import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  TILE_SIZE,
  TileKind,
  createEmptyInputFrame,
  type InputFrame,
  type SimState,
  type TileGrid,
} from '../src/contracts';
import { collisionApi, sweepAabb } from '../src/sim/collision';
import { spawnEnemy } from '../src/sim/enemies';
import { stepPlayerPhysics } from '../src/sim/physics';
import { createRng } from '../src/sim/prng';
import { createInitialSimState, stepSim } from '../src/sim/step';
import { damagePlayer } from '../src/sim/combat';

function createFlatTestGrid(width = 30, height = 20, floorTy = 15): TileGrid {
  const tiles = new Uint8Array(width * height);
  const bgTiles = new Uint8Array(width * height);
  const explored = new Uint8Array(width * height);
  tiles.fill(TileKind.EMPTY);
  bgTiles.fill(TileKind.BG_WALL);
  explored.fill(1);

  for (let x = 0; x < width; x++) {
    tiles[0 * width + x] = TileKind.SOLID;
    tiles[(height - 1) * width + x] = TileKind.SOLID;
    for (let y = floorTy; y < height; y++) {
      tiles[y * width + x] = TileKind.SOLID;
    }
  }
  for (let y = 0; y < height; y++) {
    tiles[y * width + 0] = TileKind.SOLID;
    tiles[y * width + (width - 1)] = TileKind.SOLID;
  }
  return { width, height, tiles, bgTiles, explored };
}

function createSandboxState(floorTy = 15, seed = 424242): SimState {
  const state = createInitialSimState(seed, 0);
  state.tileGrid = createFlatTestGrid(30, 20, floorTy);
  state.enemies = [];
  state.projectiles = [];
  state.turrets = [];
  state.pickups = [];
  state.chests = [];
  state.doors = [];
  state.teleporters = [];
  state.shrines = [];
  state.hazards = [];
  state.particlesSim = [];
  state.bossArenaState.active = false;
  state.runStatus = 'playing';

  const floorY = floorTy * TILE_SIZE;
  state.player.pos = { x: 8 * TILE_SIZE, y: floorY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.onOneWay = false;
  state.player.onWallDir = 0;
  state.player.coyoteTicks = 6;
  state.player.jumpBufferTicks = 0;
  state.player.airJumpsLeft = 1;
  state.player.wallRunTicksLeft = 16;
  state.player.actionState = 'idle';
  state.player.diveSlamState = 'none';
  state.player.rollTicks = 0;
  state.player.rollCooldownTicks = 0;
  state.player.iframeTicks = 0;
  return state;
}

function inputOf(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...createEmptyInputFrame(), ...overrides };
}

