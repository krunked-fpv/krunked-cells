import {
  FIXED_DT,
  TILE_SIZE,
  TileKind,
  type BossDef,
  type BossId,
  type CollisionAPI,
  type EnemyState,
  type RngAPI,
  type SimState,
} from '../contracts';
import { getBoss, getDifficulty } from '../data';
import { attemptShieldParry, damagePlayer, damagePlayerTurretsInArea } from './combat';
import { spawnEnemy } from './enemies';
import { clearNegativeStatuses, hasStatus } from './status';

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
    stuckArrows: [],
    ccResistStacks: 0,
    ccResistResetTicks: 0,
    bossFloatingSummon: false,
    bossSubPhaseCount: 0,
    telegraphUnparriable: false,
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
    engaged: true,
    playerTookHit: false,
    icePlatformTimers: def.id === 'KingsHand' ? [0, 0] : undefined,
  };

  return boss;
}

function getTargetPhaseIndex(def: BossDef, hpRatio: number): number {
  let phaseIdx = 0;
  for (let i = 0; i < def.phases.length; i++) {
    if (hpRatio <= def.phases[i]!.hpThreshold) {
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
  knockY = 0,
  bidirectional = false,
  unrollable = false
): boolean {
  const player = state.player;
  const dmg = Math.max(1, Math.round(boss.damage * dmgMult));

  damagePlayerTurretsInArea(
    state,
    boss.pos.x + (bidirectional ? 0 : boss.facing * rangeX * 0.45),
    boss.pos.y,
    bidirectional ? rangeX * 2 : rangeX,
    rangeY * 2,
    dmg
  );

  const dx = player.pos.x - boss.pos.x;
  const dy = player.pos.y - boss.pos.y;
  const inX = bidirectional
    ? Math.abs(dx) <= rangeX
    : Math.abs(dx) <= rangeX && (dx * boss.facing >= -18 || rangeX >= 70);
  const inY = Math.abs(dy) <= rangeY;
  if (!inX || !inY) return false;

  if (parriable && attemptShieldParry(state, dmg, boss, null, rng)) {
    boss.hitPlayerThisSwing = true;
    return true;
  }

  if (
    damagePlayer(state, dmg, boss.name, rng, false, {
      attackerX: boss.pos.x,
      attacker: boss,
      unblockable: !parriable && unrollable,
      unrollable,
    })
  ) {
    boss.hitPlayerThisSwing = true;
    if (knockX !== 0) player.vel.x = knockX;
    if (knockY !== 0) player.vel.y = knockY;
    return true;
  }
  return false;
}

function isUnparriableBossAttack(attackId: string): boolean {
  return (
    attackId === 'leapSlam' ||
    attackId === 'shockwave' ||
    attackId === 'roarAura' ||
    attackId === 'telluricSlam' ||
    attackId === 'superSlam' ||
    attackId === 'dropBanners' ||
    attackId === 'addWave'
  );
}

function beginBossAttack(
  state: SimState,
  boss: EnemyState,
  attackId: string,
  speedMult: number
): void {
  const player = state.player;
  if (!hasStatus(boss.statusEffects, 'root')) {
    boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
  }
  boss.bossAttackId = attackId;
  boss.hitPlayerThisSwing = false;
  boss.state = 'windup';
  boss.telegraphUnparriable = isUnparriableBossAttack(attackId);

  const baseWindup =
    attackId === 'superSlam'
      ? 26
      : attackId === 'roarAura'
        ? 30
        : attackId === 'punch' || attackId === 'leapSlam'
          ? 24
          : attackId === 'telluricSlam' || attackId === 'shieldCharge' || attackId === 'bombFlurry'
            ? 22
            : attackId === 'swordCombo' || attackId === 'shurikenFan' || attackId === 'dashSlash'
              ? 15
              : attackId === 'shurikenBurst'
                ? 14
                : 20;

  boss.stateTicks = Math.max(12, Math.round(baseWindup / speedMult));
  boss.telegraphTicks = boss.stateTicks;
  boss.vel.x *= 0.15;

  state.events.push({
    type: 'enemyTelegraph',
    x: boss.pos.x,
    y: boss.pos.y - boss.height * 0.55 - 10,
    enemyUid: boss.uid,
    unparriable: boss.telegraphUnparriable,
  });
}

function getBossAttackDuration(boss: EnemyState, attackId: string): number {
  switch (attackId) {
    case 'punch':
      return 12;
    case 'leapSlam':
      return 36;
    case 'shockwave':
      return 12;
    case 'roarAura':
      return 16;
    case 'swordCombo':
      return boss.bossPhase >= 3 ? 28 : boss.bossPhase === 2 ? 20 : 12;
    case 'shurikenBurst':
      return 12;
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
    case 'jabTelluric':
      return 24;
    case 'bombFlurry':
      return 36;
    case 'shieldCharge':
      return 24;
    case 'telluricSlam':
      return 26;
    case 'dropBanners':
      return 14;
    case 'addWave':
      return 1080; // 18s safety timer while floating invulnerable until Elite dies!
    case 'superSlam':
      return 58; // 40t hover charge + slam!
    default:
      return 14;
  }
}

function emitConciergeShoutAndAura(state: SimState, boss: EnemyState): void {
  const player = state.player;
  boss.bossShieldTicks = 150; // 2.5s invulnerability
  boss.bossAuraTicks = 270; // 4.5s Lacerating Aura
  clearNegativeStatuses(boss.statusEffects);
  state.screenShake = Math.max(state.screenShake, 7);

  state.particlesSim.push({
    uid: state.nextUid++,
    pos: { x: boss.pos.x, y: boss.pos.y },
    vel: { x: 0, y: 0 },
    size: 125,
    color: '#ff2e4c',
    alpha: 1,
    ttlTicks: 24,
    maxTtlTicks: 24,
    gravity: 0,
    emissive: true,
    kind: 'ring',
  });

  // Unblockable/unrollable Shout Stun wave (r = 125px) forces spacing!
  const dist = Math.hypot(player.pos.x - boss.pos.x, player.pos.y - boss.pos.y);
  if (dist <= 125 && player.actionState !== 'dead') {
    const pushDir = player.pos.x >= boss.pos.x ? 1 : -1;
    player.vel.x = pushDir * 240;
    player.vel.y = -110;
    player.fallStunTicks = Math.max(player.fallStunTicks ?? 0, 30);
    state.particlesSim.push({
      uid: state.nextUid++,
      pos: { x: player.pos.x, y: player.pos.y - 22 },
      vel: { x: 0, y: -28 },
      size: 10,
      color: '#ffe852',
      alpha: 1,
      ttlTicks: 30,
      maxTtlTicks: 30,
      gravity: 0,
      emissive: true,
      kind: 'text',
      text: 'STUNNED!',
    });
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
        boss.vel.x = boss.facing * 185;
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 66, 36, 1.05, true, rng, boss.facing * 200, -90);
      }
      break;
    }

    case 'leapSlam': {
      if (isFirstTick) {
        boss.vel.y = -370;
        boss.vel.x = Math.max(-270, Math.min(270, dx * 1.45));
      } else if (boss.grounded && boss.stateTicks < 30) {
        state.screenShake = Math.max(state.screenShake, 8);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y + boss.height * 0.4 },
          vel: { x: 0, y: 0 },
          size: 76,
          color: '#ff523b',
          alpha: 1,
          ttlTicks: 20,
          maxTtlTicks: 20,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
        if (!boss.hitPlayerThisSwing) {
          tryBossMeleeHit(state, boss, 74, 42, 1.25, false, rng, boss.facing * 210, -120, true);
        }
        boss.stateTicks = 0;
      }
      break;
    }

    case 'shockwave': {
      // Unrollable & unparriable Fire Strike (bilateral in P2+!)
      if (isFirstTick) {
        state.screenShake = Math.max(state.screenShake, 5);
        const dirs: readonly (-1 | 1)[] = boss.bossPhase >= 2 ? [-1, 1] : [boss.facing];
        for (let i = 0; i < dirs.length; i++) {
          const dir = dirs[i]!;
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shockwave',
            pos: { x: boss.pos.x + dir * 22, y: boss.pos.y + boss.height * 0.38 },
            prevPos: { x: boss.pos.x + dir * 22, y: boss.pos.y + boss.height * 0.38 },
            vel: { x: dir * 245, y: 0 },
            radius: 12,
            damage: boss.damage,
            isCrit: false,
            pierceLeft: 3,
            gravity: 0,
            ttlTicks: 75,
            maxTtlTicks: 75,
            color: '#ff4a3d',
            applyStatus: 'burn',
            parriable: false,
            unrollable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'roarAura': {
      if (isFirstTick) {
        emitConciergeShoutAndAura(state, boss);
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
  const arena = state.bossArenaState;
  const dx = player.pos.x - boss.pos.x;
  const dy = player.pos.y - boss.pos.y;
  const dist = Math.max(1, Math.hypot(dx, dy));

  switch (boss.bossAttackId) {
    case 'swordCombo': {
      // 1-hit (P1), 2-hit (P2), 3-hit (P3) rapid parriable sword combo!
      const isBeat =
        boss.bossPhase >= 3
          ? boss.stateTicks === 27 || boss.stateTicks === 18 || boss.stateTicks === 9
          : boss.bossPhase === 2
            ? boss.stateTicks === 19 || boss.stateTicks === 10
            : boss.stateTicks === 11;

      if (isBeat) {
        boss.hitPlayerThisSwing = false;
        if (!hasStatus(boss.statusEffects, 'root')) {
          boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
        }
        boss.vel.x = boss.facing * 230;
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x + boss.facing * 22, y: boss.pos.y - 4 },
          vel: { x: boss.facing * 45, y: 0 },
          size: 36,
          color: '#62f5e6',
          alpha: 1,
          ttlTicks: 8,
          maxTtlTicks: 8,
          gravity: 0,
          emissive: true,
          kind: 'slash',
        });
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 54, 34, 1.0, true, rng, boss.facing * 150, -55);
      }
      break;
    }

    case 'shurikenBurst': {
      // 70% HP Phase 2 transition: teleport to center + 360° ring of 12 parriable shurikens!
      if (isFirstTick) {
        const fromX = boss.pos.x;
        const fromY = boss.pos.y;
        const centerX =
          arena.active && arena.lockedRightX > arena.lockedLeftX
            ? (arena.lockedLeftX + arena.lockedRightX) * 0.5
            : boss.pos.x;
        boss.pos.x = centerX;
        boss.prevPos.x = centerX;
        state.events.push({
          type: 'teleport',
          fromX,
          fromY,
          toX: boss.pos.x,
          toY: boss.pos.y,
        });
        const count = 12;
        for (let i = 0; i < count; i++) {
          const ang = (i / count) * Math.PI * 2;
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shuriken',
            pos: { x: boss.pos.x, y: boss.pos.y - 4 },
            prevPos: { x: boss.pos.x, y: boss.pos.y - 4 },
            vel: { x: Math.cos(ang) * 320, y: Math.sin(ang) * 320 },
            radius: 5,
            damage: Math.round(boss.damage * 0.85),
            isCrit: false,
            pierceLeft: 0,
            gravity: 0,
            ttlTicks: 80,
            maxTtlTicks: 80,
            color: '#62f5e6',
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'shurikenFan': {
      if (isFirstTick) {
        // Micro-teleport away from player before throwing 1 / 3 / 5 shurikens!
        if (!hasStatus(boss.statusEffects, 'root') && arena.lockedRightX > arena.lockedLeftX) {
          const fromX = boss.pos.x;
          const fromY = boss.pos.y;
          const awayDir = player.pos.x >= boss.pos.x ? -1 : 1;
          const targetX = Math.max(
            arena.lockedLeftX + 42,
            Math.min(arena.lockedRightX - 42, boss.pos.x + awayDir * 115)
          );
          boss.pos.x = targetX;
          boss.prevPos.x = targetX;
          boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
          state.events.push({
            type: 'teleport',
            fromX,
            fromY,
            toX: boss.pos.x,
            toY: boss.pos.y,
          });
        }

        const nDx = player.pos.x - boss.pos.x;
        const nDy = player.pos.y - boss.pos.y;
        const count = boss.bossPhase >= 3 ? 5 : boss.bossPhase === 2 ? 3 : 1;
        const baseAngle = Math.atan2(nDy, nDx);
        for (let i = 0; i < count; i++) {
          const spread = (i - (count - 1) * 0.5) * 0.14;
          const ang = baseAngle + spread;
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shuriken',
            pos: { x: boss.pos.x + boss.facing * 12, y: boss.pos.y - 4 },
            prevPos: { x: boss.pos.x + boss.facing * 12, y: boss.pos.y - 4 },
            vel: { x: Math.cos(ang) * 355, y: Math.sin(ang) * 355 },
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
          vel: { x: (dx / dist) * 425, y: (dy / dist) * 185 },
          radius: 6,
          damage: Math.round(boss.damage * 0.85),
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
      // Lightspeed Dash at 560 px/s! Phase 3 chains 2-3x dashes!
      if (isFirstTick) {
        boss.vel.x = boss.facing * 560;
      }
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 54, 34, 1.1, true, rng, boss.facing * 180, -70);
      }
      break;
    }

    case 'fallingSwords': {
      if (boss.stateTicks === 22 || boss.stateTicks === 14 || boss.stateTicks === 6) {
        const swordsPerVolley = boss.bossPhase >= 3 ? 3 : 2;
        for (let s = 0; s < swordsPerVolley; s++) {
          const targetX =
            player.pos.x + (s - (swordsPerVolley - 1) * 0.5) * 58 + rng.rangeFloat(-12, 12);
          spawnSkySword(state, boss, targetX);
        }
      }
      break;
    }
  }
}

function spawnSkySword(state: SimState, boss: EnemyState, targetX: number): void {
  const arena = state.bossArenaState;
  const clampedX =
    arena.active && arena.lockedRightX > arena.lockedLeftX
      ? Math.max(arena.lockedLeftX + 18, Math.min(arena.lockedRightX - 18, targetX))
      : targetX;
  const spawnY = Math.max(TILE_SIZE * 2 + 8, boss.pos.y - 175);

  // Ceiling telegraph glow warning particle
  state.particlesSim.push({
    uid: state.nextUid++,
    pos: { x: clampedX, y: spawnY + 14 },
    vel: { x: 0, y: 0 },
    size: 22,
    color: '#62f5e6',
    alpha: 0.95,
    ttlTicks: 18,
    maxTtlTicks: 18,
    gravity: 0,
    emissive: true,
    kind: 'ring',
  });

  state.projectiles.push({
    uid: state.nextUid++,
    owner: 'enemy',
    ownerUid: boss.uid,
    kind: 'fallingSword',
    pos: { x: clampedX, y: spawnY },
    prevPos: { x: clampedX, y: spawnY },
    vel: { x: 0, y: 315 },
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

function executeKingsHandAttack(
  state: SimState,
  boss: EnemyState,
  isFirstTick: boolean,
  rng: RngAPI
): void {
  const player = state.player;
  const arena = state.bossArenaState;
  const floorY = 14 * TILE_SIZE;

  switch (boss.bossAttackId) {
    case 'lanceCombo': {
      // Iconic Symmetrical 3-Hit Lance Combo:
      // Hit 1 (t=29): forward upward sweep
      // Hit 2 (t=19): SYMMETRICAL SPIN hitting BOTH front AND behind (|dx| <= 78)!
      // Hit 3 (t=9): heavy forward smash
      if (boss.stateTicks === 29 || boss.stateTicks === 19 || boss.stateTicks === 9) {
        boss.hitPlayerThisSwing = false;
        if (boss.stateTicks !== 19 && !hasStatus(boss.statusEffects, 'root')) {
          boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
        }
        boss.vel.x = boss.stateTicks === 19 ? 0 : boss.facing * 210;

        if (boss.stateTicks === 19) {
          // Dual front & back slash arcs!
          for (const dir of [-1, 1] as const) {
            state.particlesSim.push({
              uid: state.nextUid++,
              pos: { x: boss.pos.x + dir * 36, y: boss.pos.y - 6 },
              vel: { x: dir * 55, y: 0 },
              size: 52,
              color: '#ffe066',
              alpha: 1,
              ttlTicks: 10,
              maxTtlTicks: 10,
              gravity: 0,
              emissive: true,
              kind: 'slash',
            });
          }
        } else {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: boss.pos.x + boss.facing * 34, y: boss.pos.y - 6 },
            vel: { x: boss.facing * 45, y: 0 },
            size: 48,
            color: '#64d2ff',
            alpha: 1,
            ttlTicks: 9,
            maxTtlTicks: 9,
            gravity: 0,
            emissive: true,
            kind: 'slash',
          });
        }
      }
      if (!boss.hitPlayerThisSwing) {
        const isSpinHit2 = boss.stateTicks <= 19 && boss.stateTicks > 9;
        const isSmashHit3 = boss.stateTicks <= 9;
        tryBossMeleeHit(
          state,
          boss,
          isSpinHit2 ? 78 : 74,
          40,
          isSmashHit3 ? 1.2 : 1.05,
          true,
          rng,
          (player.pos.x >= boss.pos.x ? 1 : -1) * (isSmashHit3 ? 260 : 185),
          isSmashHit3 ? -115 : -80,
          isSpinHit2
        );
      }
      break;
    }

    case 'jabTelluric': {
      // Quick lance jab immediately chained into localized Telluric Shock!
      if (boss.stateTicks === 23) {
        boss.hitPlayerThisSwing = false;
        boss.vel.x = boss.facing * 175;
      } else if (boss.stateTicks === 11) {
        boss.hitPlayerThisSwing = false;
        state.screenShake = Math.max(state.screenShake, 7);
        for (const dir of [-1, 1] as const) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shockwave',
            pos: { x: boss.pos.x + dir * 20, y: boss.pos.y + boss.height * 0.42 },
            prevPos: { x: boss.pos.x + dir * 20, y: boss.pos.y + boss.height * 0.42 },
            vel: { x: dir * 235, y: 0 },
            radius: 10,
            damage: Math.round(boss.damage * 1.0),
            isCrit: false,
            pierceLeft: 2,
            gravity: 0,
            ttlTicks: 38,
            maxTtlTicks: 38,
            color: '#64d2ff',
            parriable: false,
            unrollable: true,
            hitIds: [],
          });
        }
      }
      if (!boss.hitPlayerThisSwing) {
        const isSlam = boss.stateTicks <= 11;
        tryBossMeleeHit(
          state,
          boss,
          isSlam ? 74 : 66,
          38,
          isSlam ? 1.1 : 0.95,
          !isSlam,
          rng,
          boss.facing * 185,
          -90,
          isSlam
        );
      }
      break;
    }

    case 'bombFlurry': {
      // 6-Bomb Flurry: 3 pairs of short-fuse bouncing parriable bombs over 36 ticks!
      if (boss.stateTicks === 35 || boss.stateTicks === 23 || boss.stateTicks === 11) {
        const dx = player.pos.x - boss.pos.x;
        for (let pair = 0; pair < 2; pair++) {
          const offset = pair === 0 ? -38 : 38;
          const vx = Math.max(-240, Math.min(240, (dx + offset) * 1.35 + rng.rangeFloat(-15, 15)));
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'grenade',
            pos: { x: boss.pos.x + boss.facing * 14, y: boss.pos.y - 12 },
            prevPos: { x: boss.pos.x + boss.facing * 14, y: boss.pos.y - 12 },
            vel: { x: vx, y: -235 - pair * 28 },
            radius: 5.5,
            damage: Math.round(boss.damage * 0.9),
            isCrit: false,
            pierceLeft: 0,
            gravity: 580,
            ttlTicks: 115,
            maxTtlTicks: 115,
            color: '#ff9642',
            explosionRadius: 48,
            parriable: true,
            bouncesLeft: 1,
            floorFuseTicks: 28,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'shieldCharge': {
      // Frontal-blocking Shield Charge shoving player toward spike pits (P3 chains 2x!)
      boss.vel.x = boss.facing * 420;
      if (!boss.hitPlayerThisSwing) {
        tryBossMeleeHit(state, boss, 58, 42, 1.05, true, rng, boss.facing * 420, -140);
      }
      break;
    }

    case 'telluricSlam': {
      if (isFirstTick) {
        boss.vel.y = -255;
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
            vel: { x: dir * 265, y: 0 },
            radius: 11,
            damage: Math.round(boss.damage * 1.1),
            isCrit: false,
            pierceLeft: 3,
            gravity: 0,
            ttlTicks: 78,
            maxTtlTicks: 78,
            color: '#64d2ff',
            parriable: false,
            unrollable: true,
            hitIds: [],
          });
        }
        if (!boss.hitPlayerThisSwing) {
          tryBossMeleeHit(state, boss, 76, 40, 1.2, false, rng, boss.facing * 200, -110, true);
        }
        boss.stateTicks = 0;
      }
      break;
    }

    case 'dropBanners': {
      // Always drops 3 Explosive Banners evenly spaced across the Throne Room (45 HP, 6s fuse, r=88px!)
      if (isFirstTick) {
        const count = 3;
        const left = arena.lockedLeftX + 56;
        const right = Math.max(left + 120, arena.lockedRightX - 56);
        for (let b = 0; b < count; b++) {
          const bx = left + ((right - left) * (b + 1)) / (count + 1);
          state.turrets.push({
            uid: state.nextUid++,
            defId: 'BossBanner',
            pos: { x: bx, y: boss.pos.y + boss.height * 0.25 },
            hp: 45,
            maxHp: 45,
            damage: Math.round(boss.damage * 1.2),
            range: 88,
            fireCooldownTicks: 0,
            ttlTicks: 360,
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
      // Floating Invulnerable Add-Summon Intermission (85% & 40% HP) until Elite dies or 18s safety timer!
      const floatY = floorY - 120;
      if (isFirstTick) {
        boss.bossFloatingSummon = true;
        boss.bossShieldTicks = 1080;
        boss.vel.x = 0;
        boss.vel.y = 0;
        boss.pos.y = floatY;
        boss.prevPos.y = floatY;

        const centerX =
          arena.lockedRightX > arena.lockedLeftX
            ? (arena.lockedLeftX + arena.lockedRightX) * 0.5
            : boss.pos.x;
        const regulars = boss.bossPhase >= 3 ? (['Runner', 'Comboter'] as const) : (['Zombie', 'Archer'] as const);
        const eliteId = boss.bossPhase >= 3 ? 'CastleKnight' : 'Runner';
        spawnEnemy(state, regulars[0], centerX - 88, floorY - 26, boss.roomId, rng, false, true);
        spawnEnemy(state, regulars[1], centerX + 88, floorY - 26, boss.roomId, rng, false, true);
        spawnEnemy(state, eliteId, centerX, floorY - 30, boss.roomId, rng, true, true);

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
      } else {
        // Hover smoothly at floatY while summoned Elite is alive
        boss.vel.x = 0;
        boss.vel.y = (floatY - boss.pos.y) * 5;
        boss.bossShieldTicks = Math.max(boss.bossShieldTicks, 10);

        const eliteAlive = state.enemies.some(
          (e) => !e.isBoss && e.isElite && e.state !== 'dead' && e.hp > 0
        );
        if (!eliteAlive || boss.stateTicks <= 1) {
          boss.bossFloatingSummon = false;
          boss.bossShieldTicks = 0;
          boss.vel.y = 380;
          boss.stateTicks = 0;
          state.screenShake = Math.max(state.screenShake, 8);
        }
      }
      break;
    }

    case 'superSlam': {
      // Whole-Arena Unrollable Super Telluric Slam: 40t hover charge + full-floor shockwave!
      const center =
        arena.lockedRightX > arena.lockedLeftX
          ? (arena.lockedLeftX + arena.lockedRightX) * 0.5
          : boss.pos.x;
      const hoverY = floorY - 125;

      if (isFirstTick) {
        boss.vel.y = -340;
        boss.vel.x = (center - boss.pos.x) * 1.4;
      } else if (boss.stateTicks > 18) {
        // Hover charging for 40 ticks with blinding golden full-floor warning telegraph!
        boss.vel.x = (center - boss.pos.x) * 2.5;
        boss.vel.y = (hoverY - boss.pos.y) * 4;
        if (boss.stateTicks % 5 === 0) {
          const warnX =
            arena.lockedLeftX +
            rng.rangeFloat(24, Math.max(48, arena.lockedRightX - arena.lockedLeftX - 24));
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: warnX, y: floorY - 6 },
            vel: { x: 0, y: -45 },
            size: 6,
            color: '#ffd166',
            alpha: 1,
            ttlTicks: 14,
            maxTtlTicks: 14,
            gravity: 0,
            emissive: true,
            kind: 'spark',
          });
        }
      } else if (boss.stateTicks === 18) {
        boss.vel.x = 0;
        boss.vel.y = 520;
      } else if (boss.grounded && boss.stateTicks < 18) {
        state.screenShake = Math.max(state.screenShake, 12);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: boss.pos.x, y: boss.pos.y + boss.height * 0.35 },
          vel: { x: 0, y: 0 },
          size: 160,
          color: '#ffd166',
          alpha: 1,
          ttlTicks: 28,
          maxTtlTicks: 28,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });

        // Full-arena unrollable ground shockwave: forces jumping onto Ice Platforms or mid-air stall!
        const playerBottomY = player.pos.y + player.height * 0.5;
        if (playerBottomY >= floorY - 30 && !boss.hitPlayerThisSwing) {
          if (
            damagePlayer(state, Math.round(boss.damage * 1.35), 'Super Telluric Slam', rng, false, {
              attackerX: boss.pos.x,
              attacker: boss,
              unblockable: true,
              unrollable: true,
            })
          ) {
            boss.hitPlayerThisSwing = true;
            player.vel.y = -175;
          }
        }

        for (const dir of [-1, 1] as const) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: boss.uid,
            kind: 'shockwave',
            pos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            prevPos: { x: boss.pos.x + dir * 24, y: boss.pos.y + boss.height * 0.42 },
            vel: { x: dir * 310, y: 0 },
            radius: 14,
            damage: Math.round(boss.damage * 1.3),
            isCrit: false,
            pierceLeft: 4,
            gravity: 0,
            ttlTicks: 85,
            maxTtlTicks: 85,
            color: '#ffd166',
            parriable: false,
            unrollable: true,
            hitIds: [],
          });
        }
        boss.stateTicks = 0;
      }
      break;
    }
  }
}

