// =============================================================================
// KRUNKED CELLS — Abilities Parity & Feel Regression Suite
// Pure headless simulation tests targeting the canonical contracts in
// src/contracts/index.ts (starter 4-slot loadout, Phaser empty-room blink,
// turret/trap floor-snapping, grenade explosion events, shield hold-to-block
// & parryStart feedback, full-HP/empty flask feedback, and mouse aim).
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  PLAYER_HEIGHT,
  TILE_SIZE,
  TileKind,
  createEmptyInputFrame,
  type GearInstance,
  type InputFrame,
  type SimEvent,
  type SimState,
  type TileGrid,
} from '../src/contracts';
import { SKILL_MAP, getWeapon } from '../src/data';
import { collisionApi } from '../src/sim/collision';
import { damagePlayer } from '../src/sim/combat';
import { spawnEnemy } from '../src/sim/enemies';
import { createRng } from '../src/sim/prng';
import { createInitialSimState, stepSim } from '../src/sim/step';

function createFlatArenaGrid(width = 36, height = 20, floorTy = 15): TileGrid {
  const tiles = new Uint8Array(width * height);
  const bgTiles = new Uint8Array(width * height);
  const explored = new Uint8Array(width * height);
  tiles.fill(TileKind.EMPTY);
  bgTiles.fill(TileKind.BG_WALL);
  explored.fill(1);
  for (let x = 0; x < width; x++) {
    tiles[x] = TileKind.SOLID;
    for (let y = floorTy; y < height; y++) {
      tiles[y * width + x] = TileKind.SOLID;
    }
  }
  for (let y = 0; y < height; y++) {
    tiles[y * width] = TileKind.SOLID;
    tiles[y * width + (width - 1)] = TileKind.SOLID;
  }
  return { width, height, tiles, bgTiles, explored };
}

function createAbilitiesSandbox(seed = 202601, floorTy = 15): SimState {
  const state = createInitialSimState(seed, 0);
  state.tileGrid = createFlatArenaGrid(36, 20, floorTy);
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
  state.passageState.active = false;
  state.runStatus = 'playing';

  const floorY = floorTy * TILE_SIZE;
  state.player.pos = { x: 10 * TILE_SIZE, y: floorY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.iframeTicks = 0;
  state.player.parryWindowTicks = 0;
  state.player.parryCooldownTicks = 0;
  state.player.rollCooldownTicks = 0;
  state.player.healTicks = 0;
  return state;
}

function inputOf(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...createEmptyInputFrame(), ...overrides };
}

