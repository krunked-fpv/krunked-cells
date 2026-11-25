import {
  FIXED_DT,
  MAX_ACTIVE_LIGHTS,
  MAX_BOSS_CELLS,
  TILE_SIZE,
  TileKind,
  type CollisionAPI,
  type CritCondition,
  type EnemyState,
  type GearInstance,
  type InputFrame,
  type LightSource,
  type ProjectileState,
  type RngAPI,
  type SimState,
  type StatusKind,
  type StrikeStep,
  type Vec2,
  type WeaponDef,
} from '../contracts';
import { AFFIX_MAP, ENEMY_MAP, WEAPON_MAP, getSkill, getWeapon } from '../data';
import {
  applyMutationCooldownReduction,
  applyMutationOnKill,
  applyMutationOnParry,
  computeGearDamage,
  getLoadoutDamageTakenMultiplier,
  getMutationDamageMultiplier,
  hasLoadoutAffixKind,
  hasMutation,
  onEnemyKilledForCurseAndStreak,
} from './roguelite';
import {
  applyStatus,
  clearNegativeStatuses,
  computeBossCcDuration,
  computeSynergyMultiplier,
  getStatusColor,
  hasStatus,
  removeStatus,
  tickEntityStatuses,
} from './status';

export interface DamagePlayerOptions {
  attackerX?: number;
  attacker?: EnemyState | null;
  unblockable?: boolean;
  unrollable?: boolean;
}

const UNBLOCKABLE_SOURCES: ReadonlySet<string> = new Set([
  'Spikes',
  'Toxic Acid',
  'Crimson Aura',
  'Hazard',
  'Super Telluric Slam',
  'bleed',
  'poison',
  'burn',
  'electrify',
]);

function getWeaponGear(state: SimState, slot: 1 | 2): GearInstance | null {
  return slot === 1 ? state.player.loadout.weapon1 : state.player.loadout.weapon2;
}

function getSkillGear(state: SimState, slot: 1 | 2): GearInstance | null {
  return slot === 1 ? state.player.loadout.skill1 : state.player.loadout.skill2;
}

function findEquippedShield(state: SimState): { gear: GearInstance; def: WeaponDef } | null {
  const active = getWeaponGear(state, state.player.activeWeaponSlot);
  if (active) {
    const def = WEAPON_MAP[active.defId];
    if (def && def.kind === 'shield') return { gear: active, def };
  }
  const slots: (1 | 2)[] = [1, 2];
  for (let i = 0; i < slots.length; i++) {
    const g = getWeaponGear(state, slots[i]!);
    if (!g) continue;
    const def = WEAPON_MAP[g.defId];
    if (def && def.kind === 'shield') return { gear: g, def };
  }
  return null;
}

function aabbOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean {
  return Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
}

function spawnParticle(
  state: SimState,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: number,
  color: string,
  ttlTicks: number,
  kind: SimState['particlesSim'][number]['kind'],
  emissive = true,
  gravity = 220,
  text?: string
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
    text,
  });
}

function spawnTransientLight(
  state: SimState,
  x: number,
  y: number,
  radius: number,
  color: [number, number, number],
  intensity: number,
  ttlTicks: number,
  kind: LightSource['kind'] = 'slash'
): void {
  if (state.lights.length >= MAX_ACTIVE_LIGHTS) {
    const idx = state.lights.findIndex((l) => l.ttlTicks !== undefined);
    if (idx >= 0) {
      state.lights.splice(idx, 1);
    } else {
      return;
    }
  }
  state.lights.push({
    id: state.nextUid++,
    x,
    y,
    radius,
    color,
    intensity,
    flickerSpeed: 0,
    flickerAmp: 0,
    kind,
    ttlTicks,
  });
}

function hasValidAim(
  input?: InputFrame
): input is InputFrame & { aimX: number; aimY: number } {
  return Boolean(
    input &&
      input.aimX !== undefined &&
      input.aimY !== undefined &&
      Number.isFinite(input.aimX) &&
      Number.isFinite(input.aimY)
  );
}

function applyAimFacing(state: SimState, input?: InputFrame): void {
  const player = state.player;
  if (!input) return;
  const moveDir = (input.moveRight ? 1 : 0) - (input.moveLeft ? 1 : 0);
  if (hasValidAim(input)) {
    const aimDir: 1 | -1 = input.aimX >= player.pos.x ? 1 : -1;
    if (moveDir === 0 || moveDir === aimDir) {
      player.facing = aimDir;
    } else {
      player.facing = moveDir > 0 ? 1 : -1;
    }
    return;
  }
  if (moveDir !== 0) {
    player.facing = moveDir > 0 ? 1 : -1;
  }
}

export function findFloorY(
  state: SimState,
  x: number,
  startY: number,
  col: CollisionAPI
): number {
  const grid = state.tileGrid;
  const tx = Math.max(0, Math.min(grid.width - 1, Math.floor(x / TILE_SIZE)));
  const startTy = Math.max(0, Math.floor(startY / TILE_SIZE));
  const maxTy = Math.min(grid.height - 1, startTy + 12);
  for (let ty = startTy; ty <= maxTy; ty++) {
    const tileTopY = ty * TILE_SIZE;
    if (col.isSolidAt(grid, tx, ty)) {
      if (tileTopY >= startY - 4 || ty > startTy) {
        return tileTopY;
      }
    } else if (col.isOneWayAt(grid, tx, ty) && tileTopY >= startY - 4) {
      return tileTopY;
    }
  }
  return Math.min((grid.height - 1) * TILE_SIZE, startY + state.player.height * 0.5);
}

export function damagePlayerTurretsInArea(
  state: SimState,
  x: number,
  y: number,
  rangeX: number,
  rangeY: number,
  damage: number
): void {
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i]!;
    if (t.owner !== 'player') continue;
    if (t.kind !== 'sinew' && t.kind !== 'heavy') continue;
    if (aabbOverlap(x, y, rangeX, rangeY, t.pos.x, t.pos.y, 18, 22)) {
      t.hp -= Math.max(1, Math.round(damage));
      spawnParticle(state, t.pos.x, t.pos.y - 6, 0, -35, 3, '#ff9c52', 12, 'spark', true, 180);
      if (t.hp <= 0) {
        state.turrets.splice(i, 1);
      }
    }
  }
}

export function refundStuckArrows(state: SimState, enemy: EnemyState): void {
  if (!enemy.stuckArrows || enemy.stuckArrows.length === 0) return;
  for (let i = 0; i < enemy.stuckArrows.length; i++) {
    const stuck = enemy.stuckArrows[i]!;
    const gear = stuck.slot === 1 ? state.player.loadout.weapon1 : state.player.loadout.weapon2;
    if (gear && gear.maxAmmo !== undefined && gear.ammo !== undefined) {
      gear.ammo = Math.min(gear.maxAmmo, gear.ammo + 1);
    }
  }
  enemy.stuckArrows = [];
}

function isEntityInWater(state: SimState, x: number, y: number, h: number, col?: CollisionAPI): boolean {
  if (!col) return false;
  const tx = Math.floor(x / TILE_SIZE);
  const midTy = Math.floor(y / TILE_SIZE);
  const footTy = Math.floor((y + h * 0.45) / TILE_SIZE);
  return (
    col.getTile(state.tileGrid, tx, midTy) === TileKind.WATER ||
    col.getTile(state.tileGrid, tx, footTy) === TileKind.WATER
  );
}

function triggerBleedHemorrhageBurst(
  state: SimState,
  enemy: EnemyState,
  burstDmg: number,
  rng: RngAPI,
  col?: CollisionAPI
): void {
  state.events.push({
    type: 'bleedBurst',
    x: enemy.pos.x,
    y: enemy.pos.y,
    damage: burstDmg,
  });
  state.hitstopTicks = Math.max(state.hitstopTicks, 2);
  state.screenShake = Math.max(state.screenShake, 3.5);
  spawnParticle(state, enemy.pos.x, enemy.pos.y, 0, 0, 44, '#ff1f3d', 16, 'ring', true, 0);
  spawnParticle(
    state,
    enemy.pos.x,
    enemy.pos.y - enemy.height * 0.6 - 12,
    0,
    -42,
    12,
    '#ff2e4c',
    38,
    'text',
    true,
    0,
    'BLEED!'
  );
  for (let s = 0; s < 10; s++) {
    const ang = (s / 10) * Math.PI * 2;
    spawnParticle(
      state,
      enemy.pos.x,
      enemy.pos.y,
      Math.cos(ang) * rng.rangeFloat(80, 175),
      Math.sin(ang) * rng.rangeFloat(80, 175) - 25,
      3.5,
      '#ff2e4c',
      22,
      'blood',
      true,
      300
    );
  }
  damageEnemy(state, enemy, burstDmg, false, 0, 0, 0, rng, 'status', undefined, col);
}

export function applyEnemyStatus(
  state: SimState,
  enemy: EnemyState,
  kind: StatusKind,
  ticks: number,
  dps: number,
  rng: RngAPI,
  col?: CollisionAPI
): boolean {
  if (enemy.state === 'dead' || enemy.hp <= 0) return false;

  let effectiveTicks = ticks;
  if (kind === 'freeze' || kind === 'stun' || kind === 'root') {
    effectiveTicks = computeBossCcDuration(enemy, ticks);
    if (effectiveTicks <= 0) {
      return false;
    }
  }

  if (kind === 'bleed') {
    applyStatus(enemy.statusEffects, 'bleed', effectiveTicks, dps, 0, (burstDmg) => {
      triggerBleedHemorrhageBurst(state, enemy, burstDmg, rng, col);
    });
    return true;
  }

  applyStatus(enemy.statusEffects, kind, effectiveTicks, dps, 0);
  if (kind === 'freeze') {
    if (!enemy.isBoss) {
      enemy.state = 'frozen';
      enemy.stateTicks = Math.max(enemy.stateTicks, effectiveTicks);
    }
  } else if (kind === 'stun') {
    enemy.stunTicks = Math.max(enemy.stunTicks, effectiveTicks);
    if (!enemy.isBoss) {
      enemy.state = 'stunned';
      enemy.stateTicks = Math.max(enemy.stateTicks, effectiveTicks);
    }
  } else if (kind === 'root') {
    if (!enemy.isBoss) {
      enemy.state = 'rooted';
      enemy.stateTicks = Math.max(enemy.stateTicks, effectiveTicks);
    }
  }
  return true;
}

const PARRIABLE_BOSS_MELEE: ReadonlySet<string> = new Set([
  'punch',
  'dashSlash',
  'swordCombo',
  'lanceCombo',
  'jabTelluric',
  'shieldCharge',
]);
const RANGED_ENEMY_ATTACK_KINDS: ReadonlySet<string> = new Set([
  'ranged',
  'grenade',
  'clusterGrenade',
  'auraShield',
]);

function tryParryOverlappingThreats(state: SimState, rng: RngAPI): boolean {
  const player = state.player;
  if (player.parryWindowTicks <= 0) return false;

  // 1. Overlapping parriable enemy projectiles (r <= 34, reflects ALL simultaneous overlapping!)
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i]!;
    if (p.owner !== 'enemy' || !p.parriable) continue;
    if (Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) <= 34) {
      return attemptShieldParry(state, p.damage, null, p, rng);
    }
  }

  // 2. Overlapping active enemy/boss melee strikes
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state !== 'attack' || e.hp <= 0 || e.hitPlayerThisSwing) continue;

    if (e.isBoss) {
      if (!PARRIABLE_BOSS_MELEE.has(e.bossAttackId)) continue;
      const dx = player.pos.x - e.pos.x;
      const dy = player.pos.y - e.pos.y;
      const reachX =
        e.bossAttackId === 'lanceCombo' ? 78 : e.bossAttackId === 'punch' ? 68 : 58;
      const reachY = 42;
      const bidirectional = e.bossAttackId === 'lanceCombo' && e.stateTicks <= 19 && e.stateTicks > 9;
      if (Math.abs(dx) <= reachX && (bidirectional || dx * e.facing >= -18) && Math.abs(dy) <= reachY) {
        if (attemptShieldParry(state, e.damage, e, null, rng)) {
          e.hitPlayerThisSwing = true;
          return true;
        }
      }
    } else {
      const def = ENEMY_MAP[e.defId];
      if (!def || !def.canBeParried) continue;
      const isPirateMelee = e.defId === 'PirateChief' && e.bossAttackId === 'meleeCombo';
      if (RANGED_ENEMY_ATTACK_KINDS.has(def.attackKind) && !isPirateMelee) {
        continue;
      }
      const dx = player.pos.x - e.pos.x;
      const dy = player.pos.y - e.pos.y;
      const reachX = e.defId === 'Lancer' ? 100 : Math.max(38, def.attackRange + 8);
      const reachY = 30;
      if (Math.abs(dx) <= reachX && dx * e.facing >= -12 && Math.abs(dy) <= reachY) {
        if (attemptShieldParry(state, e.damage, e, null, rng)) {
          e.hitPlayerThisSwing = true;
          return true;
        }
      }
    }
  }

  return false;
}

function evaluateCritCondition(
  state: SimState,
  weaponDef: WeaponDef,
  stepIndex: number,
  enemy: EnemyState,
  col?: CollisionAPI
): boolean {
  const player = state.player;
  const cond: CritCondition = weaponDef.critCondition;

  switch (cond) {
    case 'none':
      return false;
    case 'always':
      return true;
    case 'backstab':
      return (
        ((enemy.pos.x - player.pos.x) * enemy.facing >= -6 && player.facing === enemy.facing) ||
        (enemy.pos.x - player.pos.x) * enemy.facing > 0
      );
    case 'finalHit':
      if (weaponDef.id === 'BroadSword') {
        return stepIndex >= 1;
      }
      return stepIndex >= weaponDef.strikeChain.length - 1;
    case 'bleeding':
      return hasStatus(enemy.statusEffects, 'bleed');
    case 'poisoned':
      return hasStatus(enemy.statusEffects, 'poison');
    case 'burning':
      return hasStatus(enemy.statusEffects, 'burn');
    case 'oiled':
      return hasStatus(enemy.statusEffects, 'oil');
    case 'frozenOrRooted':
      return (
        hasStatus(enemy.statusEffects, 'freeze') ||
        hasStatus(enemy.statusEffects, 'root') ||
        hasStatus(enemy.statusEffects, 'stun') ||
        enemy.stunTicks > 0
      );
    case 'speedBuff':
      return player.speedBuffTicks > 0;
    case 'afterRoll':
      return player.afterRollCritTicks > 0 || player.afterParryCritTicks > 0;
    case 'afterParry':
      return player.afterParryCritTicks > 0;
    case 'isolated': {
      for (let i = 0; i < state.enemies.length; i++) {
        const other = state.enemies[i]!;
        if (other.uid === enemy.uid || other.state === 'dead' || other.hp <= 0) continue;
        if (Math.hypot(other.pos.x - enemy.pos.x, other.pos.y - enemy.pos.y) <= 96) {
          return false;
        }
      }
      return true;
    }
    case 'wallSlam': {
      if (!col) return false;
      const dir = enemy.pos.x >= player.pos.x ? 1 : -1;
      const ty = Math.floor(enemy.pos.y / TILE_SIZE);
      // Generous 44px behind-enemy wall check so pushing/pinning near a wall crits cleanly!
      for (const probeDist of [16, 30, 44]) {
        const tx = Math.floor((enemy.pos.x + dir * (enemy.width * 0.5 + probeDist)) / TILE_SIZE);
        if (col.isSolidAt(state.tileGrid, tx, ty)) {
          return true;
        }
      }
      return false;
    }
    case 'highCombo':
      // Balanced Blade crits at 10+ consecutive hits!
      return (player.balancedStacks ?? 0) >= 10;
    case 'stuckArrows3':
      // Quick Bow crits when target has 3+ arrows lodged in it!
      return (enemy.stuckArrows?.length ?? 0) >= 3;
    case 'closeRange':
      return Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y) <= 88;
    case 'midRange': {
      const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
      return dist >= 64 && dist <= 160;
    }
  }
}

function getStatusDps(state: SimState, kind: StatusKind): number {
  const maxStat = Math.max(
    state.player.scrolls.brutality,
    state.player.scrolls.tactics,
    state.player.scrolls.survival
  );
  const mult = Math.pow(1.15, Math.max(0, maxStat - 1));
  const base =
    kind === 'burn' ? 24 : kind === 'poison' ? 22 : kind === 'electrify' ? 26 : 20;
  return Math.round(base * mult);
}

