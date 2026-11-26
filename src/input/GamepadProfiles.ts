// =============================================================================
// KRUNKED CELLS — Controller Profiles, Non-Standard HID Normalization,
// Dynamic Action Glyphs, and Safe Dual-Rumble / Touch Haptics.
// Zero browser-only assumptions; safe in Node headless, Desktop, Mobile, Tesla.
// =============================================================================

import {
  DEFAULT_KEY_BINDINGS,
  type ControllerSettings,
  type GamepadConnectionInfo,
  type GamepadGlyphStyle,
  type GamepadLayoutPreset,
  type GamepadVendorFamily,
  type InputDeviceMode,
  type KeyBindings,
  type SimEvent,
  type Vec2,
} from '../contracts';

export type GlyphFamily = 'keyboard' | GamepadVendorFamily | 'touch';

export type ActionGlyphId =
  | 'jump'
  | 'roll'
  | 'weapon1'
  | 'weapon2'
  | 'skill1'
  | 'skill2'
  | 'heal'
  | 'interact'
  | 'equip2'
  | 'recycle'
  | 'map'
  | 'pause'
  | 'confirm'
  | 'cancel';

export interface ActionGlyph {
  label: string;
  styleClass: string;
}

export interface RumblePulse {
  weak: number;
  strong: number;
  durationMs: number;
}

export interface TriggerHysteresisState {
  leftTrigger?: boolean;
  rightTrigger?: boolean;
}

export interface NormalizedGamepadUi {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  cancel: boolean;
  tabPrev: boolean;
  tabNext: boolean;
  pause: boolean;
  map: boolean;
}

export interface NormalizedGamepadState {
  moveLeft: boolean;
  moveRight: boolean;
  moveUp: boolean;
  moveDown: boolean;
  moveX: number;
  moveY: number;
  jump: boolean;
  roll: boolean;
  weapon1: boolean;
  weapon2: boolean;
  skill1: boolean;
  skill2: boolean;
  heal: boolean;
  interact: boolean;
  equip2: boolean;
  recycle: boolean;
  map: boolean;
  pause: boolean;
  aim: Vec2;
  aimActive: boolean;
  cameraPeekY: number;
  leftTriggerHeld: boolean;
  rightTriggerHeld: boolean;
  ui: NormalizedGamepadUi;
  anyActive: boolean;
}

interface RawPadActuators {
  vibrationActuator?: {
    type?: string;
    playEffect?: (
      type: string,
      params: {
        startDelay?: number;
        duration: number;
        weakMagnitude: number;
        strongMagnitude: number;
      }
    ) => Promise<string> | void;
  };
  hapticActuators?: ArrayLike<{
    pulse?: (value: number, duration: number) => Promise<boolean> | void;
  }>;
}

const TRIGGER_ENGAGE_THRESHOLD = 0.35;
const TRIGGER_RELEASE_THRESHOLD = 0.22;
const BUTTON_PRESS_THRESHOLD = 0.45;
const POV_TOLERANCE = 0.08;

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * Detects Tesla in-car Chromium/QtCarBrowser user agents safely.
 */
export function detectTeslaBrowser(userAgent?: string): boolean {
  const ua =
    userAgent !== undefined
      ? userAgent
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
  return /Tesla\/|QtCarBrowser|TeslaCar/i.test(ua);
}

/**
 * Detects physical controller vendor family while preserving recognizable
 * Xbox / PlayStation / Nintendo hardware even inside Tesla's in-car browser.
 */
export function detectGamepadFamily(id: string, isTeslaBrowser = false): GamepadVendorFamily {
  const raw = (id ?? '').toLowerCase();

  // Explicit PlayStation signatures first (before generic wireless/vendor checks)
  if (
    raw.includes('dualsense') ||
    raw.includes('dualshock') ||
    raw.includes('playstation') ||
    raw.includes('054c') ||
    raw.includes('sony') ||
    raw.includes('sixaxis') ||
    /\bps[345]\b/.test(raw)
  ) {
    return 'playstation';
  }

  // Xbox / XInput signatures (checked before generic "wireless controller")
  if (
    raw.includes('xbox') ||
    raw.includes('x-box') ||
    raw.includes('xinput') ||
    raw.includes('045e') ||
    raw.includes('microsoft') ||
    /\b360\b/.test(raw)
  ) {
    return 'xbox';
  }

  // Nintendo Switch / Joy-Con / Pro Controller signatures
  if (
    raw.includes('nintendo') ||
    raw.includes('switch') ||
    raw.includes('joy-con') ||
    raw.includes('joycon') ||
    raw.includes('pro controller') ||
    raw.includes('057e')
  ) {
    return 'nintendo';
  }

  // macOS/iOS/Linux often expose DualShock 4 / DualSense simply as "Wireless Controller"
  if (raw.includes('wireless controller') && !raw.includes('tesla')) {
    return 'playstation';
  }

  // Tesla explicit or generic USB/Bluetooth controller connected inside Tesla Browser
  if (raw.includes('tesla') || isTeslaBrowser) {
    return 'tesla';
  }

  return 'generic';
}

