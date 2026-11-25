// =============================================================================
// KRUNKED CELLS — Swept Sub-Stepped AABB Collision & Tile Raycasting (LOS)
// Zero wall/floor tunneling at any velocity (sub-steps whenever |v*dt| > 10 px).
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// =============================================================================

import {
  TILE_SIZE,
  TileKind,
  type CollisionAPI,
  type SweepResult,
  type TileGrid,
  type TileKindValue,
} from '../contracts';

const EPS = 0.001;
const MAX_SUBSTEP_PX = 8;

export function getTile(grid: TileGrid, tx: number, ty: number): TileKindValue {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) {
    return TileKind.SOLID;
  }
  return grid.tiles[ty * grid.width + tx] as TileKindValue;
}

export function setTile(grid: TileGrid, tx: number, ty: number, kind: TileKindValue): void {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) {
    return;
  }
  grid.tiles[ty * grid.width + tx] = kind;
}

export function isSolidTile(kind: TileKindValue): boolean {
  return (
    kind === TileKind.SOLID ||
    kind === TileKind.SECRET_WALL ||
    kind === TileKind.CRACKED_FLOOR
  );
}

export function isSolidAt(grid: TileGrid, tx: number, ty: number): boolean {
  return isSolidTile(getTile(grid, tx, ty));
}

export function isOneWayAt(grid: TileGrid, tx: number, ty: number): boolean {
  return getTile(grid, tx, ty) === TileKind.ONE_WAY;
}

export function isClimbableAt(grid: TileGrid, tx: number, ty: number): boolean {
  const kind = getTile(grid, tx, ty);
  return kind === TileKind.LADDER || kind === TileKind.CHAIN;
}

export function isHazardAt(grid: TileGrid, tx: number, ty: number): TileKindValue | 0 {
  const kind = getTile(grid, tx, ty);
  if (kind === TileKind.SPIKES || kind === TileKind.ACID) {
    return kind;
  }
  return 0;
}

function shatterCrackedFloorRun(grid: TileGrid, tx: number, ty: number): void {
  setTile(grid, tx, ty, TileKind.EMPTY);
  // Also shatter immediately contiguous cracked tiles on the same row (up to 2 tiles each way)
  for (let dx = -1; dx >= -2; dx--) {
    if (getTile(grid, tx + dx, ty) === TileKind.CRACKED_FLOOR) {
      setTile(grid, tx + dx, ty, TileKind.EMPTY);
    } else {
      break;
    }
  }
  for (let dx = 1; dx <= 2; dx++) {
    if (getTile(grid, tx + dx, ty) === TileKind.CRACKED_FLOOR) {
      setTile(grid, tx + dx, ty, TileKind.EMPTY);
    } else {
      break;
    }
  }
}

/**
 * Resolves swept AABB movement in separate X then Y passes with automatic
 * sub-stepping whenever `|v * dt| > 10` px to guarantee zero tunneling.
 * Coordinates `(x, y)` represent the TOP-LEFT corner of the `w × h` AABB.
 */