function applyWeaponAndAffixStatuses(
  state: SimState,
  enemy: EnemyState,
  weaponStatus: StatusKind | undefined,
  affixes: readonly string[] | undefined,
  isMelee: boolean,
  weaponId: string,
  stepIndex: number,
  rng: RngAPI,
  col?: CollisionAPI
): void {
  if (weaponStatus) {
    const dur =
      weaponStatus === 'freeze'
        ? 72
        : weaponStatus === 'stun'
          ? 75
          : weaponStatus === 'root'
            ? 150
            : weaponStatus === 'bleed' && weaponId === 'Bleeder'
              ? 360
              : 210;
    const dps =
      weaponStatus === 'bleed' ||
      weaponStatus === 'poison' ||
      weaponStatus === 'burn' ||
      weaponStatus === 'electrify'
        ? getStatusDps(state, weaponStatus)
        : 0;
    applyEnemyStatus(state, enemy, weaponStatus, dur, dps, rng, col);
    // Blood Sword hit 2 applies an extra Bleed stack toward 5-stack Hemorrhage Burst!
    if (weaponId === 'Bleeder' && weaponStatus === 'bleed' && stepIndex >= 1 && enemy.hp > 0) {
      applyEnemyStatus(state, enemy, 'bleed', dur, dps, rng, col);
    }
  }

  if (affixes) {
    for (let i = 0; i < affixes.length; i++) {
      const affixId = affixes[i]!;
      const def = AFFIX_MAP[affixId];
      if (!def || def.kind !== 'applyStatus' || !def.applyStatus) continue;
      const st = def.applyStatus;
      const dur = st === 'oil' ? 300 : 210;
      const dps = st === 'oil' ? 0 : getStatusDps(state, st);
      applyEnemyStatus(state, enemy, st, dur, dps, rng, col);
      // ★ spread_oil splashes oil to nearby enemies too
      if (affixId === 'spread_oil') {
        for (let j = 0; j < state.enemies.length; j++) {
          const other = state.enemies[j]!;
          if (other.uid === enemy.uid || other.state === 'dead' || other.hp <= 0) continue;
          if (Math.hypot(other.pos.x - enemy.pos.x, other.pos.y - enemy.pos.y) <= 56) {
            applyStatus(other.statusEffects, 'oil', 300, 0, 0);
          }
        }
      }
    }
  }

  if (isMelee && hasMutation(state, 'OpenWounds') && enemy.hp > 0) {
    applyEnemyStatus(state, enemy, 'bleed', 180, getStatusDps(state, 'bleed'), rng, col);
  }
  if (isMelee && hasMutation(state, 'Melee') && enemy.hp > 0) {
    // Slow-only (NO frost -> NO accidental boss freeze stunlock!)
    applyStatus(enemy.statusEffects, 'slow', 150, 0, 0);
  }
}

function reflectSingleProjectile(
  state: SimState,
  proj: ProjectileState,
  shieldCounterDamage: number,
  incomingDamage: number,
  shieldGear: GearInstance | null
): void {
  const player = state.player;
  const origOwnerUid = proj.ownerUid;
  proj.owner = 'player';
  proj.ownerUid = 0;
  const speed = Math.max(330, Math.hypot(proj.vel.x, proj.vel.y) * 1.45);

  // Aim reflected projectile directly back at its attacker if alive, else along player.facing!
  const attacker =
    origOwnerUid > 0
      ? state.enemies.find((e) => e.uid === origOwnerUid && e.state !== 'dead' && e.hp > 0)
      : undefined;
  if (attacker) {
    const adx = attacker.pos.x - proj.pos.x;
    const ady = attacker.pos.y - proj.pos.y;
    const alen = Math.max(1, Math.hypot(adx, ady));
    proj.vel.x = (adx / alen) * speed;
    proj.vel.y = (ady / alen) * speed;
  } else {
    const dirX = player.facing;
    proj.vel.x = dirX * speed;
    proj.vel.y = Math.min(0, -Math.abs(proj.vel.y) * 0.45);
  }

  proj.gravity = Math.min(proj.gravity, 120);
  proj.damage = Math.max(
    shieldCounterDamage,
    Math.round(Math.max(incomingDamage, proj.damage) * 2.2)
  );
  proj.isCrit = true;
  proj.parriable = false;
  proj.rollsOnFloor = false;
  proj.floorFuseTicks = undefined;
  proj.bouncesLeft = 0;
  proj.ttlTicks = Math.max(proj.ttlTicks, 120);
  proj.hitIds = [];
  proj.color = '#ffe866';
  proj.affixes = shieldGear?.affixes;
}

export function attemptShieldParry(
  state: SimState,
  incomingDamage: number,
  attacker: EnemyState | null,
  projectile: ProjectileState | null,
  rng: RngAPI
): boolean {
  const player = state.player;
  const armadilloRoll =
    player.actionState === 'roll' && hasMutation(state, 'Armadillopack');
  const parryActive = player.parryWindowTicks > 0 || armadilloRoll;

  if (!parryActive) {
    return false;
  }

  if (projectile && !projectile.parriable) {
    return false;
  }

  const shieldInfo = findEquippedShield(state);
  const shieldGear = shieldInfo?.gear ?? null;
  const shieldDef = shieldInfo?.def ?? null;
  const shieldBasePower = shieldDef?.strikeChain[0]?.basePower ?? 48;
  const shieldCounterDamage = computeGearDamage(
    shieldBasePower,
    shieldGear,
    player.scrolls
  );

  // Negate 100% damage and trigger Dead Cells golden parry feel
  state.hitstopTicks = Math.max(state.hitstopTicks, 6);
  state.parryFlashAlpha = 1.0;
  state.screenShake = Math.max(state.screenShake, 5);
  player.parryCooldownTicks = 0; // Instant cooldown reset on successful parry!
  player.parryWindowTicks = 0;
  player.afterParryCritTicks = 90;
  player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 60);
  player.iframeTicks = Math.max(player.iframeTicks, 14);
  if (!armadilloRoll) {
    player.actionState = 'parrySuccess';
    player.actionTicks = 12;
  }

  // Golden radial shockwave VFX + light
  spawnParticle(
    state,
    player.pos.x + player.facing * 8,
    player.pos.y - 2,
    0,
    0,
    38,
    '#ffe866',
    16,
    'ring',
    true,
    0
  );
  spawnParticle(
    state,
    player.pos.x,
    player.pos.y - 24,
    0,
    -30,
    11,
    '#ffe866',
    36,
    'text',
    true,
    0,
    'PARRY!'
  );
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    spawnParticle(
      state,
      player.pos.x + player.facing * 6,
      player.pos.y - 2,
      Math.cos(angle) * 140,
      Math.sin(angle) * 140,
      4,
      '#fff088',
      18,
      'spark',
      true,
      0
    );
  }

  if (projectile) {
    reflectSingleProjectile(state, projectile, shieldCounterDamage, incomingDamage, shieldGear);
    // Reflect ALL simultaneous overlapping parriable projectiles in r <= 34!
    for (let i = 0; i < state.projectiles.length; i++) {
      const other = state.projectiles[i]!;
      if (other.uid === projectile.uid || other.owner !== 'enemy' || !other.parriable) continue;
      if (Math.hypot(other.pos.x - player.pos.x, other.pos.y - player.pos.y) <= 34) {
        reflectSingleProjectile(state, other, shieldCounterDamage, other.damage, shieldGear);
      }
    }

    state.events.push({
      type: 'parrySuccess',
      x: player.pos.x,
      y: player.pos.y,
      reflected: true,
    });
  } else {
    state.events.push({
      type: 'parrySuccess',
      x: player.pos.x,
      y: player.pos.y,
      reflected: false,
    });
  }

  if (attacker && attacker.state !== 'dead' && attacker.hp > 0) {
    // Return any arrows stuck in the parried attacker!
    refundStuckArrows(state, attacker);

    const baseStunDur = shieldDef?.parryPassive === 'stun' ? 165 : 75;
    applyEnemyStatus(state, attacker, 'stun', baseStunDur, 0, rng);

    const pushDir = attacker.pos.x >= player.pos.x ? 1 : -1;
    damageEnemy(
      state,
      attacker,
      shieldCounterDamage,
      true,
      80,
      pushDir * 120,
      -40,
      rng,
      shieldDef?.id ?? 'StartShield',
      shieldGear?.affixes
    );
  }

  // Trigger shield parry passives
  const passive = shieldDef?.parryPassive ?? 'none';
  if (passive === 'bleed') {
    const bleedDps = getStatusDps(state, 'bleed');
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0) continue;
      if (Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= 120) {
        applyEnemyStatus(state, e, 'bleed', 240, bleedDps, rng);
        if (e.hp > 0) {
          applyEnemyStatus(state, e, 'bleed', 240, bleedDps, rng);
        }
      }
    }
    spawnParticle(state, player.pos.x, player.pos.y, 0, 0, 96, '#ff2e4c', 18, 'ring', true, 0);
  } else if (passive === 'forcefield' && !projectile) {
    // Rampart forcefield triggers STRICTLY on melee parries (135t)!
    applyStatus(player.statusEffects, 'shield', 135, 0, 0);
  } else if (passive === 'damageBuff') {
    player.afterParryCritTicks = 180;
    player.comboMutationTicks = Math.max(player.comboMutationTicks, 180);
  }

  applyMutationOnParry(state, Boolean(projectile));
  return true;
}

export function damagePlayer(
  state: SimState,
  amount: number,
  sourceLabel: string,
  rng: RngAPI,
  ignoreIframes = false,
  opts?: DamagePlayerOptions
): boolean {
  const player = state.player;
  if (player.godMode || player.actionState === 'dead' || state.runStatus !== 'playing') {
    return false;
  }

  // Rampart / Disengagement invulnerability forcefield blocks all hits
  if (hasStatus(player.statusEffects, 'shield')) {
    return false;
  }

  if (!ignoreIframes) {
    const isUnrollableWhileRolling = Boolean(opts?.unrollable && player.actionState === 'roll');
    if (
      (!isUnrollableWhileRolling && player.iframeTicks > 0) ||
      (player.onHitShieldTicks ?? 0) > 0
    ) {
      return false;
    }
  }

  // Track Flawless Boss No-Hit failure
  if (state.bossArenaState.active) {
    state.bossArenaState.playerTookHit = true;
  }

  // Cursed instant death (any unparried damage kills immediately!)
  if (player.curseKillsLeft > 0) {
    const lost = player.hp;
    player.hp = 0;
    player.rallyHp = 0;
    player.rallyLostAnchor = 0;
    player.killStreak = 0;
    player.speedKillCount = 0;
    player.balancedStacks = 0;
    state.lastDamageSource = `Curse (${sourceLabel})`;
    state.damageFlashAlpha = 1.0;
    state.screenShake = Math.max(state.screenShake, 10);
    state.events.push({
      type: 'playerDamaged',
      x: player.pos.x,
      y: player.pos.y,
      amount: lost,
      rallyAdded: 0,
    });
    finalizePlayerDeath(state, state.lastDamageSource);
    return true;
  }

  let mult = 1.0;
  const amuletDr = player.loadout.amulet?.dmgReductionPct ?? 0;
  if (amuletDr > 0) {
    mult *= Math.max(0.4, 1 - amuletDr / 100);
  }
  if ((player.vengeanceTicks ?? 0) > 0 && hasMutation(state, 'Vengeance')) {
    mult *= 0.75;
  }
  if ((player.tempShieldTicks ?? 0) > 0) {
    // Tonic 35% DR while overheal barrier is active
    mult *= 0.65;
  }
  if (hasStatus(player.statusEffects, 'corrupted')) {
    mult *= 1.3;
  }
  mult *= getLoadoutDamageTakenMultiplier(state);

  // Frontal-Only Hold-to-Block Shield Mitigation (NEVER blocks floor spikes, acid, DoTs, or unparriable shockwaves!)
  const unblockable = Boolean(opts?.unblockable) || UNBLOCKABLE_SOURCES.has(sourceLabel);
  const isFrontal =
    opts?.attackerX === undefined ||
    (opts.attackerX - player.pos.x) * player.facing >= -8;
  const shieldInfo = findEquippedShield(state);
  const isShieldBlocked = Boolean(
    player.shieldBlocking &&
      shieldInfo &&
      !ignoreIframes &&
      !unblockable &&
      isFrontal &&
      player.curseKillsLeft <= 0
  );

  if (isShieldBlocked && shieldInfo) {
    const dr = shieldInfo.def.blockDrPct ?? 0.75;
    mult *= Math.max(0.05, 1 - dr);
  }

  const finalDamage = Math.max(1, Math.round(amount * mult));

  // Absorb damage from Tonic temporary overheal barrier BEFORE player.hp!
  let remainingDamage = finalDamage;
  if ((player.tempShieldHp ?? 0) > 0) {
    const absorbed = Math.min(player.tempShieldHp!, remainingDamage);
    player.tempShieldHp! -= absorbed;
    remainingDamage -= absorbed;
    spawnParticle(
      state,
      player.pos.x,
      player.pos.y - 20,
      0,
      -32,
      9,
      '#66f5c8',
      26,
      'text',
      true,
      0,
      `-${absorbed} SHD`
    );
  }

  const actualLost = Math.min(player.hp, remainingDamage);

  if (isShieldBlocked && shieldInfo) {
    player.vel.x = -player.facing * 105;
    state.events.push({
      type: 'shieldBlock',
      x: player.pos.x,
      y: player.pos.y,
      reducedDamage: finalDamage,
    });
    for (let i = 0; i < 6; i++) {
      const ang = -0.9 + (i / 5) * 1.8;
      const spd = rng.rangeFloat(80, 150);
      spawnParticle(
        state,
        player.pos.x + player.facing * 9,
        player.pos.y - 2,
        Math.cos(ang) * spd * player.facing,
        Math.sin(ang) * spd - 20,
        3.5,
        i % 2 === 0 ? '#b8e4ff' : '#7ac8ff',
        16,
        'spark',
        true,
        180
      );
    }
    spawnParticle(
      state,
      player.pos.x,
      player.pos.y - 24,
      0,
      -34,
      10,
      '#9ee2ff',
      34,
      'text',
      true,
      0,
      'BLOCK!'
    );
    spawnTransientLight(
      state,
      player.pos.x + player.facing * 8,
      player.pos.y - 2,
      82,
      [0.58, 0.86, 1.0],
      1.35,
      10,
      'slash'
    );

    // Block contact passives against frontal melee attackers!
    if (opts?.attacker && opts.attacker.state !== 'dead' && opts.attacker.hp > 0) {
      if (shieldInfo.def.id === 'StunShield') {
        applyEnemyStatus(state, opts.attacker, 'stun', 180, 0, rng);
      } else if (shieldInfo.def.id === 'BleedShield') {
        applyEnemyStatus(state, opts.attacker, 'bleed', 180, getStatusDps(state, 'bleed'), rng);
      }
    }
  }

  // Disengagement safety shield below 20% HP
  const lowHpThreshold = Math.round(player.maxHp * 0.2);
  if (
    actualLost > 0 &&
    player.hp - actualLost <= lowHpThreshold &&
    hasMutation(state, 'Disengagement') &&
    player.disengagementCooldownTicks <= 0
  ) {
    player.hp = Math.max(1, player.hp - actualLost);
    player.disengagementCooldownTicks = 7200;
    applyStatus(player.statusEffects, 'shield', 300, 0, 0);
    spawnParticle(
      state,
      player.pos.x,
      player.pos.y - 20,
      0,
      -26,
      10,
      '#66f5c8',
      45,
      'text',
      true,
      0,
      'DISENGAGEMENT!'
    );
  } else {
    player.hp = Math.max(0, player.hp - actualLost);
  }

  // Oracle Rally Formula: 80% of lost HP enters rallyHp, holds 36t, drains at 0.30 * maxHp / sec
  const rallyAdd = Math.round(actualLost * 0.8);
  if (rallyAdd > 0) {
    player.rallyHp = Math.min(player.maxHp - player.hp, player.rallyHp + rallyAdd);
    player.rallyLostAnchor = player.rallyHp;
    player.rallyHoldTicks = 36;
    player.rallyDrainTicks = Math.max(
      1,
      Math.round(player.rallyHp / Math.max(0.01, 0.3 * player.maxHp * FIXED_DT))
    );
  }

  // Carrying any shield grants 0.5s (30t) post-hit protective barrier (with -65% rally malus)
  if (!ignoreIframes && shieldInfo && actualLost > 0) {
    player.onHitShieldTicks = 30;
  }

  // Reset kill streak & Balanced Blade stacks; activate 8s Vengeance window; 5BC Malaise hit
  player.killStreak = 0;
  player.speedKillCount = 0;
  player.balancedStacks = 0;
  player.balancedDecayTicks = 0;
  player.hitFlashTicks = 12;
  player.vengeanceTicks = 480;
  if (state.bossStemCells >= 5 && !ignoreIframes) {
    player.malaise = Math.min(100, (player.malaise ?? 0) + 10);
  }
  if (!ignoreIframes) {
    player.iframeTicks = Math.max(player.iframeTicks, 36);
  }
  state.damageFlashAlpha = isShieldBlocked ? 0.42 : 0.85;
  state.screenShake = Math.max(state.screenShake, isShieldBlocked ? 3.5 : 6);
  state.lastDamageSource = sourceLabel;

  state.events.push({
    type: 'playerDamaged',
    x: player.pos.x,
    y: player.pos.y,
    amount: actualLost,
    rallyAdded: rallyAdd,
  });

  if (actualLost > 0) {
    spawnParticle(
      state,
      player.pos.x,
      player.pos.y - 18,
      rng.rangeFloat(-20, 20),
      -40,
      10,
      '#ff4757',
      32,
      'text',
      true,
      0,
      `-${actualLost}`
    );
    for (let i = 0; i < 6; i++) {
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y,
        rng.rangeFloat(-90, 90),
        rng.rangeFloat(-110, -20),
        3,
        '#ff334b',
        22,
        'blood',
        false,
        360
      );
    }
  }

  if (player.hp <= 0) {
    finalizePlayerDeath(state, sourceLabel);
  }

  return true;
}

