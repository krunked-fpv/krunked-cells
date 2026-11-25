// =============================================================================
// KRUNKED CELLS — Acrobatic 60 Hz Player Physics & Traversal Controller
// Ground Run (3-tick accel / 2-tick stop), Variable Jump, Double Jump, Coyote
// Time (7 ticks), Jump Buffer (7 ticks), Auto-Mantle (20px tolerance), One-Way
// Drop-Through, Chains/Ladders, Spider Wall-Run & Wall-Jump (6t away-lock),
// Dodge Roll (24t / 21 iframes / 18t post-roll cooldown + flat air-roll glide
// + Door Smash + Armadillopack), High-Fall Dizzy Stun (132px, roll-cancellable),
// 2-Tier Ram Rune Dive-Slam (10t cancellable impact), Hazards & Secret Walls.
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// =============================================================================

import {
  FIXED_DT,
  TILE_SIZE,
  TileKind,
  type CollisionAPI,
  type InputFrame,
  type PlayerState,
  type RngAPI,
  type SimState,
} from '../contracts';
import { WEAPON_MAP } from '../data';
import { attemptShieldParry, damageEnemy, damagePlayer } from './combat';
import { getScrollDamageMultiplier, hasMutation } from './roguelite';
import { applyStatus } from './status';

const RUN_BASE_SPEED = 155;
const RUN_MAX_SPEED = 175;
const JUMP_VY = -335;
const DOUBLE_JUMP_VY = -305;
const GRAVITY_RISE = 980;
const GRAVITY_FALL = 1323; // 1.35x rising gravity
const MAX_FALL_SPEED = 540;
const COYOTE_TICKS = 7;
const JUMP_BUFFER_TICKS = 7;
const WALL_RUN_VY = -135;
const WALL_RUN_MAX_TICKS = 16;
const WALL_SLIDE_MAX_VY = 70;
const WALL_JUMP_VX = 195;
const WALL_JUMP_VY = -315;
const WALL_JUMP_LOCK_TICKS = 6;
const ROLL_DURATION_TICKS = 24;
const ROLL_IFRAME_TICKS = 21;
const ROLL_SPEED = 265;
const ROLL_COOLDOWN_TICKS = 42; // 24t roll + 18t crisp post-roll cadence
const AFTER_ROLL_CRIT_START_TICKS = ROLL_DURATION_TICKS + 45; // 69t
const AFTER_ROLL_CRIT_END_TICKS = 60;
const FALL_STUN_HEIGHT_PX = 132; // 5.5 tiles
const FALL_STUN_TICKS = 36;
const FALL_ROLL_BUFFER_TICKS = 4;
const DIVE_SLAM_VY = 540;
const DIVE_HEAVY_RAM_HEIGHT_PX = 72; // 3 tiles -> Tier 2 Ram Crater
const DIVE_T1_POWER = 35;
const DIVE_T1_RADIUS = 40;
const DIVE_T1_STUN_TICKS = 30;
const DIVE_T2_POWER = 90;
const DIVE_T2_RADIUS = 68;
const DIVE_T2_STUN_TICKS = 55;
const DIVE_IMPACT_RECOVERY_TICKS = 10;
const DIVE_TOUCHDOWN_GRACE_IFRAMES = 4;
const CLIMB_UP_VY = -145;
const CLIMB_DOWN_VY = 155;
const MANTLE_TOLERANCE_PX = 18; // Effective 20px tolerance (MANTLE_TOLERANCE_PX + 2)

interface PlayerPhysicsRuntime {
  rollBufferTicks: number;
}

const physicsRuntimeMap = new WeakMap<PlayerState, PlayerPhysicsRuntime>();

function getPhysicsRuntime(player: PlayerState): PlayerPhysicsRuntime {
  let rt = physicsRuntimeMap.get(player);
  if (!rt) {
    rt = { rollBufferTicks: 0 };
    physicsRuntimeMap.set(player, rt);
  }
  return rt;
}

function emitParticle(
  state: SimState,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: number,
  color: string,
  ttlTicks: number,
  kind: SimState['particlesSim'][number]['kind'],
  emissive = false,
  gravity = 220
): void {
  if (state.particlesSim.length >= 260) {
    state.particlesSim.shift();
  }
  state.particlesSim.push({
    uid: state.nextUid++,
    pos: { x, y },
    vel: { x: vx, y: vy },
    size,
    color,
    alpha: 1,
    ttlTicks,
    maxTtlTicks: ttlTicks,
    gravity,
    emissive,
    kind,
  });
}

