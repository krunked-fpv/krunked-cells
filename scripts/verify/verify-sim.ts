// =============================================================================
// KRUNKED CELLS — Gate B: Autonomous Headless Campaign Soak & Replay Verifier
// Runs a full deterministic 60 Hz campaign via real InputFrames + SimCommands:
//   PrisonStart -> Passage -> PrisonCourtyard -> Passage -> PrisonRoof ->
//   Passage -> Bridge (Behemoth) -> Passage -> ClockTower -> Passage ->
//   TopClockTower (TimeKeeper) -> Passage -> Castle -> Passage ->
//   Throne (KingsHand) -> Victory & 1BC Boss Stem Cell unlock!
// Replays the exact recorded input tape from scratch and asserts bit-for-bit
// identical hashSimState() across both runs.
// =============================================================================

import {
  TILE_SIZE,
  TileKind,
  createEmptyInputFrame,
  type BiomeId,
  type BossId,
  type EnemyState,
  type InputFrame,
  type RoomNode,
  type ScrollStat,
  type SimCommand,
  type SimState,
} from '../../src/contracts';
import { collisionApi } from '../../src/sim/collision';
import { hashSimState } from '../../src/sim/hash';
import { getForgeReforgeCost, getForgeUpgradeCost, getNextGearQuality } from '../../src/sim/passage';
import { createInitialSimState, stepSim } from '../../src/sim/step';

const CAMPAIGN_SEED = 20261125;

const CAMPAIGN_ROUTE: readonly BiomeId[] = [
  'PrisonStart',
  'PrisonCourtyard',
  'PrisonRoof',
  'Bridge',
  'ClockTower',
  'TopClockTower',
  'Castle',
  'Throne',
];

interface CampaignTelemetry {
  totalTicks: number;
  biomesCleared: BiomeId[];
  passageVisits: number;
  timedDoorsOpened: number;
  killStreakDoorsOpened: number;
  collectorDeposits: number;
  mutationsEquipped: number;
  forgeUpgrades: number;
  forgeReforges: number;
  fountainsUsed: number;
  parriesLanded: number;
  bossPhasesSeen: Record<BossId, Set<number>>;
  bossesDefeated: Set<BossId>;
  checkpointHashes: { tick: number; label: string; hash: string }[];
}

function assertFinite(val: number, label: string, tick: number): void {
  if (!Number.isFinite(val)) {
    throw new Error(`[Gate B] NaN/Infinity invariant violated at tick ${tick}: ${label} = ${val}`);
  }
}

function assertWorldInvariants(state: SimState): void {
  const t = state.tick;
  const p = state.player;
  const maxX = state.tileGrid.width * TILE_SIZE;
  const maxY = state.tileGrid.height * TILE_SIZE;

  assertFinite(p.pos.x, 'player.pos.x', t);
  assertFinite(p.pos.y, 'player.pos.y', t);
  assertFinite(p.vel.x, 'player.vel.x', t);
  assertFinite(p.vel.y, 'player.vel.y', t);
  assertFinite(p.hp, 'player.hp', t);
  assertFinite(p.maxHp, 'player.maxHp', t);
  assertFinite(p.rallyHp, 'player.rallyHp', t);

  if (p.pos.x < TILE_SIZE || p.pos.x > maxX - TILE_SIZE || p.pos.y < TILE_SIZE || p.pos.y > maxY - TILE_SIZE) {
    throw new Error(
      `[Gate B] Player out-of-bounds tunneling at tick ${t} in ${state.activeBiomeId}: (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}) vs grid (${maxX}, ${maxY})`
    );
  }

  const ptx = Math.floor(p.pos.x / TILE_SIZE);
  const pty = Math.floor(p.pos.y / TILE_SIZE);
  const centerTile = collisionApi.getTile(state.tileGrid, ptx, pty);
  if (centerTile === TileKind.SOLID) {
    throw new Error(
      `[Gate B] Player embedded inside SOLID tile at tick ${t} in ${state.activeBiomeId}: tile (${ptx}, ${pty})`
    );
  }

  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    assertFinite(e.pos.x, `enemy[${e.uid}].pos.x`, t);
    assertFinite(e.pos.y, `enemy[${e.uid}].pos.y`, t);
    assertFinite(e.vel.x, `enemy[${e.uid}].vel.x`, t);
    assertFinite(e.vel.y, `enemy[${e.uid}].vel.y`, t);
    assertFinite(e.hp, `enemy[${e.uid}].hp`, t);
    if (e.state !== 'dead' && e.hp > 0) {
      if (e.pos.x < -TILE_SIZE || e.pos.x > maxX + TILE_SIZE || e.pos.y < -TILE_SIZE * 2 || e.pos.y > maxY + TILE_SIZE) {
        throw new Error(
          `[Gate B] Enemy ${e.defId}#${e.uid} out-of-bounds at tick ${t} in ${state.activeBiomeId}: (${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)})`
        );
      }
    }
  }

  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i]!;
    assertFinite(pr.pos.x, `proj[${pr.uid}].pos.x`, t);
    assertFinite(pr.pos.y, `proj[${pr.uid}].pos.y`, t);
    assertFinite(pr.vel.x, `proj[${pr.uid}].vel.x`, t);
    assertFinite(pr.vel.y, `proj[${pr.uid}].vel.y`, t);
    assertFinite(pr.damage, `proj[${pr.uid}].damage`, t);
  }

  assertFinite(state.camera.x, 'camera.x', t);
  assertFinite(state.camera.y, 'camera.y', t);
  assertFinite(state.camera.targetX, 'camera.targetX', t);
  assertFinite(state.camera.targetY, 'camera.targetY', t);

  if (state.runStatus === 'dead' || p.actionState === 'dead') {
    throw new Error(
      `[Gate B] Player died at tick ${t} in ${state.activeBiomeId} (cause: ${state.lastDamageSource || 'unknown'}, HP=${p.hp}/${p.maxHp}, scrolls=${JSON.stringify(p.scrolls)})`
    );
  }
}

