// =============================================================================
// KRUNKED CELLS — 100-Playtester Automated QA, Mechanic & Feel Gauntlet
// Pure headless simulation verifier (ZERO browser/DOM/WebGL/Audio dependencies).
// Runs 100 distinct playtester personas (PT-001 .. PT-100) across:
//   - PT-001..PT-010: Starter Kit & Core Controls
//   - PT-011..PT-030: All 20 Weapons Matrix (WEAPONS)
//   - PT-031..PT-042: All 12 Skills Matrix (SKILLS)
//   - PT-043..PT-057: All 15 Mutations Matrix (MUTATIONS)
//   - PT-058..PT-077: All 10 Biomes + Passage & Traversal Stress (20 seeds)
//   - PT-078..PT-092: 3 Multi-Phase Bosses & 0BC..5BC Scaling
//   - PT-093..PT-100: Mouse Aim, Input Buffer, Cancel Feel & Bit-Exact Replay
//
// Writes JSON report to .krunked-cells-assets/playtest-100-report.json
// Exits 0 ONLY when 100/100 playtesters pass with 0 CRITICAL & 0 MAJOR defects.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_BOSS_CELLS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  TILE_SIZE,
  TileKind,
  createEmptyInputFrame,
  type BiomeId,
  type BossId,
  type EnemyState,
  type GearInstance,
  type InputFrame,
  type ProjectileState,
  type SimEvent,
  type SimState,
  type TileGrid,
  type TurretState,
  type Vec2,
} from '../../src/contracts';
import {
  BOSS_MAP,
  DIFFICULTIES,
  ENEMY_MAP,
  MUTATIONS,
  SKILLS,
  SKILL_MAP,
  WEAPONS,
  getBiome,
  getBoss,
  getDifficulty,
  getEnemy,
  getWeapon,
} from '../../src/data';
import { spawnBoss } from '../../src/sim/bosses';
import { collisionApi } from '../../src/sim/collision';
import { attemptShieldParry, damageEnemy, damagePlayer } from '../../src/sim/combat';
import { spawnEnemy } from '../../src/sim/enemies';
import { hashSimState } from '../../src/sim/hash';
import { enterPassageRoom, handlePassageCommand } from '../../src/sim/passage';
import { createRng } from '../../src/sim/prng';
import {
  applyScrollPickup,
  rollGearInstance,
  triggerCurse,
} from '../../src/sim/roguelite';
import { applyStatus, hasStatus } from '../../src/sim/status';
import {
  createInitialSimState,
  spawnBossEncounter,
  stepSim,
  warpToBiome,
} from '../../src/sim/step';
import { verifyWorldReachability } from '../../src/sim/worldgen';

// =============================================================================
// Structured Playtester Report Types
// =============================================================================

type DefectSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';

interface PlaytesterDefect {
  severity: DefectSeverity;
  code: string;
  detail: string;
}

interface PlaytesterResult {
  id: string;
  persona: string;
  category: string;
  seed: number;
  pass: boolean;
  score: number;
  durationMs: number;
  metrics: Record<string, number | string | boolean>;
  feedback: string[];
  defects: PlaytesterDefect[];
}

interface CategorySummary {
  category: string;
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  critical: number;
  major: number;
  minor: number;
}

interface Playtest100Report {
  generatedAt: string;
  totalPlaytesters: number;
  passed: number;
  failed: number;
  passRatePct: number;
  avgScore: number;
  defectsBySeverity: { CRITICAL: number; MAJOR: number; MINOR: number };
  uniqueDefectCodes: Record<string, { severity: DefectSeverity; count: number; sample: string }>;
  categories: CategorySummary[];
  results: PlaytesterResult[];
}

// =============================================================================
// Playtester Builder & Harness Helpers
// =============================================================================

class TesterContext {
  readonly defects: PlaytesterDefect[] = [];
  readonly feedback: string[] = [];
  readonly metrics: Record<string, number | string | boolean> = {};

  defect(severity: DefectSeverity, code: string, detail: string): void {
    this.defects.push({ severity, code, detail });
    this.feedback.push(`[${severity}] ${code}: ${detail}`);
  }

  check(
    condition: boolean,
    severity: DefectSeverity,
    code: string,
    failDetail: string,
    passNote?: string
  ): boolean {
    if (!condition) {
      this.defect(severity, code, failDetail);
      return false;
    }
    if (passNote) {
      this.feedback.push(passNote);
    }
    return true;
  }

  note(msg: string): void {
    this.feedback.push(msg);
  }

  metric(key: string, value: number | string | boolean): void {
    this.metrics[key] = value;
  }
}

function runPlaytester(
  id: string,
  persona: string,
  category: string,
  seed: number,
  fn: (ctx: TesterContext) => void
): PlaytesterResult {
  const ctx = new TesterContext();
  const t0 = performance.now();
  try {
    fn(ctx);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.defect('CRITICAL', 'UNCAUGHT_EXCEPTION', msg);
  }
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;

  let crit = 0;
  let major = 0;
  let minor = 0;
  for (const d of ctx.defects) {
    if (d.severity === 'CRITICAL') crit += 1;
    else if (d.severity === 'MAJOR') major += 1;
    else minor += 1;
  }

  const score = Math.max(0, 100 - crit * 50 - major * 25 - minor * 8);
  const pass = crit === 0 && major === 0;

  return {
    id,
    persona,
    category,
    seed,
    pass,
    score,
    durationMs,
    metrics: ctx.metrics,
    feedback: ctx.feedback,
    defects: ctx.defects,
  };
}

function ptId(n: number): string {
  return `PT-${String(n).padStart(3, '0')}`;
}

function inputOf(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...createEmptyInputFrame(), ...overrides };
}

function createArenaGrid(width = 40, height = 20, floorTy = 15): TileGrid {
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

function createCombatSandbox(seed: number, bossCells = 0, floorTy = 15): SimState {
  const state = createInitialSimState(seed, bossCells);
  state.tileGrid = createArenaGrid(40, 20, floorTy);
  state.rooms = [
    {
      id: 0,
      type: 'combatArena',
      tx: 1,
      ty: 1,
      tw: 38,
      th: floorTy,
      neighbors: [],
      discovered: true,
      cleared: false,
    },
  ];
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
  state.bossArenaState.defeated = false;
  state.passageState.active = false;
  state.runStatus = 'playing';

  const floorY = floorTy * TILE_SIZE;
  state.player.pos = { x: 10 * TILE_SIZE, y: floorY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.onOneWay = false;
  state.player.onWallDir = 0;
  state.player.coyoteTicks = 6;
  state.player.jumpBufferTicks = 0;
  state.player.airJumpsLeft = state.player.maxAirJumps;
  state.player.wallRunTicksLeft = 16;
  state.player.actionState = 'idle';
  state.player.diveSlamState = 'none';
  state.player.rollTicks = 0;
  state.player.rollCooldownTicks = 0;
  state.player.parryWindowTicks = 0;
  state.player.parryCooldownTicks = 0;
  state.player.iframeTicks = 0;
  state.player.healTicks = 0;
  state.player.attackPhase = 'none';
  state.player.attackPhaseTicks = 0;
  return state;
}

function makeGear(
  state: SimState,
  defId: string,
  slotKind: 'weapon' | 'skill',
  overrides: Partial<GearInstance> = {}
): GearInstance {
  if (slotKind === 'skill') {
    const def = SKILL_MAP[defId] ?? SKILLS[0]!;
    return {
      uid: state.nextUid++,
      defId: def.id,
      slotKind: 'skill',
      level: 1,
      quality: 'base',
      color: def.colors[0] ?? 'brutality',
      affixes: [],
      cooldownTicks: 0,
      ...overrides,
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
    ...overrides,
  };
}

function stepAndCollect(
  state: SimState,
  ticks: number,
  inputFn: (t: number) => Partial<InputFrame> = () => ({})
): SimEvent[] {
  const all: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    stepSim(state, inputOf(inputFn(t)));
    for (let i = 0; i < state.events.length; i++) {
      all.push(state.events[i]!);
    }
  }
  return all;
}

function spawnEnemyProjectile(
  state: SimState,
  x: number,
  y: number,
  vx: number,
  vy = 0,
  damage = 28,
  parriable = true
): ProjectileState {
  const proj: ProjectileState = {
    uid: state.nextUid++,
    owner: 'enemy',
    ownerUid: 999,
    kind: 'enemyBolt',
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: vx, y: vy },
    radius: 5,
    damage,
    isCrit: false,
    pierceLeft: 0,
    gravity: 0,
    ttlTicks: 90,
    maxTtlTicks: 90,
    color: '#ffd166',
    parriable,
    hitIds: [],
  };
  state.projectiles.push(proj);
  return proj;
}

function inspectTurretGrounding(
  state: SimState,
  turret: TurretState
): { supportTopY: number | null; gapPx: number; tileUnderValid: boolean } {
  const grid = state.tileGrid;
  const tx = Math.floor(turret.pos.x / TILE_SIZE);
  const startTy = Math.max(0, Math.floor((turret.pos.y - 2) / TILE_SIZE));
  let supportTy = -1;
  for (let ty = startTy; ty < grid.height; ty++) {
    if (collisionApi.isSolidAt(grid, tx, ty) || collisionApi.isOneWayAt(grid, tx, ty)) {
      supportTy = ty;
      break;
    }
  }
  if (supportTy === -1) {
    return { supportTopY: null, gapPx: Infinity, tileUnderValid: false };
  }
  const supportTopY = supportTy * TILE_SIZE;
  const gapPx = supportTopY - turret.pos.y;
  const turretTy = Math.floor(turret.pos.y / TILE_SIZE);
  const tileUnderValid = supportTy - turretTy <= 1 && gapPx >= -12 && gapPx <= 16;
  return { supportTopY, gapPx, tileUnderValid };
}

function findFirstNonFinite(state: SimState): string | null {
  const p = state.player;
  const checks: [string, number][] = [
    ['player.pos.x', p.pos.x],
    ['player.pos.y', p.pos.y],
    ['player.vel.x', p.vel.x],
    ['player.vel.y', p.vel.y],
    ['player.hp', p.hp],
    ['player.maxHp', p.maxHp],
    ['player.rallyHp', p.rallyHp],
    ['player.gold', p.gold],
    ['player.cells', p.cells],
    ['camera.x', state.camera.x],
    ['camera.y', state.camera.y],
  ];
  for (const [label, val] of checks) {
    if (!Number.isFinite(val)) return `${label}=${val}`;
  }
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y) || !Number.isFinite(e.hp)) {
      return `enemy[${e.defId}#${e.uid}] pos=(${e.pos.x},${e.pos.y}) hp=${e.hp}`;
    }
  }
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i]!;
    if (!Number.isFinite(pr.pos.x) || !Number.isFinite(pr.pos.y) || !Number.isFinite(pr.damage)) {
      return `proj[${pr.kind}#${pr.uid}] pos=(${pr.pos.x},${pr.pos.y}) dmg=${pr.damage}`;
    }
  }
  for (let i = 0; i < state.turrets.length; i++) {
    const t = state.turrets[i]!;
    if (!Number.isFinite(t.pos.x) || !Number.isFinite(t.pos.y) || !Number.isFinite(t.hp)) {
      return `turret[${t.defId}#${t.uid}] pos=(${t.pos.x},${t.pos.y}) hp=${t.hp}`;
    }
  }
  return null;
}

function performSingleMeleeStrike(state: SimState, slot: 1 | 2 = 1): SimEvent[] {
  const events: SimEvent[] = [];
  // Wait out any active hitstop/slow-mo from prior actions so the press is not swallowed
  let guard = 0;
  while ((state.hitstopTicks > 0 || state.slowMoTicks > 0) && guard < 30) {
    stepSim(state, inputOf());
    guard += 1;
  }
  let sawSwing = false;
  for (let t = 0; t < 48; t++) {
    const frame: Partial<InputFrame> =
      t === 0 ? (slot === 1 ? { weapon1Pressed: true } : { weapon2Pressed: true }) : {};
    stepSim(state, inputOf(frame));
    for (const ev of state.events) {
      events.push(ev);
      if (ev.type === 'attackSwing') sawSwing = true;
    }
    if (sawSwing && state.player.attackPhase === 'none') break;
  }
  return events;
}

// =============================================================================
// CATEGORY 1: PT-001 .. PT-010 — Starter Kit & Core Controls
// =============================================================================

