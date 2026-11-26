// =============================================================================
// KRUNKED CELLS — Strict Mobile / Touch / Tesla Environment Detector
// Ensures touch controls ONLY show when mobile/touch is genuinely sensed —
// never falsely triggered on desktop mouse/keyboard PCs.
// Headless Node safe.
// =============================================================================

import type { InputDeviceMode, TouchControlsMode } from '../contracts';
import { detectTeslaBrowser } from './GamepadProfiles';

export const SYNTHETIC_MOUSE_SUPPRESS_MS = 750;

const MOBILE_OR_TESLA_UA_REGEX = /Android|iPhone|iPad|iPod|Mobile|Tablet|Tesla|QtCarBrowser/i;

export interface TouchEnvSnapshot {
  userAgent?: string;
  maxTouchPoints?: number;
  hasOntouchstart?: boolean;
  pointerCoarse?: boolean;
  hoverNone?: boolean;
  matchMedia?: (query: string) => { matches: boolean };
}

export interface InitialTouchDetectionResult {
  touchSensed: boolean;
  isTeslaBrowser: boolean;
  initialMode: InputDeviceMode;
}

/**
 * Inspects pointer media queries, UA, and touch APIs conservatively so desktop
 * mouse/keyboard browsers never falsely activate touch controls on load, even
 * when Chromium exposes ontouchstart or maxTouchPoints > 0.
 */
export function detectInitialTouchEnvironment(env?: TouchEnvSnapshot): InitialTouchDetectionResult {
  const hasExplicitEnv = env !== undefined;

  const userAgent =
    env?.userAgent !== undefined
      ? env.userAgent
      : !hasExplicitEnv && typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';

  const maxTouchPoints =
    env?.maxTouchPoints !== undefined
      ? env.maxTouchPoints
      : !hasExplicitEnv && typeof navigator !== 'undefined' && typeof navigator.maxTouchPoints === 'number'
        ? navigator.maxTouchPoints
        : 0;

  const hasOntouchstart =
    env?.hasOntouchstart !== undefined
      ? env.hasOntouchstart
      : !hasExplicitEnv && typeof window !== 'undefined' && 'ontouchstart' in window;

  const mm =
    env?.matchMedia !== undefined
      ? env.matchMedia
      : !hasExplicitEnv && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (q: string) => window.matchMedia(q)
        : null;

  const pointerCoarse =
    typeof env?.pointerCoarse === 'boolean'
      ? env.pointerCoarse
      : mm
        ? Boolean(mm('(pointer: coarse)')?.matches)
        : false;

  const hoverNone =
    typeof env?.hoverNone === 'boolean'
      ? env.hoverNone
      : mm
        ? Boolean(mm('(hover: none)')?.matches)
        : false;

  const isTeslaBrowser = detectTeslaBrowser(userAgent);
  const coarseAndNoHover = pointerCoarse && hoverNone;
  const isMobileOrTeslaUa = MOBILE_OR_TESLA_UA_REGEX.test(userAgent);
  const hasTouchApi = maxTouchPoints > 0 || hasOntouchstart;

  const touchSensed = coarseAndNoHover || (isMobileOrTeslaUa && hasTouchApi);
  const initialMode: InputDeviceMode = touchSensed ? 'touch' : 'keyboard';

  return {
    touchSensed,
    isTeslaBrowser,
    initialMode,
  };
}

/**
 * Runtime input mode & touch visibility state machine with 750ms synthetic
 * post-touch mouse suppression and seamless keyboard/mouse/gamepad/touch handoff.
 */
export class TouchDetector {
  private _touchSensed: boolean;
  private _isTeslaBrowser: boolean;
  private _activeMode: InputDeviceMode;
  private _lastTouchTimeMs = -Infinity;

  constructor(env?: TouchEnvSnapshot) {
    const init = detectInitialTouchEnvironment(env);
    this._touchSensed = init.touchSensed;
    this._isTeslaBrowser = init.isTeslaBrowser;
    this._activeMode = init.initialMode;
  }

  public get touchSensed(): boolean {
    return this._touchSensed;
  }

  public get isTeslaBrowser(): boolean {
    return this._isTeslaBrowser;
  }

  public get activeMode(): InputDeviceMode {
    return this._activeMode;
  }

  public get lastTouchTimeMs(): number {
    return this._lastTouchTimeMs;
  }

  private resolveNow(nowMs?: number): number {
    if (typeof nowMs === 'number' && Number.isFinite(nowMs)) {
      return nowMs;
    }
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Returns true if a mouse event occurring at `nowMs` falls within the 750ms
   * synthetic-mouse suppression window following a real touch event.
   */
  public isWithinSyntheticMouseWindow(nowMs?: number): boolean {
    if (!Number.isFinite(this._lastTouchTimeMs)) return false;
    const t = this.resolveNow(nowMs);
    const delta = t - this._lastTouchTimeMs;
    return delta >= 0 && delta < SYNTHETIC_MOUSE_SUPPRESS_MS;
  }

  /**
   * Records genuine touch activity. Marks touch as sensed, switches activeMode
   * to 'touch', updates synthetic-mouse suppression timestamp, and returns true
   * if visible state changed.
   */
  public recordTouchActivity(nowMs?: number): boolean {
    const t = this.resolveNow(nowMs);
    this._lastTouchTimeMs = t;
    const changed = !this._touchSensed || this._activeMode !== 'touch';
    this._touchSensed = true;
    this._activeMode = 'touch';
    return changed;
  }

  /**
   * Records mouse activity. Ignores synthetic mouse events within 750ms of
   * recent touch activity; otherwise switches activeMode to 'keyboard'.
   */
  public recordMouseActivity(nowMs?: number): boolean {
    if (this.isWithinSyntheticMouseWindow(nowMs)) {
      return false;
    }
    if (this._activeMode === 'keyboard') {
      return false;
    }
    this._activeMode = 'keyboard';
    return true;
  }

  /**
   * Records keyboard activity and switches activeMode to 'keyboard'.
   */
  public recordKeyboardActivity(): boolean {
    if (this._activeMode === 'keyboard') {
      return false;
    }
    this._activeMode = 'keyboard';
    return true;
  }

  /**
   * Records active physical gamepad input, switching activeMode to 'gamepad'
   * (automatically hiding touch sticks on Tesla/iPad/Android when a controller is used).
   */
  public recordGamepadActivity(): boolean {
    if (this._activeMode === 'gamepad') {
      return false;
    }
    this._activeMode = 'gamepad';
    return true;
  }

  /**
   * Evaluates whether virtual touch controls should be shown under the active TouchControlsMode.
   */
  public shouldShowTouchControls(touchMode: TouchControlsMode): boolean {
    if (touchMode === 'off') return false;
    if (touchMode === 'always') return true;
    return this._touchSensed && this._activeMode === 'touch';
  }
}