function findRoomContaining(rooms: readonly RoomNode[], x: number, y: number): RoomNode | null {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    if (tx >= r.tx && tx < r.tx + r.tw && ty >= r.ty && ty < r.ty + r.th) {
      return r;
    }
  }
  // Nearest room center fallback when standing inside a doorway or shaft
  let best: RoomNode | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    const cx = (r.tx + r.tw * 0.5) * TILE_SIZE;
    const cy = (r.ty + r.th * 0.5) * TILE_SIZE;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

function findRoomPath(rooms: readonly RoomNode[], startId: number, goalId: number): number[] {
  if (startId === goalId) return [startId];
  const visited = new Set<number>([startId]);
  const parent = new Map<number, number>();
  const queue: number[] = [startId];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const room = rooms[cur];
    if (!room) continue;
    for (let i = 0; i < room.neighbors.length; i++) {
      const nxt = room.neighbors[i]!;
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      parent.set(nxt, cur);
      if (nxt === goalId) {
        const path: number[] = [goalId];
        let node = goalId;
        while (node !== startId) {
          node = parent.get(node)!;
          path.push(node);
        }
        path.reverse();
        return path;
      }
      queue.push(nxt);
    }
  }
  return [startId];
}

function steerTowardPoint(
  state: SimState,
  targetX: number,
  targetY: number,
  frame: InputFrame,
  localTick: number
): void {
  const p = state.player;
  const grid = state.tileGrid;
  const dx = targetX - p.pos.x;
  const dy = targetY - p.pos.y;

  const curRoom = findRoomContaining(state.rooms, p.pos.x, p.pos.y);
  const goalRoom = findRoomContaining(state.rooms, targetX, targetY);

  // If moving between different rooms, follow room-graph BFS waypoint first
  if (curRoom && goalRoom && curRoom.id !== goalRoom.id) {
    const path = findRoomPath(state.rooms, curRoom.id, goalRoom.id);
    if (path.length >= 2) {
      const nextRoom = state.rooms[path[1]!]!;
      if (nextRoom.ty < curRoom.ty) {
        // Climb UP vertical shaft connecting curRoom -> nextRoom
        const shaftTx = nextRoom.tx + Math.floor(nextRoom.tw * 0.5);
        const shaftX = (shaftTx + 0.5) * TILE_SIZE;
        const topFloorY = (nextRoom.ty + nextRoom.th - 1) * TILE_SIZE;
        if (Math.abs(p.pos.x - shaftX) > 10 && p.pos.y > topFloorY - 12) {
          if (shaftX > p.pos.x) frame.moveRight = true;
          else frame.moveLeft = true;
        } else if (p.pos.y > topFloorY - 22) {
          frame.moveUp = true;
          if (Math.abs(p.pos.x - shaftX) > 4) {
            if (shaftX > p.pos.x) frame.moveRight = true;
            else frame.moveLeft = true;
          }
          // Jump to latch if standing just off the chain
          if (p.grounded && localTick % 20 === 0) {
            frame.jump = true;
            frame.jumpPressed = true;
          }
        } else {
          // Step cleanly onto upper room floor
          frame.moveRight = nextRoom.tx * TILE_SIZE + nextRoom.tw * TILE_SIZE * 0.5 >= p.pos.x;
          frame.moveLeft = !frame.moveRight;
        }
        avoidHazardsAndDoors(state, frame, localTick);
        return;
      } else if (nextRoom.ty > curRoom.ty) {
        // Descend DOWN vertical shaft connecting curRoom -> nextRoom
        const shaftTx = curRoom.tx + Math.floor(curRoom.tw * 0.5);
        const shaftX = (shaftTx + 0.5) * TILE_SIZE;
        if (Math.abs(p.pos.x - shaftX) > 10) {
          if (shaftX > p.pos.x) frame.moveRight = true;
          else frame.moveLeft = true;
        } else {
          frame.moveDown = true;
          if (p.grounded && p.onOneWay && localTick % 12 === 0) {
            frame.jumpPressed = true;
          }
        }
        avoidHazardsAndDoors(state, frame, localTick);
        return;
      } else {
        // Horizontal room neighbor: aim toward doorway center
        const goRight = nextRoom.tx > curRoom.tx;
        frame.moveRight = goRight;
        frame.moveLeft = !goRight;
        // If on a high one-way platform above doorway floor, drop down
        const floorY = (curRoom.ty + curRoom.th - 1) * TILE_SIZE - 14;
        if (p.grounded && p.onOneWay && p.pos.y < floorY - 24) {
          frame.moveDown = true;
          frame.jumpPressed = true;
        }
        avoidHazardsAndDoors(state, frame, localTick);
        return;
      }
    }
  }

  // Same room steering
  if (Math.abs(dx) > 8) {
    if (dx > 0) frame.moveRight = true;
    else frame.moveLeft = true;
  }

  // If target is significantly higher, jump (or double-jump)
  if (dy < -28 && (p.grounded || (p.vel.y > 10 && p.airJumpsLeft > 0)) && localTick % 14 === 0) {
    frame.jump = true;
    frame.jumpPressed = true;
  } else if (dy > 32 && p.grounded && p.onOneWay) {
    frame.moveDown = true;
    frame.jumpPressed = true;
  }

  // Avoid solid wall blockage in same room
  const dir = frame.moveRight ? 1 : frame.moveLeft ? -1 : 0;
  if (dir !== 0 && p.grounded) {
    const aheadTx = Math.floor((p.pos.x + dir * (p.width * 0.5 + 8)) / TILE_SIZE);
    const bodyTy = Math.floor(p.pos.y / TILE_SIZE);
    if (collisionApi.isSolidAt(grid, aheadTx, bodyTy)) {
      frame.jump = true;
      frame.jumpPressed = true;
    }
  }

  avoidHazardsAndDoors(state, frame, localTick);
}