function finalizePlayerDeath(state: SimState, cause: string): void {
  const player = state.player;
  player.actionState = 'dead';
  player.attackPhase = 'none';
  player.shieldBlocking = false;
  player.vel.x = 0;
  state.runStatus = 'dead';
  state.metaSnapshot.totalRuns += 1;

  // Bank retained Gold up to Gold Reserves cap
  const caps = [0, 2500, 5000, 10000, 15000];
  const cap = caps[Math.min(4, Math.max(0, state.metaSnapshot.goldReserveTier))] ?? 0;
  state.metaSnapshot.bankedGold = Math.min(player.gold, cap);

  state.runSummary = {
    victory: false,
    bossCells: state.bossStemCells,
    biomeReached: state.activeBiomeId,
    kills: state.runKills,
    maxKillStreak: state.maxKillStreak,
    runTimerTicks: player.runTimerTicks,
    scrolls: { ...player.scrolls },
    cellsCollected: state.totalCellsEarned,
    goldCollected: state.totalGoldEarned,
    causeOfDeath: cause,
    unlockedNewBossCell: false,
  };
  state.events.push({
    type: 'playerDeath',
    x: player.pos.x,
    y: player.pos.y,
    cause,
  });
}

function finalizeRunVictory(state: SimState): void {
  const player = state.player;
  let unlockedNew = false;
  if (
    state.bossStemCells >= state.metaSnapshot.bossCellsUnlocked &&
    state.metaSnapshot.bossCellsUnlocked < MAX_BOSS_CELLS
  ) {
    state.metaSnapshot.bossCellsUnlocked += 1;
    unlockedNew = true;
  }
  state.metaSnapshot.totalRuns += 1;
  if (
    state.metaSnapshot.bestClearTicks === null ||
    player.runTimerTicks < state.metaSnapshot.bestClearTicks
  ) {
    state.metaSnapshot.bestClearTicks = player.runTimerTicks;
  }
  state.runStatus = 'victory';
  state.runSummary = {
    victory: true,
    bossCells: state.bossStemCells,
    biomeReached: state.activeBiomeId,
    kills: state.runKills,
    maxKillStreak: state.maxKillStreak,
    runTimerTicks: player.runTimerTicks,
    scrolls: { ...player.scrolls },
    cellsCollected: state.totalCellsEarned,
    goldCollected: state.totalGoldEarned,
    causeOfDeath: '',
    unlockedNewBossCell: unlockedNew,
  };
}

export function damageEnemy(
  state: SimState,
  enemy: EnemyState,
  rawDamage: number,
  isCrit: boolean,
  breachPower: number,
  knockbackX: number,
  knockbackY: number,
  rng: RngAPI,
  weaponId: string,
  affixes?: readonly string[],
  col?: CollisionAPI
): boolean {
  if (enemy.state === 'dead' || enemy.hp <= 0 || enemy.buried) {
    return false;
  }

  // Protector shield aura or Boss invulnerability shield / Floating Add-Summon
  if (enemy.protectedByUid !== null || enemy.bossShieldTicks > 0 || enemy.bossFloatingSummon) {
    spawnParticle(
      state,
      enemy.pos.x,
      enemy.pos.y - enemy.height * 0.5,
      0,
      -28,
      9,
      '#66f5c8',
      24,
      'text',
      true,
      0,
      'SHIELDED'
    );
    return false;
  }

  // Frontal shield block (Shieldbearer, charging Royal Guard, charging Hand of the King)
  const enemyDef = ENEMY_MAP[enemy.defId];
  const ignoresShields =
    weaponId === 'Whip' ||
    weaponId === 'status' ||
    weaponId === 'skill' ||
    Boolean(affixes && affixes.includes('breaks_shields'));
  const isChargingShield =
    enemy.state === 'attack' &&
    enemy.bossAttackId === 'shieldCharge' &&
    (enemy.defId === 'CastleKnight' || enemy.bossId === 'KingsHand');
  const hasFrontShield = Boolean(enemyDef?.shieldFront) || isChargingShield;

  if (
    hasFrontShield &&
    !ignoresShields &&
    breachPower < 55 &&
    enemy.stunTicks <= 0 &&
    !hasStatus(enemy.statusEffects, 'freeze') &&
    !hasStatus(enemy.statusEffects, 'root') &&
    (state.player.pos.x - enemy.pos.x) * enemy.facing > 0
  ) {
    enemy.vel.x += Math.sign(knockbackX || enemy.facing) * -35;
    // Shieldbearer frontal melee block recoils the attacker!
    const wDef = WEAPON_MAP[weaponId];
    if (wDef && wDef.kind === 'melee' && enemy.defId === 'Shield') {
      state.player.vel.x = -state.player.facing * 120;
      state.player.attackPhase = 'none';
      state.player.attackPhaseTicks = 0;
      state.player.fallStunTicks = Math.max(state.player.fallStunTicks ?? 0, 8);
    }
    spawnParticle(
      state,
      enemy.pos.x + enemy.facing * 8,
      enemy.pos.y - 4,
      0,
      -26,
      9,
      '#b8d8ff',
      22,
      'text',
      true,
      0,
      'BLOCKED'
    );
    return false;
  }

  let mult = computeSynergyMultiplier(affixes, enemy.statusEffects);

  // Rooted enemies (Wolf Trap) take +40% bonus damage
  if (hasStatus(enemy.statusEffects, 'root')) {
    mult *= 1.4;
  }

  // Corrupted Power active: +50% damage dealt
  if (hasStatus(state.player.statusEffects, 'corrupted')) {
    mult *= 1.5;
  }

  // Heavy Turret aura: +20% bonus damage when player is close to own Heavy Turret
  for (let i = 0; i < state.turrets.length; i++) {
    const t = state.turrets[i]!;
    if (
      t.owner === 'player' &&
      t.kind === 'heavy' &&
      Math.hypot(t.pos.x - state.player.pos.x, t.pos.y - state.player.pos.y) <= 130
    ) {
      mult *= 1.2;
      break;
    }
  }

  let finalDamage = Math.max(1, Math.round(rawDamage * mult));

  // Freeze Shatter: hitting a frozen enemy (except FrostBow/status) shatters ice into slow + 15% shatter pop!
  if (
    hasStatus(enemy.statusEffects, 'freeze') &&
    weaponId !== 'FrostBow' &&
    weaponId !== 'status'
  ) {
    removeStatus(enemy.statusEffects, 'freeze');
    applyStatus(enemy.statusEffects, 'slow', 75, 0, 0);
    if (enemy.state === 'frozen') {
      enemy.state = 'chase';
    }
    finalDamage = Math.max(1, Math.round(finalDamage * 1.15));
    state.events.push({
      type: 'freezeShatter',
      x: enemy.pos.x,
      y: enemy.pos.y,
    });
    spawnParticle(
      state,
      enemy.pos.x,
      enemy.pos.y - enemy.height * 0.55 - 10,
      0,
      -40,
      11,
      '#8ceeff',
      32,
      'text',
      true,
      0,
      'SHATTER!'
    );
    for (let s = 0; s < 8; s++) {
      const ang = (s / 8) * Math.PI * 2;
      spawnParticle(
        state,
        enemy.pos.x,
        enemy.pos.y,
        Math.cos(ang) * rng.rangeFloat(75, 160),
        Math.sin(ang) * rng.rangeFloat(75, 160) - 25,
        3.5,
        s % 2 === 0 ? '#7ce8ff' : '#e0fbff',
        20,
        'ice',
        true,
        240
      );
    }
  }

  // Wall-slam bonus damage (+25%) and 35-tick stun when knockback slams an enemy into a solid wall
  let wallSlammed = false;
  if (col && Math.abs(knockbackX) >= 75) {
    const dir = Math.sign(knockbackX);
    const probeX = enemy.pos.x + dir * (enemy.width * 0.5 + 16);
    const tx = Math.floor(probeX / TILE_SIZE);
    const ty = Math.floor(enemy.pos.y / TILE_SIZE);
    if (col.isSolidAt(state.tileGrid, tx, ty)) {
      wallSlammed = true;
      finalDamage = Math.round(finalDamage * 1.25);
      if (!enemy.isBoss) {
        applyEnemyStatus(state, enemy, 'stun', 35, 0, rng, col);
      }
      spawnParticle(state, probeX, enemy.pos.y, 0, 0, 24, '#ffcf66', 14, 'ring', true, 0);
      spawnParticle(
        state,
        enemy.pos.x,
        enemy.pos.y - 24,
        0,
        -32,
        10,
        '#ffcf66',
        30,
        'text',
        true,
        0,
        'WALL SLAM!'
      );
    }
  }

  // Boss 15% Single-Hit Damage Cap!
  if (enemy.isBoss) {
    finalDamage = Math.min(finalDamage, Math.max(1, Math.round(enemy.maxHp * 0.15)));
  }

  enemy.hp = Math.max(0, enemy.hp - finalDamage);
  enemy.hitFlashTicks = 8;

  // Oracle Rally Recovery: ONLY direct weapons & shield parries (NOT status/skills/diveSlam)!
  const isDirectWeaponOrParry =
    weaponId !== 'status' && weaponId !== 'skill' && weaponId !== 'diveSlam';
  if (isDirectWeaponOrParry && state.player.rallyHp > 0 && state.player.hp > 0) {
    const anchor = Math.max(state.player.rallyLostAnchor ?? state.player.rallyHp, state.player.rallyHp);
    let perHit = Math.min(
      Math.round(finalDamage * 0.12),
      Math.max(1, Math.round(anchor * 0.2))
    );
    if ((state.player.onHitShieldTicks ?? 0) > 0) {
      perHit = Math.round(perHit * 0.35);
    }
    const healFromRally = Math.min(state.player.rallyHp, Math.max(1, perHit));
    state.player.rallyHp = Math.max(0, state.player.rallyHp - healFromRally);
    state.player.hp = Math.min(state.player.maxHp, state.player.hp + healFromRally);
    state.events.push({
      type: 'rallyRecovered',
      x: state.player.pos.x,
      y: state.player.pos.y,
      amount: healFromRally,
    });
  }

  // Breach (with Slasher 0.7 & Royal Guard 0.65 combo super-armor!) & knockback
  let didBreach = false;
  if (breachPower > 0) {
    let breachResist = 0;
    if (enemy.state === 'attack' && enemy.defId === 'Comboter') {
      breachResist = 0.7;
    } else if (enemy.state === 'attack' && enemy.defId === 'CastleKnight') {
      breachResist = 0.65;
    }
    const effBreach = Math.round(breachPower * (1 - breachResist));
    enemy.breachMeter += effBreach;
    if (enemy.breachMeter >= enemy.breachThreshold) {
      enemy.breachMeter = 0;
      didBreach = true;
      if (!enemy.isBoss) {
        enemy.stunTicks = Math.max(enemy.stunTicks, 26);
        enemy.state = 'stunned';
        enemy.stateTicks = Math.max(enemy.stateTicks, 26);
        enemy.telegraphTicks = 0;
      }
    }
  }

  const kbScale = enemy.isBoss ? 0.14 : enemy.isElite ? 0.55 : 1.0;
  enemy.vel.x += knockbackX * kbScale;
  enemy.vel.y += knockbackY * kbScale;

  // Hitstop durations: 2 normal, 4 heavy/breach, 6 crit/parry
  const isWeaponDamage = weaponId !== 'status';
  if (isWeaponDamage) {
    if (isCrit) {
      state.hitstopTicks = Math.max(state.hitstopTicks, 6);
      state.screenShake = Math.max(state.screenShake, 4.5);
    } else if (didBreach || wallSlammed || breachPower >= 45) {
      state.hitstopTicks = Math.max(state.hitstopTicks, 4);
      state.screenShake = Math.max(state.screenShake, 3);
    } else {
      state.hitstopTicks = Math.max(state.hitstopTicks, 2);
      state.screenShake = Math.max(state.screenShake, 1.5);
    }
  }

  // Emitted events
  if (isCrit) {
    state.events.push({
      type: 'critImpact',
      x: enemy.pos.x,
      y: enemy.pos.y,
      damage: finalDamage,
      weaponId,
    });
    applyMutationCooldownReduction(state, true);
  } else {
    state.events.push({
      type: 'hitImpact',
      x: enemy.pos.x,
      y: enemy.pos.y,
      damage: finalDamage,
      breach: didBreach || wallSlammed,
      color: isWeaponDamage ? '#ffcf70' : '#ff6b6b',
      weaponId,
    });
  }

  // Floating damage numbers & blood sparks
  spawnParticle(
    state,
    enemy.pos.x + rng.rangeFloat(-6, 6),
    enemy.pos.y - enemy.height * 0.5 - 6,
    rng.rangeFloat(-18, 18),
    isCrit ? -54 : -38,
    isCrit ? 12 : 9,
    isCrit ? '#ffe852' : '#ffffff',
    isCrit ? 36 : 26,
    'text',
    true,
    0,
    isCrit ? `${finalDamage}!` : `${finalDamage}`
  );
  const sparkCount = isCrit ? 7 : 4;
  for (let i = 0; i < sparkCount; i++) {
    spawnParticle(
      state,
      enemy.pos.x,
      enemy.pos.y,
      rng.rangeFloat(-110, 110) + knockbackX * 0.3,
      rng.rangeFloat(-120, -10),
      isCrit ? 3.5 : 2.5,
      isCrit ? '#ffe866' : '#ff3b5c',
      20,
      isCrit ? 'spark' : 'blood',
      isCrit,
      340
    );
  }

  // Handle Enemy Death
  if (enemy.hp <= 0) {
    enemy.state = 'dead';
    enemy.telegraphTicks = 0;
    enemy.vel.x = knockbackX * 0.6;
    enemy.vel.y = -90;

    // Return all stuck arrows/knives lodged in this enemy!
    refundStuckArrows(state, enemy);

    // Clear Protector aura from allies if Protector died
    if (enemy.defId === 'Protector') {
      for (let i = 0; i < state.enemies.length; i++) {
        if (state.enemies[i]!.protectedByUid === enemy.uid) {
          state.enemies[i]!.protectedByUid = null;
        }
      }
    }

    // Worm drops 6 bouncing/resting pulsing death-eggs (parriable until detonation!)
    if (enemy.defId === 'Worm') {
      for (let i = 0; i < 6; i++) {
        const vx = -115 + i * 46 + rng.rangeFloat(-12, 12);
        const vy = rng.rangeFloat(-205, -125);
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'grenade',
          pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          vel: { x: vx, y: vy },
          radius: 5,
          damage: Math.max(12, Math.round(enemy.damage * 0.85)),
          isCrit: false,
          pierceLeft: 0,
          gravity: 560,
          ttlTicks: 165,
          maxTtlTicks: 165,
          color: '#ff6642',
          explosionRadius: 42,
          parriable: true,
          bouncesLeft: 1,
          floorFuseTicks: 60 + i * 5,
          hitIds: [],
        });
      }
    }

    // Cannibal (LeapingDuelyst) drops 1 delayed parting fuse bomb on death!
    if (enemy.defId === 'LeapingDuelyst') {
      state.projectiles.push({
        uid: state.nextUid++,
        owner: 'enemy',
        ownerUid: enemy.uid,
        kind: 'grenade',
        pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
        prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
        vel: { x: rng.rangeFloat(-45, 45), y: -155 },
        radius: 5,
        damage: Math.max(14, Math.round(enemy.damage * 0.9)),
        isCrit: false,
        pierceLeft: 0,
        gravity: 560,
        ttlTicks: 120,
        maxTtlTicks: 120,
        color: '#ff9c42',
        explosionRadius: 46,
        parriable: true,
        bouncesLeft: 1,
        floorFuseTicks: 48,
        hitIds: [],
      });
    }

    // Affix: Victims explode into a toxic cloud
    if (affixes && affixes.includes('explode_toxic')) {
      state.hazards.push({
        uid: state.nextUid++,
        rect: {
          x: enemy.pos.x - 42,
          y: enemy.pos.y - 24,
          w: 84,
          h: 36,
        },
        kind: 'toxicCloud',
        damage: Math.max(8, Math.round(finalDamage * 0.3)),
        ttlTicks: 240,
        owner: 'player',
      });
      for (let i = 0; i < state.enemies.length; i++) {
        const other = state.enemies[i]!;
        if (other.uid === enemy.uid || other.state === 'dead' || other.hp <= 0) continue;
        if (Math.hypot(other.pos.x - enemy.pos.x, other.pos.y - enemy.pos.y) <= 56) {
          applyStatus(other.statusEffects, 'poison', 240, getStatusDps(state, 'poison'), 0);
        }
      }
    }

    // ★ Star Affix: Victims freeze nearby enemies on death
    if (affixes && affixes.includes('freeze_death')) {
      spawnParticle(state, enemy.pos.x, enemy.pos.y, 0, 0, 72, '#7ce8ff', 16, 'ring', true, 0);
      for (let i = 0; i < state.enemies.length; i++) {
        const other = state.enemies[i]!;
        if (other.uid === enemy.uid || other.state === 'dead' || other.hp <= 0) continue;
        if (Math.hypot(other.pos.x - enemy.pos.x, other.pos.y - enemy.pos.y) <= 72) {
          applyEnemyStatus(state, other, 'freeze', 72, 0, rng, col);
        }
      }
    }

    // Boss death: 18-tick slow-mo burst, unlock boss gates, check KingsHand victory
    if (enemy.isBoss) {
      state.slowMoTicks = 18;
      state.screenShake = Math.max(state.screenShake, 12);
      state.bossArenaState.defeated = true;
      state.bossArenaState.active = false;
      for (let i = 0; i < state.doors.length; i++) {
        if (state.doors[i]!.kind === 'bossGate') {
          state.doors[i]!.opened = true;
        }
      }
      if (enemy.bossId === 'KingsHand') {
        finalizeRunVictory(state);
      }
    }

    const wDef = WEAPON_MAP[weaponId];
    const wasMelee = wDef ? wDef.kind === 'melee' : false;
    onEnemyKilledForCurseAndStreak(state, rng, enemy);
    applyMutationOnKill(state, enemy, wasMelee, isCrit);
  }

  return true;
}

