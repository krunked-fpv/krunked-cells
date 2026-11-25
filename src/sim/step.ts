// =============================================================================
// KRUNKED CELLS — Master Deterministic 60 Hz Simulation Step Orchestrator
// Pure simulation module: strictly deterministic, zero browser/DOM/WebGL/Audio/clock usage.
// =============================================================================

import {
  FIXED_DT,
  MAX_BOSS_CELLS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  TILE_SIZE,
  TileKind,
  createDefaultMetaSnapshot,
  type BiomeId,
  type BossId,
  type GearInstance,
  type InputFrame,
  type MetaSnapshot,
  type PickupState,
  type RngAPI,
  type ScrollStat,
  type SimCommand,
  type SimState,
} from '../contracts';
import { WEAPON_MAP, getBiome, getDifficulty, getSkill, getWeapon } from '../data';
import { spawnBoss } from './bosses';
import { snapCameraToPlayer, stepCamera } from './camera';
import { collisionApi } from './collision';
import { stepPlayerCombat, stepProjectilesAndTurrets } from './combat';
import { spawnEnemy, stepEnemies } from './enemies';
import { handlePassageCommand } from './passage';
import { stepPlayerPhysics } from './physics';
import { createRng, seedToRngState } from './prng';
import {
  applyScrollPickup,
  computePlayerMaxHp,
  getQualityLevelBonus,
  hasMutation,
  rollGearInstance,
  triggerCurse,
} from './roguelite';
import { generateBiomeWorld } from './worldgen';

const BOSS_TO_BIOME: Readonly<Record<BossId, BiomeId>> = {
  Behemoth: 'Bridge',
  TimeKeeper: 'TopClockTower',
  KingsHand: 'Throne',
};

// Matches src/data/meta.ts Gold Reserves I-IV caps
const GOLD_RESERVES_BY_TIER: readonly number[] = [0, 2500, 5000, 10000, 15000];

const BLUEPRINT_ID_ALIASES: Readonly<Record<string, string>> = {
  HealthFlask: 'health_flask',
  flask: 'health_flask',
  GoldReserves: 'gold_reserves',
  goldReserve: 'gold_reserves',
  RandomStarter: 'random_starter',
  randomStarter: 'random_starter',
  Recycling: 'recycling',
  recycle: 'recycling',
};

const THRONE_ICE_PLATFORMS: readonly { minTx: number; maxTx: number; ty: number }[] = [
  { minTx: 6, maxTx: 10, ty: 10 },
  { minTx: 33, maxTx: 37, ty: 10 },
];
const ICE_PLATFORM_CRUMBLE_TICKS = 180;
const ICE_PLATFORM_RESPAWN_TICKS = 300;
const SHOP_MAX_REROLLS = 3;

function cloneMetaSnapshot(meta?: MetaSnapshot): MetaSnapshot {
  const base = meta ?? createDefaultMetaSnapshot();
  return {
    bossCellsUnlocked: base.bossCellsUnlocked,
    flaskTier: base.flaskTier,
    goldReserveTier: base.goldReserveTier,
    randomStarterUnlocked: base.randomStarterUnlocked,
    recycleUnlocked: base.recycleUnlocked,
    unlockedBlueprints: [...base.unlockedBlueprints],
    blueprintProgress: { ...base.blueprintProgress },
    runesUnlocked: { ...base.runesUnlocked },
    totalRuns: base.totalRuns,
    totalKills: base.totalKills,
    bestClearTicks: base.bestClearTicks,
    bankedGold: base.bankedGold ?? 0,
    legendaryForgePlus: base.legendaryForgePlus ?? 0,
    legendaryForgePlusPlus: base.legendaryForgePlusPlus ?? 0,
  };
}

function createStarterGear(
  nextUid: () => number,
  defId: string,
  slotKind: 'weapon' | 'skill'
): GearInstance {
  if (slotKind === 'skill') {
    const def = getSkill(defId);
    return {
      uid: nextUid(),
      defId: def.id,
      slotKind: 'skill',
      level: 1,
      quality: 'base',
      color: def.colors[0] ?? 'brutality',
      affixes: [],
      cooldownTicks: 0,
    };
  }
  const def = getWeapon(defId);
  return {
    uid: nextUid(),
    defId: def.id,
    slotKind: 'weapon',
    level: 1,
    quality: 'base',
    color: def.colors[0] ?? 'brutality',
    affixes: [],
    ammo: def.ammoCapacity,
    maxAmmo: def.ammoCapacity,
    cooldownTicks: 0,
  };
}

function updateFogOfWarAndRoomDiscovery(state: SimState): void {
  const grid = state.tileGrid;
  const ptx = Math.floor(state.player.pos.x / TILE_SIZE);
  const pty = Math.floor(state.player.pos.y / TILE_SIZE);
  const radius = 10;
  const r2 = radius * radius;

  const minY = Math.max(0, pty - radius);
  const maxY = Math.min(grid.height - 1, pty + radius);
  const minX = Math.max(0, ptx - radius);
  const maxX = Math.min(grid.width - 1, ptx + radius);

  for (let ty = minY; ty <= maxY; ty++) {
    const dy = ty - pty;
    const rowOff = ty * grid.width;
    for (let tx = minX; tx <= maxX; tx++) {
      const dx = tx - ptx;
      if (dx * dx + dy * dy <= r2) {
        grid.explored[rowOff + tx] = 1;
      }
    }
  }

  for (let i = 0; i < state.rooms.length; i++) {
    const r = state.rooms[i]!;
    if (ptx >= r.tx && ptx < r.tx + r.tw && pty >= r.ty && pty < r.ty + r.th) {
      r.discovered = true;
    }
    if (r.discovered && !r.cleared) {
      let hasAlive = false;
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j]!;
        if (e.roomId === r.id && e.state !== 'dead' && e.hp > 0) {
          hasAlive = true;
          break;
        }
      }
      if (!hasAlive) {
        r.cleared = true;
      }
    }
  }
}

/**
 * Applies or removes `bonusScrolls` (`++` / `S` / `L` / Amulet) onto `player.scrolls`
 * and cleanly recomputes `player.maxHp` (preserving current HP gain/cap).
 */
export function applyGearScrollDelta(
  state: SimState,
  gear: GearInstance | null,
  sign: 1 | -1
): void {
  if (!gear || !gear.bonusScrolls) return;
  const stats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
  let changed = false;
  for (let i = 0; i < stats.length; i++) {
    const k = stats[i]!;
    const delta = gear.bonusScrolls[k] ?? 0;
    if (delta > 0) {
      state.player.scrolls[k] = Math.max(1, state.player.scrolls[k] + sign * delta);
      changed = true;
    }
  }
  if (!changed) return;

  const prevMax = state.player.maxHp;
  const nextMax = computePlayerMaxHp(state.player.scrolls);
  state.player.maxHp = nextMax;
  if (nextMax > prevMax) {
    state.player.hp = Math.min(nextMax, state.player.hp + (nextMax - prevMax));
  } else {
    state.player.hp = Math.min(nextMax, state.player.hp);
  }
}

function consumeChoiceGroupSiblings(state: SimState, picked: PickupState): void {
  if (picked.choiceGroupId === undefined) return;
  const gid = picked.choiceGroupId;
  for (let i = 0; i < state.pickups.length; i++) {
    const other = state.pickups[i]!;
    if (other.uid !== picked.uid && !other.collected && other.choiceGroupId === gid) {
      other.collected = true;
    }
  }
}

