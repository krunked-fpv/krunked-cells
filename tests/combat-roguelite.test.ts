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
  rollAffixes,
} from '../src/sim/roguelite';
import { enterPassageRoom, handlePassageCommand } from '../src/sim/passage';
import { applyEnemyStatus } from '../src/sim/combat';
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

  describe('Rally Orange Health Recovery (Oracle Formula)', () => {
    it('adds 80% lost HP to rallyHp, holds 36 ticks, drains at 30% maxHp/s, and recovers 12% hit capped at 20% lost anchor on weapons/parries only', () => {
      const state = createCombatSandbox();
      const rng = createRng(444);
      // Give player a higher HP pool so numbers are unambiguous
      applyScrollPickup(state, 'survival');
      applyScrollPickup(state, 'survival');
      const maxHp = state.player.maxHp;

      expect(damagePlayer(state, 80, 'TestMob', rng)).toBe(true);
      expect(state.player.hp).toBe(maxHp - 80);
      expect(state.player.rallyHp).toBe(64); // 80% of 80 lost
      expect(state.player.rallyLostAnchor).toBe(64);
      expect(state.player.rallyHoldTicks).toBe(36);
      expect(state.player.onHitShieldTicks).toBe(30); // Carrying StartShield triggers 30t post-hit shield

      // Hold for 30 ticks -> rallyHp must NOT drain during 36t hold; onHitShieldTicks expires
      for (let t = 0; t < 30; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.rallyHp).toBe(64);
      expect(state.player.rallyHoldTicks).toBe(6);
      expect(state.player.onHitShieldTicks).toBe(0);

      const dummy = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 30, state.player.pos.y, 0, rng);
      const hpBeforeSkill = state.player.hp;
      // Skills do NOT recover Rally HP!
      damageEnemy(state, dummy, 100, false, 15, 0, 0, rng, 'skill');
      expect(state.player.hp).toBe(hpBeforeSkill);
      expect(state.player.rallyHp).toBe(64);

      // Direct weapon hit for 200 dmg -> 12% (24) capped at 20% of rallyLostAnchor (round(64 * 0.2) = 13)!
      const hpBeforeHit = state.player.hp;
      damageEnemy(state, dummy, 200, false, 15, 0, 0, rng, 'StartSword');
      expect(state.player.hp).toBe(hpBeforeHit + 13);
      expect(state.player.rallyHp).toBe(51);
      expect(state.events.some((e) => e.type === 'rallyRecovered' && e.amount === 13)).toBe(true);

      // Remove dummy so it doesn't deal fresh damage while observing rally drain
      state.enemies = [];

      // Finish remaining hold ticks + drain ticks -> rallyHp drains down toward 0
      for (let t = 0; t < 35; t++) {
        stepSim(state, inputOf());
      }
      expect(state.player.rallyHp).toBeLessThan(51);

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

  describe('Dead Cells Mechanics Parity Regressions', () => {
    it('enforces 15% single-hit boss damage cap, immediate Freeze Shatter into Slow, and Boss CC diminishing returns', () => {
      const state = createCombatSandbox(1101);
      const rng = createRng(1101);
      const floorY = 14 * TILE_SIZE;
      const boss = spawnBoss(state, 'Behemoth', 20 * TILE_SIZE, floorY - 26);

      // 15% single-hit cap: 5000 raw dmg on 4000 HP Concierge caps at 600!
      damageEnemy(state, boss, 5000, true, 50, 0, 0, rng, 'BroadSword');
      expect(boss.hp).toBe(4000 - 600);

      // Boss CC diminishing returns: 1st freeze = 55%, 2nd = 28%, 3rd = 12%, 4th = immune (0)
      expect(applyEnemyStatus(state, boss, 'freeze', 100, 0, rng)).toBe(true);
      expect(hasStatus(boss.statusEffects, 'freeze')).toBe(true);
      expect(boss.statusEffects.find((s) => s.kind === 'freeze')?.ticksLeft).toBe(55);

      // Hitting frozen enemy shatters freeze into slow (75t) + emits freezeShatter + adds +15% pop!
      state.events = [];
      const hpBeforeShatter = boss.hp;
      damageEnemy(state, boss, 100, false, 10, 0, 0, rng, 'StartSword');
      expect(hasStatus(boss.statusEffects, 'freeze')).toBe(false);
      expect(hasStatus(boss.statusEffects, 'slow')).toBe(true);
      expect(state.events.some((e) => e.type === 'freezeShatter')).toBe(true);
      expect(hpBeforeShatter - boss.hp).toBe(115);

      // Next 2 CCs diminish and 4th within 360t is immune!
      expect(applyEnemyStatus(state, boss, 'root', 100, 0, rng)).toBe(true);
      expect(applyEnemyStatus(state, boss, 'stun', 100, 0, rng)).toBe(true);
      expect(applyEnemyStatus(state, boss, 'freeze', 100, 0, rng)).toBe(false);
    });

    it('detonates 5-stack Bleed Hemorrhage Burst immediately and clears stacks', () => {
      const state = createCombatSandbox(1102);
      const rng = createRng(1102);
      const foe = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 30, state.player.pos.y, 0, rng);
      const hpBefore = foe.hp;

      for (let i = 0; i < 4; i++) {
        applyEnemyStatus(state, foe, 'bleed', 240, 30, rng);
      }
      expect(hasStatus(foe.statusEffects, 'bleed')).toBe(true);
      expect(state.events.some((e) => e.type === 'bleedBurst')).toBe(false);

      // 5th stack triggers immediate Hemorrhage Burst!
      applyEnemyStatus(state, foe, 'bleed', 240, 30, rng);
      expect(state.events.some((e) => e.type === 'bleedBurst' && e.damage > 0)).toBe(true);
      expect(hasStatus(foe.statusEffects, 'bleed')).toBe(false);
      expect(foe.hp).toBeLessThan(hpBefore);
    });

    it('lets Inquisitor (Mage360) bolts pierce solid walls and Worm 6 death-eggs bounce & rest pulsing on floor', () => {
      const state = createCombatSandbox(1103);
      const rng = createRng(1103);
      // Place a solid wall pillar between x=14 and x=16
      for (let ty = 8; ty <= 13; ty++) {
        collisionApi.setTile(state.tileGrid, 15, ty, TileKind.SOLID);
      }
      // Spawn Inquisitor bolt on right side flying left through the solid wall
      state.projectiles.push({
        uid: state.nextUid++,
        owner: 'enemy',
        ownerUid: 777,
        kind: 'enemyBolt',
        pos: { x: 16 * TILE_SIZE + 8, y: 12 * TILE_SIZE },
        prevPos: { x: 16 * TILE_SIZE + 8, y: 12 * TILE_SIZE },
        vel: { x: -240, y: 0 },
        radius: 5,
        damage: 15,
        isCrit: false,
        pierceLeft: 0,
        gravity: 0,
        ttlTicks: 50,
        maxTtlTicks: 50,
        color: '#d966ff',
        parriable: true,
        piercesWalls: true,
        hitIds: [],
      });
      for (let t = 0; t < 15; t++) stepSim(state, inputOf());
      const bolt = state.projectiles.find((p) => p.ownerUid === 777);
      expect(bolt).toBeDefined();
      expect(bolt!.pos.x).toBeLessThan(15 * TILE_SIZE);

      // Worm death spawns 6 bouncing/resting fuse eggs that survive floor contact!
      const worm = spawnEnemy(state, 'Worm', 20 * TILE_SIZE, 14 * TILE_SIZE - 9, 0, rng);
      damageEnemy(state, worm, 9999, false, 50, 0, 0, rng, 'StartSword');
      const eggs = state.projectiles.filter((p) => p.ownerUid === worm.uid && p.kind === 'grenade');
      expect(eggs.length).toBe(6);
      expect(eggs.every((e) => (e.bouncesLeft ?? 0) >= 1 && (e.floorFuseTicks ?? 0) > 0 && e.parriable)).toBe(true);

      // After 35 ticks (past first floor touch!), eggs are still alive & pulsing (not instant-detonated!)
      for (let t = 0; t < 35; t++) stepSim(state, inputOf());
      const survivingEggs = state.projectiles.filter((p) => p.ownerUid === worm.uid);
      expect(survivingEggs.length).toBeGreaterThan(0);

      // Grounded Worm death-eggs remain parriable, and unparried eggs detonate after floor fuse!
      const eggToParry = survivingEggs[0]!;
      state.player.loadout.weapon2 = makeGear('StartShield', 'weapon', { color: 'survival' });
      eggToParry.pos.x = state.player.pos.x + 10;
      eggToParry.pos.y = state.player.pos.y;
      stepSim(state, inputOf({ weapon2Pressed: true }));
      expect(eggToParry.owner).toBe('player');

      let sawEggExplosion = false;
      for (let t = 0; t < 160; t++) {
        stepSim(state, inputOf());
        if (state.events.some((e) => e.type === 'explosion')) {
          sawEggExplosion = true;
        }
      }
      expect(sawEggExplosion).toBe(true);
      expect(state.projectiles.filter((p) => p.ownerUid === worm.uid).length).toBe(0);
    });

    it('lodges Quick Bow arrows for stuckArrows3 crits, returns ammo on kill, and triggers Pyrotechnics oiled-only crit + Electric Whip water crit + Phaser next-melee bonus', () => {
      const state = createCombatSandbox(1104);
      const rng = createRng(1104);

      // 1. Quick Bow stuckArrows3 crit + ammo return on enemy kill
      state.player.loadout.weapon1 = makeGear('FastBow', 'weapon', {
        color: 'tactics',
        ammo: 12,
        maxAmmo: 12,
      });
      const dummy = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 80, state.player.pos.y, 0, rng);
      dummy.attackCooldownTicks = 9999;
      let sawQuickCrit = false;
      for (let shot = 0; shot < 4; shot++) {
        for (let t = 0; t < 16; t++) {
          stepSim(state, inputOf({ weapon1Pressed: t === 0 }));
          if (state.events.some((e) => e.type === 'critImpact' && e.weaponId === 'FastBow')) {
            sawQuickCrit = true;
          }
        }
      }
      expect(sawQuickCrit).toBe(true);
      expect((dummy.stuckArrows?.length ?? 0)).toBeGreaterThanOrEqual(3);
      const ammoBeforeKill = state.player.loadout.weapon1!.ammo!;
      damageEnemy(state, dummy, 9999, false, 50, 0, 0, rng, 'StartSword');
      expect(state.player.loadout.weapon1!.ammo!).toBeGreaterThan(ammoBeforeKill);

      // 2. Electric Whip instant hitscan chain lightning + guaranteed WATER crit + lightningArc!
      const sWhip = createCombatSandbox(1105);
      const rngW = createRng(1105);
      sWhip.player.loadout.weapon1 = makeGear('Whip', 'weapon', { color: 'tactics' });
      const wetTx = 13;
      collisionApi.setTile(sWhip.tileGrid, wetTx, 13, TileKind.WATER);
      const wetFoe = spawnEnemy(sWhip, 'Zombie', wetTx * TILE_SIZE + 12, 13 * TILE_SIZE + 10, 0, rngW);
      const chainFoe = spawnEnemy(sWhip, 'Zombie', (wetTx + 2) * TILE_SIZE, 13 * TILE_SIZE + 10, 0, rngW);
      const chainHpBefore = chainFoe.hp;
      let sawArc = false;
      let sawWaterCrit = false;
      for (let t = 0; t < 10; t++) {
        stepSim(sWhip, inputOf({ weapon1Pressed: t === 0 }));
        if (sWhip.events.some((e) => e.type === 'lightningArc')) sawArc = true;
        if (sWhip.events.some((e) => e.type === 'critImpact' && e.weaponId === 'Whip')) sawWaterCrit = true;
      }
      expect(sawArc).toBe(true);
      expect(sawWaterCrit).toBe(true);
      expect(wetFoe.hp).toBeLessThan(wetFoe.maxHp);
      expect(chainFoe.hp).toBeLessThan(chainHpBefore);

      // 3. Pyrotechnics oiled-only crit (burning alone does NOT crit; oil DOES crit!)
      const sPyro = createCombatSandbox(1106);
      const rngP = createRng(1106);
      sPyro.player.loadout.weapon1 = makeGear('Fireball', 'weapon', { color: 'brutality' });
      const pyroFoe = spawnEnemy(sPyro, 'CastleKnight', sPyro.player.pos.x + 70, sPyro.player.pos.y, 0, rngP);
      pyroFoe.attackCooldownTicks = 9999;
      applyStatus(pyroFoe.statusEffects, 'burn', 300, 10, 0);
      let burnCrit = false;
      for (let t = 0; t < 18; t++) {
        stepSim(sPyro, inputOf({ weapon1Pressed: t === 0 }));
        if (sPyro.events.some((e) => e.type === 'critImpact')) burnCrit = true;
      }
      expect(burnCrit).toBe(false);

      applyStatus(pyroFoe.statusEffects, 'oil', 300, 0, 0);
      let oilCrit = false;
      for (let t = 0; t < 18; t++) {
        stepSim(sPyro, inputOf({ weapon1Pressed: t === 0 }));
        if (sPyro.events.some((e) => e.type === 'critImpact')) oilCrit = true;
      }
      expect(oilCrit).toBe(true);

      // 4. Phaser empowers NEXT MELEE STRIKE of ANY weapon + Tonic gives tempShieldHp barrier
      const sSkill = createCombatSandbox(1107);
      const rngS = createRng(1107);
      sSkill.player.loadout.weapon1 = makeGear('StartSword', 'weapon', { color: 'brutality' });
      sSkill.player.loadout.skill1 = makeGear('Phaser', 'skill', { color: 'brutality' });
      sSkill.player.loadout.skill2 = makeGear('Tonic', 'skill', { color: 'survival' });

      // Measure baseline StartSword swing damage first
      const baseTarget = spawnEnemy(sSkill, 'CastleKnight', sSkill.player.pos.x + 22, sSkill.player.pos.y, 0, rngS);
      baseTarget.attackCooldownTicks = 9999;
      const baseHpBefore = baseTarget.hp;
      for (let t = 0; t < 14; t++) stepSim(sSkill, inputOf({ weapon1Pressed: t === 0 }));
      const baseSwingDmg = baseHpBefore - baseTarget.hp;

      // Wait out swing recovery, clear previous target, cast Phaser -> empowers next StartSword swing & clears bonus on hit!
      for (let t = 0; t < 12; t++) stepSim(sSkill, inputOf());
      sSkill.enemies = [];
      stepSim(sSkill, inputOf({ skill1Pressed: true }));
      expect(sSkill.player.phaserBonusDamage ?? 0).toBeGreaterThan(0);
      expect(sSkill.player.phaserBuffTicks ?? 0).toBeGreaterThan(0);
      const phaserTarget = spawnEnemy(sSkill, 'CastleKnight', sSkill.player.pos.x + sSkill.player.facing * 22, sSkill.player.pos.y, 0, rngS);
      phaserTarget.attackCooldownTicks = 9999;
      const pHpBefore = phaserTarget.hp;
      for (let t = 0; t < 14; t++) stepSim(sSkill, inputOf({ weapon1Pressed: t === 0 }));
      const phaserSwingDmg = pHpBefore - phaserTarget.hp;
      expect(phaserSwingDmg).toBeGreaterThan(baseSwingDmg);
      expect(sSkill.player.phaserBonusDamage).toBe(0);

      sSkill.player.hp = 50;
      stepSim(sSkill, inputOf({ skill2Pressed: true }));
      expect(sSkill.player.hp).toBe(50); // No infinite permanent heal!
      expect(sSkill.player.tempShieldHp ?? 0).toBeGreaterThan(0);
    });

    it('applies S-tier gear bonusScrolls (+2 stat & maxHp) on equip and removes them cleanly on unequip (gear_scroll_bonuses_applied)', () => {
      const state = createCombatSandbox(1112);
      const baseBrut = state.player.scrolls.brutality;
      const baseMaxHp = state.player.maxHp;

      // Place an S-tier Brutality sword (+2 Brutality) pickup at player's feet and equip it
      const sTierSword = makeGear('BroadSword', 'weapon', {
        uid: state.nextUid++,
        color: 'brutality',
        quality: 'S',
        bonusScrolls: { brutality: 2 },
      });
      const pickupUid = state.nextUid++;
      state.pickups.push({
        uid: pickupUid,
        kind: 'gear',
        pos: { x: state.player.pos.x, y: state.player.pos.y },
        prevPos: { x: state.player.pos.x, y: state.player.pos.y },
        vel: { x: 0, y: 0 },
        value: 0,
        gear: sTierSword,
        label: 'BroadSword-S',
        magnetTicks: 0,
        collected: false,
        bobPhase: 0,
      });

      stepSim(state, inputOf({ commands: [{ type: 'equipPickup', pickupUid, targetSlot: 1 }] }));
      expect(state.player.loadout.weapon1?.uid).toBe(sTierSword.uid);
      expect(state.player.scrolls.brutality).toBe(baseBrut + 2);
      expect(state.player.maxHp).toBe(computePlayerMaxHp(state.player.scrolls));
      expect(state.player.maxHp).toBeGreaterThan(baseMaxHp);

      // Displace with a plain base sword (no bonusScrolls) -> +2 Brutality & maxHp revert cleanly!
      const plainSword = makeGear('StartSword', 'weapon', {
        uid: state.nextUid++,
        color: 'brutality',
        quality: 'base',
      });
      const plainUid = state.nextUid++;
      state.pickups.push({
        uid: plainUid,
        kind: 'gear',
        pos: { x: state.player.pos.x, y: state.player.pos.y },
        prevPos: { x: state.player.pos.x, y: state.player.pos.y },
        vel: { x: 0, y: 0 },
        value: 0,
        gear: plainSword,
        label: 'StartSword',
        magnetTicks: 0,
        collected: false,
        bobPhase: 0,
      });

      stepSim(state, inputOf({ commands: [{ type: 'equipPickup', pickupUid: plainUid, targetSlot: 1 }] }));
      expect(state.player.loadout.weapon1?.uid).toBe(plainSword.uid);
      expect(state.player.scrolls.brutality).toBe(baseBrut);
      expect(state.player.maxHp).toBe(baseMaxHp);
    });

    it('filters rollAffixes by gear kind, enforces 2BC fountain refill limits, and opens Flawless Boss Door + Forge scroll delta', () => {
      const rng = createRng(1108);
      // Melee swords & shields NEVER roll pierce_first
      for (let i = 0; i < 40; i++) {
        const meleeAff = rollAffixes(rng, 4, undefined, 'weapon', 'melee', 'StartSword');
        const shieldAff = rollAffixes(rng, 4, undefined, 'weapon', 'shield', 'StartShield');
        expect(meleeAff).not.toContain('pierce_first');
        expect(shieldAff).not.toContain('pierce_first');
      }

      // 2BC Fountain decrements singleFlaskRefillsLeft (3 -> 2 -> 1 -> 0 -> refuses 4th!)
      const s2bc = createCombatSandbox(1109);
      s2bc.bossStemCells = 2;
      s2bc.player.maxFlaskCharges = 4;
      s2bc.player.flaskCharges = 0;
      for (let visit = 0; visit < 3; visit++) {
        enterPassageRoom(s2bc, 'PrisonStart', ['PrisonCourtyard'], rng);
        expect(handlePassageCommand(s2bc, { type: 'useFountain' }, rng)).toBe(true);
      }
      enterPassageRoom(s2bc, 'PrisonStart', ['PrisonCourtyard'], rng);
      expect(handlePassageCommand(s2bc, { type: 'useFountain' }, rng)).toBe(false);

      // Flawless Boss Door + Minor Forge bonusScrolls delta
      const sBoss = createCombatSandbox(1110);
      sBoss.bossArenaState.defeated = true;
      sBoss.bossArenaState.playerTookHit = false;
      enterPassageRoom(sBoss, 'Bridge', ['ClockTower'], rng);
      expect(sBoss.passageState.flawlessBossDoorOpen).toBe(true);
      expect(sBoss.pickups.some((p) => p.gear?.quality === 'L')).toBe(true);

      sBoss.player.gold = 20000;
      const brutBefore = sBoss.player.scrolls.brutality;
      expect(handlePassageCommand(sBoss, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true); // +
      expect(handlePassageCommand(sBoss, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true); // ++ (+1 scroll!)
      expect(sBoss.player.scrolls.brutality).toBe(brutBefore + 1);
      expect(handlePassageCommand(sBoss, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true); // S (+2 scrolls!)
      expect(sBoss.player.scrolls.brutality).toBe(brutBefore + 2);
    });

    it('ensures Dark Tracker (Ninja) teleports FIRST and enters 26t windup without same-tick hit', () => {
      const state = createCombatSandbox(1111);
      const rng = createRng(1111);
      const ninja = spawnEnemy(state, 'Ninja', state.player.pos.x + 110, state.player.pos.y, 0, rng);
      ninja.attackCooldownTicks = 0;
      const hpStart = state.player.hp;

      let sawTeleport = false;
      let hitOnTeleportTick = false;
      for (let t = 0; t < 20; t++) {
        stepSim(state, inputOf());
        if (state.events.some((e) => e.type === 'teleport')) {
          sawTeleport = true;
          if (state.player.hp < hpStart) {
            hitOnTeleportTick = true;
          }
          expect(ninja.state).toBe('windup');
          expect(ninja.telegraphTicks).toBeGreaterThanOrEqual(20);
          break;
        }
      }
      expect(sawTeleport).toBe(true);
      expect(hitOnTeleportTick).toBe(false);
    });
  });
});