function makeGear(state: SimState, defId: string, slotKind: 'weapon' | 'skill'): GearInstance {
  if (slotKind === 'skill') {
    const def = SKILL_MAP[defId]!;
    return {
      uid: state.nextUid++,
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
    uid: state.nextUid++,
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

function stepCollect(
  state: SimState,
  ticks: number,
  inputFn: (t: number) => Partial<InputFrame> = () => ({})
): SimEvent[] {
  const collected: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    stepSim(state, inputOf(inputFn(t)));
    collected.push(...state.events);
  }
  return collected;
}

function getFloorGapPx(state: SimState, x: number, y: number): number {
  const tx = Math.floor(x / TILE_SIZE);
  const startTy = Math.max(0, Math.floor((y - 2) / TILE_SIZE));
  for (let ty = startTy; ty < state.tileGrid.height; ty++) {
    if (collisionApi.isSolidAt(state.tileGrid, tx, ty) || collisionApi.isOneWayAt(state.tileGrid, tx, ty)) {
      return ty * TILE_SIZE - y;
    }
  }
  return Infinity;
}

describe('Abilities Parity & Combat Feel Contracts', () => {
  describe('Starter 4-Slot Loadout', () => {
    it('starts every new run with all 4 active slots populated (StartSword, StartShield, InfantryGrenade, SinewSlicer)', () => {
      const state = createInitialSimState(12345, 0);
      expect(state.player.loadout.weapon1?.defId).toBe('StartSword');
      expect(state.player.loadout.weapon2?.defId).toBe('StartShield');
      expect(state.player.loadout.skill1?.defId).toBe('InfantryGrenade');
      expect(state.player.loadout.skill2).not.toBeNull();
      expect(state.player.loadout.skill2?.defId).toBe('SinewSlicer');
      expect(Boolean(state.player.shieldBlocking)).toBe(false);
    });
  });

  describe('Phaser Empty-Room Phantom Blink & Behind-Enemy Teleport', () => {
    it('blinks forward > 40px and emits teleport event when no enemy is in range', () => {
      const state = createAbilitiesSandbox(2001);
      state.player.loadout.skill1 = makeGear(state, 'Phaser', 'skill');
      const startX = state.player.pos.x;

      stepSim(state, inputOf({ skill1Pressed: true }));

      expect(state.events.some((e) => e.type === 'skillCast' && e.skillId === 'Phaser')).toBe(true);
      expect(state.events.some((e) => e.type === 'teleport')).toBe(true);
      expect(state.player.pos.x - startX).toBeGreaterThan(40);
      expect(state.player.afterRollCritTicks).toBeGreaterThan(0);
    });

    it('still teleports behind a living enemy, roots, and damages them when in range', () => {
      const state = createAbilitiesSandbox(2002);
      const rng = createRng(2002);
      state.player.loadout.skill1 = makeGear(state, 'Phaser', 'skill');
      const foe = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 96, state.player.pos.y, 0, rng);
      foe.facing = -1;
      const hpBefore = foe.hp;

      stepSim(state, inputOf({ skill1Pressed: true }));

      expect(state.events.some((e) => e.type === 'teleport')).toBe(true);
      expect(state.player.pos.x).toBeGreaterThan(foe.pos.x);
      expect(foe.hp).toBeLessThan(hpBefore);
    });
  });

  describe('Turret & Trap Floor-Snapping (Solid & One-Way Floors)', () => {
    it.each(['SinewSlicer', 'HeavyTurret', 'WolfTrap'] as const)(
      'snaps midair-deployed %s flush onto the floor within <= 16px',
      (skillId) => {
        const state = createAbilitiesSandbox(3001, 15);
        state.player.loadout.skill1 = makeGear(state, skillId, 'skill');

        // Start player 72px midair above solid floor
        const floorY = 15 * TILE_SIZE;
        state.player.pos.y = floorY - PLAYER_HEIGHT * 0.5 - 72;
        state.player.grounded = false;
        state.player.vel = { x: 0, y: 0 };

        stepCollect(state, 20, (t) => ({ skill1Pressed: t === 0 }));

        const deployed = state.turrets.filter((t) => t.owner === 'player');
        expect(deployed.length).toBeGreaterThanOrEqual(skillId === 'WolfTrap' ? 2 : 1);
        for (const tur of deployed) {
          const gap = getFloorGapPx(state, tur.pos.x, tur.pos.y);
          expect(gap).toBeLessThanOrEqual(16);
          expect(gap).toBeGreaterThanOrEqual(-12);
        }
      }
    );

    it('snaps turrets deployed above a ONE_WAY platform directly onto the platform', () => {
      const state = createAbilitiesSandbox(3002, 16);
      for (let tx = 8; tx <= 14; tx++) {
        collisionApi.setTile(state.tileGrid, tx, 12, TileKind.ONE_WAY);
      }
      state.player.loadout.skill1 = makeGear(state, 'SinewSlicer', 'skill');
      state.player.pos = { x: 10 * TILE_SIZE, y: 10 * TILE_SIZE };
      state.player.grounded = false;

      stepCollect(state, 15, (t) => ({ skill1Pressed: t === 0 }));

      const tur = state.turrets.find((t) => t.owner === 'player');
      expect(tur).toBeDefined();
      if (tur) {
        const gap = getFloorGapPx(state, tur.pos.x, tur.pos.y);
        expect(gap).toBeLessThanOrEqual(16);
        expect(tur.pos.y).toBeLessThan(12 * TILE_SIZE + 4);
      }
    });
  });

  describe('Grenade Explosion Events & Elemental Effects', () => {
    it.each([
      { skillId: 'InfantryGrenade', expectedElement: 'physical' as const },
      { skillId: 'FireGrenade', expectedElement: 'fire' as const },
      { skillId: 'IceGrenade', expectedElement: 'ice' as const },
      { skillId: 'ClusterGrenade', expectedElement: 'cluster' as const },
    ])(
      'emits explosion SimEvent (element="$expectedElement") and damages enemies for $skillId',
      ({ skillId, expectedElement }) => {
        const state = createAbilitiesSandbox(4001);
        const rng = createRng(4001);
        state.player.loadout.skill1 = makeGear(state, skillId, 'skill');
        const foe = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 140, state.player.pos.y, 0, rng);
        foe.attackCooldownTicks = 9999;
        const hpBefore = foe.hp;

        const evs = stepCollect(state, 95, (t) => ({ skill1Pressed: t === 0 }));
        const explosions = evs.filter((e) => e.type === 'explosion');

        expect(explosions.length).toBeGreaterThanOrEqual(1);
        expect(explosions.some((e) => e.element === expectedElement)).toBe(true);
        expect(foe.hp).toBeLessThan(hpBefore);
      }
    );
  });

  describe('Shield Hold-to-Block & parryStart Feedback', () => {
    it('emits parryStart immediately when pressing shield in open air', () => {
      const state = createAbilitiesSandbox(5001);
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(state.player.actionState).toBe('parry');
      expect(state.events.some((e) => e.type === 'parryStart')).toBe(true);
    });

    it('activates shieldBlocking when holding shield, cuts incoming damage ~75%, emits shieldBlock, and clears on release', () => {
      const state = createAbilitiesSandbox(5002);
      const rng = createRng(5002);

      // Hold weapon2Held while idle (parryWindowTicks === 0)
      stepCollect(state, 2, () => ({ weapon2Held: true }));
      expect(state.player.shieldBlocking).toBe(true);

      state.player.iframeTicks = 0;
      const hpBefore = state.player.hp;
      state.events = [];
      const damaged = damagePlayer(state, 40, 'Zombie', rng);

      expect(damaged).toBe(true);
      expect(hpBefore - state.player.hp).toBeLessThanOrEqual(12);
      expect(state.events.some((e) => e.type === 'shieldBlock')).toBe(true);

      // Releasing shield stops blocking
      stepSim(state, inputOf({ weapon2Held: false }));
      expect(state.player.shieldBlocking).toBe(false);
    });
  });

  describe('Health Flask Feedback (Full HP, Injured & Empty)', () => {
    it('emits flaskEmpty(reason:"fullHp") without wasting charges when pressed at full HP', () => {
      const state = createAbilitiesSandbox(6001);
      state.player.maxFlaskCharges = 2;
      state.player.flaskCharges = 2;
      state.player.hp = state.player.maxHp;

      stepSim(state, inputOf({ healPressed: true }));

      expect(state.player.flaskCharges).toBe(2);
      expect(state.events.some((e) => e.type === 'flaskEmpty' && e.reason === 'fullHp')).toBe(true);
    });

    it('emits flaskEmpty(reason:"empty") when injured with 0 flask charges', () => {
      const state = createAbilitiesSandbox(6002);
      state.player.flaskCharges = 0;
      state.player.hp = 40;

      stepSim(state, inputOf({ healPressed: true }));

      expect(state.player.hp).toBe(40);
      expect(state.events.some((e) => e.type === 'flaskEmpty' && e.reason === 'empty')).toBe(true);
    });

    it('heals ~60% max HP and emits flaskDrink when injured with charges available', () => {
      const state = createAbilitiesSandbox(6003);
      state.player.flaskCharges = 1;
      state.player.hp = 20;

      stepSim(state, inputOf({ healPressed: true }));

      expect(state.player.flaskCharges).toBe(0);
      expect(state.player.hp).toBe(80);
      expect(state.events.some((e) => e.type === 'flaskDrink' && e.healed === 60)).toBe(true);
    });
  });

  describe('Mouse Aiming (aimX / aimY) for Ranged Weapons & Grenades', () => {
    it('steers bow shots left and upward when mouse aimX/aimY points left or up-right', () => {
      // Aim left while initially facing right
      const sLeft = createAbilitiesSandbox(7001);
      sLeft.player.loadout.weapon1 = makeGear(sLeft, 'CloseCombatBow', 'weapon');
      sLeft.player.facing = 1;
      for (let t = 0; t < 14 && sLeft.projectiles.length === 0; t++) {
        stepSim(
          sLeft,
          inputOf({
            weapon1Pressed: t === 0,
            aimX: sLeft.player.pos.x - 140,
            aimY: sLeft.player.pos.y,
          })
        );
      }
      expect(sLeft.projectiles.length).toBeGreaterThanOrEqual(1);
      expect(sLeft.projectiles[0]!.vel.x).toBeLessThan(-150);

      // Aim 45deg up-right
      const sUp = createAbilitiesSandbox(7002);
      sUp.player.loadout.weapon1 = makeGear(sUp, 'CloseCombatBow', 'weapon');
      for (let t = 0; t < 14 && sUp.projectiles.length === 0; t++) {
        stepSim(
          sUp,
          inputOf({
            weapon1Pressed: t === 0,
            aimX: sUp.player.pos.x + 100,
            aimY: sUp.player.pos.y - 100,
          })
        );
      }
      expect(sUp.projectiles.length).toBeGreaterThanOrEqual(1);
      expect(sUp.projectiles[0]!.vel.x).toBeGreaterThan(100);
      expect(sUp.projectiles[0]!.vel.y).toBeLessThan(-100);
    });

    it('flips grenade throw left and scales throw speed with mouse aim distance', () => {
      const sLeft = createAbilitiesSandbox(7003);
      sLeft.player.facing = 1;
      stepSim(
        sLeft,
        inputOf({
          skill1Pressed: true,
          aimX: sLeft.player.pos.x - 150,
          aimY: sLeft.player.pos.y,
        })
      );
      const gLeft = sLeft.projectiles.find((p) => p.kind === 'grenade');
      expect(gLeft).toBeDefined();
      expect(gLeft!.vel.x).toBeLessThan(-80);

      const sNear = createAbilitiesSandbox(7004);
      stepSim(sNear, inputOf({ skill1Pressed: true, aimX: sNear.player.pos.x + 65, aimY: sNear.player.pos.y }));
      const sFar = createAbilitiesSandbox(7004);
      stepSim(sFar, inputOf({ skill1Pressed: true, aimX: sFar.player.pos.x + 260, aimY: sFar.player.pos.y }));
      const gNear = sNear.projectiles.find((p) => p.kind === 'grenade');
      const gFar = sFar.projectiles.find((p) => p.kind === 'grenade');
      expect(gNear).toBeDefined();
      expect(gFar).toBeDefined();
      expect(gFar!.vel.x).toBeGreaterThan(gNear!.vel.x + 20);
    });
  });
});