function equipGearFromPickup(state: SimState, pickup: PickupState, targetSlot: 1 | 2): boolean {
  if (!pickup.gear || pickup.collected) return false;
  const price = pickup.priceGold ?? 0;
  if (price > state.player.gold) return false;

  if (price > 0) {
    state.player.gold -= price;
  }

  const incoming = pickup.gear;
  pickup.collected = true;
  consumeChoiceGroupSiblings(state, pickup);

  let dropped: GearInstance | null = null;

  if (incoming.slotKind === 'amulet') {
    dropped = state.player.loadout.amulet;
    applyGearScrollDelta(state, dropped, -1);
    state.player.loadout.amulet = incoming;
    applyGearScrollDelta(state, incoming, 1);
  } else if (incoming.slotKind === 'skill') {
    if (targetSlot === 1) {
      dropped = state.player.loadout.skill1;
      applyGearScrollDelta(state, dropped, -1);
      state.player.loadout.skill1 = incoming;
      applyGearScrollDelta(state, incoming, 1);
    } else {
      dropped = state.player.loadout.skill2;
      applyGearScrollDelta(state, dropped, -1);
      state.player.loadout.skill2 = incoming;
      applyGearScrollDelta(state, incoming, 1);
    }
  } else {
    if (targetSlot === 1) {
      dropped = state.player.loadout.weapon1;
      applyGearScrollDelta(state, dropped, -1);
      state.player.loadout.weapon1 = incoming;
      applyGearScrollDelta(state, incoming, 1);
    } else {
      dropped = state.player.loadout.weapon2;
      applyGearScrollDelta(state, dropped, -1);
      state.player.loadout.weapon2 = incoming;
      applyGearScrollDelta(state, incoming, 1);
    }
  }

  // Drop displaced gear back onto the ground so the player never loses items accidentally
  if (dropped) {
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gear',
      pos: { x: state.player.pos.x, y: state.player.pos.y - 6 },
      prevPos: { x: state.player.pos.x, y: state.player.pos.y - 6 },
      vel: { x: -state.player.facing * 45, y: -115 },
      value: 0,
      gear: dropped,
      label: dropped.defId,
      magnetTicks: 0,
      collected: false,
      bobPhase: 0,
    });
  }

  state.events.push({
    type: 'itemPickup',
    x: state.player.pos.x,
    y: state.player.pos.y,
    itemId: incoming.defId,
  });
  return true;
}

function handleShopRerollCommand(
  state: SimState,
  shrineUid: number,
  preferredColor: ScrollStat | undefined,
  rng: RngAPI
): boolean {
  const shrine = state.shrines.find((s) => s.uid === shrineUid && s.kind === 'merchant');
  if (!shrine || shrine.shopId === undefined) return false;

  const rerolls = shrine.rerollCount ?? 0;
  if (rerolls >= SHOP_MAX_REROLLS) return false;

  const cost = 250 * Math.pow(2, rerolls);
  if (state.player.gold < cost) return false;

  const wares = state.pickups.filter((pk) => !pk.collected && pk.shopId === shrine.shopId);
  if (wares.length === 0) return false;

  state.player.gold -= cost;
  shrine.rerollCount = rerolls + 1;
  if (preferredColor) {
    shrine.colorFilter = preferredColor;
  }

  const filterColor = preferredColor ?? shrine.colorFilter;
  const biome = getBiome(state.activeBiomeId);
  const shopLevel = Math.max(1, biome.depthTier + 2);
  const seenIds = new Set<string>();

  for (let i = 0; i < wares.length; i++) {
    const pk = wares[i]!;
    if (shrine.shopKind === 'weapon' || shrine.shopKind === 'skill') {
      const slotKind = shrine.shopKind;
      let nextGear = rollGearInstance(state, rng, slotKind, shopLevel, filterColor);
      for (let tries = 0; tries < 4 && seenIds.has(nextGear.defId); tries++) {
        nextGear = rollGearInstance(state, rng, slotKind, shopLevel, filterColor);
      }
      seenIds.add(nextGear.defId);
      pk.kind = 'gear';
      pk.gear = nextGear;
      pk.label = nextGear.defId;
    }
  }

  state.events.push({
    type: 'shopReroll',
    x: shrine.pos.x,
    y: shrine.pos.y,
  });
  return true;
}

function handlePickRecyclingTubeCommand(state: SimState, shrineUid: number): boolean {
  const shrine = state.shrines.find(
    (s) => s.uid === shrineUid && s.kind === 'recyclingTube' && !s.used && s.tubeLoadout
  );
  if (!shrine || !shrine.tubeLoadout) return false;

  const loadout = state.player.loadout;
  // Remove bonus scrolls from previous 4 active slots
  applyGearScrollDelta(state, loadout.weapon1, -1);
  applyGearScrollDelta(state, loadout.weapon2, -1);
  applyGearScrollDelta(state, loadout.skill1, -1);
  applyGearScrollDelta(state, loadout.skill2, -1);

  const bundle = shrine.tubeLoadout;
  loadout.weapon1 = bundle.weapon1;
  loadout.weapon2 = bundle.weapon2;
  loadout.skill1 = bundle.skill1;
  loadout.skill2 = bundle.skill2;

  // Apply bonus scrolls from newly equipped 4 slots
  applyGearScrollDelta(state, loadout.weapon1, 1);
  applyGearScrollDelta(state, loadout.weapon2, 1);
  applyGearScrollDelta(state, loadout.skill1, 1);
  applyGearScrollDelta(state, loadout.skill2, 1);

  // Mark this tube and all sibling recycling tubes used
  for (let i = 0; i < state.shrines.length; i++) {
    const s = state.shrines[i]!;
    if (s.kind === 'recyclingTube') {
      s.used = true;
    }
  }

  state.events.push({
    type: 'itemPickup',
    x: state.player.pos.x,
    y: state.player.pos.y,
    itemId: bundle.weapon1.defId,
  });
  return true;
}

function handleLegendaryForgeInvestCommand(
  state: SimState,
  tier: 'plus' | 'plusPlus',
  amount: number
): boolean {
  // Accessible in Passage (post-boss forge or Passage safe room)
  if (!state.passageState.active && state.activeBiomeId !== 'Passage') {
    return false;
  }
  const requested = Math.max(1, Math.floor(amount));
  if (state.player.cells <= 0) return false;

  if (tier === 'plus') {
    const cur = Math.max(0, Math.min(100, Math.floor(state.metaSnapshot.legendaryForgePlus ?? 0)));
    const remaining = 100 - cur;
    const spend = Math.min(state.player.cells, requested, remaining);
    if (spend <= 0) return false;
    state.player.cells -= spend;
    state.metaSnapshot.legendaryForgePlus = Math.min(100, cur + spend);
    return true;
  }

  const curPP = Math.max(0, Math.min(100, Math.floor(state.metaSnapshot.legendaryForgePlusPlus ?? 0)));
  const remaining = 100 - curPP;
  const spend = Math.min(state.player.cells, requested, remaining);
  if (spend <= 0) return false;
  state.player.cells -= spend;
  state.metaSnapshot.legendaryForgePlusPlus = Math.min(100, curPP + spend);
  return true;
}