function fireElectricWhipHitscan(
  state: SimState,
  weaponDef: WeaponDef,
  gear: GearInstance,
  step: StrikeStep,
  stepIndex: number,
  input: InputFrame,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  const baseDmg = computeGearDamage(step.basePower, gear, player.scrolls);
  const origin: Vec2 = { x: player.pos.x + player.facing * 12, y: player.pos.y - 4 };

  // Find closest living enemy in 136x80 frontal/aim cone (auto-target, ignores shields!)
  let aimDx: number = player.facing;
  let aimDy = 0;
  if (hasValidAim(input)) {
    const rdx = input.aimX - origin.x;
    const rdy = input.aimY - origin.y;
    const rlen = Math.hypot(rdx, rdy);
    if (rlen >= 4) {
      aimDx = rdx / rlen;
      aimDy = rdy / rlen;
    }
  }

  let primary: EnemyState | null = null;
  let bestDist = step.rangeX + 1;
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
    const ex = e.pos.x - player.pos.x;
    const ey = e.pos.y - player.pos.y;
    const dist = Math.hypot(ex, ey);
    if (dist > step.rangeX || Math.abs(ey) > step.rangeY) continue;
    const aligned = hasValidAim(input) ? ex * aimDx + ey * aimDy >= -18 : ex * player.facing >= -18;
    if (!aligned) continue;
    if (dist < bestDist) {
      bestDist = dist;
      primary = e;
    }
  }

  if (!primary) {
    // Emit crackle lightning arc into the air along facing/aim
    const tip: Vec2 = {
      x: origin.x + aimDx * Math.min(88, step.rangeX * 0.65),
      y: origin.y + aimDy * Math.min(88, step.rangeX * 0.65),
    };
    state.events.push({ type: 'lightningArc', points: [origin, tip] });
    return;
  }

  const arcPoints: Vec2[] = [origin];
  const hitSet = new Set<number>();

  const strikeTarget = (target: EnemyState, dmgScale: number): boolean => {
    hitSet.add(target.uid);
    arcPoints.push({ x: target.pos.x, y: target.pos.y });
    const dist = Math.hypot(target.pos.x - player.pos.x, target.pos.y - player.pos.y);
    const inWater = isEntityInWater(state, target.pos.x, target.pos.y, target.height, col);
    const isCrit = inWater || evaluateCritCondition(state, weaponDef, stepIndex, target, col);
    const mutMult = getMutationDamageMultiplier(state, false, dist);
    const dmg = Math.max(1, Math.round(baseDmg * dmgScale * mutMult * (isCrit ? step.critMul : 1)));

    applyWeaponAndAffixStatuses(
      state,
      target,
      'electrify',
      gear.affixes,
      false,
      weaponDef.id,
      stepIndex,
      rng,
      col
    );
    if (inWater) {
      applyEnemyStatus(state, target, 'stun', 20, 0, rng, col);
    }
    damageEnemy(
      state,
      target,
      dmg,
      isCrit,
      step.breachPower,
      (target.pos.x >= player.pos.x ? 1 : -1) * 45,
      -20,
      rng,
      weaponDef.id,
      gear.affixes,
      col
    );

    for (let s = 0; s < 4; s++) {
      spawnParticle(
        state,
        target.pos.x + rng.rangeFloat(-8, 8),
        target.pos.y + rng.rangeFloat(-10, 8),
        rng.rangeFloat(-75, 75),
        rng.rangeFloat(-75, 45),
        3,
        inWater ? '#ffe866' : '#78e6ff',
        12,
        'spark',
        true,
        0
      );
    }
    return inWater;
  };

  const primaryWet = strikeTarget(primary, 1.0);

  // Chain up to 3 nearby enemies within 84px for 50% damage (plus all nearby wet enemies if in water!)
  let chainOrigin = primary;
  let chainsLeft = 3;
  while (chainsLeft > 0) {
    let nextTarget: EnemyState | null = null;
    let nextDist = 85;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried || hitSet.has(e.uid)) continue;
      const d = Math.hypot(e.pos.x - chainOrigin.pos.x, e.pos.y - chainOrigin.pos.y);
      if (d <= 84 && d < nextDist) {
        nextDist = d;
        nextTarget = e;
      }
    }
    if (!nextTarget) break;
    strikeTarget(nextTarget, 0.5);
    chainOrigin = nextTarget;
    chainsLeft -= 1;
  }

  // Water conductivity: conduct across ALL enemies standing in the same water pool (r <= 145px)!
  if (primaryWet) {
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried || hitSet.has(e.uid)) continue;
      if (
        Math.hypot(e.pos.x - primary.pos.x, e.pos.y - primary.pos.y) <= 145 &&
        isEntityInWater(state, e.pos.x, e.pos.y, e.height, col)
      ) {
        strikeTarget(e, 0.75);
      }
    }
  }

  state.events.push({ type: 'lightningArc', points: arcPoints });
  spawnTransientLight(
    state,
    primary.pos.x,
    primary.pos.y - 4,
    115,
    [0.42, 0.9, 1.0],
    1.7,
    10,
    'slash'
  );
}

function fireRangedWeapon(
  state: SimState,
  weaponDef: WeaponDef,
  gear: GearInstance,
  step: StrikeStep,
  stepIndex: number,
  input: InputFrame,
  rng: RngAPI,
  col: CollisionAPI
): void {
  if (weaponDef.id === 'Whip') {
    fireElectricWhipHitscan(state, weaponDef, gear, step, stepIndex, input, rng, col);
    return;
  }

  const player = state.player;
  const baseDmg = computeGearDamage(step.basePower, gear, player.scrolls);
  const speed = step.projectileSpeed ?? 390;
  const spawnX = player.pos.x + player.facing * step.offsetX;
  const spawnY = player.pos.y + step.offsetY;

  let aimDx: number = player.facing;
  let aimDy = 0;

  // Throwing Knife ALWAYS auto-aims vertically toward nearest threat in front cone (175x96)!
  const forceAutoTarget = weaponDef.id === 'ThrowingKnife';
  let autoTargeted = false;

  if (forceAutoTarget || !hasValidAim(input)) {
    let bestDist = step.rangeX;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
      const dx = e.pos.x - spawnX;
      const dy = e.pos.y - spawnY;
      if (dx * player.facing < -8) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist && Math.abs(dy) <= Math.max(step.rangeY, 72)) {
        bestDist = dist;
        aimDx = dx / Math.max(1, dist);
        aimDy = dy / Math.max(1, dist);
        autoTargeted = true;
      }
    }
  }

  if (!autoTargeted && hasValidAim(input)) {
    // Cursor aiming with gentle magnetic auto-assist onto enemies near the aim ray
    const rawDx = input.aimX - spawnX;
    const rawDy = input.aimY - spawnY;
    const rawLen = Math.hypot(rawDx, rawDy);
    if (rawLen >= 4) {
      aimDx = rawDx / rawLen;
      aimDy = rawDy / rawLen;
    }

    let bestScore = Infinity;
    let bestUx = aimDx;
    let bestUy = aimDy;
    let bestPerp = Infinity;

    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
      const ex = e.pos.x - spawnX;
      const ey = e.pos.y - spawnY;
      const edist = Math.hypot(ex, ey);
      if (edist < 1 || edist > step.rangeX) continue;
      const ux = ex / edist;
      const uy = ey / edist;
      const dot = ux * aimDx + uy * aimDy;
      if (dot < 0.88) continue;
      const perpDist = Math.abs(ex * aimDy - ey * aimDx);
      if (perpDist > 34) continue;
      const score = perpDist + edist * 0.08;
      if (score < bestScore) {
        bestScore = score;
        bestUx = ux;
        bestUy = uy;
        bestPerp = perpDist;
      }
    }

    if (bestScore < Infinity) {
      const assist = Math.max(0.2, Math.min(0.65, 1 - bestPerp / 42));
      const bx = aimDx * (1 - assist) + bestUx * assist;
      const by = aimDy * (1 - assist) + bestUy * assist;
      const blen = Math.hypot(bx, by) || 1;
      aimDx = bx / blen;
      aimDy = by / blen;
    }
  }

  let pierce = step.pierceCount ?? 0;
  if (gear.affixes.includes('pierce_first')) {
    pierce += 1;
  }

  const kind = step.projectileKind ?? 'arrow';
  const radius = kind === 'fireball' ? 6 : 4;
  const ttl = Math.max(14, Math.round((step.rangeX / Math.max(100, speed)) * 60) + 6);
  const tracksAmmo = weaponDef.ammoCapacity !== undefined;

  state.projectiles.push({
    uid: state.nextUid++,
    owner: 'player',
    ownerUid: 0,
    kind,
    pos: { x: spawnX, y: spawnY },
    prevPos: { x: spawnX, y: spawnY },
    vel: { x: aimDx * speed, y: aimDy * speed },
    radius,
    damage: baseDmg,
    isCrit: false, // Evaluated per target hit!
    pierceLeft: pierce,
    gravity: kind === 'fireball' ? 60 : 0,
    ttlTicks: ttl,
    maxTtlTicks: ttl,
    color: step.slashColor,
    applyStatus: step.applyStatus,
    explosionRadius: kind === 'fireball' ? 28 : undefined,
    parriable: false,
    hitIds: [],
    affixes: gear.affixes,
    sourceWeaponSlot: tracksAmmo ? player.activeWeaponSlot : undefined,
  });
}

function executeMeleeActiveFrame(
  state: SimState,
  weaponDef: WeaponDef,
  gear: GearInstance,
  step: StrikeStep,
  stepIndex: number,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  const hitCenterX = player.pos.x + player.facing * step.offsetX;
  const hitCenterY = player.pos.y + step.offsetY;
  const baseDmg = computeGearDamage(step.basePower, gear, player.scrolls);

  // Smash wooden doors in weapon reach (even if already opened, as long as unbroken!)
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i]!;
    if (door.kind !== 'wood' || door.broken) continue;
    if (
      aabbOverlap(
        hitCenterX,
        hitCenterY,
        step.rangeX,
        step.rangeY,
        door.pos.x,
        door.pos.y,
        door.width,
        door.height
      )
    ) {
      door.broken = true;
      door.opened = true;
      state.events.push({ type: 'doorSmash', x: door.pos.x, y: door.pos.y });
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j]!;
        if (e.state === 'dead' || e.hp <= 0 || e.isBoss) continue;
        const ddx = e.pos.x - door.pos.x;
        if (ddx * player.facing >= -16 && Math.hypot(ddx, e.pos.y - door.pos.y) <= 84) {
          applyEnemyStatus(state, e, 'stun', 90, 0, rng, col);
          e.vel.x += player.facing * 95;
        }
      }
    }
  }

  // Damage enemy boss banners in reach
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i]!;
    if (t.owner !== 'enemy') continue;
    if (player.attackHitIds.includes(t.uid)) continue;
    if (aabbOverlap(hitCenterX, hitCenterY, step.rangeX, step.rangeY, t.pos.x, t.pos.y, 18, 30)) {
      player.attackHitIds.push(t.uid);
      t.hp -= baseDmg;
      spawnParticle(state, t.pos.x, t.pos.y - 8, 0, -40, 4, '#ffd166', 18, 'spark', true, 160);
      if (t.hp <= 0) {
        state.turrets.splice(i, 1);
      }
    }
  }

  // Hit enemies
  for (let i = 0; i < state.enemies.length; i++) {
    const enemy = state.enemies[i]!;
    if (enemy.state === 'dead' || enemy.hp <= 0 || enemy.buried) continue;
    if (player.attackHitIds.includes(enemy.uid)) continue;

    if (
      aabbOverlap(
        hitCenterX,
        hitCenterY,
        step.rangeX,
        step.rangeY,
        enemy.pos.x,
        enemy.pos.y,
        enemy.width,
        enemy.height
      )
    ) {
      player.attackHitIds.push(enemy.uid);
      const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);

      // Balanced Blade (`QuickSword`) progressive hit-stack ramp (+8%/stack up to 9, crits at >= 10!)
      let balancedMult = 1.0;
      if (weaponDef.id === 'QuickSword') {
        const stacks = Math.min(20, (player.balancedStacks ?? 0) + 1);
        player.balancedStacks = stacks;
        player.balancedDecayTicks = 210;
        balancedMult = 1 + Math.min(9, stacks - 1) * 0.08;
      }

      const isCrit = evaluateCritCondition(state, weaponDef, stepIndex, enemy, col);
      const mutMult = getMutationDamageMultiplier(state, true, dist);
      let rawDamage = Math.round(
        baseDmg * balancedMult * mutMult * (isCrit ? step.critMul : 1.0)
      );

      // Phaser empowers the NEXT MELEE STRIKE of ANY weapon!
      if ((player.phaserBuffTicks ?? 0) > 0 && (player.phaserBonusDamage ?? 0) > 0) {
        rawDamage += player.phaserBonusDamage!;
        player.phaserBonusDamage = 0;
        player.phaserBuffTicks = 0;
        spawnParticle(state, enemy.pos.x, enemy.pos.y, 0, 0, 38, '#52f5ff', 14, 'ring', true, 0);
        spawnParticle(
          state,
          enemy.pos.x,
          enemy.pos.y - 28,
          0,
          -36,
          10,
          '#52f5ff',
          28,
          'text',
          true,
          0,
          'PHASED!'
        );
      }

      const kbSpeed =
        weaponDef.id === 'ImpaleSpear'
          ? 150
          : step.breachPower >= 45
            ? 165
            : 95;
      const kbX = player.facing * kbSpeed;
      const kbY = step.breachPower >= 45 ? -70 : -25;

      const damaged = damageEnemy(
        state,
        enemy,
        rawDamage,
        isCrit,
        step.breachPower,
        kbX,
        kbY,
        rng,
        weaponDef.id,
        gear.affixes,
        col
      );
      if (damaged && enemy.hp > 0) {
        applyWeaponAndAffixStatuses(
          state,
          enemy,
          step.applyStatus,
          gear.affixes,
          true,
          weaponDef.id,
          stepIndex,
          rng,
          col
        );
      }
    }
  }
}

function startParryAction(
  state: SimState,
  slot: 1 | 2,
  input: InputFrame,
  rng: RngAPI
): void {
  const player = state.player;
  applyAimFacing(state, input);
  player.activeWeaponSlot = slot;
  player.attackPhase = 'none';
  player.attackPhaseTicks = 0;
  player.attackHitIds = [];
  player.actionState = 'parry';
  player.actionTicks = 16;
  player.parryWindowTicks = 16;
  player.parryCooldownTicks = 36; // 36t whiff lockout (reset to 0 on success!)
  player.shieldBlocking = false;
  player.shieldHoldTicks = 0;
  player.queuedInput = 'none';
  player.queuedInputTicks = 0;

  // Immediate unmistakable golden shield-raise feedback even if no enemy hits!
  state.events.push({
    type: 'parryStart',
    x: player.pos.x,
    y: player.pos.y,
    facing: player.facing,
  });
  const arcX = player.pos.x + player.facing * 10;
  const arcY = player.pos.y - 2;
  spawnParticle(state, arcX, arcY, 0, 0, 22, '#ffe266', 12, 'ring', true, 0);
  for (let i = 0; i < 5; i++) {
    const ang = -0.85 + (i / 4) * 1.7;
    const spd = 75 + (i % 2) * 35;
    spawnParticle(
      state,
      arcX,
      arcY,
      Math.cos(ang) * spd * player.facing,
      Math.sin(ang) * spd,
      3.2,
      i % 2 === 0 ? '#fff08a' : '#ffcf48',
      13,
      'spark',
      true,
      0
    );
  }

  // Immediate contact check against overlapping parriable projectiles & active melee swings
  tryParryOverlappingThreats(state, rng);
}

function startWeaponAttack(state: SimState, slot: 1 | 2, input: InputFrame): boolean {
  const player = state.player;
  const gear = getWeaponGear(state, slot);
  if (!gear) return false;
  const weaponDef = getWeapon(gear.defId);
  if (weaponDef.kind === 'shield') return false;

  if (weaponDef.ammoCapacity !== undefined && gear.ammo !== undefined && gear.ammo <= 0) {
    return false;
  }

  applyAimFacing(state, input);
  player.shieldBlocking = false;
  player.shieldHoldTicks = 0;
  // Attacking breaks Predator stealth invisibility!
  player.stealthTicks = 0;

  if (player.activeWeaponSlot !== slot || player.comboResetTicks <= 0) {
    player.comboStep = 0;
  }
  player.activeWeaponSlot = slot;
  const stepIndex = player.comboStep % weaponDef.strikeChain.length;
  const step = weaponDef.strikeChain[stepIndex]!;

  player.actionState = 'attack';
  player.attackPhase = 'windup';
  player.attackPhaseTicks = Math.max(1, step.windupTicks);
  player.attackHitIds = [];
  player.comboResetTicks = 45;
  player.queuedInput = 'none';
  player.queuedInputTicks = 0;
  return true;
}