function runCategory1StarterKit(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '1. Starter Kit & Core Controls';

  // PT-001: Fresh-Run 4-Slot Starter Loadout
  out.push(
    runPlaytester(ptId(1), 'Fresh-Run Loadout Inspector', CAT, 1001, (ctx) => {
      const state = createInitialSimState(1001, 0);
      const { loadout } = state.player;
      ctx.metric('weapon1', loadout.weapon1?.defId ?? 'null');
      ctx.metric('weapon2', loadout.weapon2?.defId ?? 'null');
      ctx.metric('skill1', loadout.skill1?.defId ?? 'null');
      ctx.metric('skill2', loadout.skill2?.defId ?? 'null');
      ctx.metric('flaskCharges', state.player.flaskCharges);

      ctx.check(
        loadout.weapon1?.defId === 'StartSword',
        'CRITICAL',
        'STARTER_WEAPON1_MISMATCH',
        `Expected weapon1=StartSword, got ${loadout.weapon1?.defId ?? 'null'}`
      );
      ctx.check(
        loadout.weapon2?.defId === 'StartShield',
        'CRITICAL',
        'STARTER_WEAPON2_MISMATCH',
        `Expected weapon2=StartShield, got ${loadout.weapon2?.defId ?? 'null'}`
      );
      ctx.check(
        loadout.skill1?.defId === 'InfantryGrenade',
        'MAJOR',
        'STARTER_SKILL1_MISMATCH',
        `Expected skill1=InfantryGrenade, got ${loadout.skill1?.defId ?? 'null'}`
      );
      ctx.check(
        loadout.skill2 !== null && Boolean(SKILL_MAP[loadout.skill2.defId]),
        'MAJOR',
        'STARTER_SKILL2_EMPTY',
        `New run has skill2=null (expected SinewSlicer or valid starter skill so E slot works on tick 1)`
      );
      ctx.check(
        state.player.hp === 100 && state.player.maxHp === 100,
        'MAJOR',
        'STARTER_HP_MISMATCH',
        `Expected 100/100 HP, got ${state.player.hp}/${state.player.maxHp}`
      );
      ctx.check(
        state.player.flaskCharges >= 1,
        'MAJOR',
        'STARTER_FLASK_EMPTY',
        `Expected >= 1 starter flask charge, got ${state.player.flaskCharges}`
      );
      ctx.check(
        !state.player.shieldBlocking,
        'MINOR',
        'STARTER_SHIELD_BLOCKING_INIT',
        `Expected shieldBlocking falsy at start`
      );
      ctx.check(findFirstNonFinite(state) === null, 'CRITICAL', 'NAN_STATE', 'NaN in initial state');
    })
  );

  // PT-002: 3-Hit Starter Melee Combo
  out.push(
    runPlaytester(ptId(2), 'Three-Hit Melee Combo Specialist', CAT, 1002, (ctx) => {
      const state = createCombatSandbox(1002);
      const rng = createRng(1002);
      const dummy = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 22, state.player.pos.y, 0, rng);
      dummy.hp = 1000;
      dummy.maxHp = 1000;
      dummy.attackCooldownTicks = 9999;

      const stepIndices: number[] = [];
      const hitDamages: number[] = [];

      for (let swing = 0; swing < 3; swing++) {
        // Keep dummy in sword reach between swings without resetting combo
        dummy.pos.x = state.player.pos.x + 22;
        dummy.vel.x = 0;
        dummy.attackCooldownTicks = 9999;
        const evs = performSingleMeleeStrike(state, 1);
        for (const ev of evs) {
          if (ev.type === 'attackSwing') stepIndices.push(ev.stepIndex);
          if (ev.type === 'hitImpact' || ev.type === 'critImpact') hitDamages.push(ev.damage);
        }
      }

      ctx.metric('comboSteps', stepIndices.join(','));
      ctx.metric('hitDamages', hitDamages.join(','));

      ctx.check(
        stepIndices.length >= 3 && stepIndices[0] === 0 && stepIndices[1] === 1 && stepIndices[2] === 2,
        'MAJOR',
        'MELEE_COMBO_CHAIN_BROKEN',
        `Expected 3-hit combo steps [0,1,2], got [${stepIndices.join(',')}]`
      );
      ctx.check(
        hitDamages.length >= 3 && hitDamages.every((d) => d > 0),
        'MAJOR',
        'MELEE_COMBO_NO_DAMAGE',
        `Expected 3 positive damage hits, got [${hitDamages.join(',')}]`
      );
      if (hitDamages.length >= 3) {
        ctx.check(
          hitDamages[2]! > hitDamages[0]!,
          'MINOR',
          'MELEE_FINISHER_WEAK',
          `3rd combo strike (${hitDamages[2]}) did not exceed 1st strike (${hitDamages[0]})`
        );
      }
    })
  );

  // PT-003: Shield Parry & Visual/Event Feedback
  out.push(
    runPlaytester(ptId(3), 'Shield Parry & Feedback Duelist', CAT, 1003, (ctx) => {
      const state = createCombatSandbox(1003);
      const rng = createRng(1003);
      const particlesBefore = state.particlesSim.length;

      // Press shield in open room -> must emit parryStart & visual sparks
      stepSim(state, inputOf({ weapon2Pressed: true }));
      const sawParryStart = state.events.some((e) => e.type === 'parryStart');
      const particlesAdded = state.particlesSim.length - particlesBefore;
      ctx.metric('parryStartEvent', sawParryStart);
      ctx.metric('parryStartParticles', particlesAdded);

      ctx.check(
        state.player.actionState === 'parry' && state.player.parryWindowTicks > 0,
        'CRITICAL',
        'SHIELD_PARRY_WINDOW_FAILED',
        `Shield press did not enter parry state (actionState=${state.player.actionState}, window=${state.player.parryWindowTicks})`
      );
      ctx.check(
        sawParryStart,
        'MAJOR',
        'PARRY_START_EVENT_MISSING',
        'Pressing shield did not emit parryStart feedback event'
      );
      ctx.check(
        particlesAdded > 0,
        'MINOR',
        'PARRY_START_VFX_MISSING',
        'Pressing shield spawned 0 visual feedback particles'
      );

      // Reset and test projectile reflection
      stepAndCollect(state, 35);
      const bolt = spawnEnemyProjectile(state, state.player.pos.x + 14, state.player.pos.y, -280, 0, 30, true);
      stepSim(state, inputOf({ weapon2Pressed: true }));
      const reflected = state.events.some((e) => e.type === 'parrySuccess' && e.reflected);
      ctx.metric('projectileReflected', reflected);
      ctx.check(
        reflected && bolt.owner === 'player' && bolt.isCrit && bolt.vel.x > 0,
        'CRITICAL',
        'SHIELD_PROJECTILE_REFLECT_FAILED',
        `Projectile parry failed (owner=${bolt.owner}, isCrit=${bolt.isCrit}, vx=${bolt.vel.x})`
      );
      ctx.check(
        state.player.parryCooldownTicks === 0,
        'MAJOR',
        'PARRY_COOLDOWN_NOT_RESET',
        `parryCooldownTicks=${state.player.parryCooldownTicks} after successful parry (expected 0)`
      );

      // Test melee parry + stun + counter damage
      const s2 = createCombatSandbox(10031);
      const attacker = spawnEnemy(s2, 'Zombie', s2.player.pos.x + 24, s2.player.pos.y, 0, rng);
      const hpBefore = s2.player.hp;
      const mobHpBefore = attacker.hp;
      stepSim(s2, inputOf({ weapon2Pressed: true }));
      const ok = attemptShieldParry(s2, 25, attacker, null, rng);
      ctx.check(
        ok && s2.player.hp === hpBefore && attacker.stunTicks >= 75 && attacker.hp < mobHpBefore,
        'CRITICAL',
        'SHIELD_MELEE_PARRY_FAILED',
        `Melee parry failed (ok=${ok}, hp=${s2.player.hp}/${hpBefore}, stun=${attacker.stunTicks})`
      );
    })
  );

  // PT-004: Shield Hold-to-Block Damage Reduction
  out.push(
    runPlaytester(ptId(4), 'Shield Hold-to-Block Guardian', CAT, 1004, (ctx) => {
      const state = createCombatSandbox(1004);
      const rng = createRng(1004);

      // Hold weapon2Held (StartShield) without active parry window -> enters shieldBlocking
      stepAndCollect(state, 3, () => ({ weapon2Held: true }));
      const blockingActive = state.player.shieldBlocking === true;
      ctx.metric('shieldBlockingActive', blockingActive);
      ctx.check(
        blockingActive,
        'MAJOR',
        'SHIELD_HOLD_BLOCK_MISSING',
        `Holding StartShield (weapon2Held=true, parryWindow=0) did not set player.shieldBlocking=true (got ${String(state.player.shieldBlocking)})`
      );

      // Incoming 40 damage while blocking should be reduced (~75% -> ~10 dmg) & emit shieldBlock
      state.player.iframeTicks = 0;
      const hpBefore = state.player.hp;
      state.events = [];
      damagePlayer(state, 40, 'Zombie', rng);
      const dmgTaken = hpBefore - state.player.hp;
      const sawShieldBlock = state.events.some((e) => e.type === 'shieldBlock');
      ctx.metric('blockedDamageTaken', dmgTaken);
      ctx.metric('shieldBlockEvent', sawShieldBlock);

      ctx.check(
        sawShieldBlock,
        'MAJOR',
        'SHIELD_BLOCK_EVENT_MISSING',
        'Taking damage while holding shield did not emit shieldBlock event'
      );
      ctx.check(
        dmgTaken > 0 && dmgTaken <= 15,
        'MAJOR',
        'SHIELD_BLOCK_NO_DAMAGE_REDUCTION',
        `Expected reduced damage <= 15 (75% DR on 40 dmg), took ${dmgTaken}`
      );

      // Releasing weapon2Held clears shieldBlocking
      stepSim(state, inputOf({ weapon2Held: false }));
      ctx.check(
        !state.player.shieldBlocking,
        'MAJOR',
        'SHIELD_BLOCK_STUCK_ON',
        'Releasing weapon2Held did not clear player.shieldBlocking'
      );
    })
  );

  // PT-005: Starter Grenade Throw, Explosion Event & Enemy Damage
  out.push(
    runPlaytester(ptId(5), 'Starter Grenade Demolitionist', CAT, 1005, (ctx) => {
      const state = createCombatSandbox(1005);
      const rng = createRng(1005);
      const foe = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 140, state.player.pos.y, 0, rng);
      foe.attackCooldownTicks = 9999;
      const foeHpBefore = foe.hp;

      const evs = stepAndCollect(state, 75, (t) => ({ skill1Pressed: t === 0 }));
      const sawCast = evs.some((e) => e.type === 'skillCast' && e.skillId === 'InfantryGrenade');
      const sawExplosion = evs.some((e) => e.type === 'explosion');
      const dmgDealt = foeHpBefore - foe.hp;

      ctx.metric('skillCast', sawCast);
      ctx.metric('explosionEvent', sawExplosion);
      ctx.metric('damageDealt', dmgDealt);
      ctx.metric('cooldownRemaining', state.player.loadout.skill1?.cooldownTicks ?? 0);

      ctx.check(sawCast, 'CRITICAL', 'GRENADE_CAST_FAILED', 'skill1Pressed did not emit skillCast for InfantryGrenade');
      ctx.check(
        sawExplosion,
        'MAJOR',
        'GRENADE_EXPLOSION_EVENT_MISSING',
        'InfantryGrenade detonated without emitting explosion SimEvent'
      );
      ctx.check(dmgDealt > 0, 'CRITICAL', 'GRENADE_NO_DAMAGE', `InfantryGrenade dealt ${dmgDealt} damage to enemy in blast zone`);
    })
  );

  // PT-006: Starter Turret Floor-Snapping (Grounded & Midair Deploy)
  out.push(
    runPlaytester(ptId(6), 'Starter Turret Grounding Engineer', CAT, 1006, (ctx) => {
      const state = createCombatSandbox(1006);
      const rng = createRng(1006);
      const hadStarterSkill2 = state.player.loadout.skill2 !== null;
      ctx.metric('hadStarterSkill2', hadStarterSkill2);
      if (!hadStarterSkill2) {
        ctx.defect('MAJOR', 'STARTER_SKILL2_NULL_ON_DEPLOY', 'Starter skill2 is null; equipping SinewSlicer manually to audit grounding');
        state.player.loadout.skill2 = makeGear(state, 'SinewSlicer', 'skill');
      }

      // Position player 68px midair above floor and deploy turret!
      const floorY = 15 * TILE_SIZE;
      state.player.pos.y = floorY - PLAYER_HEIGHT * 0.5 - 68;
      state.player.grounded = false;
      state.player.vel = { x: 0, y: 0 };

      const foe = spawnEnemy(state, 'CastleKnight', state.player.pos.x + 110, floorY - 18, 0, rng);
      foe.attackCooldownTicks = 9999;
      const foeHpBefore = foe.hp;

      const evs = stepAndCollect(state, 55, (t) => ({ skill2Pressed: t === 0 }));
      const turret = state.turrets.find((t) => t.owner === 'player');
      ctx.check(Boolean(turret), 'CRITICAL', 'TURRET_NOT_SPAWNED', 'Deploying skill2 did not spawn a player turret');
      ctx.check(evs.some((e) => e.type === 'skillCast'), 'MAJOR', 'TURRET_CAST_EVENT_MISSING', 'skillCast not emitted on turret deploy');

      if (turret) {
        const g = inspectTurretGrounding(state, turret);
        ctx.metric('turretFloorGapPx', Math.round(g.gapPx * 10) / 10);
        ctx.metric('turretGroundedValid', g.tileUnderValid);
        ctx.check(
          g.supportTopY !== null && g.gapPx <= 16 && g.gapPx >= -12,
          'MAJOR',
          'TURRET_FLOATING_MIDAIR',
          `Midair-deployed ${turret.defId} floats ${g.gapPx.toFixed(1)}px above floor (limit <= 16px)`
        );
        ctx.check(
          foe.hp < foeHpBefore,
          'MAJOR',
          'TURRET_FAILED_TO_DAMAGE',
          `Turret ${turret.defId} did not damage enemy in range (hp ${foe.hp}/${foeHpBefore})`
        );
      }
    })
  );

  // PT-007: Roll-Cancel of Attack Windup + 21-Tick Iframes
  out.push(
    runPlaytester(ptId(7), 'Roll-Cancel & Iframe Acrobat', CAT, 1007, (ctx) => {
      const state = createCombatSandbox(1007);
      const rng = createRng(1007);
      state.player.loadout.weapon1 = makeGear(state, 'BroadSword', 'weapon', { color: 'survival' });

      // Start slow BroadSword windup, then cancel on tick 2 with Roll
      stepSim(state, inputOf({ weapon1Pressed: true }));
      ctx.check(state.player.attackPhase === 'windup', 'MAJOR', 'ATTACK_WINDUP_NOT_ENTERED', 'BroadSword did not enter windup');

      stepSim(state, inputOf({ rollPressed: true }));
      ctx.check(
        state.player.actionState === 'roll' && state.player.attackPhase === 'none',
        'CRITICAL',
        'ROLL_CANCEL_WINDUP_FAILED',
        `Roll did not cancel windup (actionState=${state.player.actionState}, attackPhase=${state.player.attackPhase})`
      );
      ctx.check(
        state.events.some((e) => e.type === 'dodgeRoll'),
        'MAJOR',
        'DODGE_ROLL_EVENT_MISSING',
        'dodgeRoll event not emitted'
      );

      // Verify iframes negate damage during roll
      const startHp = state.player.hp;
      let negatedTicks = 0;
      if (state.player.iframeTicks > 0 && !damagePlayer(state, 35, 'Trap', rng)) negatedTicks += 1;
      for (let t = 0; t < 26; t++) {
        stepSim(state, inputOf());
        if (state.player.iframeTicks > 0) {
          if (!damagePlayer(state, 35, 'Trap', rng)) negatedTicks += 1;
        }
      }
      ctx.metric('iframeNegatedTicks', negatedTicks);
      ctx.check(
        negatedTicks >= 20 && state.player.hp === startHp,
        'MAJOR',
        'ROLL_IFRAMES_BROKEN',
        `Expected >= 20 iframe ticks negating damage, got ${negatedTicks} (hp=${state.player.hp}/${startHp})`
      );
    })
  );

  // PT-008: Double-Jump, Wall-Slide & Dive-Slam
  out.push(
    runPlaytester(ptId(8), 'Acrobatic Platformer', CAT, 1008, (ctx) => {
      const state = createCombatSandbox(1008, 0, 17);
      const rng = createRng(1008);
      // Tall wall on right at tx=16 for wall-run/slide, cracked floor at ty=13
      for (let ty = 3; ty <= 16; ty++) {
        collisionApi.setTile(state.tileGrid, 16, ty, TileKind.SOLID);
      }

      // 1. Ground jump + midair double jump
      const jumpEvs = stepAndCollect(state, 18, (t) => ({
        jump: true,
        jumpPressed: t === 0 || t === 10,
      }));
      const sawGroundJump = jumpEvs.some((e) => e.type === 'jump' && !e.isAirJump);
      const sawAirJump = jumpEvs.some((e) => e.type === 'jump' && e.isAirJump);
      ctx.check(sawGroundJump && sawAirJump, 'MAJOR', 'DOUBLE_JUMP_FAILED', `ground=${sawGroundJump}, air=${sawAirJump}`);

      // 2. Wall-run -> Wall-slide on right wall
      state.player.pos = { x: 16 * TILE_SIZE - PLAYER_WIDTH * 0.5, y: 12 * TILE_SIZE };
      state.player.vel = { x: 0, y: 0 };
      state.player.grounded = false;
      state.player.coyoteTicks = 0;
      state.player.wallRunTicksLeft = 16;
      const wallStartY = state.player.pos.y;
      stepAndCollect(state, 16, () => ({ moveRight: true }));
      const wallClimbed = wallStartY - state.player.pos.y;
      stepAndCollect(state, 14, () => ({ moveRight: true }));
      const slidingVy = state.player.vel.y;
      ctx.metric('wallClimbPx', Math.round(wallClimbed));
      ctx.metric('wallSlideVy', Math.round(slidingVy));
      ctx.check(wallClimbed > 20, 'MAJOR', 'WALL_RUN_FAILED', `Spider wall-run climbed only ${wallClimbed.toFixed(1)}px`);
      ctx.check(
        state.player.wallSlideTicks > 0 && slidingVy <= 70.1,
        'MAJOR',
        'WALL_SLIDE_FAILED',
        `Wall-slide failed (ticks=${state.player.wallSlideTicks}, vy=${slidingVy.toFixed(1)})`
      );

      // 3. Dive-slam shatters CRACKED_FLOOR & stuns enemy below
      for (let tx = 6; tx <= 10; tx++) {
        collisionApi.setTile(state.tileGrid, tx, 12, TileKind.CRACKED_FLOOR);
      }
      const lowerFloorY = 17 * TILE_SIZE;
      const victim = spawnEnemy(state, 'Zombie', 8 * TILE_SIZE + 20, lowerFloorY - 14, 0, rng);
      const victimHpBefore = victim.hp;
      state.player.pos = { x: 8 * TILE_SIZE, y: 8 * TILE_SIZE };
      state.player.vel = { x: 0, y: 0 };
      state.player.grounded = false;
      const slamEvs = stepAndCollect(state, 40, (t) => ({
        moveDown: true,
        jumpPressed: t === 0,
      }));
      const sawSlam = slamEvs.some((e) => e.type === 'diveSlamImpact');
      const shattered = collisionApi.getTile(state.tileGrid, 8, 12) === TileKind.EMPTY;
      ctx.check(sawSlam && shattered, 'MAJOR', 'DIVE_SLAM_FAILED', `sawSlam=${sawSlam}, crackedShattered=${shattered}`);
      ctx.check(
        victim.hp < victimHpBefore && victim.stunTicks > 0,
        'MAJOR',
        'DIVE_SLAM_NO_IMPACT_EFFECT',
        `Enemy hp=${victim.hp}/${victimHpBefore}, stun=${victim.stunTicks}`
      );
    })
  );

  // PT-009: Health Flask (Injured Heal + Full-HP Feedback + Empty Feedback)
  out.push(
    runPlaytester(ptId(9), 'Health Flask Medic', CAT, 1009, (ctx) => {
      const state = createCombatSandbox(1009);
      state.player.maxFlaskCharges = 2;
      state.player.flaskCharges = 2;
      state.player.hp = state.player.maxHp;

      // Case A: Full HP -> MUST NOT waste charge, MUST emit flaskEmpty(reason:'fullHp')
      stepSim(state, inputOf({ healPressed: true }));
      const fullHpFeedback = state.events.some(
        (e) => e.type === 'flaskEmpty' && e.reason === 'fullHp'
      );
      ctx.metric('fullHpFeedback', fullHpFeedback);
      ctx.check(
        state.player.flaskCharges === 2,
        'CRITICAL',
        'FLASK_WASTED_AT_FULL_HP',
        `Flask charge consumed at full HP (left=${state.player.flaskCharges})`
      );
      ctx.check(
        fullHpFeedback,
        'MAJOR',
        'FLASK_FULL_HP_FEEDBACK_MISSING',
        'Pressing heal at full HP gave no flaskEmpty(reason:"fullHp") feedback event'
      );

      // Case B: Injured -> heals 60% maxHp, consumes 1 charge, emits flaskDrink
      state.player.hp = Math.round(state.player.maxHp * 0.25);
      const hpBefore = state.player.hp;
      stepSim(state, inputOf({ healPressed: true }));
      const sawDrink = state.events.some((e) => e.type === 'flaskDrink' && e.healed > 0);
      ctx.metric('healedHp', state.player.hp - hpBefore);
      ctx.check(
        sawDrink && state.player.flaskCharges === 1 && state.player.hp > hpBefore + 40,
        'CRITICAL',
        'FLASK_HEAL_FAILED',
        `Injured heal failed (sawDrink=${sawDrink}, charges=${state.player.flaskCharges}, hp=${hpBefore}->${state.player.hp})`
      );

      // Wait out healTicks, set flaskCharges = 0, injure again, press heal -> flaskEmpty(reason:'empty')
      stepAndCollect(state, 30);
      state.player.flaskCharges = 0;
      state.player.hp = Math.round(state.player.maxHp * 0.3);
      const hpEmptyBefore = state.player.hp;
      stepSim(state, inputOf({ healPressed: true }));
      const emptyFeedback = state.events.some(
        (e) => e.type === 'flaskEmpty' && e.reason === 'empty'
      );
      ctx.metric('emptyFlaskFeedback', emptyFeedback);
      ctx.check(
        emptyFeedback,
        'MAJOR',
        'FLASK_EMPTY_FEEDBACK_MISSING',
        'Pressing heal with 0 charges gave no flaskEmpty(reason:"empty") feedback event'
      );
      ctx.check(
        state.player.hp === hpEmptyBefore,
        'CRITICAL',
        'EMPTY_FLASK_HEALED_PLAYER',
        'Empty flask healed player'
      );
    })
  );

  // PT-010: Door Smash & Rally Orange Health Recovery
  out.push(
    runPlaytester(ptId(10), 'Door Smasher & Rally Brawler', CAT, 1010, (ctx) => {
      const state = createCombatSandbox(1010);
      const rng = createRng(1010);
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
      const guard = spawnEnemy(state, 'Zombie', state.player.pos.x + 56, floorY - 14, 0, rng);
      guard.stunTicks = 0;

      const smashEvs = stepAndCollect(state, 12, (t) => ({ rollPressed: t === 0 }));
      ctx.check(
        smashEvs.some((e) => e.type === 'doorSmash') && state.doors[0]!.broken,
        'MAJOR',
        'DOOR_SMASH_FAILED',
        'Rolling through wooden door did not smash it'
      );
      ctx.check(
        guard.stunTicks >= 75,
        'MAJOR',
        'DOOR_SMASH_STUN_FAILED',
        `Enemy behind smashed door stunTicks=${guard.stunTicks} (expected >= 75)`
      );

      // Rally orange health recovery check
      const s2 = createCombatSandbox(10102);
      applyScrollPickup(s2, 'survival');
      applyScrollPickup(s2, 'survival');
      damagePlayer(s2, 60, 'Zombie', rng);
      ctx.check(s2.player.rallyHp === 60, 'MAJOR', 'RALLY_NOT_POPULATED', `rallyHp=${s2.player.rallyHp}, expected 60`);
      const hpAfterHit = s2.player.hp;
      const target = spawnEnemy(s2, 'CastleKnight', s2.player.pos.x + 22, s2.player.pos.y, 0, rng);
      target.attackCooldownTicks = 9999;
      const rallyEvs = performSingleMeleeStrike(s2, 1);
      ctx.check(
        s2.player.hp > hpAfterHit && rallyEvs.some((e) => e.type === 'rallyRecovered'),
        'MAJOR',
        'RALLY_RECOVERY_FAILED',
        `Melee hit did not recover rally HP (${hpAfterHit} -> ${s2.player.hp})`
      );
    })
  );

  return out;
}