function startDodgeRoll(
  state: SimState,
  moveDir: number,
  rng: RngAPI
): void {
  const player = state.player;
  if (moveDir !== 0) {
    player.facing = moveDir > 0 ? 1 : -1;
  }
  player.actionState = 'roll';
  player.rollTicks = ROLL_DURATION_TICKS;
  player.iframeTicks = Math.max(player.iframeTicks, ROLL_IFRAME_TICKS);
  player.rollCooldownTicks = ROLL_COOLDOWN_TICKS;
  player.afterRollCritTicks = Math.max(player.afterRollCritTicks, AFTER_ROLL_CRIT_START_TICKS);
  player.diveSlamState = 'none';
  player.actionTicks = 0;
  player.attackPhase = 'none';
  player.attackPhaseTicks = 0;
  player.attackHitIds = [];
  player.parryWindowTicks = 0;
  player.shieldBlocking = false;
  player.healTicks = 0;
  player.queuedInput = 'none';
  player.queuedInputTicks = 0;
  player.fallStartY = player.pos.y;
  player.vel.x = player.facing * ROLL_SPEED;
  if (player.vel.y > 20) player.vel.y = 20;

  state.events.push({
    type: 'dodgeRoll',
    x: player.pos.x,
    y: player.pos.y,
    facing: player.facing,
  });
  for (let i = 0; i < 4; i++) {
    emitParticle(
      state,
      player.pos.x - player.facing * 4,
      player.pos.y + player.height * 0.4,
      -player.facing * rng.rangeFloat(35, 95),
      rng.rangeFloat(-45, -10),
      3,
      '#c4c0d8',
      14,
      'dust',
      false,
      120
    );
  }
}

function smashWoodenDoor(
  state: SimState,
  doorIdx: number,
  rng: RngAPI
): void {
  const door = state.doors[doorIdx]!;
  door.broken = true;
  door.opened = true;
  state.screenShake = Math.max(state.screenShake, 3.8);
  state.events.push({ type: 'doorSmash', x: door.pos.x, y: door.pos.y });

  const smashDir = state.player.facing;
  for (let p = 0; p < 10; p++) {
    emitParticle(
      state,
      door.pos.x,
      door.pos.y + rng.rangeFloat(-16, 16),
      smashDir * rng.rangeFloat(95, 230),
      rng.rangeFloat(-145, -18),
      rng.rangeFloat(3, 4.5),
      p % 2 === 0 ? '#b87a42' : '#8a5226',
      26,
      'dust',
      false,
      440
    );
  }

  // Stun enemies in front of the smashed door for 90 ticks with crisp knockback!
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state === 'dead' || e.hp <= 0 || e.isBoss) continue;
    const dx = e.pos.x - door.pos.x;
    const dy = e.pos.y - door.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dx * smashDir >= -16 && dist <= 84) {
      e.stunTicks = Math.max(e.stunTicks, 90);
      e.state = 'stunned';
      e.stateTicks = Math.max(e.stateTicks, 90);
      e.telegraphTicks = 0;
      e.vel.x = smashDir * 140;
      e.vel.y = Math.min(e.vel.y, -75);
      applyStatus(e.statusEffects, 'stun', 90, 0, 0);
    }
  }
}

function breakSecretWallIfPresent(
  state: SimState,
  col: CollisionAPI,
  tx: number,
  ty: number,
  rng: RngAPI
): boolean {
  if (col.getTile(state.tileGrid, tx, ty) !== TileKind.SECRET_WALL) {
    return false;
  }
  col.setTile(state.tileGrid, tx, ty, TileKind.EMPTY);
  const wx = (tx + 0.5) * TILE_SIZE;
  const wy = (ty + 0.5) * TILE_SIZE;
  state.screenShake = Math.max(state.screenShake, 3);
  for (let i = 0; i < 6; i++) {
    emitParticle(
      state,
      wx,
      wy,
      rng.rangeFloat(-95, 95),
      rng.rangeFloat(-120, -20),
      3.5,
      '#c7b59a',
      24,
      'dust',
      false,
      360
    );
  }
  // Secret walls hide delicious Wall Food or Gold!
  if (rng.chance(0.75)) {
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'food',
      pos: { x: wx, y: wy - 4 },
      prevPos: { x: wx, y: wy - 4 },
      vel: { x: rng.rangeFloat(-35, 35), y: -115 },
      value: 50,
      label: 'Wall Roast (+50% HP)',
      magnetTicks: 0,
      collected: false,
      bobPhase: 0,
    });
  } else {
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gold',
      pos: { x: wx, y: wy - 4 },
      prevPos: { x: wx, y: wy - 4 },
      vel: { x: rng.rangeFloat(-45, 45), y: -120 },
      value: 180,
      magnetTicks: 10,
      collected: false,
      bobPhase: 0,
    });
  }
  return true;
}

function isParryRequested(player: PlayerState, input: InputFrame): boolean {
  const w1Def = player.loadout.weapon1 ? WEAPON_MAP[player.loadout.weapon1.defId] : null;
  const w2Def = player.loadout.weapon2 ? WEAPON_MAP[player.loadout.weapon2.defId] : null;
  if (player.parryCooldownTicks > 0) return false;
  if (input.weapon1Pressed && w1Def?.kind === 'shield') return true;
  if (input.weapon2Pressed && w2Def?.kind === 'shield') return true;
  if (player.queuedInput === 'parry' && (w1Def?.kind === 'shield' || w2Def?.kind === 'shield')) {
    return true;
  }
  return false;
}