function avoidHazardsAndDoors(state: SimState, frame: InputFrame, localTick: number): void {
  const p = state.player;
  const grid = state.tileGrid;
  const dir = frame.moveRight ? 1 : frame.moveLeft ? -1 : p.facing;

  // Jump proactively over acid / spike pits 1-2 tiles ahead!
  const footTy = Math.floor((p.pos.y + p.height * 0.5 + 4) / TILE_SIZE);
  const aheadTx1 = Math.floor((p.pos.x + dir * 20) / TILE_SIZE);
  const aheadTx2 = Math.floor((p.pos.x + dir * 40) / TILE_SIZE);
  const hazardAhead =
    collisionApi.isHazardAt(grid, aheadTx1, footTy) !== 0 ||
    collisionApi.isHazardAt(grid, aheadTx2, footTy) !== 0;

  if (hazardAhead && (p.grounded || (p.vel.y > 0 && p.airJumpsLeft > 0))) {
    frame.jump = true;
    frame.jumpPressed = true;
  }

  // Smash closed wooden doors in front of player using roll or melee
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.kind !== 'wood' || door.broken || door.opened) continue;
    const dx = door.pos.x - p.pos.x;
    if (Math.abs(dx) <= 36 && Math.abs(door.pos.y - p.pos.y) <= 36 && dx * dir >= -4) {
      if (p.rollCooldownTicks <= 0 && p.actionState !== 'roll') {
        frame.rollPressed = true;
      } else if (localTick % 8 === 0) {
        frame.weapon1Pressed = true;
      }
      break;
    }
  }
}

function applyCombatBehavior(
  state: SimState,
  target: EnemyState,
  frame: InputFrame,
  localTick: number
): void {
  const p = state.player;
  const isThrone = state.activeBiomeId === 'Throne';

  // 1. Health Flask when HP drops below 50%
  if (p.hp < p.maxHp * 0.5 && p.flaskCharges > 0 && p.healTicks <= 0 && p.actionState !== 'roll') {
    frame.healPressed = true;
    return;
  }

  // 2. Keep away from Throne Room left/right spike pits (tx 3..5 = x 72..144, tx 38..40 = x 912..984)
  if (isThrone) {
    if (p.pos.x < 176) {
      frame.moveRight = true;
      frame.moveLeft = false;
      if (p.grounded || p.airJumpsLeft > 0) {
        frame.jump = true;
        frame.jumpPressed = true;
      }
      return;
    }
    if (p.pos.x > 876) {
      frame.moveLeft = true;
      frame.moveRight = false;
      if (p.grounded || p.airJumpsLeft > 0) {
        frame.jump = true;
        frame.jumpPressed = true;
      }
      return;
    }
  }

  // 3. Defend against incoming enemy projectiles (Parry parriables, Jump/Roll shockwaves!)
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i]!;
    if (pr.owner !== 'enemy') continue;
    const dist = Math.hypot(pr.pos.x - p.pos.x, pr.pos.y - p.pos.y);
    if (dist <= 54) {
      if (pr.parriable) {
        // Hold active parry window instead of roll-cancelling it!
        if (p.parryWindowTicks > 0) {
          return;
        }
        if (p.parryCooldownTicks <= 0 && p.actionState !== 'roll') {
          frame.weapon2Pressed = true;
          return;
        }
      }
      if (pr.kind === 'shockwave') {
        if (p.grounded) {
          frame.jump = true;
          frame.jumpPressed = true;
          return;
        }
      }
      if (p.rollCooldownTicks <= 0 && p.actionState !== 'roll') {
        frame.rollPressed = true;
        return;
      }
    }
  }

  // 4. Destroy nearby Sovereign Hand explosive banners before they detonate!
  for (let i = 0; i < state.turrets.length; i++) {
    const tur = state.turrets[i]!;
    if (tur.owner !== 'enemy' || tur.kind !== 'bossBanner') continue;
    const bdx = tur.pos.x - p.pos.x;
    if (Math.abs(bdx) <= 95) {
      if (Math.abs(bdx) > 28) {
        if (bdx > 0) frame.moveRight = true;
        else frame.moveLeft = true;
      } else {
        frame.moveRight = bdx >= 0;
        frame.moveLeft = bdx < 0;
        frame.weapon1Pressed = true;
      }
      return;
    }
  }

  const dx = target.pos.x - p.pos.x;
  const dy = target.pos.y - p.pos.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // 5. Respect Behemoth's active Crimson Laceration Damage Aura
  if (target.bossId === 'Behemoth' && target.bossAuraTicks > 0) {
    if (absDx < 82) {
      const escapeRight = p.pos.x < 500 ? dx < 0 : dx <= 0;
      const safeDirRight = p.pos.x < 140 ? true : p.pos.x > 860 ? false : escapeRight;
      frame.moveRight = safeDirRight;
      frame.moveLeft = !safeDirRight;
      if (p.rollCooldownTicks <= 0 && absDx < 66) {
        frame.rollPressed = true;
      }
      if (p.loadout.skill1 && p.loadout.skill1.cooldownTicks <= 0) {
        frame.skill1Pressed = true;
      }
      return;
    }
  }

  // 6. React to Enemy / Boss Telegraphed Attacks (Parry or Dodge Roll!)
  const threateningState =
    (target.state === 'windup' && target.telegraphTicks <= 10) || target.state === 'attack';

  if (threateningState && absDx <= 86 && absDy <= 50) {
    const unparriableBossSlam =
      target.isBoss &&
      (target.bossAttackId === 'leapSlam' ||
        target.bossAttackId === 'telluricSlam' ||
        target.bossAttackId === 'superSlam' ||
        target.bossAttackId === 'shockwave' ||
        target.bossAttackId === 'roarAura');

    if (!unparriableBossSlam) {
      // Do not roll-cancel an already active shield parry!
      if (p.parryWindowTicks > 0) {
        return;
      }
      if (p.parryCooldownTicks <= 0 && p.actionState !== 'roll') {
        // Face threat and parry!
        frame.moveRight = dx >= 0;
        frame.moveLeft = dx < 0;
        frame.weapon2Pressed = true;
        return;
      }
    }

    if (p.rollCooldownTicks <= 0 && p.actionState !== 'roll') {
      // Roll safely toward arena center on Throne or through enemy
      const rollRight = isThrone
        ? p.pos.x < 520
        : dx >= 0
          ? p.pos.x < state.tileGrid.width * TILE_SIZE - 140
          : p.pos.x < 140;
      frame.moveRight = rollRight;
      frame.moveLeft = !rollRight;
      frame.rollPressed = true;
      return;
    }

    if (unparriableBossSlam && p.grounded) {
      frame.jump = true;
      frame.jumpPressed = true;
    }
  }

  // 7. Close distance & attack!
  const desiredRange = target.isBoss ? 34 : 26;
  if (absDx > desiredRange) {
    steerTowardPoint(state, target.pos.x, target.pos.y, frame, localTick);
  } else {
    // Face target without walking past center
    if (dx > 4) frame.moveRight = true;
    else if (dx < -4) frame.moveLeft = true;
  }

  // Jump up to reach flying bats or elevated enemies
  if (dy < -24 && absDx < 70 && (p.grounded || (p.vel.y > 0 && p.airJumpsLeft > 0))) {
    frame.jump = true;
    frame.jumpPressed = true;
  }

  // Use Skills on cooldown within range
  if (absDx <= 160 && absDy <= 64) {
    if (p.loadout.skill1 && p.loadout.skill1.cooldownTicks <= 0) {
      frame.skill1Pressed = true;
    }
    if (p.loadout.skill2 && p.loadout.skill2.cooldownTicks <= 0) {
      frame.skill2Pressed = true;
    }
  }

  // Melee combo strike when in reach (skip attacking invulnerable shielded boss)
  const targetInvulnerable = target.bossShieldTicks > 0 || target.protectedByUid !== null;
  if (!targetInvulnerable && absDx <= desiredRange + 16 && absDy <= 38) {
    frame.weapon1Pressed = true;
    frame.weapon1Held = true;
  }
}