function finalizeThroneVictoryFallback(state: SimState): void {
  if (state.runStatus === 'victory') return;
  let unlockedNew = false;
  if (
    state.bossStemCells >= state.metaSnapshot.bossCellsUnlocked &&
    state.metaSnapshot.bossCellsUnlocked < MAX_BOSS_CELLS
  ) {
    state.metaSnapshot.bossCellsUnlocked = Math.min(
      MAX_BOSS_CELLS,
      state.bossStemCells + 1
    );
    unlockedNew = true;
  }
  state.metaSnapshot.totalRuns += 1;
  if (
    state.metaSnapshot.bestClearTicks === null ||
    state.player.runTimerTicks < state.metaSnapshot.bestClearTicks
  ) {
    state.metaSnapshot.bestClearTicks = state.player.runTimerTicks;
  }
  state.runStatus = 'victory';
  state.runSummary = {
    victory: true,
    bossCells: state.bossStemCells,
    biomeReached: state.activeBiomeId,
    kills: state.runKills,
    maxKillStreak: state.maxKillStreak,
    runTimerTicks: state.player.runTimerTicks,
    scrolls: { ...state.player.scrolls },
    cellsCollected: state.totalCellsEarned,
    goldCollected: state.totalGoldEarned,
    causeOfDeath: '',
    unlockedNewBossCell: unlockedNew,
  };
}

function processSimCommand(state: SimState, cmd: SimCommand, rng: RngAPI): void {
  switch (cmd.type) {
    case 'pickScroll': {
      const pending = state.pendingScroll;
      if (!pending) return;
      if (!pending.choices.includes(cmd.stat)) return;
      applyScrollPickup(state, cmd.stat);
      state.pendingScroll = null;
      return;
    }

    case 'equipPickup': {
      const pk = state.pickups.find((p) => p.uid === cmd.pickupUid && !p.collected && p.kind === 'gear');
      if (!pk) return;
      equipGearFromPickup(state, pk, cmd.targetSlot);
      return;
    }

    case 'recyclePickup': {
      if (!state.metaSnapshot.recycleUnlocked) return;
      const pk = state.pickups.find((p) => p.uid === cmd.pickupUid && !p.collected && p.kind === 'gear');
      if (!pk || !pk.gear || (pk.priceGold && pk.priceGold > 0)) return;
      pk.collected = true;
      consumeChoiceGroupSiblings(state, pk);
      const goldGain = 110 + pk.gear.level * 55 + getQualityLevelBonus(pk.gear.quality) * 40;
      state.player.gold += goldGain;
      state.totalGoldEarned += goldGain;
      state.events.push({
        type: 'goldCollect',
        x: pk.pos.x,
        y: pk.pos.y,
        amount: goldGain,
      });
      return;
    }

    case 'teleportTo': {
      const tp = state.teleporters.find((t) => t.uid === cmd.teleporterUid);
      if (!tp) return;
      const fromX = state.player.pos.x;
      const fromY = state.player.pos.y;
      tp.activated = true;
      state.player.pos.x = tp.pos.x;
      state.player.pos.y = tp.pos.y - PLAYER_HEIGHT * 0.5 + 4;
      state.player.prevPos.x = state.player.pos.x;
      state.player.prevPos.y = state.player.pos.y;
      state.player.vel.x = 0;
      state.player.vel.y = 0;
      state.player.diveSlamState = 'none';
      state.player.fallStartY = state.player.pos.y;
      snapCameraToPlayer(state);
      updateFogOfWarAndRoomDiscovery(state);
      state.events.push({
        type: 'teleport',
        fromX,
        fromY,
        toX: state.player.pos.x,
        toY: state.player.pos.y,
      });
      return;
    }

    case 'enterBiome': {
      handlePassageCommand(state, cmd, rng);
      transitionBiomeWithRng(state, cmd.biomeId, rng);
      return;
    }

    case 'collectorInvest': {
      const mappedId = BLUEPRINT_ID_ALIASES[cmd.blueprintId] ?? cmd.blueprintId;
      handlePassageCommand(
        state,
        mappedId === cmd.blueprintId ? cmd : { ...cmd, blueprintId: mappedId },
        rng
      );
      return;
    }

    case 'forgeUpgrade': {
      const targetGear = state.player.loadout[cmd.slot];
      const prevBonus = targetGear?.bonusScrolls ? { ...targetGear.bonusScrolls } : null;
      const prevScrolls = { ...state.player.scrolls };
      const ok = handlePassageCommand(state, cmd, rng);
      if (ok && targetGear) {
        // Apply scroll delta cleanly only if passage.ts did not already mutate player.scrolls
        const passageUpdatedScrolls =
          state.player.scrolls.brutality !== prevScrolls.brutality ||
          state.player.scrolls.tactics !== prevScrolls.tactics ||
          state.player.scrolls.survival !== prevScrolls.survival;
        if (!passageUpdatedScrolls) {
          if (prevBonus) {
            applyGearScrollDelta(state, { ...targetGear, bonusScrolls: prevBonus }, -1);
          }
          applyGearScrollDelta(state, targetGear, 1);
        }
      }
      return;
    }

    case 'shopReroll': {
      handleShopRerollCommand(state, cmd.shrineUid, cmd.preferredColor, rng);
      return;
    }

    case 'pickRecyclingTube': {
      handlePickRecyclingTubeCommand(state, cmd.shrineUid);
      return;
    }

    case 'legendaryForgeInvest': {
      handleLegendaryForgeInvestCommand(state, cmd.tier, cmd.amount);
      return;
    }

    case 'openPassageNpc':
    case 'pickMutation':
    case 'respecMutations':
    case 'forgeReforge':
    case 'useFountain': {
      handlePassageCommand(state, cmd, rng);
      return;
    }
  }
}

