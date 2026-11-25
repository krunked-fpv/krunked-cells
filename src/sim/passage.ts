import {
  TILE_SIZE,
  type BiomeId,
  type GearInstance,
  type GearQuality,
  type MetaBlueprintDef,
  type RngAPI,
  type ScrollStat,
  type SimCommand,
  type SimState,
} from '../contracts';
import {
  META_BLUEPRINTS,
  META_BLUEPRINT_MAP,
  MUTATION_MAP,
  SKILL_MAP,
  WEAPON_MAP,
  getBiome,
  getDifficulty,
} from '../data';
import {
  applyGearScrollDelta,
  getAffixCountForQuality,
  rollAffixes,
  rollGearInstance,
} from './roguelite';

export function getForgeUpgradeCost(gear: GearInstance): number {
  switch (gear.quality) {
    case 'base':
      return 250 + gear.level * 50;
    case '+':
      return 600 + gear.level * 100;
    case '++':
      return 1400 + gear.level * 150;
    case 'S':
    case 'L':
      return 0;
  }
}

export function getNextGearQuality(quality: GearQuality): GearQuality | null {
  switch (quality) {
    case 'base':
      return '+';
    case '+':
      return '++';
    case '++':
      return 'S';
    case 'S':
    case 'L':
      return null;
  }
}

export function getForgeReforgeCost(state: SimState, gear: GearInstance): number {
  return 150 + state.passageState.reforgeCount * 100 + gear.level * 25;
}

export function getMutationRespecCost(state: SimState): number {
  return 500 + state.passageState.reforgeCount * 500;
}

function findBlueprint(idOrTarget: string): MetaBlueprintDef | undefined {
  if (META_BLUEPRINT_MAP[idOrTarget]) {
    return META_BLUEPRINT_MAP[idOrTarget];
  }
  return META_BLUEPRINTS.find((b) => b.targetId === idOrTarget);
}

function getBlueprintCurrentTier(state: SimState, bp: MetaBlueprintDef): number {
  const meta = state.metaSnapshot;
  if (bp.id === 'health_flask') return meta.flaskTier;
  if (bp.id === 'gold_reserves') return meta.goldReserveTier;
  if (bp.id === 'random_starter') return meta.randomStarterUnlocked ? 1 : 0;
  if (bp.id === 'recycling') return meta.recycleUnlocked ? 1 : 0;
  if (bp.targetId) {
    return meta.unlockedBlueprints.includes(bp.targetId) ? 1 : 0;
  }
  return 0;
}

function spawnBonusDoorRewards(
  state: SimState,
  x: number,
  y: number,
  level: number,
  labelPrefix: string,
  rng: RngAPI
): void {
  // Authentic Dead Cells 3-Choice Gear Altar behind bonus doors (picking 1 consumes the other 2!)
  const choiceGroupId = state.nextUid++;
  const colors: readonly ScrollStat[] = ['brutality', 'tactics', 'survival'];
  for (let i = 0; i < 3; i++) {
    const slotKind = i === 2 ? 'skill' : 'weapon';
    const gear = rollGearInstance(state, rng, slotKind, Math.max(2, level + 1), colors[i]);
    const px = x + (i - 1) * 24;
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gear',
      pos: { x: px, y: y - 10 },
      prevPos: { x: px, y: y - 10 },
      vel: { x: 0, y: 0 },
      value: 0,
      gear,
      label: `${labelPrefix} Choice ${i + 1}`,
      magnetTicks: 0,
      collected: false,
      bobPhase: i * 0.9,
      choiceGroupId,
    });
  }

  state.pickups.push({
    uid: state.nextUid++,
    kind: 'cell',
    pos: { x: x + 36, y: y - 8 },
    prevPos: { x: x + 36, y: y - 8 },
    vel: { x: 0, y: 0 },
    value: 20,
    label: '+20 Cells',
    magnetTicks: 0,
    collected: false,
    bobPhase: 1.2,
  });

  state.pickups.push({
    uid: state.nextUid++,
    kind: 'gold',
    pos: { x: x - 36, y: y - 8 },
    prevPos: { x: x - 36, y: y - 8 },
    vel: { x: 0, y: 0 },
    value: 250 + level * 75,
    magnetTicks: 0,
    collected: false,
    bobPhase: 2.4,
  });
}