// =============================================================================
// CATEGORY 2: PT-011 .. PT-030 — All 20 Weapons Matrix
// =============================================================================

function runCategory2WeaponsMatrix(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '2. All 20 Weapons Matrix';

  for (let idx = 0; idx < WEAPONS.length; idx++) {
    const def = WEAPONS[idx]!;
    const num = 11 + idx;
    const seed = 2000 + num;

    out.push(
      runPlaytester(ptId(num), `Weapon Master: ${def.name} (${def.id})`, CAT, seed, (ctx) => {
        const state = createCombatSandbox(seed);
        const rng = createRng(seed);
        ctx.metric('weaponId', def.id);
        ctx.metric('kind', def.kind);
        ctx.metric('critCondition', def.critCondition);

        if (def.kind === 'shield') {
          // Test shield in slot 2: parryStart, projectile reflection, melee parry + passive, hold-to-block!
          state.player.loadout.weapon2 = makeGear(state, def.id, 'weapon', { color: def.colors[0] ?? 'survival' });

          // 1. parryStart feedback
          stepSim(state, inputOf({ weapon2Pressed: true }));
          const sawParryStart = state.events.some((e) => e.type === 'parryStart');
          ctx.check(
            sawParryStart,
            'MAJOR',
            'SHIELD_PARRY_START_MISSING',
            `${def.id}: pressing shield did not emit parryStart`
          );

          // 2. Projectile reflection
          stepAndCollect(state, 32);
          const bolt = spawnEnemyProjectile(state, state.player.pos.x + 14, state.player.pos.y, -260, 0, 32, true);
          stepSim(state, inputOf({ weapon2Pressed: true }));
          const reflected =
            state.events.some((e) => e.type === 'parrySuccess' && e.reflected) &&
            bolt.owner === 'player' &&
            bolt.isCrit;
          ctx.metric('reflectedProjectile', reflected);
          ctx.check(
            reflected,
            'CRITICAL',
            'SHIELD_REFLECT_FAILED',
            `${def.id}: failed to reflect parriable enemy projectile`
          );

          // 3. Melee parry + shield passive verification
          const sMelee = createCombatSandbox(seed + 50);
          sMelee.player.loadout.weapon2 = makeGear(sMelee, def.id, 'weapon', { color: def.colors[0] ?? 'survival' });
          const primaryMob = spawnEnemy(sMelee, 'CastleKnight', sMelee.player.pos.x + 24, sMelee.player.pos.y, 0, rng);
          const nearbyMob = spawnEnemy(sMelee, 'Zombie', sMelee.player.pos.x + 80, sMelee.player.pos.y, 0, rng);
          const primaryHpBefore = primaryMob.hp;
          stepSim(sMelee, inputOf({ weapon2Pressed: true }));
          const parriedMelee = attemptShieldParry(sMelee, 30, primaryMob, null, rng);
          ctx.check(
            parriedMelee && primaryMob.hp < primaryHpBefore,
            'CRITICAL',
            'SHIELD_MELEE_COUNTER_FAILED',
            `${def.id}: melee parry counter failed`
          );
          if (def.parryPassive === 'stun') {
            ctx.check(
              primaryMob.stunTicks >= 150,
              'MAJOR',
              'STUN_SHIELD_PASSIVE_FAILED',
              `StunShield stunTicks=${primaryMob.stunTicks} (expected >= 150)`
            );
          } else if (def.parryPassive === 'bleed') {
            ctx.check(
              hasStatus(primaryMob.statusEffects, 'bleed') && hasStatus(nearbyMob.statusEffects, 'bleed'),
              'MAJOR',
              'BLEED_SHIELD_PASSIVE_FAILED',
              `BleedShield did not apply AoE bleed to nearby enemies`
            );
          } else if (def.parryPassive === 'forcefield') {
            ctx.check(
              hasStatus(sMelee.player.statusEffects, 'shield'),
              'MAJOR',
              'FORCE_SHIELD_PASSIVE_FAILED',
              `ForceShield did not grant player shield forcefield status`
            );
          }

          // 4. Hold-to-block damage reduction
          const sBlock = createCombatSandbox(seed + 90);
          sBlock.player.loadout.weapon2 = makeGear(sBlock, def.id, 'weapon', { color: def.colors[0] ?? 'survival' });
          stepAndCollect(sBlock, 3, () => ({ weapon2Held: true }));
          const isBlocking = sBlock.player.shieldBlocking === true;
          ctx.metric('shieldBlocking', isBlocking);
          ctx.check(
            isBlocking,
            'MAJOR',
            'SHIELD_HOLD_BLOCK_MISSING',
            `${def.id}: holding weapon2Held did not activate player.shieldBlocking`
          );
          sBlock.player.iframeTicks = 0;
          const hpBeforeBlock = sBlock.player.hp;
          sBlock.events = [];
          damagePlayer(sBlock, 40, 'Zombie', rng);
          const blockedDmg = hpBeforeBlock - sBlock.player.hp;
          const sawBlockEvt = sBlock.events.some((e) => e.type === 'shieldBlock');
          ctx.metric('blockedDmg', blockedDmg);
          ctx.check(
            sawBlockEvt && blockedDmg > 0 && blockedDmg <= 15,
            'MAJOR',
            'SHIELD_BLOCK_REDUCTION_FAILED',
            `${def.id}: hold-block took ${blockedDmg}/40 dmg (shieldBlock event=${sawBlockEvt})`
          );
          return;
        }

        // Melee & Ranged Offense Weapons (16)
        const gear = makeGear(state, def.id, 'weapon', { color: def.colors[0] ?? 'brutality' });
        state.player.loadout.weapon1 = gear;
        state.player.godMode = true;

        // Place target enemy cleanly based on weapon & crit condition
        let enemyX = state.player.pos.x + (def.kind === 'ranged' ? 62 : 24);
        if (def.id === 'ImpaleSpear') {
          // Build a solid wall 3 tiles thick right behind enemy for wallSlam crit
          for (let tx = 14; tx <= 16; tx++) {
            for (let ty = 10; ty <= 14; ty++) {
              collisionApi.setTile(state.tileGrid, tx, ty, TileKind.SOLID);
            }
          }
          enemyX = 14 * TILE_SIZE - 14;
          state.player.pos.x = enemyX - 36;
          state.player.prevPos.x = state.player.pos.x;
        } else if (def.id === 'Rapier') {
          enemyX = state.player.pos.x + 118;
        }

        const mobKind = def.id === 'Whip' ? 'Shield' : 'CastleKnight';
        const enemy = spawnEnemy(state, mobKind, enemyX, state.player.pos.y, 0, rng);
        enemy.hp = 1200;
        enemy.maxHp = 1200;
        enemy.attackCooldownTicks = 9999;
        if (def.id === 'Whip') {
          // Face player so front shield is actively pointed at player (Whip must bypass it!)
          enemy.facing = -1;
        }

        // Set up weapon-specific crit preconditions
        if (def.critCondition === 'backstab') {
          enemy.facing = 1;
          enemy.stunTicks = 40;
          enemy.state = 'stunned';
        } else if (def.critCondition === 'frozenOrRooted') {
          applyStatus(enemy.statusEffects, 'root', 240, 0, 0);
        } else if (def.critCondition === 'speedBuff') {
          state.player.speedBuffTicks = 240;
        } else if (def.critCondition === 'highCombo') {
          state.player.killStreak = 5;
        } else if (def.critCondition === 'afterRoll') {
          // Execute a full dodge roll forward right up to the enemy!
          stepAndCollect(state, 26, (t) => ({ rollPressed: t === 0 }));
          enemy.pos.x = state.player.pos.x + 28;
          enemy.vel.x = 0;
        }

        const startHp = enemy.hp;
        const startAmmo = gear.ammo;
        const allEvents: SimEvent[] = [];

        const strikesNeeded =
          def.critCondition === 'finalHit'
            ? def.strikeChain.length
            : def.critCondition === 'bleeding' || def.critCondition === 'burning'
              ? 2
              : 1;

        for (let s = 0; s < strikesNeeded; s++) {
          if (def.kind === 'melee' && def.id !== 'ImpaleSpear') {
            enemy.pos.x = state.player.pos.x + 24;
            enemy.vel.x = 0;
          }
          if (def.critCondition === 'backstab') {
            enemy.facing = 1;
            enemy.stunTicks = 30;
          }
          const evs = performSingleMeleeStrike(state, 1);
          allEvents.push(...evs);

          // For ranged projectiles, let projectile travel & impact before next shot
          if (def.kind === 'ranged') {
            const flightEvs = stepAndCollect(state, 22);
            allEvents.push(...flightEvs);
          }
        }

        const totalDmg = startHp - enemy.hp;
        const sawSwing = allEvents.some((e) => e.type === 'attackSwing' && e.weaponId === def.id);
        const sawCrit = allEvents.some((e) => e.type === 'critImpact');
        ctx.metric('totalDamage', totalDmg);
        ctx.metric('sawSwing', sawSwing);
        ctx.metric('sawCrit', sawCrit);

        ctx.check(sawSwing, 'CRITICAL', 'WEAPON_NO_SWING', `${def.id}: attack did not emit attackSwing`);
        ctx.check(totalDmg > 0, 'CRITICAL', 'WEAPON_NO_DAMAGE', `${def.id}: dealt ${totalDmg} damage`);

        if (def.critCondition !== 'none') {
          ctx.check(
            sawCrit,
            'MAJOR',
            'WEAPON_CRIT_FAILED',
            `${def.id}: critCondition="${def.critCondition}" failed to trigger critImpact`
          );
        }

        // Status verification for elemental weapons
        if (def.id === 'Bleeder' || def.id === 'ThrowingKnife') {
          ctx.check(
            hasStatus(enemy.statusEffects, 'bleed'),
            'MAJOR',
            'WEAPON_STATUS_MISSING',
            `${def.id}: failed to inflict bleed`
          );
        } else if (def.id === 'FrostBow') {
          ctx.check(
            hasStatus(enemy.statusEffects, 'freeze') || enemy.state === 'frozen',
            'MAJOR',
            'WEAPON_STATUS_MISSING',
            `${def.id}: failed to freeze target`
          );
        } else if (def.id === 'Fireball') {
          ctx.check(
            hasStatus(enemy.statusEffects, 'burn'),
            'MAJOR',
            'WEAPON_STATUS_MISSING',
            `${def.id}: failed to burn target`
          );
        } else if (def.id === 'Whip') {
          ctx.check(
            hasStatus(enemy.statusEffects, 'electrify'),
            'MAJOR',
            'WEAPON_STATUS_MISSING',
            `Whip: failed to electrify / bypass Shieldbearer`
          );
        }

        // Ammo consumption & regeneration check for ammo-capped ranged weapons
        if (def.ammoCapacity !== undefined && startAmmo !== undefined) {
          const ammoAfterShots = gear.ammo ?? 0;
          ctx.metric('ammoAfterShots', ammoAfterShots);
          ctx.check(
            ammoAfterShots < startAmmo,
            'MAJOR',
            'RANGED_AMMO_NOT_CONSUMED',
            `${def.id}: ammo stayed ${ammoAfterShots}/${startAmmo} after firing`
          );
          // Step 95 ticks to trigger passive ammo regen (every 90 ticks)
          stepAndCollect(state, 95);
          const ammoAfterRegen = gear.ammo ?? 0;
          ctx.metric('ammoAfterRegen', ammoAfterRegen);
          ctx.check(
            ammoAfterRegen > ammoAfterShots,
            'MAJOR',
            'RANGED_AMMO_NO_REGEN',
            `${def.id}: ammo failed to regenerate (${ammoAfterShots} -> ${ammoAfterRegen})`
          );
        }

        ctx.check(findFirstNonFinite(state) === null, 'CRITICAL', 'NAN_STATE', `${def.id}: NaN detected`);
      })
    );
  }

  return out;
}

// =============================================================================
// CATEGORY 3: PT-031 .. PT-042 — All 12 Skills Matrix
// =============================================================================