function handleWorldInteraction(state: SimState, rng: RngAPI): void {
  const player = state.player;
  const px = player.pos.x;
  const py = player.pos.y;

  // 1. Chests (Treasure / Cursed / Boss)
  for (let i = 0; i < state.chests.length; i++) {
    const chest = state.chests[i]!;
    if (chest.opened) continue;
    if (Math.hypot(chest.pos.x - px, chest.pos.y - py) <= 46) {
      chest.opened = true;
      const biome = getBiome(state.activeBiomeId);
      const gearLevel = Math.max(1, biome.depthTier + (chest.kind === 'cursed' ? 2 : 1));

      if (chest.kind === 'cursed') {
        triggerCurse(state, 10);
        // Cursed Chest grants Power Scroll + Colorless/Legendary Gear + Gold burst!
        state.pickups.push({
          uid: state.nextUid++,
          kind: 'scroll',
          pos: { x: chest.pos.x - 16, y: chest.pos.y - 10 },
          prevPos: { x: chest.pos.x - 16, y: chest.pos.y - 10 },
          vel: { x: -35, y: -135 },
          value: 1,
          scrollChoices: ['brutality', 'tactics', 'survival'],
          label: 'Cursed Power Scroll',
          magnetTicks: 0,
          collected: false,
          bobPhase: 0,
        });
        const cursedGear = rollGearInstance(
          state,
          rng,
          rng.chance(0.65) ? 'weapon' : 'skill',
          gearLevel,
          undefined,
          true
        );
        state.pickups.push({
          uid: state.nextUid++,
          kind: 'gear',
          pos: { x: chest.pos.x + 16, y: chest.pos.y - 10 },
          prevPos: { x: chest.pos.x + 16, y: chest.pos.y - 10 },
          vel: { x: 35, y: -145 },
          value: 0,
          gear: cursedGear,
          label: `Cursed ${cursedGear.defId}`,
          magnetTicks: 0,
          collected: false,
          bobPhase: 1,
        });
      } else {
        const lootGear = rollGearInstance(
          state,
          rng,
          rng.chance(0.6) ? 'weapon' : 'skill',
          gearLevel
        );
        state.pickups.push({
          uid: state.nextUid++,
          kind: 'gear',
          pos: { x: chest.pos.x, y: chest.pos.y - 10 },
          prevPos: { x: chest.pos.x, y: chest.pos.y - 10 },
          vel: { x: rng.rangeFloat(-30, 30), y: -135 },
          value: 0,
          gear: lootGear,
          label: lootGear.defId,
          magnetTicks: 0,
          collected: false,
          bobPhase: 0,
        });
      }

      // Bonus Gold & Cells from chest
      const goldCount = chest.kind === 'cursed' ? 5 : 3;
      for (let g = 0; g < goldCount; g++) {
        state.pickups.push({
          uid: state.nextUid++,
          kind: 'gold',
          pos: { x: chest.pos.x, y: chest.pos.y - 8 },
          prevPos: { x: chest.pos.x, y: chest.pos.y - 8 },
          vel: { x: rng.rangeFloat(-85, 85), y: rng.rangeFloat(-170, -95) },
          value: 55 + biome.depthTier * 20,
          magnetTicks: 10,
          collected: false,
          bobPhase: g * 0.8,
        });
      }
      return;
    }
  }

  // 2. Scroll / Food / FlaskRefill Pickups
  for (let i = 0; i < state.pickups.length; i++) {
    const pk = state.pickups[i]!;
    if (pk.collected) continue;
    if (
      pk.kind !== 'scroll' &&
      pk.kind !== 'dualScroll' &&
      pk.kind !== 'food' &&
      pk.kind !== 'flaskRefill'
    ) {
      continue;
    }
    if (Math.hypot(pk.pos.x - px, pk.pos.y - py) <= 46) {
      const price = pk.priceGold ?? 0;
      if (price > player.gold) return;
      if (price > 0) player.gold -= price;
      pk.collected = true;
      consumeChoiceGroupSiblings(state, pk);

      if (pk.kind === 'scroll' || pk.kind === 'dualScroll') {
        state.pendingScroll = {
          pickupUid: pk.uid,
          choices: pk.scrollChoices ?? ['brutality', 'tactics', 'survival'],
          title: pk.kind === 'dualScroll' ? 'Dual Scroll' : 'Scroll of Power',
        };
      } else if (pk.kind === 'food') {
        const basePct = (pk.value > 0 && pk.value <= 100 ? pk.value : 50) / 100;
        const healPct = hasMutation(state, 'Gastronomy') ? Math.min(1, basePct * 1.65) : basePct;
        const healAmt = Math.max(8, Math.round(player.maxHp * healPct));
        const before = player.hp;
        player.hp = Math.min(player.maxHp, player.hp + healAmt);
        player.rallyHp = 0;
        state.events.push({
          type: 'flaskDrink',
          x: player.pos.x,
          y: player.pos.y,
          healed: player.hp - before,
        });
      } else if (pk.kind === 'flaskRefill') {
        player.flaskCharges = Math.min(player.maxFlaskCharges, player.flaskCharges + 1);
        state.events.push({
          type: 'flaskDrink',
          x: player.pos.x,
          y: player.pos.y,
          healed: 0,
        });
      }
      return;
    }
  }

  // 2.5. Directly standing in front of an unlocked Biome Exit Door wins over weapon-swap loops
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.broken || door.kind !== 'biomeExit') continue;
    const curBiome = getBiome(state.activeBiomeId);
    if (curBiome.isBossArena && !state.bossArenaState.defeated) continue;
    if (Math.hypot(door.pos.x - px, door.pos.y - py) <= 52) {
      if (state.activeBiomeId === 'Passage') {
        const dest: BiomeId = door.targetBiomeId ?? state.passageState.nextBiomes[0] ?? 'PrisonCourtyard';
        transitionBiomeWithRng(state, dest, rng);
        return;
      }
      const nextList: BiomeId[] =
        curBiome.nextBiomes.length > 0
          ? [...curBiome.nextBiomes]
          : door.targetBiomeId
            ? [door.targetBiomeId]
            : ['PrisonCourtyard'];
      state.passageState.fromBiome = state.activeBiomeId;
      state.passageState.nextBiomes = nextList;
      transitionBiomeWithRng(state, 'Passage', rng);
      return;
    }
  }

  // 3. Gear Pickup (direct keyboard [F] fallback when not dispatched via HudOverlay)
  for (let i = 0; i < state.pickups.length; i++) {
    const pk = state.pickups[i]!;
    if (pk.collected || pk.kind !== 'gear' || !pk.gear) continue;
    if (Math.hypot(pk.pos.x - px, pk.pos.y - py) <= 46) {
      const g = pk.gear;
      const slot: 1 | 2 =
        g.slotKind === 'skill'
          ? player.loadout.skill2 === null
            ? 2
            : 1
          : g.slotKind === 'weapon' && WEAPON_MAP[g.defId]?.kind === 'shield'
            ? 2
            : 1;
      equipGearFromPickup(state, pk, slot);
      return;
    }
  }

  // 4. Shrines, Merchants, Recycling Tubes & Passage NPCs
  for (let i = 0; i < state.shrines.length; i++) {
    const sh = state.shrines[i]!;
    if (Math.hypot(sh.pos.x - px, sh.pos.y - py) <= 50) {
      if (sh.kind === 'collector' || sh.kind === 'guillain' || sh.kind === 'forge') {
        handlePassageCommand(state, { type: 'openPassageNpc', npc: sh.kind }, rng);
        return;
      }
      if (sh.kind === 'fountain') {
        handlePassageCommand(state, { type: 'useFountain' }, rng);
        return;
      }
      if (sh.kind === 'merchant') {
        handleShopRerollCommand(state, sh.uid, sh.colorFilter, rng);
        return;
      }
      if (!sh.used && sh.kind === 'recyclingTube') {
        handlePickRecyclingTubeCommand(state, sh.uid);
        return;
      }
      if (!sh.used && sh.kind === 'challengeRift') {
        sh.used = true;
        // Challenge Rift gauntlet rewards sit at the far end; activating entry altar grants a small spark/gold bonus
        const riftBonus = 100;
        player.gold += riftBonus;
        state.totalGoldEarned += riftBonus;
        state.events.push({
          type: 'goldCollect',
          x: sh.pos.x,
          y: sh.pos.y - 12,
          amount: riftBonus,
        });
        return;
      }
      if (!sh.used && sh.kind === 'loreSkeleton') {
        if (state.activeBiomeId === 'Throne') {
          if (!state.bossArenaState.defeated) {
            return; // Cannot claim the Sovereign Throne while Hand of the King still stands!
          }
          sh.used = true;
          finalizeThroneVictoryFallback(state);
          return;
        }
        sh.used = true;
        const bonusGold = 75;
        player.gold += bonusGold;
        state.totalGoldEarned += bonusGold;
        state.events.push({
          type: 'goldCollect',
          x: sh.pos.x,
          y: sh.pos.y - 10,
          amount: bonusGold,
        });
        return;
      }
    }
  }

  // 5. Biome Exit Doors & Wooden Doors
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.broken) continue;
    if (Math.hypot(door.pos.x - px, door.pos.y - py) <= 52) {
      if (door.kind === 'wood') {
        door.opened = !door.opened;
        return;
      }
      if (door.kind === 'biomeExit') {
        const curBiome = getBiome(state.activeBiomeId);
        if (curBiome.isBossArena && !state.bossArenaState.defeated) {
          return;
        }
        if (state.activeBiomeId === 'Passage') {
          const dest: BiomeId = door.targetBiomeId ?? state.passageState.nextBiomes[0] ?? 'PrisonCourtyard';
          transitionBiomeWithRng(state, dest, rng);
          return;
        }
        // Regular/Boss Biome Exit -> Enter The Passage Safe Room!
        const nextList: BiomeId[] =
          curBiome.nextBiomes.length > 0
            ? [...curBiome.nextBiomes]
            : door.targetBiomeId
              ? [door.targetBiomeId]
              : ['PrisonCourtyard'];
        state.passageState.fromBiome = state.activeBiomeId;
        state.passageState.nextBiomes = nextList;
        transitionBiomeWithRng(state, 'Passage', rng);
        return;
      }
    }
  }
}