function triggerDiveSlamImpact(
  state: SimState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  const fallHeight = Math.max(24, player.pos.y - player.diveStartY);
  const isHeavyRam = fallHeight >= DIVE_HEAVY_RAM_HEIGHT_PX;
  const basePower = isHeavyRam ? DIVE_T2_POWER : DIVE_T1_POWER;
  const radius = isHeavyRam ? DIVE_T2_RADIUS : DIVE_T1_RADIUS;
  const stunTicks = isHeavyRam ? DIVE_T2_STUN_TICKS : DIVE_T1_STUN_TICKS;
  const scrollMult = getScrollDamageMultiplier(player.scrolls, 'colorless');
  const rawPower = Math.round(basePower * scrollMult);
  const impactY = player.pos.y + player.height * 0.5;

  // Enter 10-tick roll/parry-cancellable impact recovery stance + 4t touchdown grace!
  player.diveSlamState = 'impact';
  player.actionState = 'diveSlam';
  player.actionTicks = DIVE_IMPACT_RECOVERY_TICKS;
  player.vel.x = 0;
  player.iframeTicks = Math.max(player.iframeTicks, DIVE_TOUCHDOWN_GRACE_IFRAMES);
  player.fallStartY = player.pos.y;
  state.screenShake = Math.max(state.screenShake, isHeavyRam ? 8 : 5);

  state.events.push({
    type: 'diveSlamImpact',
    x: player.pos.x,
    y: impactY,
    radius,
    power: rawPower,
  });

  // Tier 2 fiery orange Ram Crater vs Tier 1 golden dust shockwave
  const ringColor = isHeavyRam ? '#ff6a24' : '#ffcf66';
  emitParticle(state, player.pos.x, impactY - 4, 0, 0, radius, ringColor, isHeavyRam ? 20 : 14, 'ring', true, 0);
  const debrisCount = isHeavyRam ? 12 : 7;
  for (let i = 0; i < debrisCount; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    emitParticle(
      state,
      player.pos.x + dir * rng.rangeFloat(4, isHeavyRam ? 26 : 16),
      impactY - 2,
      dir * rng.rangeFloat(65, isHeavyRam ? 210 : 145),
      rng.rangeFloat(isHeavyRam ? -165 : -115, -30),
      isHeavyRam ? 3.5 : 2.8,
      isHeavyRam && i % 2 === 0 ? '#ff7b29' : '#d8d0e8',
      isHeavyRam ? 22 : 16,
      isHeavyRam && i % 2 === 0 ? 'ember' : 'dust',
      isHeavyRam && i % 2 === 0,
      360
    );
  }

  // Stun & damage enemies in shockwave radius
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state === 'dead' || e.hp <= 0) continue;
    const dx = e.pos.x - player.pos.x;
    const dy = e.pos.y - player.pos.y;
    if (Math.hypot(dx, dy) <= radius) {
      if (!e.isBoss) {
        e.stunTicks = Math.max(e.stunTicks, stunTicks);
        e.state = 'stunned';
        e.stateTicks = Math.max(e.stateTicks, stunTicks);
        e.telegraphTicks = 0;
        applyStatus(e.statusEffects, 'stun', stunTicks, 0, 0);
      }
      const pushDir = dx >= 0 ? 1 : -1;
      damageEnemy(
        state,
        e,
        rawPower,
        false,
        isHeavyRam ? 75 : 45,
        pushDir * (isHeavyRam ? 175 : 130),
        isHeavyRam ? -115 : -85,
        rng,
        'diveSlam',
        undefined,
        col
      );
    }
  }

  // Smash unbroken wooden doors in shockwave radius (even if already opened!)
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.kind === 'wood' && !door.broken) {
      if (Math.hypot(door.pos.x - player.pos.x, door.pos.y - player.pos.y) <= radius) {
        smashWoodenDoor(state, i, rng);
      }
    }
  }
}