export function stepPlayerCombat(
  state: SimState,
  input: InputFrame,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  if (player.actionState === 'dead' || state.runStatus !== 'playing') {
    player.shieldBlocking = false;
    player.shieldHoldTicks = 0;
    return;
  }

  // Decrement combat, buff & mutation timers
  if (player.comboResetTicks > 0) {
    player.comboResetTicks -= 1;
    if (player.comboResetTicks === 0 && player.attackPhase === 'none') {
      player.comboStep = 0;
    }
  }
  if (player.afterRollCritTicks > 0) player.afterRollCritTicks -= 1;
  if (player.afterParryCritTicks > 0) player.afterParryCritTicks -= 1;
  if (player.parryCooldownTicks > 0) player.parryCooldownTicks -= 1;
  if (player.comboMutationTicks > 0) player.comboMutationTicks -= 1;
  if (player.disengagementCooldownTicks > 0) player.disengagementCooldownTicks -= 1;
  if (player.hitFlashTicks > 0) player.hitFlashTicks -= 1;
  if (player.speedBuffTicks > 0) player.speedBuffTicks -= 1;
  if ((player.onHitShieldTicks ?? 0) > 0) player.onHitShieldTicks! -= 1;
  if ((player.vengeanceTicks ?? 0) > 0) player.vengeanceTicks! -= 1;
  if ((player.stealthTicks ?? 0) > 0) player.stealthTicks! -= 1;
  if ((player.wdlmCooldownTicks ?? 0) > 0) player.wdlmCooldownTicks! -= 1;
  if ((player.phaserBuffTicks ?? 0) > 0) {
    player.phaserBuffTicks! -= 1;
    if (player.phaserBuffTicks === 0) {
      player.phaserBonusDamage = 0;
    }
  }
  if ((player.balancedDecayTicks ?? 0) > 0) {
    player.balancedDecayTicks! -= 1;
    if (player.balancedDecayTicks === 0) {
      player.balancedStacks = 0;
    }
  }
  if ((player.tempShieldTicks ?? 0) > 0) {
    player.tempShieldTicks! -= 1;
    if (player.tempShieldTicks === 0) {
      player.tempShieldHp = 0;
    }
  }
  if ((player.speedComboDecayTicks ?? 0) > 0) {
    player.speedComboDecayTicks! -= 1;
    if (player.speedComboDecayTicks === 0) {
      player.speedKillCount = 0;
    }
  }

  if (player.healTicks > 0) {
    player.healTicks -= 1;
    if (player.healTicks === 0 && player.actionState === 'heal') {
      player.actionState = 'idle';
    }
  }

  // Skill cooldown tickdown
  if (player.loadout.skill1 && player.loadout.skill1.cooldownTicks > 0) {
    player.loadout.skill1.cooldownTicks -= 1;
  }
  if (player.loadout.skill2 && player.loadout.skill2.cooldownTicks > 0) {
    player.loadout.skill2.cooldownTicks -= 1;
  }

  // Tick player status effects
  tickEntityStatuses(player.statusEffects, (kind, amount) => {
    state.events.push({ type: 'statusProc', x: player.pos.x, y: player.pos.y, status: kind });
    damagePlayer(state, amount, kind, rng, true);
  });

  // Corrupted Power continuous electric shock aura (every 30 ticks within 64px!)
  if (hasStatus(player.statusEffects, 'corrupted') && state.tick % 30 === 0) {
    const auraDmg = Math.max(
      8,
      Math.round(
        18 *
          Math.pow(
            1.15,
            Math.max(0, Math.max(player.scrolls.brutality, player.scrolls.tactics) - 1)
          )
      )
    );
    let hitAny = false;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
      if (Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= 64) {
        hitAny = true;
        applyEnemyStatus(state, e, 'electrify', 120, getStatusDps(state, 'electrify'), rng, col);
        damageEnemy(state, e, auraDmg, false, 10, 0, 0, rng, 'skill', undefined, col);
      }
    }
    if (hitAny) {
      spawnParticle(state, player.pos.x, player.pos.y, 0, 0, 64, '#b86bff', 12, 'ring', true, 0);
    }
  }

  // Tick Oracle Rally (Orange Health Recovery): hold 36t, then drain 0.30 * maxHp * FIXED_DT
  if (player.rallyHp > 0) {
    if (player.rallyHoldTicks > 0) {
      player.rallyHoldTicks -= 1;
    } else {
      const drainRate = Math.max(0.05, 0.3 * player.maxHp * FIXED_DT);
      player.rallyHp = Math.max(0, player.rallyHp - drainRate);
      if (player.rallyDrainTicks > 0) player.rallyDrainTicks -= 1;
      if (player.rallyHp <= 0.01) {
        player.rallyHp = 0;
        player.rallyLostAnchor = 0;
      }
    }
  }

  // Flame trail affix while rolling or speed-buffed
  if (
    (player.actionState === 'roll' || player.speedBuffTicks > 0) &&
    state.tick % 10 === 0 &&
    hasLoadoutAffixKind(state, 'flameTrail')
  ) {
    state.hazards.push({
      uid: state.nextUid++,
      rect: { x: player.pos.x - 10, y: player.pos.y + 4, w: 20, h: 12 },
      kind: 'burningOil',
      damage: Math.max(
        8,
        Math.round(12 * Math.pow(1.15, Math.max(0, player.scrolls.brutality - 1)))
      ),
      ttlTicks: 90,
      owner: 'player',
    });
  }

  // Determine if weapon1 or weapon2 is a shield
  const w1Def = player.loadout.weapon1 ? WEAPON_MAP[player.loadout.weapon1.defId] : null;
  const w2Def = player.loadout.weapon2 ? WEAPON_MAP[player.loadout.weapon2.defId] : null;

  // 4-tick input buffering queue
  if (input.rollPressed) {
    player.queuedInput = 'roll';
    player.queuedInputTicks = 4;
  } else if (input.weapon1Pressed && w1Def?.kind === 'shield') {
    player.queuedInput = 'parry';
    player.queuedInputTicks = 4;
    player.activeWeaponSlot = 1;
  } else if (input.weapon2Pressed && w2Def?.kind === 'shield') {
    player.queuedInput = 'parry';
    player.queuedInputTicks = 4;
    player.activeWeaponSlot = 2;
  } else if (input.weapon1Pressed) {
    player.queuedInput = 'attack1';
    player.queuedInputTicks = 4;
  } else if (input.weapon2Pressed) {
    player.queuedInput = 'attack2';
    player.queuedInputTicks = 4;
  } else if (player.queuedInputTicks > 0) {
    player.queuedInputTicks -= 1;
    if (player.queuedInputTicks === 0) {
      player.queuedInput = 'none';
    }
  }

  // React to physics.ts roll initiation (single source of truth in physics.ts — NO duplicate roll-start here!)
  if (player.actionState === 'roll') {
    if (player.attackPhase !== 'none') {
      player.attackPhase = 'none';
      player.attackPhaseTicks = 0;
      player.attackHitIds = [];
    }
    player.parryWindowTicks = 0;
    player.shieldBlocking = false;
    player.shieldHoldTicks = 0;
    player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 60);
  }

  // Instant Shield Parry Cancel of weapon windup & recovery
  const wantParrySlot: 1 | 2 | null =
    input.weapon1Pressed && w1Def?.kind === 'shield'
      ? 1
      : input.weapon2Pressed && w2Def?.kind === 'shield'
        ? 2
        : player.queuedInput === 'parry'
          ? w1Def?.kind === 'shield'
            ? 1
            : w2Def?.kind === 'shield'
              ? 2
              : null
          : null;

  if (wantParrySlot !== null && player.parryCooldownTicks <= 0 && player.actionState !== 'roll') {
    startParryAction(state, wantParrySlot, input, rng);
  }

  // Track shield hold duration (first 12-16t auto-parries, >= 16t enters frontal-only Hold-to-Block!)
  const holdingShield =
    (input.weapon2Held && w2Def?.kind === 'shield') ||
    (input.weapon1Held && w1Def?.kind === 'shield');
  if (holdingShield && player.actionState !== 'roll' && player.healTicks <= 0) {
    player.shieldHoldTicks = (player.shieldHoldTicks ?? 0) + 1;
  } else {
    player.shieldHoldTicks = 0;
  }

  // Tick active Parry window & check overlapping parriable projectiles / active melee swings
  if (player.parryWindowTicks > 0) {
    if (!tryParryOverlappingThreats(state, rng) && player.parryWindowTicks > 0) {
      player.parryWindowTicks -= 1;
      if (player.parryWindowTicks === 0 && player.actionState === 'parry') {
        state.events.push({ type: 'parryFail', x: player.pos.x, y: player.pos.y });
        player.actionState = player.grounded ? 'idle' : 'fall';
      }
    }
  } else if (player.actionState === 'parrySuccess') {
    if (player.actionTicks > 0) {
      player.actionTicks -= 1;
    } else {
      player.actionState = player.grounded ? 'idle' : 'fall';
    }
  }

  // Health Flask activation (heals 60% max HP + clears 30 Malaise on 5BC) + full/empty feedback
  if (input.healPressed && player.actionState !== 'roll' && player.healTicks <= 0) {
    if (player.hp >= player.maxHp) {
      state.events.push({
        type: 'flaskEmpty',
        x: player.pos.x,
        y: player.pos.y,
        reason: 'fullHp',
      });
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y - 22,
        0,
        -28,
        10,
        '#a8ffd0',
        34,
        'text',
        true,
        0,
        'FULL HP'
      );
    } else if (player.flaskCharges <= 0) {
      state.events.push({
        type: 'flaskEmpty',
        x: player.pos.x,
        y: player.pos.y,
        reason: 'empty',
      });
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y - 22,
        0,
        -28,
        10,
        '#ff7b7b',
        34,
        'text',
        true,
        0,
        'NO FLASK'
      );
    } else {
      player.flaskCharges -= 1;
      const healAmount = Math.max(1, Math.round(player.maxHp * 0.6));
      const beforeHp = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + healAmount);
      const actualHealed = player.hp - beforeHp;
      player.rallyHp = 0;
      player.rallyLostAnchor = 0;
      if (state.bossStemCells >= 5) {
        player.malaise = Math.max(0, (player.malaise ?? 0) - 30);
      }
      player.healTicks = 24;
      player.iframeTicks = Math.max(player.iframeTicks, 20);
      player.actionState = 'heal';
      player.attackPhase = 'none';
      player.attackPhaseTicks = 0;
      player.shieldBlocking = false;
      player.shieldHoldTicks = 0;
      state.events.push({
        type: 'flaskDrink',
        x: player.pos.x,
        y: player.pos.y,
        healed: actualHealed,
      });
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y - 22,
        0,
        -34,
        11,
        '#4dff88',
        40,
        'text',
        true,
        0,
        `+${actualHealed} HP`
      );
      for (let i = 0; i < 10; i++) {
        spawnParticle(
          state,
          player.pos.x + rng.rangeFloat(-10, 10),
          player.pos.y + rng.rangeFloat(-8, 12),
          rng.rangeFloat(-26, 26),
          rng.rangeFloat(-88, -36),
          3.5,
          i % 2 === 0 ? '#4dff88' : '#96ffc8',
          28 + (i % 4) * 3,
          'spark',
          true,
          -25
        );
      }
      spawnTransientLight(
        state,
        player.pos.x,
        player.pos.y - 8,
        122,
        [0.24, 1.0, 0.56],
        1.85,
        22,
        'status'
      );
    }
  }

  // Skill activation (allow casting outside roll OR during late roll cancel window!)
  const canCastSkill = player.actionState !== 'roll' || player.rollTicks <= 5;
  if (input.skill1Pressed && canCastSkill) {
    activateSkill(state, 1, rng, col, input);
  }
  if (input.skill2Pressed && canCastSkill) {
    activateSkill(state, 2, rng, col, input);
  }

  // Do not run weapon attacks while rolling, parrying, drinking flask, or dizzy/fall-stunned
  if (
    player.actionState === 'roll' ||
    player.parryWindowTicks > 0 ||
    player.healTicks > 0 ||
    (player.fallStunTicks ?? 0) > 0
  ) {
    player.shieldBlocking = false;
    return;
  }

  // Start new attack if idle or queued during end of recovery
  const isRecoveryCancel =
    player.attackPhase === 'recovery' && player.attackPhaseTicks <= 2;
  const canStartNew = player.attackPhase === 'none' || isRecoveryCancel;

  if (canStartNew) {
    const wantSlot: 1 | 2 | null =
      (input.weapon1Pressed || input.weapon1Held || player.queuedInput === 'attack1') &&
      w1Def &&
      w1Def.kind !== 'shield'
        ? 1
        : (input.weapon2Pressed || input.weapon2Held || player.queuedInput === 'attack2') &&
            w2Def &&
            w2Def.kind !== 'shield'
          ? 2
          : null;

    if (wantSlot !== null) {
      if (isRecoveryCancel && player.activeWeaponSlot === wantSlot) {
        const prevDef = wantSlot === 1 ? w1Def : w2Def;
        if (prevDef) {
          player.comboStep =
            prevDef.strikeChain.length > 1
              ? (player.comboStep + 1) % prevDef.strikeChain.length
              : Math.min(99, player.comboStep + 1);
          player.comboResetTicks = 34;
        }
      }
      startWeaponAttack(state, wantSlot, input);
    }
  }

  // Advance active weapon swing phases
  if (player.attackPhase !== 'none') {
    const gear = getWeaponGear(state, player.activeWeaponSlot);
    if (!gear) {
      player.attackPhase = 'none';
      player.shieldBlocking = false;
      return;
    }
    const weaponDef = getWeapon(gear.defId);
    const stepIndex = player.comboStep % weaponDef.strikeChain.length;
    const step = weaponDef.strikeChain[stepIndex]!;

    player.attackPhaseTicks -= 1;

    if (player.attackPhase === 'windup' && player.attackPhaseTicks <= 0) {
      player.attackPhase = 'active';
      player.attackPhaseTicks = Math.max(1, step.activeTicks);
      player.attackHitIds = [];
      player.vel.x += player.facing * step.forwardImpulse;

      state.events.push({
        type: 'attackSwing',
        x: player.pos.x + player.facing * step.offsetX,
        y: player.pos.y + step.offsetY,
        facing: player.facing,
        weaponId: weaponDef.id,
        stepIndex,
        color: step.slashColor,
      });

      spawnParticle(
        state,
        player.pos.x + player.facing * (step.offsetX * 0.8),
        player.pos.y + step.offsetY,
        player.facing * 24,
        0,
        step.rangeX * 0.6,
        step.slashColor,
        Math.max(6, step.activeTicks + 3),
        'slash',
        true,
        0
      );

      if (step.isRanged) {
        if (weaponDef.ammoCapacity !== undefined && gear.ammo !== undefined) {
          gear.ammo = Math.max(0, gear.ammo - 1);
        }
        fireRangedWeapon(state, weaponDef, gear, step, stepIndex, input, rng, col);
      } else {
        executeMeleeActiveFrame(state, weaponDef, gear, step, stepIndex, rng, col);
      }
    } else if (player.attackPhase === 'active') {
      if (!step.isRanged) {
        executeMeleeActiveFrame(state, weaponDef, gear, step, stepIndex, rng, col);
      }
      if (player.attackPhaseTicks <= 0) {
        player.attackPhase = 'recovery';
        player.attackPhaseTicks = Math.max(1, step.recoveryTicks);
      }
    } else if (player.attackPhase === 'recovery' && player.attackPhaseTicks <= 0) {
      player.attackPhase = 'none';
      player.comboStep =
        weaponDef.strikeChain.length > 1
          ? (stepIndex + 1) % weaponDef.strikeChain.length
          : Math.min(99, player.comboStep + 1);
      player.comboResetTicks = 34;
      if (player.actionState === 'attack') {
        player.actionState = player.grounded ? 'idle' : 'fall';
      }
    }
  }

  // Hold-to-Block activates strictly after shieldHoldTicks >= 16 (first 12-16t auto-parries!)
  player.shieldBlocking =
    Boolean(holdingShield) &&
    (player.shieldHoldTicks ?? 0) >= 16 &&
    player.actionState !== 'attack' &&
    player.actionState !== 'heal' &&
    player.attackPhase === 'none' &&
    player.parryWindowTicks <= 0 &&
    player.healTicks <= 0;
}