function stepPickupsAndTeleporters(state: SimState): void {
  const player = state.player;
  const grid = state.tileGrid;

  // Auto-activate teleporter runes when the player walks near them
  for (let i = 0; i < state.teleporters.length; i++) {
    const tp = state.teleporters[i]!;
    if (!tp.activated && Math.hypot(tp.pos.x - player.pos.x, tp.pos.y - player.pos.y) <= 54) {
      tp.activated = true;
    }
  }

  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const pk = state.pickups[i]!;
    if (pk.collected) {
      state.pickups.splice(i, 1);
      continue;
    }

    pk.prevPos.x = pk.pos.x;
    pk.prevPos.y = pk.pos.y;
    pk.bobPhase += 0.08;
    if (pk.magnetTicks > 0) pk.magnetTicks -= 1;

    const isCurrency = pk.kind === 'gold' || pk.kind === 'cell';
    const dx = player.pos.x - pk.pos.x;
    const dy = player.pos.y - pk.pos.y;
    const dist = Math.hypot(dx, dy);

    if (isCurrency && pk.magnetTicks <= 0 && dist <= 110) {
      // Silky Dead Cells curved cell/coin vacuum arc toward Prisoner's chest!
      const targetDx = player.pos.x - pk.pos.x;
      const targetDy = player.pos.y - 16 - pk.pos.y;
      const tLen = Math.max(1, Math.hypot(targetDx, targetDy));

      const curSpeed = Math.hypot(pk.vel.x, pk.vel.y);
      if (curSpeed < 35) {
        // Gentle initial upward lift & tangential kick to carve an arc
        pk.vel.y -= 92;
        pk.vel.x += (targetDx >= 0 ? -1 : 1) * 32;
      }

      const maxSpeed = 340;
      const desiredVx = (targetDx / tLen) * maxSpeed;
      const desiredVy = (targetDy / tLen) * maxSpeed;
      const steerDx = desiredVx - pk.vel.x;
      const steerDy = desiredVy - pk.vel.y;
      const steerLen = Math.hypot(steerDx, steerDy);
      const maxDelta = 1450 * FIXED_DT;

      if (steerLen <= maxDelta || steerLen < 0.001) {
        pk.vel.x = desiredVx;
        pk.vel.y = desiredVy;
      } else {
        pk.vel.x += (steerDx / steerLen) * maxDelta;
        pk.vel.y += (steerDy / steerLen) * maxDelta;
      }

      const nextSpeed = Math.hypot(pk.vel.x, pk.vel.y);
      if (nextSpeed > maxSpeed) {
        pk.vel.x = (pk.vel.x / nextSpeed) * maxSpeed;
        pk.vel.y = (pk.vel.y / nextSpeed) * maxSpeed;
      }

      pk.pos.x += pk.vel.x * FIXED_DT;
      pk.pos.y += pk.vel.y * FIXED_DT;
    } else if (pk.vel.x !== 0 || pk.vel.y !== 0) {
      pk.vel.y = Math.min(420, pk.vel.y + 760 * FIXED_DT);
      const prevVy = pk.vel.y;
      const res = collisionApi.sweepAabb(
        grid,
        pk.pos.x - 5,
        pk.pos.y - 5,
        10,
        10,
        pk.vel.x,
        pk.vel.y,
        FIXED_DT,
        false,
        false
      );
      pk.pos.x = res.x + 5;
      pk.pos.y = res.y + 5;

      // Elastic coin & cell floor bounce
      if (res.hitFloor && prevVy > 48) {
        const bounceRestitution = pk.kind === 'gold' ? 0.56 : 0.44;
        pk.vel.y = -prevVy * bounceRestitution;
        pk.vel.x = res.vx * 0.78;
      } else {
        pk.vel.x = res.hitFloor ? res.vx * 0.65 : res.vx;
        pk.vel.y = res.vy;
        if (res.hitFloor && Math.abs(pk.vel.x) < 8) {
          pk.vel.x = 0;
        }
      }
    }

    // Auto-collect Gold and Cells on touch
    const collectDist = Math.hypot(player.pos.x - pk.pos.x, player.pos.y - pk.pos.y);
    if (isCurrency && pk.magnetTicks <= 0 && collectDist <= 24) {
      pk.collected = true;
      if (pk.kind === 'gold') {
        player.gold += pk.value;
        state.totalGoldEarned += pk.value;
        state.events.push({
          type: 'goldCollect',
          x: pk.pos.x,
          y: pk.pos.y,
          amount: pk.value,
        });
      } else {
        player.cells += pk.value;
        state.totalCellsEarned += pk.value;
        state.events.push({
          type: 'cellCollect',
          x: pk.pos.x,
          y: pk.pos.y,
          count: pk.value,
        });
      }
      state.pickups.splice(i, 1);
    }
  }
}