function runCategory3SkillsMatrix(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '3. All 12 Skills Matrix';

  for (let idx = 0; idx < SKILLS.length; idx++) {
    const def = SKILLS[idx]!;
    const num = 31 + idx;
    const seed = 3000 + num;

    out.push(
      runPlaytester(ptId(num), `Skill Tester: ${def.name} (${def.id})`, CAT, seed, (ctx) => {
        ctx.metric('skillId', def.id);
        ctx.metric('skillKind', def.kind);

        // --- PART A: OPEN EMPTY ROOM TEST ---
        const emptyState = createCombatSandbox(seed);
        const emptyGear = makeGear(emptyState, def.id, 'skill', { color: def.colors[0] ?? 'brutality' });
        emptyState.player.loadout.skill1 = emptyGear;
        const floorY = 15 * TILE_SIZE;

        if (def.id === 'SinewSlicer' || def.id === 'HeavyTurret' || def.id === 'WolfTrap') {
          // Deploy from midair (64px above floor) to strictly validate floor-snapping!
          emptyState.player.pos.y = floorY - PLAYER_HEIGHT * 0.5 - 64;
          emptyState.player.grounded = false;
          emptyState.player.vel = { x: 0, y: 0 };
        }
        if (def.id === 'Tonic') {
          emptyState.player.hp = Math.round(emptyState.player.maxHp * 0.4);
          applyStatus(emptyState.player.statusEffects, 'poison', 200, 12, 0);
        }

        const startXEmpty = emptyState.player.pos.x;
        const startHpEmpty = emptyState.player.hp;
        const emptyEvents = stepAndCollect(emptyState, 90, (t) => ({ skill1Pressed: t === 0 }));

        const sawEmptyCast = emptyEvents.some((e) => e.type === 'skillCast' && e.skillId === def.id);
        ctx.check(sawEmptyCast, 'CRITICAL', 'SKILL_CAST_EVENT_MISSING', `${def.id}: empty-room cast emitted no skillCast`);
        ctx.check(
          emptyGear.cooldownTicks > 0 || def.cooldownTicks <= 90,
          'MAJOR',
          'SKILL_COOLDOWN_NOT_APPLIED',
          `${def.id}: cooldownTicks=${emptyGear.cooldownTicks} after cast`
        );

        // Skill-specific empty-room assertions
        if (def.id === 'SinewSlicer' || def.id === 'HeavyTurret' || def.id === 'WolfTrap') {
          const deployed = emptyState.turrets.filter((t) => t.owner === 'player');
          const minExpected = def.id === 'WolfTrap' ? 2 : 1;
          ctx.check(
            deployed.length >= minExpected,
            'CRITICAL',
            'TURRET_OR_TRAP_NOT_DEPLOYED',
            `${def.id}: expected >= ${minExpected} deployed entity, got ${deployed.length}`
          );
          for (const tur of deployed) {
            const g = inspectTurretGrounding(emptyState, tur);
            ctx.metric('emptyRoomFloorGapPx', Math.round(g.gapPx * 10) / 10);
            ctx.check(
              g.supportTopY !== null && g.tileUnderValid,
              'MAJOR',
              'DEPLOYABLE_NOT_GROUNDED',
              `${def.id}: midair deploy floats ${g.gapPx.toFixed(1)}px above floor (must snap within 16px & 1 tile of solid/one-way)`
            );
          }
        } else if (def.kind === 'grenade') {
          const explosions = emptyEvents.filter((e) => e.type === 'explosion');
          ctx.metric('emptyRoomExplosions', explosions.length);
          ctx.check(
            explosions.length >= 1,
            'MAJOR',
            'GRENADE_EXPLOSION_EVENT_MISSING',
            `${def.id}: empty-room throw produced 0 explosion events`
          );
          if (def.id === 'FireGrenade') {
            ctx.check(
              emptyState.hazards.some((h) => h.kind === 'burningOil'),
              'MAJOR',
              'FIRE_GRENADE_NO_OIL',
              'FireGrenade did not spawn burningOil hazard'
            );
          }
          if (def.id === 'ClusterGrenade') {
            // Cluster splits into 5 sub-grenades -> expect > 1 total explosions!
            ctx.check(
              explosions.length >= 2,
              'MAJOR',
              'CLUSTER_SUB_BOMBS_MISSING',
              `ClusterGrenade emitted ${explosions.length} explosion events (expected primary + sub-bomblets)`
            );
          }
        } else if (def.id === 'Phaser') {
          const movedPx = Math.abs(emptyState.player.pos.x - startXEmpty);
          const sawTp = emptyEvents.some((e) => e.type === 'teleport');
          ctx.metric('emptyRoomBlinkPx', Math.round(movedPx));
          ctx.check(
            movedPx > 40 && sawTp,
            'MAJOR',
            'PHASER_EMPTY_ROOM_DEAD',
            `Phaser in empty room moved only ${movedPx.toFixed(1)}px (teleport=${sawTp}); must blink forward > 40px!`
          );
        } else if (def.id === 'CorruptedPower') {
          ctx.check(
            hasStatus(emptyState.player.statusEffects, 'corrupted'),
            'CRITICAL',
            'CORRUPTED_STATUS_MISSING',
            'CorruptedPower did not apply corrupted status'
          );
        } else if (def.id === 'KnifeDance') {
          // Check on tick 1 immediately in a quick fresh sandbox for exact spawned knife count
          const knifeSnap = createCombatSandbox(seed + 1);
          knifeSnap.player.loadout.skill1 = makeGear(knifeSnap, 'KnifeDance', 'skill');
          stepSim(knifeSnap, inputOf({ skill1Pressed: true }));
          const knives = knifeSnap.projectiles.filter((p) => p.owner === 'player' && p.kind === 'knife');
          ctx.metric('knifeDanceSpawnCount', knives.length);
          ctx.check(
            knives.length >= 8,
            'MAJOR',
            'KNIFE_DANCE_TOO_FEW_KNIVES',
            `KnifeDance spawned ${knives.length} knives (expected >= 8 radial knives)`
          );
        } else if (def.id === 'Tonic') {
          ctx.check(
            emptyState.player.hp > startHpEmpty,
            'CRITICAL',
            'TONIC_NO_HEAL',
            `Tonic failed to heal injured player (${startHpEmpty} -> ${emptyState.player.hp})`
          );
          ctx.check(
            hasStatus(emptyState.player.statusEffects, 'shield'),
            'MAJOR',
            'TONIC_NO_SHIELD',
            'Tonic did not grant shield status'
          );
          ctx.check(
            !hasStatus(emptyState.player.statusEffects, 'poison'),
            'MAJOR',
            'TONIC_NO_CLEANSE',
            'Tonic failed to purge negative poison status'
          );
        }

        // --- PART B: ENEMY NEARBY COMBAT TEST ---
        const combatState = createCombatSandbox(seed + 100);
        const rng = createRng(seed + 100);
        combatState.player.loadout.skill1 = makeGear(combatState, def.id, 'skill', {
          color: def.colors[0] ?? 'brutality',
        });
        combatState.player.godMode = def.id !== 'Tonic';

        if (def.id === 'SinewSlicer' || def.id === 'HeavyTurret') {
          const foe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 115, combatState.player.pos.y, 0, rng);
          foe.attackCooldownTicks = 9999;
          const hpBefore = foe.hp;
          stepAndCollect(combatState, 70, (t) => ({ skill1Pressed: t === 0 }));
          ctx.metric('combatDamage', hpBefore - foe.hp);
          ctx.check(
            foe.hp < hpBefore,
            'CRITICAL',
            'TURRET_NO_COMBAT_DAMAGE',
            `${def.id}: turret failed to shoot & damage enemy (${hpBefore} -> ${foe.hp})`
          );
        } else if (def.id === 'WolfTrap') {
          const foe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 28, combatState.player.pos.y, 0, rng);
          foe.attackCooldownTicks = 9999;
          const hpBefore = foe.hp;
          stepAndCollect(combatState, 20, (t) => ({ skill1Pressed: t === 0 }));
          ctx.metric('wolfTrapRooted', hasStatus(foe.statusEffects, 'root'));
          ctx.metric('wolfTrapDamage', hpBefore - foe.hp);
          ctx.check(
            hasStatus(foe.statusEffects, 'root') && foe.hp < hpBefore,
            'CRITICAL',
            'WOLF_TRAP_FAILED',
            `WolfTrap failed to root & damage enemy (rooted=${hasStatus(foe.statusEffects, 'root')}, dmg=${hpBefore - foe.hp})`
          );
        } else if (def.kind === 'grenade') {
          const foe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 140, combatState.player.pos.y, 0, rng);
          foe.attackCooldownTicks = 9999;
          const hpBefore = foe.hp;
          const evs = stepAndCollect(combatState, 100, (t) => ({ skill1Pressed: t === 0 }));
          ctx.metric('combatDamage', hpBefore - foe.hp);
          ctx.check(
            foe.hp < hpBefore,
            'CRITICAL',
            'GRENADE_COMBAT_MISS',
            `${def.id}: dealt 0 damage to enemy in blast range`
          );
          if (def.id === 'IceGrenade') {
            ctx.check(
              hasStatus(foe.statusEffects, 'freeze') || hasStatus(foe.statusEffects, 'slow') || foe.state === 'frozen',
              'MAJOR',
              'ICE_GRENADE_NO_FREEZE',
              'IceGrenade did not freeze target'
            );
          } else if (def.id === 'FireGrenade') {
            ctx.check(
              hasStatus(foe.statusEffects, 'burn') && combatState.hazards.some((h) => h.kind === 'burningOil'),
              'MAJOR',
              'FIRE_GRENADE_NO_BURN_OIL',
              'FireGrenade did not ignite target and spawn burningOil'
            );
          }
          void evs;
        } else if (def.id === 'Phaser') {
          const foe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 100, combatState.player.pos.y, 0, rng);
          foe.facing = -1; // Facing player on left -> behind enemy is to its right (+x)
          foe.attackCooldownTicks = 9999;
          const hpBefore = foe.hp;
          const evs = stepAndCollect(combatState, 4, (t) => ({ skill1Pressed: t === 0 }));
          const teleportedBehind = combatState.player.pos.x > foe.pos.x;
          ctx.metric('phaserBehindEnemy', teleportedBehind);
          ctx.check(
            teleportedBehind && evs.some((e) => e.type === 'teleport') && foe.hp < hpBefore,
            'CRITICAL',
            'PHASER_COMBAT_TP_FAILED',
            `Phaser failed to teleport behind & damage enemy (playerX=${combatState.player.pos.x}, foeX=${foe.pos.x}, dmg=${hpBefore - foe.hp})`
          );
        } else if (def.id === 'WaveOfDenial') {
          const foe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 48, combatState.player.pos.y, 0, rng);
          foe.attackCooldownTicks = 9999;
          const foeStartX = foe.pos.x;
          const foeHpBefore = foe.hp;
          const bolt = spawnEnemyProjectile(combatState, combatState.player.pos.x + 56, combatState.player.pos.y, -220, 0, 25, true);
          stepAndCollect(combatState, 12, (t) => ({ skill1Pressed: t === 0 }));
          ctx.metric('waveReflected', bolt.owner === 'player');
          ctx.metric('waveKnockbackPx', Math.round(foe.pos.x - foeStartX));
          ctx.check(
            bolt.owner === 'player' && bolt.vel.x > 0,
            'CRITICAL',
            'WAVE_REFLECT_FAILED',
            'WaveOfDenial failed to reflect enemy projectile'
          );
          ctx.check(
            foe.hp < foeHpBefore && foe.pos.x > foeStartX + 12,
            'MAJOR',
            'WAVE_KNOCKBACK_FAILED',
            `WaveOfDenial knockback/dmg insufficient (dx=${(foe.pos.x - foeStartX).toFixed(1)}, dmg=${foeHpBefore - foe.hp})`
          );
        } else if (def.id === 'CorruptedPower') {
          // Compare single StartSword melee hitImpact damage baseline vs with CorruptedPower active!
          const baseState = createCombatSandbox(seed + 101);
          const baseFoe = spawnEnemy(baseState, 'CastleKnight', baseState.player.pos.x + 24, baseState.player.pos.y, 0, createRng(seed + 101));
          baseFoe.attackCooldownTicks = 9999;
          const baseEvs = performSingleMeleeStrike(baseState, 1);
          const baseHit = baseEvs.find((e) => e.type === 'hitImpact' || e.type === 'critImpact');
          const baseDmg = baseHit && (baseHit.type === 'hitImpact' || baseHit.type === 'critImpact') ? baseHit.damage : 0;

          // First verify CorruptedPower cast aura damages a nearby enemy
          const auraFoe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 40, combatState.player.pos.y, 0, rng);
          auraFoe.attackCooldownTicks = 9999;
          const auraBefore = auraFoe.hp;
          stepSim(combatState, inputOf({ skill1Pressed: true }));
          const auraDmg = auraBefore - auraFoe.hp;
          // Clear auraFoe and spawn fresh foe so electrify DoT doesn't mix with pure melee hitImpact measurement
          combatState.enemies = [];
          const meleeFoe = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 24, combatState.player.pos.y, 0, rng);
          meleeFoe.attackCooldownTicks = 9999;
          const buffEvs = performSingleMeleeStrike(combatState, 1);
          const buffHit = buffEvs.find((e) => e.type === 'hitImpact' || e.type === 'critImpact');
          const buffedDmg = buffHit && (buffHit.type === 'hitImpact' || buffHit.type === 'critImpact') ? buffHit.damage : 0;

          ctx.metric('auraDmg', auraDmg);
          ctx.metric('baseDmg', baseDmg);
          ctx.metric('corruptedDmg', buffedDmg);
          ctx.check(auraDmg > 0, 'MAJOR', 'CORRUPTED_AURA_NO_DMG', 'CorruptedPower shock aura dealt 0 damage');
          ctx.check(
            baseDmg > 0 && buffedDmg > baseDmg * 1.35,
            'MAJOR',
            'CORRUPTED_NO_DMG_BUFF',
            `CorruptedPower did not boost melee damage ~1.5x (base=${baseDmg}, buffed=${buffedDmg})`
          );
        } else if (def.id === 'KnifeDance') {
          const foeL = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x - 42, combatState.player.pos.y, 0, rng);
          const foeR = spawnEnemy(combatState, 'CastleKnight', combatState.player.pos.x + 42, combatState.player.pos.y, 0, rng);
          foeL.attackCooldownTicks = 9999;
          foeR.attackCooldownTicks = 9999;
          const totalBefore = foeL.hp + foeR.hp;
          stepAndCollect(combatState, 24, (t) => ({ skill1Pressed: t === 0 }));
          const dmgDealt = totalBefore - (foeL.hp + foeR.hp);
          const bled = hasStatus(foeL.statusEffects, 'bleed') || hasStatus(foeR.statusEffects, 'bleed');
          ctx.metric('knifeDanceDamage', dmgDealt);
          ctx.check(
            dmgDealt > 0 && bled,
            'CRITICAL',
            'KNIFE_DANCE_COMBAT_FAILED',
            `KnifeDance failed to hit & bleed enemies (dmg=${dmgDealt}, bled=${bled})`
          );
        } else if (def.id === 'Tonic') {
          combatState.player.hp = 50;
          stepSim(combatState, inputOf({ skill1Pressed: true }));
          const hpAfterTonic = combatState.player.hp;
          combatState.player.iframeTicks = 0;
          const hitLanded = damagePlayer(combatState, 40, 'Zombie', rng, true);
          ctx.check(
            !hitLanded && combatState.player.hp === hpAfterTonic,
            'MAJOR',
            'TONIC_SHIELD_NO_PROTECTION',
            `Tonic shield failed to block incoming hit (hitLanded=${hitLanded})`
          );
        }

        ctx.check(findFirstNonFinite(emptyState) === null && findFirstNonFinite(combatState) === null, 'CRITICAL', 'NAN_STATE', `${def.id}: NaN detected`);
      })
    );
  }

  return out;
}

// =============================================================================
// CATEGORY 4: PT-043 .. PT-057 — All 15 Mutations Matrix
// =============================================================================