/**
 * Formats a clean, concise, zero-emoji human-readable controller display name.
 */
export function formatGamepadDisplayName(
  id: string,
  family: GamepadVendorFamily,
  isTeslaBrowser = false
): string {
  const raw = (id ?? '').toLowerCase();

  if (family === 'playstation') {
    if (raw.includes('dualsense edge') || raw.includes('0df2')) return 'DualSense Edge Controller';
    if (raw.includes('dualsense') || raw.includes('0ce6') || raw.includes('ps5')) {
      return 'DualSense Controller';
    }
    if (raw.includes('dualshock 4') || raw.includes('09cc') || raw.includes('05c4') || raw.includes('ps4')) {
      return 'DualShock 4 Controller';
    }
    if (raw.includes('dualshock 3') || raw.includes('sixaxis') || raw.includes('ps3')) {
      return 'DualShock 3 Controller';
    }
    return 'PlayStation Controller';
  }

  if (family === 'xbox') {
    if (raw.includes('elite')) return 'Xbox Elite Controller';
    if (raw.includes('series') || raw.includes('0b12') || raw.includes('0b13')) {
      return 'Xbox Series Controller';
    }
    if (raw.includes('360') || raw.includes('028e') || raw.includes('02a1')) {
      return 'Xbox 360 Controller';
    }
    if (raw.includes('wireless') || raw.includes('02fd') || raw.includes('02e0')) {
      return 'Xbox Wireless Controller';
    }
    if (raw.includes('xbox one') || raw.includes('x-box one') || raw.includes('02ea') || raw.includes('02dd')) {
      return 'Xbox One Controller';
    }
    return 'Xbox Controller';
  }

  if (family === 'nintendo') {
    if (raw.includes('pro controller') || raw.includes('switch pro') || raw.includes('2009')) {
      return 'Nintendo Switch Pro';
    }
    if (raw.includes('joy-con') || raw.includes('joycon') || raw.includes('2006') || raw.includes('2007')) {
      return 'Nintendo Joy-Con';
    }
    return 'Nintendo Controller';
  }

  if (raw.includes('f710')) {
    return isTeslaBrowser || family === 'tesla' ? 'Logitech F710 (Tesla USB)' : 'Logitech F710 Gamepad';
  }
  if (raw.includes('f310')) {
    return isTeslaBrowser || family === 'tesla' ? 'Logitech F310 (Tesla USB)' : 'Logitech F310 Gamepad';
  }
  if (raw.includes('logitech') || raw.includes('046d')) {
    return isTeslaBrowser || family === 'tesla' ? 'Logitech Gamepad (Tesla)' : 'Logitech Gamepad';
  }
  if (raw.includes('8bitdo')) {
    return isTeslaBrowser || family === 'tesla' ? '8BitDo Controller (Tesla)' : '8BitDo Controller';
  }
  if (raw.includes('steam deck') || raw.includes('valve')) {
    return 'Steam Deck Controller';
  }
  if (raw.includes('stadia')) {
    return 'Stadia Controller';
  }
  if (raw.includes('backbone')) {
    return 'Backbone One Controller';
  }
  if (raw.includes('kishi') || raw.includes('razer')) {
    return 'Razer Controller';
  }

  if (family === 'tesla' || isTeslaBrowser) {
    if (raw.includes('usb')) return 'Tesla USB Controller';
    return 'Tesla Bluetooth Controller';
  }

  // Strip browser HID suffix metadata and non-ASCII/emoji noise from generic ids
  const stripped = (id ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\b(?:standard\s+gamepad|vendor|product)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length >= 3 && !/^[0-9a-f\-_:]+$/i.test(stripped) && stripped.toLowerCase() !== 'gamepad') {
    return stripped.length > 32 ? `${stripped.slice(0, 29).trim()}...` : stripped;
  }

  return 'USB Gamepad';
}

/**
 * Checks whether a Gamepad instance exposes any supported rumble actuator API.
 */
export function hasGamepadRumbleSupport(pad: Gamepad | null): boolean {
  if (!pad) return false;
  const raw = pad as Gamepad & RawPadActuators;
  if (raw.vibrationActuator && typeof raw.vibrationActuator.playEffect === 'function') {
    return true;
  }
  if (raw.hapticActuators && raw.hapticActuators.length > 0 && typeof raw.hapticActuators[0]?.pulse === 'function') {
    return true;
  }
  return false;
}

/**
 * Applies radial + axial deadzone with clean rescaling to [0, 1].
 */