function stepThroneIcePlatforms(state: SimState, col: CollisionAPI): void {
  const arena = state.bossArenaState;
  if (!arena.active || state.activeBiomeId !== 'Throne') return;
  if (!arena.icePlatformTimers) {
    arena.icePlatformTimers = [0, 0];
  }

  const platTy = 10;
  const platY = platTy * TILE_SIZE;
  const player = state.player;
  const playerFootY = player.pos.y + player.height * 0.5;
  const onIceRow =
    player.grounded && player.onOneWay && Math.abs(playerFootY - platY) <= 4;
  const playerTx = Math.floor(player.pos.x / TILE_SIZE);

  const zones: readonly { idx: 0 | 1; clearMin: number; clearMax: number; regenMin: number; regenMax: number }[] = [
    { idx: 0, clearMin: 5, clearMax: 14, regenMin: 6, regenMax: 10 },
    { idx: 1, clearMin: 26, clearMax: 38, regenMin: 33, regenMax: 37 },
  ];

  for (let z = 0; z < zones.length; z++) {
    const zone = zones[z]!;
    let timer = arena.icePlatformTimers[zone.idx];

    if (timer < 0) {
      // Shattered: counting 300 ticks until regeneration
      timer += 1;
      if (timer >= 0) {
        timer = 0;
        for (let tx = zone.regenMin; tx <= zone.regenMax; tx++) {
          col.setTile(state.tileGrid, tx, platTy, TileKind.ONE_WAY);
        }
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: ((zone.regenMin + zone.regenMax + 1) * 0.5) * TILE_SIZE, y: platY },
          vel: { x: 0, y: 0 },
          size: 48,
          color: '#7ce8ff',
          alpha: 0.85,
          ttlTicks: 18,
          maxTtlTicks: 18,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
      }
    } else {
      const playerOnZone =
        onIceRow && playerTx >= zone.clearMin && playerTx <= zone.clearMax;
      if (playerOnZone || timer > 0) {
        timer += 1;
        // Subtle shimmer particles as platform cracks
        if (timer % 18 === 0) {
          const cx = ((zone.regenMin + zone.regenMax + 1) * 0.5) * TILE_SIZE;
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: cx, y: platY + 2 },
            vel: { x: 0, y: 24 },
            size: 3,
            color: '#9eeeff',
            alpha: 0.9,
            ttlTicks: 14,
            maxTtlTicks: 14,
            gravity: 160,
            emissive: true,
            kind: 'ice',
          });
        }
        if (timer >= 180) {
          // Shatter platform after 3s! Regen 5s (300t) later!
          for (let tx = zone.clearMin; tx <= zone.clearMax; tx++) {
            if (col.getTile(state.tileGrid, tx, platTy) === TileKind.ONE_WAY) {
              col.setTile(state.tileGrid, tx, platTy, TileKind.EMPTY);
            }
          }
          const cx = ((zone.regenMin + zone.regenMax + 1) * 0.5) * TILE_SIZE;
          state.events.push({ type: 'freezeShatter', x: cx, y: platY });
          timer = -300;
        }
      }
    }

    arena.icePlatformTimers[zone.idx] = timer;
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
  const arena = state.bossArenaState;

  // Tick Throne Room temporary Ice Platforms
  if (boss.bossId === 'KingsHand') {
    stepThroneIcePlatforms(state, col);
  }

  // Intro Engagement Gate: if worldgen set engaged === false, hold boss poised until player crosses intro line or hits boss!
  if (arena.engaged === false) {
    boss.facing = player.pos.x >= boss.pos.x ? 1 : -1;
    if (player.pos.x >= 14 * TILE_SIZE || boss.hp < boss.maxHp) {
      arena.engaged = true;
      arena.bannerTicks = 150;
      state.events.push({ type: 'bossEngage', bossId: boss.bossId });
      boss.state = 'chase';
      if (boss.bossId === 'Behemoth' && state.bossStemCells >= 1) {
        beginBossAttack(state, boss, 'roarAura', 1.0);
      }
    } else {
      boss.state = 'idle';
      boss.vel.x = 0;
      boss.vel.y = Math.min(500, boss.vel.y + 980 * FIXED_DT);
      const res = col.sweepAabb(
        state.tileGrid,
        boss.pos.x - boss.width * 0.5,
        boss.pos.y - boss.height * 0.5,
        boss.width,
        boss.height,
        0,
        boss.vel.y,
        FIXED_DT,
        false,
        false
      );
      boss.pos.x = res.x + boss.width * 0.5;
      boss.pos.y = res.y + boss.height * 0.5;
      boss.vel.y = res.vy;
      boss.grounded = res.hitFloor;
      return;
    }
  }

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
      // Phase transition: Shout Stun Wave + 150t invulnerable shield + 270t Lacerating Aura!
      emitConciergeShoutAndAura(state, boss);
    } else if (boss.bossId === 'TimeKeeper') {
      boss.bossShieldTicks = 30;
      if (boss.bossPhase === 2) {
        // 70% HP: 360° Shuriken Shield burst!
        beginBossAttack(state, boss, 'shurikenBurst', def.phases[1]!.speedMult);
      } else {
        // 50% HP: Temporal Collapse — persistent Sword Rain + immediate volley!
        beginBossAttack(state, boss, 'fallingSwords', def.phases[2]!.speedMult);
      }
    } else if (boss.bossId === 'KingsHand') {
      // Both 85% (P2) & 40% (P3) trigger Floating Invulnerable Add-Summon Intermission!
      beginBossAttack(
        state,
        boss,
        'addWave',
        def.phases[Math.min(def.phases.length - 1, boss.bossPhase - 1)]!.speedMult
      );
    }
  }

  // Behemoth Lacerating Aura (r = 58px, pulses every 15 ticks while walking & leaping!)
  if (boss.bossId === 'Behemoth' && boss.bossAuraTicks > 0 && state.tick % 15 === 0) {
    if (Math.hypot(player.pos.x - boss.pos.x, player.pos.y - boss.pos.y) <= 58) {
      damagePlayer(state, Math.max(8, Math.round(boss.damage * 0.55)), 'Crimson Aura', rng, false, {
        attackerX: boss.pos.x,
        attacker: boss,
        unblockable: true,
      });
    }
  }

  // TimeKeeper Phase 3 (<50% HP): Persistent Ambient Ceiling Sword Rain!
  if (
    boss.bossId === 'TimeKeeper' &&
    boss.bossPhase >= 3 &&
    player.actionState !== 'dead' &&
    state.tick % 38 === 0
  ) {
    spawnSkySword(state, boss, player.pos.x + rng.rangeFloat(-48, 48));
  }

  const phaseDef = def.phases[Math.min(def.phases.length - 1, Math.max(0, boss.bossPhase - 1))]!;
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
    const isRooted = hasStatus(boss.statusEffects, 'root');

    if (boss.state === 'chase' || boss.state === 'idle' || boss.state === 'patrol') {
      // Lock facing while rooted in Wolf Trap!
      if (!isRooted) {
        boss.facing = dx >= 0 ? 1 : -1;
      }
      const moveSpeed =
        (boss.bossId === 'TimeKeeper' ? 132 : boss.bossId === 'KingsHand' ? 92 : 82) * speedMult;
      if (isRooted) {
        boss.vel.x = 0;
      } else if (dist > 52) {
        boss.vel.x = boss.facing * moveSpeed;
      } else {
        boss.vel.x *= 0.7;
      }

      if (boss.attackCooldownTicks <= 0 && player.actionState !== 'dead') {
        let pool = phaseDef.attacks.filter((a) => a !== 'addWave');
        if (boss.bossId === 'KingsHand' && boss.bossBannerCooldown > 0) {
          pool = pool.filter((a) => a !== 'dropBanners');
        }
        if (boss.bossId === 'Behemoth' && boss.bossAuraTicks > 0) {
          pool = pool.filter((a) => a !== 'roarAura');
        }

        let chosen: string;
        if (boss.bossId === 'Behemoth' && dist < 72 && rng.chance(0.55)) {
          chosen = 'punch';
        } else if (boss.bossId === 'TimeKeeper' && dist < 68 && rng.chance(0.55)) {
          chosen = 'swordCombo';
        } else if (boss.bossId === 'KingsHand' && dist > 180 && rng.chance(0.45)) {
          chosen = rng.chance(0.5) ? 'bombFlurry' : 'shieldCharge';
        } else {
          chosen = pool.length > 0 ? rng.pick(pool) : phaseDef.attacks[0]!;
        }

        // Set up multi-chain sub-counts for Phase 3 signature chains
        if (boss.bossId === 'TimeKeeper' && chosen === 'dashSlash' && boss.bossPhase >= 3) {
          boss.bossSubPhaseCount = rng.chance(0.5) ? 2 : 1; // 2-3 total Lightspeed Dashes!
        } else if (boss.bossId === 'KingsHand' && chosen === 'shieldCharge' && boss.bossPhase >= 3) {
          boss.bossSubPhaseCount = 1; // 2x consecutive Shield Charges in Phase 3!
        } else {
          boss.bossSubPhaseCount = 0;
        }

        beginBossAttack(state, boss, chosen, speedMult);
      }
    } else if (boss.state === 'windup') {
      boss.vel.x *= 0.75;
      boss.stateTicks -= 1;
      if (boss.telegraphTicks > 0) boss.telegraphTicks -= 1;
      if (boss.stateTicks <= 0) {
        boss.state = 'attack';
        boss.stateTicks = getBossAttackDuration(boss, boss.bossAttackId);
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

      if (boss.state === 'attack' && boss.stateTicks <= 0) {
        // Handle multi-hit boss chains!
        if ((boss.bossSubPhaseCount ?? 0) > 0 && player.actionState !== 'dead') {
          boss.bossSubPhaseCount! -= 1;
          beginBossAttack(state, boss, boss.bossAttackId, speedMult * 1.15);
        } else if (
          boss.bossId === 'Behemoth' &&
          boss.bossAttackId === 'shockwave' &&
          boss.bossPhase >= 2 &&
          rng.chance(boss.bossPhase >= 3 ? 0.75 : 0.45)
        ) {
          // Concierge P2+ Fire Strike -> Leap Slam chain!
          beginBossAttack(state, boss, 'leapSlam', speedMult);
        } else {
          boss.state = 'recover';
          boss.stateTicks = Math.max(14, Math.round(28 / speedMult));
        }
      }
    } else if (boss.state === 'recover') {
      boss.vel.x *= 0.78;
      boss.stateTicks -= 1;
      if (boss.stateTicks <= 0) {
        boss.state = 'chase';
        boss.attackCooldownTicks = Math.max(16, Math.round(34 / speedMult));
      }
    }
  }

  // Gravity & Swept Collision (suppressed while floating invulnerable during HoTK Add-Summon / Super Slam hover!)
  const suppressGravity =
    Boolean(boss.bossFloatingSummon) ||
    (boss.bossId === 'KingsHand' &&
      boss.state === 'attack' &&
      boss.bossAttackId === 'superSlam' &&
      boss.stateTicks > 18);

  if (!suppressGravity) {
    boss.vel.y = Math.min(520, boss.vel.y + 980 * FIXED_DT);
  }

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