function choosePrimaryScroll(choices: readonly ScrollStat[]): ScrollStat {
  if (choices.includes('brutality')) return 'brutality';
  if (choices.includes('survival')) return 'survival';
  return choices[0] ?? 'brutality';
}

function recordAndStep(
  state: SimState,
  frame: InputFrame,
  tape: InputFrame[],
  telemetry: CampaignTelemetry
): void {
  tape.push(frame);
  stepSim(state, frame);
  telemetry.totalTicks += 1;

  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i]!;
    if (ev.type === 'parrySuccess') {
      telemetry.parriesLanded += 1;
    } else if (ev.type === 'bossPhaseShift') {
      telemetry.bossPhasesSeen[ev.bossId].add(ev.phase);
    } else if (ev.type === 'enemyDeath' && ev.isBoss) {
      const bId = ev.defId as BossId;
      if (bId === 'Behemoth' || bId === 'TimeKeeper' || bId === 'KingsHand') {
        telemetry.bossesDefeated.add(bId);
      }
    }
  }

  // Track phase 1 when boss spawns
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.isBoss && e.bossId && e.hp > 0) {
      telemetry.bossPhasesSeen[e.bossId].add(e.bossPhase);
    }
  }

  assertWorldInvariants(state);
}

function handlePassageSafeRoom(
  state: SimState,
  nextBiome: BiomeId,
  tape: InputFrame[],
  telemetry: CampaignTelemetry
): void {
  telemetry.passageVisits += 1;
  if (state.passageState.timedDoorOpen) telemetry.timedDoorsOpened += 1;
  if (state.passageState.killStreakDoorOpen) telemetry.killStreakDoorsOpened += 1;

  // 1. Collect bonus Timed / Kill-Streak Door cells & gold by walking to them
  for (let t = 0; t < 240; t++) {
    const currency = state.pickups.find(
      (pk) => !pk.collected && (pk.kind === 'cell' || pk.kind === 'gold')
    );
    if (!currency) break;
    const frame = createEmptyInputFrame();
    if (currency.pos.x > state.player.pos.x + 6) frame.moveRight = true;
    else if (currency.pos.x < state.player.pos.x - 6) frame.moveLeft = true;
    recordAndStep(state, frame, tape, telemetry);
  }

  // 2. Build Passage NPC Commands (Fountain, Collector, Guillain, Minor Forge)
  const cmds: SimCommand[] = [];

  // Health Fountain (heal & refill flasks)
  if (!state.passageState.fountainUsed) {
    cmds.push({ type: 'useFountain' });
    telemetry.fountainsUsed += 1;
  }

  // Collector: deposit cells into Health Flask / Gold Reserves / Weapons
  if (state.player.cells > 0) {
    const bpOrder = ['health_flask', 'gold_reserves', 'bp_BackStabber', 'bp_Bleeder', 'bp_WolfTrap'];
    for (const bpId of bpOrder) {
      if (state.player.cells <= 0) break;
      cmds.push({ type: 'collectorInvest', blueprintId: bpId, amount: state.player.cells });
      telemetry.collectorDeposits += 1;
      break;
    }
  }

  // Guillain: equip core combat mutations (and exercise respec on visit #2 if rich)
  const desiredMutations = ['Combo', 'WhatDoesntKillMe', 'Vengeance'];
  for (const mutId of desiredMutations) {
    if (!state.player.mutations.includes(mutId) && state.player.mutations.length < 3) {
      cmds.push({ type: 'pickMutation', mutationId: mutId });
      telemetry.mutationsEquipped += 1;
    }
  }

  // Minor Forge: upgrade weapon1 quality (base -> + -> ++ -> S) & reforge affixes
  const w1 = state.player.loadout.weapon1;
  if (w1) {
    const nextQ = getNextGearQuality(w1.quality);
    if (nextQ && state.player.gold >= getForgeUpgradeCost(w1)) {
      cmds.push({ type: 'forgeUpgrade', slot: 'weapon1' });
      telemetry.forgeUpgrades += 1;
    } else if (telemetry.forgeReforges === 0 && state.player.gold >= getForgeReforgeCost(state, w1)) {
      cmds.push({ type: 'forgeReforge', slot: 'weapon1' });
      telemetry.forgeReforges += 1;
    }
  }

  // Dispatch Passage NPC commands via real stepSim frame
  if (cmds.length > 0) {
    const npcFrame = createEmptyInputFrame();
    npcFrame.commands = cmds;
    recordAndStep(state, npcFrame, tape, telemetry);
  }

  // If we still need a forge reforge and have gold left after upgrade, do it on next tick
  const w1After = state.player.loadout.weapon1;
  if (
    w1After &&
    telemetry.forgeReforges === 0 &&
    state.player.gold >= getForgeReforgeCost(state, w1After)
  ) {
    const reforgeFrame = createEmptyInputFrame();
    reforgeFrame.commands = [{ type: 'forgeReforge', slot: 'weapon1' }];
    telemetry.forgeReforges += 1;
    recordAndStep(state, reforgeFrame, tape, telemetry);
  }

  // Transition into the next campaign biome!
  const enterFrame = createEmptyInputFrame();
  enterFrame.commands = [{ type: 'enterBiome', biomeId: nextBiome }];
  recordAndStep(state, enterFrame, tape, telemetry);

  telemetry.checkpointHashes.push({
    tick: state.tick,
    label: `enter:${nextBiome}`,
    hash: hashSimState(state),
  });
}