function runCategory4MutationsMatrix(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '4. All 15 Mutations Matrix';

  for (let idx = 0; idx < MUTATIONS.length; idx++) {
    const mut = MUTATIONS[idx]!;
    const num = 43 + idx;
    const seed = 4000 + num;

    out.push(
      runPlaytester(ptId(num), `Mutation Tester: ${mut.name} (${mut.id})`, CAT, seed, (ctx) => {
        ctx.metric('mutationId', mut.id);
        ctx.metric('color', mut.color);

        const runPairMeleeDamage = (setupFn: (s: SimState, withMut: boolean) => void): { base: number; withMut: number } => {
          const measure = (withMut: boolean): number => {
            const s = createCombatSandbox(seed + (withMut ? 1 : 0));
            const rng = createRng(seed + 9);
            s.player.godMode = true;
            if (withMut) s.player.mutations = [mut.id];
            setupFn(s, withMut);
            const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 24, s.player.pos.y, 0, rng);
            foe.attackCooldownTicks = 9999;
            const before = foe.hp;
            performSingleMeleeStrike(s, 1);
            return before - foe.hp;
          };
          return { base: measure(false), withMut: measure(true) };
        };

        switch (mut.id) {
          case 'Combo': {
            const { base, withMut } = runPairMeleeDamage((s) => {
              const rng = createRng(seed + 2);
              const fodder = spawnEnemy(s, 'BatKamikaze', s.player.pos.x + 20, s.player.pos.y, 0, rng);
              damageEnemy(s, fodder, 999, false, 10, 0, 0, rng, 'StartSword');
            });
            ctx.metric('baseDmg', base);
            ctx.metric('mutDmg', withMut);
            ctx.check(withMut > base * 1.2, 'MAJOR', 'MUT_COMBO_FAILED', `Combo failed to boost melee dmg (base=${base}, mut=${withMut})`);
            break;
          }

          case 'OpenWounds': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            s.player.mutations = ['OpenWounds'];
            const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 24, s.player.pos.y, 0, rng);
            foe.attackCooldownTicks = 9999;
            performSingleMeleeStrike(s, 1);
            ctx.check(hasStatus(foe.statusEffects, 'bleed'), 'MAJOR', 'MUT_OPEN_WOUNDS_FAILED', 'OpenWounds did not apply bleed on melee hit');
            break;
          }

          case 'Melee': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            s.player.mutations = ['Melee'];
            const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 24, s.player.pos.y, 0, rng);
            foe.attackCooldownTicks = 9999;
            performSingleMeleeStrike(s, 1);
            ctx.check(
              hasStatus(foe.statusEffects, 'slow') && hasStatus(foe.statusEffects, 'frost'),
              'MAJOR',
              'MUT_MELEE_FAILED',
              'Melee mutation did not apply slow + frost'
            );
            break;
          }

          case 'Predator': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            s.player.mutations = ['Predator'];
            const fodder = spawnEnemy(s, 'BatKamikaze', s.player.pos.x + 22, s.player.pos.y, 0, rng);
            damageEnemy(s, fodder, 999, false, 10, 0, 0, rng, 'StartSword');
            ctx.metric('speedBuffTicks', s.player.speedBuffTicks);
            ctx.metric('iframeTicks', s.player.iframeTicks);
            ctx.check(
              s.player.speedBuffTicks >= 180 && s.player.iframeTicks >= 20,
              'MAJOR',
              'MUT_PREDATOR_FAILED',
              `Predator failed on melee kill (speed=${s.player.speedBuffTicks}, iframes=${s.player.iframeTicks})`
            );
            break;
          }

          case 'Vengeance': {
            const { base, withMut } = runPairMeleeDamage((s) => {
              const rng = createRng(seed + 4);
              applyScrollPickup(s, 'survival');
              applyScrollPickup(s, 'survival');
              s.player.godMode = false;
              damagePlayer(s, 30, 'Zombie', rng);
              s.player.godMode = true;
            });
            // Also check 25% damage reduction while rallyHp > 0
            const sDrBase = createCombatSandbox(seed + 10);
            const sDrMut = createCombatSandbox(seed + 10);
            sDrMut.player.mutations = ['Vengeance'];
            for (const st of [sDrBase, sDrMut]) {
              applyScrollPickup(st, 'survival');
              applyScrollPickup(st, 'survival');
              damagePlayer(st, 20, 'FirstHit', createRng(seed + 11));
              st.player.iframeTicks = 0;
            }
            const bBefore = sDrBase.player.hp;
            const mBefore = sDrMut.player.hp;
            damagePlayer(sDrBase, 40, 'SecondHit', createRng(seed + 12));
            damagePlayer(sDrMut, 40, 'SecondHit', createRng(seed + 12));
            const dmgBase = bBefore - sDrBase.player.hp;
            const dmgMut = mBefore - sDrMut.player.hp;
            ctx.metric('baseOutDmg', base);
            ctx.metric('vengeanceOutDmg', withMut);
            ctx.metric('baseTakenDmg', dmgBase);
            ctx.metric('vengeanceTakenDmg', dmgMut);
            ctx.check(
              withMut > base * 1.3 && dmgMut < dmgBase,
              'MAJOR',
              'MUT_VENGEANCE_FAILED',
              `Vengeance failed (out ${base}->${withMut}, taken ${dmgBase}->${dmgMut})`
            );
            break;
          }

          case 'Support': {
            const { base, withMut } = runPairMeleeDamage((s) => {
              // Add player SinewSlicer right next to player (no HeavyTurret aura confounding!)
              s.turrets.push({
                uid: s.nextUid++,
                defId: 'SinewSlicer',
                pos: { x: s.player.pos.x - 20, y: s.player.pos.y + 4 },
                hp: 150,
                maxHp: 150,
                damage: 20,
                range: 170,
                fireCooldownTicks: 999,
                ttlTicks: 600,
                facing: 1,
                kind: 'sinew',
                owner: 'player',
              });
            });
            ctx.metric('baseDmg', base);
            ctx.metric('supportDmg', withMut);
            ctx.check(withMut > base * 1.2, 'MAJOR', 'MUT_SUPPORT_FAILED', `Support failed (base=${base}, support=${withMut})`);
            break;
          }

          case 'PointBlank': {
            const measureBow = (withMut: boolean): number => {
              const s = createCombatSandbox(seed + (withMut ? 1 : 0));
              s.player.loadout.weapon1 = makeGear(s, 'CloseCombatBow', 'weapon', { color: 'tactics' });
              if (withMut) s.player.mutations = ['PointBlank'];
              const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 52, s.player.pos.y, 0, createRng(seed));
              foe.attackCooldownTicks = 9999;
              const before = foe.hp;
              performSingleMeleeStrike(s, 1);
              stepAndCollect(s, 18);
              return before - foe.hp;
            };
            const base = measureBow(false);
            const withMut = measureBow(true);
            ctx.metric('baseDmg', base);
            ctx.metric('pointBlankDmg', withMut);
            ctx.check(withMut > base * 1.25, 'MAJOR', 'MUT_POINT_BLANK_FAILED', `PointBlank failed (base=${base}, mut=${withMut})`);
            break;
          }

          case 'BarbedTips': {
            const s = createCombatSandbox(seed);
            s.player.loadout.weapon1 = makeGear(s, 'CloseCombatBow', 'weapon', { color: 'tactics' });
            s.player.mutations = ['BarbedTips'];
            const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 72, s.player.pos.y, 0, createRng(seed));
            foe.attackCooldownTicks = 9999;
            performSingleMeleeStrike(s, 1);
            stepAndCollect(s, 18);
            ctx.check(hasStatus(foe.statusEffects, 'bleed'), 'MAJOR', 'MUT_BARBED_TIPS_FAILED', 'BarbedTips did not apply bleed on arrow hit');
            break;
          }

          case 'Tranquility': {
            const measureLong = (withMut: boolean): number => {
              const s = createCombatSandbox(seed + (withMut ? 1 : 0));
              s.player.loadout.weapon1 = makeGear(s, 'CloseCombatBow', 'weapon', { color: 'tactics' });
              if (withMut) s.player.mutations = ['Tranquility'];
              const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 135, s.player.pos.y, 0, createRng(seed));
              foe.attackCooldownTicks = 9999;
              const before = foe.hp;
              performSingleMeleeStrike(s, 1);
              stepAndCollect(s, 26);
              return before - foe.hp;
            };
            const base = measureLong(false);
            const withMut = measureLong(true);
            ctx.metric('baseDmg', base);
            ctx.metric('tranquilityDmg', withMut);
            ctx.check(withMut > base * 1.2, 'MAJOR', 'MUT_TRANQUILITY_FAILED', `Tranquility failed (base=${base}, mut=${withMut})`);
            break;
          }

          case 'Necromancy': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            applyScrollPickup(s, 'survival');
            s.player.mutations = ['Necromancy'];
            s.player.hp = Math.round(s.player.maxHp * 0.25);
            const hpBefore = s.player.hp;
            const fodder = spawnEnemy(s, 'BatKamikaze', s.player.pos.x + 22, s.player.pos.y, 0, rng);
            damageEnemy(s, fodder, 999, false, 10, 0, 0, rng, 'StartSword');
            ctx.metric('healed', s.player.hp - hpBefore);
            ctx.check(s.player.hp > hpBefore, 'MAJOR', 'MUT_NECROMANCY_FAILED', `Necromancy failed to heal on kill (${hpBefore} -> ${s.player.hp})`);
            break;
          }

          case 'Gastronomy': {
            const measureFood = (withMut: boolean): number => {
              const s = createCombatSandbox(seed + (withMut ? 1 : 0));
              applyScrollPickup(s, 'survival');
              applyScrollPickup(s, 'survival');
              if (withMut) s.player.mutations = ['Gastronomy'];
              s.player.hp = 10;
              s.pickups.push({
                uid: s.nextUid++,
                kind: 'food',
                pos: { x: s.player.pos.x + 6, y: s.player.pos.y },
                prevPos: { x: s.player.pos.x + 6, y: s.player.pos.y },
                vel: { x: 0, y: 0 },
                value: 50,
                magnetTicks: 0,
                collected: false,
                bobPhase: 0,
              });
              stepSim(s, inputOf({ interactPressed: true }));
              return s.player.hp - 10;
            };
            const base = measureFood(false);
            const withMut = measureFood(true);
            ctx.metric('baseFoodHeal', base);
            ctx.metric('gastronomyHeal', withMut);
            ctx.check(withMut > base * 1.5, 'MAJOR', 'MUT_GASTRONOMY_FAILED', `Gastronomy failed (base=${base}, mut=${withMut})`);
            break;
          }

          case 'WhatDoesntKillMe': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            applyScrollPickup(s, 'survival');
            s.player.mutations = ['WhatDoesntKillMe'];
            s.player.hp = Math.round(s.player.maxHp * 0.5);
            const hpBefore = s.player.hp;
            const mob = spawnEnemy(s, 'Zombie', s.player.pos.x + 24, s.player.pos.y, 0, rng);
            stepSim(s, inputOf({ weapon2Pressed: true }));
            attemptShieldParry(s, 20, mob, null, rng);
            ctx.metric('parryHealed', s.player.hp - hpBefore);
            ctx.check(s.player.hp > hpBefore, 'MAJOR', 'MUT_WDKM_FAILED', `WhatDoesntKillMe failed to heal on parry (${hpBefore} -> ${s.player.hp})`);
            break;
          }

          case 'Armadillopack': {
            const s = createCombatSandbox(seed);
            s.player.mutations = ['Armadillopack'];
            const bolt = spawnEnemyProjectile(s, s.player.pos.x + 24, s.player.pos.y, -260, 0, 30, true);
            const hpBefore = s.player.hp;
            const evs = stepAndCollect(s, 10, (t) => ({ rollPressed: t === 0 }));
            ctx.check(
              bolt.owner === 'player' && bolt.isCrit && s.player.hp === hpBefore && evs.some((e) => e.type === 'parrySuccess'),
              'MAJOR',
              'MUT_ARMADILLOPACK_FAILED',
              `Armadillopack roll failed to reflect projectile (owner=${bolt.owner}, hp=${s.player.hp}/${hpBefore})`
            );
            break;
          }

          case 'Disengagement': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            s.player.mutations = ['Disengagement'];
            damagePlayer(s, 95, 'BigHit', rng);
            ctx.metric('hpAfterLethal', s.player.hp);
            ctx.metric('hasShield', hasStatus(s.player.statusEffects, 'shield'));
            ctx.check(
              s.player.hp >= 1 && s.runStatus === 'playing' && hasStatus(s.player.statusEffects, 'shield') && s.player.disengagementCooldownTicks > 0,
              'MAJOR',
              'MUT_DISENGAGEMENT_FAILED',
              `Disengagement failed (hp=${s.player.hp}, status=${s.runStatus}, shield=${hasStatus(s.player.statusEffects, 'shield')})`
            );
            break;
          }

          case 'InstinctOfTheMaster': {
            const s = createCombatSandbox(seed);
            const rng = createRng(seed);
            s.player.mutations = ['InstinctOfTheMaster'];
            s.player.loadout.weapon1 = makeGear(s, 'BackStabber', 'weapon', { color: 'brutality' });
            s.player.loadout.skill1 = makeGear(s, 'InfantryGrenade', 'skill', { cooldownTicks: 300 });
            const foe = spawnEnemy(s, 'CastleKnight', s.player.pos.x + 20, s.player.pos.y, 0, rng);
            foe.facing = 1;
            foe.stunTicks = 30;
            foe.state = 'stunned';
            performSingleMeleeStrike(s, 1);
            const cdAfter = s.player.loadout.skill1.cooldownTicks;
            ctx.metric('cooldownBefore', 300);
            ctx.metric('cooldownAfter', cdAfter);
            ctx.check(
              cdAfter <= 250,
              'MAJOR',
              'MUT_INSTINCT_FAILED',
              `InstinctOfTheMaster did not reduce cooldown on crit (300 -> ${cdAfter})`
            );
            break;
          }
        }
      })
    );
  }

  return out;
}

// =============================================================================
// CATEGORY 5: PT-058 .. PT-077 — All 10 Biomes + Passage & Traversal Stress
// =============================================================================