function spawnFlawlessBossRewards(
  state: SimState,
  x: number,
  y: number,
  level: number,
  rng: RngAPI
): void {
  const legGear = rollGearInstance(
    state,
    rng,
    rng.chance(0.7) ? 'weapon' : 'skill',
    Math.max(3, level + 2),
    undefined,
    true
  );
  state.pickups.push({
    uid: state.nextUid++,
    kind: 'gear',
    pos: { x, y: y - 10 },
    prevPos: { x, y: y - 10 },
    vel: { x: 0, y: 0 },
    value: 0,
    gear: legGear,
    label: `Flawless Legendary ${legGear.defId}`,
    magnetTicks: 0,
    collected: false,
    bobPhase: 0,
  });

  state.pickups.push({
    uid: state.nextUid++,
    kind: 'cell',
    pos: { x: x + 22, y: y - 8 },
    prevPos: { x: x + 22, y: y - 8 },
    vel: { x: 0, y: 0 },
    value: 25,
    label: '+25 Cells',
    magnetTicks: 0,
    collected: false,
    bobPhase: 1.1,
  });

  state.pickups.push({
    uid: state.nextUid++,
    kind: 'gold',
    pos: { x: x - 22, y: y - 8 },
    prevPos: { x: x - 22, y: y - 8 },
    vel: { x: 0, y: 0 },
    value: 500,
    magnetTicks: 0,
    collected: false,
    bobPhase: 2.2,
  });
}

function ensureFountainCounters(state: SimState): {
  fountainLeft: number;
  singleLeft: number;
} {
  const diff = getDifficulty(state.bossStemCells);
  if (state.fountainRefillsLeft === undefined) {
    state.fountainRefillsLeft = diff.fountainRefills;
  }
  if (state.singleFlaskRefillsLeft === undefined) {
    state.singleFlaskRefillsLeft = diff.singleFlaskRefills;
  }
  return {
    fountainLeft: state.fountainRefillsLeft,
    singleLeft: state.singleFlaskRefillsLeft,
  };
}

