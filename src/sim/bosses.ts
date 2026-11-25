import {
  FIXED_DT,
  TILE_SIZE,
  type BossDef,
  type BossId,
  type CollisionAPI,
  type EnemyState,
  type RngAPI,
  type SimState,
} from '../contracts';
import { getBoss, getDifficulty } from '../data';
import { attemptShieldParry, damagePlayer } from './combat';
import { spawnEnemy } from './enemies';
import { hasStatus } from './status';

export function spawnBoss(
  state: SimState,
  bossId: BossId,
  x: number,
  y: number
): EnemyState {
  const def = getBoss(bossId);
  const diff = getDifficulty(state.bossStemCells);

  const maxHp = Math.max(500, Math.round(def.baseHp * diff.mobHpMult));
  const damage = Math.max(12, Math.round(def.baseDamage * diff.mobDmgMult));

  const boss: EnemyState = {
    uid: state.nextUid++,
    defId: def.id,
    name: def.name,
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: 0, y: 0 },
    width: def.width,
    height: def.height,
    facing: -1,
    grounded: false,
    hp: maxHp,
    maxHp,
    damage,
    state: 'chase',
    stateTicks: 30,
    telegraphTicks: 0,
    attackCooldownTicks: 40,
    stunTicks: 0,
    breachMeter: 0,
    breachThreshold: Math.round(maxHp * 0.14),
    hitFlashTicks: 0,
    isElite: false,
    eliteTimerTicks: 0,
    isBoss: true,
    bossId: def.id,
    bossPhase: 1,
    bossAttackId: '',
    bossAuraTicks: 0,
    bossShieldTicks: 0,
    bossBannerCooldown: 180,
    homePos: { x, y },
    patrolMinX: x - 200,
    patrolMaxX: x + 200,
    roomId: 0,
    statusEffects: [],
    hitPlayerThisSwing: false,
    protectedByUid: null,
  };

  state.enemies.push(boss);

  const arenaRoom = state.rooms.find((r) => r.type === 'bossArena') ?? state.rooms[0];
  const lockedLeftX = arenaRoom
    ? (arenaRoom.tx + 2) * TILE_SIZE
    : Math.max(TILE_SIZE * 2, x - 240);
  const lockedRightX = arenaRoom
    ? (arenaRoom.tx + arenaRoom.tw - 2) * TILE_SIZE
    : x + 240;

  state.bossArenaState = {
    active: true,
    bossId: def.id,
    bossUid: boss.uid,
    lockedLeftX,
    lockedRightX,
    defeated: false,
    bannerTicks: 150,
  };

  return boss;
}

function getTargetPhaseIndex(def: BossDef, hpRatio: number): number {
  let phaseIdx = 0;
  for (let i = 0; i < def.phases.length; i++) {
    if (hpRatio <= def.phases[i].hpThreshold) {
      phaseIdx = i;
    }
  }
  return phaseIdx;
}

function tryBossMeleeHit(
  state: SimState,
  boss: EnemyState,
  rangeX: number,
  rangeY: number,
  dmgMult: number,
  parriable: boolean,
  rng: RngAPI,
  knockX = 0,
  knockY = 0
): boolean {
  const player = state.player;
  const dx = player.pos.x - boss.pos.x;
  const dy = player.pos.y - boss.pos.y;
  const inX = Math.abs(dx) <= rangeX && (dx * boss.facing >= -18 || rangeX >= 70);
  const inY = Math.abs(dy) <= rangeY;
  if (!inX || !inY) return false;

  const dmg = Math.max(1, Math.round(boss.damage * dmgMult));
  if (parriable && attemptShieldParry(state, dmg, boss, null, rng)) {
    boss.hitPlayerThisSwing = true;
    return true;
  }

  if (damagePlayer(state, dmg, boss.name, rng)) {
    boss.hitPlayerThisSwing = true;
    if (knockX !== 0) player.vel.x = knockX;
    if (knockY !== 0) player.vel.y = knockY;
    return true;
  }
  return false;
}