function runCategory5BiomesAndPassage(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '5. All 10 Biomes + Passage Stress';

  const biomeSeeds: { pt: number; biome: BiomeId; seed: number; label: string }[] = [
    { pt: 58, biome: 'PrisonStart', seed: 58011, label: "Prisoner's Quarters (Seed A)" },
    { pt: 59, biome: 'PrisonStart', seed: 59029, label: "Prisoner's Quarters (Seed B)" },
    { pt: 60, biome: 'PrisonCourtyard', seed: 60037, label: 'Promenade of the Condemned (Seed A)' },
    { pt: 61, biome: 'PrisonCourtyard', seed: 61051, label: 'Promenade of the Condemned (Seed B)' },
    { pt: 62, biome: 'Sewer', seed: 62073, label: 'Toxic Sewers (Seed A)' },
    { pt: 63, biome: 'Sewer', seed: 63089, label: 'Toxic Sewers (Seed B)' },
    { pt: 64, biome: 'PrisonRoof', seed: 64103, label: 'Ramparts (Seed A)' },
    { pt: 65, biome: 'PrisonRoof', seed: 65127, label: 'Ramparts (Seed B)' },
    { pt: 66, biome: 'Bridge', seed: 66141, label: 'Black Bridge Boss Arena' },
    { pt: 67, biome: 'StiltVillage', seed: 67163, label: 'Stilt Village (Seed A)' },
    { pt: 68, biome: 'StiltVillage', seed: 68189, label: 'Stilt Village (Seed B)' },
    { pt: 69, biome: 'ClockTower', seed: 69203, label: 'Clock Tower (Seed A)' },
    { pt: 70, biome: 'ClockTower', seed: 70229, label: 'Clock Tower (Seed B)' },
    { pt: 71, biome: 'TopClockTower', seed: 71247, label: 'Clock Room Boss Arena' },
    { pt: 72, biome: 'Castle', seed: 72263, label: 'High Peak Castle (Seed A)' },
    { pt: 73, biome: 'Castle', seed: 73289, label: 'High Peak Castle (Seed B)' },
    { pt: 74, biome: 'Throne', seed: 74307, label: 'Throne Room Boss Arena' },
  ];

  for (const cfg of biomeSeeds) {
    out.push(
      runPlaytester(ptId(cfg.pt), `Biome Explorer: ${cfg.label}`, CAT, cfg.seed, (ctx) => {
        const state = createInitialSimState(cfg.seed, 0);
        if (cfg.biome !== 'PrisonStart') {
          warpToBiome(state, cfg.biome);
        }
        const biomeDef = getBiome(cfg.biome);
        ctx.metric('biomeId', cfg.biome);
        ctx.metric('rooms', state.rooms.length);
        ctx.metric('enemies', state.enemies.length);

        // 1. Player spawn grounded, never embedded in solid, never falling into void
        const spawnTx = Math.floor(state.player.pos.x / TILE_SIZE);
        const spawnTy = Math.floor(state.player.pos.y / TILE_SIZE);
        const spawnTile = collisionApi.getTile(state.tileGrid, spawnTx, spawnTy);
        ctx.check(
          spawnTile !== TileKind.SOLID,
          'CRITICAL',
          'PLAYER_SPAWN_IN_SOLID',
          `${cfg.biome}: player spawned inside SOLID tile (${spawnTx},${spawnTy})`
        );

        state.player.godMode = true;
        stepAndCollect(state, 10); // Settle on floor
        ctx.check(
          state.player.grounded,
          'CRITICAL',
          'PLAYER_SPAWN_NOT_GROUNDED',
          `${cfg.biome}: player not grounded after 10 settle ticks (pos=${state.player.pos.x.toFixed(1)},${state.player.pos.y.toFixed(1)})`
        );

        // 2. Active traversal stress (90 ticks run/jump/roll) — zero NaN / zero void fall
        const maxX = state.tileGrid.width * TILE_SIZE;
        const maxY = state.tileGrid.height * TILE_SIZE;
        stepAndCollect(state, 90, (t) => ({
          moveRight: t < 50,
          moveLeft: t >= 50,
          jump: t % 28 < 8,
          jumpPressed: t % 28 === 0,
          rollPressed: t === 35 || t === 70,
        }));
        const nanIssue = findFirstNonFinite(state);
        ctx.check(nanIssue === null, 'CRITICAL', 'BIOME_NAN_STATE', `${cfg.biome}: ${nanIssue}`);
        ctx.check(
          state.player.pos.x > TILE_SIZE &&
            state.player.pos.x < maxX - TILE_SIZE &&
            state.player.pos.y > TILE_SIZE &&
            state.player.pos.y < maxY - TILE_SIZE,
          'CRITICAL',
          'BIOME_PLAYER_OOB',
          `${cfg.biome}: player escaped bounds (${state.player.pos.x.toFixed(1)},${state.player.pos.y.toFixed(1)})`
        );

        // 3. Verify enemies exist & non-flying enemies are grounded (not embedded / out of bounds)
        ctx.check(
          state.enemies.length > 0,
          'CRITICAL',
          'BIOME_NO_ENEMIES',
          `${cfg.biome}: 0 enemies spawned`
        );
        let ungroundedMobs = 0;
        let solidEmbeddedMobs = 0;
        for (const e of state.enemies) {
          if (e.state === 'dead' || e.hp <= 0) continue;
          const etx = Math.floor(e.pos.x / TILE_SIZE);
          const ety = Math.floor(e.pos.y / TILE_SIZE);
          if (collisionApi.getTile(state.tileGrid, etx, ety) === TileKind.SOLID) {
            solidEmbeddedMobs += 1;
          }
          if (!e.isBoss) {
            const def = getEnemy(e.defId);
            if (!def.flying && !e.grounded) {
              // Check if floor is directly underneath within 1.5 tiles (e.g., mid-hop lunge)
              const below1 = collisionApi.isSolidAt(state.tileGrid, etx, ety + 1) || collisionApi.isOneWayAt(state.tileGrid, etx, ety + 1);
              const below2 = collisionApi.isSolidAt(state.tileGrid, etx, ety + 2) || collisionApi.isOneWayAt(state.tileGrid, etx, ety + 2);
              if (!below1 && !below2) ungroundedMobs += 1;
            }
          }
        }
        ctx.check(
          solidEmbeddedMobs === 0,
          'MAJOR',
          'ENEMY_IN_SOLID_TILE',
          `${cfg.biome}: ${solidEmbeddedMobs} enemies embedded inside SOLID tiles`
        );
        ctx.check(
          ungroundedMobs === 0,
          'MAJOR',
          'ENEMY_UNGROUNDED',
          `${cfg.biome}: ${ungroundedMobs} ground enemies floating over void`
        );

        if (!biomeDef.isBossArena) {
          // 4. Verify exits, chests, doors, teleporters, and BFS reachability
          const exitDoors = state.doors.filter((d) => d.kind === 'biomeExit');
          ctx.metric('exitDoors', exitDoors.length);
          ctx.metric('chests', state.chests.length);
          ctx.metric('teleporters', state.teleporters.length);
          ctx.check(exitDoors.length >= 1, 'CRITICAL', 'BIOME_NO_EXIT', `${cfg.biome}: missing biomeExit door`);
          ctx.check(state.teleporters.length >= 1, 'MAJOR', 'BIOME_NO_TELEPORTER', `${cfg.biome}: missing teleporters`);
          ctx.check(state.chests.length >= 1, 'MAJOR', 'BIOME_NO_CHEST', `${cfg.biome}: missing chests`);

          const targets: { label: string; pos: Vec2 }[] = [];
          for (const d of exitDoors) targets.push({ label: `exit:${d.uid}`, pos: d.pos });
          for (const c of state.chests) targets.push({ label: `chest:${c.uid}`, pos: c.pos });
          for (const tp of state.teleporters) targets.push({ label: `tp:${tp.uid}`, pos: tp.pos });
          const bfs = verifyWorldReachability(state.tileGrid, state.rooms, state.player.pos, targets);
          ctx.check(
            bfs.reachable,
            'CRITICAL',
            'BIOME_UNREACHABLE_TARGETS',
            `${cfg.biome}: unreachable targets [${bfs.missing.join(', ')}]`
          );

          // 5. Combat kills award gold, cells, and killStreak
          for (let s = 0; s < 10; s++) applyScrollPickup(state, 'brutality');
          const killsBefore = state.runKills;
          const streakBefore = state.player.killStreak;
          // Engage up to 5 non-protected enemies cleanly so cell roll (55% per mob) & gold drop collect
          const candidates = state.enemies
            .filter((e) => e.state !== 'dead' && e.hp > 0 && e.defId !== 'Protector' && e.protectedByUid === null)
            .slice(0, 5);
          for (const foe of candidates) {
            // Stand on enemy's floor at safe melee offset
            const safeX = foe.pos.x - 18;
            const safeTx = Math.floor(safeX / TILE_SIZE);
            const safeTy = Math.floor(foe.pos.y / TILE_SIZE);
            state.player.pos.x = collisionApi.isSolidAt(state.tileGrid, safeTx, safeTy) ? foe.pos.x + 18 : safeX;
            state.player.pos.y = foe.pos.y;
            state.player.facing = foe.pos.x >= state.player.pos.x ? 1 : -1;
            for (let attempt = 0; attempt < 6 && foe.hp > 0 && foe.state !== 'dead'; attempt++) {
              performSingleMeleeStrike(state, 1);
            }
            // Wait 28 ticks for gold/cell drops to magnetize and auto-collect
            stepAndCollect(state, 28);
          }
          ctx.metric('kills', state.runKills - killsBefore);
          ctx.metric('goldEarned', state.totalGoldEarned);
          ctx.metric('cellsEarned', state.totalCellsEarned);
          ctx.metric('killStreak', state.player.killStreak);
          ctx.check(
            state.runKills > killsBefore && state.player.killStreak > streakBefore,
            'MAJOR',
            'COMBAT_KILL_STREAK_FAILED',
            `${cfg.biome}: killing enemies failed to increment runKills/killStreak`
          );
          ctx.check(
            state.totalGoldEarned > 0,
            'MAJOR',
            'COMBAT_NO_GOLD_AWARDED',
            `${cfg.biome}: killing enemies awarded 0 gold`
          );
          ctx.check(
            state.totalCellsEarned > 0 || state.pickups.some((p) => p.kind === 'cell'),
            'MINOR',
            'COMBAT_NO_CELLS_DROPPED',
            `${cfg.biome}: 0 cells dropped across ${candidates.length} kills`
          );
        } else {
          // Boss arena checks
          ctx.check(
            state.bossArenaState.active && state.enemies.some((e) => e.isBoss && e.bossId === biomeDef.bossId),
            'CRITICAL',
            'BOSS_ARENA_NO_BOSS',
            `${cfg.biome}: boss ${biomeDef.bossId} did not spawn or arena inactive`
          );
        }
      })
    );
  }

  // PT-075: Passage Safe Room Full NPC Workflow (0BC)
  out.push(
    runPlaytester(ptId(75), 'Passage Quartermaster (0BC All NPCs)', CAT, 75011, (ctx) => {
      const state = createInitialSimState(75011, 0);
      const rng = createRng(75011);
      state.player.hp = 35;
      state.player.flaskCharges = 0;
      state.player.cells = 100;
      state.player.gold = 5000;
      warpToBiome(state, 'Passage');

      const shrineKinds = new Set(state.shrines.map((s) => s.kind));
      ctx.check(
        shrineKinds.has('collector') &&
          shrineKinds.has('guillain') &&
          shrineKinds.has('forge') &&
          shrineKinds.has('fountain'),
        'CRITICAL',
        'PASSAGE_MISSING_NPCS',
        `Missing Passage NPCs: found [${[...shrineKinds].join(', ')}]`
      );

      // 1. Fountain -> full HP + full flask
      stepSim(state, inputOf({ commands: [{ type: 'useFountain' }] }));
      ctx.check(
        state.player.hp === state.player.maxHp && state.player.flaskCharges === state.player.maxFlaskCharges,
        'MAJOR',
        'PASSAGE_FOUNTAIN_FAILED',
        `0BC Fountain failed (hp=${state.player.hp}/${state.player.maxHp}, flask=${state.player.flaskCharges})`
      );

      // 2. Collector -> unlock Health Flask tier 2 + BackStabber weapon
      stepSim(
        state,
        inputOf({
          commands: [
            { type: 'collectorInvest', blueprintId: 'health_flask', amount: 25 },
            { type: 'collectorInvest', blueprintId: 'bp_BackStabber', amount: 25 },
          ],
        })
      );
      ctx.check(
        state.metaSnapshot.flaskTier === 2 && state.metaSnapshot.unlockedBlueprints.includes('BackStabber'),
        'MAJOR',
        'PASSAGE_COLLECTOR_FAILED',
        `Collector unlock failed (flaskTier=${state.metaSnapshot.flaskTier})`
      );

      // 3. Guillain -> equip & respec mutations
      stepSim(
        state,
        inputOf({
          commands: [
            { type: 'pickMutation', mutationId: 'Combo' },
            { type: 'pickMutation', mutationId: 'Necromancy' },
          ],
        })
      );
      ctx.check(
        state.player.mutations.length === 2,
        'MAJOR',
        'PASSAGE_GUILLAIN_FAILED',
        `Guillain pickMutation failed (${state.player.mutations.join(',')})`
      );
      stepSim(state, inputOf({ commands: [{ type: 'respecMutations' }] }));
      ctx.check(state.player.mutations.length === 0, 'MAJOR', 'PASSAGE_RESPEC_FAILED', 'respecMutations did not clear mutations');

      // 4. Minor Forge -> upgrade quality base -> + and reforge affixes
      stepSim(state, inputOf({ commands: [{ type: 'forgeUpgrade', slot: 'weapon1' }] }));
      ctx.check(
        state.player.loadout.weapon1?.quality === '+',
        'MAJOR',
        'PASSAGE_FORGE_UPGRADE_FAILED',
        `Forge upgrade failed (quality=${state.player.loadout.weapon1?.quality})`
      );
      const reforgeBefore = state.passageState.reforgeCount;
      stepSim(state, inputOf({ commands: [{ type: 'forgeReforge', slot: 'weapon1' }] }));
      ctx.check(
        state.passageState.reforgeCount === reforgeBefore + 1,
        'MAJOR',
        'PASSAGE_FORGE_REFORGE_FAILED',
        'Forge reforge failed'
      );

      // 5. Exit Passage -> PrisonCourtyard
      stepSim(state, inputOf({ commands: [{ type: 'enterBiome', biomeId: 'PrisonCourtyard' }] }));
      ctx.check(
        state.activeBiomeId === 'PrisonCourtyard' && state.runStatus === 'playing',
        'CRITICAL',
        'PASSAGE_EXIT_FAILED',
        `Failed to exit Passage into PrisonCourtyard (biome=${state.activeBiomeId}, status=${state.runStatus})`
      );
      void rng;
    })
  );

  // PT-076: Passage Bonus Doors (Timed + 30-Kill Streak) & 2BC Fountain
  out.push(
    runPlaytester(ptId(76), 'Passage Speedrunner (2BC Bonus Doors)', CAT, 76023, (ctx) => {
      const state = createInitialSimState(76023, 2);
      const rng = createRng(76023);
      state.player.maxFlaskCharges = 3;
      state.player.flaskCharges = 0;
      state.player.hp = 30;
      state.player.runTimerTicks = 60 * 60; // 1:00 (< 2:00 timed door!)
      state.player.killStreak = 35; // >= 30 kill streak!
      enterPassageRoom(state, 'PrisonStart', ['PrisonCourtyard', 'Sewer'], rng);

      ctx.check(
        state.passageState.timedDoorOpen && state.passageState.killStreakDoorOpen,
        'MAJOR',
        'PASSAGE_BONUS_DOORS_CLOSED',
        `Bonus doors failed to open (timed=${state.passageState.timedDoorOpen}, streak=${state.passageState.killStreakDoorOpen})`
      );
      ctx.check(
        state.pickups.length >= 6,
        'MAJOR',
        'PASSAGE_BONUS_REWARDS_MISSING',
        `Expected >= 6 bonus pickups, got ${state.pickups.length}`
      );
      const used = handlePassageCommand(state, { type: 'useFountain' }, rng);
      ctx.check(
        used && state.player.flaskCharges === 1,
        'MAJOR',
        'PASSAGE_2BC_FOUNTAIN_WRONG',
        `2BC single flask refill failed (used=${used}, charges=${state.player.flaskCharges})`
      );
    })
  );

  // PT-077: Passage 4BC Shattered Fountain + Multi-Biome Groundedness
  out.push(
    runPlaytester(ptId(77), 'Hell-Tier Passage Veteran (4BC)', CAT, 77039, (ctx) => {
      const state = createInitialSimState(77039, 4);
      const rng = createRng(77039);
      state.player.maxFlaskCharges = 4;
      state.player.flaskCharges = 0;
      state.player.hp = 25;
      warpToBiome(state, 'Passage');
      stepAndCollect(state, 5);
      ctx.check(state.player.grounded, 'MAJOR', 'PASSAGE_NOT_GROUNDED', 'Player not grounded in Passage');
      const used = handlePassageCommand(state, { type: 'useFountain' }, rng);
      ctx.check(
        !used && state.player.flaskCharges === 0 && state.player.hp === 25,
        'MAJOR',
        'PASSAGE_4BC_FOUNTAIN_NOT_SHATTERED',
        `4BC shattered fountain still worked (used=${used}, flask=${state.player.flaskCharges})`
      );
      stepSim(state, inputOf({ commands: [{ type: 'enterBiome', biomeId: 'PrisonRoof' }] }));
      ctx.check(
        state.activeBiomeId === 'PrisonRoof' && findFirstNonFinite(state) === null,
        'CRITICAL',
        'PASSAGE_4BC_TRANSITION_FAILED',
        `Transition to PrisonRoof failed`
      );
    })
  );

  return out;
}

// =============================================================================
// CATEGORY 6: PT-078 .. PT-092 — 3 Multi-Phase Bosses & 0BC..5BC Scaling
// =============================================================================

function fightBossToDeath(
  state: SimState,
  boss: EnemyState,
  maxTicks = 1800
): { phasesSeen: Set<number>; killed: boolean; ticksUsed: number } {
  const phasesSeen = new Set<number>([boss.bossPhase]);
  state.player.godMode = true;

  for (let t = 0; t < maxTicks; t++) {
    if (boss.state === 'dead' || boss.hp <= 0) {
      return { phasesSeen, killed: true, ticksUsed: t };
    }
    const dx = boss.pos.x - state.player.pos.x;
    const frame: Partial<InputFrame> = {};
    if (Math.abs(dx) > 32) {
      if (dx > 0) frame.moveRight = true;
      else frame.moveLeft = true;
    } else {
      frame.moveRight = dx >= 0;
      frame.moveLeft = dx < 0;
      if (boss.bossShieldTicks <= 0) {
        frame.weapon1Pressed = t % 4 === 0;
        frame.weapon1Held = true;
      }
    }
    stepSim(state, inputOf(frame));
    for (const ev of state.events) {
      if (ev.type === 'bossPhaseShift' && ev.bossId === boss.bossId) {
        phasesSeen.add(ev.phase);
      }
    }
    phasesSeen.add(boss.bossPhase);
  }
  return { phasesSeen, killed: boss.hp <= 0 || boss.state === 'dead', ticksUsed: maxTicks };
}

function calibrateBossBuild(state: SimState, bossMaxHp: number): void {
  // Give a realistic build whose single swing deals ~8-12% of bossMaxHp so all 3 phases always fire!
  // StartSword avg power ~38. Target ~0.09 * bossMaxHp -> scrolls needed: log1.15(target / 38) + 1
  const targetPerHit = Math.max(90, bossMaxHp * 0.085);
  const multNeeded = targetPerHit / 38;
  const scrolls = Math.max(4, Math.min(24, Math.round(Math.log(multNeeded) / Math.log(1.15)) + 1));
  state.player.scrolls.brutality = scrolls;
  state.player.scrolls.survival = Math.min(8, Math.max(2, Math.floor(scrolls * 0.4)));
  state.player.loadout.weapon1 = makeGear(state, 'StartSword', 'weapon', {
    color: 'brutality',
    level: Math.max(1, Math.min(6, state.bossStemCells + 2)),
    quality: '+',
  });
}