export function enterPassageRoom(
  state: SimState,
  fromBiome: BiomeId,
  nextBiomes: BiomeId[],
  rng: RngAPI
): void {
  const prevDef = getBiome(fromBiome);
  const { fountainLeft, singleLeft } = ensureFountainCounters(state);

  const timedTargetTicks =
    prevDef.timedDoorMinutes > 0 ? prevDef.timedDoorMinutes * 60 * 60 : 0;
  const timedDoorOpen =
    timedTargetTicks > 0 && state.player.runTimerTicks <= timedTargetTicks;

  const killStreakTarget = prevDef.killStreakDoorTarget;
  const killStreakDoorOpen =
    killStreakTarget > 0 && state.player.killStreak >= killStreakTarget;

  // Flawless Boss Door (0 hits taken in Bridge / TopClockTower)
  const flawlessBossDoorOpen = Boolean(
    prevDef.isBossArena &&
      state.bossArenaState.defeated &&
      state.bossArenaState.playerTookHit !== true
  );

  // Clear combat & biome transient entities
  state.enemies = [];
  state.projectiles = [];
  state.turrets = [];
  state.hazards = [];
  state.chests = [];
  state.teleporters = [];
  state.pickups = [];
  state.doors = [];
  state.shrines = [];
  state.pendingScroll = null;

  state.bossArenaState.active = false;
  state.bossArenaState.bossId = null;
  state.bossArenaState.bossUid = null;
  state.bossArenaState.playerTookHit = false;

  state.activeBiomeId = 'Passage';
  if (!state.biomesVisited.includes('Passage')) {
    state.biomesVisited.push('Passage');
  }
  state.runStatus = 'passage';

  state.passageState = {
    active: true,
    fromBiome,
    nextBiomes: [...nextBiomes],
    timedDoorOpen,
    timedDoorClaimed: timedDoorOpen,
    killStreakDoorOpen,
    killStreakDoorClaimed: killStreakDoorOpen,
    timedTargetTicks,
    killStreakTarget,
    fountainUsed: false,
    activeNpc: 'none',
    reforgeCount: 0,
    flawlessBossDoorOpen,
    flawlessBossDoorClaimed: flawlessBossDoorOpen,
  };

  // Determine Passage safe room floor baseline
  const passageRoom = state.rooms.find((r) => r.type === 'passage') ?? state.rooms[0];
  const baseX = passageRoom ? (passageRoom.tx + 4) * TILE_SIZE : 6 * TILE_SIZE;
  const floorY = passageRoom
    ? (passageRoom.ty + passageRoom.th - 2) * TILE_SIZE
    : Math.max(8 * TILE_SIZE, state.player.pos.y);

  // Lay out NPC shrines along the safe room (reflecting remaining BC refill limits!)
  const fountainLabel =
    fountainLeft > 0
      ? state.bossStemCells === 0
        ? 'Health Fountain (Full Heal & Flask)'
        : `Health Fountain (${fountainLeft} Full Refill${fountainLeft === 1 ? '' : 's'} Left)`
      : singleLeft > 0
        ? `Flask Dispenser (+1 Charge, ${singleLeft} Left)`
        : 'Shattered Health Fountain';

  state.shrines.push(
    {
      uid: state.nextUid++,
      pos: { x: baseX + 72, y: floorY },
      kind: 'fountain',
      used: fountainLeft <= 0 && singleLeft <= 0,
      label: fountainLabel,
    },
    {
      uid: state.nextUid++,
      pos: { x: baseX + 168, y: floorY },
      kind: 'collector',
      used: false,
      label: 'The Collector',
    },
    {
      uid: state.nextUid++,
      pos: { x: baseX + 264, y: floorY },
      kind: 'guillain',
      used: false,
      label: 'Guillain (Mutations)',
    },
    {
      uid: state.nextUid++,
      pos: { x: baseX + 360, y: floorY },
      kind: 'forge',
      used: false,
      label: prevDef.isBossArena ? 'Minor & Legendary Forge' : 'Minor Forge',
    }
  );

  // Timed Door (2:00 after PrisonStart, 8:00 after Promenade/Sewers, 15:00 after Black Bridge)
  if (timedTargetTicks > 0) {
    const timedX = baseX + 456;
    state.doors.push({
      uid: state.nextUid++,
      pos: { x: timedX, y: floorY },
      width: 24,
      height: 44,
      kind: 'timed',
      opened: timedDoorOpen,
      broken: false,
      label: `Timed Door (< ${prevDef.timedDoorMinutes}m)`,
    });
    if (timedDoorOpen) {
      spawnBonusDoorRewards(state, timedX, floorY, prevDef.depthTier, 'Timed Door', rng);
    }
  }

  // 30 / 60 Kill-Streak No-Hit Door (regular biomes) OR Flawless Boss Door (post-boss)
  if (killStreakTarget > 0) {
    const streakX = baseX + 528;
    state.doors.push({
      uid: state.nextUid++,
      pos: { x: streakX, y: floorY },
      width: 24,
      height: 44,
      kind: 'killStreak',
      opened: killStreakDoorOpen,
      broken: false,
      label: `${killStreakTarget} Kill-Streak Door`,
    });
    if (killStreakDoorOpen) {
      spawnBonusDoorRewards(
        state,
        streakX,
        floorY,
        prevDef.depthTier,
        `${killStreakTarget}-Kill Streak`,
        rng
      );
    }
  } else if (prevDef.isBossArena) {
    const flawlessX = baseX + 528;
    state.doors.push({
      uid: state.nextUid++,
      pos: { x: flawlessX, y: floorY },
      width: 24,
      height: 44,
      kind: 'killStreak',
      opened: flawlessBossDoorOpen,
      broken: false,
      label: 'Flawless Boss Door (No-Hit)',
    });
    if (flawlessBossDoorOpen) {
      spawnFlawlessBossRewards(state, flawlessX, floorY, prevDef.depthTier, rng);
    }
  }

  // Next Biome Exit Doors
  for (let i = 0; i < nextBiomes.length; i++) {
    const targetId = nextBiomes[i]!;
    const targetDef = getBiome(targetId);
    state.doors.push({
      uid: state.nextUid++,
      pos: { x: baseX + 612 + i * 72, y: floorY },
      width: 28,
      height: 48,
      kind: 'biomeExit',
      opened: true,
      broken: false,
      targetBiomeId: targetId,
      label: `Enter ${targetDef.name}`,
    });
  }

  state.events.push({
    type: 'biomeTransition',
    from: fromBiome,
    to: 'Passage',
  });
}

