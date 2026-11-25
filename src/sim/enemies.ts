import {
  FIXED_DT,
  TILE_SIZE,
  type CollisionAPI,
  type EliteAffix,
  type EnemyState,
  type RngAPI,
  type SimState,
} from '../contracts';
import { ENEMY_MAP, getBiome, getDifficulty, getEnemy } from '../data';
import { stepBossAI } from './bosses';
import { attemptShieldParry, damageEnemy, damagePlayer } from './combat';
import { applyStatus, hasStatus, tickEntityStatuses } from './status';

const ELITE_AFFIXES: readonly EliteAffix[] = ['laser', 'storm', 'twin', 'teleport'];

function createEnemyEntity(
  state: SimState,
  defId: string,
  x: number,
  y: number,
  roomId: number,
  rng: RngAPI,
  isElite: boolean,
  eliteAffix?: EliteAffix,
  hpScale = 1.0
): EnemyState {
  const def = getEnemy(defId);
  const biome = getBiome(state.activeBiomeId);
  const diff = getDifficulty(state.bossStemCells);

  const tierHpMult = 1 + Math.max(0, biome.depthTier - 1) * 0.28;
  const tierDmgMult = 1 + Math.max(0, biome.depthTier - 1) * 0.16;
  const eliteHpMult = isElite ? 2.15 : 1.0;
  const eliteDmgMult = isElite ? 1.35 : 1.0;

  const maxHp = Math.max(
    10,
    Math.round(def.baseHp * tierHpMult * diff.mobHpMult * eliteHpMult * hpScale)
  );
  const damage = Math.max(
    5,
    Math.round(def.baseDamage * tierDmgMult * diff.mobDmgMult * eliteDmgMult)
  );

  const entity: EnemyState = {
    uid: state.nextUid++,
    defId: def.id,
    name: isElite ? `Elite ${def.name}` : def.name,
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: 0, y: 0 },
    width: def.width,
    height: def.height,
    facing: rng.chance(0.5) ? 1 : -1,
    grounded: !def.flying,
    hp: maxHp,
    maxHp,
    damage,
    state: 'patrol',
    stateTicks: rng.rangeInt(30, 90),
    telegraphTicks: 0,
    attackCooldownTicks: rng.rangeInt(10, 30),
    stunTicks: 0,
    breachMeter: 0,
    breachThreshold: Math.max(30, Math.round(def.baseHp * (isElite ? 0.6 : 0.35))),
    hitFlashTicks: 0,
    isElite,
    eliteAffix,
    eliteTimerTicks: rng.rangeInt(90, 150),
    isBoss: false,
    bossPhase: 0,
    bossAttackId: '',
    bossAuraTicks: 0,
    bossShieldTicks: 0,
    bossBannerCooldown: 0,
    homePos: { x, y },
    patrolMinX: x - 96,
    patrolMaxX: x + 96,
    roomId,
    statusEffects: [],
    hitPlayerThisSwing: false,
    protectedByUid: null,
  };

  state.enemies.push(entity);
  return entity;
}

export function spawnEnemy(
  state: SimState,
  defId: string,
  x: number,
  y: number,
  roomId: number,
  rng: RngAPI,
  forceElite?: boolean
): EnemyState {
  const isElite = forceElite ?? false;
  const eliteAffix = isElite ? rng.pick(ELITE_AFFIXES) : undefined;
  const main = createEnemyEntity(state, defId, x, y, roomId, rng, isElite, eliteAffix, 1.0);

  if (isElite && eliteAffix === 'twin') {
    createEnemyEntity(state, defId, x + 22, y, roomId, rng, true, undefined, 0.65);
  }

  return main;
}