function stepThroneIcePlatforms(state: SimState): void {
  if (state.activeBiomeId !== 'Throne') return;
  const timers = state.bossArenaState.icePlatformTimers;
  if (!timers) return;

  const player = state.player;
  const grid = state.tileGrid;

  for (let idx = 0; idx < THRONE_ICE_PLATFORMS.length; idx++) {
    const plat = THRONE_ICE_PLATFORMS[idx]!;
    const t = timers[idx]!;
    const leftX = plat.minTx * TILE_SIZE;
    const rightX = (plat.maxTx + 1) * TILE_SIZE;
    const topY = plat.ty * TILE_SIZE;

    if (t === 0) {
      // Intact: start crumble countdown when player lands on this ice platform
      const feetY = player.pos.y + player.height * 0.5;
      if (
        player.grounded &&
        player.onOneWay &&
        player.pos.x >= leftX - 4 &&
        player.pos.x <= rightX + 4 &&
        Math.abs(feetY - topY) <= 4
      ) {
        timers[idx] = ICE_PLATFORM_CRUMBLE_TICKS;
      }
    } else if (t > 0) {
      const next = t - 1;
      if (next <= 0) {
        // Shatter the ice platform!
        for (let tx = plat.minTx; tx <= plat.maxTx; tx++) {
          collisionApi.setTile(grid, tx, plat.ty, TileKind.EMPTY);
        }
        timers[idx] = -ICE_PLATFORM_RESPAWN_TICKS;
        if (state.particlesSim.length < 250) {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: (leftX + rightX) * 0.5, y: topY + 6 },
            vel: { x: 0, y: 24 },
            size: 10,
            color: '#9beeff',
            alpha: 1,
            ttlTicks: 22,
            maxTtlTicks: 22,
            gravity: 160,
            emissive: true,
            kind: 'ice',
          });
        }
      } else {
        timers[idx] = next;
      }
    } else {
      // Shattered cooldown -> count up toward 0 and regenerate!
      const next = t + 1;
      timers[idx] = next;
      if (next === 0) {
        for (let tx = plat.minTx; tx <= plat.maxTx; tx++) {
          collisionApi.setTile(grid, tx, plat.ty, TileKind.ONE_WAY);
        }
      }
    }
  }
}

function stepBossArenaEngagement(state: SimState): void {
  const arena = state.bossArenaState;
  if (!arena.active || arena.defeated || arena.bossId === null) return;

  const boss = state.enemies.find(
    (e) => e.uid === arena.bossUid && e.state !== 'dead' && e.hp > 0
  );

  // Track Flawless Boss no-hit condition
  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i]!;
    if (ev.type === 'playerDamaged' && ev.amount > 0) {
      arena.playerTookHit = true;
    }
  }

  if (arena.engaged === false) {
    const crossedThreshold = state.player.pos.x >= 14 * TILE_SIZE;
    const bossDamaged = Boolean(boss && boss.hp < boss.maxHp);
    if (crossedThreshold || bossDamaged) {
      arena.engaged = true;
      arena.bannerTicks = 120;
      for (let i = 0; i < state.doors.length; i++) {
        const d = state.doors[i]!;
        if (d.kind === 'bossGate') {
          d.opened = false;
        }
      }
      state.events.push({
        type: 'bossEngage',
        bossId: arena.bossId,
      });
    }
  }
}

function stepMalaise5BC(state: SimState, rng: RngAPI): void {
  if (state.bossStemCells < 5 || state.runStatus !== 'playing') return;
  const player = state.player;
  const biome = getBiome(state.activeBiomeId);

  let malaise = player.malaise ?? 0;

  // Event-driven Malaise changes (damage +10, kill -2, elite -10, boss -50, flask -30)
  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i]!;
    if (ev.type === 'playerDamaged' && ev.amount > 0) {
      malaise = Math.min(100, malaise + 10);
    } else if (ev.type === 'enemyDeath') {
      const clear = ev.isBoss ? 50 : ev.isElite ? 10 : 2;
      malaise = Math.max(0, malaise - clear);
    } else if (ev.type === 'flaskDrink' && ev.healed > 0) {
      malaise = Math.max(0, malaise - 30);
    }
  }

  // Passive time rise in non-boss combat biomes while enemies remain alive
  if (!biome.isBossArena) {
    let aliveCount = 0;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state !== 'dead' && e.hp > 0) aliveCount += 1;
    }
    if (aliveCount > 0) {
      const ratePerSec = 0.35 + Math.min(0.45, aliveCount * 0.02);
      malaise = Math.min(100, malaise + ratePerSec * FIXED_DT);
    }

    // High Malaise (>= 60) periodic ambush mob spawn
    if (
      malaise >= 60 &&
      state.tick % 720 === 0 &&
      biome.enemyPool.length > 0 &&
      aliveCount < 28
    ) {
      const defId = rng.pick(biome.enemyPool);
      const dir = rng.chance(0.5) ? 1 : -1;
      const sx = Math.max(
        TILE_SIZE * 3,
        Math.min((state.tileGrid.width - 3) * TILE_SIZE, player.pos.x + dir * 120)
      );
      const sy = player.pos.y - 8;
      const stx = Math.floor(sx / TILE_SIZE);
      const sty = Math.floor(sy / TILE_SIZE);
      if (!collisionApi.isSolidAt(state.tileGrid, stx, sty)) {
        spawnEnemy(state, defId, sx, sy, 0, rng, false);
        state.events.push({
          type: 'teleport',
          fromX: sx,
          fromY: sy - 24,
          toX: sx,
          toY: sy,
        });
      }
    }
  }

  player.malaise = Math.max(0, Math.min(100, malaise));
}

function stepSimParticlesAndLights(state: SimState): void {
  for (let i = state.particlesSim.length - 1; i >= 0; i--) {
    const p = state.particlesSim[i]!;
    p.ttlTicks -= 1;
    if (p.ttlTicks <= 0) {
      state.particlesSim.splice(i, 1);
      continue;
    }
    p.vel.y += p.gravity * FIXED_DT;
    p.pos.x += p.vel.x * FIXED_DT;
    p.pos.y += p.vel.y * FIXED_DT;
    p.alpha = Math.max(0, Math.min(1, p.ttlTicks / Math.max(1, p.maxTtlTicks)));
  }

  for (let i = state.lights.length - 1; i >= 0; i--) {
    const l = state.lights[i]!;
    if (l.kind === 'homunculus') {
      l.x = state.player.pos.x;
      l.y = state.player.pos.y - 10;
      continue;
    }
    if (l.ttlTicks !== undefined) {
      l.ttlTicks -= 1;
      if (l.ttlTicks <= 0) {
        state.lights.splice(i, 1);
      }
    }
  }
}

// =============================================================================
// Public Lifecycle & Master Tick API
// =============================================================================