export function stepPlayerPhysics(
  state: SimState,
  input: InputFrame,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  if (player.actionState === 'dead') {
    return;
  }

  const grid = state.tileGrid;
  const wasGrounded = player.grounded;
  const prevVy = player.vel.y;
  const rt = getPhysicsRuntime(player);

  if (player.fallStartY === undefined) {
    player.fallStartY = player.pos.y;
  }

  // 1. Tick movement & invulnerability timers
  if (player.iframeTicks > 0) player.iframeTicks -= 1;
  if (player.rollCooldownTicks > 0) player.rollCooldownTicks -= 1;
  if (player.coyoteTicks > 0) player.coyoteTicks -= 1;
  if (player.jumpBufferTicks > 0) player.jumpBufferTicks -= 1;
  if ((player.wallJumpLockTicks ?? 0) > 0) {
    player.wallJumpLockTicks = (player.wallJumpLockTicks ?? 0) - 1;
  }
  if (rt.rollBufferTicks > 0) rt.rollBufferTicks -= 1;
  if (input.rollPressed) {
    rt.rollBufferTicks = FALL_ROLL_BUFFER_TICKS;
  }
  if (player.actionState === 'mantle' && player.actionTicks > 0) {
    player.actionTicks -= 1;
  }

  // 1b. High-Fall Dizzy Stun lockout (blocks run / jump / roll / attack cleanly)
  if ((player.fallStunTicks ?? 0) > 0) {
    player.fallStunTicks = (player.fallStunTicks ?? 0) - 1;
    player.vel.x = 0;
    player.vel.y = Math.min(MAX_FALL_SPEED, player.vel.y + GRAVITY_FALL * FIXED_DT);
    player.jumpBufferTicks = 0;
    player.queuedInput = 'none';
    player.queuedInputTicks = 0;
    player.attackPhase = 'none';
    player.attackPhaseTicks = 0;
    player.diveSlamState = 'none';

    const stunRes = col.sweepAabb(
      grid,
      player.pos.x - player.width * 0.5,
      player.pos.y - player.height * 0.5,
      player.width,
      player.height,
      player.vel.x,
      player.vel.y,
      FIXED_DT,
      false,
      false
    );
    player.pos.x = stunRes.x + player.width * 0.5;
    player.pos.y = stunRes.y + player.height * 0.5;
    player.vel.x = stunRes.vx;
    player.vel.y = stunRes.vy;
    player.grounded = stunRes.hitFloor;
    player.onOneWay = stunRes.onOneWay;
    player.fallStartY = player.pos.y;
    player.actionState = (player.fallStunTicks ?? 0) > 0 ? 'hurt' : player.grounded ? 'idle' : 'fall';
    return;
  }

  if (input.jumpPressed) {
    player.jumpBufferTicks = JUMP_BUFFER_TICKS;
  }

  const moveDir = (input.moveRight ? 1 : 0) - (input.moveLeft ? 1 : 0);
  if (
    moveDir !== 0 &&
    player.actionState !== 'roll' &&
    player.diveSlamState === 'none' &&
    (player.wallJumpLockTicks ?? 0) <= 0
  ) {
    // Allow facing change unless locked mid-active swing
    if (player.attackPhase !== 'active') {
      player.facing = moveDir > 0 ? 1 : -1;
    }
  }

  const speedMult = player.speedBuffTicks > 0 ? 1.25 : 1.0;

  // 2. Dodge Roll initiation (SINGLE source of truth: 24t duration, 21 iframes, 42t cooldown = 18t post-roll!)
  if (
    (input.rollPressed || player.queuedInput === 'roll') &&
    player.rollCooldownTicks <= 0 &&
    player.actionState !== 'roll'
  ) {
    startDodgeRoll(state, moveDir, rng);
  }

  let dropThroughOneWay = false;
  let breakCrackedFloor = false;
  let climbing = false;

  // 2b. Dive-Slam Impact Stance (10t recovery, immediately roll/parry cancellable!)
  if (player.diveSlamState === 'impact') {
    if (isParryRequested(player, input) || player.parryWindowTicks > 0) {
      player.diveSlamState = 'none';
      player.actionTicks = 0;
      if (player.actionState === 'diveSlam') {
        player.actionState = player.grounded ? 'idle' : 'fall';
      }
    } else {
      player.actionTicks = Math.max(0, player.actionTicks - 1);
      if (player.actionTicks <= 0) {
        player.diveSlamState = 'none';
        if (player.actionState === 'diveSlam') {
          player.actionState = player.grounded ? 'idle' : 'fall';
        }
      }
    }
  }

  // 3. Active Dodge Roll locomotion, flat air-roll glide, door-smash & Armadillopack parry-roll
  if (player.actionState === 'roll') {
    player.rollTicks -= 1;
    player.vel.x = player.facing * ROLL_SPEED;
    if (player.rollTicks > 6) {
      // Crisp Dead Cells flat air-roll glide across gaps & projectiles
      player.vel.y = Math.min(20, player.vel.y + GRAVITY_RISE * 0.12 * FIXED_DT);
    } else {
      player.vel.y = Math.min(MAX_FALL_SPEED, player.vel.y + GRAVITY_FALL * FIXED_DT);
    }
    player.fallStartY = player.pos.y;

    // Smash unbroken wooden doors encountered during roll (even if already opened!)
    for (let i = 0; i < state.doors.length; i++) {
      const door = state.doors[i]!;
      if (door.kind !== 'wood' || door.broken) continue;
      if (
        Math.abs(door.pos.x - (player.pos.x + player.facing * 8)) <= door.width * 0.5 + player.width * 0.5 + 8 &&
        Math.abs(door.pos.y - player.pos.y) <= door.height * 0.5 + player.height * 0.5
      ) {
        smashWoodenDoor(state, i, rng);
      }
    }

    // Break secret walls when rolling directly into them
    const frontTx = Math.floor((player.pos.x + player.facing * (player.width * 0.5 + 4)) / TILE_SIZE);
    const midTy = Math.floor(player.pos.y / TILE_SIZE);
    breakSecretWallIfPresent(state, col, frontTx, midTy, rng);

    // Armadillopack mutation: rolling parries nearby parriable projectiles!
    if (hasMutation(state, 'Armadillopack')) {
      for (let i = 0; i < state.projectiles.length; i++) {
        const pr = state.projectiles[i]!;
        if (pr.owner !== 'enemy' || !pr.parriable) continue;
        if (Math.hypot(pr.pos.x - player.pos.x, pr.pos.y - player.pos.y) <= 26) {
          attemptShieldParry(state, pr.damage, null, pr, rng);
        }
      }
    }

    if (player.rollTicks <= 0) {
      player.actionState = player.grounded ? 'idle' : 'fall';
      player.vel.x *= 0.45;
      player.afterRollCritTicks = Math.max(player.afterRollCritTicks, AFTER_ROLL_CRIT_END_TICKS);
    }
  } else if (player.diveSlamState === 'impact') {
    // Brief impact recovery crouch (cancellable by Roll or Parry on any frame!)
    player.vel.x *= 0.65;
    if (Math.abs(player.vel.x) < 4) player.vel.x = 0;
    player.vel.y = Math.min(MAX_FALL_SPEED, player.vel.y + GRAVITY_FALL * FIXED_DT);
    player.fallStartY = player.pos.y;
  } else {
    // 4. One-Way Drop-Through vs Airborne Downward Dive-Slam
    if (player.grounded && player.onOneWay && input.moveDown && input.jumpPressed) {
      dropThroughOneWay = true;
      player.pos.y += 3;
      player.vel.y = 95;
      player.grounded = false;
      player.onOneWay = false;
      player.coyoteTicks = 0;
      player.jumpBufferTicks = 0;
      player.fallStartY = player.pos.y;
    } else if (
      !player.grounded &&
      input.moveDown &&
      input.jumpPressed &&
      player.diveSlamState === 'none'
    ) {
      player.diveSlamState = 'falling';
      player.diveStartY = player.pos.y;
      player.fallStartY = player.pos.y;
      player.actionState = 'diveSlam';
      player.vel.x *= 0.2;
      player.vel.y = DIVE_SLAM_VY;
      player.jumpBufferTicks = 0;
      player.coyoteTicks = 0;
      player.onWallDir = 0;
    }

    if (player.diveSlamState === 'falling') {
      player.vel.y = DIVE_SLAM_VY;
      player.vel.x *= 0.85;
      player.fallStartY = player.pos.y;
      // Gate CRACKED_FLOOR shattering strictly on Ram Rune unlock!
      breakCrackedFloor = state.metaSnapshot.runesUnlocked.ram;
      dropThroughOneWay = input.moveDown;
    } else {
      // 5. Ladder & Chain Climbing
      const centerTx = Math.floor(player.pos.x / TILE_SIZE);
      const centerTy = Math.floor(player.pos.y / TILE_SIZE);
      const feetTy = Math.floor((player.pos.y + player.height * 0.45) / TILE_SIZE);
      const onClimbable =
        col.isClimbableAt(grid, centerTx, centerTy) ||
        col.isClimbableAt(grid, centerTx, feetTy);

      if (onClimbable && (input.moveUp || input.moveDown)) {
        climbing = true;
        player.grounded = false;
        player.onOneWay = false;
        player.airJumpsLeft = player.maxAirJumps;
        player.wallRunTicksLeft = WALL_RUN_MAX_TICKS;
        player.onWallDir = 0;
        player.fallStartY = player.pos.y;
        player.vel.y = input.moveUp ? CLIMB_UP_VY : CLIMB_DOWN_VY;
        if (input.moveDown) {
          dropThroughOneWay = true;
        }
        if (moveDir === 0) {
          const climbCenterX = (centerTx + 0.5) * TILE_SIZE;
          player.vel.x = (climbCenterX - player.pos.x) * 8;
        } else {
          player.vel.x = moveDir * 115 * speedMult;
        }

        if (player.jumpBufferTicks > 0) {
          climbing = false;
          player.vel.y = JUMP_VY * 0.94;
          player.jumpBufferTicks = 0;
          player.fallStartY = player.pos.y;
          player.actionState = 'jump';
          state.events.push({
            type: 'jump',
            x: player.pos.x,
            y: player.pos.y + player.height * 0.5,
            isAirJump: false,
          });
        }
      }

      if (!climbing) {
        // 6. Horizontal Run Acceleration (3 ticks to 175 px/s, 2-tick crisp stop)
        const maxSpeed = RUN_MAX_SPEED * speedMult;
        const baseSpeed = RUN_BASE_SPEED * speedMult;

        if (player.grounded) {
          if (moveDir !== 0) {
            const desiredSign = moveDir;
            if (Math.sign(player.vel.x) !== desiredSign || Math.abs(player.vel.x) < baseSpeed) {
              // Instant crisp start at baseSpeed, then 3 ticks up to maxSpeed
              player.vel.x = desiredSign * baseSpeed;
            } else {
              const stepAccel = (maxSpeed - baseSpeed) / 2;
              const nextMag = Math.min(maxSpeed, Math.abs(player.vel.x) + stepAccel);
              player.vel.x = desiredSign * nextMag;
            }
          } else {
            // 2-tick crisp deceleration to exact 0 (zero ice-skating)
            const stopStep = maxSpeed * 0.5;
            if (Math.abs(player.vel.x) <= stopStep) {
              player.vel.x = 0;
            } else {
              player.vel.x -= Math.sign(player.vel.x) * stopStep;
            }
          }
        } else if ((player.wallJumpLockTicks ?? 0) <= 0) {
          // Responsive air control (suspended briefly during 6t wall-jump away-lock)
          if (moveDir !== 0) {
            const airAccel = maxSpeed * 0.28;
            const targetVx = moveDir * maxSpeed;
            if (moveDir > 0) {
              player.vel.x = Math.min(targetVx, player.vel.x + airAccel);
            } else {
              player.vel.x = Math.max(targetVx, player.vel.x - airAccel);
            }
          } else {
            player.vel.x *= 0.92;
            if (Math.abs(player.vel.x) < 4) player.vel.x = 0;
          }
        }

        // 7. Spider Wall-Run & Wall-Slide Detection (2 vertical torso probes: pos.y - 8 & pos.y + 6)
        let wallDir: -1 | 0 | 1 = 0;
        if (!player.grounded && (player.wallJumpLockTicks ?? 0) <= 0) {
          const leftTx = Math.floor((player.pos.x - player.width * 0.5 - 2) / TILE_SIZE);
          const rightTx = Math.floor((player.pos.x + player.width * 0.5 + 2) / TILE_SIZE);
          const upperTy = Math.floor((player.pos.y - 8) / TILE_SIZE);
          const lowerTy = Math.floor((player.pos.y + 6) / TILE_SIZE);
          const touchLeft = col.isSolidAt(grid, leftTx, upperTy) || col.isSolidAt(grid, leftTx, lowerTy);
          const touchRight = col.isSolidAt(grid, rightTx, upperTy) || col.isSolidAt(grid, rightTx, lowerTy);

          if (touchLeft && (input.moveLeft || (player.onWallDir === -1 && !input.moveRight))) {
            wallDir = -1;
          } else if (touchRight && (input.moveRight || (player.onWallDir === 1 && !input.moveLeft))) {
            wallDir = 1;
          }
        }
        player.onWallDir = wallDir;

        // 8. Jump, Wall-Jump & Double Jump Resolution
        if (player.jumpBufferTicks > 0 && !dropThroughOneWay) {
          if (player.grounded || player.coyoteTicks > 0) {
            // Ground / Coyote jump
            player.vel.y = JUMP_VY;
            player.grounded = false;
            player.onOneWay = false;
            player.coyoteTicks = 0;
            player.jumpBufferTicks = 0;
            player.fallStartY = player.pos.y;
            if (player.attackPhase === 'none') player.actionState = 'jump';
            state.events.push({
              type: 'jump',
              x: player.pos.x,
              y: player.pos.y + player.height * 0.5,
              isAirJump: false,
            });
            for (let i = 0; i < 4; i++) {
              emitParticle(
                state,
                player.pos.x + rng.rangeFloat(-6, 6),
                player.pos.y + player.height * 0.5,
                rng.rangeFloat(-50, 50),
                rng.rangeFloat(-30, -5),
                2.5,
                '#d0cce0',
                14,
                'dust',
                false,
                80
              );
            }
          } else if (wallDir !== 0) {
            // Spider Wall-Jump with 6-tick horizontal away-lock!
            player.vel.x = -wallDir * WALL_JUMP_VX;
            player.vel.y = WALL_JUMP_VY;
            player.facing = wallDir === 1 ? -1 : 1;
            player.airJumpsLeft = player.maxAirJumps;
            player.wallRunTicksLeft = WALL_RUN_MAX_TICKS;
            player.wallJumpLockTicks = WALL_JUMP_LOCK_TICKS;
            player.wallSlideTicks = 0;
            player.onWallDir = 0;
            player.jumpBufferTicks = 0;
            player.fallStartY = player.pos.y;
            if (player.attackPhase === 'none') player.actionState = 'jump';
            state.events.push({
              type: 'jump',
              x: player.pos.x + wallDir * (player.width * 0.5),
              y: player.pos.y,
              isAirJump: false,
            });
            for (let i = 0; i < 5; i++) {
              emitParticle(
                state,
                player.pos.x + wallDir * (player.width * 0.5),
                player.pos.y + rng.rangeFloat(-6, 6),
                -wallDir * rng.rangeFloat(45, 110),
                rng.rangeFloat(-70, 20),
                3,
                '#d4d0e6',
                16,
                'dust',
                false,
                140
              );
            }
          } else if (player.airJumpsLeft > 0) {
            // Double Jump
            player.vel.y = DOUBLE_JUMP_VY;
            player.airJumpsLeft -= 1;
            player.jumpBufferTicks = 0;
            player.fallStartY = player.pos.y;
            if (player.attackPhase === 'none') player.actionState = 'jump';
            state.events.push({
              type: 'jump',
              x: player.pos.x,
              y: player.pos.y + player.height * 0.5,
              isAirJump: true,
            });
            for (let i = 0; i < 6; i++) {
              emitParticle(
                state,
                player.pos.x + rng.rangeFloat(-8, 8),
                player.pos.y + player.height * 0.5,
                rng.rangeFloat(-75, 75),
                rng.rangeFloat(-15, 25),
                3,
                '#9beeff',
                15,
                'dust',
                true,
                40
              );
            }
          }
        }

        // Variable jump height cut on early jump release (0.48x once)
        if (!input.jump && player.vel.y < -165) {
          player.vel.y *= 0.48;
        }

        // Spider Wall-Run climb or Wall-Slide friction
        const pushingIntoWall =
          (player.onWallDir === -1 && input.moveLeft) ||
          (player.onWallDir === 1 && input.moveRight);

        if (pushingIntoWall && !player.grounded) {
          player.fallStartY = player.pos.y;
          if (player.wallRunTicksLeft > 0 && state.metaSnapshot.runesUnlocked.spider) {
            player.vel.y = WALL_RUN_VY;
            player.wallRunTicksLeft -= 1;
            player.wallSlideTicks = 0;
          } else {
            const grav = player.vel.y < 0 ? GRAVITY_RISE : GRAVITY_FALL;
            player.vel.y = Math.min(WALL_SLIDE_MAX_VY, player.vel.y + grav * FIXED_DT);
            player.wallSlideTicks += 1;
          }
        } else {
          // Asymmetric rising vs falling gravity (1.35x heavier falling)
          const grav = player.vel.y < 0 ? GRAVITY_RISE : GRAVITY_FALL;
          player.vel.y = Math.min(MAX_FALL_SPEED, player.vel.y + grav * FIXED_DT);
        }
      }
    }
  }

  // Track highest point of uninterrupted airborne descent for High-Fall Dizzy Stun
  if (
    !player.grounded &&
    player.vel.y > 0 &&
    player.diveSlamState === 'none' &&
    player.actionState !== 'roll' &&
    !climbing &&
    player.onWallDir === 0
  ) {
    player.fallStartY = Math.min(player.fallStartY ?? player.pos.y, player.pos.y);
  } else if (player.grounded || player.vel.y <= 0) {
    player.fallStartY = player.pos.y;
  }

  // 9. Swept AABB Collision Pass
  const res = col.sweepAabb(
    grid,
    player.pos.x - player.width * 0.5,
    player.pos.y - player.height * 0.5,
    player.width,
    player.height,
    player.vel.x,
    player.vel.y,
    FIXED_DT,
    dropThroughOneWay,
    breakCrackedFloor
  );

  // 10. Generous Auto-Mantle / Ledge Climb (18-20px tolerance, works near jump apex vel.y >= -90!)
  if (
    !res.hitFloor &&
    player.diveSlamState === 'none' &&
    player.actionState !== 'roll' &&
    player.vel.y >= -90 &&
    (input.moveRight || input.moveLeft)
  ) {
    const dir = res.hitRight
      ? 1
      : res.hitLeft
        ? -1
        : input.moveRight && !input.moveLeft
          ? 1
          : input.moveLeft && !input.moveRight
            ? -1
            : 0;
    if (dir !== 0) {
      const wallTx =
        dir > 0
          ? Math.floor((res.x + player.width + 2) / TILE_SIZE)
          : Math.floor((res.x - 2) / TILE_SIZE);
      const feetY = res.y + player.height;
      const ledgeTy = Math.floor((feetY - 1) / TILE_SIZE);
      const ledgeTopY = ledgeTy * TILE_SIZE;
      const verticalGap = feetY - ledgeTopY;

      if (
        verticalGap >= 0 &&
        verticalGap <= MANTLE_TOLERANCE_PX + 2 &&
        col.isSolidAt(grid, wallTx, ledgeTy) &&
        !col.isSolidAt(grid, wallTx, ledgeTy - 1) &&
        !col.isSolidAt(grid, wallTx, ledgeTy - 2)
      ) {
        res.y = ledgeTopY - player.height;
        res.x += dir * 5;
        res.vy = 0;
        res.hitFloor = true;
        player.fallStartY = res.y + player.height * 0.5;
        if (player.attackPhase === 'none') {
          player.actionState = 'mantle';
          player.actionTicks = 6;
        }
      }
    }
  }

  // Apply resolved transform (convert top-left back to center-based pos)
  player.pos.x = res.x + player.width * 0.5;
  player.pos.y = res.y + player.height * 0.5;
  player.vel.x = res.vx;
  player.vel.y = res.vy;
  player.grounded = res.hitFloor;
  player.onOneWay = res.onOneWay;

  // Keep player locked inside Boss Arena horizontal bounds while active
  const arena = state.bossArenaState;
  if (arena.active && arena.lockedRightX > arena.lockedLeftX) {
    const minX = arena.lockedLeftX + player.width * 0.5;
    const maxX = arena.lockedRightX - player.width * 0.5;
    if (player.pos.x < minX) {
      player.pos.x = minX;
      player.vel.x = Math.max(0, player.vel.x);
    } else if (player.pos.x > maxX) {
      player.pos.x = maxX;
      player.vel.x = Math.min(0, player.vel.x);
    }
  }

  // 11. Landing, Coyote Time, Dive-Slam Impact & High-Fall Dizzy Stun
  if (player.grounded) {
    player.coyoteTicks = COYOTE_TICKS;
    player.airJumpsLeft = player.maxAirJumps;
    player.wallRunTicksLeft = WALL_RUN_MAX_TICKS;
    player.wallJumpLockTicks = 0;
    player.wallSlideTicks = 0;
    player.onWallDir = 0;

    if (player.diveSlamState === 'falling' && !res.crackedFloorHit) {
      triggerDiveSlamImpact(state, rng, col);
    } else if (!wasGrounded) {
      const fallHeight = player.pos.y - (player.fallStartY ?? player.pos.y);
      if (
        player.diveSlamState === 'none' &&
        player.actionState !== 'roll' &&
        player.actionState !== 'mantle' &&
        fallHeight >= FALL_STUN_HEIGHT_PX
      ) {
        if (rt.rollBufferTicks > 0) {
          // Timed 4-tick roll-buffer cleanly cancels High-Fall Dizzy Stun!
          rt.rollBufferTicks = 0;
          if (player.rollCooldownTicks <= 0) {
            startDodgeRoll(state, moveDir, rng);
          }
        } else {
          // Hard-landing High-Fall Dizzy Stun (36 ticks)!
          player.fallStunTicks = FALL_STUN_TICKS;
          player.actionState = 'hurt';
          player.vel.x = 0;
          player.attackPhase = 'none';
          player.attackPhaseTicks = 0;
          player.queuedInput = 'none';
          player.queuedInputTicks = 0;
          state.screenShake = Math.max(state.screenShake, 3.5);
          state.events.push({
            type: 'fallStun',
            x: player.pos.x,
            y: player.pos.y + player.height * 0.5,
          });
          for (let i = 0; i < 6; i++) {
            emitParticle(
              state,
              player.pos.x + rng.rangeFloat(-8, 8),
              player.pos.y + player.height * 0.45,
              rng.rangeFloat(-75, 75),
              rng.rangeFloat(-55, -10),
              3,
              i % 2 === 0 ? '#ffe066' : '#cfc8dc',
              18,
              'dust',
              i % 2 === 0,
              140
            );
          }
        }
      } else if (prevVy > 110) {
        state.events.push({
          type: 'land',
          x: player.pos.x,
          y: player.pos.y + player.height * 0.5,
          impactSpeed: prevVy,
        });
        for (let i = 0; i < 4; i++) {
          emitParticle(
            state,
            player.pos.x + rng.rangeFloat(-6, 6),
            player.pos.y + player.height * 0.5,
            rng.rangeFloat(-55, 55),
            rng.rangeFloat(-28, -5),
            2.5,
            '#cfc8dc',
            12,
            'dust',
            false,
            110
          );
        }
      }
    }

    player.fallStartY = player.pos.y;

    // Footstep SFX/FX cadence while running
    if (
      Math.abs(player.vel.x) > 85 &&
      state.tick % 14 === 0 &&
      player.actionState !== 'roll' &&
      (player.fallStunTicks ?? 0) <= 0
    ) {
      const footTx = Math.floor(player.pos.x / TILE_SIZE);
      const footTy = Math.floor((player.pos.y + player.height * 0.5 + 2) / TILE_SIZE);
      const under = col.getTile(grid, footTx, footTy);
      const surface: 'stone' | 'wood' | 'water' =
        under === TileKind.WATER
          ? 'water'
          : under === TileKind.ONE_WAY
            ? 'wood'
            : 'stone';
      state.events.push({
        type: 'footstep',
        x: player.pos.x,
        y: player.pos.y + player.height * 0.5,
        surface,
      });
    }
  }

  // 12. Breakable Secret Wall on Active Melee Attack
  if (player.attackPhase === 'active') {
    const reachTx = Math.floor((player.pos.x + player.facing * (player.width * 0.5 + 16)) / TILE_SIZE);
    const reachTy = Math.floor(player.pos.y / TILE_SIZE);
    breakSecretWallIfPresent(state, col, reachTx, reachTy, rng);
  }

  // 13. Environmental Tile Hazards (Spikes & Acid)
  if (state.runStatus === 'playing') {
    const hTxMin = Math.floor((player.pos.x - player.width * 0.5 + 2) / TILE_SIZE);
    const hTxMax = Math.floor((player.pos.x + player.width * 0.5 - 2) / TILE_SIZE);
    const hTyMin = Math.floor((player.pos.y - player.height * 0.5 + 4) / TILE_SIZE);
    const hTyMax = Math.floor((player.pos.y + player.height * 0.5 - 1) / TILE_SIZE);

    let hitHazard: 0 | typeof TileKind.SPIKES | typeof TileKind.ACID = 0;
    for (let ty = hTyMin; ty <= hTyMax && hitHazard === 0; ty++) {
      for (let tx = hTxMin; tx <= hTxMax; tx++) {
        const hz = col.isHazardAt(grid, tx, ty);
        if (hz === TileKind.SPIKES || hz === TileKind.ACID) {
          hitHazard = hz;
          break;
        }
      }
    }

    if (hitHazard === TileKind.SPIKES) {
      const dmg = Math.max(12, Math.round(player.maxHp * 0.12));
      if (damagePlayer(state, dmg, 'Spikes', rng)) {
        player.vel.y = -225;
        player.grounded = false;
        player.fallStartY = player.pos.y;
      }
    } else if (hitHazard === TileKind.ACID) {
      const dmg = Math.max(10, Math.round(player.maxHp * 0.1));
      if (damagePlayer(state, dmg, 'Toxic Acid', rng)) {
        applyStatus(player.statusEffects, 'poison', 150, 10, 0);
        player.vel.y = -195;
        player.grounded = false;
        player.fallStartY = player.pos.y;
      }
    }
  }

  // 14. Sync non-combat locomotion actionState cleanly
  const isLockedAction =
    player.hp <= 0 ||
    (player.fallStunTicks ?? 0) > 0 ||
    player.actionState === 'roll' ||
    player.actionState === 'diveSlam' ||
    player.actionState === 'attack' ||
    player.actionState === 'parry' ||
    player.actionState === 'parrySuccess' ||
    player.actionState === 'heal' ||
    (player.actionState === 'mantle' && player.actionTicks > 0);

  if (!isLockedAction) {
    if (player.grounded) {
      player.actionState = Math.abs(player.vel.x) > 12 ? 'run' : 'idle';
    } else if (player.onWallDir !== 0 && !climbing) {
      player.actionState = 'wallSlide';
    } else if (player.vel.y < 0) {
      player.actionState = 'jump';
    } else {
      player.actionState = 'fall';
    }
  }
}