export function activateSkill(
  state: SimState,
  slot: 1 | 2,
  rng: RngAPI,
  col: CollisionAPI,
  input?: InputFrame
): boolean {
  const player = state.player;
  const gear = getSkillGear(state, slot);
  if (!gear || gear.cooldownTicks > 0) return false;

  const skillDef = getSkill(gear.defId);
  gear.cooldownTicks = skillDef.cooldownTicks;
  const scaledDmg = computeGearDamage(skillDef.basePower, gear, player.scrolls);

  if (skillDef.id !== 'Tonic') {
    player.stealthTicks = 0;
  }

  // Face cursor direction for thrown/deployed/blink skills unless holding opposite direction
  if (
    skillDef.kind === 'grenade' ||
    skillDef.kind === 'turret' ||
    skillDef.kind === 'trap' ||
    skillDef.kind === 'teleport'
  ) {
    applyAimFacing(state, input);
  }

  state.events.push({
    type: 'skillCast',
    x: player.pos.x,
    y: player.pos.y,
    skillId: skillDef.id,
  });

  switch (skillDef.id) {
    case 'SinewSlicer':
    case 'HeavyTurret': {
      // Cap active player turrets of same kind to 1 (replace oldest)
      const kind = skillDef.id === 'SinewSlicer' ? 'sinew' : 'heavy';
      for (let i = state.turrets.length - 1; i >= 0; i--) {
        if (state.turrets[i]!.owner === 'player' && state.turrets[i]!.kind === kind) {
          state.turrets.splice(i, 1);
        }
      }
      const desiredX = player.pos.x + player.facing * 18;
      const desiredTx = Math.floor(desiredX / TILE_SIZE);
      const playerTy = Math.floor(player.pos.y / TILE_SIZE);
      const spawnX = col.isSolidAt(state.tileGrid, desiredTx, playerTy) ? player.pos.x : desiredX;
      const floorY = findFloorY(state, spawnX, player.pos.y, col);
      const spawnY = floorY - 6;

      state.turrets.push({
        uid: state.nextUid++,
        defId: skillDef.id,
        pos: { x: spawnX, y: spawnY },
        hp: 150,
        maxHp: 150,
        damage: scaledDmg,
        range: skillDef.radius,
        fireCooldownTicks: 10,
        ttlTicks: skillDef.durationTicks,
        facing: player.facing,
        kind,
        owner: 'player',
      });
      spawnParticle(
        state,
        spawnX,
        spawnY,
        0,
        0,
        24,
        kind === 'sinew' ? '#ff6680' : '#ffd166',
        12,
        'ring',
        true,
        0
      );
      for (let s = 0; s < 6; s++) {
        spawnParticle(
          state,
          spawnX,
          spawnY,
          rng.rangeFloat(-75, 75),
          rng.rangeFloat(-95, -20),
          3,
          kind === 'sinew' ? '#ff8599' : '#ffe27a',
          16,
          'spark',
          true,
          280
        );
      }
      break;
    }

    case 'InfantryGrenade':
    case 'FireGrenade':
    case 'IceGrenade':
    case 'ClusterGrenade': {
      const isCluster = skillDef.id === 'ClusterGrenade';
      const isInfantry = skillDef.id === 'InfantryGrenade';
      const color =
        skillDef.id === 'FireGrenade'
          ? '#ff6b2b'
          : skillDef.id === 'IceGrenade'
            ? '#6ee8ff'
            : isCluster
              ? '#ff9c3b'
              : '#ffcf52';

      let throwVx = player.facing * 230;
      let throwVy = -185;
      if (hasValidAim(input)) {
        const dx = input.aimX - player.pos.x;
        const dy = input.aimY - player.pos.y;
        const distFactor = Math.max(0, Math.min(1, Math.abs(dx) / 220));
        const speedX = 140 + distFactor * 170; // 140..310 px/s
        throwVx = player.facing * speedX;
        const elevAdjust = Math.max(-75, Math.min(55, dy * 0.45));
        throwVy = -185 + elevAdjust;
      }

      state.projectiles.push({
        uid: state.nextUid++,
        owner: 'player',
        ownerUid: 0,
        kind: isCluster ? 'cluster' : 'grenade',
        pos: { x: player.pos.x + player.facing * 10, y: player.pos.y - 6 },
        prevPos: { x: player.pos.x + player.facing * 10, y: player.pos.y - 6 },
        vel: { x: throwVx, y: throwVy },
        radius: 5,
        damage: scaledDmg,
        isCrit: false,
        pierceLeft: 0,
        gravity: 620,
        ttlTicks: isInfantry ? 68 : 54,
        maxTtlTicks: isInfantry ? 68 : 54,
        color,
        applyStatus: skillDef.applyStatus,
        explosionRadius: skillDef.radius,
        parriable: false,
        bouncesLeft: isInfantry ? 1 : 0,
        floorFuseTicks: isInfantry ? 18 : undefined,
        hitIds: [],
        affixes: gear.affixes,
      });
      break;
    }

    case 'Phaser': {
      let target: EnemyState | null = null;
      let bestDist = skillDef.radius;
      for (let i = 0; i < state.enemies.length; i++) {
        const e = state.enemies[i]!;
        if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
        const d = Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y);
        if (d < bestDist) {
          bestDist = d;
          target = e;
        }
      }

      const fromX = player.pos.x;
      const fromY = player.pos.y;
      const halfW = player.width * 0.5;
      const arena = state.bossArenaState;
      const minBoundX =
        arena.active && arena.lockedRightX > arena.lockedLeftX
          ? arena.lockedLeftX + halfW
          : TILE_SIZE + halfW;
      const maxBoundX =
        arena.active && arena.lockedRightX > arena.lockedLeftX
          ? arena.lockedRightX - halfW
          : (state.tileGrid.width - 1) * TILE_SIZE - halfW;

      // Empower the NEXT MELEE STRIKE of ANY weapon!
      player.phaserBonusDamage = Math.max(10, Math.round(scaledDmg * 1.85));
      player.phaserBuffTicks = 180;
      player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 90);

      if (target) {
        const behindX = Math.max(
          minBoundX,
          Math.min(maxBoundX, target.pos.x - target.facing * (target.width * 0.5 + 16))
        );
        const frontX = Math.max(
          minBoundX,
          Math.min(maxBoundX, target.pos.x + target.facing * 16)
        );
        const destTy = Math.floor(target.pos.y / TILE_SIZE);
        const behindSolid = col.isSolidAt(state.tileGrid, Math.floor(behindX / TILE_SIZE), destTy);
        const frontSolid = col.isSolidAt(state.tileGrid, Math.floor(frontX / TILE_SIZE), destTy);
        const finalX = !behindSolid ? behindX : !frontSolid ? frontX : target.pos.x;

        player.pos.x = finalX;
        player.pos.y = target.pos.y;
        player.prevPos.x = finalX;
        player.prevPos.y = target.pos.y;
        player.facing = target.pos.x >= player.pos.x ? 1 : -1;
        player.iframeTicks = Math.max(player.iframeTicks, 15);
        applyEnemyStatus(state, target, 'root', 90, 0, rng, col);
        damageEnemy(
          state,
          target,
          scaledDmg,
          false,
          30,
          player.facing * 35,
          -10,
          rng,
          'skill',
          gear.affixes,
          col
        );
        state.events.push({
          type: 'teleport',
          fromX,
          fromY,
          toX: player.pos.x,
          toY: player.pos.y,
        });
        spawnParticle(state, player.pos.x, player.pos.y - 4, 0, 0, 42, '#52f5ff', 14, 'ring', true, 0);
        for (let s = 0; s < 10; s++) {
          const ang = (s / 10) * Math.PI * 2;
          const originX = s < 4 ? fromX : player.pos.x;
          const originY = s < 4 ? fromY : player.pos.y;
          spawnParticle(
            state,
            originX,
            originY - 4,
            Math.cos(ang) * rng.rangeFloat(65, 145),
            Math.sin(ang) * rng.rangeFloat(65, 145),
            3.5,
            s % 2 === 0 ? '#52f5ff' : '#c4fcff',
            16,
            'spark',
            true,
            0
          );
        }
        spawnTransientLight(
          state,
          player.pos.x,
          player.pos.y - 6,
          115,
          [0.28, 0.95, 1.0],
          1.8,
          16,
          'portal'
        );
      } else {
        // No enemy in radius -> crisp 110px forward Phantom Blink + 50% cooldown refund!
        const topTy = Math.floor((fromY - player.height * 0.4) / TILE_SIZE);
        const midTy = Math.floor(fromY / TILE_SIZE);
        const botTy = Math.floor((fromY + player.height * 0.4) / TILE_SIZE);
        let destX = fromX;

        const stepDistances = [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 110];
        for (let k = 0; k < stepDistances.length; k++) {
          const testX = fromX + player.facing * stepDistances[k]!;
          if (testX < minBoundX || testX > maxBoundX) break;
          const leadTx = Math.floor((testX + player.facing * halfW) / TILE_SIZE);
          const centerTx = Math.floor(testX / TILE_SIZE);
          if (
            col.isSolidAt(state.tileGrid, leadTx, topTy) ||
            col.isSolidAt(state.tileGrid, leadTx, midTy) ||
            col.isSolidAt(state.tileGrid, leadTx, botTy) ||
            col.isSolidAt(state.tileGrid, centerTx, midTy)
          ) {
            break;
          }
          destX = testX;
        }

        player.pos.x = destX;
        player.prevPos.x = destX;
        player.iframeTicks = Math.max(player.iframeTicks, 12);
        gear.cooldownTicks = Math.round(skillDef.cooldownTicks * 0.5);

        state.events.push({
          type: 'teleport',
          fromX,
          fromY,
          toX: player.pos.x,
          toY: player.pos.y,
        });
        spawnParticle(state, player.pos.x, player.pos.y - 4, 0, 0, 38, '#52f5ff', 14, 'ring', true, 0);
        for (let s = 0; s < 10; s++) {
          const frac = s / 9;
          const sx = fromX + (destX - fromX) * frac;
          spawnParticle(
            state,
            sx + rng.rangeFloat(-4, 4),
            fromY + rng.rangeFloat(-12, 8),
            player.facing * rng.rangeFloat(25, 95),
            rng.rangeFloat(-55, 35),
            3.5,
            s % 2 === 0 ? '#52f5ff' : '#c8fdff',
            16,
            'spark',
            true,
            0
          );
        }
        spawnParticle(
          state,
          player.pos.x,
          player.pos.y - 24,
          0,
          -34,
          10,
          '#6ef5ff',
          32,
          'text',
          true,
          0,
          'BLINK'
        );
        spawnTransientLight(
          state,
          player.pos.x,
          player.pos.y - 6,
          110,
          [0.28, 0.95, 1.0],
          1.75,
          16,
          'portal'
        );
      }
      break;
    }

    case 'WolfTrap': {
      // Replace prior player wolf traps before tossing twin fresh traps
      for (let i = state.turrets.length - 1; i >= 0; i--) {
        if (state.turrets[i]!.owner === 'player' && state.turrets[i]!.kind === 'wolfTrap') {
          state.turrets.splice(i, 1);
        }
      }
      const playerTy = Math.floor(player.pos.y / TILE_SIZE);
      for (let idx = 0; idx < 2; idx++) {
        const targetDist = 24 + idx * 28;
        let trapX = player.pos.x;
        for (let d = 8; d <= targetDist; d += 8) {
          const testX = player.pos.x + player.facing * d;
          if (col.isSolidAt(state.tileGrid, Math.floor(testX / TILE_SIZE), playerTy)) {
            break;
          }
          trapX = testX;
        }
        const floorY = findFloorY(state, trapX, player.pos.y, col);
        const trapY = floorY - 6;

        state.turrets.push({
          uid: state.nextUid++,
          defId: 'WolfTrap',
          pos: { x: trapX, y: trapY },
          hp: 60,
          maxHp: 60,
          damage: scaledDmg,
          range: skillDef.radius,
          fireCooldownTicks: 0,
          ttlTicks: skillDef.durationTicks,
          facing: player.facing,
          kind: 'wolfTrap',
          owner: 'player',
          rootedEnemyUid: null,
        });
        for (let s = 0; s < 3; s++) {
          spawnParticle(
            state,
            trapX,
            trapY,
            rng.rangeFloat(-55, 55),
            rng.rangeFloat(-70, -15),
            2.8,
            '#e8d290',
            14,
            'spark',
            true,
            260
          );
        }
      }
      break;
    }

    case 'WaveOfDenial': {
      spawnParticle(state, player.pos.x, player.pos.y, 0, 0, skillDef.radius * 0.65, '#d4fbff', 12, 'ring', true, 0);
      spawnParticle(state, player.pos.x, player.pos.y, 0, 0, skillDef.radius, '#7cf0ff', 18, 'ring', true, 0);
      for (let s = 0; s < 14; s++) {
        const ang = (s / 14) * Math.PI * 2;
        const spd = rng.rangeFloat(140, 240);
        spawnParticle(
          state,
          player.pos.x,
          player.pos.y - 2,
          Math.cos(ang) * spd,
          Math.sin(ang) * spd,
          3.5,
          s % 2 === 0 ? '#7cf0ff' : '#d8fcff',
          16,
          'spark',
          true,
          0
        );
      }
      spawnTransientLight(
        state,
        player.pos.x,
        player.pos.y - 4,
        skillDef.radius * 1.9,
        [0.42, 0.94, 1.0],
        1.9,
        14,
        'slash'
      );
      state.screenShake = Math.max(state.screenShake, 5);

      // Smash all unbroken wooden doors within radius (stunning nearby enemies behind doors!)
      for (let i = 0; i < state.doors.length; i++) {
        const door = state.doors[i]!;
        if (door.kind !== 'wood' || door.broken) continue;
        if (Math.hypot(door.pos.x - player.pos.x, door.pos.y - player.pos.y) <= skillDef.radius) {
          door.broken = true;
          door.opened = true;
          state.events.push({ type: 'doorSmash', x: door.pos.x, y: door.pos.y });
          for (let j = 0; j < state.enemies.length; j++) {
            const e = state.enemies[j]!;
            if (e.state === 'dead' || e.hp <= 0 || e.isBoss) continue;
            if (Math.hypot(e.pos.x - door.pos.x, e.pos.y - door.pos.y) <= 84) {
              applyEnemyStatus(state, e, 'stun', 90, 0, rng, col);
            }
          }
        }
      }

      // Reflect all enemy projectiles & ground bombs within radius
      for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i]!;
        if (p.owner !== 'enemy') continue;
        if (Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) <= skillDef.radius) {
          p.owner = 'player';
          p.ownerUid = 0;
          const pushDir = p.pos.x >= player.pos.x ? 1 : -1;
          p.vel.x = Math.abs(p.vel.x) < 40 ? pushDir * 300 : -p.vel.x * 1.4;
          p.vel.y = -Math.abs(p.vel.y) * 0.6 - 60;
          p.rollsOnFloor = false;
          p.floorFuseTicks = undefined;
          p.damage = Math.max(scaledDmg, Math.round(p.damage * 2.0));
          p.isCrit = true;
          p.color = '#7cf0ff';
          p.ttlTicks = Math.max(p.ttlTicks, 90);
          p.hitIds = [];
          spawnParticle(
            state,
            p.pos.x,
            p.pos.y - 14,
            0,
            -32,
            10,
            '#7cf0ff',
            30,
            'text',
            true,
            0,
            'REFLECT!'
          );
        }
      }

      // Hurl enemies violently away (triggering wall slams!)
      for (let i = 0; i < state.enemies.length; i++) {
        const e = state.enemies[i]!;
        if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
        const dx = e.pos.x - player.pos.x;
        const dy = e.pos.y - player.pos.y;
        if (Math.hypot(dx, dy) <= skillDef.radius) {
          const dir = dx >= 0 ? 1 : -1;
          damageEnemy(state, e, scaledDmg, false, 60, dir * 240, -110, rng, 'skill', gear.affixes, col);
        }
      }
      break;
    }

    case 'CorruptedPower': {
      applyStatus(player.statusEffects, 'corrupted', skillDef.durationTicks, 0, 0);
      spawnParticle(state, player.pos.x, player.pos.y, 0, 0, skillDef.radius, '#c852ff', 22, 'ring', true, 0);
      for (let s = 0; s < 12; s++) {
        const ang = (s / 12) * Math.PI * 2;
        const spd = rng.rangeFloat(90, 185);
        spawnParticle(
          state,
          player.pos.x,
          player.pos.y - 4,
          Math.cos(ang) * spd,
          Math.sin(ang) * spd - 20,
          3.8,
          s % 2 === 0 ? '#d966ff' : '#ff4da6',
          20,
          'spark',
          true,
          40
        );
      }
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y - 26,
        0,
        -30,
        10,
        '#e070ff',
        44,
        'text',
        true,
        0,
        'CORRUPTED +50%'
      );
      spawnTransientLight(
        state,
        player.pos.x,
        player.pos.y - 6,
        skillDef.radius * 2.0,
        [0.78, 0.28, 1.0],
        1.9,
        20,
        'status'
      );
      for (let i = 0; i < state.enemies.length; i++) {
        const e = state.enemies[i]!;
        if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
        if (Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= skillDef.radius) {
          applyEnemyStatus(state, e, 'electrify', 150, getStatusDps(state, 'electrify'), rng, col);
          damageEnemy(
            state,
            e,
            scaledDmg,
            false,
            25,
            (e.pos.x >= player.pos.x ? 1 : -1) * 70,
            -30,
            rng,
            'skill',
            gear.affixes,
            col
          );
        }
      }
      break;
    }

    case 'KnifeDance': {
      const count = 10;
      spawnParticle(state, player.pos.x, player.pos.y - 4, 0, 0, 56, '#ff3b5c', 14, 'ring', true, 0);
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'player',
          ownerUid: 0,
          kind: 'knife',
          pos: { x: player.pos.x, y: player.pos.y - 4 },
          prevPos: { x: player.pos.x, y: player.pos.y - 4 },
          vel: { x: Math.cos(angle) * 380, y: Math.sin(angle) * 380 },
          radius: 4,
          damage: scaledDmg,
          isCrit: false,
          pierceLeft: 1,
          gravity: 0,
          ttlTicks: 28,
          maxTtlTicks: 28,
          color: '#ff4763',
          applyStatus: 'bleed',
          parriable: false,
          hitIds: [],
          affixes: gear.affixes,
        });
        spawnParticle(
          state,
          player.pos.x,
          player.pos.y - 4,
          Math.cos(angle) * 145,
          Math.sin(angle) * 145,
          3.2,
          '#ff4763',
          14,
          'spark',
          true,
          0
        );
      }
      spawnTransientLight(
        state,
        player.pos.x,
        player.pos.y - 4,
        115,
        [1.0, 0.24, 0.36],
        1.75,
        14,
        'slash'
      );
      break;
    }

    case 'Tonic': {
      // Authentic Dead Cells Tonic: Temporary Overheal Barrier (+35% max HP for 8s) + 35% DR + Speed + Status Purge!
      const survBonus = 1 + Math.max(0, player.scrolls.survival - 1) * 0.04;
      const barrierAmt = Math.max(15, Math.round(player.maxHp * 0.35 * survBonus));
      player.tempShieldHp = barrierAmt;
      player.tempShieldTicks = 480;
      clearNegativeStatuses(player.statusEffects);
      player.speedBuffTicks = Math.max(player.speedBuffTicks, 300);

      spawnParticle(state, player.pos.x, player.pos.y - 4, 0, 0, 58, '#4dff9b', 20, 'ring', true, 0);
      for (let i = 0; i < 10; i++) {
        spawnParticle(
          state,
          player.pos.x + rng.rangeFloat(-12, 12),
          player.pos.y + rng.rangeFloat(-8, 12),
          rng.rangeFloat(-28, 28),
          rng.rangeFloat(-92, -38),
          3.5,
          i % 2 === 0 ? '#4dff9b' : '#9effcc',
          30 + (i % 4) * 3,
          'spark',
          true,
          -30
        );
      }
      spawnTransientLight(
        state,
        player.pos.x,
        player.pos.y - 6,
        120,
        [0.24, 1.0, 0.56],
        1.8,
        22,
        'status'
      );
      spawnParticle(
        state,
        player.pos.x,
        player.pos.y - 22,
        0,
        -30,
        10,
        '#66f5c8',
        40,
        'text',
        true,
        0,
        `SHIELD +${barrierAmt}`
      );
      break;
    }
  }

  return true;
}

