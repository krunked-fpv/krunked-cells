import {
  FIXED_DT,
  TILE_SIZE,
  type CollisionAPI,
  type DoorState,
  type EliteAffix,
  type EnemyState,
  type RngAPI,
  type SimState,
} from '../contracts';
import { ENEMY_MAP, getBiome, getDifficulty, getEnemy } from '../data';
import { stepBossAI } from './bosses';
import {
  attemptShieldParry,
  damageEnemy,
  damagePlayer,
  damagePlayerTurretsInArea,
} from './combat';
import { hasMutation } from './roguelite';
import { applyStatus, hasStatus, tickEntityStatuses } from './status';

const ELITE_AFFIXES: readonly EliteAffix[] = ['laser', 'storm', 'twin', 'teleport'];

const DROP_THROUGH_CHASERS: ReadonlySet<string> = new Set([
  'Zombie',
  'Runner',
  'Comboter',
  'LeapingDuelyst',
  'Worm',
  'Shield',
  'PirateChief',
  'CastleKnight',
  'Lancer',
]);

function isBlockedByClosedWoodDoor(
  doors: readonly DoorState[],
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  for (let i = 0; i < doors.length; i++) {
    const d = doors[i]!;
    if (d.kind !== 'wood' || d.broken || d.opened) continue;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const dxHalf = d.width * 0.5;
    if (maxX < d.pos.x - dxHalf || minX > d.pos.x + dxHalf) continue;
    const spanX = x1 - x0;
    const t = Math.abs(spanX) < 0.001 ? 0.5 : Math.max(0, Math.min(1, (d.pos.x - x0) / spanX));
    const yAtDoor = y0 + (y1 - y0) * t;
    if (Math.abs(yAtDoor - d.pos.y) <= d.height * 0.5 + 4) {
      return true;
    }
  }
  return false;
}

function isClosedWoodDoorAt(
  doors: readonly DoorState[],
  x: number,
  y: number,
  halfH: number
): boolean {
  for (let i = 0; i < doors.length; i++) {
    const d = doors[i]!;
    if (d.kind !== 'wood' || d.broken || d.opened) continue;
    if (
      Math.abs(d.pos.x - x) <= d.width * 0.5 + 4 &&
      Math.abs(d.pos.y - y) <= d.height * 0.5 + halfH
    ) {
      return true;
    }
  }
  return false;
}