export function applyStickDeadzone(
  rawX: number,
  rawY: number,
  deadzone: number,
  axialRatio = 0.45
): { x: number; y: number; magnitude: number } {
  const x = Number.isFinite(rawX) ? clamp(rawX, -1, 1) : 0;
  const y = Number.isFinite(rawY) ? clamp(rawY, -1, 1) : 0;
  const dz = clamp(deadzone, 0.05, 0.75);

  const mag = Math.hypot(x, y);
  if (mag <= dz) {
    return { x: 0, y: 0, magnitude: 0 };
  }

  const clampedMag = Math.min(1, mag);
  const rescaledMag = (clampedMag - dz) / Math.max(0.001, 1 - dz);
  let sx = (x / mag) * rescaledMag;
  let sy = (y / mag) * rescaledMag;

  // Axial deadzone cleanup eliminates slight drift on the minor axis
  const axialDz = dz * clamp(axialRatio, 0, 0.9);
  if (Math.abs(x) < axialDz) sx = 0;
  if (Math.abs(y) < axialDz) sy = 0;

  const outMag = Math.min(1, Math.hypot(sx, sy));
  return { x: clamp(sx, -1, 1), y: clamp(sy, -1, 1), magnitude: outMag };
}

function readButtonValue(pad: Gamepad, index: number): number {
  const btn = pad.buttons?.[index];
  if (!btn) return 0;
  if (typeof btn.value === 'number' && Number.isFinite(btn.value)) {
    if (btn.pressed && btn.value <= 0) return 1;
    return clamp01(btn.value);
  }
  return btn.pressed ? 1 : 0;
}

function isButtonHeld(pad: Gamepad, index: number): boolean {
  const btn = pad.buttons?.[index];
  if (!btn) return false;
  return Boolean(btn.pressed || (typeof btn.value === 'number' && btn.value > BUTTON_PRESS_THRESHOLD));
}