function tryEnemyMeleeHit(
  state: SimState,
  enemy: EnemyState,
  rangeX: number,
  rangeY: number,
  dmgMult: number,
  rng: RngAPI
): boolean {
  const player = state.player;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;
  const inFront = dx * enemy.facing >= -10 && Math.abs(dx) <= rangeX;
  const inY = Math.abs(dy) <= rangeY;
  if (!inFront || !inY) return false;

  const dmg = Math.max(1, Math.round(enemy.damage * dmgMult));
  const def = ENEMY_MAP[enemy.defId];
  if (def && def.canBeParried && attemptShieldParry(state, dmg, enemy, null, rng)) {
    enemy.hitPlayerThisSwing = true;
    return true;
  }

  if (damagePlayer(state, dmg, enemy.name, rng)) {
    enemy.hitPlayerThisSwing = true;
    return true;
  }
  return false;
}

function stepEliteAffix(
  state: SimState,
  enemy: EnemyState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  if (!enemy.isElite || !enemy.eliteAffix) return;
  const player = state.player;
  const dist = Math.hypot(player.pos.x - enemy.pos.x, player.pos.y - enemy.pos.y);
  if (dist > 280) return;

  enemy.eliteTimerTicks -= 1;
  if (enemy.eliteTimerTicks > 0) return;

  switch (enemy.eliteAffix) {
    case 'laser': {
      enemy.eliteTimerTicks = 175;
      const dir = player.pos.x >= enemy.pos.x ? 1 : -1;
      state.projectiles.push({
        uid: state.nextUid++,
        owner: 'enemy',
        ownerUid: enemy.uid,
        kind: 'laserBeam',
        pos: { x: enemy.pos.x + dir * 12, y: enemy.pos.y - 4 },
        prevPos: { x: enemy.pos.x + dir * 12, y: enemy.pos.y - 4 },
        vel: { x: dir * 280, y: 0 },
        radius: 6,
        damage: Math.round(enemy.damage * 0.9),
        isCrit: false,
        pierceLeft: 2,
        gravity: 0,
        ttlTicks: 38,
        maxTtlTicks: 38,
        color: '#ff4285',
        parriable: false,
        hitIds: [],
      });
      break;
    }
    case 'storm': {
      enemy.eliteTimerTicks = 160;
      state.projectiles.push({
        uid: state.nextUid++,
        owner: 'enemy',
        ownerUid: enemy.uid,
        kind: 'fallingSword',
        pos: { x: player.pos.x + rng.rangeFloat(-16, 16), y: player.pos.y - 130 },
        prevPos: { x: player.pos.x, y: player.pos.y - 130 },
        vel: { x: 0, y: 290 },
        radius: 8,
        damage: Math.round(enemy.damage * 0.95),
        isCrit: false,
        pierceLeft: 0,
        gravity: 160,
        ttlTicks: 48,
        maxTtlTicks: 48,
        color: '#78e6ff',
        applyStatus: 'electrify',
        parriable: false,
        hitIds: [],
      });
      break;
    }
    case 'teleport': {
      enemy.eliteTimerTicks = 150;
      if (dist > 95) {
        const destX = player.pos.x - player.facing * 36;
        const tx = Math.floor(destX / TILE_SIZE);
        const ty = Math.floor(player.pos.y / TILE_SIZE);
        if (!col.isSolidAt(state.tileGrid, tx, ty)) {
          const fromX = enemy.pos.x;
          const fromY = enemy.pos.y;
          enemy.pos.x = destX;
          enemy.pos.y = player.pos.y;
          enemy.prevPos.x = destX;
          enemy.prevPos.y = player.pos.y;
          enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
          state.events.push({
            type: 'teleport',
            fromX,
            fromY,
            toX: enemy.pos.x,
            toY: enemy.pos.y,
          });
        }
      }
      break;
    }
    case 'twin': {
      enemy.eliteTimerTicks = 240;
      break;
    }
  }
}

