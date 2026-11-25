// =============================================================================
// KRUNKED CELLS — Deterministic Look-Ahead Camera & Screen-Shake Controller
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// Camera (x, y) represents the TOP-LEFT corner of the 480×270 logical viewport.
// =============================================================================

import { TILE_SIZE, VIEWPORT_H, VIEWPORT_W, type SimState } from '../contracts';

const LOOK_AHEAD_X = 46;
const VERTICAL_BIAS_Y = -14;

/**
 * Immediately snaps camera to player with look-ahead and saves prevX/prevY.
 * Call after biome transitions, warps, or teleports to avoid a 1-frame camera streak.
 */
export function snapCameraToPlayer(state: SimState): void {
  const cam = state.camera;
  const player = state.player;
  const grid = state.tileGrid;

  const worldW = grid.width * TILE_SIZE;
  const worldH = grid.height * TILE_SIZE;
  const maxX = Math.max(0, worldW - VIEWPORT_W);
  const maxY = Math.max(0, worldH - VIEWPORT_H);

  const desiredX = player.pos.x + player.facing * LOOK_AHEAD_X - VIEWPORT_W * 0.5;
  const desiredY = player.pos.y + VERTICAL_BIAS_Y - VIEWPORT_H * 0.5;

  const clampedX = Math.max(0, Math.min(maxX, desiredX));
  const clampedY = Math.max(0, Math.min(maxY, desiredY));

  cam.x = clampedX;
  cam.y = clampedY;
  cam.prevX = clampedX;
  cam.prevY = clampedY;
  cam.targetX = clampedX;
  cam.targetY = clampedY;
  cam.shakeX = 0;
  cam.shakeY = 0;
  cam.shakeMagnitude = 0;
  if (cam.zoom <= 0.05) cam.zoom = 1;
}

/**
 * Smoothly updates look-ahead camera tracking, clamps cleanly to tileGrid bounds,
 * and decays deterministic screen shake (derived strictly from `state.tick`).
 */
export function stepCamera(state: SimState, dt: number): void {
  const cam = state.camera;
  const player = state.player;
  const grid = state.tileGrid;

  // Save previous frame position for 120 FPS render interpolation
  cam.prevX = cam.x;
  cam.prevY = cam.y;

  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  const worldW = Math.max(VIEWPORT_W, grid.width * TILE_SIZE);
  const worldH = Math.max(VIEWPORT_H, grid.height * TILE_SIZE);
  const maxX = Math.max(0, worldW - VIEWPORT_W);
  const maxY = Math.max(0, worldH - VIEWPORT_H);

  // Subtle boss framing bias when boss arena is active
  let focusX = player.pos.x + player.facing * LOOK_AHEAD_X;
  let focusY = player.pos.y + VERTICAL_BIAS_Y;
  if (state.bossArenaState.active && state.bossArenaState.bossUid !== null) {
    const boss = state.enemies.find(
      (e) => e.uid === state.bossArenaState.bossUid && e.hp > 0 && e.state !== 'dead'
    );
    if (boss) {
      focusX = player.pos.x * 0.72 + boss.pos.x * 0.28;
      focusY = player.pos.y * 0.8 + boss.pos.y * 0.2 - 12;
    }
  }

  cam.targetX = Math.max(0, Math.min(maxX, focusX - VIEWPORT_W * 0.5));
  cam.targetY = Math.max(0, Math.min(maxY, focusY - VIEWPORT_H * 0.5));

  const smoothX = 1 - Math.exp(-8.5 * safeDt);
  const smoothY = 1 - Math.exp(-7.0 * safeDt);

  cam.x += (cam.targetX - cam.x) * smoothX;
  cam.y += (cam.targetY - cam.y) * smoothY;

  cam.x = Math.max(0, Math.min(maxX, cam.x));
  cam.y = Math.max(0, Math.min(maxY, cam.y));

  // Deterministic pseudo-shake derived strictly from state.tick
  if (state.screenShake > cam.shakeMagnitude) {
    cam.shakeMagnitude = state.screenShake;
  }
  state.screenShake = Math.max(0, state.screenShake * 0.8 - 0.12);

  if (cam.shakeMagnitude > 0.05) {
    const angle = state.tick * 2.399963229728653; // Golden-angle deterministic stride
    const secondary = state.tick * 4.1887902047863905;
    cam.shakeX = Math.cos(angle) * cam.shakeMagnitude;
    cam.shakeY = Math.sin(secondary) * cam.shakeMagnitude * 0.85;
    cam.shakeMagnitude = Math.max(0, cam.shakeMagnitude * 0.84 - 0.14);
  } else {
    cam.shakeMagnitude = 0;
    cam.shakeX = 0;
    cam.shakeY = 0;
  }
}