function beginBossAttack(
  state: SimState,
  boss: EnemyState,
  attackId: string,
  speedMult: number
): void {
  const player = state.player;
  boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
  boss.bossAttackId = attackId;
  boss.hitPlayerThisSwing = false;
  boss.state = 'windup';

  const baseWindup =
    attackId === 'superSlam'
      ? 26
      : attackId === 'leapSlam' || attackId === 'telluricSlam' || attackId === 'shieldCharge'
        ? 22
        : attackId === 'shurikenFan' || attackId === 'dashSlash'
          ? 16
          : 20;

  boss.stateTicks = Math.max(14, Math.round(baseWindup / speedMult));
  boss.telegraphTicks = boss.stateTicks;
  boss.vel.x *= 0.15;

  state.events.push({
    type: 'enemyTelegraph',
    x: boss.pos.x,
    y: boss.pos.y - boss.height * 0.55 - 10,
    enemyUid: boss.uid,
  });
}

function getBossAttackDuration(attackId: string): number {
  switch (attackId) {
    case 'punch':
      return 12;
    case 'leapSlam':
      return 34;
    case 'shockwave':
      return 10;
    case 'roarAura':
      return 18;
    case 'shurikenFan':
      return 12;
    case 'hookPull':
      return 14;
    case 'dashSlash':
      return 16;
    case 'fallingSwords':
      return 24;
    case 'lanceCombo':
      return 30;
    case 'shieldCharge':
      return 24;
    case 'telluricSlam':
      return 26;
    case 'dropBanners':
      return 14;
    case 'addWave':
      return 28;
    case 'superSlam':
      return 42;
    default:
      return 14;
  }
}

function executeBehemothAttack(
  state: SimState,
  boss: EnemyState,
  isFirstTick: boolean,
  rng: RngAPI
): void {
  const player = state.player;
  const dx = player.pos.x - boss.pos.x;

  switch (boss.bossAttackId) {
    case 'punch': {
      if (isFirstTick) {
        boss.vel.x = boss.facing * 180;
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 66, 36, 1.05, true, rng, boss.facing * 200, -90);
      }
      break;
    }

    case 'leapSlam': {
      if (isFirstTick) {
        boss.vel.y = -355;
        boss.vel.x = Math.max(-260, Math.min(260, dx * 1.45));
      } else if (boss.grounded && boss.stateTicks < 28) {
        state.screenShake = Math.max(state.screenShake, 8);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y + boss.height * 0.4 },
          vel: { x: 0, y: 0 },
          size: 72,
          color: '#ff523b',
          alpha: 1,
          ttlTicks: 20,
          maxTtlTicks: 20,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
        if (!boss.hitPlayerThisSwing) {
          tryBossMeleeHit(state, boss, 74, 42, 1.25, false, rng, boss.facing * 210, -120);
        }
        boss.stateTicks = 0;
      }
      break;
    }

    case 'shockwave': {
      if (isFirstTick) {
        state.screenShake = Math.max(state.screenShake, 5);
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: boss.uid,
          kind: 'shockwave',
          pos: { x: boss.pos.x + boss.facing * 22, y: boss.pos.y + boss.height * 0.4 },
          prevPos: { x: boss.pos.x + boss.facing * 22, y: boss.pos.y + boss.height * 0.4 },
          vel: { x: boss.facing * 245, y: 0 },
          radius: 10,
          damage: boss.damage,
          isCrit: false,
          pierceLeft: 3,
          gravity: 0,
          ttlTicks: 70,
          maxTtlTicks: 70,
          color: '#ff4a3d',
          parriable: false,
          hitIds: [],
        });
      }
      break;
    }

    case 'roarAura': {
      if (isFirstTick) {
        boss.bossAuraTicks = 210;
        state.screenShake = Math.max(state.screenShake, 6);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y },
          vel: { x: 0, y: 0 },
          size: 84,
          color: '#ff2e4c',
          alpha: 1,
          ttlTicks: 24,
          maxTtlTicks: 24,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
      }
      break;
    }
  }
}