export function createInitialSimState(
  seed: number,
  bossCells = 0,
  meta?: MetaSnapshot
): SimState {
  const safeSeed = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) || 133742 : 133742;
  const clampedBc = Math.max(0, Math.min(MAX_BOSS_CELLS, Math.floor(bossCells)));
  const metaSnap = cloneMetaSnapshot(meta);
  const diff = getDifficulty(clampedBc);
  const rngState = seedToRngState(safeSeed);

  let uidCounter = 10;
  const allocUid = (): number => uidCounter++;

  const starterFlasks = Math.max(1, Math.min(4, metaSnap.flaskTier));
  const reserveCap = GOLD_RESERVES_BY_TIER[Math.min(4, Math.max(0, metaSnap.goldReserveTier))] ?? 0;
  const bankedGold = Math.max(0, Math.floor(metaSnap.bankedGold ?? 0));
  // Banked gold retained from previous death up to Gold Reserves cap (or initial reserve unlock cap on fresh meta)
  const starterGold =
    bankedGold > 0
      ? Math.min(reserveCap, bankedGold)
      : metaSnap.totalRuns === 0 && reserveCap > 0
        ? reserveCap
        : 0;
  const scrolls: Record<ScrollStat, number> = { brutality: 1, tactics: 1, survival: 1 };
  const maxHp = computePlayerMaxHp(scrolls);

  const state: SimState = {
    tick: 0,
    nextUid: uidCounter,
    rngState,
    runSeed: safeSeed,
    bossStemCells: clampedBc,
    activeBiomeId: 'PrisonStart',
    biomesVisited: [],
    rooms: [],
    tileGrid: {
      width: 1,
      height: 1,
      tiles: new Uint8Array(1),
      bgTiles: new Uint8Array(1),
      explored: new Uint8Array(1),
    },
    player: {
      pos: { x: 96, y: 96 },
      prevPos: { x: 96, y: 96 },
      vel: { x: 0, y: 0 },
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
      facing: 1,
      grounded: false,
      onOneWay: false,
      onWallDir: 0,
      hp: maxHp,
      maxHp,
      rallyHp: 0,
      rallyHoldTicks: 0,
      rallyDrainTicks: 0,
      flaskCharges: starterFlasks,
      maxFlaskCharges: starterFlasks,
      scrolls,
      gold: starterGold,
      cells: 0,
      killStreak: 0,
      speedKillCount: 0,
      speedBuffTicks: 0,
      curseKillsLeft: 0,
      runTimerTicks: 0,
      loadout: {
        weapon1: createStarterGear(allocUid, 'StartSword', 'weapon'),
        weapon2: createStarterGear(allocUid, 'StartShield', 'weapon'),
        skill1: createStarterGear(allocUid, 'InfantryGrenade', 'skill'),
        skill2: createStarterGear(allocUid, 'SinewSlicer', 'skill'),
        amulet: null,
      },
      mutations: [],
      actionState: 'idle',
      actionTicks: 0,
      activeWeaponSlot: 1,
      comboStep: 0,
      comboResetTicks: 0,
      attackPhase: 'none',
      attackPhaseTicks: 0,
      attackHitIds: [],
      queuedInput: 'none',
      queuedInputTicks: 0,
      iframeTicks: 0,
      rollTicks: 0,
      rollCooldownTicks: 0,
      afterRollCritTicks: 0,
      parryWindowTicks: 0,
      parryCooldownTicks: 0,
      afterParryCritTicks: 0,
      shieldBlocking: false,
      coyoteTicks: 0,
      jumpBufferTicks: 0,
      airJumpsLeft: 1,
      maxAirJumps: 1,
      wallSlideTicks: 0,
      wallRunTicksLeft: 16,
      diveSlamState: 'none',
      diveStartY: 0,
      healTicks: 0,
      hitFlashTicks: 0,
      comboMutationTicks: 0,
      disengagementCooldownTicks: 0,
      statusEffects: [],
      godMode: false,
      fallStartY: 96,
      fallStunTicks: 0,
      wallJumpLockTicks: 0,
      rallyLostAnchor: 0,
      onHitShieldTicks: 0,
      shieldHoldTicks: 0,
      balancedStacks: 0,
      balancedDecayTicks: 0,
      phaserBonusDamage: 0,
      phaserBuffTicks: 0,
      tempShieldHp: 0,
      tempShieldTicks: 0,
      vengeanceTicks: 0,
      stealthTicks: 0,
      wdlmCooldownTicks: 0,
      speedComboDecayTicks: 0,
      malaise: 0,
    },
    enemies: [],
    projectiles: [],
    turrets: [],
    pickups: [],
    chests: [],
    doors: [],
    teleporters: [],
    shrines: [],
    hazards: [],
    particlesSim: [],
    lights: [],
    passageState: {
      active: false,
      fromBiome: 'PrisonStart',
      nextBiomes: ['PrisonCourtyard', 'Sewer'],
      timedDoorOpen: false,
      timedDoorClaimed: false,
      killStreakDoorOpen: false,
      killStreakDoorClaimed: false,
      timedTargetTicks: 0,
      killStreakTarget: 0,
      fountainUsed: false,
      activeNpc: 'none',
      reforgeCount: 0,
      flawlessBossDoorOpen: false,
      flawlessBossDoorClaimed: false,
    },
    camera: {
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      targetX: 0,
      targetY: 0,
      shakeX: 0,
      shakeY: 0,
      shakeMagnitude: 0,
      zoom: 1,
    },
    hitstopTicks: 0,
    slowMoTicks: 0,
    screenShake: 0,
    damageFlashAlpha: 0,
    parryFlashAlpha: 0,
    bossArenaState: {
      active: false,
      bossId: null,
      bossUid: null,
      lockedLeftX: 0,
      lockedRightX: 0,
      defeated: false,
      bannerTicks: 0,
      engaged: false,
      playerTookHit: false,
    },
    pendingScroll: null,
    runStatus: 'playing',
    runKills: 0,
    maxKillStreak: 0,
    totalGoldEarned: starterGold,
    totalCellsEarned: 0,
    lastDamageSource: '',
    runSummary: null,
    metaSnapshot: metaSnap,
    events: [],
    fountainRefillsLeft: diff.fountainRefills,
    singleFlaskRefillsLeft: diff.singleFlaskRefills,
  };

  state.nextUid = uidCounter;

  // Random Starter Weapons meta upgrade
  if (metaSnap.randomStarterUnlocked) {
    const rng = createRng(state.rngState);
    const w1 = rollGearInstance(state, rng, 'weapon', 1, 'brutality');
    const s1 = rollGearInstance(state, rng, 'skill', 1);
    let s2 = rollGearInstance(state, rng, 'skill', 1);
    if (s2.defId === s1.defId) {
      const altId = s1.defId === 'SinewSlicer' ? 'InfantryGrenade' : 'SinewSlicer';
      s2 = rollGearInstance(state, rng, 'skill', 1, undefined, false, altId);
    }
    state.player.loadout.weapon1 = w1;
    state.player.loadout.skill1 = s1;
    state.player.loadout.skill2 = s2;
    applyGearScrollDelta(state, w1, 1);
    applyGearScrollDelta(state, s1, 1);
    applyGearScrollDelta(state, s2, 1);
    state.rngState = rng.getState();
  }

  startRunInBiome(state, 'PrisonStart');
  return state;
}

function transitionBiomeWithRng(state: SimState, biomeId: BiomeId, rng: RngAPI): void {
  const prevBiome = state.activeBiomeId;
  state.pendingScroll = null;
  state.passageState.activeNpc = 'none';

  // Preserve run max kill-streak before entering Passage or starting next biome
  if (state.player.killStreak > state.maxKillStreak) {
    state.maxKillStreak = state.player.killStreak;
  }

  let flawlessBossAchieved = false;
  if (biomeId === 'Passage' && prevBiome !== 'Passage') {
    const prevDef = getBiome(prevBiome);
    state.passageState.fromBiome = prevBiome;
    state.passageState.nextBiomes =
      prevDef.nextBiomes.length > 0 ? [...prevDef.nextBiomes] : ['PrisonCourtyard'];
    flawlessBossAchieved =
      prevDef.isBossArena &&
      state.bossArenaState.defeated &&
      !state.bossArenaState.playerTookHit;
  }

  // Reset per-biome no-hit kill streak whenever entering a playable non-Passage biome!
  if (biomeId !== 'Passage') {
    state.player.killStreak = 0;
  }

  generateBiomeWorld(state, biomeId, rng, collisionApi);

  if (biomeId === 'Passage' && flawlessBossAchieved) {
    state.passageState.flawlessBossDoorOpen = true;
  }

  snapCameraToPlayer(state);
  updateFogOfWarAndRoomDiscovery(state);
  state.runStatus = biomeId === 'Passage' ? 'passage' : 'playing';

  if (biomeId !== 'Passage') {
    state.events.push({
      type: 'biomeTransition',
      from: prevBiome,
      to: biomeId,
    });
  }
}