function executeEnemyAttackTick(
  state: SimState,
  enemy: EnemyState,
  isFirstActiveTick: boolean,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const player = state.player;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;
  const dist = Math.max(1, Math.hypot(dx, dy));

  switch (enemy.defId) {
    case 'Zombie': {
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 225;
        enemy.vel.y = -75;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 34, 26, 1.0, rng);
      }
      break;
    }

    case 'Archer': {
      if (isFirstActiveTick) {
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'enemyBolt',
          pos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
          prevPos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
          vel: { x: enemy.facing * 330, y: (dy / dist) * 65 },
          radius: 4,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 0,
          ttlTicks: 65,
          maxTtlTicks: 65,
          color: '#ffd166',
          parriable: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'Grenader': {
      if (isFirstActiveTick) {
        const vx = Math.max(-210, Math.min(210, dx * 1.45));
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'grenade',
          pos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 8 },
          prevPos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 8 },
          vel: { x: vx, y: -225 },
          radius: 5,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 560,
          ttlTicks: 62,
          maxTtlTicks: 62,
          color: '#ff6b42',
          explosionRadius: 48,
          parriable: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'Shield': {
      enemy.vel.x = enemy.facing * 235;
      if (!enemy.hitPlayerThisSwing) {
        if (tryEnemyMeleeHit(state, enemy, 32, 26, 1.0, rng)) {
          player.vel.x += enemy.facing * 160;
        }
      }
      break;
    }

    case 'Mage360': {
      if (isFirstActiveTick) {
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'enemyBolt',
          pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          vel: { x: (dx / dist) * 235, y: (dy / dist) * 235 },
          radius: 5,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 0,
          ttlTicks: 90,
          maxTtlTicks: 90,
          color: '#d966ff',
          parriable: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'Runner': {
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 260;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 34, 26, 1.0, rng);
      }
      break;
    }

    case 'BatKamikaze': {
      if (isFirstActiveTick) {
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: enemy.pos.x, y: enemy.pos.y },
          vel: { x: 0, y: 0 },
          size: 52,
          color: '#ff4d4d',
          alpha: 1,
          ttlTicks: 18,
          maxTtlTicks: 18,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
        if (dist <= 54) {
          if (!attemptShieldParry(state, enemy.damage, enemy, null, rng)) {
            damagePlayer(state, enemy.damage, enemy.name, rng);
          }
        }
        enemy.hp = 0;
        enemy.state = 'dead';
      }
      break;
    }

    case 'BatDasher': {
      if (isFirstActiveTick) {
        enemy.vel.x = (dx / dist) * 275;
        enemy.vel.y = (dy / dist) * 275;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 26, 24, 1.0, rng);
      }
      break;
    }

    case 'Worm': {
      if (isFirstActiveTick) {
        enemy.vel.y = -130;
        for (let b = 0; b < 2; b++) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'acidSpit',
            pos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 4 },
            prevPos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 4 },
            vel: { x: enemy.facing * (145 + b * 55), y: -155 - b * 25 },
            radius: 4.5,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 0,
            gravity: 500,
            ttlTicks: 60,
            maxTtlTicks: 60,
            color: '#78ff42',
            applyStatus: 'poison',
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'Protector': {
      if (isFirstActiveTick) {
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: enemy.pos.x, y: enemy.pos.y },
          vel: { x: 0, y: 0 },
          size: 120,
          color: '#52f5a8',
          alpha: 0.9,
          ttlTicks: 22,
          maxTtlTicks: 22,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
      }
      break;
    }

    case 'Scorpio': {
      if (isFirstActiveTick) {
        if (dist <= 44) {
          if (tryEnemyMeleeHit(state, enemy, 44, 24, 1.0, rng)) {
            applyStatus(player.statusEffects, 'poison', 180, 12, enemy.uid);
          }
        } else {
          enemy.vel.x = -enemy.facing * 80;
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'acidSpit',
            pos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
            prevPos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
            vel: { x: enemy.facing * 280, y: -40 },
            radius: 4.5,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 0,
            gravity: 120,
            ttlTicks: 58,
            maxTtlTicks: 58,
            color: '#6ee642',
            applyStatus: 'poison',
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'Comboter': {
      // 3-hit combo with shockwave finisher on 3rd beat
      if (enemy.stateTicks === 13 || enemy.stateTicks === 8 || enemy.stateTicks === 3) {
        enemy.hitPlayerThisSwing = false;
        enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
        enemy.vel.x = enemy.facing * 175;
        if (enemy.stateTicks === 3) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'shockwave',
            pos: { x: enemy.pos.x + enemy.facing * 16, y: enemy.pos.y + enemy.height * 0.35 },
            prevPos: { x: enemy.pos.x + enemy.facing * 16, y: enemy.pos.y + enemy.height * 0.35 },
            vel: { x: enemy.facing * 215, y: 0 },
            radius: 8,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 2,
            gravity: 0,
            ttlTicks: 42,
            maxTtlTicks: 42,
            color: '#ff7042',
            parriable: false,
            hitIds: [],
          });
        }
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 44, 28, 1.0, rng);
      }
      break;
    }

    case 'Ninja': {
      if (isFirstActiveTick) {
        const targetX = player.pos.x - player.facing * 26;
        const tx = Math.floor(targetX / TILE_SIZE);
        const ty = Math.floor(player.pos.y / TILE_SIZE);
        if (!col.isSolidAt(state.tileGrid, tx, ty)) {
          const fromX = enemy.pos.x;
          const fromY = enemy.pos.y;
          enemy.pos.x = targetX;
          enemy.pos.y = player.pos.y;
          enemy.prevPos.x = targetX;
          enemy.prevPos.y = player.pos.y;
          enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
          state.events.push({
            type: 'teleport',
            fromX,
            fromY,
            toX: enemy.pos.x,
            toY: enemy.pos.y,
          });
        }
        enemy.vel.x = enemy.facing * 150;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 38, 26, 1.1, rng);
      }
      break;
    }

    case 'LeapingDuelyst': {
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 185;
        enemy.vel.y = -210;
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'grenade',
          pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          vel: { x: -enemy.facing * 80, y: -150 },
          radius: 4.5,
          damage: Math.round(enemy.damage * 0.85),
          isCrit: false,
          pierceLeft: 0,
          gravity: 560,
          ttlTicks: 44,
          maxTtlTicks: 44,
          color: '#ff9c42',
          explosionRadius: 42,
          parriable: true,
          hitIds: [],
        });
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 42, 30, 1.0, rng);
      }
      break;
    }

    case 'ClusterGrenader': {
      if (isFirstActiveTick) {
        const vx = Math.max(-215, Math.min(215, dx * 1.4));
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'cluster',
          pos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
          prevPos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
          vel: { x: vx, y: -245 },
          radius: 6,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 580,
          ttlTicks: 58,
          maxTtlTicks: 58,
          color: '#ff5242',
          explosionRadius: 46,
          parriable: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'PirateChief': {
      if (isFirstActiveTick) {
        if (dist <= 52) {
          tryEnemyMeleeHit(state, enemy, 54, 30, 1.15, rng);
        } else {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'grenade',
            pos: { x: enemy.pos.x + enemy.facing * 14, y: enemy.pos.y - 6 },
            prevPos: { x: enemy.pos.x + enemy.facing * 14, y: enemy.pos.y - 6 },
            vel: { x: enemy.facing * 265, y: -45 },
            radius: 7,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 0,
            gravity: 240,
            ttlTicks: 62,
            maxTtlTicks: 62,
            color: '#ffb042',
            explosionRadius: 56,
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'CastleKnight': {
      if (isFirstActiveTick) {
        state.screenShake = Math.max(state.screenShake, 4);
        for (const dir of [-1, 1] as const) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'shockwave',
            pos: { x: enemy.pos.x + dir * 16, y: enemy.pos.y + enemy.height * 0.35 },
            prevPos: { x: enemy.pos.x + dir * 16, y: enemy.pos.y + enemy.height * 0.35 },
            vel: { x: dir * 210, y: 0 },
            radius: 9,
            damage: Math.round(enemy.damage * 0.9),
            isCrit: false,
            pierceLeft: 2,
            gravity: 0,
            ttlTicks: 44,
            maxTtlTicks: 44,
            color: '#ffd166',
            parriable: false,
            hitIds: [],
          });
        }
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 56, 32, 1.15, rng);
      }
      break;
    }

    case 'Lancer': {
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 140;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 92, 22, 1.1, rng);
      }
      break;
    }

    default: {
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 36, 26, 1.0, rng);
      }
      break;
    }
  }
}

