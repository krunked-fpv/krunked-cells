// =============================================================================
// KRUNKED CELLS — Deterministic Look-Ahead Camera, Vertical Scout Peek,
//                 Fast-Fall Look-Down, Zoom Punch & Screen-Shake Controller
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// Camera (x, y) represents the TOP-LEFT corner of the 480×270 logical viewport.
// =============================================================================

import {
  TILE_SIZE,
  VIEWPORT_H,
  VIEWPORT_W,
  type CameraState,
  type InputFrame,
  type SimState,
} from '../contracts';

const LOOK_AHEAD_X = 46;
const VERTICAL_BIAS_Y = -14;
const PEEK_HOLD_THRESHOLD_TICKS = 12;
const PEEK_DOWN_PX = 68;
const PEEK_UP_PX = -58;
const FAST_FALL_THRESHOLD_VY = 250;
const FAST_FALL_MAX_BIAS_PX = 42;

interface CameraTrackRuntime {
  upHoldTicks: number;
  downHoldTicks: number;
  peekOffsetY: number;
  fallOffsetY: number;
  lookAheadX: number;
}

const cameraRuntimeMap = new WeakMap<CameraState, CameraTrackRuntime>();

function getCameraRuntime(state: SimState): CameraTrackRuntime {
  let rt = cameraRuntimeMap.get(state.camera);
  if (!rt) {
    rt = {
      upHoldTicks: 0,
      downHoldTicks: 0,
      peekOffsetY: 0,
      fallOffsetY: 0,
      lookAheadX: state.player.facing * LOOK_AHEAD_X,
    };
    cameraRuntimeMap.set(state.camera, rt);
  }
  return rt;
}

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

  const lookAhead = player.facing * LOOK_AHEAD_X;
  const desiredX = player.pos.x + lookAhead - VIEWPORT_W * 0.5;
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
  cam.zoom = 1;

  cameraRuntimeMap.set(cam, {
    upHoldTicks: 0,
    downHoldTicks: 0,
    peekOffsetY: 0,
    fallOffsetY: 0,
    lookAheadX: lookAhead,
  });
}

/**
 * Smoothly updates look-ahead camera tracking, vertical scout peek (Up/Down hold
 * or gamepad right-stick `cameraPeekY`), fast-fall look-down bias, zoom punch/decay,
 * clamps cleanly to tileGrid bounds, and decays deterministic screen shake.
 */
export function stepCamera(state: SimState, dt: number, input?: InputFrame): void {
  const cam = state.camera;
  const player = state.player;
  const grid = state.tileGrid;
  const rt = getCameraRuntime(state);

  // Save previous frame position for 120 FPS render interpolation
  cam.prevX = cam.x;
  cam.prevY = cam.y;

  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  const worldW = Math.max(VIEWPORT_W, grid.width * TILE_SIZE);
  const worldH = Math.max(VIEWPORT_H, grid.height * TILE_SIZE);
  const maxX = Math.max(0, worldW - VIEWPORT_W);
  const maxY = Math.max(0, worldH - VIEWPORT_H);

  // Smooth horizontal look-ahead (avoids 1-frame snap-whiplash on rapid turnarounds)
  const desiredLookAheadX = player.facing * LOOK_AHEAD_X;
  const lookSmooth = 1 - Math.exp(-6.5 * safeDt);
  rt.lookAheadX += (desiredLookAheadX - rt.lookAheadX) * lookSmooth;

  // Vertical Scout Peek: Up/Down held >= 12t while grounded & stationary, OR gamepad right stick
  let targetPeekY = 0;
  if (input) {
    const stickY =
      typeof input.cameraPeekY === 'number' && Number.isFinite(input.cameraPeekY)
        ? Math.max(-1, Math.min(1, input.cameraPeekY))
        : 0;

    const canKeyPeek =
      player.grounded &&
      Math.abs(player.vel.x) < 10 &&
      player.actionState !== 'roll' &&
      player.actionState !== 'attack';

    if (canKeyPeek && input.moveDown && !input.moveUp) {
      rt.downHoldTicks += 1;
      rt.upHoldTicks = 0;
    } else if (canKeyPeek && input.moveUp && !input.moveDown) {
      rt.upHoldTicks += 1;
      rt.downHoldTicks = 0;
    } else {
      rt.downHoldTicks = 0;
      rt.upHoldTicks = 0;
    }

    if (Math.abs(stickY) > 0.1) {
      targetPeekY = stickY > 0 ? stickY * PEEK_DOWN_PX : -stickY * PEEK_UP_PX;
    } else if (rt.downHoldTicks >= PEEK_HOLD_THRESHOLD_TICKS) {
      targetPeekY = PEEK_DOWN_PX;
    } else if (rt.upHoldTicks >= PEEK_HOLD_THRESHOLD_TICKS) {
      targetPeekY = PEEK_UP_PX;
    }
  } else {
    rt.downHoldTicks = 0;
    rt.upHoldTicks = 0;
  }

  const peekSmooth = 1 - Math.exp(-7.5 * safeDt);
  rt.peekOffsetY += (targetPeekY - rt.peekOffsetY) * peekSmooth;
  if (Math.abs(rt.peekOffsetY) < 0.05 && targetPeekY === 0) {
    rt.peekOffsetY = 0;
  }

  // Fast-Fall Look-Down Bias (up to +42px when falling > 250 px/s)
  const targetFallBias =
    !player.grounded && player.vel.y > FAST_FALL_THRESHOLD_VY
      ? Math.min(FAST_FALL_MAX_BIAS_PX, (player.vel.y - FAST_FALL_THRESHOLD_VY) * 0.16)
      : 0;
  const fallSmooth = 1 - Math.exp((targetFallBias > rt.fallOffsetY ? -7.5 : -9.0) * safeDt);
  rt.fallOffsetY += (targetFallBias - rt.fallOffsetY) * fallSmooth;
  if (Math.abs(rt.fallOffsetY) < 0.05 && targetFallBias === 0) {
    rt.fallOffsetY = 0;
  }

  // Subtle boss framing bias when boss arena is active
  let focusX = player.pos.x + rt.lookAheadX;
  let focusY = player.pos.y + VERTICAL_BIAS_Y + rt.peekOffsetY + rt.fallOffsetY;
  if (state.bossArenaState.active && state.bossArenaState.bossUid !== null) {
    const boss = state.enemies.find(
      (e) => e.uid === state.bossArenaState.bossUid && e.hp > 0 && e.state !== 'dead'
    );
    if (boss) {
      focusX = player.pos.x * 0.72 + boss.pos.x * 0.28;
      focusY = player.pos.y * 0.8 + boss.pos.y * 0.2 - 12 + rt.peekOffsetY * 0.45 + rt.fallOffsetY * 0.5;
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

  // Subtle Camera Zoom Punch on dramatic impacts & smooth decay back to 1.0
  if (!Number.isFinite(cam.zoom) || cam.zoom <= 0.05) {
    cam.zoom = 1;
  }
  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i]!;
    if (
      ev.type === 'parrySuccess' ||
      ev.type === 'critImpact' ||
      ev.type === 'bossEngage' ||
      ev.type === 'bossPhaseShift'
    ) {
      cam.zoom = Math.max(cam.zoom, 1.045);
    } else if (ev.type === 'doorSmash') {
      cam.zoom = Math.max(cam.zoom, 1.022);
    }
  }
  cam.zoom += (1 - cam.zoom) * 0.14;
  if (Math.abs(cam.zoom - 1) < 0.0004) {
    cam.zoom = 1;
  }

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