export function startRunInBiome(state: SimState, biomeId: BiomeId): void {
  const rng = createRng(state.rngState);
  transitionBiomeWithRng(state, biomeId, rng);
  state.rngState = rng.getState();
}

export function warpToBiome(state: SimState, biomeId: BiomeId): void {
  startRunInBiome(state, biomeId);
}

export function spawnBossEncounter(state: SimState, bossId: BossId): void {
  const arenaBiome = BOSS_TO_BIOME[bossId] ?? 'Bridge';
  warpToBiome(state, arenaBiome);

  // Guard: ensure the requested boss exists alive even if called repeatedly
  const hasBoss = state.enemies.some((e) => e.isBoss && e.bossId === bossId && e.hp > 0);
  if (!hasBoss) {
    const floorY = 14 * TILE_SIZE;
    spawnBoss(state, bossId, 31 * TILE_SIZE, floorY - 32);
  }
}

export function stepSim(state: SimState, input: InputFrame): SimState {
  // 1. Drain previous tick events
  state.events = [];

  const rng = createRng(state.rngState);

  // 2. Process queued UI / modal / teleport / passage commands
  if (input.commands && input.commands.length > 0) {
    for (let i = 0; i < input.commands.length; i++) {
      processSimCommand(state, input.commands[i]!, rng);
    }
  }

  // 3. Do not advance combat when on title, paused, dead, or victory screen
  if (state.runStatus !== 'playing' && state.runStatus !== 'passage') {
    state.rngState = rng.getState();
    return state;
  }

  // Pause world simulation cleanly while Scroll Picker or Passage NPC modal is open
  if (
    state.pendingScroll !== null ||
    (state.passageState.active && state.passageState.activeNpc !== 'none')
  ) {
    state.damageFlashAlpha = Math.max(0, state.damageFlashAlpha - 0.04);
    state.parryFlashAlpha = Math.max(0, state.parryFlashAlpha - 0.05);
    stepCamera(state, FIXED_DT, input);
    state.rngState = rng.getState();
    return state;
  }

  const wasDeadBeforeStep = (state.runStatus as string) === 'dead';
  const wasBossDefeatedBeforeStep = state.bossArenaState.defeated;

  state.tick += 1;
  if (state.runStatus === 'playing') {
    state.player.runTimerTicks += 1;
  }

  // Decay screen flashes and boss banner
  if (state.damageFlashAlpha > 0) {
    state.damageFlashAlpha = Math.max(0, state.damageFlashAlpha - 0.055);
  }
  if (state.parryFlashAlpha > 0) {
    state.parryFlashAlpha = Math.max(0, state.parryFlashAlpha - 0.065);
  }
  if (state.bossArenaState.bannerTicks > 0) {
    state.bossArenaState.bannerTicks -= 1;
  }

  // 4. Hitstop & Dramatic Boss-Kill Slow-Mo
  if (state.hitstopTicks > 0) {
    state.hitstopTicks -= 1;
    stepCamera(state, FIXED_DT, input);
    state.rngState = rng.getState();
    return state;
  }

  if (state.slowMoTicks > 0) {
    state.slowMoTicks -= 1;
    if (state.slowMoTicks % 3 !== 0) {
      stepCamera(state, FIXED_DT, input);
      state.rngState = rng.getState();
      return state;
    }
  }

  // 5. Snapshot prevPos on player, enemies, projectiles for 120 FPS render interpolation
  state.player.prevPos.x = state.player.pos.x;
  state.player.prevPos.y = state.player.pos.y;
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    e.prevPos.x = e.pos.x;
    e.prevPos.y = e.pos.y;
  }
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i]!;
    pr.prevPos.x = pr.pos.x;
    pr.prevPos.y = pr.pos.y;
  }

  // 6. Step Physics, Combat, Projectiles/Turrets, Enemies/Bosses, Pickups & Interactions
  stepPlayerPhysics(state, input, rng, collisionApi);

  const isFallStunned = (state.player.fallStunTicks ?? 0) > 0;
  const combatInput: InputFrame = isFallStunned
    ? {
        ...input,
        moveLeft: false,
        moveRight: false,
        jump: false,
        jumpPressed: false,
        rollPressed: false,
        weapon1Pressed: false,
        weapon1Held: false,
        weapon2Pressed: false,
        weapon2Held: false,
        skill1Pressed: false,
        skill2Pressed: false,
        healPressed: false,
        interactPressed: false,
      }
    : input;

  if (state.runStatus === 'playing') {
    stepPlayerCombat(state, combatInput, rng, collisionApi);
    stepProjectilesAndTurrets(state, rng, collisionApi);

    // Check Boss Intro engagement gate BEFORE stepping bosses so unengaged boss stands poised!
    stepBossArenaEngagement(state);
    if (state.bossArenaState.active && state.bossArenaState.engaged === false) {
      // Keep unengaged boss poised facing the player until engagement threshold or hit
      for (let i = 0; i < state.enemies.length; i++) {
        const e = state.enemies[i]!;
        if (e.isBoss && e.hp > 0 && e.state !== 'dead') {
          e.facing = state.player.pos.x >= e.pos.x ? 1 : -1;
          e.vel.x = 0;
          e.state = 'idle';
          e.attackCooldownTicks = Math.max(e.attackCooldownTicks, 20);
        }
      }
    } else {
      stepEnemies(state, rng, collisionApi);
    }

    stepThroneIcePlatforms(state);
    stepBossArenaEngagement(state);
    stepMalaise5BC(state, rng);
  }

  stepPickupsAndTeleporters(state);

  if (
    !isFallStunned &&
    input.interactPressed &&
    (state.runStatus === 'playing' || state.runStatus === 'passage')
  ) {
    handleWorldInteraction(state, rng);
  }

  // Bank retained Gold Reserves on death into metaSnapshot.bankedGold!
  if (!wasDeadBeforeStep && (state.runStatus as string) === 'dead') {
    const cap = GOLD_RESERVES_BY_TIER[Math.min(4, Math.max(0, state.metaSnapshot.goldReserveTier))] ?? 0;
    state.metaSnapshot.bankedGold = Math.min(cap, Math.max(0, Math.floor(state.player.gold)));
  }

  // 7. Boss Victory & Arena Exit Unlock Sync
  if (state.bossArenaState.defeated) {
    if (!wasBossDefeatedBeforeStep && !state.bossArenaState.playerTookHit) {
      state.passageState.flawlessBossDoorOpen = true;
    }
    for (let i = 0; i < state.doors.length; i++) {
      const d = state.doors[i]!;
      if (d.kind === 'biomeExit' || d.kind === 'bossGate') {
        d.opened = true;
      }
    }
    // Sovereign Throne Victory is triggered cleanly via [F] on 'Claim the Sovereign Throne'
    // (no instant skip on HoTK death; verify-sim.ts walks to the Throne shrine & interacts!)
  }

  // 8. Fog-of-War, Particles, Dynamic Lights & Camera
  updateFogOfWarAndRoomDiscovery(state);
  stepSimParticlesAndLights(state);
  stepCamera(state, FIXED_DT, input);

  // 9. Persist deterministic PRNG state for bit-exact replays
  state.rngState = rng.getState();
  return state;
}