export function sweepAabb(
  grid: TileGrid,
  x: number,
  y: number,
  w: number,
  h: number,
  vx: number,
  vy: number,
  dt: number,
  dropThroughOneWay: boolean,
  breakCrackedFloor: boolean
): SweepResult {
  let curX = Number.isFinite(x) ? x : 0;
  let curY = Number.isFinite(y) ? y : 0;
  let curVx = Number.isFinite(vx) ? vx : 0;
  let curVy = Number.isFinite(vy) ? vy : 0;
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;

  let hitLeft = false;
  let hitRight = false;
  let hitCeiling = false;
  let hitFloor = false;
  let onOneWay = false;
  let wallSlamSpeed = 0;
  let crackedFloorHit = false;

  const totalDx = curVx * safeDt;
  const totalDy = curVy * safeDt;
  const maxMove = Math.max(Math.abs(totalDx), Math.abs(totalDy));
  const steps = maxMove > 10 ? Math.ceil(maxMove / MAX_SUBSTEP_PX) : 1;
  const subDt = safeDt / steps;

  for (let s = 0; s < steps; s++) {
    // -------------------------------------------------------------------------
    // 1. Horizontal Sweep (X)
    // -------------------------------------------------------------------------
    const stepDx = curVx * subDt;
    if (stepDx !== 0) {
      curX += stepDx;
      const tyMin = Math.floor((curY + EPS) / TILE_SIZE);
      const tyMax = Math.floor((curY + h - EPS) / TILE_SIZE);

      if (stepDx > 0) {
        const tx = Math.floor((curX + w - EPS) / TILE_SIZE);
        for (let ty = tyMin; ty <= tyMax; ty++) {
          if (isSolidAt(grid, tx, ty)) {
            curX = tx * TILE_SIZE - w;
            hitRight = true;
            const speed = Math.abs(curVx);
            if (speed > wallSlamSpeed) wallSlamSpeed = speed;
            curVx = 0;
            break;
          }
        }
      } else {
        const tx = Math.floor((curX + EPS) / TILE_SIZE);
        for (let ty = tyMin; ty <= tyMax; ty++) {
          if (isSolidAt(grid, tx, ty)) {
            curX = (tx + 1) * TILE_SIZE;
            hitLeft = true;
            const speed = Math.abs(curVx);
            if (speed > wallSlamSpeed) wallSlamSpeed = speed;
            curVx = 0;
            break;
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. Vertical Sweep (Y)
    // -------------------------------------------------------------------------
    const stepDy = curVy * subDt;
    if (stepDy !== 0) {
      const prevBottom = curY + h;
      curY += stepDy;
      const txMin = Math.floor((curX + EPS) / TILE_SIZE);
      const txMax = Math.floor((curX + w - EPS) / TILE_SIZE);

      if (stepDy > 0) {
        const ty = Math.floor((curY + h - EPS) / TILE_SIZE);
        let blockedSolid = false;
        let blockedOneWay = false;

        for (let tx = txMin; tx <= txMax; tx++) {
          const kind = getTile(grid, tx, ty);
          if (kind === TileKind.CRACKED_FLOOR) {
            if (breakCrackedFloor) {
              shatterCrackedFloorRun(grid, tx, ty);
              crackedFloorHit = true;
            } else {
              blockedSolid = true;
            }
          } else if (kind === TileKind.SOLID || kind === TileKind.SECRET_WALL) {
            blockedSolid = true;
          } else if (
            kind === TileKind.ONE_WAY &&
            !dropThroughOneWay &&
            prevBottom <= ty * TILE_SIZE + 2.5
          ) {
            blockedOneWay = true;
          }
        }

        if (blockedSolid) {
          curY = ty * TILE_SIZE - h;
          hitFloor = true;
          onOneWay = false;
          curVy = 0;
        } else if (blockedOneWay) {
          curY = ty * TILE_SIZE - h;
          hitFloor = true;
          onOneWay = true;
          curVy = 0;
        }
      } else {
        const ty = Math.floor((curY + EPS) / TILE_SIZE);
        for (let tx = txMin; tx <= txMax; tx++) {
          if (isSolidAt(grid, tx, ty)) {
            curY = (ty + 1) * TILE_SIZE;
            hitCeiling = true;
            curVy = 0;
            break;
          }
        }
      }
    }
  }

  // If moving purely horizontally (vy === 0), probe 1px below feet to maintain grounded contact
  if (!hitFloor && curVy === 0) {
    const footY = curY + h;
    const ty = Math.floor((footY + 0.5) / TILE_SIZE);
    const alignedToTileTop = Math.abs(footY - ty * TILE_SIZE) <= 1.5;
    if (alignedToTileTop) {
      const txMin = Math.floor((curX + EPS) / TILE_SIZE);
      const txMax = Math.floor((curX + w - EPS) / TILE_SIZE);
      for (let tx = txMin; tx <= txMax; tx++) {
        const kind = getTile(grid, tx, ty);
        if (isSolidTile(kind)) {
          hitFloor = true;
          onOneWay = false;
          break;
        }
        if (kind === TileKind.ONE_WAY && !dropThroughOneWay) {
          hitFloor = true;
          onOneWay = true;
        }
      }
    }
  }

  return {
    x: curX,
    y: curY,
    vx: curVx,
    vy: curVy,
    hitLeft,
    hitRight,
    hitCeiling,
    hitFloor,
    onOneWay,
    wallSlamSpeed,
    crackedFloorHit,
  };
}

/**
 * Exact Amanatides-Woo grid DDA raycast returning true iff no `SOLID` (or
 * `SECRET_WALL`) tile blocks the line segment from `(x0, y0)` to `(x1, y1)`.
 */
export function hasLineOfSight(
  grid: TileGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return false;
  }

  const gx0 = x0 / TILE_SIZE;
  const gy0 = y0 / TILE_SIZE;
  const gx1 = x1 / TILE_SIZE;
  const gy1 = y1 / TILE_SIZE;

  let tx = Math.floor(gx0);
  let ty = Math.floor(gy0);
  const endTx = Math.floor(gx1);
  const endTy = Math.floor(gy1);

  const isBlocking = (cx: number, cy: number): boolean => {
    const k = getTile(grid, cx, cy);
    return k === TileKind.SOLID || k === TileKind.SECRET_WALL;
  };

  if (isBlocking(tx, ty)) return false;
  if (tx === endTx && ty === endTy) return true;

  const dx = gx1 - gx0;
  const dy = gy1 - gy0;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;

  let tMaxX =
    stepX > 0
      ? (tx + 1 - gx0) * tDeltaX
      : stepX < 0
        ? (gx0 - tx) * tDeltaX
        : Number.POSITIVE_INFINITY;
  let tMaxY =
    stepY > 0
      ? (ty + 1 - gy0) * tDeltaY
      : stepY < 0
        ? (gy0 - ty) * tDeltaY
        : Number.POSITIVE_INFINITY;

  const maxSteps = Math.abs(endTx - tx) + Math.abs(endTy - ty) + 2;
  for (let i = 0; i < maxSteps; i++) {
    if (tMaxX < tMaxY) {
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      ty += stepY;
      tMaxY += tDeltaY;
    }

    if (isBlocking(tx, ty)) {
      return false;
    }
    if (tx === endTx && ty === endTy) {
      return true;
    }
  }

  return true;
}

export const collisionApi: CollisionAPI = {
  getTile,
  setTile,
  isSolidTile,
  isSolidAt,
  isOneWayAt,
  isClimbableAt,
  isHazardAt,
  sweepAabb,
  hasLineOfSight,
};