export function handlePassageCommand(
  state: SimState,
  cmd: SimCommand,
  rng: RngAPI
): boolean {
  const player = state.player;
  const passage = state.passageState;

  switch (cmd.type) {
    case 'openPassageNpc': {
      passage.activeNpc = cmd.npc;
      return true;
    }

    case 'collectorInvest': {
      const bp = findBlueprint(cmd.blueprintId);
      if (!bp) return false;

      const currentTier = getBlueprintCurrentTier(state, bp);
      if (currentTier >= bp.maxTier) return false;

      const tierCost = bp.costs[currentTier] ?? bp.costs[bp.costs.length - 1]!;
      const currentProgress = state.metaSnapshot.blueprintProgress[bp.id] ?? 0;
      const remaining = Math.max(0, tierCost - currentProgress);
      const requested = Math.max(1, Math.floor(cmd.amount));
      const spend = Math.min(player.cells, requested, remaining);
      if (spend <= 0) return false;

      player.cells -= spend;
      const newProgress = currentProgress + spend;
      state.metaSnapshot.blueprintProgress[bp.id] = newProgress;

      if (newProgress >= tierCost) {
        state.metaSnapshot.blueprintProgress[bp.id] = 0;
        if (bp.id === 'health_flask') {
          state.metaSnapshot.flaskTier = Math.min(bp.maxTier, state.metaSnapshot.flaskTier + 1);
          player.maxFlaskCharges = Math.max(player.maxFlaskCharges, state.metaSnapshot.flaskTier);
          player.flaskCharges = Math.min(player.maxFlaskCharges, player.flaskCharges + 1);
        } else if (bp.id === 'gold_reserves') {
          state.metaSnapshot.goldReserveTier = Math.min(
            bp.maxTier,
            state.metaSnapshot.goldReserveTier + 1
          );
        } else if (bp.id === 'random_starter') {
          state.metaSnapshot.randomStarterUnlocked = true;
        } else if (bp.id === 'recycling') {
          state.metaSnapshot.recycleUnlocked = true;
        } else if (bp.targetId) {
          if (!state.metaSnapshot.unlockedBlueprints.includes(bp.targetId)) {
            state.metaSnapshot.unlockedBlueprints.push(bp.targetId);
          }
          // Collector drops a complimentary unlocked weapon or skill right on unlock!
          const isWeapon = Boolean(WEAPON_MAP[bp.targetId]);
          const isSkill = Boolean(SKILL_MAP[bp.targetId]);
          if (isWeapon || isSkill) {
            const prevTier = Math.max(1, getBiome(passage.fromBiome).depthTier);
            const gear = rollGearInstance(
              state,
              rng,
              isWeapon ? 'weapon' : 'skill',
              prevTier,
              undefined,
              false,
              bp.targetId
            );
            state.pickups.push({
              uid: state.nextUid++,
              kind: 'gear',
              pos: { x: player.pos.x + 18, y: player.pos.y - 6 },
              prevPos: { x: player.pos.x + 18, y: player.pos.y - 6 },
              vel: { x: 20, y: -90 },
              value: 0,
              gear,
              label: `Unlocked ${bp.name}`,
              magnetTicks: 0,
              collected: false,
              bobPhase: 0,
            });
          }
        }
      }
      return true;
    }

    case 'legendaryForgeInvest': {
      const prevDef = getBiome(passage.fromBiome);
      if (!prevDef.isBossArena) return false;
      const requested = Math.max(1, Math.floor(cmd.amount));
      if (cmd.tier === 'plus') {
        const cur = state.metaSnapshot.legendaryForgePlus ?? 0;
        const remaining = Math.max(0, 100 - cur);
        const spend = Math.min(player.cells, requested, remaining);
        if (spend <= 0) return false;
        player.cells -= spend;
        state.metaSnapshot.legendaryForgePlus = Math.min(100, cur + spend);
        return true;
      } else {
        const plusCur = state.metaSnapshot.legendaryForgePlus ?? 0;
        if (plusCur < 100) return false;
        const cur = state.metaSnapshot.legendaryForgePlusPlus ?? 0;
        const remaining = Math.max(0, 100 - cur);
        const spend = Math.min(player.cells, requested, remaining);
        if (spend <= 0) return false;
        player.cells -= spend;
        state.metaSnapshot.legendaryForgePlusPlus = Math.min(100, cur + spend);
        return true;
      }
    }

    case 'pickMutation': {
      if (!MUTATION_MAP[cmd.mutationId]) return false;
      if (player.mutations.includes(cmd.mutationId)) return false;

      if (
        cmd.slotIndex !== undefined &&
        cmd.slotIndex >= 0 &&
        cmd.slotIndex < 3 &&
        cmd.slotIndex < player.mutations.length
      ) {
        player.mutations[cmd.slotIndex] = cmd.mutationId;
        return true;
      }

      if (player.mutations.length >= 3) return false;
      player.mutations.push(cmd.mutationId);
      return true;
    }

    case 'respecMutations': {
      if (player.mutations.length === 0) return false;
      const cost = getMutationRespecCost(state);
      if (player.gold < cost) return false;
      player.gold -= cost;
      passage.reforgeCount += 1;
      player.mutations = [];
      return true;
    }

    case 'forgeUpgrade': {
      const gear = player.loadout[cmd.slot];
      if (!gear) return false;
      const nextQuality = getNextGearQuality(gear.quality);
      if (!nextQuality) return false;

      const cost = getForgeUpgradeCost(gear);
      if (player.gold < cost) return false;
      player.gold -= cost;

      // Remove old bonusScrolls delta before applying upgraded bonusScrolls!
      applyGearScrollDelta(state, gear, -1);

      gear.quality = nextQuality;
      const weaponKind = gear.slotKind === 'weapon' ? WEAPON_MAP[gear.defId]?.kind : undefined;
      gear.affixes = rollAffixes(
        rng,
        getAffixCountForQuality(nextQuality),
        undefined,
        gear.slotKind,
        weaponKind,
        gear.defId
      );

      const statKey: ScrollStat = gear.color === 'colorless' ? 'brutality' : gear.color;
      if (nextQuality === '++') {
        gear.bonusScrolls = { [statKey]: 1 };
      } else if (nextQuality === 'S') {
        gear.bonusScrolls = { [statKey]: 2 };
      }
      applyGearScrollDelta(state, gear, 1);
      return true;
    }

    case 'forgeReforge': {
      const gear = player.loadout[cmd.slot];
      if (!gear) return false;
      const cost = getForgeReforgeCost(state, gear);
      if (player.gold < cost) return false;

      player.gold -= cost;
      passage.reforgeCount += 1;
      const weaponKind = gear.slotKind === 'weapon' ? WEAPON_MAP[gear.defId]?.kind : undefined;
      gear.affixes = rollAffixes(
        rng,
        getAffixCountForQuality(gear.quality),
        undefined,
        gear.slotKind,
        weaponKind,
        gear.defId
      );
      return true;
    }

    case 'useFountain': {
      if (passage.fountainUsed) return false;
      const { fountainLeft, singleLeft } = ensureFountainCounters(state);

      if (fountainLeft > 0) {
        const healed = Math.max(0, player.maxHp - player.hp);
        player.hp = player.maxHp;
        player.rallyHp = 0;
        player.flaskCharges = player.maxFlaskCharges;
        state.fountainRefillsLeft = Math.max(0, fountainLeft - 1);
        passage.fountainUsed = true;
        const fountainShrine = state.shrines.find((s) => s.kind === 'fountain');
        if (fountainShrine) fountainShrine.used = true;
        state.events.push({
          type: 'flaskDrink',
          x: player.pos.x,
          y: player.pos.y,
          healed,
        });
        return true;
      }

      if (singleLeft > 0) {
        const healAmt = Math.round(player.maxHp * 0.3);
        const beforeHp = player.hp;
        player.hp = Math.min(player.maxHp, player.hp + healAmt);
        player.rallyHp = 0;
        player.flaskCharges = Math.min(player.maxFlaskCharges, player.flaskCharges + 1);
        state.singleFlaskRefillsLeft = Math.max(0, singleLeft - 1);
        passage.fountainUsed = true;
        const fountainShrine = state.shrines.find((s) => s.kind === 'fountain');
        if (fountainShrine) fountainShrine.used = true;
        state.events.push({
          type: 'flaskDrink',
          x: player.pos.x,
          y: player.pos.y,
          healed: player.hp - beforeHp,
        });
        return true;
      }

      return false;
    }

    case 'enterBiome': {
      passage.active = false;
      passage.activeNpc = 'none';
      state.runStatus = 'playing';
      return true;
    }

    default:
      return false;
  }
}
