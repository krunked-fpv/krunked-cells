// =============================================================================
// KRUNKED CELLS — Acrobatic 60 Hz Player Physics & Traversal Controller
// Ground Run (3-tick accel / 2-tick stop), Variable Jump, Double Jump, Coyote
// Time (6 ticks), Jump Buffer (7 ticks), Auto-Mantle, One-Way Drop-Through,
// Chains/Ladders, Spider Wall-Run & Wall-Jump, Dodge Roll (24 ticks / 21 iframes
// + Door Smash + Armadillopack), Downward Dive-Slam, Hazards & Secret Walls.
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// =============================================================================

import {
  FIXED_DT,
  TILE_SIZE,
  TileKind,
  type CollisionAPI,
  type InputFrame,
  type RngAPI,
  type SimState,
} from '../contracts';
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
const COYOTE_TICKS = 6;
const JUMP_BUFFER_TICKS = 7;
const WALL_RUN_VY = -135;
const WALL_RUN_MAX_TICKS = 16;
const WALL_SLIDE_MAX_VY = 70;
const WALL_JUMP_VX = 195;
const WALL_JUMP_VY = -315;
const ROLL_DURATION_TICKS = 24;
const ROLL_IFRAME_TICKS = 21;
const ROLL_SPEED = 265;
const ROLL_COOLDOWN_TICKS = 15;
const DIVE_SLAM_VY = 540;
const DIVE_SLAM_RADIUS = 56;
const DIVE_SLAM_STUN_TICKS = 45;
const CLIMB_UP_VY = -145;
const CLIMB_DOWN_VY = 155;
const MANTLE_TOLERANCE_PX = 10;

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