function executeTimeKeeperAttack(
  state: SimState,
  boss: EnemyState,
  isFirstTick: boolean,
  rng: RngAPI
): void {
  const player = state.player;
  const dx = player.pos.x - boss.pos.x;
  const dy = player.pos.y - boss.pos.y;
  const dist = Math.max(1, Math.hypot(dx, dy));

  switch (boss.bossAttackId) {
    case 'shurikenFan': {
      if (isFirstTick) {
        boss.vel.x = -boss.facing * 120;
        const count = boss.bossPhase >= 2 ? 5 : 3;
        for (let i = 0; i < count; i++) {
          const spread = (i - (count - 1) * 0.5) * 0.16;
          const baseAngle = Math.atan2(dy, dx);
          const ang = baseAngle + spread;
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shuriken',
            pos: { x: boss.pos.x + boss.facing * 12, y: boss.pos.y - 4 },
            prevPos: { x: boss.pos.x + boss.facing * 12, y: boss.pos.y - 4 },
            vel: { x: Math.cos(ang) * 340, y: Math.sin(ang) * 340 },
            radius: 5,
            damage: Math.round(boss.damage * 0.85),
            isCrit: false,
            pierceLeft: 0,
            gravity: 0,
            ttlTicks: 75,
            maxTtlTicks: 75,
            color: '#62f5e6',
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'hookPull': {
      if (isFirstTick) {
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: boss.uid,
          kind: 'hook',
          pos: { x: boss.pos.x + boss.facing * 14, y: boss.pos.y - 4 },
          prevPos: { x: boss.pos.x + boss.facing * 14, y: boss.pos.y - 4 },
          vel: { x: (dx / dist) * 410, y: (dy / dist) * 180 },
          radius: 6,
          damage: Math.round(boss.damage * 0.9),
          isCrit: false,
          pierceLeft: 0,
          gravity: 0,
          ttlTicks: 42,
          maxTtlTicks: 42,
          color: '#ffd166',
          parriable: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'dashSlash': {
      if (isFirstTick) {
        boss.vel.x = boss.facing * 425;
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 52, 34, 1.1, true, rng, boss.facing * 170, -70);
      }
      break;
    }

    case 'fallingSwords': {
      if (boss.stateTicks === 22 || boss.stateTicks === 14 || boss.stateTicks === 6) {
        const swordsPerVolley = boss.bossPhase >= 3 ? 3 : 2;
        for (let s = 0; s < swordsPerVolley; s++) {
          const targetX = player.pos.x + (s - (swordsPerVolley - 1) * 0.5) * 58 + rng.rangeFloat(-12, 12);
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'fallingSword',
            pos: { x: targetX, y: boss.pos.y - 175 },
            prevPos: { x: targetX, y: boss.pos.y - 175 },
            vel: { x: 0, y: 310 },
            radius: 7,
            damage: Math.round(boss.damage * 0.95),
            isCrit: false,
            pierceLeft: 0,
            gravity: 180,
            ttlTicks: 55,
            maxTtlTicks: 55,
            color: '#62f5e6',
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }
  }
}

function executeKingsHandAttack(
  state: SimState,
  boss: EnemyState,
  isFirstTick: boolean,
  rng: RngAPI
): void {
  const player = state.player;
  const arena = state.bossArenaState;

  switch (boss.bossAttackId) {
    case 'lanceCombo': {
      // Iconic 3-hit symmetrical lance combo
      if (boss.stateTicks === 29 || boss.stateTicks === 19 || boss.stateTicks === 9) {
        boss.hitPlayerThisSwing = false;
        boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
        boss.vel.x = boss.facing * 200;
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x + boss.facing * 32, y: boss.pos.y - 6 },
          vel: { x: boss.facing * 40, y: 0 },
          size: 46,
          color: '#64d2ff',
          alpha: 1,
          ttlTicks: 9,
          maxTtlTicks: 9,
          gravity: 0,
          emissive: true,
          kind: 'slash',
        });
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 74, 38, 1.05, true, rng, boss.facing * 180, -80);
      }
      break;
    }

    case 'shieldCharge': {
      // Charges aggressively to push player toward arena spike pits!
      boss.vel.x = boss.facing * 335;
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 56, 40, 1.0, true, rng, boss.facing * 360, -135);
      }
      break;
    }

    case 'telluricSlam': {
      if (isFirstTick) {
        boss.vel.y = -245;
      } else if (boss.grounded && boss.stateTicks < 20) {
        state.screenShake = Math.max(state.screenShake, 9);
        for (const dir of [-1, 1] as const) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shockwave',
            pos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            prevPos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            vel: { x: dir * 255, y: 0 },
            radius: 11,
            damage: Math.round(boss.damage * 1.1),
            isCrit: false,
            pierceLeft: 3,
            gravity: 0,
            ttlTicks: 78,
            maxTtlTicks: 78,
            color: '#64d2ff',
            parriable: false,
            hitIds: [],
          });
        }
        if (!boss.hitPlayerThisSwing) {
          tryBossMeleeHit(state, boss, 76, 40, 1.2, false, rng, boss.facing * 200, -110);
        }
        boss.stateTicks = 0;
      }
      break;
    }

    case 'dropBanners': {
      if (isFirstTick) {
        const count = boss.bossPhase >= 3 ? 3 : 2;
        const left = arena.lockedLeftX + 48;
        const right = Math.max(left + 96, arena.lockedRightX - 48);
        for (let b = 0; b < count; b++) {
          const bx = left + ((right - left) * (b + 1)) / (count + 1);
          state.turrets.push({
            uid: state.nextUid++,
            defId: 'BossBanner',
            pos: { x: bx, y: boss.pos.y + boss.height * 0.25 },
            hp: 95,
            maxHp: 95,
            damage: Math.round(boss.damage * 1.15),
            range: 66,
            fireCooldownTicks: 0,
            ttlTicks: 240,
            facing: 1,
            kind: 'bossBanner',
            owner: 'enemy',
          });
        }
        boss.bossBannerCooldown = 360;
      }
      break;
    }

    case 'addWave': {
      if (isFirstTick) {
        boss.bossShieldTicks = 150;
        const minions = ['Zombie', 'Archer', 'Runner'] as const;
        for (let m = 0; m < minions.length; m++) {
          const spawnX = boss.pos.x + (m - 1) * 72;
          spawnEnemy(state, minions[m], spawnX, boss.pos.y - 24, boss.roomId, rng, false);
        }
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y },
          vel: { x: 0, y: 0 },
          size: 96,
          color: '#ffd166',
          alpha: 1,
          ttlTicks: 24,
          maxTtlTicks: 24,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
      }
      break;
    }

    case 'superSlam': {
      if (isFirstTick) {
        const center = (arena.lockedLeftX + arena.lockedRightX) * 0.5;
        boss.vel.y = -410;
        boss.vel.x = (center - boss.pos.x) * 1.4;
      } else if (boss.stateTicks === 22) {
        boss.vel.x = 0;
        boss.vel.y = 440;
      } else if (boss.grounded && boss.stateTicks < 24) {
        state.screenShake = Math.max(state.screenShake, 12);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y + boss.height * 0.35 },
          vel: { x: 0, y: 0 },
          size: 120,
          color: '#ffd166',
          alpha: 1,
          ttlTicks: 28,
          maxTtlTicks: 28,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
        for (const dir of [-1, 1] as const) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shockwave',
            pos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            prevPos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            vel: { x: dir * 295, y: 0 },
            radius: 13,
            damage: Math.round(boss.damage * 1.3),
            isCrit: false,
            pierceLeft: 4,
            gravity: 0,
            ttlTicks: 85,
            maxTtlTicks: 85,
            color: '#ffd166',
            parriable: false,
            hitIds: [],
          });
        }
        if (!boss.hitPlayerThisSwing) {
          tryBossMeleeHit(state, boss, 118, 52, 1.35, false, rng, boss.facing * 260, -150);
        }
        boss.stateTicks = 0;
      }
      break;
    }
  }
}