function spawnBurningOilZone(
  state: SimState,
  x: number,
  y: number,
  width: number,
  damage: number,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const oilFloorY = findFloorY(state, x, y - 4, col);
  const oilY = Math.abs(oilFloorY - y) <= 42 ? oilFloorY - 12 : y - 10;
  state.hazards.push({
    uid: state.nextUid++,
    rect: {
      x: x - width * 0.5,
      y: oilY,
      w: width,
      h: 18,
    },
    kind: 'burningOil',
    damage: Math.max(8, Math.round(damage)),
    ttlTicks: 240,
    owner: 'player',
  });
  for (let f = 0; f < 6; f++) {
    spawnParticle(
      state,
      x + rng.rangeFloat(-width * 0.45, width * 0.45),
      oilY + 8,
      rng.rangeFloat(-18, 18),
      rng.rangeFloat(-75, -30),
      4.5,
      f % 2 === 0 ? '#ff6b2b' : '#ffd152',
      24,
      'flame',
      true,
      -40
    );
  }
}

function detonateProjectile(
  state: SimState,
  proj: ProjectileState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const radius = proj.explosionRadius ?? 56;
  const element: 'fire' | 'ice' | 'physical' | 'cluster' =
    proj.applyStatus === 'burn'
      ? 'fire'
      : proj.applyStatus === 'freeze'
        ? 'ice'
        : proj.kind === 'cluster'
          ? 'cluster'
          : 'physical';

  state.events.push({
    type: 'explosion',
    x: proj.pos.x,
    y: proj.pos.y,
    radius,
    color: proj.color,
    element,
  });

  spawnParticle(state, proj.pos.x, proj.pos.y, 0, 0, radius, proj.color, 18, 'ring', true, 0);
  if (element === 'ice') {
    spawnParticle(state, proj.pos.x, proj.pos.y, 0, 0, radius * 0.65, '#c8f8ff', 14, 'ring', true, 0);
  }
  const burstKind: SimState['particlesSim'][number]['kind'] =
    element === 'fire' ? 'flame' : element === 'ice' ? 'ice' : 'spark';
  for (let s = 0; s < 14; s++) {
    const ang = (s / 14) * Math.PI * 2 + rng.rangeFloat(-0.18, 0.18);
    const spd = rng.rangeFloat(85, 220);
    const pColor =
      element === 'fire'
        ? s % 2 === 0
          ? '#ff6b2b'
          : '#ffcf52'
        : element === 'ice'
          ? s % 2 === 0
            ? '#6ee8ff'
            : '#d6fbff'
          : s % 2 === 0
            ? proj.color
            : '#fff099';
    spawnParticle(
      state,
      proj.pos.x,
      proj.pos.y,
      Math.cos(ang) * spd,
      Math.sin(ang) * spd - (element === 'fire' ? 35 : 15),
      rng.rangeFloat(3.2, 5.5),
      pColor,
      18 + (s % 4) * 3,
      burstKind,
      true,
      element === 'fire' ? 90 : element === 'ice' ? 140 : 220
    );
  }

  const lightColor: [number, number, number] =
    element === 'fire'
      ? [1.0, 0.46, 0.14]
      : element === 'ice'
        ? [0.38, 0.94, 1.0]
        : [1.0, 0.82, 0.3];
  spawnTransientLight(
    state,
    proj.pos.x,
    proj.pos.y,
    radius * 2.2,
    lightColor,
    2.0,
    16,
    'slash'
  );
  state.screenShake = Math.max(state.screenShake, element === 'cluster' ? 6 : 4.5);

  // Cluster grenade splits into bouncing sub-bomblets (5 player, 3 enemy Bombardier!)
  if (proj.kind === 'cluster') {
    const subCount = proj.owner === 'player' ? 5 : 3;
    const subTx = Math.floor(proj.pos.x / TILE_SIZE);
    const aboveTy = Math.floor((proj.pos.y - 4) / TILE_SIZE);
    const subY = col.isSolidAt(state.tileGrid, subTx, aboveTy) ? proj.pos.y + 4 : proj.pos.y - 4;
    for (let i = 0; i < subCount; i++) {
      const frac = subCount > 1 ? i / (subCount - 1) - 0.5 : 0;
      state.projectiles.push({
        uid: state.nextUid++,
        owner: proj.owner,
        ownerUid: proj.ownerUid,
        kind: 'grenade',
        pos: { x: proj.pos.x, y: subY },
        prevPos: { x: proj.pos.x, y: subY },
        vel: { x: frac * 240 + rng.rangeFloat(-20, 20), y: rng.rangeFloat(-210, -140) },
        radius: 4,
        damage: Math.max(10, Math.round(proj.damage * 0.55)),
        isCrit: false,
        pierceLeft: 0,
        gravity: 640,
        ttlTicks: proj.owner === 'player' ? 75 : 110,
        maxTtlTicks: proj.owner === 'player' ? 75 : 110,
        color: proj.color,
        applyStatus: proj.applyStatus,
        explosionRadius: 42,
        parriable: proj.owner === 'enemy',
        bouncesLeft: proj.owner === 'player' ? 2 : 1,
        floorFuseTicks: proj.owner === 'player' ? 18 : 40,
        hitIds: [],
        affixes: proj.affixes,
      });
    }
  }

  // Player heavy grenades also smash nearby wooden doors!
  if (proj.owner === 'player' && (proj.kind === 'grenade' || proj.kind === 'cluster')) {
    for (let d = 0; d < state.doors.length; d++) {
      const door = state.doors[d]!;
      if (door.kind !== 'wood' || door.broken) continue;
      if (Math.hypot(door.pos.x - proj.pos.x, door.pos.y - proj.pos.y) <= radius) {
        door.broken = true;
        door.opened = true;
        state.events.push({ type: 'doorSmash', x: door.pos.x, y: door.pos.y });
      }
    }
  }

  // Fire grenade leaves blazing floor fire zone (igniting any existing oil into burningOil!)
  if (proj.owner === 'player' && proj.applyStatus === 'burn' && proj.kind !== 'fireball') {
    spawnBurningOilZone(state, proj.pos.x, proj.pos.y, radius * 1.4, proj.damage * 0.25, rng, col);
  }

  if (proj.owner === 'player') {
    const spreadsOil = Boolean(
      proj.affixes && (proj.affixes.includes('spread_oil') || proj.affixes.includes('apply_oil'))
    );
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i]!;
      if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
      if (proj.kind === 'fireball' && proj.hitIds.includes(e.uid)) continue;
      if (Math.hypot(e.pos.x - proj.pos.x, e.pos.y - proj.pos.y) <= radius) {
        if (proj.applyStatus) {
          const dur = proj.applyStatus === 'freeze' ? 90 : 210;
          const dps =
            proj.applyStatus === 'burn' || proj.applyStatus === 'bleed' || proj.applyStatus === 'poison'
              ? getStatusDps(state, proj.applyStatus)
              : 0;
          applyEnemyStatus(state, e, proj.applyStatus, dur, dps, rng, col);
          if (spreadsOil) {
            applyStatus(e.statusEffects, 'oil', 240, 0, 0);
          }
        }
        const dir = e.pos.x >= proj.pos.x ? 1 : -1;
        damageEnemy(state, e, proj.damage, proj.isCrit, 45, dir * 130, -85, rng, 'skill', proj.affixes, col);
      }
    }
  } else {
    damagePlayerTurretsInArea(state, proj.pos.x, proj.pos.y, radius * 2, radius * 2, proj.damage);
    const p = state.player;
    if (Math.hypot(p.pos.x - proj.pos.x, p.pos.y - proj.pos.y) <= radius) {
      if (!attemptShieldParry(state, proj.damage, null, proj, rng)) {
        damagePlayer(state, proj.damage, 'Explosion', rng, false, {
          attackerX: proj.pos.x,
          unrollable: proj.unrollable,
        });
      }
    }
  }
}

function refundMissedProjectileAmmo(state: SimState, proj: ProjectileState): void {
  if (
    proj.owner === 'player' &&
    proj.sourceWeaponSlot !== undefined &&
    proj.hitIds.length === 0
  ) {
    const gear = getWeaponGear(state, proj.sourceWeaponSlot);
    if (gear && gear.maxAmmo !== undefined && gear.ammo !== undefined) {
      gear.ammo = Math.min(gear.maxAmmo, gear.ammo + 1);
    }
  }
}

