import {
  FIXED_DT,
  MAX_ACTIVE_LIGHTS,
  MAX_BOSS_CELLS,
  TILE_SIZE,
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
  type WeaponDef,
} from '../contracts';
import { AFFIX_MAP, ENEMY_MAP, SKILL_MAP, WEAPON_MAP, getSkill, getWeapon } from '../data';
import {
  applyMutationCooldownReduction,
  applyMutationOnKill,
  applyMutationOnParry,
  computeGearDamage,
  getMutationDamageMultiplier,
  hasLoadoutAffixKind,
  hasMutation,
  onEnemyKilledForCurseAndStreak,
} from './roguelite';
import {
  applyStatus,
  clearNegativeStatuses,
  computeSynergyMultiplier,
  getStatusColor,
  hasStatus,
  tickEntityStatuses,
} from './status';

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
    const g = getWeaponGear(state, slots[i]);
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
  return (
    Math.abs(ax - bx) * 2 < aw + bw &&
    Math.abs(ay - by) * 2 < ah + bh
  );
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

const PARRIABLE_BOSS_MELEE: ReadonlySet<string> = new Set([
  'punch',
  'dashSlash',
  'lanceCombo',
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

  // 1. Overlapping parriable enemy projectiles
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i];
    if (p.owner !== 'enemy' || !p.parriable) continue;
    if (Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) <= 28) {
      return attemptShieldParry(state, p.damage, null, p, rng);
    }
  }

  // 2. Overlapping active enemy/boss melee strikes
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (e.state !== 'attack' || e.hp <= 0 || e.hitPlayerThisSwing) continue;

    if (e.isBoss) {
      if (!PARRIABLE_BOSS_MELEE.has(e.bossAttackId)) continue;
      const dx = player.pos.x - e.pos.x;
      const dy = player.pos.y - e.pos.y;
      const reachX =
        e.bossAttackId === 'lanceCombo' ? 76 : e.bossAttackId === 'punch' ? 68 : 58;
      const reachY = 42;
      if (Math.abs(dx) <= reachX && dx * e.facing >= -18 && Math.abs(dy) <= reachY) {
        if (attemptShieldParry(state, e.damage, e, null, rng)) {
          e.hitPlayerThisSwing = true;
          return true;
        }
      }
    } else {
      const def = ENEMY_MAP[e.defId];
      if (!def || !def.canBeParried || RANGED_ENEMY_ATTACK_KINDS.has(def.attackKind)) {
        continue;
      }
      const dx = player.pos.x - e.pos.x;
      const dy = player.pos.y - e.pos.y;
      const reachX = e.defId === 'Lancer' ? 92 : Math.max(38, def.attackRange + 8);
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
      return (enemy.pos.x - player.pos.x) * enemy.facing > 0;
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
      return hasStatus(enemy.statusEffects, 'burn') || hasStatus(enemy.statusEffects, 'oil');
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
        const other = state.enemies[i];
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
      const tx = Math.floor((enemy.pos.x + dir * (enemy.width * 0.5 + 22)) / TILE_SIZE);
      const ty = Math.floor(enemy.pos.y / TILE_SIZE);
      return col.isSolidAt(state.tileGrid, tx, ty);
    }
    case 'highCombo':
      return stepIndex >= 2 || player.comboStep >= 2 || player.killStreak >= 3;
    case 'closeRange':
      return Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y) <= 84;
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
  isRangedWeapon: boolean
): void {
  if (weaponStatus) {
    const dur =
      weaponStatus === 'freeze'
        ? 110
        : weaponStatus === 'stun'
          ? 75
          : weaponStatus === 'root'
            ? 150
            : 210;
    const dps =
      weaponStatus === 'bleed' ||
      weaponStatus === 'poison' ||
      weaponStatus === 'burn' ||
      weaponStatus === 'electrify'
        ? getStatusDps(state, weaponStatus)
        : 0;
    applyStatus(enemy.statusEffects, weaponStatus, dur, dps, 0);
    if (weaponStatus === 'freeze') {
      enemy.state = 'frozen';
      enemy.stateTicks = Math.max(enemy.stateTicks, 90);
    } else if (weaponStatus === 'stun') {
      enemy.stunTicks = Math.max(enemy.stunTicks, 75);
      enemy.state = 'stunned';
    }
  }

  if (affixes) {
    for (let i = 0; i < affixes.length; i++) {
      const def = AFFIX_MAP[affixes[i]];
      if (!def || def.kind !== 'applyStatus' || !def.applyStatus) continue;
      const st = def.applyStatus;
      const dur = st === 'oil' ? 300 : 210;
      const dps = st === 'oil' ? 0 : getStatusDps(state, st);
      applyStatus(enemy.statusEffects, st, dur, dps, 0);
    }
  }

  if (isMelee && hasMutation(state, 'OpenWounds')) {
    applyStatus(enemy.statusEffects, 'bleed', 180, getStatusDps(state, 'bleed'), 0);
  }
  if (isMelee && hasMutation(state, 'Melee')) {
    applyStatus(enemy.statusEffects, 'slow', 150, 0, 0);
    applyStatus(enemy.statusEffects, 'frost', 180, 0, 0);
  }
  if (isRangedWeapon && hasMutation(state, 'BarbedTips')) {
    applyStatus(enemy.statusEffects, 'bleed', 180, getStatusDps(state, 'bleed'), 0);
  }
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
    projectile.owner = 'player';
    projectile.ownerUid = 0;
    const speed = Math.max(320, Math.hypot(projectile.vel.x, projectile.vel.y) * 1.45);
    const dirX = projectile.vel.x === 0 ? player.facing : -Math.sign(projectile.vel.x);
    projectile.vel.x = dirX * speed;
    projectile.vel.y = Math.min(0, -Math.abs(projectile.vel.y) * 0.5);
    projectile.gravity = Math.min(projectile.gravity, 120);
    projectile.damage = Math.max(
      shieldCounterDamage,
      Math.round(Math.max(incomingDamage, projectile.damage) * 2.2)
    );
    projectile.isCrit = true;
    projectile.parriable = false;
    projectile.ttlTicks = Math.max(projectile.ttlTicks, 120);
    projectile.hitIds = [];
    projectile.color = '#ffe866';
    projectile.affixes = shieldGear?.affixes;

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
    const stunDur = shieldDef?.parryPassive === 'stun' ? 165 : 75;
    attacker.stunTicks = Math.max(attacker.stunTicks, stunDur);
    if (!attacker.isBoss) {
      attacker.state = 'stunned';
      attacker.stateTicks = Math.max(attacker.stateTicks, stunDur);
    }
    applyStatus(attacker.statusEffects, 'stun', stunDur, 0, 0);

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
      const e = state.enemies[i];
      if (e.state === 'dead' || e.hp <= 0) continue;
      if (Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= 110) {
        applyStatus(e.statusEffects, 'bleed', 240, bleedDps, 0);
      }
    }
    spawnParticle(state, player.pos.x, player.pos.y, 0, 0, 88, '#ff2e4c', 18, 'ring', true, 0);
  } else if (passive === 'forcefield') {
    applyStatus(player.statusEffects, 'shield', 120, 0, 0);
  } else if (passive === 'damageBuff') {
    player.afterParryCritTicks = 180;
    player.comboMutationTicks = Math.max(player.comboMutationTicks, 180);
  }

  applyMutationOnParry(state);
  return true;
}