function runCategory6BossesAndScaling(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '6. 3 Bosses & 0BC..5BC Scaling';

  // PT-078..PT-080: Core 0BC Oracle HP + Phase Transitions + Kill & Unlock for all 3 bosses
  const coreBossTests: { pt: number; bossId: BossId; oracleHp: number }[] = [
    { pt: 78, bossId: 'Behemoth', oracleHp: 4000 },
    { pt: 79, bossId: 'TimeKeeper', oracleHp: 2500 },
    { pt: 80, bossId: 'KingsHand', oracleHp: 5900 },
  ];

  for (const cfg of coreBossTests) {
    out.push(
      runPlaytester(ptId(cfg.pt), `0BC Boss Slayer: ${cfg.bossId}`, CAT, 7800 + cfg.pt, (ctx) => {
        const state = createInitialSimState(7800 + cfg.pt, 0);
        state.metaSnapshot.bossCellsUnlocked = 0;
        spawnBossEncounter(state, cfg.bossId);

        const boss = state.enemies.find((e) => e.isBoss && e.bossId === cfg.bossId);
        ctx.check(Boolean(boss), 'CRITICAL', 'BOSS_MISSING', `${cfg.bossId} did not spawn`);
        if (!boss) return;

        ctx.metric('bossMaxHp', boss.maxHp);
        ctx.check(
          boss.maxHp === cfg.oracleHp,
          'CRITICAL',
          'BOSS_ORACLE_HP_MISMATCH',
          `${cfg.bossId} 0BC maxHp=${boss.maxHp}, expected oracle ${cfg.oracleHp}`
        );
        ctx.check(
          state.bossArenaState.active && state.bossArenaState.lockedRightX > state.bossArenaState.lockedLeftX,
          'MAJOR',
          'BOSS_ARENA_NOT_LOCKED',
          `${cfg.bossId} arena lock inactive`
        );

        // Verify horizontal arena lock clamps player from running past lockedLeftX
        const savedX = state.player.pos.x;
        state.player.pos.x = state.bossArenaState.lockedLeftX - 100;
        stepSim(state, inputOf({ moveLeft: true }));
        ctx.check(
          state.player.pos.x >= state.bossArenaState.lockedLeftX,
          'MAJOR',
          'BOSS_ARENA_CLAMP_FAILED',
          `${cfg.bossId} arena did not clamp player inside lockedLeftX`
        );
        state.player.pos.x = savedX;

        calibrateBossBuild(state, boss.maxHp);
        const fight = fightBossToDeath(state, boss);
        // Step 2 more ticks so step.ts exit unlock / Throne victory sync runs
        stepAndCollect(state, 3);

        ctx.metric('phasesSeen', [...fight.phasesSeen].sort().join(','));
        ctx.metric('killed', fight.killed);
        ctx.metric('ticksUsed', fight.ticksUsed);

        ctx.check(fight.killed, 'CRITICAL', 'BOSS_KILL_TIMEOUT', `${cfg.bossId} not defeated in budget`);
        ctx.check(
          fight.phasesSeen.has(1) && fight.phasesSeen.has(2) && fight.phasesSeen.has(3),
          'MAJOR',
          'BOSS_PHASES_SKIPPED',
          `${cfg.bossId} phases seen=[${[...fight.phasesSeen].join(',')}], expected 1,2,3`
        );
        ctx.check(
          state.bossArenaState.defeated && !state.bossArenaState.active,
          'MAJOR',
          'BOSS_DEFEATED_FLAG_MISSING',
          `${cfg.bossId} bossArenaState.defeated not set`
        );

        if (cfg.bossId === 'KingsHand') {
          ctx.check(
            state.runStatus === 'victory' && state.runSummary?.victory === true,
            'CRITICAL',
            'THRONE_VICTORY_FAILED',
            `Killing KingsHand did not trigger victory (runStatus=${state.runStatus})`
          );
          ctx.check(
            state.metaSnapshot.bossCellsUnlocked === 1 && state.runSummary?.unlockedNewBossCell === true,
            'CRITICAL',
            'BOSS_CELL_UNLOCK_FAILED',
            `0BC Throne victory did not unlock 1BC (unlocked=${state.metaSnapshot.bossCellsUnlocked})`
          );
        } else {
          const exitOpen = state.doors.some((d) => (d.kind === 'biomeExit' || d.kind === 'bossGate') && d.opened);
          ctx.check(exitOpen, 'MAJOR', 'BOSS_EXIT_STILL_LOCKED', `${cfg.bossId} exit door stayed locked after kill`);
        }
        ctx.check(findFirstNonFinite(state) === null, 'CRITICAL', 'NAN_STATE', `${cfg.bossId}: NaN detected`);
      })
    );
  }

  // PT-081..PT-085: 1BC .. 5BC Scaling & Progression Tier Audit
  for (let bc = 1; bc <= 5; bc++) {
    const pt = 80 + bc;
    out.push(
      runPlaytester(ptId(pt), `Difficulty Auditor: ${bc}BC Scaling & Progression`, CAT, 8100 + bc, (ctx) => {
        const diff = getDifficulty(bc);
        const prevDiff = getDifficulty(bc - 1);
        ctx.metric('bossCells', bc);
        ctx.metric('mobHpMult', diff.mobHpMult);
        ctx.metric('mobDmgMult', diff.mobDmgMult);

        ctx.check(
          diff.mobHpMult > prevDiff.mobHpMult && diff.mobDmgMult > prevDiff.mobDmgMult,
          'MAJOR',
          'BC_SCALING_NOT_MONOTONIC',
          `${bc}BC mults (${diff.mobHpMult}/${diff.mobDmgMult}) not strictly > ${bc - 1}BC`
        );

        // Verify all 3 bosses scale exact HP & damage for this BC tier
        for (const bossId of ['Behemoth', 'TimeKeeper', 'KingsHand'] as const) {
          const s = createCombatSandbox(8100 + bc * 10, bc);
          const def = BOSS_MAP[bossId];
          const b = spawnBoss(s, bossId, 20 * TILE_SIZE, 13 * TILE_SIZE);
          const expectedHp = Math.round(def.baseHp * diff.mobHpMult);
          const expectedDmg = Math.round(def.baseDamage * diff.mobDmgMult);
          ctx.check(
            b.maxHp === expectedHp && b.damage === expectedDmg,
            'MAJOR',
            'BOSS_BC_SCALING_MISMATCH',
            `${bossId} @ ${bc}BC: got HP=${b.maxHp}/DMG=${b.damage}, expected ${expectedHp}/${expectedDmg}`
          );
        }

        // Verify gear extraLootLevel scales with BC
        const s0 = createCombatSandbox(8199, 0);
        const sBc = createCombatSandbox(8199, bc);
        const g0 = rollGearInstance(s0, createRng(8199), 'weapon', 1);
        const gBc = rollGearInstance(sBc, createRng(8199), 'weapon', 1);
        ctx.check(
          gBc.level === g0.level + diff.extraLootLevel,
          'MAJOR',
          'BC_LOOT_LEVEL_MISMATCH',
          `${bc}BC gear level=${gBc.level}, expected ${g0.level + diff.extraLootLevel}`
        );

        // Verify Throne clear progression at this BC tier
        const sThrone = createInitialSimState(8200 + bc, bc);
        sThrone.metaSnapshot.bossCellsUnlocked = bc;
        spawnBossEncounter(sThrone, 'KingsHand');
        const kh = sThrone.enemies.find((e) => e.bossId === 'KingsHand')!;
        calibrateBossBuild(sThrone, kh.maxHp);
        const res = fightBossToDeath(sThrone, kh);
        stepAndCollect(sThrone, 2);
        const expectedUnlocked = Math.min(MAX_BOSS_CELLS, bc + 1);
        ctx.check(
          res.killed && sThrone.runStatus === 'victory',
          'CRITICAL',
          'BC_THRONE_CLEAR_FAILED',
          `${bc}BC KingsHand victory failed`
        );
        ctx.check(
          sThrone.metaSnapshot.bossCellsUnlocked === expectedUnlocked,
          'MAJOR',
          'BC_NEXT_UNLOCK_WRONG',
          `${bc}BC clear set bossCellsUnlocked=${sThrone.metaSnapshot.bossCellsUnlocked}, expected ${expectedUnlocked}`
        );
      })
    );
  }

  // PT-086..PT-091: High-BC Live Boss Multi-Phase Combat Gauntlets (2BC / 3BC / 5BC)
  const highBcBosses: { pt: number; bossId: BossId; bc: number; label: string }[] = [
    { pt: 86, bossId: 'Behemoth', bc: 2, label: 'Behemoth 2BC Live Choreography' },
    { pt: 87, bossId: 'Behemoth', bc: 5, label: 'Behemoth 5BC Hell Gauntlet' },
    { pt: 88, bossId: 'TimeKeeper', bc: 2, label: 'TimeKeeper 2BC Parry & Phases' },
    { pt: 89, bossId: 'TimeKeeper', bc: 5, label: 'TimeKeeper 5BC Hell Gauntlet' },
    { pt: 90, bossId: 'KingsHand', bc: 3, label: 'KingsHand 3BC Add-Wave & SuperSlam' },
    { pt: 91, bossId: 'KingsHand', bc: 5, label: 'KingsHand 5BC Hell Sovereign Clear' },
  ];

  for (const cfg of highBcBosses) {
    out.push(
      runPlaytester(ptId(cfg.pt), cfg.label, CAT, 8600 + cfg.pt, (ctx) => {
        const state = createInitialSimState(8600 + cfg.pt, cfg.bc);
        state.metaSnapshot.bossCellsUnlocked = cfg.bc;
        spawnBossEncounter(state, cfg.bossId);
        const boss = state.enemies.find((e) => e.bossId === cfg.bossId);
        ctx.check(Boolean(boss), 'CRITICAL', 'BOSS_MISSING', `${cfg.bossId} @ ${cfg.bc}BC failed to spawn`);
        if (!boss) return;

        const expectedHp = Math.round(getBoss(cfg.bossId).baseHp * getDifficulty(cfg.bc).mobHpMult);
        ctx.metric('bossMaxHp', boss.maxHp);
        ctx.check(boss.maxHp === expectedHp, 'MAJOR', 'BOSS_HP_SCALING_OFF', `HP=${boss.maxHp} != ${expectedHp}`);

        // For TimeKeeper 2BC, also verify shuriken projectile parry reflection works!
        if (cfg.pt === 88) {
          const shuriken = spawnEnemyProjectile(state, state.player.pos.x + 16, state.player.pos.y, -320, 0, boss.damage, true);
          shuriken.kind = 'shuriken';
          stepSim(state, inputOf({ weapon2Pressed: true }));
          ctx.check(shuriken.owner === 'player' && shuriken.isCrit, 'MAJOR', 'TIMEKEEPER_SHURIKEN_PARRY_FAILED', 'Could not parry TimeKeeper shuriken');
        }

        calibrateBossBuild(state, boss.maxHp);
        const fight = fightBossToDeath(state, boss, 2200);
        stepAndCollect(state, 3);
        ctx.metric('phases', [...fight.phasesSeen].sort().join(','));
        ctx.metric('killed', fight.killed);

        ctx.check(fight.killed, 'CRITICAL', 'HIGH_BC_BOSS_UNDEFEATED', `${cfg.label} timed out`);
        ctx.check(
          fight.phasesSeen.has(1) && fight.phasesSeen.has(2) && fight.phasesSeen.has(3),
          'MAJOR',
          'HIGH_BC_PHASES_INCOMPLETE',
          `${cfg.label} saw phases [${[...fight.phasesSeen].join(',')}]`
        );
        if (cfg.bossId === 'KingsHand') {
          ctx.check(state.runStatus === 'victory', 'CRITICAL', 'HIGH_BC_VICTORY_FAILED', `${cfg.label} did not reach victory`);
        }
        ctx.check(findFirstNonFinite(state) === null, 'CRITICAL', 'NAN_STATE', `${cfg.label}: NaN detected`);
      })
    );
  }

  // PT-092: Boss Arena Exit Lock Before Kill & Passage Transition After Kill
  out.push(
    runPlaytester(ptId(92), 'Boss Arena Gatekeeper', CAT, 9200, (ctx) => {
      for (const bossId of ['Behemoth', 'TimeKeeper'] as const) {
        const state = createInitialSimState(9200 + (bossId === 'Behemoth' ? 1 : 2), 0);
        spawnBossEncounter(state, bossId);
        const exitDoor = state.doors.find((d) => d.kind === 'biomeExit');
        ctx.check(Boolean(exitDoor), 'CRITICAL', 'BOSS_ARENA_NO_EXIT_DOOR', `${bossId} arena has no biomeExit door`);
        if (!exitDoor) continue;

        // While boss is alive, pressing interact at exit door MUST NOT leave arena!
        state.player.pos.x = exitDoor.pos.x;
        state.player.pos.y = exitDoor.pos.y;
        const arenaBefore = state.activeBiomeId;
        stepSim(state, inputOf({ interactPressed: true }));
        ctx.check(
          state.activeBiomeId === arenaBefore,
          'CRITICAL',
          'BOSS_EXIT_SKIPPED_ALIVE',
          `Player exited ${arenaBefore} while ${bossId} was still alive!`
        );

        // Defeat boss -> let boss-kill slow-mo finish, then interacting with exit door transitions cleanly to Passage!
        const boss = state.enemies.find((e) => e.bossId === bossId)!;
        calibrateBossBuild(state, boss.maxHp);
        const fight = fightBossToDeath(state, boss);
        stepAndCollect(state, 24);
        ctx.check(fight.killed, 'CRITICAL', 'BOSS_KILL_FAILED', `${bossId} failed to die`);

        const unlockedExit = state.doors.find((d) => d.kind === 'biomeExit')!;
        state.player.pos.x = unlockedExit.pos.x;
        state.player.pos.y = unlockedExit.pos.y;
        stepSim(state, inputOf({ interactPressed: true }));
        ctx.check(
          state.activeBiomeId === 'Passage',
          'MAJOR',
          'POST_BOSS_PASSAGE_TRANSITION_FAILED',
          `After defeating ${bossId}, exit door did not enter Passage (activeBiome=${state.activeBiomeId})`
        );
      }
    })
  );

  return out;
}

// =============================================================================
// CATEGORY 7: PT-093 .. PT-100 — Mouse Aim, Input Buffer, Cancel Feel & Replay
// =============================================================================