function smashWoodenDoor(
  state: SimState,
  doorIdx: number,
  rng: RngAPI
): void {
  const door = state.doors[doorIdx]!;
  door.broken = true;
  door.opened = true;
  state.screenShake = Math.max(state.screenShake, 3.5);
  state.events.push({ type: 'doorSmash', x: door.pos.x, y: door.pos.y });

  for (let p = 0; p < 7; p++) {
    emitParticle(
      state,
      door.pos.x,
      door.pos.y + rng.rangeFloat(-14, 14),
      state.player.facing * rng.rangeFloat(80, 200),
      rng.rangeFloat(-130, -20),
      3.5,
      '#b87a42',
      24,
      'dust',
      false,
      420
    );
  }

  // Stun enemies within 72px behind/near the smashed door for 90 ticks
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state === 'dead' || e.hp <= 0 || e.isBoss) continue;
    if (Math.hypot(e.pos.x - door.pos.x, e.pos.y - door.pos.y) <= 72) {
      e.stunTicks = Math.max(e.stunTicks, 90);
      e.state = 'stunned';
      e.stateTicks = Math.max(e.stateTicks, 90);
      e.telegraphTicks = 0;
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

function triggerDiveSlamImpact(
  state: SimState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  const fallHeight = Math.max(24, player.pos.y - player.diveStartY);
  const scrollMult = getScrollDamageMultiplier(player.scrolls, 'colorless');
  const rawPower = Math.round((28 + Math.min(260, fallHeight) * 0.35) * scrollMult);
  const impactY = player.pos.y + player.height * 0.5;

  player.diveSlamState = 'none';
  player.actionState = 'idle';
  state.screenShake = Math.max(state.screenShake, 6.5);

  state.events.push({
    type: 'diveSlamImpact',
    x: player.pos.x,
    y: impactY,
    radius: DIVE_SLAM_RADIUS,
    power: rawPower,
  });

  emitParticle(state, player.pos.x, impactY - 4, 0, 0, DIVE_SLAM_RADIUS, '#ffcf66', 16, 'ring', true, 0);
  for (let i = 0; i < 8; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    emitParticle(
      state,
      player.pos.x + dir * rng.rangeFloat(4, 18),
      impactY - 2,
      dir * rng.rangeFloat(65, 165),
      rng.rangeFloat(-120, -35),
      3,
      '#d8d0e8',
      18,
      'dust',
      false,
      360
    );
  }

  // Stun & damage enemies in shockwave radius
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state === 'dead' || e.hp <= 0) continue;
    const dx = e.pos.x - player.pos.x;
    const dy = e.pos.y - player.pos.y;
    if (Math.hypot(dx, dy) <= DIVE_SLAM_RADIUS) {
      if (!e.isBoss) {
        e.stunTicks = Math.max(e.stunTicks, DIVE_SLAM_STUN_TICKS);
        e.state = 'stunned';
        e.stateTicks = Math.max(e.stateTicks, DIVE_SLAM_STUN_TICKS);
        e.telegraphTicks = 0;
        applyStatus(e.statusEffects, 'stun', DIVE_SLAM_STUN_TICKS, 0, 0);
      }
      const pushDir = dx >= 0 ? 1 : -1;
      damageEnemy(
        state,
        e,
        rawPower,
        false,
        55,
        pushDir * 145,
        -95,
        rng,
        'diveSlam',
        undefined,
        col
      );
    }
  }

  // Smash wooden doors in shockwave radius
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.kind === 'wood' && !door.broken) {
      if (Math.hypot(door.pos.x - player.pos.x, door.pos.y - player.pos.y) <= DIVE_SLAM_RADIUS) {
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

  // 1. Tick movement & invulnerability timers
  if (player.iframeTicks > 0) player.iframeTicks -= 1;
  if (player.rollCooldownTicks > 0) player.rollCooldownTicks -= 1;
  if (player.coyoteTicks > 0) player.coyoteTicks -= 1;
  if (player.jumpBufferTicks > 0) player.jumpBufferTicks -= 1;
  if (player.actionState === 'mantle' && player.actionTicks > 0) {
    player.actionTicks -= 1;
  }

  if (input.jumpPressed) {
    player.jumpBufferTicks = JUMP_BUFFER_TICKS;
  }

  const moveDir = (input.moveRight ? 1 : 0) - (input.moveLeft ? 1 : 0);
  if (moveDir !== 0 && player.actionState !== 'roll' && player.diveSlamState === 'none') {
    // Allow facing change unless locked mid-active swing
    if (player.attackPhase !== 'active') {
      player.facing = moveDir > 0 ? 1 : -1;
    }
  }

  const speedMult = player.speedBuffTicks > 0 ? 1.25 : 1.0;

  // 2. Dodge Roll initiation (24 ticks, 21 iframes, 265 px/s, 15-tick cooldown)
  if (
    input.rollPressed &&
    player.rollCooldownTicks <= 0 &&
    player.actionState !== 'roll'
  ) {
    if (moveDir !== 0) {
      player.facing = moveDir > 0 ? 1 : -1;
    }
    player.actionState = 'roll';
    player.rollTicks = ROLL_DURATION_TICKS;
    player.iframeTicks = Math.max(player.iframeTicks, ROLL_IFRAME_TICKS);
    player.rollCooldownTicks = ROLL_COOLDOWN_TICKS;
    player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 24);
    player.diveSlamState = 'none';
    player.attackPhase = 'none';
    player.attackPhaseTicks = 0;
    player.attackHitIds = [];
    player.parryWindowTicks = 0;
    player.queuedInput = 'none';
    player.queuedInputTicks = 0;
    player.vel.x = player.facing * ROLL_SPEED;
    if (player.vel.y > 40) player.vel.y = 40;

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

  let dropThroughOneWay = false;
  let breakCrackedFloor = false;
  let climbing = false;

  // 3. Active Dodge Roll locomotion, door-smash & Armadillopack parry-roll
  if (player.actionState === 'roll') {
    player.rollTicks -= 1;
    player.vel.x = player.facing * ROLL_SPEED;
    player.vel.y = Math.min(MAX_FALL_SPEED, player.vel.y + GRAVITY_FALL * FIXED_DT);

    // Smash wooden doors encountered during roll
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

    // Armadillopack mutation: rolling parries nearby parriable projectiles & attacking foes!
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
    }
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
    } else if (
      !player.grounded &&
      input.moveDown &&
      input.jumpPressed &&
      player.diveSlamState === 'none'
    ) {
      player.diveSlamState = 'falling';
      player.diveStartY = player.pos.y;
      player.actionState = 'diveSlam';
      player.vel.x *= 0.2;
      player.vel.y = DIVE_SLAM_VY;
      player.iframeTicks = Math.max(player.iframeTicks, 12);
      player.jumpBufferTicks = 0;
      player.coyoteTicks = 0;
      player.onWallDir = 0;
    }

    if (player.diveSlamState === 'falling') {
      player.vel.y = DIVE_SLAM_VY;
      player.vel.x *= 0.85;
      player.iframeTicks = Math.max(player.iframeTicks, 6);
      breakCrackedFloor = true;
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
        } else {
          // Responsive air control
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

        // 7. Spider Wall-Run & Wall-Slide Detection
        let wallDir: -1 | 0 | 1 = 0;
        if (!player.grounded) {
          const leftTx = Math.floor((player.pos.x - player.width * 0.5 - 2) / TILE_SIZE);
          const rightTx = Math.floor((player.pos.x + player.width * 0.5 + 2) / TILE_SIZE);
          const bodyTy = Math.floor(player.pos.y / TILE_SIZE);
          const touchLeft = col.isSolidAt(grid, leftTx, bodyTy);
          const touchRight = col.isSolidAt(grid, rightTx, bodyTy);

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
            // Spider Wall-Jump
            player.vel.x = -wallDir * WALL_JUMP_VX;
            player.vel.y = WALL_JUMP_VY;
            player.facing = wallDir === 1 ? -1 : 1;
            player.airJumpsLeft = player.maxAirJumps;
            player.wallRunTicksLeft = WALL_RUN_MAX_TICKS;
            player.wallSlideTicks = 0;
            player.onWallDir = 0;
            player.jumpBufferTicks = 0;
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

  // 10. Auto-Mantle / Ledge Climb (within 10px vertical tolerance of a 1-tile solid corner)
  if (
    !res.hitFloor &&
    player.diveSlamState === 'none' &&
    player.actionState !== 'roll' &&
    ((res.hitRight && input.moveRight) || (res.hitLeft && input.moveLeft))
  ) {
    const dir = res.hitRight ? 1 : -1;
    const wallTx =
      dir > 0
        ? Math.floor((res.x + player.width + 1) / TILE_SIZE)
        : Math.floor((res.x - 1) / TILE_SIZE);
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
      if (player.attackPhase === 'none') {
        player.actionState = 'mantle';
        player.actionTicks = 6;
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

  // 11. Landing, Coyote Time & Dive-Slam Impact
  if (player.grounded) {
    player.coyoteTicks = COYOTE_TICKS;
    player.airJumpsLeft = player.maxAirJumps;
    player.wallRunTicksLeft = WALL_RUN_MAX_TICKS;
    player.wallSlideTicks = 0;
    player.onWallDir = 0;

    if (player.diveSlamState === 'falling' && !res.crackedFloorHit) {
      triggerDiveSlamImpact(state, rng, col);
    } else if (!wasGrounded && prevVy > 110) {
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

    // Footstep SFX/FX cadence while running
    if (Math.abs(player.vel.x) > 85 && state.tick % 14 === 0 && player.actionState !== 'roll') {
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
      }
    } else if (hitHazard === TileKind.ACID) {
      const dmg = Math.max(10, Math.round(player.maxHp * 0.1));
      if (damagePlayer(state, dmg, 'Toxic Acid', rng)) {
        applyStatus(player.statusEffects, 'poison', 150, 10, 0);
        player.vel.y = -195;
        player.grounded = false;
      }
    }
  }

  // 14. Sync non-combat locomotion actionState cleanly
  const isLockedAction =
    player.hp <= 0 ||
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