export function stepBossAI(
  state: SimState,
  boss: EnemyState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  if (!boss.bossId || boss.state === 'dead' || boss.hp <= 0) return;
  const def = getBoss(boss.bossId);
  const player = state.player;

  if (boss.bossBannerCooldown > 0) boss.bossBannerCooldown -= 1;

  // Evaluate Phase Transitions (Phase 1 -> 2 -> 3)
  const hpRatio = boss.hp / Math.max(1, boss.maxHp);
  const desiredPhase = getTargetPhaseIndex(def, hpRatio) + 1;
  if (desiredPhase > boss.bossPhase) {
    boss.bossPhase = desiredPhase;
    state.screenShake = Math.max(state.screenShake, 9);
    state.events.push({
      type: 'bossPhaseShift',
      x: boss.pos.x,
      y: boss.pos.y,
      bossId: boss.bossId,
      phase: boss.bossPhase,
    });
    state.particlesSim.push({
      uid: state.nextUid++,
      pos: { x: boss.pos.x, y: boss.pos.y },
      vel: { x: 0, y: 0 },
      size: 105,
      color: '#ffd166',
      alpha: 1,
      ttlTicks: 26,
      maxTtlTicks: 26,
      gravity: 0,
      emissive: true,
      kind: 'ring',
    });

    if (boss.bossId === 'Behemoth') {
      // Phase transition roar shield + radial knockback!
      boss.bossShieldTicks = 75;
      boss.bossAuraTicks = 210;
      const pushDir = player.pos.x >= boss.pos.x ? 1 : -1;
      if (Math.hypot(player.pos.x - boss.pos.x, player.pos.y - boss.pos.y) <= 130) {
        player.vel.x = pushDir * 290;
        player.vel.y = -130;
      }
    } else if (boss.bossId === 'TimeKeeper') {
      boss.bossShieldTicks = 30;
      beginBossAttack(state, boss, 'fallingSwords', def.phases[boss.bossPhase - 1].speedMult);
    } else if (boss.bossId === 'KingsHand') {
      if (boss.bossPhase === 2) {
        beginBossAttack(state, boss, 'addWave', def.phases[1].speedMult);
      } else {
        beginBossAttack(state, boss, 'superSlam', def.phases[2].speedMult);
      }
    }
  }

  // Behemoth Crimson Laceration Damage Aura
  if (boss.bossId === 'Behemoth' && boss.bossAuraTicks > 0 && state.tick % 18 === 0) {
    if (Math.hypot(player.pos.x - boss.pos.x, player.pos.y - boss.pos.y) <= 60) {
      damagePlayer(state, Math.max(8, Math.round(boss.damage * 0.55)), 'Crimson Aura', rng);
    }
  }

  const phaseDef = def.phases[Math.min(def.phases.length - 1, Math.max(0, boss.bossPhase - 1))];
  const slowMult =
    hasStatus(boss.statusEffects, 'slow') || hasStatus(boss.statusEffects, 'frost') ? 0.65 : 1.0;
  const speedMult = phaseDef.speedMult * slowMult;

  if (boss.stunTicks > 0) {
    boss.stunTicks -= 1;
    boss.vel.x *= 0.8;
  } else if (hasStatus(boss.statusEffects, 'freeze')) {
    boss.vel.x *= 0.8;
  } else {
    const dx = player.pos.x - boss.pos.x;
    const dist = Math.abs(dx);

    if (boss.state === 'chase' || boss.state === 'idle' || boss.state === 'patrol') {
      boss.facing = dx >= 0 ? 1 : -1;
      const moveSpeed =
        (boss.bossId === 'TimeKeeper' ? 128 : boss.bossId === 'KingsHand' ? 88 : 78) * speedMult;
      if (hasStatus(boss.statusEffects, 'root')) {
        boss.vel.x = 0;
      } else if (dist > 54) {
        boss.vel.x = boss.facing * moveSpeed;
      } else {
        boss.vel.x *= 0.7;
      }

      if (boss.attackCooldownTicks <= 0 && player.actionState !== 'dead') {
        let pool = phaseDef.attacks.filter((a) => a !== 'addWave');
        if (boss.bossId === 'KingsHand' && boss.bossBannerCooldown > 0) {
          pool = pool.filter((a) => a !== 'dropBanners');
        }
        if (boss.bossId === 'Behemoth' && dist < 72 && rng.chance(0.55)) {
          beginBossAttack(state, boss, 'punch', speedMult);
        } else {
          const chosen = pool.length > 0 ? rng.pick(pool) : phaseDef.attacks[0];
          beginBossAttack(state, boss, chosen, speedMult);
        }
      }
    } else if (boss.state === 'windup') {
      boss.vel.x *= 0.75;
      boss.stateTicks -= 1;
      if (boss.telegraphTicks > 0) boss.telegraphTicks -= 1;
      if (boss.stateTicks <= 0) {
        boss.state = 'attack';
        boss.stateTicks = getBossAttackDuration(boss.bossAttackId);
        boss.telegraphTicks = 0;
        if (boss.bossId === 'Behemoth') executeBehemothAttack(state, boss, true, rng);
        else if (boss.bossId === 'TimeKeeper') executeTimeKeeperAttack(state, boss, true, rng);
        else executeKingsHandAttack(state, boss, true, rng);
      }
    } else if (boss.state === 'attack') {
      boss.stateTicks -= 1;
      if (boss.bossId === 'Behemoth') executeBehemothAttack(state, boss, false, rng);
      else if (boss.bossId === 'TimeKeeper') executeTimeKeeperAttack(state, boss, false, rng);
      else executeKingsHandAttack(state, boss, false, rng);

      if (boss.stateTicks <= 0) {
        boss.state = 'recover';
        boss.stateTicks = Math.max(14, Math.round(28 / speedMult));
      }
    } else if (boss.state === 'recover') {
      boss.vel.x *= 0.78;
      boss.stateTicks -= 1;
      if (boss.stateTicks <= 0) {
        boss.state = 'chase';
        boss.attackCooldownTicks = Math.max(18, Math.round(36 / speedMult));
      }
    }
  }

  // Gravity & Swept Collision
  boss.vel.y = Math.min(500, boss.vel.y + 980 * FIXED_DT);
  const res = col.sweepAabb(
    state.tileGrid,
    boss.pos.x - boss.width * 0.5,
    boss.pos.y - boss.height * 0.5,
    boss.width,
    boss.height,
    boss.vel.x,
    boss.vel.y,
    FIXED_DT,
    false,
    false
  );

  boss.pos.x = res.x + boss.width * 0.5;
  boss.pos.y = res.y + boss.height * 0.5;
  boss.vel.x = res.vx;
  boss.vel.y = res.vy;
  boss.grounded = res.hitFloor;

  // Keep boss cleanly inside arena bounds
  const arena = state.bossArenaState;
  if (arena.active && arena.lockedRightX > arena.lockedLeftX) {
    const minX = arena.lockedLeftX + boss.width * 0.5;
    const maxX = arena.lockedRightX - boss.width * 0.5;
    if (boss.pos.x < minX) {
      boss.pos.x = minX;
      boss.vel.x = 0;
    } else if (boss.pos.x > maxX) {
      boss.pos.x = maxX;
      boss.vel.x = 0;
    }
  }
}