function runCategory7AimBufferCancelAndReplay(): PlaytesterResult[] {
  const out: PlaytesterResult[] = [];
  const CAT = '7. Aim, Buffer, Cancel & Determinism';

  // PT-093: Mouse Aim for Ranged Weapons (Right, Left & Up-Angle 45°)
  out.push(
    runPlaytester(ptId(93), 'Mouse-Aim Sharpshooter (Bow)', CAT, 9301, (ctx) => {
      const shootWithAim = (dx: number, dy: number): { vx: number; vy: number; facing: 1 | -1 } | null => {
        const s = createCombatSandbox(9301);
        s.player.loadout.weapon1 = makeGear(s, 'CloseCombatBow', 'weapon', { color: 'tactics' });
        s.player.facing = 1; // Always start facing right to test aiming left!
        const aimX = s.player.pos.x + dx;
        const aimY = s.player.pos.y + dy;
        for (let t = 0; t < 16; t++) {
          stepSim(
            s,
            inputOf({
              weapon1Pressed: t === 0,
              aimX,
              aimY,
            })
          );
          const arrow = s.projectiles.find((p) => p.owner === 'player');
          if (arrow) {
            return { vx: arrow.vel.x, vy: arrow.vel.y, facing: s.player.facing };
          }
        }
        return null;
      };

      const rightShot = shootWithAim(140, 0);
      const leftShot = shootWithAim(-140, 0);
      const upRightShot = shootWithAim(100, -100);

      ctx.metric('rightVx', rightShot ? Math.round(rightShot.vx) : 0);
      ctx.metric('leftVx', leftShot ? Math.round(leftShot.vx) : 0);
      ctx.metric('upRightVy', upRightShot ? Math.round(upRightShot.vy) : 0);

      ctx.check(
        rightShot !== null && rightShot.vx > 150,
        'CRITICAL',
        'MOUSE_AIM_RIGHT_FAILED',
        `Aim-right arrow failed (${JSON.stringify(rightShot)})`
      );
      ctx.check(
        leftShot !== null && leftShot.vx < -150 && leftShot.facing === -1,
        'MAJOR',
        'MOUSE_AIM_LEFT_IGNORED',
        `Aiming bow left while facing right fired vx=${leftShot?.vx.toFixed(1)}, facing=${leftShot?.facing} (mouse aimX ignored!)`
      );
      ctx.check(
        upRightShot !== null && upRightShot.vx > 100 && upRightShot.vy < -100,
        'MAJOR',
        'MOUSE_AIM_UP_ANGLE_IGNORED',
        `Aiming bow 45deg up-right fired vel=(${upRightShot?.vx.toFixed(1)}, ${upRightShot?.vy.toFixed(1)}) (mouse aimY ignored!)`
      );
    })
  );

  // PT-094: Mouse Aim for Grenades (Left Flip & Distance Velocity Scaling)
  out.push(
    runPlaytester(ptId(94), 'Mouse-Aim Grenadier', CAT, 9401, (ctx) => {
      const throwWithAim = (dx: number, dy: number): { vx: number; vy: number } | null => {
        const s = createCombatSandbox(9401);
        s.player.loadout.skill1 = makeGear(s, 'InfantryGrenade', 'skill');
        s.player.facing = 1;
        stepSim(
          s,
          inputOf({
            skill1Pressed: true,
            aimX: s.player.pos.x + dx,
            aimY: s.player.pos.y + dy,
          })
        );
        const g = s.projectiles.find((p) => p.owner === 'player' && p.kind === 'grenade');
        return g ? { vx: g.vel.x, vy: g.vel.y } : null;
      };

      const leftThrow = throwWithAim(-150, -10);
      const nearRight = throwWithAim(65, 0);
      const farRight = throwWithAim(260, -20);

      ctx.metric('leftThrowVx', leftThrow ? Math.round(leftThrow.vx) : 0);
      ctx.metric('nearRightVx', nearRight ? Math.round(nearRight.vx) : 0);
      ctx.metric('farRightVx', farRight ? Math.round(farRight.vx) : 0);

      ctx.check(
        leftThrow !== null && leftThrow.vx < -80,
        'MAJOR',
        'MOUSE_AIM_GRENADE_LEFT_IGNORED',
        `Aiming grenade left while facing right threw vx=${leftThrow?.vx.toFixed(1)} (mouse aimX ignored!)`
      );
      ctx.check(
        nearRight !== null && farRight !== null && farRight.vx > nearRight.vx + 20,
        'MAJOR',
        'MOUSE_AIM_GRENADE_DIST_FLAT',
        `Mouse distance did not scale grenade throw velocity (near=${nearRight?.vx.toFixed(1)}, far=${farRight?.vx.toFixed(1)})`
      );
    })
  );

  // PT-095: 4-Tick Combat Input Buffer
  out.push(
    runPlaytester(ptId(95), '4-Tick Input Buffer Tactician', CAT, 9501, (ctx) => {
      const state = createCombatSandbox(9501);
      // StartSword step 0: windup=6, active=4, recovery=6. canStartNew opens when recovery ticks <= 2.
      stepSim(state, inputOf({ weapon1Pressed: true }));
      let bufferedPressed = false;
      let sawQueueSet = false;
      const swingsSeen: number[] = [];

      for (let t = 0; t < 30; t++) {
        // Queue 2nd attack 3 ticks BEFORE recovery cancel window opens (inside 4-tick buffer!)
        const shouldPress = !bufferedPressed && state.player.attackPhase === 'recovery' && state.player.attackPhaseTicks === 5;
        if (shouldPress) bufferedPressed = true;
        stepSim(state, inputOf({ weapon1Pressed: shouldPress }));
        if (shouldPress && state.player.queuedInput === 'attack1' && state.player.queuedInputTicks === 4) {
          sawQueueSet = true;
        }
        for (const ev of state.events) {
          if (ev.type === 'attackSwing') swingsSeen.push(ev.stepIndex);
        }
        if (swingsSeen.length >= 2) break;
      }

      const sawSecondSwing = swingsSeen.length >= 2;
      const comboAdvanced = swingsSeen.length >= 2 && swingsSeen[1] === 1;
      ctx.metric('bufferedPressed', bufferedPressed);
      ctx.metric('sawQueueSet', sawQueueSet);
      ctx.metric('swingsSeen', swingsSeen.join(','));
      ctx.check(
        bufferedPressed && sawQueueSet && sawSecondSwing,
        'MAJOR',
        'INPUT_BUFFER_4TICK_FAILED',
        `4-tick buffer failed to fire follow-up attack (pressed=${bufferedPressed}, queued=${sawQueueSet}, swings=[${swingsSeen.join(',')}])`
      );
      if (sawSecondSwing) {
        ctx.check(
          comboAdvanced,
          'MAJOR',
          'COMBO_BUFFER_REPEATS_STEP0',
          `Buffered attack during recovery cancel window (ticks<=2) fired stepIndex=${swingsSeen[1]} instead of advancing comboStep to 1 (swings=[${swingsSeen.join(',')}])`
        );
      }
    })
  );

  // PT-096: Heavy BroadSword Roll-Cancel & Parry-Cancel Feel (Windup + Recovery)
  out.push(
    runPlaytester(ptId(96), 'Heavy Cancel-Feel Specialist', CAT, 9601, (ctx) => {
      const state = createCombatSandbox(9601);
      state.player.loadout.weapon1 = makeGear(state, 'BroadSword', 'weapon', { color: 'survival' });
      state.player.loadout.weapon2 = makeGear(state, 'StartShield', 'weapon', { color: 'survival' });

      // 1. Roll-cancel mid-windup
      stepSim(state, inputOf({ weapon1Pressed: true }));
      stepAndCollect(state, 3);
      ctx.check(state.player.attackPhase === 'windup', 'MAJOR', 'BROADSWORD_NOT_IN_WINDUP', 'BroadSword windup ended too fast');
      stepSim(state, inputOf({ rollPressed: true }));
      ctx.check(
        state.player.actionState === 'roll' && state.player.attackPhase === 'none',
        'CRITICAL',
        'BROADSWORD_ROLL_CANCEL_FAILED',
        'BroadSword windup roll-cancel failed'
      );

      // 2. Parry-cancel mid-windup
      stepAndCollect(state, 40);
      stepSim(state, inputOf({ weapon1Pressed: true }));
      stepAndCollect(state, 3);
      stepSim(state, inputOf({ weapon2Pressed: true }));
      ctx.check(
        state.player.actionState === 'parry' && state.player.attackPhase === 'none',
        'CRITICAL',
        'BROADSWORD_PARRY_CANCEL_FAILED',
        'BroadSword windup parry-cancel failed'
      );

      // 3. Recovery cancel with Parry
      stepAndCollect(state, 36);
      stepSim(state, inputOf({ weapon1Pressed: true }));
      for (let t = 0; t < 25 && state.player.attackPhase !== 'recovery'; t++) stepSim(state, inputOf());
      ctx.check(state.player.attackPhase === 'recovery', 'MAJOR', 'BROADSWORD_NO_RECOVERY', 'BroadSword did not enter recovery');
      stepSim(state, inputOf({ weapon2Pressed: true }));
      ctx.check(
        state.player.actionState === 'parry' && state.player.attackPhase === 'none',
        'MAJOR',
        'BROADSWORD_RECOVERY_PARRY_CANCEL_FAILED',
        'BroadSword recovery parry-cancel failed'
      );
    })
  );

  // PT-097: Curse Instant-Death & 10-Kill Cleanse
  out.push(
    runPlaytester(ptId(97), 'Cursed Chest Risk-Taker', CAT, 9701, (ctx) => {
      // Sub-test A: 1 unparried hit while cursed = instant death regardless of high HP
      const sDeath = createCombatSandbox(9701);
      const rngA = createRng(9701);
      for (let i = 0; i < 6; i++) applyScrollPickup(sDeath, 'survival');
      triggerCurse(sDeath, 10);
      ctx.check(sDeath.player.curseKillsLeft === 10, 'MAJOR', 'CURSE_COUNT_WRONG', `curseKillsLeft=${sDeath.player.curseKillsLeft}`);
      damagePlayer(sDeath, 5, 'TinyScratch', rngA);
      ctx.check(
        sDeath.player.hp === 0 && sDeath.runStatus === 'dead' && sDeath.lastDamageSource.includes('Curse'),
        'CRITICAL',
        'CURSE_INSTAKILL_FAILED',
        `Cursed player survived 5-dmg hit (hp=${sDeath.player.hp}, status=${sDeath.runStatus})`
      );

      // Sub-test B: 10 kills cleanly lifts curse and restores normal survivability
      const sLift = createCombatSandbox(9702);
      const rngB = createRng(9702);
      sLift.chests.push({
        uid: sLift.nextUid++,
        pos: { x: sLift.player.pos.x + 12, y: sLift.player.pos.y },
        kind: 'cursed',
        opened: false,
        roomId: 0,
      });
      stepSim(sLift, inputOf({ interactPressed: true }));
      ctx.check(sLift.player.curseKillsLeft === 10, 'MAJOR', 'CURSED_CHEST_NO_CURSE', 'Opening cursed chest did not apply 10-kill curse');

      let sawCleared = false;
      for (let k = 0; k < 10; k++) {
        sLift.events = [];
        const bat = spawnEnemy(sLift, 'BatKamikaze', sLift.player.pos.x + 20, sLift.player.pos.y, 0, rngB);
        damageEnemy(sLift, bat, 999, false, 10, 0, 0, rngB, 'StartSword');
        if (sLift.events.some((e) => e.type === 'curseCleared')) sawCleared = true;
      }
      ctx.check(
        sLift.player.curseKillsLeft === 0 && sawCleared,
        'MAJOR',
        'CURSE_CLEANSE_FAILED',
        `10 kills did not clear curse (left=${sLift.player.curseKillsLeft}, event=${sawCleared})`
      );
      sLift.player.iframeTicks = 0;
      const hpBefore = sLift.player.hp;
      damagePlayer(sLift, 10, 'Zombie', rngB);
      ctx.check(
        sLift.player.hp === hpBefore - 10 && sLift.runStatus === 'playing',
        'MAJOR',
        'POST_CLEANSE_STILL_CURSED',
        'Damage after curse cleanse still killed player'
      );
    })
  );

  // Helper for deterministic replay comparison
  const verifyDeterministicSeed = (seed: number, includePassageAndBoss: boolean): { match: boolean; finalHash: string; mismatchTick: number } => {
    const tape: InputFrame[] = [];
    for (let t = 0; t < 240; t++) {
      const f = inputOf({
        moveRight: t % 50 < 30,
        moveLeft: t % 50 >= 30,
        jump: t % 28 < 8,
        jumpPressed: t % 28 === 0,
        rollPressed: t % 42 === 12,
        weapon1Pressed: t % 15 === 3,
        weapon2Pressed: t % 46 === 20,
        skill1Pressed: t === 40 || t === 190,
        skill2Pressed: t === 65,
        healPressed: t === 90,
        interactPressed: t % 35 === 10,
        aimX: 240 + Math.cos(t * 0.1) * 120,
        aimY: 280 + Math.sin(t * 0.1) * 60,
      });
      if (includePassageAndBoss) {
        if (t === 80) f.commands = [{ type: 'enterBiome', biomeId: 'Passage' }];
        else if (t === 95) f.commands = [{ type: 'useFountain' }, { type: 'pickMutation', mutationId: 'Combo' }];
        else if (t === 110) f.commands = [{ type: 'enterBiome', biomeId: seed % 2 === 0 ? 'Bridge' : 'TopClockTower' }];
      }
      tape.push(f);
    }

    const simA = createInitialSimState(seed, 0);
    const simB = createInitialSimState(seed, 0);
    for (let t = 0; t < tape.length; t++) {
      stepSim(simA, tape[t]!);
      stepSim(simB, tape[t]!);
      if (hashSimState(simA) !== hashSimState(simB)) {
        return { match: false, finalHash: hashSimState(simA), mismatchTick: t + 1 };
      }
    }
    return { match: true, finalHash: hashSimState(simA), mismatchTick: -1 };
  };

  // PT-098: Bit-Exact FNV-1a Replay Determinism (Seeds 1 & 2)
  out.push(
    runPlaytester(ptId(98), 'Determinism Auditor (Seeds 1 & 2)', CAT, 98001, (ctx) => {
      const r1 = verifyDeterministicSeed(100001, false);
      const r2 = verifyDeterministicSeed(200002, false);
      ctx.metric('seed1Hash', r1.finalHash);
      ctx.metric('seed2Hash', r2.finalHash);
      ctx.check(r1.match, 'CRITICAL', 'REPLAY_DESYNC_SEED1', `Seed 100001 diverged at tick ${r1.mismatchTick}`);
      ctx.check(r2.match, 'CRITICAL', 'REPLAY_DESYNC_SEED2', `Seed 200002 diverged at tick ${r2.mismatchTick}`);
      ctx.check(
        r1.finalHash !== r2.finalHash && /^[0-9a-f]{8}$/.test(r1.finalHash),
        'MAJOR',
        'HASH_COLLISION_OR_FORMAT',
        `Hashes invalid or identical (${r1.finalHash} vs ${r2.finalHash})`
      );
    })
  );

  // PT-099: Bit-Exact FNV-1a Replay Determinism (Seeds 3 & 4 — Passage + Boss Arenas)
  out.push(
    runPlaytester(ptId(99), 'Determinism Auditor (Seeds 3 & 4 Boss/Passage)', CAT, 99003, (ctx) => {
      const r3 = verifyDeterministicSeed(300003, true);
      const r4 = verifyDeterministicSeed(400004, true);
      ctx.metric('seed3Hash', r3.finalHash);
      ctx.metric('seed4Hash', r4.finalHash);
      ctx.check(r3.match, 'CRITICAL', 'REPLAY_DESYNC_SEED3', `Seed 300003 diverged at tick ${r3.mismatchTick}`);
      ctx.check(r4.match, 'CRITICAL', 'REPLAY_DESYNC_SEED4', `Seed 400004 diverged at tick ${r4.mismatchTick}`);
      ctx.check(r3.finalHash !== r4.finalHash, 'MAJOR', 'BOSS_HASH_IDENTICAL', 'Distinct boss seeds produced identical hash');
    })
  );

  // PT-100: Full-System Chaos, Particle Cap & Zero-NaN Stress Gauntlet
  out.push(
    runPlaytester(ptId(100), 'Chaos QA Stress-Tester (All Systems)', CAT, 100100, (ctx) => {
      const state = createCombatSandbox(100100, 3);
      const rng = createRng(100100);
      state.player.godMode = true;
      for (let i = 0; i < 6; i++) applyScrollPickup(state, 'brutality');
      state.player.loadout.weapon1 = makeGear(state, 'Bleeder', 'weapon', { quality: 'L', affixes: ['explode_toxic', 'flame_trail'] });
      state.player.loadout.weapon2 = makeGear(state, 'BleedShield', 'weapon', { color: 'survival' });
      state.player.loadout.skill1 = makeGear(state, 'ClusterGrenade', 'skill');
      state.player.loadout.skill2 = makeGear(state, 'KnifeDance', 'skill');
      state.player.mutations = ['OpenWounds', 'InstinctOfTheMaster', 'Armadillopack'];

      const archetypes = ['Zombie', 'Archer', 'Grenader', 'Shield', 'Runner', 'BatKamikaze', 'Worm', 'Scorpio'];
      for (let i = 0; i < archetypes.length; i++) {
        spawnEnemy(state, archetypes[i]!, (12 + i * 2) * TILE_SIZE, 13 * TILE_SIZE, 0, rng, i % 4 === 0);
      }

      let maxParticlesSeen = 0;
      let firstNaN: string | null = null;
      for (let t = 0; t < 420; t++) {
        stepSim(
          state,
          inputOf({
            moveRight: t % 60 < 35,
            moveLeft: t % 60 >= 35,
            jump: t % 24 < 6,
            jumpPressed: t % 24 === 0,
            rollPressed: t % 31 === 5,
            weapon1Pressed: t % 9 === 0,
            weapon1Held: t % 9 < 4,
            weapon2Pressed: t % 37 === 15,
            weapon2Held: t % 37 >= 15 && t % 37 < 25,
            skill1Pressed: t % 80 === 10,
            skill2Pressed: t % 80 === 30,
            healPressed: t % 120 === 60,
            aimX: state.player.pos.x + Math.cos(t * 0.2) * 140,
            aimY: state.player.pos.y - 40 + Math.sin(t * 0.2) * 40,
          })
        );
        if (state.particlesSim.length > maxParticlesSeen) {
          maxParticlesSeen = state.particlesSim.length;
        }
        if (firstNaN === null) {
          firstNaN = findFirstNonFinite(state);
        }
      }

      ctx.metric('maxParticlesSeen', maxParticlesSeen);
      ctx.metric('killsInChaos', state.runKills);
      ctx.metric('finalHash', hashSimState(state));
      ctx.check(firstNaN === null, 'CRITICAL', 'CHAOS_NAN_STATE', `NaN during chaos soak: ${firstNaN}`);
      ctx.check(maxParticlesSeen <= 265, 'MINOR', 'PARTICLE_CAP_EXCEEDED', `Particle count reached ${maxParticlesSeen} (> 265)`);
      ctx.check(state.runKills >= 1, 'MAJOR', 'CHAOS_ZERO_KILLS', '420-tick chaos battle killed 0 enemies');
    })
  );

  return out;
}

// =============================================================================
// Main Entry & Dashboard Printer
// =============================================================================

function main(): void {
  const startAll = performance.now();

  const results: PlaytesterResult[] = [
    ...runCategory1StarterKit(),
    ...runCategory2WeaponsMatrix(),
    ...runCategory3SkillsMatrix(),
    ...runCategory4MutationsMatrix(),
    ...runCategory5BiomesAndPassage(),
    ...runCategory6BossesAndScaling(),
    ...runCategory7AimBufferCancelAndReplay(),
  ];

  if (results.length !== 100) {
    throw new Error(`Expected exactly 100 playtesters, got ${results.length}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const passRatePct = Math.round((passed / results.length) * 1000) / 10;
  const avgScore =
    Math.round((results.reduce((sum, r) => sum + r.score, 0) / results.length) * 10) / 10;

  const defectsBySeverity = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  const uniqueDefectCodes: Record<string, { severity: DefectSeverity; count: number; sample: string }> = {};
  const catMap = new Map<string, PlaytesterResult[]>();

  for (const r of results) {
    if (!catMap.has(r.category)) catMap.set(r.category, []);
    catMap.get(r.category)!.push(r);
    for (const d of r.defects) {
      defectsBySeverity[d.severity] += 1;
      const existing = uniqueDefectCodes[d.code];
      if (!existing) {
        uniqueDefectCodes[d.code] = { severity: d.severity, count: 1, sample: `[${r.id}] ${d.detail}` };
      } else {
        existing.count += 1;
      }
    }
  }

  const categories: CategorySummary[] = [];
  for (const [category, list] of catMap.entries()) {
    const p = list.filter((r) => r.pass).length;
    let crit = 0;
    let maj = 0;
    let min = 0;
    for (const r of list) {
      for (const d of r.defects) {
        if (d.severity === 'CRITICAL') crit += 1;
        else if (d.severity === 'MAJOR') maj += 1;
        else min += 1;
      }
    }
    categories.push({
      category,
      total: list.length,
      passed: p,
      failed: list.length - p,
      avgScore: Math.round((list.reduce((s, r) => s + r.score, 0) / list.length) * 10) / 10,
      critical: crit,
      major: maj,
      minor: min,
    });
  }

  const report: Playtest100Report = {
    generatedAt: new Date().toISOString(),
    totalPlaytesters: results.length,
    passed,
    failed,
    passRatePct,
    avgScore,
    defectsBySeverity,
    uniqueDefectCodes,
    categories,
    results,
  };

  // Write JSON report into gitignored .krunked-cells-assets/
  const reportPath = path.resolve(process.cwd(), '.krunked-cells-assets/playtest-100-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const elapsedMs = Math.round(performance.now() - startAll);

  // Print Concise 100-Playtester Dashboard Summary
  console.log('==============================================================================');
  console.log('  KRUNKED CELLS — 100-PLAYTESTER QA & MECHANIC PARITY GAUNTLET DASHBOARD');
  console.log('==============================================================================');
  console.log(
    `  Result: ${passed}/${results.length} PASSED (${passRatePct}%) | Avg Score: ${avgScore}/100 | Time: ${elapsedMs}ms`
  );
  console.log(
    `  Defects: ${defectsBySeverity.CRITICAL} CRITICAL, ${defectsBySeverity.MAJOR} MAJOR, ${defectsBySeverity.MINOR} MINOR`
  );
  console.log('------------------------------------------------------------------------------');
  console.log('  Category                                   | Pass / Tot | Avg   | C / M / m');
  console.log('------------------------------------------------------------------------------');
  for (const c of categories) {
    const name = c.category.padEnd(42);
    const ratio = `${String(c.passed).padStart(2)} / ${String(c.total).padEnd(2)}`.padEnd(10);
    const avg = `${c.avgScore.toFixed(1)}`.padStart(5);
    console.log(`  ${name} | ${ratio} | ${avg} | ${c.critical} / ${c.major} / ${c.minor}`);
  }
  console.log('------------------------------------------------------------------------------');

  const defectEntries = Object.entries(uniqueDefectCodes).sort((a, b) => {
    const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };
    return rank[a[1].severity] - rank[b[1].severity] || b[1].count - a[1].count;
  });

  if (defectEntries.length === 0) {
    console.log('  ALL 100 PLAYTESTERS PASSED WITH ZERO DEFECTS!');
  } else {
    console.log(`  DEFECT SUMMARY (${defectEntries.length} unique codes across ${failed} failed playtesters):`);
    for (const [code, info] of defectEntries) {
      console.log(`    [${info.severity}] ${code} (x${info.count}) — ${info.sample}`);
    }
    console.log('------------------------------------------------------------------------------');
    console.log('  FAILED PLAYTESTERS:');
    for (const r of results) {
      if (!r.pass) {
        const codes = r.defects.map((d) => `${d.severity}:${d.code}`).join(', ');
        console.log(`    ${r.id} (${r.persona}) [score=${r.score}]: ${codes}`);
      }
    }
  }

  console.log('------------------------------------------------------------------------------');
  console.log(`  Full JSON report written to: ${reportPath}`);
  console.log('==============================================================================');

  const gatingDefects = defectsBySeverity.CRITICAL + defectsBySeverity.MAJOR;
  if (passed === 100 && gatingDefects === 0) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
