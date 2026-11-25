import { describe, expect, it } from 'vitest';
import {
  PLAYER_HEIGHT,
  SCROLL_DAMAGE_BASE,
  TILE_SIZE,
  TileKind,
  createEmptyInputFrame,
  type GearInstance,
  type InputFrame,
  type ProjectileState,
  type SimState,
  type TileGrid,
} from '../src/contracts';
import { BOSS_MAP } from '../src/data';
import { spawnBoss } from '../src/sim/bosses';
import { collisionApi } from '../src/sim/collision';
import { attemptShieldParry, damageEnemy, damagePlayer } from '../src/sim/combat';
import { spawnEnemy } from '../src/sim/enemies';
import { createRng } from '../src/sim/prng';
import {
  applyScrollPickup,
  computeGearDamage,
  computePlayerMaxHp,
  getScrollDamageMultiplier,
} from '../src/sim/roguelite';
import {
  applyStatus,
  computeSynergyMultiplier,
  hasStatus,
  tickEntityStatuses,
} from '../src/sim/status';
import { createInitialSimState, stepSim } from '../src/sim/step';

function createArenaGrid(width = 36, height = 18, floorTy = 14): TileGrid {
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

function createCombatSandbox(seed = 10101): SimState {
  const state = createInitialSimState(seed, 0);
  const floorTy = 14;
  state.tileGrid = createArenaGrid(36, 18, floorTy);
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
  state.player.pos = { x: 10 * TILE_SIZE, y: floorY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.iframeTicks = 0;
  state.player.parryCooldownTicks = 0;
  state.player.rollCooldownTicks = 0;
  return state;
}

function makeGear(
  defId: string,
  slotKind: 'weapon' | 'skill',
  overrides: Partial<GearInstance> = {}
): GearInstance {
  return {
    uid: 9000 + Math.floor(Math.random() * 100),
    defId,
    slotKind,
    level: 1,
    quality: 'base',
    color: 'brutality',
    affixes: [],
    cooldownTicks: 0,
    ...overrides,
  };
}

function inputOf(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...createEmptyInputFrame(), ...overrides };
}

describe('Combat, Parry, Rally, Scrolls, Synergies, Curse & Bosses', () => {
  describe('Instant Defensive Cancel (Roll & Shield Parry during Windup AND Recovery)', () => {
    it('instantly cancels heavy weapon windup and recovery with Dodge Roll', () => {
      const state = createCombatSandbox();
      state.player.loadout.weapon1 = makeGear('BroadSword', 'weapon', { color: 'survival' });

      // Start BroadSword attack -> enters 13-tick windup
      stepSim(state, inputOf({ weapon1Pressed: true }));
      expect(state.player.attackPhase).toBe('windup');
      expect(state.player.actionState).toBe('attack');

      // Cancel mid-windup with rollPressed
      stepSim(state, inputOf({ rollPressed: true }));
      expect(state.player.actionState).toBe('roll');
      expect(state.player.attackPhase).toBe('none');

      // Let roll & cooldown complete
      for (let t = 0; t < 40; t++) stepSim(state, inputOf());

      // Start BroadSword attack again and advance into recovery phase
      stepSim(state, inputOf({ weapon1Pressed: true }));
      let enteredRecovery = false;
      for (let t = 0; t < 25; t++) {
        stepSim(state, inputOf());
        if (state.player.attackPhase === 'recovery') {
          enteredRecovery = true;
          break;
        }
      }
      expect(enteredRecovery).toBe(true);

      // Cancel mid-recovery with rollPressed
      stepSim(state, inputOf({ rollPressed: true }));
      expect(state.player.actionState).toBe('roll');
      expect(state.player.attackPhase).toBe('none');
    });

    it('instantly cancels heavy weapon windup and recovery with Shield Parry', () => {
      const state = createCombatSandbox();
      state.player.loadout.weapon1 = makeGear('BroadSword', 'weapon', { color: 'survival' });
      state.player.loadout.weapon2 = makeGear('StartShield', 'weapon', { color: 'survival' });

      // Start BroadSword windup
      stepSim(state, inputOf({ weapon1Pressed: true }));
      expect(state.player.attackPhase).toBe('windup');

      // Cancel windup immediately with Shield Parry (weapon2Pressed)
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(state.player.actionState).toBe('parry');
      expect(state.player.attackPhase).toBe('none');
      expect(state.player.parryWindowTicks).toBeGreaterThan(0);

      // Wait out parry window + cooldown
      for (let t = 0; t < 35; t++) stepSim(state, inputOf());

      // Start BroadSword and advance into recovery
      stepSim(state, inputOf({ weapon1Pressed: true }));
      for (let t = 0; t < 25 && state.player.attackPhase !== 'recovery'; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.attackPhase).toBe('recovery');

      // Cancel recovery immediately with Shield Parry
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(state.player.actionState).toBe('parry');
      expect(state.player.attackPhase).toBe('none');
    });
  });

  describe('Shield Parry Window, Reflection, Hitstop, Passives & Cooldown Reset', () => {
    it('maintains a 16-tick active parry window before emitting parryFail if unhit', () => {
      const state = createCombatSandbox();
      state.player.loadout.weapon2 = makeGear('StartShield', 'weapon', { color: 'survival' });

      // Press shield -> tick 1 starts window (16 -> 15)
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(state.player.actionState).toBe('parry');
      expect(state.player.parryWindowTicks).toBe(15);

      let activeTicks = 1;
      let sawFail = false;
      for (let t = 2; t <= 20; t++) {
        stepSim(state, inputOf());
        if (state.events.some((e) => e.type === 'parryFail')) {
          sawFail = true;
          activeTicks = t;
          break;
        }
      }
      expect(sawFail).toBe(true);
      expect(activeTicks).toBe(16);
      expect(state.player.parryWindowTicks).toBe(0);
    });

    it('negates 100% damage, adds 6-tick hitstop, stuns melee attacker 75 ticks, and resets parryCooldownTicks = 0', () => {
      const state = createCombatSandbox();
      const rng = createRng(111);
      state.player.loadout.weapon2 = makeGear('StartShield', 'weapon', { color: 'survival' });
      const startHp = state.player.hp;
      const attacker = spawnEnemy(
        state,
        'Zombie',
        state.player.pos.x + 24,
        state.player.pos.y,
        0,
        rng
      );
      const attackerStartHp = attacker.hp;

      // Activate shield parry
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(state.player.parryCooldownTicks).toBeGreaterThan(0);

      // Melee attack strikes active parry window
      const parried = attemptShieldParry(state, 35, attacker, null, rng);
      expect(parried).toBe(true);
      expect(state.player.hp).toBe(startHp); // 100% damage negation
      expect(state.hitstopTicks).toBeGreaterThanOrEqual(6);
      expect(state.player.parryCooldownTicks).toBe(0); // Instant cooldown reset!
      expect(attacker.stunTicks).toBeGreaterThanOrEqual(75);
      expect(attacker.state).toBe('stunned');
      expect(attacker.hp).toBeLessThan(attackerStartHp);
      expect(state.events.some((e) => e.type === 'parrySuccess' && !e.reflected)).toBe(true);
    });

    it('reflects parriable projectiles at >=2.2x damage as guaranteed Crits and resets cooldown', () => {
      const state = createCombatSandbox();
      const rng = createRng(222);
      state.player.loadout.weapon2 = makeGear('StartShield', 'weapon', { color: 'survival' });

      const proj: ProjectileState = {
        uid: state.nextUid++,
        owner: 'enemy',
        ownerUid: 99,
        kind: 'enemyBolt',
        pos: { x: state.player.pos.x + 12, y: state.player.pos.y },
        prevPos: { x: state.player.pos.x + 20, y: state.player.pos.y },
        vel: { x: -300, y: 0 },
        radius: 5,
        damage: 50,
        isCrit: false,
        pierceLeft: 0,
        gravity: 0,
        ttlTicks: 50,
        maxTtlTicks: 50,
        color: '#ffd166',
        parriable: true,
        hitIds: [],
      };
      state.projectiles.push(proj);

      // Press shield parry -> immediate reflection on overlapping parriable projectile
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(proj.owner).toBe('player');
      expect(proj.isCrit).toBe(true);
      expect(proj.vel.x).toBeGreaterThan(0);
      expect(proj.damage).toBeGreaterThanOrEqual(Math.round(50 * 2.2));
      expect(state.player.parryCooldownTicks).toBe(0);
      expect(state.hitstopTicks).toBeGreaterThanOrEqual(6);
      expect(state.events.some((e) => e.type === 'parrySuccess' && e.reflected)).toBe(true);
      void rng;
    });

    it('triggers shield passives cleanly: StunShield (165t stun), BleedShield (AoE bleed), ForceShield (forcefield)', () => {
      const rng = createRng(333);

      // 1. StunShield (Cudgel) -> extended 165-tick stun
      const s1 = createCombatSandbox();
      s1.player.loadout.weapon2 = makeGear('StunShield', 'weapon', { color: 'survival' });
      const e1 = spawnEnemy(s1, 'Zombie', s1.player.pos.x + 24, s1.player.pos.y, 0, rng);
      stepSim(s1, inputOf({ weapon2Pressed: true }));
      expect(attemptShieldParry(s1, 30, e1, null, rng)).toBe(true);
      expect(e1.stunTicks).toBe(165);

      // 2. BleedShield (Bloodthirsty Shield) -> bleeds all enemies within 110px
      const s2 = createCombatSandbox();
      s2.player.loadout.weapon2 = makeGear('BleedShield', 'weapon', { color: 'brutality' });
      const e2a = spawnEnemy(s2, 'Zombie', s2.player.pos.x + 24, s2.player.pos.y, 0, rng);
      const e2b = spawnEnemy(s2, 'Archer', s2.player.pos.x + 85, s2.player.pos.y, 0, rng);
      stepSim(s2, inputOf({ weapon2Pressed: true }));
      expect(attemptShieldParry(s2, 30, e2a, null, rng)).toBe(true);
      expect(hasStatus(e2a.statusEffects, 'bleed')).toBe(true);
      expect(hasStatus(e2b.statusEffects, 'bleed')).toBe(true);

      // 3. ForceShield (Rampart) -> grants player 'shield' forcefield status that negates subsequent damage
      const s3 = createCombatSandbox();
      s3.player.loadout.weapon2 = makeGear('ForceShield', 'weapon', { color: 'survival' });
      const e3 = spawnEnemy(s3, 'Zombie', s3.player.pos.x + 24, s3.player.pos.y, 0, rng);
      stepSim(s3, inputOf({ weapon2Pressed: true }));
      expect(attemptShieldParry(s3, 30, e3, null, rng)).toBe(true);
      expect(hasStatus(s3.player.statusEffects, 'shield')).toBe(true);

      // Even with iframeTicks cleared, Rampart forcefield blocks incoming damage
      s3.player.iframeTicks = 0;
      const hpBefore = s3.player.hp;
      expect(damagePlayer(s3, 50, 'BlockedByForcefield', rng, true)).toBe(false);
      expect(s3.player.hp).toBe(hpBefore);
    });
  });

  describe('Rally Orange Health Recovery', () => {
    it('adds 100% lost HP to rallyHp, holds 60 ticks, drains linearly, and recovers up to 75% of weapon hit damage', () => {
      const state = createCombatSandbox();
      const rng = createRng(444);
      // Give player a higher HP pool so numbers are unambiguous
      applyScrollPickup(state, 'survival');
      applyScrollPickup(state, 'survival');
      const maxHp = state.player.maxHp;

      expect(damagePlayer(state, 80, 'TestMob', rng)).toBe(true);
      expect(state.player.hp).toBe(maxHp - 80);
      expect(state.player.rallyHp).toBe(80);
      expect(state.player.rallyHoldTicks).toBe(60);

      // Hold for 50 ticks -> rallyHp must NOT drain during the 60-tick hold window
      for (let t = 0; t < 50; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.rallyHp).toBe(80);
      expect(state.player.rallyHoldTicks).toBe(10);

      // Deal 40 weapon damage -> recovers min(rallyHp, round(40 * 0.75)) = 30 HP!
      const dummy = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 30, state.player.pos.y, 0, rng);
      const hpBeforeHit = state.player.hp;
      damageEnemy(state, dummy, 40, false, 15, 0, 0, rng, 'StartSword');
      expect(state.player.hp).toBe(hpBeforeHit + 30);
      expect(state.player.rallyHp).toBe(50);
      expect(state.events.some((e) => e.type === 'rallyRecovered' && e.amount === 30)).toBe(true);

      // Remove dummy so it doesn't deal fresh damage while observing rally drain
      state.enemies = [];

      // Finish remaining hold ticks + drain ticks -> rallyHp drains down toward 0
      for (let t = 0; t < 35; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.rallyHp).toBeLessThan(50);

      for (let t = 0; t < 260; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.rallyHp).toBe(0);
    });
  });

  describe('3-Color Scroll Scaling, Colorless/Legendary Scaling & Diminishing Max HP', () => {
    it('scales damage by exact 1.15^(stat - 1) and scales colorless/Legendary items with highest stat', () => {
      const scrolls = { brutality: 9, tactics: 3, survival: 5 };

      expect(SCROLL_DAMAGE_BASE).toBe(1.15);
      expect(getScrollDamageMultiplier(scrolls, 'brutality')).toBeCloseTo(Math.pow(1.15, 8), 8);
      expect(getScrollDamageMultiplier(scrolls, 'tactics')).toBeCloseTo(Math.pow(1.15, 2), 8);
      expect(getScrollDamageMultiplier(scrolls, 'survival')).toBeCloseTo(Math.pow(1.15, 4), 8);
      expect(getScrollDamageMultiplier(scrolls, 'colorless')).toBeCloseTo(Math.pow(1.15, 8), 8);

      const tacticalBase = makeGear('FastBow', 'weapon', {
        color: 'tactics',
        level: 1,
        quality: 'base',
      });
      const legendaryWeapon = makeGear('FastBow', 'weapon', {
        color: 'colorless',
        level: 1,
        quality: 'L',
      });

      const baseDmg = computeGearDamage(100, tacticalBase, scrolls);
      const legDmg = computeGearDamage(100, legendaryWeapon, scrolls);
      // Base: 100 * 1.07^0 * 1.15^2 = 132
      expect(baseDmg).toBe(Math.round(100 * Math.pow(1.15, 2)));
      // Legendary: effectiveLevel = 1 + 6 = 7 -> 100 * 1.07^6 * 1.15^8 (uses max stat = 9!)
      expect(legDmg).toBe(Math.round(100 * Math.pow(1.07, 6) * Math.pow(1.15, 8)));
    });

    it('applies diminishing max HP returns per scroll color with Survival > Brutality > Tactics', () => {
      const baseHp = computePlayerMaxHp({ brutality: 1, tactics: 1, survival: 1 });
      expect(baseHp).toBe(100);

      const b2 = computePlayerMaxHp({ brutality: 2, tactics: 1, survival: 1 });
      const t2 = computePlayerMaxHp({ brutality: 1, tactics: 2, survival: 1 });
      const s2 = computePlayerMaxHp({ brutality: 1, tactics: 1, survival: 2 });

      // First scroll bonuses: Survival (+80%) > Brutality (+65%) > Tactics (+50%)
      expect(s2).toBe(180);
      expect(b2).toBe(165);
      expect(t2).toBe(150);

      // Verify percentage gain diminishes strictly at higher scroll counts
      const s10 = computePlayerMaxHp({ brutality: 1, tactics: 1, survival: 10 });
      const s11 = computePlayerMaxHp({ brutality: 1, tactics: 1, survival: 11 });
      const earlyPct = (s2 - baseHp) / baseHp;
      const latePct = (s11 - s10) / s10;
      expect(latePct).toBeLessThan(earlyPct);
      expect(latePct).toBeGreaterThan(0.08);
    });
  });

  describe('Status Synergies, Affix Multipliers & Critical Hits', () => {
    it('evaluates Oil+Burn 2x DoT bonus, Freeze->Slow thaw, Root +40% dmg, and exact affix synergy multipliers', () => {
      // 1. Oil + Burn doubles Burn DoT damage
      const burnOnly = [{ kind: 'burn' as const, ticksLeft: 31, stacks: 1, dps: 40, sourceId: 0 }];
      const oilBurn = [
        { kind: 'burn' as const, ticksLeft: 31, stacks: 1, dps: 40, sourceId: 0 },
        { kind: 'oil' as const, ticksLeft: 100, stacks: 1, dps: 0, sourceId: 0 },
      ];
      let burnDmg = 0;
      let oilBurnDmg = 0;
      tickEntityStatuses(burnOnly, (_k, amt) => {
        burnDmg += amt;
      });
      tickEntityStatuses(oilBurn, (_k, amt) => {
        oilBurnDmg += amt;
      });
      expect(burnDmg).toBe(10);
      expect(oilBurnDmg).toBe(20);

      // 2. Affix multipliers: +60% Bleed, +80% Poison, +100% Burning Oil
      const effects: Parameters<typeof applyStatus>[0] = [];
      applyStatus(effects, 'bleed', 120, 20, 0);
      expect(computeSynergyMultiplier(['bonus_bleed'], effects)).toBeCloseTo(1.6, 5);

      applyStatus(effects, 'poison', 120, 20, 0);
      expect(computeSynergyMultiplier(['bonus_poison'], effects)).toBeCloseTo(1.8, 5);

      applyStatus(effects, 'oil', 120, 0, 0);
      applyStatus(effects, 'burn', 120, 20, 0);
      expect(computeSynergyMultiplier(['bonus_burning_oil'], effects)).toBeCloseTo(2.0, 5);

      // Combined affixes stack multiplicatively
      expect(computeSynergyMultiplier(['bonus_bleed', 'bonus_poison'], effects)).toBeCloseTo(
        1.6 * 1.8,
        5
      );

      // 3. Freeze expires into Slow
      const freezeEffects: Parameters<typeof applyStatus>[0] = [];
      applyStatus(freezeEffects, 'freeze', 2, 0, 0);
      tickEntityStatuses(freezeEffects, () => {});
      tickEntityStatuses(freezeEffects, () => {});
      expect(hasStatus(freezeEffects, 'freeze')).toBe(false);
      expect(hasStatus(freezeEffects, 'slow')).toBe(true);

      // 4. Root bonus (+40% damage) and BackStabber backstab Crit
      const state = createCombatSandbox();
      const rng = createRng(515);
      const mob = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 18, state.player.pos.y, 0, rng);
      mob.facing = 1; // Facing away from player on its left -> backstab!
      mob.stunTicks = 20; // Prevent enemy AI from turning around during 4-tick weapon windup
      mob.state = 'stunned';
      state.player.facing = 1;
      state.player.loadout.weapon1 = makeGear('BackStabber', 'weapon', {
        color: 'brutality',
        affixes: ['bonus_bleed'],
      });
      applyStatus(mob.statusEffects, 'bleed', 180, 20, 0);
      applyStatus(mob.statusEffects, 'root', 180, 0, 0);

      let sawCrit = false;
      const hpBefore = mob.hp;
      for (let t = 0; t < 12; t++) {
        stepSim(state, inputOf({ weapon1Pressed: t === 0 }));
        if (state.events.some((e) => e.type === 'critImpact')) {
          sawCrit = true;
          break;
        }
      }
      expect(sawCrit).toBe(true);
      // 30 * 2.45 (crit) * 1.6 (bleed affix) * 1.4 (root) = 165!
      expect(hpBefore - mob.hp).toBeGreaterThanOrEqual(150);
    });
  });

  describe('Cursed Chest 10-Kill Curse', () => {
    it('kills player instantly on 1 unparried hit while cursed, and lifts curse after 10 kills', () => {
      // Part A: 1 unparried hit while cursed = instant death regardless of HP
      const cursedDeathState = createCombatSandbox(701);
      const rng1 = createRng(701);
      for (let i = 0; i < 6; i++) applyScrollPickup(cursedDeathState, 'survival');
      expect(cursedDeathState.player.hp).toBeGreaterThan(500);

      cursedDeathState.chests.push({
        uid: cursedDeathState.nextUid++,
        pos: { x: cursedDeathState.player.pos.x + 12, y: cursedDeathState.player.pos.y },
        kind: 'cursed',
        opened: false,
        roomId: 0,
      });

      stepSim(cursedDeathState, inputOf({ interactPressed: true }));
      expect(cursedDeathState.player.curseKillsLeft).toBe(10);
      expect(cursedDeathState.events.some((e) => e.type === 'curseTriggered' && e.killsRequired === 10)).toBe(true);

      // Single 5-damage unparried hit kills immediately
      expect(damagePlayer(cursedDeathState, 5, 'BatKamikaze', rng1)).toBe(true);
      expect(cursedDeathState.player.hp).toBe(0);
      expect(cursedDeathState.runStatus).toBe('dead');
      expect(cursedDeathState.lastDamageSource).toContain('Curse');

      // Part B: Killing 10 enemies lifts the curse and emits curseCleared
      const liftState = createCombatSandbox(702);
      const rng2 = createRng(702);
      liftState.chests.push({
        uid: liftState.nextUid++,
        pos: { x: liftState.player.pos.x + 10, y: liftState.player.pos.y },
        kind: 'cursed',
        opened: false,
        roomId: 0,
      });
      stepSim(liftState, inputOf({ interactPressed: true }));
      expect(liftState.player.curseKillsLeft).toBe(10);

      let clearedEmitted = false;
      for (let k = 0; k < 10; k++) {
        liftState.events = [];
        const foe = spawnEnemy(liftState, 'BatKamikaze', liftState.player.pos.x + 24, liftState.player.pos.y, 0, rng2);
        damageEnemy(liftState, foe, 999, false, 10, 0, 0, rng2, 'StartSword');
        if (liftState.events.some((e) => e.type === 'curseCleared')) {
          clearedEmitted = true;
        }
      }

      expect(liftState.player.curseKillsLeft).toBe(0);
      expect(clearedEmitted).toBe(true);

      // Taking damage after curse is lifted does NOT instakill
      liftState.player.iframeTicks = 0;
      const hpBefore = liftState.player.hp;
      damagePlayer(liftState, 10, 'Zombie', rng2);
      expect(liftState.player.hp).toBe(hpBefore - 10);
      expect(liftState.runStatus).toBe('playing');
    });
  });

  describe('All 3 Multi-Phase Bosses (Oracle HPs & Phase Shifts)', () => {
    it.each([
      { bossId: 'Behemoth' as const, oracleHp: 4000 },
      { bossId: 'TimeKeeper' as const, oracleHp: 2500 },
      { bossId: 'KingsHand' as const, oracleHp: 5900 },
    ])(
      'spawns $bossId with exact oracle HP ($oracleHp) and cleanly transitions Phase 1 -> 2 -> 3',
      ({ bossId, oracleHp }) => {
        const state = createCombatSandbox(900);
        const def = BOSS_MAP[bossId];
        expect(def.baseHp).toBe(oracleHp);

        const floorY = 14 * TILE_SIZE;
        const boss = spawnBoss(state, bossId, 24 * TILE_SIZE, floorY - def.height * 0.5);
        expect(boss.maxHp).toBe(oracleHp);
        expect(boss.hp).toBe(oracleHp);
        expect(boss.bossPhase).toBe(1);

        // Drop HP past Phase 2 threshold (e.g. 55% HP) and step sim
        boss.hp = Math.round(oracleHp * 0.55);
        stepSim(state, inputOf());
        expect(boss.bossPhase).toBe(2);
        expect(
          state.events.some(
            (e) => e.type === 'bossPhaseShift' && e.bossId === bossId && e.phase === 2
          )
        ).toBe(true);

        // Clear any transition shield and drop HP past Phase 3 threshold (e.g. 25% HP)
        boss.bossShieldTicks = 0;
        boss.hp = Math.round(oracleHp * 0.25);
        stepSim(state, inputOf());
        expect(boss.bossPhase).toBe(3);
        expect(
          state.events.some(
            (e) => e.type === 'bossPhaseShift' && e.bossId === bossId && e.phase === 3
          )
        ).toBe(true);
      }
    );
  });
});