export function damagePlayer(
  state: SimState,
  amount: number,
  sourceLabel: string,
  rng: RngAPI,
  ignoreIframes = false
): boolean {
  const player = state.player;
  if (player.godMode || player.actionState === 'dead' || state.runStatus !== 'playing') {
    return false;
  }

  if (!ignoreIframes) {
    if (player.iframeTicks > 0 || hasStatus(player.statusEffects, 'shield')) {
      return false;
    }
  } else if (hasStatus(player.statusEffects, 'shield')) {
    return false;
  }

  // Cursed instant death (any unparried damage kills immediately!)
  if (player.curseKillsLeft > 0) {
    const lost = player.hp;
    player.hp = 0;
    player.rallyHp = 0;
    player.killStreak = 0;
    player.speedKillCount = 0;
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
  if ((player.hitFlashTicks > 0 || player.rallyHp > 0) && hasMutation(state, 'Vengeance')) {
    mult *= 0.75;
  }
  if (hasStatus(player.statusEffects, 'corrupted')) {
    mult *= 1.3;
  }
  if (hasLoadoutAffixKind(state, 'dmgDealtTaken')) {
    mult *= 1.2;
  }

  // Hold-to-block shield mitigation: 75% damage reduction on non-cursed, non-DoT hits
  const isShieldBlocked = Boolean(
    player.shieldBlocking && !ignoreIframes && player.curseKillsLeft <= 0
  );
  if (isShieldBlocked) {
    mult *= 0.25;
  }

  const finalDamage = Math.max(1, Math.round(amount * mult));
  const actualLost = Math.min(player.hp, finalDamage);

  if (isShieldBlocked) {
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
  }

  // Disengagement safety shield below 20% HP
  const lowHpThreshold = Math.round(player.maxHp * 0.2);
  if (
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

  // Rally orange HP recovery: 100% of lost HP enters rallyHp, holds 60 ticks, drains over 240 ticks
  player.rallyHp = Math.min(player.maxHp - player.hp, player.rallyHp + actualLost);
  player.rallyHoldTicks = 60;
  player.rallyDrainTicks = 240;

  // Reset kill streak on taking damage
  player.killStreak = 0;
  player.speedKillCount = 0;
  player.hitFlashTicks = 12;
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
    rallyAdded: actualLost,
  });

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
  if (enemy.state === 'dead' || enemy.hp <= 0) {
    return false;
  }

  // Protector shield aura or Boss transition invulnerability shield
  if (enemy.protectedByUid !== null || enemy.bossShieldTicks > 0) {
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

  // Front shield block (Shieldbearer blocks frontal attacks unless rolled behind, stunned, frozen, lightning, or heavy breach)
  const enemyDef = ENEMY_MAP[enemy.defId];
  const isLightning = weaponId === 'Whip' || weaponId === 'status' || weaponId === 'skill';
  if (
    enemyDef &&
    enemyDef.shieldFront &&
    !isLightning &&
    breachPower < 55 &&
    enemy.stunTicks <= 0 &&
    !hasStatus(enemy.statusEffects, 'freeze') &&
    !hasStatus(enemy.statusEffects, 'root') &&
    (state.player.pos.x - enemy.pos.x) * enemy.facing > 0
  ) {
    enemy.vel.x += Math.sign(knockbackX || enemy.facing) * -35;
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
    const t = state.turrets[i];
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
        enemy.stunTicks = Math.max(enemy.stunTicks, 35);
        enemy.state = 'stunned';
        enemy.stateTicks = Math.max(enemy.stateTicks, 35);
        applyStatus(enemy.statusEffects, 'stun', 35, 0, 0);
      }
      spawnParticle(
        state,
        probeX,
        enemy.pos.y,
        0,
        0,
        24,
        '#ffcf66',
        14,
        'ring',
        true,
        0
      );
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

  enemy.hp = Math.max(0, enemy.hp - finalDamage);
  enemy.hitFlashTicks = 8;

  // Rally recovery: weapon damage heals up to 75% of hit damage from rallyHp
  const isWeaponDamage = weaponId !== 'status';
  if (isWeaponDamage && state.player.rallyHp > 0 && state.player.hp > 0) {
    const healFromRally = Math.min(
      state.player.rallyHp,
      Math.max(1, Math.round(finalDamage * 0.75))
    );
    state.player.rallyHp = Math.max(0, state.player.rallyHp - healFromRally);
    state.player.hp = Math.min(state.player.maxHp, state.player.hp + healFromRally);
    state.events.push({
      type: 'rallyRecovered',
      x: state.player.pos.x,
      y: state.player.pos.y,
      amount: healFromRally,
    });
  }

  // Breach & knockback
  let didBreach = false;
  if (breachPower > 0) {
    enemy.breachMeter += breachPower;
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

    // Clear Protector aura from allies if Protector died
    if (enemy.defId === 'Protector') {
      for (let i = 0; i < state.enemies.length; i++) {
        if (state.enemies[i].protectedByUid === enemy.uid) {
          state.enemies[i].protectedByUid = null;
        }
      }
    }

    // Worm drops 6 death-bombs on death!
    if (enemy.defId === 'Worm') {
      for (let i = 0; i < 6; i++) {
        const vx = -110 + i * 44 + rng.rangeFloat(-12, 12);
        const vy = rng.rangeFloat(-200, -120);
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
          ttlTicks: 48 + i * 5,
          maxTtlTicks: 78,
          color: '#ff6642',
          explosionRadius: 42,
          parriable: true,
          hitIds: [],
        });
      }
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
        const other = state.enemies[i];
        if (other.uid === enemy.uid || other.state === 'dead' || other.hp <= 0) continue;
        if (Math.hypot(other.pos.x - enemy.pos.x, other.pos.y - enemy.pos.y) <= 56) {
          applyStatus(other.statusEffects, 'poison', 240, getStatusDps(state, 'poison'), 0);
        }
      }
    }

    // Recover player ranged ammo on kill
    const w1 = state.player.loadout.weapon1;
    const w2 = state.player.loadout.weapon2;
    if (w1 && w1.maxAmmo !== undefined && w1.ammo !== undefined) {
      w1.ammo = Math.min(w1.maxAmmo, w1.ammo + 3);
    }
    if (w2 && w2.maxAmmo !== undefined && w2.ammo !== undefined) {
      w2.ammo = Math.min(w2.maxAmmo, w2.ammo + 3);
    }

    // Boss death: 18-tick slow-mo burst, unlock boss gates, check KingsHand victory
    if (enemy.isBoss) {
      state.slowMoTicks = 18;
      state.screenShake = Math.max(state.screenShake, 12);
      state.bossArenaState.defeated = true;
      state.bossArenaState.active = false;
      for (let i = 0; i < state.doors.length; i++) {
        if (state.doors[i].kind === 'bossGate') {
          state.doors[i].opened = true;
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

function fireRangedWeapon(
  state: SimState,
  weaponDef: WeaponDef,
  gear: GearInstance,
  step: StrikeStep,
  stepIndex: number,
  input: InputFrame,
  rng: RngAPI
): void {
  const player = state.player;
  const baseDmg = computeGearDamage(step.basePower, gear, player.scrolls);
  const speed = step.projectileSpeed ?? 390;
  const spawnX = player.pos.x + player.facing * step.offsetX;
  const spawnY = player.pos.y + step.offsetY;

  let aimDx: number = player.facing;
  let aimDy = 0;

  if (hasValidAim(input)) {
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
      const e = state.enemies[i];
      if (e.state === 'dead' || e.hp <= 0) continue;
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
  } else {
    // Keyboard-only: Dead Cells frontal auto-aim toward nearest living enemy in front
    let bestDist = step.rangeX;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i];
      if (e.state === 'dead' || e.hp <= 0) continue;
      const dx = e.pos.x - spawnX;
      const dy = e.pos.y - spawnY;
      if (dx * player.facing < -8) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist && Math.abs(dy) <= Math.max(step.rangeY, 72)) {
        bestDist = dist;
        aimDx = dx / Math.max(1, dist);
        aimDy = dy / Math.max(1, dist);
      }
    }
  }

  // Electric Whip chains instantly to up to 2 nearby targets for snappy responsiveness
  const chainedIds: number[] = [];
  if (weaponDef.id === 'Whip') {
    let hitCount = 0;
    for (let i = 0; i < state.enemies.length && hitCount < 2; i++) {
      const e = state.enemies[i];
      if (e.state === 'dead' || e.hp <= 0) continue;
      const ex = e.pos.x - player.pos.x;
      const ey = e.pos.y - player.pos.y;
      const dist = Math.hypot(ex, ey);
      const aligned = hasValidAim(input)
        ? ex * aimDx + ey * aimDy >= -16
        : ex * player.facing >= -16;
      if (dist <= step.rangeX && aligned) {
        const mutMult = getMutationDamageMultiplier(state, false, dist);
        const isCrit = evaluateCritCondition(state, weaponDef, stepIndex, e);
        const dmg = Math.round(baseDmg * mutMult * (isCrit ? step.critMul : 1));
        applyWeaponAndAffixStatuses(state, e, 'electrify', gear.affixes, false, true);
        damageEnemy(
          state,
          e,
          dmg,
          isCrit,
          step.breachPower,
          (ex >= 0 ? 1 : -1) * 45,
          -20,
          rng,
          weaponDef.id,
          gear.affixes
        );
        chainedIds.push(e.uid);
        for (let s = 0; s < 4; s++) {
          spawnParticle(
            state,
            e.pos.x + rng.rangeFloat(-8, 8),
            e.pos.y + rng.rangeFloat(-10, 8),
            rng.rangeFloat(-70, 70),
            rng.rangeFloat(-70, 40),
            3,
            '#78e6ff',
            12,
            'spark',
            true,
            0
          );
        }
        hitCount += 1;
      }
    }
  }

  let pierce = step.pierceCount ?? 0;
  if (gear.affixes.includes('pierce_first')) {
    pierce += 1;
  }

  const kind = step.projectileKind ?? 'arrow';
  const radius = kind === 'fireball' ? 6 : kind === 'lightning' ? 9 : 4;
  const ttl = Math.max(14, Math.round((step.rangeX / Math.max(100, speed)) * 60) + 6);

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
    hitIds: chainedIds,
    affixes: gear.affixes,
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

  // Smash wooden doors in weapon reach
  for (let i = 0; i < state.doors.length; i++) {
    const door = state.doors[i];
    if (door.kind !== 'wood' || door.broken || door.opened) continue;
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
        const e = state.enemies[j];
        if (e.state === 'dead' || e.hp <= 0 || e.isBoss) continue;
        if (Math.hypot(e.pos.x - door.pos.x, e.pos.y - door.pos.y) <= 72) {
          e.stunTicks = Math.max(e.stunTicks, 90);
          e.state = 'stunned';
          applyStatus(e.statusEffects, 'stun', 90, 0, 0);
        }
      }
    }
  }

  // Damage enemy boss banners in reach
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i];
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
    const enemy = state.enemies[i];
    if (enemy.state === 'dead' || enemy.hp <= 0) continue;
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
      const isCrit = evaluateCritCondition(state, weaponDef, stepIndex, enemy, col);
      const mutMult = getMutationDamageMultiplier(state, true, dist);
      const rawDamage = Math.round(baseDmg * mutMult * (isCrit ? step.critMul : 1.0));
      const kbX = player.facing * (step.breachPower >= 45 ? 165 : 95);
      const kbY = step.breachPower >= 45 ? -70 : -25;

      applyWeaponAndAffixStatuses(state, enemy, step.applyStatus, gear.affixes, true, false);
      damageEnemy(
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
  player.parryCooldownTicks = 26;
  player.shieldBlocking = false;
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

  if (player.activeWeaponSlot !== slot || player.comboResetTicks <= 0) {
    player.comboStep = 0;
  }
  player.activeWeaponSlot = slot;
  const stepIndex = player.comboStep % weaponDef.strikeChain.length;
  const step = weaponDef.strikeChain[stepIndex];

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
    return;
  }

  // Decrement combat & mutation timers
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

  // Passive ammo regeneration for ranged weapons
  if (state.tick % 60 === 0) {
    const slots = [player.loadout.weapon1, player.loadout.weapon2];
    for (let i = 0; i < slots.length; i++) {
      const g = slots[i];
      if (g && g.maxAmmo !== undefined && g.ammo !== undefined && g.ammo < g.maxAmmo) {
        g.ammo += 1;
      }
    }
  }

  // Tick player status effects
  tickEntityStatuses(player.statusEffects, (kind, amount) => {
    state.events.push({ type: 'statusProc', x: player.pos.x, y: player.pos.y, status: kind });
    damagePlayer(state, amount, kind, rng, true);
  });

  // Tick Rally (Orange Health Recovery)
  if (player.rallyHp > 0) {
    if (player.rallyHoldTicks > 0) {
      player.rallyHoldTicks -= 1;
    } else {
      const drainRate = Math.max(
        player.maxHp / 240,
        player.rallyHp / Math.max(1, player.rallyDrainTicks)
      );
      player.rallyHp = Math.max(0, player.rallyHp - drainRate);
      if (player.rallyDrainTicks > 0) player.rallyDrainTicks -= 1;
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
      damage: Math.max(8, Math.round(12 * Math.pow(1.15, Math.max(0, player.scrolls.brutality - 1)))),
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

  // If physics already started a roll this tick, immediately cancel any weapon swing
  if (player.actionState === 'roll') {
    if (player.attackPhase !== 'none') {
      player.attackPhase = 'none';
      player.attackPhaseTicks = 0;
      player.attackHitIds = [];
    }
    player.parryWindowTicks = 0;
    player.shieldBlocking = false;
    player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 60);
  }

  // Instant Roll Cancel of weapon windup & recovery
  if (
    (input.rollPressed || player.queuedInput === 'roll') &&
    player.rollCooldownTicks <= 0 &&
    player.actionState !== 'roll'
  ) {
    player.attackPhase = 'none';
    player.attackPhaseTicks = 0;
    player.attackHitIds = [];
    player.parryWindowTicks = 0;
    player.shieldBlocking = false;
    player.actionState = 'roll';
    player.rollTicks = 24;
    player.iframeTicks = 21;
    player.rollCooldownTicks = 15;
    player.afterRollCritTicks = 60;
    if (input.moveLeft && !input.moveRight) player.facing = -1;
    else if (input.moveRight && !input.moveLeft) player.facing = 1;
    player.vel.x = player.facing * 265;
    player.queuedInput = 'none';
    player.queuedInputTicks = 0;
    state.events.push({
      type: 'dodgeRoll',
      x: player.pos.x,
      y: player.pos.y,
      facing: player.facing,
    });
    return;
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

  // Health Flask activation (heals 60% max HP per SPEC.md oracle) + full/empty feedback
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
      player.healTicks = 24;
      player.iframeTicks = Math.max(player.iframeTicks, 20);
      player.actionState = 'heal';
      player.attackPhase = 'none';
      player.attackPhaseTicks = 0;
      player.shieldBlocking = false;
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

  // Do not run weapon attacks while rolling, parrying, or drinking flask
  if (
    player.actionState === 'roll' ||
    player.parryWindowTicks > 0 ||
    player.healTicks > 0
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
    const step = weaponDef.strikeChain[stepIndex];

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
        fireRangedWeapon(state, weaponDef, gear, step, stepIndex, input, rng);
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

  // Hold-to-Block tracking when holding a shield outside active parry/roll/attack/heal
  const holdingShield =
    (input.weapon2Held && w2Def?.kind === 'shield') ||
    (input.weapon1Held && w1Def?.kind === 'shield');
  player.shieldBlocking =
    Boolean(holdingShield) &&
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
        if (state.turrets[i].owner === 'player' && state.turrets[i].kind === kind) {
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
        ttlTicks: 54,
        maxTtlTicks: 54,
        color,
        applyStatus: skillDef.applyStatus,
        explosionRadius: skillDef.radius,
        parriable: false,
        hitIds: [],
        affixes: gear.affixes,
      });
      break;
    }

    case 'Phaser': {
      let target: EnemyState | null = null;
      let bestDist = skillDef.radius;
      for (let i = 0; i < state.enemies.length; i++) {
        const e = state.enemies[i];
        if (e.state === 'dead' || e.hp <= 0) continue;
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
        player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 90);
        player.iframeTicks = Math.max(player.iframeTicks, 15);
        applyStatus(target.statusEffects, 'root', 90, 0, 0);
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
          const testX = fromX + player.facing * stepDistances[k];
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
        player.afterRollCritTicks = Math.max(player.afterRollCritTicks, 90);
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
        if (state.turrets[i].owner === 'player' && state.turrets[i].kind === 'wolfTrap') {
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
      // Double shockwave ring + 14 cyan wind sparks + transient cyan light
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

      // Reflect all enemy projectiles within radius
      for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        if (p.owner !== 'enemy') continue;
        if (Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) <= skillDef.radius) {
          p.owner = 'player';
          p.ownerUid = 0;
          const pushDir = p.pos.x >= player.pos.x ? 1 : -1;
          p.vel.x = Math.abs(p.vel.x) < 40 ? pushDir * 300 : -p.vel.x * 1.4;
          p.vel.y = -p.vel.y * 0.6;
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
        const e = state.enemies[i];
        if (e.state === 'dead' || e.hp <= 0) continue;
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
        const e = state.enemies[i];
        if (e.state === 'dead' || e.hp <= 0) continue;
        if (Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= skillDef.radius) {
          applyStatus(e.statusEffects, 'electrify', 150, getStatusDps(state, 'electrify'), 0);
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
      const heal = Math.max(10, Math.round(player.maxHp * 0.25));
      player.hp = Math.min(player.maxHp, player.hp + heal);
      player.rallyHp = 0;
      clearNegativeStatuses(player.statusEffects);
      applyStatus(player.statusEffects, 'shield', skillDef.durationTicks, 0, 0);
      player.speedBuffTicks = Math.max(player.speedBuffTicks, 240);
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
        `TONIC +${heal}`
      );
      break;
    }
  }

  return true;
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

  // Expanding shockwave ring + 14 bright sparks/flames/ice shards + intense transient light!
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

  // Cluster grenade splits into 5 juicy sub-bomblets
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
        ttlTicks: 34,
        maxTtlTicks: 34,
        color: proj.color,
        applyStatus: proj.applyStatus,
        explosionRadius: 42,
        parriable: proj.owner === 'enemy',
        hitIds: [],
        affixes: proj.affixes,
      });
    }
  }

  // Fire grenade leaves visible burning oil zone with flames
  if (proj.owner === 'player' && proj.applyStatus === 'burn') {
    const oilFloorY = findFloorY(state, proj.pos.x, proj.pos.y - 4, col);
    const oilY = Math.abs(oilFloorY - proj.pos.y) <= 42 ? oilFloorY - 12 : proj.pos.y - 10;
    const oilW = radius * 1.4;
    state.hazards.push({
      uid: state.nextUid++,
      rect: {
        x: proj.pos.x - oilW * 0.5,
        y: oilY,
        w: oilW,
        h: 18,
      },
      kind: 'burningOil',
      damage: Math.max(8, Math.round(proj.damage * 0.25)),
      ttlTicks: 240,
      owner: 'player',
    });
    for (let f = 0; f < 6; f++) {
      spawnParticle(
        state,
        proj.pos.x + rng.rangeFloat(-oilW * 0.45, oilW * 0.45),
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

  if (proj.owner === 'player') {
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i];
      if (e.state === 'dead' || e.hp <= 0) continue;
      if (proj.kind === 'fireball' && proj.hitIds.includes(e.uid)) continue;
      if (Math.hypot(e.pos.x - proj.pos.x, e.pos.y - proj.pos.y) <= radius) {
        if (proj.applyStatus) {
          const dur = proj.applyStatus === 'freeze' ? 150 : 210;
          const dps =
            proj.applyStatus === 'burn' || proj.applyStatus === 'bleed' || proj.applyStatus === 'poison'
              ? getStatusDps(state, proj.applyStatus)
              : 0;
          applyStatus(e.statusEffects, proj.applyStatus, dur, dps, 0);
          if (proj.applyStatus === 'burn') {
            applyStatus(e.statusEffects, 'oil', 240, 0, 0);
          }
          if (proj.applyStatus === 'freeze') {
            e.state = 'frozen';
            e.stateTicks = Math.max(e.stateTicks, 120);
          }
        }
        const dir = e.pos.x >= proj.pos.x ? 1 : -1;
        damageEnemy(state, e, proj.damage, proj.isCrit, 45, dir * 130, -85, rng, 'skill', proj.affixes, col);
      }
    }
  } else {
    const p = state.player;
    if (Math.hypot(p.pos.x - proj.pos.x, p.pos.y - proj.pos.y) <= radius) {
      if (!attemptShieldParry(state, proj.damage, null, proj, rng)) {
        damagePlayer(state, proj.damage, 'Explosion', rng);
      }
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
    const proj = state.projectiles[i];
    proj.prevPos.x = proj.pos.x;
    proj.prevPos.y = proj.pos.y;
    proj.ttlTicks -= 1;

    if (proj.gravity !== 0) {
      proj.vel.y += proj.gravity * FIXED_DT;
    }

    const nextX = proj.pos.x + proj.vel.x * FIXED_DT;
    const nextY = proj.pos.y + proj.vel.y * FIXED_DT;
    const tx = Math.floor(nextX / TILE_SIZE);
    const ty = Math.floor(nextY / TILE_SIZE);

    // Shockwaves hug floor, laser beams & Mage360 bolts pierce thin walls, others collide
    const ignoresWalls = proj.kind === 'laserBeam' || proj.kind === 'fallingSword';
    const hitWall = !ignoresWalls && col.isSolidAt(state.tileGrid, tx, ty);

    if (hitWall) {
      if (proj.kind === 'grenade' || proj.kind === 'cluster') {
        detonateProjectile(state, proj, rng, col);
        state.projectiles.splice(i, 1);
        continue;
      } else if (proj.kind === 'shockwave') {
        // Shockwave rides along floor, stops only on solid wall ahead
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
        state.projectiles.splice(i, 1);
        continue;
      }
    } else {
      proj.pos.x = nextX;
      proj.pos.y = nextY;
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
        const tur = state.turrets[t];
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
          const enemy = state.enemies[j];
          if (enemy.state === 'dead' || enemy.hp <= 0) continue;
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
              const primarySlot = player.activeWeaponSlot;
              const secondarySlot: 1 | 2 = primarySlot === 1 ? 2 : 1;
              const candidates = [getWeaponGear(state, primarySlot), getWeaponGear(state, secondarySlot)];
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

            let isCrit = proj.isCrit;
            if (!isCrit && projWeaponDef) {
              const critStep = projWeaponDef.id === 'FastBow' ? player.comboStep : 0;
              isCrit = evaluateCritCondition(state, projWeaponDef, critStep, enemy, col);
            }
            const critMul = isCrit && !proj.isCrit ? projWeaponDef?.strikeChain[0]?.critMul ?? 2.0 : 1.0;
            const mutMult = getMutationDamageMultiplier(state, false, dist);
            const hitDmg = Math.round(proj.damage * mutMult * critMul);

            applyWeaponAndAffixStatuses(state, enemy, proj.applyStatus, proj.affixes, false, true);
            damageEnemy(
              state,
              enemy,
              hitDmg,
              isCrit,
              proj.kind === 'fireball' ? 28 : 16,
              Math.sign(proj.vel.x || 1) * 70,
              -20,
              rng,
              projWeaponDef?.id ?? (proj.ownerUid === 0 ? 'ranged' : 'skill'),
              proj.affixes,
              col
            );

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
          // TimeKeeper Grappling Hook pulls player toward boss!
          const owner = state.enemies.find((e) => e.uid === proj.ownerUid);
          if (owner && owner.state !== 'dead') {
            const pullDir = Math.sign(owner.pos.x - player.pos.x);
            player.vel.x = pullDir * 310;
            player.vel.y = -120;
          }
          damagePlayer(state, proj.damage, 'Grappling Hook', rng);
          consumed = true;
        } else if (proj.kind === 'grenade' || proj.kind === 'cluster') {
          detonateProjectile(state, proj, rng, col);
          consumed = true;
        } else {
          if (damagePlayer(state, proj.damage, proj.kind === 'acidSpit' ? 'Acid Spit' : 'Projectile', rng)) {
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
      }
      state.projectiles.splice(i, 1);
    }
  }

  // 2. Step Turrets, Wolf Traps & Boss Banners
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const turret = state.turrets[i];
    turret.ttlTicks -= 1;

    if (turret.kind === 'bossBanner') {
      // Sovereign Hand Explosive Banner: detonates when timer hits 0!
      if (turret.ttlTicks <= 0) {
        spawnParticle(state, turret.pos.x, turret.pos.y, 0, 0, turret.range, '#ff4757', 24, 'ring', true, 0);
        state.screenShake = Math.max(state.screenShake, 8);
        if (Math.hypot(player.pos.x - turret.pos.x, player.pos.y - turret.pos.y) <= turret.range) {
          damagePlayer(state, turret.damage, 'Explosive Banner', rng);
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
          const e = state.enemies[j];
          if (e.state === 'dead' || e.hp <= 0) continue;
          if (Math.hypot(e.pos.x - turret.pos.x, e.pos.y - turret.pos.y) <= turret.range) {
            turret.rootedEnemyUid = e.uid;
            const rootDur = e.isBoss ? 150 : 300;
            applyStatus(e.statusEffects, 'root', rootDur, 0, 0);
            if (!e.isBoss) {
              e.state = 'rooted';
              e.stateTicks = rootDur;
            }
            // Crisp metallic jaw-snap sparks + gold ring + ROOTED! text + transient flash light
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
              'ROOTED!'
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
            turret.ttlTicks = Math.min(turret.ttlTicks, rootDur);
            break;
          }
        }
      }
      continue;
    }

    // Sinew Slicer & Heavy Turret firing logic
    if (turret.fireCooldownTicks > 0) {
      turret.fireCooldownTicks -= 1;
    } else {
      let nearest: EnemyState | null = null;
      let bestDist = turret.range;
      for (let j = 0; j < state.enemies.length; j++) {
        const e = state.enemies[j];
        if (e.state === 'dead' || e.hp <= 0) continue;
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
        // Bright turret muzzle sparks!
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
    const hz = state.hazards[i];
    if (hz.ttlTicks > 0) {
      hz.ttlTicks -= 1;
      if (hz.ttlTicks === 0) {
        state.hazards.splice(i, 1);
        continue;
      }
    }

    // Continuous visible flame particles over burningOil zones
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
        const e = state.enemies[j];
        if (e.state === 'dead' || e.hp <= 0) continue;
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
        damagePlayer(state, hz.damage, label, rng);
      }
    }
  }
}

export function getStatusDisplayColor(kind: StatusKind): string {
  return getStatusColor(kind);
}