function readAxis(pad: Gamepad, index: number): number {
  const v = pad.axes?.[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function decodePovHat(val: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  // Chromium DirectInput neutral is ~3.2857 (> 1.1); 0.0 is also treated as neutral for zero-initialized arrays.
  if (!Number.isFinite(val) || val > 1.1 || val < -1.1 || Math.abs(val) < 0.05) {
    return { up: false, down: false, left: false, right: false };
  }
  const near = (target: number): boolean => Math.abs(val - target) <= POV_TOLERANCE;
  const n = near(-1.0);
  const ne = near(-5 / 7);
  const e = near(-3 / 7);
  const se = near(-1 / 7);
  const s = near(1 / 7);
  const sw = near(3 / 7);
  const w = near(5 / 7);
  const nw = near(1.0);
  return {
    up: n || ne || nw,
    down: s || se || sw,
    left: w || nw || sw,
    right: e || ne || se,
  };
}

function normalizeTriggerAxis(val: number, pairUsesSignedRest: boolean): number {
  if (!Number.isFinite(val)) return 0;
  if (pairUsesSignedRest) {
    // [-1 rest .. +1 full press] -> [0 .. 1]
    return clamp01((val + 1) * 0.5);
  }
  // [0 rest .. +1 full press]
  return val > 0 ? clamp01(val) : 0;
}

function evaluateTriggerWithHysteresis(analogVal: number, digitalPressed: boolean, wasHeld: boolean): boolean {
  if (digitalPressed && analogVal <= 0) {
    return true;
  }
  const threshold = wasHeld ? TRIGGER_RELEASE_THRESHOLD : TRIGGER_ENGAGE_THRESHOLD;
  return analogVal > threshold;
}

interface StandardButtonsSnapshot {
  south: boolean;
  east: boolean;
  west: boolean;
  north: boolean;
  lb: boolean;
  rb: boolean;
  lt: boolean;
  rt: boolean;
  view: boolean;
  menu: boolean;
  l3: boolean;
  r3: boolean;
  dUp: boolean;
  dDown: boolean;
  dLeft: boolean;
  dRight: boolean;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  anyRawButton: boolean;
}

function extractCanonicalPadInputs(
  pad: Gamepad,
  family: GamepadVendorFamily,
  prevTriggers?: TriggerHysteresisState
): StandardButtonsSnapshot {
  const prevLt = Boolean(prevTriggers?.leftTrigger);
  const prevRt = Boolean(prevTriggers?.rightTrigger);
  const btnCount = pad.buttons?.length ?? 0;
  const axisCount = pad.axes?.length ?? 0;
  const rawId = (pad.id ?? '').toLowerCase();

  let anyRawButton = false;
  for (let i = 0; i < btnCount; i++) {
    if (isButtonHeld(pad, i)) {
      anyRawButton = true;
      break;
    }
  }

  // Standard W3C Gamepad Mapping
  if (pad.mapping === 'standard') {
    const ltVal = readButtonValue(pad, 6);
    const rtVal = readButtonValue(pad, 7);
    const ltPressed = Boolean(pad.buttons?.[6]?.pressed);
    const rtPressed = Boolean(pad.buttons?.[7]?.pressed);
    return {
      south: isButtonHeld(pad, 0),
      east: isButtonHeld(pad, 1),
      west: isButtonHeld(pad, 2),
      north: isButtonHeld(pad, 3),
      lb: isButtonHeld(pad, 4),
      rb: isButtonHeld(pad, 5),
      lt: evaluateTriggerWithHysteresis(ltVal, ltPressed, prevLt),
      rt: evaluateTriggerWithHysteresis(rtVal, rtPressed, prevRt),
      view: isButtonHeld(pad, 8),
      menu: isButtonHeld(pad, 9),
      l3: isButtonHeld(pad, 10),
      r3: isButtonHeld(pad, 11),
      dUp: isButtonHeld(pad, 12),
      dDown: isButtonHeld(pad, 13),
      dLeft: isButtonHeld(pad, 14),
      dRight: isButtonHeld(pad, 15),
      lx: readAxis(pad, 0),
      ly: readAxis(pad, 1),
      rx: readAxis(pad, 2),
      ry: readAxis(pad, 3),
      anyRawButton,
    };
  }

  // Non-Standard HID / DirectInput / Linux / Tesla USB Controllers
  const isLogitechDirectInput =
    !rawId.includes('xinput') &&
    (rawId.includes('logitech') ||
      rawId.includes('046d') ||
      rawId.includes('dual action') ||
      rawId.includes('f310') ||
      rawId.includes('f710'));
  const isWindowsPsRawHid = family === 'playstation' && axisCount >= 10;
  const isLinuxXpadRaw = btnCount === 11 && (axisCount === 6 || axisCount === 8);

  // Face button ordering:
  // DirectInput Logitech (D-mode) and Windows raw DualShock/DualSense use [0=West, 1=South, 2=East, 3=North].
  const rotatedFaceButtons = isLogitechDirectInput || isWindowsPsRawHid;
  const south = isButtonHeld(pad, rotatedFaceButtons ? 1 : 0);
  const east = isButtonHeld(pad, rotatedFaceButtons ? 2 : 1);
  const west = isButtonHeld(pad, rotatedFaceButtons ? 0 : 2);
  const north = isButtonHeld(pad, 3);

  const lb = isButtonHeld(pad, 4);
  const rb = isButtonHeld(pad, 5);

  const view = isLinuxXpadRaw ? isButtonHeld(pad, 6) : isButtonHeld(pad, 8);
  const menu = isLinuxXpadRaw ? isButtonHeld(pad, 7) : isButtonHeld(pad, 9);
  const l3 = isLinuxXpadRaw ? isButtonHeld(pad, 9) : isButtonHeld(pad, 10);
  const r3 = isLinuxXpadRaw ? isButtonHeld(pad, 10) : isButtonHeld(pad, 11);

  const lx = readAxis(pad, 0);
  const ly = readAxis(pad, 1);

  let rx = 0;
  let ry = 0;
  let ltAxisVal = 0;
  let rtAxisVal = 0;
  let dUp = isButtonHeld(pad, 12);
  let dDown = isButtonHeld(pad, 13);
  let dLeft = isButtonHeld(pad, 14);
  let dRight = isButtonHeld(pad, 15);

  if (axisCount >= 10) {
    // 10-axis DirectInput HID (Windows DualShock/DualSense, Switch Pro, Logitech D-mode, generic USB w/ POV hat on axis 9)
    const pov = decodePovHat(readAxis(pad, 9));
    dUp = dUp || pov.up;
    dDown = dDown || pov.down;
    dLeft = dLeft || pov.left;
    dRight = dRight || pov.right;

    const ax2 = readAxis(pad, 2);
    const ax3 = readAxis(pad, 3);
    const ax4 = readAxis(pad, 4);
    const ax5 = readAxis(pad, 5);

    if (isWindowsPsRawHid) {
      // Windows raw DualShock 4 / DualSense HID: RStick = (2, 5), L2/R2 = (3, 4) resting at -1
      rx = ax2;
      ry = ax5;
      const psSignedTriggers = ax3 < -0.5 || ax4 < -0.5;
      ltAxisVal = normalizeTriggerAxis(ax3, psSignedTriggers);
      rtAxisVal = normalizeTriggerAxis(ax4, psSignedTriggers);
    } else if (ax2 <= -0.85 || ax5 <= -0.85) {
      // Trigger axes on 2 & 5 resting at -1
      ltAxisVal = normalizeTriggerAxis(ax2, true);
      rtAxisVal = normalizeTriggerAxis(ax5, true);
      rx = ax3;
      ry = ax4;
    } else {
      // DirectInput right stick on (2, 3) or (2, 5) for Logitech D-mode
      rx = ax2;
      ry = isLogitechDirectInput && Math.abs(ax3) < 0.05 && Math.abs(ax5) > 0.05 ? ax5 : ax3;
    }
  } else if (axisCount >= 6) {
    // 6- or 8-axis Linux / Tesla evdev HID: LStick=(0,1), LT=2, RStick=(3,4), RT=5, DPad=(6,7)
    const ax2 = readAxis(pad, 2);
    const ax5 = readAxis(pad, 5);
    const signedTriggers = ax2 < -0.5 || ax5 < -0.5;
    ltAxisVal = normalizeTriggerAxis(ax2, signedTriggers);
    rtAxisVal = normalizeTriggerAxis(ax5, signedTriggers);
    rx = readAxis(pad, 3);
    ry = readAxis(pad, 4);

    if (axisCount >= 8) {
      const dx = readAxis(pad, 6);
      const dy = readAxis(pad, 7);
      if (dx < -0.5) dLeft = true;
      if (dx > 0.5) dRight = true;
      if (dy < -0.5) dUp = true;
      if (dy > 0.5) dDown = true;
    }
  } else {
    // 4-axis non-standard pad
    rx = readAxis(pad, 2);
    ry = readAxis(pad, 3);
  }

  const ltBtnVal = isLinuxXpadRaw ? 0 : readButtonValue(pad, 6);
  const rtBtnVal = isLinuxXpadRaw ? 0 : readButtonValue(pad, 7);
  const ltBtnPressed = !isLinuxXpadRaw && Boolean(pad.buttons?.[6]?.pressed);
  const rtBtnPressed = !isLinuxXpadRaw && Boolean(pad.buttons?.[7]?.pressed);

  const lt = evaluateTriggerWithHysteresis(Math.max(ltBtnVal, ltAxisVal), ltBtnPressed, prevLt);
  const rt = evaluateTriggerWithHysteresis(Math.max(rtBtnVal, rtAxisVal), rtBtnPressed, prevRt);

  return {
    south,
    east,
    west,
    north,
    lb,
    rb,
    lt,
    rt,
    view,
    menu,
    l3,
    r3,
    dUp,
    dDown,
    dLeft,
    dRight,
    lx,
    ly,
    rx,
    ry,
    anyRawButton,
  };
}

/**
 * Normalizes both W3C standard and non-standard HID / DirectInput / Tesla USB
 * gamepads into layout-aware gameplay actions, UI nav signals, aim vector,
 * camera peek, and active-input detection.
 */
export function normalizeGamepadState(
  pad: Gamepad,
  settings: ControllerSettings,
  family: GamepadVendorFamily,
  prevTriggers?: TriggerHysteresisState
): NormalizedGamepadState {
  const deadzone = clamp(settings?.deadzone ?? 0.24, 0.08, 0.5);
  const preset: GamepadLayoutPreset = settings?.layoutPreset ?? 'standard';
  const raw = extractCanonicalPadInputs(pad, family, prevTriggers);

  const leftStick = applyStickDeadzone(raw.lx, raw.ly, deadzone, 0.45);
  const rightStick = applyStickDeadzone(raw.rx, raw.ry, deadzone, 0.22);

  // Horizontal movement triggers immediately once past deadzone; vertical requires
  // deliberate deflection when running horizontally to prevent accidental drops/dives.
  const stickLeft = leftStick.x < -0.05;
  const stickRight = leftStick.x > 0.05;
  const verticalDominant = Math.abs(leftStick.y) >= Math.abs(leftStick.x) * 0.45;
  const stickUp = leftStick.y < -0.05 && verticalDominant;
  const stickDown = leftStick.y > 0.05 && verticalDominant;

  const moveLeft = raw.dLeft || stickLeft;
  const moveRight = raw.dRight || stickRight;
  const moveUp = raw.dUp || stickUp;
  const moveDown = raw.dDown || stickDown;

  // Apply layout preset remapping
  let jump = raw.south;
  let roll = raw.east;
  let weapon1 = raw.west;
  let weapon2 = raw.north;
  let interact = raw.rt;
  let uiConfirm = raw.south;
  let uiCancel = raw.east;

  if (preset === 'classic') {
    // Classic swaps RT=Roll & B(East)=Interact while preserving B as UI Cancel
    roll = raw.rt;
    interact = raw.east;
    uiConfirm = raw.south;
    uiCancel = raw.east;
  } else if (preset === 'nintendo') {
    // Nintendo swaps South/East (B/A) and West/North (Y/X) to match physical labels
    jump = raw.east;
    roll = raw.south;
    weapon1 = raw.north;
    weapon2 = raw.west;
    uiConfirm = raw.east;
    uiCancel = raw.south;
  }

  const skill1 = raw.lb;
  const skill2 = raw.rb;
  const heal = raw.lt;
  const equip2 = raw.r3;
  const recycle = raw.l3;
  const map = raw.view;
  const pause = raw.menu;

  const aimActive = rightStick.magnitude > 0.05;
  const aim: Vec2 = aimActive ? { x: rightStick.x, y: rightStick.y } : { x: 0, y: 0 };
  const cameraPeekY = Math.abs(rightStick.y) > 0.25 ? clamp(rightStick.y, -1, 1) : 0;

  // UI directional navigation uses slightly firmer stick threshold so menus never drift
  const uiStickUp = leftStick.y < -0.35 && Math.abs(leftStick.y) >= Math.abs(leftStick.x) * 0.6;
  const uiStickDown = leftStick.y > 0.35 && Math.abs(leftStick.y) >= Math.abs(leftStick.x) * 0.6;
  const uiStickLeft = leftStick.x < -0.35 && Math.abs(leftStick.x) >= Math.abs(leftStick.y) * 0.6;
  const uiStickRight = leftStick.x > 0.35 && Math.abs(leftStick.x) >= Math.abs(leftStick.y) * 0.6;

  const ui: NormalizedGamepadUi = {
    up: raw.dUp || uiStickUp,
    down: raw.dDown || uiStickDown,
    left: raw.dLeft || uiStickLeft,
    right: raw.dRight || uiStickRight,
    confirm: uiConfirm,
    cancel: uiCancel,
    tabPrev: raw.lb,
    tabNext: raw.rb,
    pause,
    map,
  };

  const anyActive = Boolean(
    raw.anyRawButton ||
      moveLeft ||
      moveRight ||
      moveUp ||
      moveDown ||
      jump ||
      roll ||
      weapon1 ||
      weapon2 ||
      skill1 ||
      skill2 ||
      heal ||
      interact ||
      equip2 ||
      recycle ||
      map ||
      pause ||
      aimActive
  );

  return {
    moveLeft,
    moveRight,
    moveUp,
    moveDown,
    moveX: leftStick.x,
    moveY: leftStick.y,
    jump,
    roll,
    weapon1,
    weapon2,
    skill1,
    skill2,
    heal,
    interact,
    equip2,
    recycle,
    map,
    pause,
    aim,
    aimActive,
    cameraPeekY,
    leftTriggerHeld: raw.lt,
    rightTriggerHeld: raw.rt,
    ui,
    anyActive,
  };
}

/**
 * Resolves the active UI button glyph family based on current input mode,
 * connected controller vendor, and user glyph style override.
 */
export function resolveGlyphFamily(
  mode: InputDeviceMode,
  gamepad: GamepadConnectionInfo | null,
  style: GamepadGlyphStyle
): GlyphFamily {
  if (mode === 'keyboard') return 'keyboard';
  if (mode === 'touch') return 'touch';
  if (style !== 'auto') return style;
  return gamepad?.family ?? 'xbox';
}

function formatKeyCodeShort(code: string): string {
  if (!code) return '?';
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) return `N${code.slice(6)}`;
  switch (code) {
    case 'Space':
      return 'SPC';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'SHIFT';
    case 'ControlLeft':
    case 'ControlRight':
      return 'CTRL';
    case 'AltLeft':
    case 'AltRight':
      return 'ALT';
    case 'Escape':
      return 'ESC';
    case 'Tab':
      return 'TAB';
    case 'Enter':
      return 'ENTER';
    case 'ArrowUp':
      return 'UP';
    case 'ArrowDown':
      return 'DOWN';
    case 'ArrowLeft':
      return 'LEFT';
    case 'ArrowRight':
      return 'RIGHT';
    default:
      return code.toUpperCase().slice(0, 5);
  }
}

function remapActionForLayout(action: ActionGlyphId, layoutPreset: GamepadLayoutPreset): ActionGlyphId {
  if (layoutPreset === 'classic') {
    if (action === 'roll') return 'interact';
    if (action === 'interact') return 'roll';
  } else if (layoutPreset === 'nintendo') {
    if (action === 'jump') return 'roll';
    if (action === 'roll') return 'jump';
    if (action === 'confirm') return 'cancel';
    if (action === 'cancel') return 'confirm';
    if (action === 'weapon1') return 'weapon2';
    if (action === 'weapon2') return 'weapon1';
  }
  return action;
}

/**
 * Returns crisp, zero-emoji button glyph label and CSS badge style class for an action.
 */
export function getActionGlyph(
  action: ActionGlyphId,
  glyphFamily: GlyphFamily,
  keyBindings?: KeyBindings,
  layoutPreset: GamepadLayoutPreset = 'standard'
): ActionGlyph {
  if (glyphFamily === 'keyboard') {
    const kb = keyBindings ?? DEFAULT_KEY_BINDINGS;
    switch (action) {
      case 'jump':
        return { label: formatKeyCodeShort(kb.jump), styleClass: 'kc-gp-key' };
      case 'roll':
        return { label: formatKeyCodeShort(kb.roll), styleClass: 'kc-gp-key' };
      case 'weapon1':
        return { label: formatKeyCodeShort(kb.weapon1), styleClass: 'kc-gp-key' };
      case 'weapon2':
        return { label: formatKeyCodeShort(kb.weapon2), styleClass: 'kc-gp-key' };
      case 'skill1':
        return { label: formatKeyCodeShort(kb.skill1), styleClass: 'kc-gp-key' };
      case 'skill2':
        return { label: formatKeyCodeShort(kb.skill2), styleClass: 'kc-gp-key' };
      case 'heal':
        return { label: formatKeyCodeShort(kb.heal), styleClass: 'kc-gp-key' };
      case 'interact':
        return { label: formatKeyCodeShort(kb.interact), styleClass: 'kc-gp-key' };
      case 'equip2':
        return { label: 'G', styleClass: 'kc-gp-key' };
      case 'recycle':
        return { label: 'X', styleClass: 'kc-gp-key' };
      case 'map':
        return { label: formatKeyCodeShort(kb.map), styleClass: 'kc-gp-key' };
      case 'pause':
        return { label: formatKeyCodeShort(kb.pause), styleClass: 'kc-gp-key' };
      case 'confirm':
        return { label: 'ENTER', styleClass: 'kc-gp-key' };
      case 'cancel':
        return { label: 'ESC', styleClass: 'kc-gp-key' };
    }
  }

  if (glyphFamily === 'touch') {
    switch (action) {
      case 'jump':
        return { label: 'JUMP', styleClass: 'kc-gp-touch' };
      case 'roll':
        return { label: 'ROLL', styleClass: 'kc-gp-touch' };
      case 'weapon1':
        return { label: 'ATK 1', styleClass: 'kc-gp-touch' };
      case 'weapon2':
        return { label: 'ATK 2', styleClass: 'kc-gp-touch' };
      case 'skill1':
        return { label: 'S1', styleClass: 'kc-gp-touch' };
      case 'skill2':
        return { label: 'S2', styleClass: 'kc-gp-touch' };
      case 'heal':
        return { label: 'FLASK', styleClass: 'kc-gp-touch' };
      case 'interact':
        return { label: 'USE', styleClass: 'kc-gp-touch' };
      case 'equip2':
        return { label: 'SLOT 2', styleClass: 'kc-gp-touch' };
      case 'recycle':
        return { label: 'SELL', styleClass: 'kc-gp-touch' };
      case 'map':
        return { label: 'MAP', styleClass: 'kc-gp-touch' };
      case 'pause':
        return { label: 'PAUSE', styleClass: 'kc-gp-touch' };
      case 'confirm':
        return { label: 'TAP', styleClass: 'kc-gp-touch' };
      case 'cancel':
        return { label: 'BACK', styleClass: 'kc-gp-touch' };
    }
  }

  const mapped = remapActionForLayout(action, layoutPreset);

  if (glyphFamily === 'playstation') {
    switch (mapped) {
      case 'jump':
      case 'confirm':
        return { label: '✕', styleClass: 'kc-gp-ps kc-gp-a' };
      case 'roll':
      case 'cancel':
        return { label: '○', styleClass: 'kc-gp-ps kc-gp-b' };
      case 'weapon1':
        return { label: '□', styleClass: 'kc-gp-ps kc-gp-x' };
      case 'weapon2':
        return { label: '△', styleClass: 'kc-gp-ps kc-gp-y' };
      case 'skill1':
        return { label: 'L1', styleClass: 'kc-gp-ps kc-gp-bumper' };
      case 'skill2':
        return { label: 'R1', styleClass: 'kc-gp-ps kc-gp-bumper' };
      case 'heal':
        return { label: 'L2', styleClass: 'kc-gp-ps kc-gp-trigger' };
      case 'interact':
        return { label: 'R2', styleClass: 'kc-gp-ps kc-gp-trigger' };
      case 'equip2':
        return { label: 'R3', styleClass: 'kc-gp-ps kc-gp-bumper' };
      case 'recycle':
        return { label: 'L3', styleClass: 'kc-gp-ps kc-gp-bumper' };
      case 'map':
        return { label: 'SHARE', styleClass: 'kc-gp-ps kc-gp-bumper' };
      case 'pause':
        return { label: 'OPT', styleClass: 'kc-gp-ps kc-gp-bumper' };
    }
  }

  if (glyphFamily === 'nintendo') {
    switch (mapped) {
      case 'jump':
      case 'confirm':
        return { label: 'B', styleClass: 'kc-gp-nintendo kc-gp-a' };
      case 'roll':
      case 'cancel':
        return { label: 'A', styleClass: 'kc-gp-nintendo kc-gp-b' };
      case 'weapon1':
        return { label: 'Y', styleClass: 'kc-gp-nintendo kc-gp-x' };
      case 'weapon2':
        return { label: 'X', styleClass: 'kc-gp-nintendo kc-gp-y' };
      case 'skill1':
        return { label: 'L', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
      case 'skill2':
        return { label: 'R', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
      case 'heal':
        return { label: 'ZL', styleClass: 'kc-gp-nintendo kc-gp-trigger' };
      case 'interact':
        return { label: 'ZR', styleClass: 'kc-gp-nintendo kc-gp-trigger' };
      case 'equip2':
        return { label: 'RS', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
      case 'recycle':
        return { label: 'LS', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
      case 'map':
        return { label: '-', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
      case 'pause':
        return { label: '+', styleClass: 'kc-gp-nintendo kc-gp-bumper' };
    }
  }

  // Xbox / Tesla / Generic
  switch (mapped) {
    case 'jump':
    case 'confirm':
      return { label: 'A', styleClass: 'kc-gp-a' };
    case 'roll':
    case 'cancel':
      return { label: 'B', styleClass: 'kc-gp-b' };
    case 'weapon1':
      return { label: 'X', styleClass: 'kc-gp-x' };
    case 'weapon2':
      return { label: 'Y', styleClass: 'kc-gp-y' };
    case 'skill1':
      return { label: 'LB', styleClass: 'kc-gp-bumper' };
    case 'skill2':
      return { label: 'RB', styleClass: 'kc-gp-bumper' };
    case 'heal':
      return { label: 'LT', styleClass: 'kc-gp-trigger' };
    case 'interact':
      return { label: 'RT', styleClass: 'kc-gp-trigger' };
    case 'equip2':
      return { label: 'RS', styleClass: 'kc-gp-bumper' };
    case 'recycle':
      return { label: 'LS', styleClass: 'kc-gp-bumper' };
    case 'map':
      return { label: 'VIEW', styleClass: 'kc-gp-bumper' };
    case 'pause':
      return { label: 'MENU', styleClass: 'kc-gp-bumper' };
  }
}

/**
 * Fires dual-rumble haptic feedback safely on supported Gamepad actuators.
 * Never throws in unsupported browsers (Safari, Tesla, Firefox, Node).
 */
export function triggerGamepadRumble(
  pad: Gamepad | null,
  weak: number,
  strong: number,
  durationMs: number,
  intensity = 1
): void {
  if (!pad || !pad.connected) return;
  const scale = clamp01(intensity);
  if (scale <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;

  const weakMagnitude = clamp01(weak * scale);
  const strongMagnitude = clamp01(strong * scale);
  if (weakMagnitude <= 0 && strongMagnitude <= 0) return;

  const duration = Math.max(10, Math.min(2000, Math.round(durationMs)));
  const raw = pad as Gamepad & RawPadActuators;

  try {
    if (raw.vibrationActuator && typeof raw.vibrationActuator.playEffect === 'function') {
      const res = raw.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude,
        strongMagnitude,
      });
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
      return;
    }

    if (raw.hapticActuators && raw.hapticActuators.length > 0) {
      const actuator = raw.hapticActuators[0];
      if (actuator && typeof actuator.pulse === 'function') {
        const res = actuator.pulse(Math.max(weakMagnitude, strongMagnitude), duration);
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    }
  } catch {
    // Gracefully ignore unsupported browser haptic implementations
  }
}

/**
 * Safely triggers short mobile touch vibration via navigator.vibrate when supported.
 */
export function triggerTouchHaptic(durationMs: number, enabled: boolean): void {
  if (!enabled || !Number.isFinite(durationMs) || durationMs <= 0) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(Math.max(5, Math.min(200, Math.round(durationMs))));
  } catch {
    // Ignore restricted/unsupported vibration contexts
  }
}

/**
 * Selects the strongest rumble pulse from a tick's simulation events.
 */
export function computeEventRumble(events: readonly SimEvent[]): RumblePulse | null {
  if (!events || events.length === 0) return null;

  let best: RumblePulse | null = null;
  let bestScore = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;

    let candidate: RumblePulse | null = null;
    switch (ev.type) {
      case 'playerDeath':
        candidate = { weak: 0.9, strong: 1.0, durationMs: 420 };
        break;
      case 'bossPhaseShift':
        candidate = { weak: 0.75, strong: 0.9, durationMs: 320 };
        break;
      case 'parrySuccess':
        candidate = { weak: 0.85, strong: 0.7, durationMs: 140 };
        break;
      case 'diveSlamImpact':
        candidate = { weak: 0.65, strong: 0.8, durationMs: 170 };
        break;
      case 'explosion':
        candidate = { weak: 0.6, strong: 0.75, durationMs: 180 };
        break;
      case 'playerDamaged':
        candidate = { weak: 0.55, strong: 0.72, durationMs: 160 };
        break;
      case 'critImpact':
        candidate = { weak: 0.65, strong: 0.45, durationMs: 95 };
        break;
      case 'doorSmash':
        candidate = { weak: 0.5, strong: 0.55, durationMs: 110 };
        break;
      case 'hitImpact':
        candidate = ev.breach
          ? { weak: 0.48, strong: 0.35, durationMs: 85 }
          : { weak: 0.3, strong: 0.18, durationMs: 55 };
        break;
      default:
        break;
    }

    if (candidate) {
      const score = candidate.strong * 1.25 + candidate.weak * 0.75 + candidate.durationMs * 0.0005;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  return best;
}