export function stepEnemies(state: SimState, rng: RngAPI, col: CollisionAPI): void {
  const player = state.player;

  // Pass 1: Update Protector shield aura links
  for (let i = 0; i < state.enemies.length; i++) {
    state.enemies[i].protectedByUid = null;
  }
  for (let i = 0; i < state.enemies.length; i++) {
    const prot = state.enemies[i];
    if (prot.state === 'dead' || prot.hp <= 0 || prot.defId !== 'Protector') continue;
    if (prot.stunTicks > 0 || hasStatus(prot.statusEffects, 'freeze')) continue;

    for (let j = 0; j < state.enemies.length; j++) {
      const ally = state.enemies[j];
      if (
        ally.uid === prot.uid ||
        ally.state === 'dead' ||
        ally.hp <= 0 ||
        ally.isBoss ||
        ally.defId === 'Protector'
      ) {
        continue;
      }
      if (Math.hypot(ally.pos.x - prot.pos.x, ally.pos.y - prot.pos.y) <= 185) {
        ally.protectedByUid = prot.uid;
      }
    }
  }

  // Pass 2: Step each enemy
  for (let i = 0; i < state.enemies.length; i++) {
    const enemy = state.enemies[i];
    if (enemy.state === 'dead' || enemy.hp <= 0) {
      continue;
    }

    enemy.prevPos.x = enemy.pos.x;
    enemy.prevPos.y = enemy.pos.y;

    if (enemy.hitFlashTicks > 0) enemy.hitFlashTicks -= 1;
    if (enemy.attackCooldownTicks > 0) enemy.attackCooldownTicks -= 1;
    if (enemy.bossShieldTicks > 0) enemy.bossShieldTicks -= 1;
    if (enemy.bossAuraTicks > 0) enemy.bossAuraTicks -= 1;

    // Tick status effects (DoTs can kill the enemy!)
    tickEntityStatuses(enemy.statusEffects, (kind, amount) => {
      state.events.push({ type: 'statusProc', x: enemy.pos.x, y: enemy.pos.y, status: kind });
      damageEnemy(state, enemy, amount, false, 0, 0, 0, rng, 'status', undefined, col);
    });

    if (enemy.hp <= 0) {
      continue;
    }

    // Bosses use dedicated multi-phase choreography
    if (enemy.isBoss) {
      stepBossAI(state, enemy, rng, col);
      continue;
    }

    const def = getEnemy(enemy.defId);
    stepEliteAffix(state, enemy, rng, col);

    const isFrozen = hasStatus(enemy.statusEffects, 'freeze');
    const isRooted = hasStatus(enemy.statusEffects, 'root');
    const isSlowed = hasStatus(enemy.statusEffects, 'slow') || hasStatus(enemy.statusEffects, 'frost');
    const speedMult = isSlowed ? 0.5 : 1.0;

    if (isFrozen) {
      enemy.state = 'frozen';
      enemy.telegraphTicks = 0;
      enemy.vel.x *= 0.8;
    } else if (enemy.stunTicks > 0 || hasStatus(enemy.statusEffects, 'stun')) {
      if (enemy.stunTicks > 0) enemy.stunTicks -= 1;
      enemy.state = 'stunned';
      enemy.telegraphTicks = 0;
      enemy.vel.x *= 0.82;
      if (enemy.stunTicks <= 0 && !hasStatus(enemy.statusEffects, 'stun')) {
        enemy.state = 'chase';
      }
    } else {
      const dx = player.pos.x - enemy.pos.x;
      const dy = player.pos.y - enemy.pos.y;
      const dist = Math.hypot(dx, dy);
      const canSee =
        dist <= def.aggroRange &&
        (enemy.defId === 'Mage360' ||
          col.hasLineOfSight(state.tileGrid, enemy.pos.x, enemy.pos.y - 6, player.pos.x, player.pos.y - 6));

      if (enemy.state === 'frozen' || enemy.state === 'rooted') {
        enemy.state = 'chase';
      }

      if (enemy.state === 'idle' || enemy.state === 'patrol') {
        if (canSee && player.actionState !== 'dead') {
          enemy.state = 'chase';
          enemy.facing = dx >= 0 ? 1 : -1;
        } else if (enemy.state === 'patrol') {
          if (def.flying) {
            enemy.vel.x = enemy.facing * def.speed * 0.45 * speedMult;
            enemy.vel.y = Math.sin((state.tick + enemy.uid * 13) * 0.08) * 26;
          } else if (!isRooted) {
            enemy.vel.x = enemy.facing * def.speed * 0.45 * speedMult;
            // Turn around at patrol edge or ledge drop-off
            const aheadX = enemy.pos.x + enemy.facing * (enemy.width * 0.5 + 8);
            const floorAheadTx = Math.floor(aheadX / TILE_SIZE);
            const floorAheadTy = Math.floor((enemy.pos.y + enemy.height * 0.5 + 6) / TILE_SIZE);
            const wallAheadTy = Math.floor(enemy.pos.y / TILE_SIZE);
            if (
              enemy.pos.x <= enemy.patrolMinX ||
              enemy.pos.x >= enemy.patrolMaxX ||
              col.isSolidAt(state.tileGrid, floorAheadTx, wallAheadTy) ||
              (!col.isSolidAt(state.tileGrid, floorAheadTx, floorAheadTy) &&
                !col.isOneWayAt(state.tileGrid, floorAheadTx, floorAheadTy))
            ) {
              enemy.facing = enemy.facing === 1 ? -1 : 1;
            }
          } else {
            enemy.vel.x = 0;
          }
        }
      } else if (enemy.state === 'chase') {
        if (player.actionState === 'dead' || dist > def.aggroRange * 1.6) {
          enemy.state = 'patrol';
          enemy.vel.x *= 0.5;
        } else {
          enemy.facing = dx >= 0 ? 1 : -1;
          const isRangedKiter =
            enemy.defId === 'Archer' ||
            enemy.defId === 'Grenader' ||
            enemy.defId === 'Mage360' ||
            enemy.defId === 'ClusterGrenader' ||
            enemy.defId === 'Scorpio';

          if (def.flying) {
            const len = Math.max(1, dist);
            enemy.vel.x = (dx / len) * def.speed * speedMult;
            enemy.vel.y = (dy / len) * def.speed * speedMult;
          } else if (isRooted) {
            enemy.vel.x = 0;
          } else if (isRangedKiter && dist < 85 && enemy.defId !== 'Scorpio') {
            enemy.vel.x = -enemy.facing * def.speed * 0.65 * speedMult;
          } else if (dist > Math.min(def.attackRange * 0.78, 36)) {
            const aheadX = enemy.pos.x + enemy.facing * (enemy.width * 0.5 + 8);
            const floorTx = Math.floor(aheadX / TILE_SIZE);
            const floorTy = Math.floor((enemy.pos.y + enemy.height * 0.5 + 8) / TILE_SIZE);
            const hasGround =
              col.isSolidAt(state.tileGrid, floorTx, floorTy) ||
              col.isOneWayAt(state.tileGrid, floorTx, floorTy);
            enemy.vel.x = hasGround ? enemy.facing * def.speed * speedMult : 0;
          } else {
            enemy.vel.x *= 0.65;
          }

          // Trigger telegraph windup when in range
          const inAttackY = def.flying || Math.abs(dy) <= (isRangedKiter ? 130 : 48);
          if (
            dist <= def.attackRange &&
            inAttackY &&
            enemy.attackCooldownTicks <= 0 &&
            (canSee || enemy.defId === 'Grenader' || enemy.defId === 'ClusterGrenader' || enemy.defId === 'Protector')
          ) {
            enemy.state = 'windup';
            enemy.stateTicks = Math.max(14, Math.round(def.windupTicks / speedMult));
            enemy.telegraphTicks = enemy.stateTicks;
            enemy.hitPlayerThisSwing = false;
            enemy.vel.x *= 0.2;
            state.events.push({
              type: 'enemyTelegraph',
              x: enemy.pos.x,
              y: enemy.pos.y - enemy.height * 0.6 - 8,
              enemyUid: enemy.uid,
            });
          }
        }
      } else if (enemy.state === 'windup') {
        enemy.vel.x *= 0.75;
        if (def.flying) enemy.vel.y *= 0.75;
        enemy.stateTicks -= 1;
        if (enemy.telegraphTicks > 0) enemy.telegraphTicks -= 1;
        if (enemy.stateTicks <= 0) {
          enemy.state = 'attack';
          enemy.stateTicks = Math.max(1, def.activeTicks);
          enemy.telegraphTicks = 0;
          executeEnemyAttackTick(state, enemy, true, rng, col);
        }
      } else if (enemy.state === 'attack') {
        enemy.stateTicks -= 1;
        executeEnemyAttackTick(state, enemy, false, rng, col);
        if (enemy.state === 'attack' && enemy.stateTicks <= 0) {
          enemy.state = 'recover';
          enemy.stateTicks = Math.max(8, def.recoveryTicks);
        }
      } else if (enemy.state === 'recover') {
        enemy.vel.x *= 0.75;
        if (def.flying) enemy.vel.y *= 0.8;
        enemy.stateTicks -= 1;
        if (enemy.stateTicks <= 0) {
          enemy.state = 'chase';
          enemy.attackCooldownTicks = Math.max(16, Math.round(def.recoveryTicks * 0.65));
        }
      }
    }

    if (enemy.hp <= 0) {
      continue;
    }

    // Apply gravity for grounded archetypes and resolve swept collision
    if (!def.flying) {
      enemy.vel.y = Math.min(480, enemy.vel.y + 980 * FIXED_DT);
    }

    const res = col.sweepAabb(
      state.tileGrid,
      enemy.pos.x - enemy.width * 0.5,
      enemy.pos.y - enemy.height * 0.5,
      enemy.width,
      enemy.height,
      enemy.vel.x,
      enemy.vel.y,
      FIXED_DT,
      false,
      false
    );

    enemy.pos.x = res.x + enemy.width * 0.5;
    enemy.pos.y = res.y + enemy.height * 0.5;
    enemy.vel.x = res.vx;
    enemy.vel.y = res.vy;
    enemy.grounded = res.hitFloor;

    // Swept knockback wall-slam trigger
    if (res.wallSlamSpeed >= 185 && enemy.hitFlashTicks > 0) {
      enemy.stunTicks = Math.max(enemy.stunTicks, 35);
      enemy.state = 'stunned';
      applyStatus(enemy.statusEffects, 'stun', 35, 0, 0);
      damageEnemy(
        state,
        enemy,
        Math.max(8, Math.round(enemy.maxHp * 0.08)),
        false,
        0,
        0,
        0,
        rng,
        'status',
        undefined,
        col
      );
    }
  }
}