describe('Physics & Swept AABB Collision', () => {
  describe('Sub-stepped Swept AABB Anti-Tunneling (2000+ px/s)', () => {
    it('prevents horizontal tunneling at +2400 px/s and -2400 px/s against a 1-tile thin solid wall', () => {
      const grid = createFlatTestGrid(30, 20, 16);
      // Place a single 1-tile-thick solid pillar wall at tx = 10, ty = 8..15
      for (let ty = 8; ty <= 15; ty++) {
        collisionApi.setTile(grid, 10, ty, TileKind.SOLID);
      }

      // Sweep right at 2400 px/s (40px per tick > 24px wall width!)
      const rightRes = sweepAabb(
        grid,
        8 * TILE_SIZE,
        12 * TILE_SIZE,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
        2400,
        0,
        FIXED_DT,
        false,
        false
      );
      expect(rightRes.hitRight).toBe(true);
      expect(rightRes.vx).toBe(0);
      expect(rightRes.x + PLAYER_WIDTH).toBeLessThanOrEqual(10 * TILE_SIZE + 0.001);
      expect(rightRes.wallSlamSpeed).toBe(2400);

      // Sweep left at -2600 px/s from right side of wall
      const leftRes = sweepAabb(
        grid,
        11 * TILE_SIZE + 6,
        12 * TILE_SIZE,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
        -2600,
        0,
        FIXED_DT,
        false,
        false
      );
      expect(leftRes.hitLeft).toBe(true);
      expect(leftRes.vx).toBe(0);
      expect(leftRes.x).toBeGreaterThanOrEqual(11 * TILE_SIZE - 0.001);
      expect(leftRes.wallSlamSpeed).toBe(2600);
    });

    it('prevents vertical floor and ceiling tunneling at 3000+ px/s against 1-tile thin slabs', () => {
      const grid = createFlatTestGrid(30, 20, 19);
      // 1-tile thick floating floor slab at ty = 12
      for (let tx = 4; tx <= 14; tx++) {
        collisionApi.setTile(grid, tx, 12, TileKind.SOLID);
      }
      // 1-tile thick ceiling slab at ty = 6
      for (let tx = 4; tx <= 14; tx++) {
        collisionApi.setTile(grid, tx, 6, TileKind.SOLID);
      }

      const downRes = sweepAabb(
        grid,
        8 * TILE_SIZE,
        10 * TILE_SIZE,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
        0,
        3200,
        FIXED_DT,
        false,
        false
      );
      expect(downRes.hitFloor).toBe(true);
      expect(downRes.vy).toBe(0);
      expect(downRes.y + PLAYER_HEIGHT).toBeCloseTo(12 * TILE_SIZE, 3);

      const upRes = sweepAabb(
        grid,
        8 * TILE_SIZE,
        8 * TILE_SIZE,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
        0,
        -3200,
        FIXED_DT,
        false,
        false
      );
      expect(upRes.hitCeiling).toBe(true);
      expect(upRes.vy).toBe(0);
      expect(upRes.y).toBeCloseTo(7 * TILE_SIZE, 3);
    });
  });

  describe('Ground Run Acceleration, Deceleration & Speed Buff', () => {
    it('accelerates from 155 px/s to 175 px/s in 3 ticks and stops cleanly in 2 ticks with zero drift', () => {
      const state = createSandboxState();
      const rng = createRng(101);

      // Tick 1: immediate snap to base speed 155
      stepPlayerPhysics(state, inputOf({ moveRight: true }), rng, collisionApi);
      expect(state.player.vel.x).toBeCloseTo(155, 3);

      // Tick 2: mid acceleration 165
      stepPlayerPhysics(state, inputOf({ moveRight: true }), rng, collisionApi);
      expect(state.player.vel.x).toBeCloseTo(165, 3);

      // Tick 3: reaches top speed 175
      stepPlayerPhysics(state, inputOf({ moveRight: true }), rng, collisionApi);
      expect(state.player.vel.x).toBeCloseTo(175, 3);

      // Release input -> decelerates in exactly 2 ticks to 0
      stepPlayerPhysics(state, inputOf(), rng, collisionApi);
      expect(state.player.vel.x).toBeCloseTo(87.5, 3);

      stepPlayerPhysics(state, inputOf(), rng, collisionApi);
      expect(state.player.vel.x).toBe(0);

      // Verify speed kill-streak buff grants +25% movement speed
      state.player.speedBuffTicks = 120;
      for (let i = 0; i < 4; i++) {
        stepPlayerPhysics(state, inputOf({ moveRight: true }), rng, collisionApi);
      }
      expect(state.player.vel.x).toBeCloseTo(175 * 1.25, 2);
    });
  });

  describe('Variable Jump, Early Release Cut, Double Jump, Coyote Time & Jump Buffer', () => {
    it('reaches significantly lower apex on early jump release vs full held jump', () => {
      const heldState = createSandboxState();
      const shortState = createSandboxState();
      const startY = heldState.player.pos.y;

      let heldMinY = startY;
      let shortMinY = startY;

      for (let t = 0; t < 45; t++) {
        stepSim(heldState, inputOf({ jump: true, jumpPressed: t === 0 }));
        stepSim(shortState, inputOf({ jump: t < 2, jumpPressed: t === 0 }));
        if (heldState.player.pos.y < heldMinY) heldMinY = heldState.player.pos.y;
        if (shortState.player.pos.y < shortMinY) shortMinY = shortState.player.pos.y;
      }

      const heldHeight = startY - heldMinY;
      const shortHeight = startY - shortMinY;
      expect(heldHeight).toBeGreaterThan(45);
      expect(shortHeight).toBeGreaterThan(10);
      expect(shortHeight).toBeLessThan(heldHeight * 0.72);
    });

    it('supports double jump in midair, blocks triple jump, and resets air jumps upon landing', () => {
      const state = createSandboxState();

      // Primary ground jump
      stepSim(state, inputOf({ jump: true, jumpPressed: true }));
      expect(state.events.some((e) => e.type === 'jump' && !e.isAirJump)).toBe(true);
      expect(state.player.airJumpsLeft).toBe(1);

      // Rise for a few ticks
      for (let t = 0; t < 12; t++) {
        stepSim(state, inputOf({ jump: true }));
      }
      expect(state.player.grounded).toBe(false);

      // Trigger Double Jump
      stepSim(state, inputOf({ jump: true, jumpPressed: true }));
      expect(state.events.some((e) => e.type === 'jump' && e.isAirJump)).toBe(true);
      expect(state.player.airJumpsLeft).toBe(0);
      expect(state.player.vel.y).toBeLessThan(-250);

      // Attempt Triple Jump -> should NOT emit jump event
      for (let t = 0; t < 5; t++) stepSim(state, inputOf({ jump: true }));
      stepSim(state, inputOf({ jump: true, jumpPressed: true }));
      expect(state.events.some((e) => e.type === 'jump')).toBe(false);

      // Let player fall back to floor and confirm air jump resets
      for (let t = 0; t < 120 && !state.player.grounded; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.grounded).toBe(true);
      expect(state.player.airJumpsLeft).toBe(state.player.maxAirJumps);
    });

    it('honors 6-tick coyote time after walking off a ledge without consuming double jump', () => {
      const state = createSandboxState(18);
      // Build an elevated ledge at ty = 12 for tx = 2..8
      for (let tx = 2; tx <= 8; tx++) {
        collisionApi.setTile(state.tileGrid, tx, 12, TileKind.SOLID);
      }
      state.player.pos = { x: 8 * TILE_SIZE + 14, y: 12 * TILE_SIZE - PLAYER_HEIGHT * 0.5 };
      state.player.grounded = true;
      state.player.coyoteTicks = 6;

      // Walk off the right edge until airborne
      let airborneTicks = 0;
      for (let t = 0; t < 20; t++) {
        stepSim(state, inputOf({ moveRight: true }));
        if (!state.player.grounded) {
          airborneTicks++;
          if (airborneTicks === 4) break; // Within 6-tick coyote window!
        }
      }
      expect(state.player.grounded).toBe(false);
      expect(state.player.coyoteTicks).toBeGreaterThan(0);

      // Press jump within coyote window -> performs ground jump, keeps air jump intact!
      stepSim(state, inputOf({ jump: true, jumpPressed: true }));
      expect(state.events.some((e) => e.type === 'jump' && !e.isAirJump)).toBe(true);
      expect(state.player.airJumpsLeft).toBe(1);
    });

    it('triggers a buffered jump when jumpPressed occurs up to 7 ticks before landing', () => {
      const state = createSandboxState(15);
      const floorY = 15 * TILE_SIZE;
      // Place player falling just above floor with airJumpsLeft = 0 so jump press is buffered, not air-jumped
      state.player.pos = { x: 8 * TILE_SIZE, y: floorY - PLAYER_HEIGHT * 0.5 - 24 };
      state.player.vel = { x: 0, y: 360 };
      state.player.grounded = false;
      state.player.coyoteTicks = 0;
      state.player.airJumpsLeft = 0;

      // Press jump 4 ticks before hitting ground (within 7-tick jump buffer)
      stepSim(state, inputOf({ jump: true, jumpPressed: true }));
      expect(state.player.jumpBufferTicks).toBe(7);

      let jumpedOnLanding = false;
      for (let t = 0; t < 10; t++) {
        stepSim(state, inputOf({ jump: true }));
        if (state.events.some((e) => e.type === 'jump' && !e.isAirJump)) {
          jumpedOnLanding = true;
          break;
        }
      }
      expect(jumpedOnLanding).toBe(true);
      expect(state.player.vel.y).toBeLessThan(-250);
    });
  });

  describe('One-Way Platform Drop-Through & Ledge Auto-Mantle', () => {
    it('supports standing on a one-way platform and immediately drops through on moveDown + jumpPressed', () => {
      const state = createSandboxState(16);
      // Place one-way platform at ty = 12
      for (let tx = 4; tx <= 14; tx++) {
        collisionApi.setTile(state.tileGrid, tx, 12, TileKind.ONE_WAY);
      }
      const platTopY = 12 * TILE_SIZE;
      state.player.pos = { x: 8 * TILE_SIZE, y: platTopY - PLAYER_HEIGHT * 0.5 - 4 };
      state.player.vel = { x: 0, y: 60 };
      state.player.grounded = false;

      // Land on one-way platform
      for (let t = 0; t < 10; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.grounded).toBe(true);
      expect(state.player.onOneWay).toBe(true);
      expect(state.player.pos.y + PLAYER_HEIGHT * 0.5).toBeCloseTo(platTopY, 1);

      // Press moveDown + jumpPressed to drop through immediately
      stepSim(state, inputOf({ moveDown: true, jumpPressed: true }));
      expect(state.player.grounded).toBe(false);
      expect(state.player.onOneWay).toBe(false);

      // Continue falling onto lower solid floor at ty = 16
      for (let t = 0; t < 45; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.grounded).toBe(true);
      expect(state.player.onOneWay).toBe(false);
      expect(state.player.pos.y + PLAYER_HEIGHT * 0.5).toBeCloseTo(16 * TILE_SIZE, 1);
    });

    it('auto-mantles onto a solid ledge within 10px vertical tolerance', () => {
      const state = createSandboxState(16);
      // Solid 1-tile block ledge at tx = 10, ty = 13 (top at y = 312), empty above (ty=11,12)
      collisionApi.setTile(state.tileGrid, 10, 13, TileKind.SOLID);
      collisionApi.setTile(state.tileGrid, 10, 14, TileKind.SOLID);
      collisionApi.setTile(state.tileGrid, 10, 15, TileKind.SOLID);

      const ledgeTopY = 13 * TILE_SIZE; // 312
      // Place airborne player pressing right against left side of block with feet 6px below ledgeTopY
      state.player.pos = {
        x: 10 * TILE_SIZE - PLAYER_WIDTH * 0.5 - 1,
        y: ledgeTopY + 6 - PLAYER_HEIGHT * 0.5,
      };
      state.player.vel = { x: 160, y: 10 };
      state.player.grounded = false;

      stepSim(state, inputOf({ moveRight: true }));
      expect(state.player.actionState).toBe('mantle');
      expect(state.player.grounded).toBe(true);
      expect(state.player.pos.y + PLAYER_HEIGHT * 0.5).toBeCloseTo(ledgeTopY, 1);
    });
  });

  describe('Spider Wall-Run, Wall-Slide & Wall-Jump', () => {
    it('wall-runs upward for 16 ticks, transitions to slow wall-slide (vy <= 70), and wall-jumps away', () => {
      const state = createSandboxState(18);
      // Tall vertical solid wall on the right at tx = 12, ty = 2..17
      for (let ty = 2; ty <= 17; ty++) {
        collisionApi.setTile(state.tileGrid, 12, ty, TileKind.SOLID);
      }

      // Position airborne player flush against the right wall
      const wallLeftX = 12 * TILE_SIZE;
      state.player.pos = { x: wallLeftX - PLAYER_WIDTH * 0.5, y: 12 * TILE_SIZE };
      state.player.vel = { x: 0, y: 0 };
      state.player.grounded = false;
      state.player.coyoteTicks = 0;
      state.player.wallRunTicksLeft = 16;
      state.metaSnapshot.runesUnlocked.spider = true;

      const startY = state.player.pos.y;

      // Hold moveRight for 16 ticks -> climbs upward (Spider Wall-Run)
      for (let t = 0; t < 16; t++) {
        stepSim(state, inputOf({ moveRight: true }));
        expect(state.player.onWallDir).toBe(1);
        expect(state.player.vel.y).toBeCloseTo(-135, 1);
      }
      expect(state.player.pos.y).toBeLessThan(startY - 25);
      expect(state.player.wallRunTicksLeft).toBe(0);

      // Next ticks while still holding into wall -> wall-slide clamped to vy <= 70
      for (let t = 0; t < 15; t++) {
        stepSim(state, inputOf({ moveRight: true }));
      }
      expect(state.player.vel.y).toBeLessThanOrEqual(70.01);
      expect(state.player.wallSlideTicks).toBeGreaterThan(0);

      // Press jump -> Spider Wall-Jump launches left (vx = -195, upward vy) & refreshes air jump + wall run
      state.player.airJumpsLeft = 0;
      stepSim(state, inputOf({ moveRight: true, jump: true, jumpPressed: true }));
      expect(state.player.facing).toBe(-1);
      expect(state.player.vel.x).toBeLessThan(-150);
      expect(state.player.vel.y).toBeLessThan(-270);
      expect(state.player.airJumpsLeft).toBe(state.player.maxAirJumps);
      expect(state.player.wallRunTicksLeft).toBe(16);
    });
  });

  describe('Dodge Roll, 21-Tick Iframes & Wooden Door Smash', () => {
    it('runs for 24 ticks with 21 full iframe ticks that negate damage', () => {
      const state = createSandboxState();
      const rng = createRng(777);
      const startHp = state.player.hp;

      // Initiate dodge roll
      stepSim(state, inputOf({ rollPressed: true }));
      expect(state.player.actionState).toBe('roll');
      expect(state.player.iframeTicks).toBe(21);
      expect(state.events.some((e) => e.type === 'dodgeRoll')).toBe(true);

      let rollDurationTicks = 1;
      let iframeActiveTicks = state.player.iframeTicks > 0 ? 1 : 0;

      // Tick 1 damage attempt must be negated by roll iframes
      expect(damagePlayer(state, 40, 'TestHit', rng)).toBe(false);
      expect(state.player.hp).toBe(startHp);

      for (let t = 2; t <= 30; t++) {
        stepSim(state, inputOf());
        if (state.player.actionState === 'roll') {
          rollDurationTicks++;
        }
        if (state.player.iframeTicks > 0) {
          iframeActiveTicks++;
          // Verify damage is negated throughout all 21 iframe ticks
          expect(damagePlayer(state, 40, 'TestHit', rng)).toBe(false);
          expect(state.player.hp).toBe(startHp);
        }
      }

      // 24 ticks total roll duration (tick 1 starts with 24->23, tick 24 hits 0 and exits)
      expect(rollDurationTicks).toBe(23);
      expect(iframeActiveTicks).toBe(21);
      expect(state.player.actionState).not.toBe('roll');
      expect(state.player.iframeTicks).toBe(0);

      // Once iframes end, damage connects normally
      expect(damagePlayer(state, 20, 'PostRollHit', rng)).toBe(true);
      expect(state.player.hp).toBe(startHp - 20);
    });

    it('smashes wooden doors during roll and stuns enemies behind the door for 90 ticks', () => {
      const state = createSandboxState();
      const rng = createRng(999);
      const floorY = 15 * TILE_SIZE;

      state.doors.push({
        uid: state.nextUid++,
        pos: { x: state.player.pos.x + 26, y: floorY - 22 },
        width: 12,
        height: 44,
        kind: 'wood',
        opened: false,
        broken: false,
      });

      const enemy = spawnEnemy(state, 'Zombie', state.player.pos.x + 56, floorY - 14, 0, rng);
      enemy.state = 'patrol';
      enemy.stunTicks = 0;

      let smashed = false;
      for (let t = 0; t < 12; t++) {
        stepSim(state, inputOf({ rollPressed: t === 0 }));
        if (state.events.some((e) => e.type === 'doorSmash')) {
          smashed = true;
          break;
        }
      }

      expect(smashed).toBe(true);
      expect(state.doors[0]!.broken).toBe(true);
      expect(state.doors[0]!.opened).toBe(true);
      expect(enemy.state).toBe('stunned');
      expect(enemy.stunTicks).toBeGreaterThanOrEqual(89);
    });
  });

  describe('Downward Dive-Slam Shockwave & Cracked Floor Shattering', () => {
    it('shatters TileKind.CRACKED_FLOOR and unleashes a 56px shockwave that stuns enemies on impact', () => {
      const state = createSandboxState(17);
      const rng = createRng(555);

      // Place a cracked floor bridge at ty = 11 (tx = 6..10) over a lower solid floor at ty = 17
      for (let tx = 6; tx <= 10; tx++) {
        collisionApi.setTile(state.tileGrid, tx, 11, TileKind.CRACKED_FLOOR);
      }

      // Place enemy standing on the lower floor directly within 56px of landing point
      const lowerFloorY = 17 * TILE_SIZE;
      const victim = spawnEnemy(state, 'Zombie', 8 * TILE_SIZE + 30, lowerFloorY - 14, 0, rng);
      const victimInitialHp = victim.hp;

      // Start player airborne above the cracked floor
      state.player.pos = { x: 8 * TILE_SIZE, y: 8 * TILE_SIZE };
      state.player.vel = { x: 0, y: 0 };
      state.player.grounded = false;
      state.player.coyoteTicks = 0;

      // Initiate Dive-Slam with moveDown + jumpPressed while airborne
      stepSim(state, inputOf({ moveDown: true, jumpPressed: true }));
      expect(state.player.diveSlamState).toBe('falling');
      expect(state.player.actionState).toBe('diveSlam');
      expect(state.player.vel.y).toBe(540);

      let impactEventSeen = false;
      for (let t = 0; t < 45; t++) {
        stepSim(state, inputOf({ moveDown: true }));
        if (state.events.some((e) => e.type === 'diveSlamImpact')) {
          impactEventSeen = true;
          break;
        }
      }

      // Cracked floor shattered to EMPTY
      expect(collisionApi.getTile(state.tileGrid, 8, 11)).toBe(TileKind.EMPTY);
      // Player landed on lower floor, entered 10t impact recovery stance, and triggered shockwave
      expect(impactEventSeen).toBe(true);
      expect(state.player.grounded).toBe(true);
      expect(state.player.diveSlamState).toBe('impact');
      expect(state.player.pos.y + PLAYER_HEIGHT * 0.5).toBeCloseTo(lowerFloorY, 1);

      // Enemy within shockwave radius took damage & was stunned (Tier 2 Ram Crater: 55t)
      expect(victim.hp).toBeLessThan(victimInitialHp);
      expect(victim.state).toBe('stunned');
      expect(victim.stunTicks).toBeGreaterThanOrEqual(40);

      // Impact stance clears cleanly after hitstop + 10 recovery ticks
      for (let t = 0; t < 18 && state.player.diveSlamState === 'impact'; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.diveSlamState).toBe('none');
    });
  });
});