export function stepProjectilesAndTurrets(
  state: SimState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;

  // 1. Step Projectiles
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const proj = state.projectiles[i]!;
    proj.prevPos.x = proj.pos.x;
    proj.prevPos.y = proj.pos.y;
    proj.ttlTicks -= 1;

    if (proj.gravity !== 0) {
      proj.vel.y += proj.gravity * FIXED_DT;
    }

    const nextX = proj.pos.x + proj.vel.x * FIXED_DT;
    const nextY = proj.pos.y + proj.vel.y * FIXED_DT;
    const ignoresWalls =
      Boolean(proj.piercesWalls) ||
      proj.kind === 'laserBeam' ||
      proj.kind === 'fallingSword';

    // Handle rolling cannonballs (Pirate Captain) & bouncing/floor-fuse bombs!
    if (proj.rollsOnFloor) {
      const wallTx = Math.floor((nextX + Math.sign(proj.vel.x || 1) * proj.radius) / TILE_SIZE);
      const midTy = Math.floor(proj.pos.y / TILE_SIZE);
      if (col.isSolidAt(state.tileGrid, wallTx, midTy)) {
        detonateProjectile(state, proj, rng, col);
        state.projectiles.splice(i, 1);
        continue;
      }
      proj.pos.x = nextX;
      const footTy = Math.floor((nextY + proj.radius) / TILE_SIZE);
      const curTx = Math.floor(proj.pos.x / TILE_SIZE);
      const hitFloor =
        proj.vel.y >= 0 &&
        (col.isSolidAt(state.tileGrid, curTx, footTy) ||
          col.isOneWayAt(state.tileGrid, curTx, footTy));
      if (hitFloor) {
        proj.pos.y = footTy * TILE_SIZE - proj.radius;
        proj.vel.y = 0;
        const rollDir = Math.sign(proj.vel.x || 1);
        proj.vel.x = rollDir * 220;
      } else {
        proj.pos.y = nextY;
      }
    } else if (
      (proj.kind === 'grenade' || proj.kind === 'cluster') &&
      ((proj.bouncesLeft ?? 0) > 0 || proj.floorFuseTicks !== undefined)
    ) {
      // Axis-separated bounce & floor-rest fuse behavior!
      const txNextX = Math.floor((nextX + Math.sign(proj.vel.x || 1) * proj.radius) / TILE_SIZE);
      const tyCur = Math.floor(proj.pos.y / TILE_SIZE);
      if (col.isSolidAt(state.tileGrid, txNextX, tyCur)) {
        proj.vel.x = -proj.vel.x * 0.5;
      } else {
        proj.pos.x = nextX;
      }

      const txCur = Math.floor(proj.pos.x / TILE_SIZE);
      const tyNextY = Math.floor(
        (nextY + (proj.vel.y >= 0 ? proj.radius : -proj.radius)) / TILE_SIZE
      );
      const hitFloor =
        proj.vel.y >= 0 &&
        (col.isSolidAt(state.tileGrid, txCur, tyNextY) ||
          (col.isOneWayAt(state.tileGrid, txCur, tyNextY) &&
            proj.pos.y + proj.radius <= tyNextY * TILE_SIZE + 4));
      const hitCeil = proj.vel.y < 0 && col.isSolidAt(state.tileGrid, txCur, tyNextY);

      if (hitFloor) {
        proj.pos.y = tyNextY * TILE_SIZE - proj.radius;
        if ((proj.bouncesLeft ?? 0) > 0) {
          proj.bouncesLeft! -= 1;
          proj.vel.y = -Math.abs(proj.vel.y) * 0.52;
          proj.vel.x *= 0.72;
          spawnParticle(state, proj.pos.x, proj.pos.y + 3, 0, -30, 2.5, proj.color, 8, 'spark', true, 160);
        } else if (proj.floorFuseTicks !== undefined) {
          proj.vel.y = 0;
          proj.vel.x *= 0.76;
          if (Math.abs(proj.vel.x) < 6) proj.vel.x = 0;
          proj.floorFuseTicks -= 1;
          // Pulsing visual fuse spark while resting parriable on floor
          if (proj.floorFuseTicks % 6 === 0) {
            spawnParticle(
              state,
              proj.pos.x,
              proj.pos.y - 3,
              rng.rangeFloat(-20, 20),
              rng.rangeFloat(-45, -15),
              3.2,
              proj.floorFuseTicks < 16 ? '#ff3b3b' : '#ffe066',
              10,
              'spark',
              true,
              120
            );
          }
          if (proj.floorFuseTicks <= 0) {
            detonateProjectile(state, proj, rng, col);
            state.projectiles.splice(i, 1);
            continue;
          }
        } else {
          detonateProjectile(state, proj, rng, col);
          state.projectiles.splice(i, 1);
          continue;
        }
      } else if (hitCeil) {
        proj.vel.y = Math.abs(proj.vel.y) * 0.35;
      } else {
        proj.pos.y = nextY;
      }
    } else {
      const tx = Math.floor(nextX / TILE_SIZE);
      const ty = Math.floor(nextY / TILE_SIZE);
      const hitWall = !ignoresWalls && col.isSolidAt(state.tileGrid, tx, ty);

      if (hitWall) {
        if (proj.kind === 'grenade' || proj.kind === 'cluster') {
          detonateProjectile(state, proj, rng, col);
          state.projectiles.splice(i, 1);
          continue;
        } else if (proj.kind === 'shockwave') {
          const wallAheadTx = Math.floor((proj.pos.x + Math.sign(proj.vel.x || 1) * 10) / TILE_SIZE);
          const wallAheadTy = Math.floor((proj.pos.y - 6) / TILE_SIZE);
          if (col.isSolidAt(state.tileGrid, wallAheadTx, wallAheadTy)) {
            state.projectiles.splice(i, 1);
            continue;
          }
          proj.pos.x = nextX;
        } else {
          if (proj.explosionRadius) {
            detonateProjectile(state, proj, rng, col);
          }
          refundMissedProjectileAmmo(state, proj);
          state.projectiles.splice(i, 1);
          continue;
        }
      } else {
        proj.pos.x = nextX;
        proj.pos.y = nextY;
      }
    }

    // Closed wooden doors block standard enemy projectiles (except piercesWalls Inquisitor bolts!)
    if (proj.owner === 'enemy' && !ignoresWalls && proj.kind !== 'shockwave') {
      let hitClosedDoor = false;
      for (let d = 0; d < state.doors.length; d++) {
        const door = state.doors[d]!;
        if (door.kind !== 'wood' || door.broken || door.opened) continue;
        if (
          aabbOverlap(
            proj.pos.x,
            proj.pos.y,
            proj.radius * 2,
            proj.radius * 2,
            door.pos.x,
            door.pos.y,
            door.width,
            door.height
          )
        ) {
          hitClosedDoor = true;
          if (proj.kind === 'grenade' || proj.kind === 'cluster') {
            detonateProjectile(state, proj, rng, col);
          }
          break;
        }
      }
      if (hitClosedDoor) {
        state.projectiles.splice(i, 1);
        continue;
      }
    }

    // Trailing glowing embers while grenades are in flight!
    if ((proj.kind === 'grenade' || proj.kind === 'cluster') && state.tick % 2 === 0) {
      const trailKind: SimState['particlesSim'][number]['kind'] =
        proj.applyStatus === 'burn' ? 'flame' : proj.applyStatus === 'freeze' ? 'ice' : 'ember';
      spawnParticle(
        state,
        proj.pos.x + rng.rangeFloat(-2, 2),
        proj.pos.y + rng.rangeFloat(-2, 2),
        -proj.vel.x * 0.1 + rng.rangeFloat(-16, 16),
        -proj.vel.y * 0.1 + rng.rangeFloat(-24, 6),
        3.2,
        proj.color,
        12,
        trailKind,
        true,
        proj.applyStatus === 'burn' ? -25 : 40
      );
    }

    // Check entity collisions
    let consumed = false;
    if (proj.owner === 'player') {
      // Check enemy turrets (boss banners)
      for (let t = state.turrets.length - 1; t >= 0; t--) {
        const tur = state.turrets[t]!;
        if (tur.owner !== 'enemy') continue;
        if (Math.hypot(proj.pos.x - tur.pos.x, proj.pos.y - tur.pos.y) <= proj.radius + 14) {
          tur.hp -= proj.damage;
          if (tur.hp <= 0) state.turrets.splice(t, 1);
          if (proj.pierceLeft > 0) {
            proj.pierceLeft -= 1;
          } else {
            consumed = true;
            break;
          }
        }
      }

      // Check enemies
      if (!consumed) {
        for (let j = 0; j < state.enemies.length; j++) {
          const enemy = state.enemies[j]!;
          if (enemy.state === 'dead' || enemy.hp <= 0 || enemy.buried) continue;
          if (proj.hitIds.includes(enemy.uid)) continue;

          if (
            aabbOverlap(
              proj.pos.x,
              proj.pos.y,
              proj.radius * 2,
              proj.radius * 2,
              enemy.pos.x,
              enemy.pos.y,
              enemy.width,
              enemy.height
            )
          ) {
            proj.hitIds.push(enemy.uid);
            if (proj.kind === 'grenade' || proj.kind === 'cluster') {
              detonateProjectile(state, proj, rng, col);
              consumed = true;
              break;
            }

            const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
            // Match the player's ranged weapon for this projectile (skip turret projectiles)
            let projWeaponDef: WeaponDef | null = null;
            if (proj.ownerUid === 0) {
              const slotPref = proj.sourceWeaponSlot ?? player.activeWeaponSlot;
              const altSlot: 1 | 2 = slotPref === 1 ? 2 : 1;
              const candidates = [getWeaponGear(state, slotPref), getWeaponGear(state, altSlot)];
              for (let c = 0; c < candidates.length; c++) {
                const g = candidates[c];
                if (!g) continue;
                const d = WEAPON_MAP[g.defId];
                if (d && d.kind === 'ranged' && d.strikeChain[0]?.projectileKind === proj.kind) {
                  projWeaponDef = d;
                  break;
                }
              }
            }

            // Lodge stuck arrow/knife inside hit enemy (once per shot, returned on death/parry/timeout!)
            let lodgedHere = false;
            if (
              proj.sourceWeaponSlot !== undefined &&
              proj.hitIds.length === 1 &&
              (proj.kind === 'arrow' || proj.kind === 'iceArrow' || proj.kind === 'knife')
            ) {
              enemy.stuckArrows ??= [];
              const stickTtl = proj.kind === 'knife' ? 180 : 300;
              enemy.stuckArrows.push({ slot: proj.sourceWeaponSlot, ttlTicks: stickTtl });
              lodgedHere = true;
            }

            const wasOiled = hasStatus(enemy.statusEffects, 'oil');
            let isCrit = proj.isCrit;
            if (!isCrit && projWeaponDef) {
              isCrit = evaluateCritCondition(state, projWeaponDef, 0, enemy, col);
            }
            const critMul = isCrit && !proj.isCrit ? projWeaponDef?.strikeChain[0]?.critMul ?? 2.0 : 1.0;
            const mutMult = getMutationDamageMultiplier(state, false, dist);
            const hitDmg = Math.round(proj.damage * mutMult * critMul);

            const hitWeaponId = projWeaponDef?.id ?? (proj.ownerUid === 0 ? 'ranged' : 'skill');
            const damaged = damageEnemy(
              state,
              enemy,
              hitDmg,
              isCrit,
              proj.kind === 'fireball' ? 28 : 16,
              Math.sign(proj.vel.x || 1) * 70,
              -20,
              rng,
              hitWeaponId,
              proj.affixes,
              col
            );

            if (!damaged && lodgedHere && enemy.stuckArrows && enemy.stuckArrows.length > 0) {
              const popped = enemy.stuckArrows.pop();
              if (popped) {
                const g = getWeaponGear(state, popped.slot);
                if (g && g.maxAmmo !== undefined && g.ammo !== undefined) {
                  g.ammo = Math.min(g.maxAmmo, g.ammo + 1);
                }
              }
            }

            if (damaged && enemy.hp > 0) {
              applyWeaponAndAffixStatuses(
                state,
                enemy,
                proj.applyStatus,
                proj.affixes,
                false,
                hitWeaponId,
                0,
                rng,
                col
              );
            }

            // Pyrotechnics hitting an oiled target ignites a burningOil floor pool beneath them!
            if (proj.kind === 'fireball' && wasOiled) {
              spawnBurningOilZone(state, enemy.pos.x, enemy.pos.y, 58, proj.damage * 0.35, rng, col);
            }

            if (proj.explosionRadius) {
              detonateProjectile(state, proj, rng, col);
            }

            if (proj.pierceLeft > 0) {
              proj.pierceLeft -= 1;
            } else {
              consumed = true;
              break;
            }
          }
        }
      }
    } else {
      // Enemy projectile hitting player
      const hitPlayer = aabbOverlap(
        proj.pos.x,
        proj.pos.y,
        proj.radius * 2 + 2,
        proj.radius * 2 + 2,
        player.pos.x,
        player.pos.y,
        player.width,
        player.height
      );

      if (hitPlayer) {
        if (proj.parriable && attemptShieldParry(state, proj.damage, null, proj, rng)) {
          // Reflected! Do not delete!
          continue;
        }

        if (proj.kind === 'hook') {
          // TimeKeeper Grappling Hook: reel player directly in + 24t root + immediate 12t telegraphed swordCombo slash!
          const owner = state.enemies.find((e) => e.uid === proj.ownerUid);
          if (owner && owner.state !== 'dead' && owner.hp > 0) {
            const arena = state.bossArenaState;
            const minX =
              arena.active && arena.lockedRightX > arena.lockedLeftX
                ? arena.lockedLeftX + player.width * 0.5
                : TILE_SIZE + player.width * 0.5;
            const maxX =
              arena.active && arena.lockedRightX > arena.lockedLeftX
                ? arena.lockedRightX - player.width * 0.5
                : (state.tileGrid.width - 1) * TILE_SIZE - player.width * 0.5;
            const reelX = Math.max(minX, Math.min(maxX, owner.pos.x + owner.facing * 26));
            player.pos.x = reelX;
            player.prevPos.x = reelX;
            player.vel.x = 0;
            player.vel.y = -40;
            applyStatus(player.statusEffects, 'root', 24, 0, owner.uid);
            // Force Time Keeper immediately into 12t telegraphed follow-up slash!
            owner.facing = player.pos.x >= owner.pos.x ? 1 : -1;
            owner.state = 'windup';
            owner.bossAttackId = 'swordCombo';
            owner.stateTicks = 12;
            owner.telegraphTicks = 12;
            owner.hitPlayerThisSwing = false;
            state.events.push({
              type: 'enemyTelegraph',
              x: owner.pos.x,
              y: owner.pos.y - owner.height * 0.55 - 10,
              enemyUid: owner.uid,
              unparriable: false,
            });
          }
          damagePlayer(state, proj.damage, 'Grappling Hook', rng, false, {
            attackerX: proj.pos.x,
          });
          consumed = true;
        } else if (proj.kind === 'grenade' || proj.kind === 'cluster') {
          // Fuse bombs (Worm death-eggs, Grenadier, Cannibal, HoTK flurry) wait for their floor fuse and remain parriable!
          // Pirate Captain's rolling cannonball & non-fuse impact grenades detonate on contact.
          if (proj.rollsOnFloor || proj.floorFuseTicks === undefined) {
            detonateProjectile(state, proj, rng, col);
            consumed = true;
          }
        } else {
          const isUnparriableShockwave = proj.kind === 'shockwave';
          if (
            damagePlayer(
              state,
              proj.damage,
              proj.kind === 'acidSpit'
                ? 'Acid Spit'
                : isUnparriableShockwave
                  ? 'Shockwave'
                  : 'Projectile',
              rng,
              false,
              {
                attackerX: proj.pos.x,
                unblockable: isUnparriableShockwave,
                unrollable: proj.unrollable,
              }
            )
          ) {
            if (proj.applyStatus) {
              applyStatus(player.statusEffects, proj.applyStatus, 180, 12, proj.ownerUid);
            }
          }
          consumed = true;
        }
      }
    }

    if (consumed) {
      state.projectiles.splice(i, 1);
      continue;
    }

    if (proj.ttlTicks <= 0) {
      if (proj.kind === 'grenade' || proj.kind === 'cluster') {
        detonateProjectile(state, proj, rng, col);
      } else {
        refundMissedProjectileAmmo(state, proj);
      }
      state.projectiles.splice(i, 1);
    }
  }

  // 2. Step Turrets, Wolf Traps & Boss Banners
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const turret = state.turrets[i]!;
    turret.ttlTicks -= 1;

    if (turret.kind === 'bossBanner') {
      if (turret.ttlTicks <= 0) {
        state.events.push({
          type: 'explosion',
          x: turret.pos.x,
          y: turret.pos.y,
          radius: turret.range,
          color: '#ff4757',
          element: 'fire',
        });
        spawnParticle(state, turret.pos.x, turret.pos.y, 0, 0, turret.range, '#ff4757', 24, 'ring', true, 0);
        state.screenShake = Math.max(state.screenShake, 8);
        if (Math.hypot(player.pos.x - turret.pos.x, player.pos.y - turret.pos.y) <= turret.range) {
          damagePlayer(state, turret.damage, 'Explosive Banner', rng, false, {
            attackerX: turret.pos.x,
            unblockable: true,
          });
        }
        state.turrets.splice(i, 1);
      }
      continue;
    }

    if (turret.ttlTicks <= 0 || turret.hp <= 0) {
      state.turrets.splice(i, 1);
      continue;
    }

    // Gentle gravity snap (+4px/tick) if no solid or one-way floor is directly beneath turret/trap
    const tTx = Math.max(0, Math.min(state.tileGrid.width - 1, Math.floor(turret.pos.x / TILE_SIZE)));
    const belowTy = Math.floor((turret.pos.y + 7) / TILE_SIZE);
    const hasSupport =
      col.isSolidAt(state.tileGrid, tTx, belowTy) || col.isOneWayAt(state.tileGrid, tTx, belowTy);
    if (!hasSupport) {
      const nextY = Math.min((state.tileGrid.height - 1) * TILE_SIZE - 6, turret.pos.y + 4);
      const landTy = Math.floor((nextY + 6) / TILE_SIZE);
      if (col.isSolidAt(state.tileGrid, tTx, landTy) || col.isOneWayAt(state.tileGrid, tTx, landTy)) {
        turret.pos.y = landTy * TILE_SIZE - 6;
      } else {
        turret.pos.y = nextY;
      }
    }

    if (turret.kind === 'wolfTrap') {
      if (turret.rootedEnemyUid == null) {
        for (let j = 0; j < state.enemies.length; j++) {
          const e = state.enemies[j]!;
          if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
          if (Math.hypot(e.pos.x - turret.pos.x, e.pos.y - turret.pos.y) <= turret.range) {
            turret.rootedEnemyUid = e.uid;
            const baseRootDur = e.isBoss ? 150 : 300;
            const applied = applyEnemyStatus(state, e, 'root', baseRootDur, 0, rng, col);
            spawnParticle(state, turret.pos.x, turret.pos.y, 0, 0, 32, '#ffd859', 16, 'ring', true, 0);
            for (let s = 0; s < 8; s++) {
              const ang = (s / 8) * Math.PI * 2;
              spawnParticle(
                state,
                turret.pos.x,
                turret.pos.y - 2,
                Math.cos(ang) * rng.rangeFloat(70, 145),
                Math.sin(ang) * rng.rangeFloat(65, 130) - 35,
                3.2,
                s % 2 === 0 ? '#ffe07a' : '#dce6f5',
                16,
                'spark',
                true,
                260
              );
            }
            spawnParticle(
              state,
              e.pos.x,
              e.pos.y - e.height * 0.6 - 10,
              0,
              -34,
              10,
              '#ffd859',
              36,
              'text',
              true,
              0,
              applied ? 'ROOTED!' : 'RESIST!'
            );
            spawnTransientLight(
              state,
              turret.pos.x,
              turret.pos.y - 4,
              78,
              [1.0, 0.86, 0.34],
              1.5,
              12,
              'slash'
            );
            damageEnemy(state, e, turret.damage, false, 35, 0, 0, rng, 'skill', undefined, col);
            turret.ttlTicks = Math.min(turret.ttlTicks, baseRootDur);
            break;
          }
        }
      }
      continue;
    }

    // Sinew Slicer & Heavy Turret: 320px player tether range!
    const distToPlayer = Math.hypot(turret.pos.x - player.pos.x, turret.pos.y - player.pos.y);
    if (distToPlayer > 320) {
      continue;
    }

    if (turret.fireCooldownTicks > 0) {
      turret.fireCooldownTicks -= 1;
    } else {
      let nearest: EnemyState | null = null;
      let bestDist = turret.range;
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j]!;
        if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
        const d = Math.hypot(e.pos.x - turret.pos.x, e.pos.y - turret.pos.y);
        if (d < bestDist && col.hasLineOfSight(state.tileGrid, turret.pos.x, turret.pos.y - 8, e.pos.x, e.pos.y)) {
          bestDist = d;
          nearest = e;
        }
      }
      if (nearest) {
        const dx = nearest.pos.x - turret.pos.x;
        const dy = nearest.pos.y - (turret.pos.y - 8);
        const len = Math.max(1, Math.hypot(dx, dy));
        const dirX = dx / len;
        const dirY = dy / len;
        turret.facing = dx >= 0 ? 1 : -1;
        const isSinew = turret.kind === 'sinew';
        turret.fireCooldownTicks = isSinew ? 20 : 42;
        const muzzleX = turret.pos.x + dirX * 8;
        const muzzleY = turret.pos.y - 8 + dirY * 6;
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'player',
          ownerUid: turret.uid,
          kind: isSinew ? 'knife' : 'arrow',
          pos: { x: muzzleX, y: muzzleY },
          prevPos: { x: muzzleX, y: muzzleY },
          vel: { x: dirX * (isSinew ? 380 : 420), y: dirY * (isSinew ? 380 : 420) },
          radius: isSinew ? 3.5 : 5,
          damage: turret.damage,
          isCrit: false,
          pierceLeft: isSinew ? 0 : 2,
          gravity: 0,
          ttlTicks: 45,
          maxTtlTicks: 45,
          color: isSinew ? '#ff4763' : '#ffd166',
          applyStatus: isSinew ? 'bleed' : undefined,
          parriable: false,
          hitIds: [],
        });
        for (let m = 0; m < 4; m++) {
          spawnParticle(
            state,
            muzzleX,
            muzzleY,
            dirX * rng.rangeFloat(70, 150) + rng.rangeFloat(-35, 35),
            dirY * rng.rangeFloat(70, 150) + rng.rangeFloat(-35, 35),
            3.2,
            isSinew ? '#ff7088' : '#ffe680',
            10,
            'spark',
            true,
            0
          );
        }
      }
    }
  }

  // 3. Step Dynamic Hazards (burningOil, toxicCloud, shockwaveZone)
  for (let i = state.hazards.length - 1; i >= 0; i--) {
    const hz = state.hazards[i]!;
    if (hz.ttlTicks > 0) {
      hz.ttlTicks -= 1;
      if (hz.ttlTicks === 0) {
        state.hazards.splice(i, 1);
        continue;
      }
    }

    if (hz.kind === 'burningOil' && state.tick % 4 === 0) {
      spawnParticle(
        state,
        hz.rect.x + rng.rangeFloat(2, Math.max(4, hz.rect.w - 2)),
        hz.rect.y + hz.rect.h * 0.65,
        rng.rangeFloat(-14, 14),
        rng.rangeFloat(-55, -24),
        rng.rangeFloat(3, 5),
        state.tick % 8 === 0 ? '#ff6b2b' : '#ffc848',
        18,
        'flame',
        true,
        -35
      );
    }

    if (state.tick % 20 !== 0) continue;
    const cx = hz.rect.x + hz.rect.w * 0.5;
    const cy = hz.rect.y + hz.rect.h * 0.5;

    if (hz.owner === 'player') {
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j]!;
        if (e.state === 'dead' || e.hp <= 0 || e.buried) continue;
        if (aabbOverlap(cx, cy, hz.rect.w, hz.rect.h, e.pos.x, e.pos.y, e.width, e.height)) {
          if (hz.kind === 'burningOil') {
            applyStatus(e.statusEffects, 'oil', 180, 0, 0);
            applyStatus(e.statusEffects, 'burn', 150, getStatusDps(state, 'burn'), 0);
          } else if (hz.kind === 'toxicCloud') {
            applyStatus(e.statusEffects, 'poison', 180, getStatusDps(state, 'poison'), 0);
          }
          damageEnemy(state, e, hz.damage, false, 0, 0, 0, rng, 'status', undefined, col);
        }
      }
    } else if (hz.owner === 'enemy' || hz.owner === 'world') {
      if (aabbOverlap(cx, cy, hz.rect.w, hz.rect.h, player.pos.x, player.pos.y, player.width, player.height)) {
        const label =
          hz.kind === 'spikes' ? 'Spikes' : hz.kind === 'acid' ? 'Toxic Acid' : 'Hazard';
        damagePlayer(state, hz.damage, label, rng, false, { unblockable: true });
      }
    }
  }
}

export function getStatusDisplayColor(kind: StatusKind): string {
  return getStatusColor(kind);
}