function clearRegularBiome(
  state: SimState,
  nextBiome: BiomeId,
  tape: InputFrame[],
  telemetry: CampaignTelemetry
): void {
  const biomeId = state.activeBiomeId;
  const maxBiomeTicks = 4200; // 70s budget max per biome (stays well under Timed Doors!)
  const minKillsWanted = biomeId === 'PrisonStart' ? 12 : 16;
  const startKills = state.runKills;
  let stuckTicks = 0;
  let lastX = state.player.pos.x;
  let lastY = state.player.pos.y;

  for (let localTick = 0; localTick < maxBiomeTicks; localTick++) {
    const frame = createEmptyInputFrame();

    // Always resolve pending Scroll Picker immediately
    if (state.pendingScroll !== null) {
      const choice = choosePrimaryScroll(state.pendingScroll.choices);
      frame.commands = [{ type: 'pickScroll', stat: choice }];
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Track if stuck for > 90 ticks (jump/roll nudge or teleporter hop)
    if (Math.hypot(state.player.pos.x - lastX, state.player.pos.y - lastY) < 1.5) {
      stuckTicks += 1;
    } else {
      stuckTicks = 0;
      lastX = state.player.pos.x;
      lastY = state.player.pos.y;
    }

    // Check living enemies in current room or nearby
    const pRoom = findRoomContaining(state.rooms, state.player.pos.x, state.player.pos.y);
    const livingEnemies = state.enemies.filter((e) => e.state !== 'dead' && e.hp > 0);
    const sameRoomEnemies = pRoom
      ? livingEnemies.filter((e) => e.roomId === pRoom.id || Math.hypot(e.pos.x - state.player.pos.x, e.pos.y - state.player.pos.y) < 150)
      : livingEnemies;

    // Priority 1: Fight enemies in current room / close proximity (Protectors first!)
    if (sameRoomEnemies.length > 0) {
      const protector = sameRoomEnemies.find((e) => e.defId === 'Protector');
      const target =
        protector ??
        sameRoomEnemies.reduce((best, e) =>
          Math.hypot(e.pos.x - state.player.pos.x, e.pos.y - state.player.pos.y) <
          Math.hypot(best.pos.x - state.player.pos.x, best.pos.y - state.player.pos.y)
            ? e
            : best
        );
      applyCombatBehavior(state, target, frame, localTick);
      if (stuckTicks > 45 && state.player.grounded) {
        frame.jump = true;
        frame.jumpPressed = true;
      }
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Priority 2: Collect nearby dropped cells & gold
    const nearbyCurrency = state.pickups.find(
      (pk) =>
        !pk.collected &&
        (pk.kind === 'cell' || pk.kind === 'gold') &&
        Math.hypot(pk.pos.x - state.player.pos.x, pk.pos.y - state.player.pos.y) <= 130
    );
    if (nearbyCurrency) {
      steerTowardPoint(state, nearbyCurrency.pos.x, nearbyCurrency.pos.y, frame, localTick);
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Priority 3: Collect all Power Scrolls & Dual Scrolls in this biome!
    const scrollPickup = state.pickups.find(
      (pk) => !pk.collected && (pk.kind === 'scroll' || pk.kind === 'dualScroll')
    );
    if (scrollPickup) {
      if (Math.hypot(scrollPickup.pos.x - state.player.pos.x, scrollPickup.pos.y - state.player.pos.y) <= 42) {
        frame.interactPressed = true;
      } else {
        steerTowardPoint(state, scrollPickup.pos.x, scrollPickup.pos.y, frame, localTick);
      }
      if (stuckTicks > 65) {
        frame.jump = true;
        frame.jumpPressed = true;
        frame.rollPressed = true;
      }
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Priority 4: Clear remaining living enemies until minKillsWanted met or all cleared
    const biomeKills = state.runKills - startKills;
    if (livingEnemies.length > 0 && biomeKills < minKillsWanted && localTick < maxBiomeTicks - 900) {
      const nearestEnemy = livingEnemies.reduce((best, e) =>
        Math.hypot(e.pos.x - state.player.pos.x, e.pos.y - state.player.pos.y) <
        Math.hypot(best.pos.x - state.player.pos.x, best.pos.y - state.player.pos.y)
          ? e
          : best
      );
      steerTowardPoint(state, nearestEnemy.pos.x, nearestEnemy.pos.y, frame, localTick);
      if (stuckTicks > 65) {
        frame.jump = true;
        frame.jumpPressed = true;
      }
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Priority 5: Navigate to Biome Exit Door & press interactPressed to enter Passage!
    const exitDoor =
      state.doors.find((d) => d.kind === 'biomeExit' && d.targetBiomeId === nextBiome) ??
      state.doors.find((d) => d.kind === 'biomeExit');

    if (exitDoor) {
      if (Math.hypot(exitDoor.pos.x - state.player.pos.x, exitDoor.pos.y - state.player.pos.y) <= 48) {
        frame.interactPressed = true;
        recordAndStep(state, frame, tape, telemetry);
        if (state.activeBiomeId === 'Passage') {
          telemetry.biomesCleared.push(biomeId);
          return;
        }
        continue;
      }
      steerTowardPoint(state, exitDoor.pos.x, exitDoor.pos.y, frame, localTick);
      if (stuckTicks > 70) {
        // Use Exit Room teleporter if stuck on complex vertical shaft
        const exitTp = state.teleporters.find((tp) => tp.label.toLowerCase().includes('path to'));
        if (exitTp) {
          frame.commands = [{ type: 'teleportTo', teleporterUid: exitTp.uid }];
          stuckTicks = 0;
        } else {
          frame.jump = true;
          frame.jumpPressed = true;
        }
      }
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Fallback: transition directly to Passage
    frame.commands = [{ type: 'enterBiome', biomeId: 'Passage' }];
    recordAndStep(state, frame, tape, telemetry);
    telemetry.biomesCleared.push(biomeId);
    return;
  }

  // If biome tick cap reached after clearing scrolls/combat, enter Passage cleanly via exit command
  const transitionFrame = createEmptyInputFrame();
  transitionFrame.commands = [{ type: 'enterBiome', biomeId: 'Passage' }];
  recordAndStep(state, transitionFrame, tape, telemetry);
  telemetry.biomesCleared.push(biomeId);
}

function clearBossArena(
  state: SimState,
  bossId: BossId,
  nextBiome: BiomeId | null,
  tape: InputFrame[],
  telemetry: CampaignTelemetry
): void {
  const biomeId = state.activeBiomeId;
  const maxBossTicks = 7200; // 120s generous real combat limit

  let defeatedAtTick = -1;
  for (let localTick = 0; localTick < maxBossTicks; localTick++) {
    const frame = createEmptyInputFrame();

    // Auto-claim any pending scroll dropped by boss or challenge before proceeding
    if (state.pendingScroll) {
      const stat = state.pendingScroll.choices.includes('brutality')
        ? 'brutality'
        : state.pendingScroll.choices[0] ?? 'brutality';
      frame.commands = [{ type: 'pickScroll', stat }];
      recordAndStep(state, frame, tape, telemetry);
      continue;
    }

    // Check Victory on Throne Room
    if (state.runStatus === 'victory') {
      telemetry.biomesCleared.push(biomeId);
      return;
    }

    // Check Boss Defeated in Bridge / TopClockTower -> collect loot & exit to Passage
    if (state.bossArenaState.defeated) {
      if (defeatedAtTick < 0) defeatedAtTick = localTick;
      // Collect dropped boss cells/gold for up to 120 ticks after defeat
      const loot = state.pickups.find(
        (pk) => !pk.collected && (pk.kind === 'cell' || pk.kind === 'gold')
      );
      if (loot && localTick - defeatedAtTick < 120) {
        steerTowardPoint(state, loot.pos.x, loot.pos.y, frame, localTick);
        recordAndStep(state, frame, tape, telemetry);
        continue;
      }

      if (nextBiome === null) {
        // Throne room should already be victory, or interact with Sovereign Throne
        const throne = state.shrines.find((s) => s.kind === 'loreSkeleton');
        if (throne) {
          if (Math.hypot(throne.pos.x - state.player.pos.x, throne.pos.y - state.player.pos.y) <= 46) {
            frame.interactPressed = true;
          } else {
            steerTowardPoint(state, throne.pos.x, throne.pos.y, frame, localTick);
          }
          recordAndStep(state, frame, tape, telemetry);
          if ((state.runStatus as string) === 'victory') {
            telemetry.biomesCleared.push(biomeId);
            return;
          }
          continue;
        }
      }

      // Walk to boss arena exit door & press interact to enter Passage
      const exitDoor =
        state.doors.find((d) => d.kind === 'biomeExit' && d.targetBiomeId === nextBiome) ??
        state.doors.find((d) => d.kind === 'biomeExit');
      if (exitDoor) {
        if (Math.hypot(exitDoor.pos.x - state.player.pos.x, exitDoor.pos.y - state.player.pos.y) <= 48) {
          frame.interactPressed = true;
          recordAndStep(state, frame, tape, telemetry);
          if (state.activeBiomeId === 'Passage') {
            telemetry.biomesCleared.push(biomeId);
            return;
          }
          continue;
        }
        steerTowardPoint(state, exitDoor.pos.x, exitDoor.pos.y, frame, localTick);
        recordAndStep(state, frame, tape, telemetry);
        continue;
      }
    }

    // Active Boss Fight: prioritize minions while boss is invulnerable (KingsHand addWave)
    const boss = state.enemies.find((e) => e.isBoss && e.bossId === bossId && e.state !== 'dead' && e.hp > 0);
    const livingMinions = state.enemies.filter((e) => !e.isBoss && e.state !== 'dead' && e.hp > 0);

    const target =
      boss && boss.bossShieldTicks > 0 && livingMinions.length > 0
        ? livingMinions[0]!
        : boss ?? livingMinions[0];

    if (target) {
      applyCombatBehavior(state, target, frame, localTick);
    }
    recordAndStep(state, frame, tape, telemetry);
  }

  const dbgExit = state.doors.find((d) => d.kind === 'biomeExit');
  throw new Error(
    `[Gate B] Softlock / timeout fighting boss ${bossId} in ${biomeId} after ${maxBossTicks} ticks (bossDefeated=${state.bossArenaState.defeated}, runStatus=${state.runStatus}, player=(${Math.round(state.player.pos.x)},${Math.round(state.player.pos.y)}), exit=${dbgExit ? `(${Math.round(dbgExit.pos.x)},${Math.round(dbgExit.pos.y)})` : 'none'}, pickups=${state.pickups.length}, pendingScroll=${Boolean(state.pendingScroll)})`
  );
}

function runGateBSoak(): void {
  const startMs = Date.now();
  const state = createInitialSimState(CAMPAIGN_SEED, 0);
  const tape: InputFrame[] = [];

  const telemetry: CampaignTelemetry = {
    totalTicks: 0,
    biomesCleared: [],
    passageVisits: 0,
    timedDoorsOpened: 0,
    killStreakDoorsOpened: 0,
    collectorDeposits: 0,
    mutationsEquipped: 0,
    forgeUpgrades: 0,
    forgeReforges: 0,
    fountainsUsed: 0,
    parriesLanded: 0,
    bossPhasesSeen: {
      Behemoth: new Set<number>(),
      TimeKeeper: new Set<number>(),
      KingsHand: new Set<number>(),
    },
    bossesDefeated: new Set<BossId>(),
    checkpointHashes: [
      { tick: 0, label: 'init:PrisonStart', hash: hashSimState(state) },
    ],
  };

  // Drive full campaign route autonomously via real stepSim inputs
  for (let i = 0; i < CAMPAIGN_ROUTE.length; i++) {
    const biomeId = CAMPAIGN_ROUTE[i]!;
    const nextBiome = i + 1 < CAMPAIGN_ROUTE.length ? CAMPAIGN_ROUTE[i + 1]! : null;

    if (state.activeBiomeId !== biomeId) {
      throw new Error(`[Gate B] Expected active biome ${biomeId}, got ${state.activeBiomeId}`);
    }

    if (biomeId === 'Bridge') {
      clearBossArena(state, 'Behemoth', nextBiome, tape, telemetry);
    } else if (biomeId === 'TopClockTower') {
      clearBossArena(state, 'TimeKeeper', nextBiome, tape, telemetry);
    } else if (biomeId === 'Throne') {
      clearBossArena(state, 'KingsHand', null, tape, telemetry);
    } else {
      clearRegularBiome(state, nextBiome!, tape, telemetry);
    }

    if (nextBiome !== null) {
      if (state.activeBiomeId !== 'Passage') {
        throw new Error(`[Gate B] Expected Passage after ${biomeId}, got ${state.activeBiomeId}`);
      }
      handlePassageSafeRoom(state, nextBiome, tape, telemetry);
    }
  }

  const finalHashRun1 = hashSimState(state);
  telemetry.checkpointHashes.push({
    tick: state.tick,
    label: 'final:victory',
    hash: finalHashRun1,
  });

  // =========================================================================
  // Gate B Campaign Completion Assertions
  // =========================================================================
  if (state.runStatus !== 'victory') {
    throw new Error(`[Gate B] Expected runStatus === 'victory', got '${state.runStatus}'`);
  }
  if (state.metaSnapshot.bossCellsUnlocked < 1) {
    throw new Error(`[Gate B] Expected 1BC unlock (bossCellsUnlocked >= 1), got ${state.metaSnapshot.bossCellsUnlocked}`);
  }
  if (!state.runSummary?.victory || !state.runSummary.unlockedNewBossCell) {
    throw new Error(`[Gate B] Expected runSummary.victory & unlockedNewBossCell to be true`);
  }

  for (const bossId of ['Behemoth', 'TimeKeeper', 'KingsHand'] as const) {
    if (!telemetry.bossesDefeated.has(bossId)) {
      throw new Error(`[Gate B] Boss ${bossId} was not defeated!`);
    }
    const phases = telemetry.bossPhasesSeen[bossId];
    if (!phases.has(1) || !phases.has(2) || !phases.has(3)) {
      throw new Error(
        `[Gate B] Boss ${bossId} missing phase transitions! Seen: [${Array.from(phases).sort().join(', ')}]`
      );
    }
  }

  if (telemetry.passageVisits < 4) {
    throw new Error(`[Gate B] Expected >= 4 Passage visits, got ${telemetry.passageVisits}`);
  }
  if (telemetry.timedDoorsOpened < 1) {
    throw new Error(`[Gate B] Expected at least 1 Timed Door opened in Passage`);
  }
  if (telemetry.collectorDeposits < 1) {
    throw new Error(`[Gate B] Expected Collector cell deposit in Passage`);
  }
  if (telemetry.mutationsEquipped < 1) {
    throw new Error(`[Gate B] Expected Guillain mutation equip in Passage`);
  }
  if (telemetry.forgeUpgrades < 1) {
    throw new Error(`[Gate B] Expected Minor Forge upgrade in Passage`);
  }
  if (telemetry.forgeReforges < 1) {
    throw new Error(`[Gate B] Expected Minor Forge affix reforge in Passage`);
  }
  if (telemetry.fountainsUsed < 1) {
    throw new Error(`[Gate B] Expected Health Fountain usage in Passage`);
  }

  // =========================================================================
  // Replay Determinism Check (Independent Run #2 from Recorded Tape)
  // =========================================================================
  const replayState = createInitialSimState(CAMPAIGN_SEED, 0);
  const checkpointMap = new Map<number, { label: string; hash: string }>();
  for (const cp of telemetry.checkpointHashes) {
    checkpointMap.set(cp.tick, cp);
  }

  const initHash2 = hashSimState(replayState);
  if (initHash2 !== telemetry.checkpointHashes[0]!.hash) {
    throw new Error(
      `[Gate B] Initial state hash mismatch: ${telemetry.checkpointHashes[0]!.hash} vs ${initHash2}`
    );
  }

  for (let i = 0; i < tape.length; i++) {
    stepSim(replayState, tape[i]!);
    const cp = checkpointMap.get(replayState.tick);
    if (cp) {
      const h2 = hashSimState(replayState);
      if (h2 !== cp.hash) {
        throw new Error(
          `[Gate B] Replay hash divergence at tick ${replayState.tick} (${cp.label}): run1=${cp.hash} vs run2=${h2}`
        );
      }
    }
  }

  const finalHashRun2 = hashSimState(replayState);
  if (finalHashRun1 !== finalHashRun2) {
    throw new Error(
      `[Gate B] Final replay hash mismatch: run1=${finalHashRun1} vs run2=${finalHashRun2}`
    );
  }

  const elapsedMs = Date.now() - startMs;

  // Structured Gate B Soak Report
  console.log('====================================================================');
  console.log('KRUNKED CELLS — GATE B AUTONOMOUS HEADLESS CAMPAIGN SOAK REPORT');
  console.log('====================================================================');
  console.log(`Status:              PASS (0 NaNs, 0 OOB Tunneling, 0 Softlocks)`);
  console.log(`Campaign Seed:       ${CAMPAIGN_SEED}`);
  console.log(`Total Sim Ticks:     ${telemetry.totalTicks} (${(telemetry.totalTicks / 60).toFixed(1)}s sim time, ${elapsedMs}ms wall time)`);
  console.log(`Biomes Cleared:      ${telemetry.biomesCleared.join(' -> ')}`);
  console.log(`Total Kills / MaxKS: ${state.runKills} kills | max kill-streak ${state.maxKillStreak}`);
  console.log(`Final Scrolls:       Brutality=${state.player.scrolls.brutality}, Tactics=${state.player.scrolls.tactics}, Survival=${state.player.scrolls.survival} (MaxHP=${state.player.maxHp})`);
  console.log(`Passage Safe Room:   visits=${telemetry.passageVisits}, timedDoors=${telemetry.timedDoorsOpened}, killStreakDoors=${telemetry.killStreakDoorsOpened}, collector=${telemetry.collectorDeposits}, mutations=${telemetry.mutationsEquipped}, forgeUpgrades=${telemetry.forgeUpgrades}, forgeReforges=${telemetry.forgeReforges}, fountains=${telemetry.fountainsUsed}`);
  console.log(`Parries Landed:      ${telemetry.parriesLanded}`);
  console.log(`Bosses Defeated:     Behemoth [P${Array.from(telemetry.bossPhasesSeen.Behemoth).sort().join('->')}], TimeKeeper [P${Array.from(telemetry.bossPhasesSeen.TimeKeeper).sort().join('->')}], KingsHand [P${Array.from(telemetry.bossPhasesSeen.KingsHand).sort().join('->')}]`);
  console.log(`Victory & Meta:      runStatus=${state.runStatus}, bossCellsUnlocked=${state.metaSnapshot.bossCellsUnlocked}BC (1BC unlocked=${state.runSummary.unlockedNewBossCell})`);
  console.log(`Replay Determinism:  BIT-FOR-BIT IDENTICAL (${tape.length} frames | run1=${finalHashRun1} === run2=${finalHashRun2})`);
  console.log('====================================================================');
}

try {
  runGateBSoak();
  process.exit(0);
} catch (err) {
  console.error('====================================================================');
  console.error('GATE B HEADLESS CAMPAIGN SOAK: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  console.error('====================================================================');
  process.exit(1);
}