function findStandableXNearPlayer(
  state: SimState,
  col: CollisionAPI,
  preferBehind: boolean,
  offsetPx: number
): { x: number; y: number } | null {
  const player = state.player;
  const candidates = preferBehind
    ? [player.pos.x - player.facing * offsetPx, player.pos.x + player.facing * offsetPx]
    : [player.pos.x + player.facing * offsetPx, player.pos.x - player.facing * offsetPx];

  const arena = state.bossArenaState;
  const minX =
    arena.active && arena.lockedRightX > arena.lockedLeftX
      ? arena.lockedLeftX + 16
      : TILE_SIZE + 12;
  const maxX =
    arena.active && arena.lockedRightX > arena.lockedLeftX
      ? arena.lockedRightX - 16
      : (state.tileGrid.width - 1) * TILE_SIZE - 12;

  const ty = Math.floor(player.pos.y / TILE_SIZE);
  const footTy = Math.floor((player.pos.y + player.height * 0.5 + 6) / TILE_SIZE);

  for (let i = 0; i < candidates.length; i++) {
    const cx = Math.max(minX, Math.min(maxX, candidates[i]!));
    const tx = Math.floor(cx / TILE_SIZE);
    const bodyClear =
      !col.isSolidAt(state.tileGrid, tx, ty) && !col.isSolidAt(state.tileGrid, tx, ty - 1);
    const hasFloor =
      col.isSolidAt(state.tileGrid, tx, footTy) ||
      col.isOneWayAt(state.tileGrid, tx, footTy) ||
      col.isSolidAt(state.tileGrid, tx, footTy + 1);
    if (bodyClear && hasFloor) {
      return { x: cx, y: player.pos.y };
    }
  }
  return null;
}

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

  // Guarantee grounded enemies never spawn with feet clipped into a solid floor tile
  let safeY = y;
  if (!def.flying && state.tileGrid.width > 1 && state.tileGrid.height > 1) {
    const tx = Math.max(0, Math.min(state.tileGrid.width - 1, Math.floor(x / TILE_SIZE)));
    const footTy = Math.max(
      0,
      Math.min(state.tileGrid.height - 1, Math.floor((safeY + def.height * 0.5 - 0.01) / TILE_SIZE))
    );
    const tileKind = state.tileGrid.tiles[footTy * state.tileGrid.width + tx]!;
    const isSolid = tileKind === 1 || tileKind === 8 || tileKind === 9;
    if (isSolid && footTy > 0) {
      const aboveKind = state.tileGrid.tiles[(footTy - 1) * state.tileGrid.width + tx]!;
      const aboveSolid = aboveKind === 1 || aboveKind === 8 || aboveKind === 9;
      if (!aboveSolid) {
        safeY = footTy * TILE_SIZE - def.height * 0.5;
      }
    }
  }

  const entity: EnemyState = {
    uid: state.nextUid++,
    defId: def.id,
    name: isElite ? `Elite ${def.name}` : def.name,
    pos: { x, y: safeY },
    prevPos: { x, y: safeY },
    vel: { x: 0, y: 0 },
    width: def.width,
    height: def.height,
    facing: rng.chance(0.5) ? 1 : -1,
    grounded: !def.flying,
    hp: maxHp,
    maxHp,
    damage,
    state: def.id === 'Scorpio' ? 'idle' : 'patrol',
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
    homePos: { x, y: safeY },
    patrolMinX: x - 96,
    patrolMaxX: x + 96,
    roomId,
    statusEffects: [],
    hitPlayerThisSwing: false,
    protectedByUid: null,
    turnDelayTicks: 0,
    buried: def.id === 'Scorpio',
    teleportCooldownTicks: def.id === 'Runner' ? 90 : 120,
    stuckArrows: [],
    ccResistStacks: 0,
    ccResistResetTicks: 0,
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
  forceElite?: boolean,
  suppressEliteAffix = false
): EnemyState {
  const isElite = forceElite ?? false;
  const eliteAffix = isElite && !suppressEliteAffix ? rng.pick(ELITE_AFFIXES) : undefined;
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
  rng: RngAPI,
  allowOmni = false
): boolean {
  const player = state.player;
  const dmg = Math.max(1, Math.round(enemy.damage * dmgMult));

  // Enemy melee swings also damage nearby deployed player turrets!
  damagePlayerTurretsInArea(
    state,
    enemy.pos.x + (allowOmni ? 0 : enemy.facing * rangeX * 0.45),
    enemy.pos.y,
    rangeX,
    rangeY,
    dmg
  );

  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;
  const inFront = allowOmni
    ? Math.abs(dx) <= rangeX
    : dx * enemy.facing >= -10 && Math.abs(dx) <= rangeX;
  const inY = Math.abs(dy) <= rangeY;
  if (!inFront || !inY) return false;

  const def = ENEMY_MAP[enemy.defId];
  if (def && def.canBeParried && attemptShieldParry(state, dmg, enemy, null, rng)) {
    enemy.hitPlayerThisSwing = true;
    return true;
  }

  if (
    damagePlayer(state, dmg, enemy.name, rng, false, {
      attackerX: enemy.pos.x,
      attacker: enemy,
    })
  ) {
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
  if ((player.stealthTicks ?? 0) > 0) return;
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
        const dest = findStandableXNearPlayer(state, col, true, 36);
        if (dest) {
          const fromX = enemy.pos.x;
          const fromY = enemy.pos.y;
          enemy.pos.x = dest.x;
          enemy.pos.y = dest.y;
          enemy.prevPos.x = dest.x;
          enemy.prevPos.y = dest.y;
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
  _col: CollisionAPI
): void {
  const player = state.player;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;
  const dist = Math.max(1, Math.hypot(dx, dy));

  switch (enemy.defId) {
    case 'Zombie': {
      if (isFirstActiveTick) {
        if (dist <= 36) {
          // Point-blank fast claw swipe
          enemy.vel.x = enemy.facing * 65;
        } else {
          // Classic telegraphed Zombie leap-lunge across gaps!
          enemy.vel.x = enemy.facing * 240;
          enemy.vel.y = -115;
        }
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 36, 26, 1.0, rng);
      }
      break;
    }

    case 'Archer': {
      if (isFirstActiveTick) {
        const clampedVy = Math.max(-45, Math.min(45, (dy / dist) * 65));
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'enemyBolt',
          pos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
          prevPos: { x: enemy.pos.x + enemy.facing * 10, y: enemy.pos.y - 3 },
          vel: { x: enemy.facing * 330, y: clampedVy },
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
          pos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
          prevPos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
          vel: { x: vx, y: -255 },
          radius: 5,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 560,
          ttlTicks: 115,
          maxTtlTicks: 115,
          color: '#ff6b42',
          explosionRadius: 48,
          parriable: true,
          bouncesLeft: 1,
          floorFuseTicks: 35,
          hitIds: [],
        });
      }
      break;
    }

    case 'Shield': {
      enemy.vel.x = enemy.facing * 240;
      if (!enemy.hitPlayerThisSwing) {
        const hpBefore = player.hp;
        if (tryEnemyMeleeHit(state, enemy, 34, 26, 1.0, rng)) {
          if (player.hp < hpBefore) {
            player.vel.x += enemy.facing * 170;
            player.fallStunTicks = Math.max(player.fallStunTicks ?? 0, 18);
          }
        }
      }
      break;
    }

    case 'Mage360': {
      if (isFirstActiveTick) {
        // Signature Inquisitor bolt: flies cleanly through solid walls & floors!
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'enemyBolt',
          pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          vel: { x: (dx / dist) * 230, y: (dy / dist) * 230 },
          radius: 5,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 0,
          gravity: 0,
          ttlTicks: 95,
          maxTtlTicks: 95,
          color: '#d966ff',
          parriable: true,
          piercesWalls: true,
          hitIds: [],
        });
      }
      break;
    }

    case 'Runner': {
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 265;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 36, 26, 1.05, rng);
      }
      break;
    }

    case 'BatKamikaze': {
      if (isFirstActiveTick) {
        const radius = 54;
        state.events.push({
          type: 'explosion',
          x: enemy.pos.x,
          y: enemy.pos.y,
          radius,
          color: '#ff4d4d',
          element: 'fire',
        });
        state.screenShake = Math.max(state.screenShake, 5);
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: enemy.pos.x, y: enemy.pos.y },
          vel: { x: 0, y: 0 },
          size: radius,
          color: '#ff4d4d',
          alpha: 1,
          ttlTicks: 18,
          maxTtlTicks: 18,
          gravity: 0,
          emissive: true,
          kind: 'ring',
        });
        damagePlayerTurretsInArea(state, enemy.pos.x, enemy.pos.y, radius * 2, radius * 2, enemy.damage);
        if (dist <= radius) {
          if (!attemptShieldParry(state, enemy.damage, enemy, null, rng)) {
            damagePlayer(state, enemy.damage, enemy.name, rng, false, {
              attackerX: enemy.pos.x,
              attacker: enemy,
            });
          }
        }
        enemy.hp = 0;
        enemy.state = 'dead';
      }
      break;
    }

    case 'BatDasher': {
      if (isFirstActiveTick) {
        const dashSpeed = 295;
        enemy.vel.x = (dx / dist) * dashSpeed;
        enemy.vel.y = (dy / dist) * dashSpeed;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 26, 24, 1.0, rng);
      }
      break;
    }

    case 'Worm': {
      // Fast leaping melee bite! (6 death-eggs drop on death in combat.ts)
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 205;
        enemy.vel.y = -95;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 38, 24, 1.0, rng);
      }
      break;
    }

    case 'Protector': {
      if (isFirstActiveTick) {
        state.particlesSim.push({
          uid: state.nextUid++,
          pos: { x: enemy.pos.x, y: enemy.pos.y },
          vel: { x: 0, y: 0 },
          size: 165,
          color: '#52f5a8',
          alpha: 0.9,
          ttlTicks: 24,
          maxTtlTicks: 24,
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
          enemy.vel.x = -enemy.facing * 95;
          enemy.vel.y = -65;
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
      // 3-beat Slasher combo with breach super-armor (0.7 resist in combat.ts):
      // Beat 1 (t=33) -> 10t -> Beat 2 (t=23, flips facing!) -> 16t charged delay -> Beat 3 (t=7) + shockwave!
      if (enemy.stateTicks === 33) {
        enemy.hitPlayerThisSwing = false;
        enemy.vel.x = enemy.facing * 175;
      } else if (enemy.stateTicks === 23) {
        enemy.hitPlayerThisSwing = false;
        if (!hasStatus(enemy.statusEffects, 'root')) {
          enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
        }
        enemy.vel.x = enemy.facing * 185;
      } else if (enemy.stateTicks === 15) {
        // Charged Beat 3 telegraph before floor shockwave
        state.events.push({
          type: 'enemyTelegraph',
          x: enemy.pos.x,
          y: enemy.pos.y - enemy.height * 0.6 - 8,
          enemyUid: enemy.uid,
        });
      } else if (enemy.stateTicks === 7) {
        enemy.hitPlayerThisSwing = false;
        if (!hasStatus(enemy.statusEffects, 'root')) {
          enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
        }
        enemy.vel.x = enemy.facing * 195;
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'shockwave',
          pos: { x: enemy.pos.x + enemy.facing * 16, y: enemy.pos.y + enemy.height * 0.35 },
          prevPos: { x: enemy.pos.x + enemy.facing * 16, y: enemy.pos.y + enemy.height * 0.35 },
          vel: { x: enemy.facing * 225, y: 0 },
          radius: 8,
          damage: enemy.damage,
          isCrit: false,
          pierceLeft: 2,
          gravity: 0,
          ttlTicks: 44,
          maxTtlTicks: 44,
          color: '#ff7042',
          parriable: false,
          hitIds: [],
        });
      }
      const inHitBeat =
        (enemy.stateTicks <= 33 && enemy.stateTicks >= 29) ||
        (enemy.stateTicks <= 23 && enemy.stateTicks >= 19) ||
        (enemy.stateTicks <= 7 && enemy.stateTicks >= 3);
      if (inHitBeat && !enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 46, 28, 1.0, rng);
      }
      break;
    }

    case 'Ninja': {
      // Dark Tracker ALREADY teleported before entering 26t windup — pure fair telegraphed slash here!
      if (isFirstActiveTick) {
        enemy.vel.x = enemy.facing * 165;
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 40, 26, 1.15, rng);
      }
      break;
    }

    case 'LeapingDuelyst': {
      // 2-beat lunging slash + leap-back tossing a bouncing fuse bomb
      if (enemy.stateTicks === 17) {
        enemy.hitPlayerThisSwing = false;
        enemy.vel.x = enemy.facing * 205;
        enemy.vel.y = -175;
      } else if (enemy.stateTicks === 8) {
        enemy.hitPlayerThisSwing = false;
        enemy.vel.x = -enemy.facing * 110;
        enemy.vel.y = -150;
        state.projectiles.push({
          uid: state.nextUid++,
          owner: 'enemy',
          ownerUid: enemy.uid,
          kind: 'grenade',
          pos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
          vel: { x: enemy.facing * 90, y: -165 },
          radius: 4.5,
          damage: Math.round(enemy.damage * 0.85),
          isCrit: false,
          pierceLeft: 0,
          gravity: 560,
          ttlTicks: 120,
          maxTtlTicks: 120,
          color: '#ff9c42',
          explosionRadius: 44,
          parriable: true,
          bouncesLeft: 1,
          floorFuseTicks: 50,
          hitIds: [],
        });
      }
      if (!enemy.hitPlayerThisSwing) {
        tryEnemyMeleeHit(state, enemy, 44, 30, 1.0, rng);
      }
      break;
    }

    case 'ClusterGrenader': {
      if (isFirstActiveTick) {
        if (dist <= 44) {
          // Cornered close-range quick melee jab!
          enemy.vel.x = enemy.facing * 95;
          tryEnemyMeleeHit(state, enemy, 44, 26, 0.9, rng);
        } else {
          const vx = Math.max(-215, Math.min(215, dx * 1.4));
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'cluster',
            pos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
            prevPos: { x: enemy.pos.x + enemy.facing * 8, y: enemy.pos.y - 10 },
            vel: { x: vx, y: -250 },
            radius: 6,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 0,
            gravity: 580,
            ttlTicks: 68,
            maxTtlTicks: 68,
            color: '#ff5242',
            explosionRadius: 46,
            parriable: true,
            hitIds: [],
          });
        }
      }
      break;
    }

    case 'PirateChief': {
      if (enemy.bossAttackId === 'meleeCombo') {
        // 3-hit melee cannon combo (tracks facing on hit 3!)
        if (enemy.stateTicks === 23 || enemy.stateTicks === 14 || enemy.stateTicks === 5) {
          enemy.hitPlayerThisSwing = false;
          if (enemy.stateTicks === 5 && !hasStatus(enemy.statusEffects, 'root')) {
            enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
          }
          enemy.vel.x = enemy.facing * 145;
        }
        if (!enemy.hitPlayerThisSwing) {
          tryEnemyMeleeHit(state, enemy, 58, 32, 1.15, rng);
        }
      } else {
        // Ranged: heavy floor-rolling cannonball (unrollable, must jump or parry!)
        if (isFirstActiveTick) {
          state.projectiles.push({
            uid: state.nextUid++,
            owner: 'enemy',
            ownerUid: enemy.uid,
            kind: 'grenade',
            pos: { x: enemy.pos.x + enemy.facing * 14, y: enemy.pos.y + 2 },
            prevPos: { x: enemy.pos.x + enemy.facing * 14, y: enemy.pos.y + 2 },
            vel: { x: enemy.facing * 220, y: 20 },
            radius: 7,
            damage: enemy.damage,
            isCrit: false,
            pierceLeft: 0,
            gravity: 480,
            ttlTicks: 110,
            maxTtlTicks: 110,
            color: '#ffb042',
            explosionRadius: 56,
            parriable: true,
            rollsOnFloor: true,
            unrollable: true,
            hitIds: [],
          });
          enemy.stateTicks = Math.min(enemy.stateTicks, 6);
        }
      }
      break;
    }

    case 'CastleKnight': {
      if (enemy.bossAttackId === 'shieldCharge') {
        // Long-range frontal-blocking Shield Charge!
        enemy.vel.x = enemy.facing * 280;
        if (!enemy.hitPlayerThisSwing) {
          const hpBefore = player.hp;
          if (tryEnemyMeleeHit(state, enemy, 48, 34, 1.05, rng)) {
            if (player.hp < hpBefore) {
              player.vel.x = enemy.facing * 280;
              player.vel.y = -110;
            }
          }
        }
      } else {
        // Close-range Telluric Leap Slam!
        if (isFirstActiveTick) {
          enemy.vel.y = -260;
          enemy.vel.x = enemy.facing * 120;
        } else if (enemy.grounded && enemy.stateTicks < 22) {
          state.screenShake = Math.max(state.screenShake, 6);
          for (const dir of [-1, 1] as const) {
            state.projectiles.push({
              uid: state.nextUid++,
              owner: 'enemy',
              ownerUid: enemy.uid,
              kind: 'shockwave',
              pos: { x: enemy.pos.x + dir * 16, y: enemy.pos.y + enemy.height * 0.35 },
              prevPos: { x: enemy.pos.x + dir * 16, y: enemy.pos.y + enemy.height * 0.35 },
              vel: { x: dir * 220, y: 0 },
              radius: 9,
              damage: Math.round(enemy.damage * 0.95),
              isCrit: false,
              pierceLeft: 2,
              gravity: 0,
              ttlTicks: 48,
              maxTtlTicks: 48,
              color: '#ffd166',
              parriable: false,
              unrollable: true,
              hitIds: [],
            });
          }
          if (!enemy.hitPlayerThisSwing) {
            tryEnemyMeleeHit(state, enemy, 62, 34, 1.2, rng, true);
          }
          enemy.stateTicks = 0;
        }
      }
      break;
    }

    case 'Lancer': {
      // 4-Directional through-platform spear thrusts (UP, DOWN, LEFT, RIGHT)
      if (enemy.bossAttackId === 'thrustUp') {
        if (isFirstActiveTick) {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: enemy.pos.x, y: enemy.pos.y - 52 },
            vel: { x: 0, y: -30 },
            size: 46,
            color: '#ffe07d',
            alpha: 1,
            ttlTicks: 8,
            maxTtlTicks: 8,
            gravity: 0,
            emissive: true,
            kind: 'slash',
          });
        }
        if (!enemy.hitPlayerThisSwing) {
          if (Math.abs(dx) <= 24 && dy <= 6 && dy >= -104) {
            const dmg = Math.max(1, Math.round(enemy.damage * 1.1));
            if (attemptShieldParry(state, dmg, enemy, null, rng)) {
              enemy.hitPlayerThisSwing = true;
            } else if (
              damagePlayer(state, dmg, enemy.name, rng, false, {
                attackerX: enemy.pos.x,
                attacker: enemy,
              })
            ) {
              enemy.hitPlayerThisSwing = true;
            }
          }
        }
      } else if (enemy.bossAttackId === 'thrustDown') {
        if (isFirstActiveTick) {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: enemy.pos.x, y: enemy.pos.y + 52 },
            vel: { x: 0, y: 30 },
            size: 46,
            color: '#ffe07d',
            alpha: 1,
            ttlTicks: 8,
            maxTtlTicks: 8,
            gravity: 0,
            emissive: true,
            kind: 'slash',
          });
        }
        if (!enemy.hitPlayerThisSwing) {
          if (Math.abs(dx) <= 24 && dy >= -6 && dy <= 104) {
            const dmg = Math.max(1, Math.round(enemy.damage * 1.1));
            if (attemptShieldParry(state, dmg, enemy, null, rng)) {
              enemy.hitPlayerThisSwing = true;
            } else if (
              damagePlayer(state, dmg, enemy.name, rng, false, {
                attackerX: enemy.pos.x,
                attacker: enemy,
              })
            ) {
              enemy.hitPlayerThisSwing = true;
            }
          }
        }
      } else {
        if (isFirstActiveTick) {
          enemy.vel.x = enemy.facing * 145;
        }
        if (!enemy.hitPlayerThisSwing) {
          tryEnemyMeleeHit(state, enemy, 100, 22, 1.1, rng);
        }
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
  const biome = getBiome(state.activeBiomeId);
  const diff = getDifficulty(state.bossStemCells);
  const tierMult = 1 + Math.max(0, biome.depthTier - 1) * 0.2;
  const malaiseSpeedMult =
    diff.malaiseEnabled && (player.malaise ?? 0) > 20
      ? 1 + Math.min(0.25, ((player.malaise ?? 0) / 100) * 0.25)
      : 1.0;

  // Pass 1: Update Protector shield aura links (r = 210px, through walls/floors!)
  for (let i = 0; i < state.enemies.length; i++) {
    state.enemies[i]!.protectedByUid = null;
  }
  for (let i = 0; i < state.enemies.length; i++) {
    const prot = state.enemies[i]!;
    if (prot.state === 'dead' || prot.hp <= 0 || prot.defId !== 'Protector') continue;
    if (prot.stunTicks > 0 || hasStatus(prot.statusEffects, 'freeze')) continue;

    // Steady visual emerald pulse ring every 45 ticks so players spot Protectors immediately
    if (state.tick % 45 === 0) {
      state.particlesSim.push({
        uid: state.nextUid++,
        pos: { x: prot.pos.x, y: prot.pos.y },
        vel: { x: 0, y: 0 },
        size: 165,
        color: '#52f5a8',
        alpha: 0.75,
        ttlTicks: 22,
        maxTtlTicks: 22,
        gravity: 0,
        emissive: true,
        kind: 'ring',
      });
    }

    for (let j = 0; j < state.enemies.length; j++) {
      const ally = state.enemies[j]!;
      if (
        ally.uid === prot.uid ||
        ally.state === 'dead' ||
        ally.hp <= 0 ||
        ally.isBoss ||
        ally.defId === 'Protector'
      ) {
        continue;
      }
      if (Math.hypot(ally.pos.x - prot.pos.x, ally.pos.y - prot.pos.y) <= 210) {
        ally.protectedByUid = prot.uid;
      }
    }
  }

  // Pass 2: Step each enemy
  for (let i = 0; i < state.enemies.length; i++) {
    const enemy = state.enemies[i]!;
    if (enemy.state === 'dead' || enemy.hp <= 0) {
      continue;
    }

    enemy.prevPos.x = enemy.pos.x;
    enemy.prevPos.y = enemy.pos.y;

    if (enemy.hitFlashTicks > 0) enemy.hitFlashTicks -= 1;
    if (enemy.attackCooldownTicks > 0) enemy.attackCooldownTicks -= 1;
    if (enemy.bossShieldTicks > 0) enemy.bossShieldTicks -= 1;
    if (enemy.bossAuraTicks > 0) enemy.bossAuraTicks -= 1;

    // Boss/Elite CC diminishing returns reset window
    if ((enemy.ccResistResetTicks ?? 0) > 0) {
      enemy.ccResistResetTicks! -= 1;
      if (enemy.ccResistResetTicks === 0) {
        enemy.ccResistStacks = 0;
      }
    }

    // Breach Meter Decay (20 * tierMult / sec when not actively being hit)
    if (enemy.hitFlashTicks === 0 && enemy.breachMeter > 0) {
      enemy.breachMeter = Math.max(0, enemy.breachMeter - 20 * tierMult * FIXED_DT);
    }

    // Stuck arrows timeout & ammo return + Barbed Tips DoT scaled by stuckArrows.length!
    if (enemy.stuckArrows && enemy.stuckArrows.length > 0) {
      for (let a = enemy.stuckArrows.length - 1; a >= 0; a--) {
        const stuck = enemy.stuckArrows[a]!;
        stuck.ttlTicks -= 1;
        if (stuck.ttlTicks <= 0) {
          const weapon = stuck.slot === 1 ? player.loadout.weapon1 : player.loadout.weapon2;
          if (weapon && weapon.maxAmmo !== undefined && weapon.ammo !== undefined) {
            weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + 1);
          }
          enemy.stuckArrows.splice(a, 1);
        }
      }
      if (
        enemy.stuckArrows.length > 0 &&
        state.tick % 20 === 0 &&
        hasMutation(state, 'BarbedTips')
      ) {
        const barbedDps = 22 + Math.max(0, player.scrolls.tactics - 1) * 4;
        const tickDmg = Math.max(
          1,
          Math.round((barbedDps / 3) * enemy.stuckArrows.length)
        );
        damageEnemy(state, enemy, tickDmg, false, 0, 0, 0, rng, 'status', undefined, col);
        if (enemy.hp <= 0) continue;
      }
    }

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

    // Scorpion buried ambush state
    if (enemy.defId === 'Scorpio' && enemy.buried) {
      const distToPlayer = Math.hypot(player.pos.x - enemy.pos.x, player.pos.y - enemy.pos.y);
      const diveTriggered =
        player.diveSlamState === 'impact' && distToPlayer <= 140;
      if (
        ((player.stealthTicks ?? 0) <= 0 && distToPlayer <= 115) ||
        diveTriggered
      ) {
        enemy.buried = false;
        enemy.vel.y = -150;
        enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
        enemy.state = 'chase';
        enemy.attackCooldownTicks = 16;
        for (let p = 0; p < 6; p++) {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: enemy.pos.x + rng.rangeFloat(-8, 8), y: enemy.pos.y + 6 },
            vel: { x: rng.rangeFloat(-70, 70), y: rng.rangeFloat(-120, -40) },
            size: 3.5,
            color: '#6b5344',
            alpha: 1,
            ttlTicks: 20,
            maxTtlTicks: 20,
            gravity: 340,
            emissive: false,
            kind: 'dust',
          });
        }
      } else {
        enemy.vel.x = 0;
        continue;
      }
    }

    stepEliteAffix(state, enemy, rng, col);

    const isFrozen = hasStatus(enemy.statusEffects, 'freeze');
    const isRooted = hasStatus(enemy.statusEffects, 'root');
    const isSlowed =
      hasStatus(enemy.statusEffects, 'slow') || hasStatus(enemy.statusEffects, 'frost');
    const speedMult = (isSlowed ? 0.5 : 1.0) * malaiseSpeedMult;
    let dropThroughOneWay = def.flying;

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
      const playerStealthed = (player.stealthTicks ?? 0) > 0;
      const blockedByDoor =
        enemy.defId !== 'Mage360' &&
        isBlockedByClosedWoodDoor(
          state.doors,
          enemy.pos.x,
          enemy.pos.y - 6,
          player.pos.x,
          player.pos.y - 6
        );
      const canSee =
        !playerStealthed &&
        !blockedByDoor &&
        dist <= def.aggroRange &&
        (enemy.defId === 'Mage360' ||
          col.hasLineOfSight(
            state.tileGrid,
            enemy.pos.x,
            enemy.pos.y - 6,
            player.pos.x,
            player.pos.y - 6
          ));

      if (enemy.state === 'frozen' || enemy.state === 'rooted') {
        enemy.state = 'chase';
      }

      if (enemy.state === 'idle' || enemy.state === 'patrol') {
        if (canSee && player.actionState !== 'dead') {
          enemy.state = 'chase';
          if (!isRooted) {
            enemy.facing = dx >= 0 ? 1 : -1;
            enemy.turnDelayTicks = 0;
          }
        } else if (enemy.state === 'patrol') {
          if (def.speed <= 0) {
            enemy.vel.x = 0;
          } else if (def.flying) {
            enemy.vel.x = enemy.facing * def.speed * 0.45 * speedMult;
            enemy.vel.y = Math.sin((state.tick + enemy.uid * 13) * 0.08) * 26;
          } else if (!isRooted) {
            enemy.vel.x = enemy.facing * def.speed * 0.45 * speedMult;
            const aheadX = enemy.pos.x + enemy.facing * (enemy.width * 0.5 + 8);
            const floorAheadTx = Math.floor(aheadX / TILE_SIZE);
            const floorAheadTy = Math.floor((enemy.pos.y + enemy.height * 0.5 + 6) / TILE_SIZE);
            const wallAheadTy = Math.floor(enemy.pos.y / TILE_SIZE);
            if (
              enemy.pos.x <= enemy.patrolMinX ||
              enemy.pos.x >= enemy.patrolMaxX ||
              isClosedWoodDoorAt(state.doors, aheadX, enemy.pos.y, enemy.height * 0.5) ||
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
        if (player.actionState === 'dead' || playerStealthed || dist > def.aggroRange * 1.6) {
          enemy.state = 'patrol';
          enemy.vel.x *= 0.5;
        } else {
          // Turn-around lag (`turnDelayTicks`), completely locked while rooted!
          if (!isRooted) {
            const desiredFacing: 1 | -1 = dx >= 0 ? 1 : -1;
            if (desiredFacing !== enemy.facing) {
              if ((enemy.turnDelayTicks ?? 0) <= 0) {
                enemy.turnDelayTicks = enemy.defId === 'Shield' ? 24 : 14;
              } else {
                enemy.turnDelayTicks! -= 1;
                if (enemy.turnDelayTicks === 0) {
                  enemy.facing = desiredFacing;
                }
              }
            } else {
              enemy.turnDelayTicks = 0;
            }
          }

          // Runner aggro teleportation & 4BC+ global enemy teleportation!
          const canRunnerTeleport =
            enemy.defId === 'Runner' &&
            !isRooted &&
            (dist > 110 || Math.abs(dy) > 48) &&
            dist < 280;
          const can4BcTeleport =
            Boolean(diff.enemyTeleport) &&
            !def.flying &&
            enemy.defId !== 'Protector' &&
            !isRooted &&
            (dist > 140 || Math.abs(dy) > 52) &&
            dist < 380;

          if (canRunnerTeleport || can4BcTeleport) {
            enemy.teleportCooldownTicks = (enemy.teleportCooldownTicks ?? 120) - 1;
            if (enemy.teleportCooldownTicks <= 0) {
              const dest = findStandableXNearPlayer(state, col, true, 34);
              if (dest) {
                const fromX = enemy.pos.x;
                const fromY = enemy.pos.y;
                enemy.pos.x = dest.x;
                enemy.pos.y = dest.y;
                enemy.prevPos.x = dest.x;
                enemy.prevPos.y = dest.y;
                enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
                enemy.turnDelayTicks = 0;
                enemy.teleportCooldownTicks = enemy.defId === 'Runner' ? 180 : 240;
                state.events.push({
                  type: 'teleport',
                  fromX,
                  fromY,
                  toX: enemy.pos.x,
                  toY: enemy.pos.y,
                });
                state.particlesSim.push({
                  uid: state.nextUid++,
                  pos: { x: enemy.pos.x, y: enemy.pos.y },
                  vel: { x: 0, y: 0 },
                  size: 32,
                  color: '#b852ff',
                  alpha: 1,
                  ttlTicks: 16,
                  maxTtlTicks: 16,
                  gravity: 0,
                  emissive: true,
                  kind: 'ring',
                });
                // Enter telegraphed windup (NEVER instant hit!)
                enemy.state = 'windup';
                enemy.stateTicks = Math.max(18, Math.round(def.windupTicks / speedMult));
                enemy.telegraphTicks = enemy.stateTicks;
                enemy.hitPlayerThisSwing = false;
                enemy.vel.x = 0;
                state.events.push({
                  type: 'enemyTelegraph',
                  x: enemy.pos.x,
                  y: enemy.pos.y - enemy.height * 0.6 - 8,
                  enemyUid: enemy.uid,
                });
                continue;
              }
              enemy.teleportCooldownTicks = 60;
            }
          } else if (diff.enemyTeleport && !can4BcTeleport && enemy.defId !== 'Runner') {
            enemy.teleportCooldownTicks = 120;
          }

          const isRangedKiter =
            enemy.defId === 'Archer' ||
            enemy.defId === 'Grenader' ||
            enemy.defId === 'Mage360' ||
            enemy.defId === 'ClusterGrenader' ||
            enemy.defId === 'Scorpio';

          // Grounded chasers drop through ONE_WAY platforms when player is below
          if (
            !def.flying &&
            !isRooted &&
            enemy.grounded &&
            DROP_THROUGH_CHASERS.has(enemy.defId) &&
            dy > 34 &&
            Math.abs(dx) < 160
          ) {
            const curTx = Math.floor(enemy.pos.x / TILE_SIZE);
            const belowTy = Math.floor((enemy.pos.y + enemy.height * 0.5 + 3) / TILE_SIZE);
            if (col.isOneWayAt(state.tileGrid, curTx, belowTy)) {
              dropThroughOneWay = true;
              enemy.pos.y += 2;
              enemy.vel.y = Math.max(enemy.vel.y, 45);
              enemy.grounded = false;
            }
          }

          if (def.speed <= 0) {
            enemy.vel.x = 0;
          } else if (enemy.hitFlashTicks > 2 || Math.abs(enemy.vel.x) > def.speed * speedMult * 1.15) {
            enemy.vel.x *= 0.88;
          } else if (def.flying) {
            const len = Math.max(1, dist);
            if (enemy.defId === 'BatDasher' && dist < 85 && dist > 55) {
              // Hover at sight-line offset before dash
              enemy.vel.x *= 0.8;
              enemy.vel.y = ((player.pos.y - 36 - enemy.pos.y) / 30) * 60;
            } else {
              enemy.vel.x = (dx / len) * def.speed * speedMult;
              enemy.vel.y = (dy / len) * def.speed * speedMult;
            }
          } else if (isRooted) {
            enemy.vel.x = 0;
          } else if (
            isRangedKiter &&
            dist < 85 &&
            enemy.defId !== 'Scorpio' &&
            enemy.defId !== 'ClusterGrenader'
          ) {
            const backX = enemy.pos.x - enemy.facing * (enemy.width * 0.5 + 8);
            const blockedBack = isClosedWoodDoorAt(
              state.doors,
              backX,
              enemy.pos.y,
              enemy.height * 0.5
            );
            enemy.vel.x = blockedBack ? 0 : -enemy.facing * def.speed * 0.65 * speedMult;
          } else if (dist > Math.min(def.attackRange * 0.78, 36)) {
            const aheadX = enemy.pos.x + enemy.facing * (enemy.width * 0.5 + 8);
            const floorTx = Math.floor(aheadX / TILE_SIZE);
            const floorTy = Math.floor((enemy.pos.y + enemy.height * 0.5 + 8) / TILE_SIZE);
            const hasGround =
              col.isSolidAt(state.tileGrid, floorTx, floorTy) ||
              col.isOneWayAt(state.tileGrid, floorTx, floorTy);
            const doorAhead = isClosedWoodDoorAt(
              state.doors,
              aheadX,
              enemy.pos.y,
              enemy.height * 0.5
            );
            enemy.vel.x = hasGround && !doorAhead ? enemy.facing * def.speed * speedMult : 0;
          } else {
            enemy.vel.x *= 0.65;
          }

          // Special attack-range checks (Lancer 4-dir vertical thrust!)
          const lancerVertReady =
            enemy.defId === 'Lancer' && Math.abs(dx) <= 26 && Math.abs(dy) <= 104 && Math.abs(dy) > 28;
          const inAttackY =
            def.flying ||
            lancerVertReady ||
            Math.abs(dy) <= (isRangedKiter ? 130 : 48);

          const canTriggerAttack =
            (dist <= def.attackRange || lancerVertReady) &&
            inAttackY &&
            enemy.attackCooldownTicks <= 0 &&
            (canSee ||
              lancerVertReady ||
              enemy.defId === 'Grenader' ||
              enemy.defId === 'ClusterGrenader' ||
              enemy.defId === 'Protector');

          if (canTriggerAttack) {
            // Dark Tracker (Ninja): teleport behind player FIRST, THEN enter 26t telegraphed windup!
            if (enemy.defId === 'Ninja' && !isRooted && dist >= 44) {
              const dest = findStandableXNearPlayer(state, col, true, 28);
              if (dest) {
                const fromX = enemy.pos.x;
                const fromY = enemy.pos.y;
                enemy.pos.x = dest.x;
                enemy.pos.y = dest.y;
                enemy.prevPos.x = dest.x;
                enemy.prevPos.y = dest.y;
                enemy.facing = player.pos.x >= enemy.pos.x ? 1 : -1;
                enemy.turnDelayTicks = 0;
                state.events.push({
                  type: 'teleport',
                  fromX,
                  fromY,
                  toX: enemy.pos.x,
                  toY: enemy.pos.y,
                });
                state.particlesSim.push({
                  uid: state.nextUid++,
                  pos: { x: enemy.pos.x, y: enemy.pos.y },
                  vel: { x: 0, y: 0 },
                  size: 28,
                  color: '#d966ff',
                  alpha: 0.9,
                  ttlTicks: 14,
                  maxTtlTicks: 14,
                  gravity: 0,
                  emissive: true,
                  kind: 'ring',
                });
              }
            }

            // Pick sub-attack mode for multi-move enemies
            if (enemy.defId === 'PirateChief') {
              enemy.bossAttackId = dist <= 56 ? 'meleeCombo' : 'cannonball';
            } else if (enemy.defId === 'CastleKnight') {
              enemy.bossAttackId = dist > 72 ? 'shieldCharge' : 'leapSlam';
            } else if (enemy.defId === 'Lancer') {
              if (lancerVertReady) {
                enemy.bossAttackId = dy < 0 ? 'thrustUp' : 'thrustDown';
              } else {
                enemy.bossAttackId = 'thrustHoriz';
              }
            } else {
              enemy.bossAttackId = '';
            }

            enemy.state = 'windup';
            const customWindup =
              enemy.defId === 'Ninja'
                ? 26
                : enemy.defId === 'BatKamikaze'
                  ? 26
                  : enemy.defId === 'Scorpio' && dist <= 44
                    ? 14
                    : def.windupTicks;
            enemy.stateTicks = Math.max(14, Math.round(customWindup / speedMult));
            enemy.telegraphTicks = enemy.stateTicks;
            enemy.hitPlayerThisSwing = false;
            enemy.vel.x *= 0.2;
            state.events.push({
              type: 'enemyTelegraph',
              x: enemy.pos.x,
              y: enemy.pos.y - enemy.height * 0.6 - 8,
              enemyUid: enemy.uid,
              unparriable: enemy.defId === 'CastleKnight' && enemy.bossAttackId === 'leapSlam',
            });
          }
        }
      } else if (enemy.state === 'windup') {
        enemy.vel.x *= 0.75;
        if (def.flying) enemy.vel.y *= 0.72;
        enemy.stateTicks -= 1;
        if (enemy.telegraphTicks > 0) enemy.telegraphTicks -= 1;

        // BatKamikaze glowing red swell warning
        if (enemy.defId === 'BatKamikaze' && enemy.stateTicks % 5 === 0) {
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: enemy.pos.x, y: enemy.pos.y },
            vel: { x: 0, y: 0 },
            size: 16 + (26 - enemy.stateTicks) * 1.1,
            color: '#ff4242',
            alpha: 0.9,
            ttlTicks: 8,
            maxTtlTicks: 8,
            gravity: 0,
            emissive: true,
            kind: 'ring',
          });
        }

        // BatDasher sight-line red telegraph sparks
        if (enemy.defId === 'BatDasher' && enemy.stateTicks % 4 === 0) {
          const frac = 0.25 + (1 - enemy.stateTicks / 18) * 0.55;
          state.particlesSim.push({
            uid: state.nextUid++,
            pos: { x: enemy.pos.x + dx * frac, y: enemy.pos.y + dy * frac },
            vel: { x: 0, y: 0 },
            size: 3,
            color: '#ff3b5c',
            alpha: 0.9,
            ttlTicks: 6,
            maxTtlTicks: 6,
            gravity: 0,
            emissive: true,
            kind: 'spark',
          });
        }

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
      dropThroughOneWay,
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
