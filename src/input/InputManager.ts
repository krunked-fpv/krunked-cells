// =============================================================================
// KRUNKED CELLS — Unified Keyboard + Mouse + Multi-Gamepad + Touch Input Manager
// Edge-triggered Pressed latches guarantee zero dropped inputs at 30/60/120 FPS.
// Accurate 16:9 letterbox world-space aim, multi-controller active-pad switching,
// UI directional navigation with repeat, dual-rumble haptics, and strict touch detection.
// =============================================================================

import {
  CameraState,
  ControllerSettings,
  DEFAULT_CONTROLLER_SETTINGS,
  DEFAULT_KEY_BINDINGS,
  GamepadConnectionInfo,
  InputFrame,
  KeyBindings,
  SimCommand,
  SimEvent,
  UiNavAction,
  VIEWPORT_H,
  VIEWPORT_W,
  Vec2,
  VirtualControlAction,
  ActiveInputSnapshot,
  createEmptyInputFrame,
} from '../contracts';
import {
  NormalizedGamepadState,
  computeEventRumble,
  detectGamepadFamily,
  formatGamepadDisplayName,
  hasGamepadRumbleSupport,
  normalizeGamepadState,
  resolveGlyphFamily,
  triggerGamepadRumble,
  triggerTouchHaptic,
} from './GamepadProfiles';
import { TouchDetector } from './TouchDetector';

export type KeyAction = keyof KeyBindings;
export type CameraOriginMode = 'auto' | 'topLeft' | 'center';

export interface InputHotkeys {
  onToggleDevDrawer?: () => void;
  onTogglePause?: () => void;
  onToggleMap?: () => void;
  onScrollShortcut?: (index: 0 | 1 | 2) => void;
  onLootShortcut?: (action: 'equip1' | 'equip2' | 'recycle') => boolean | void;
  isScrollModalOpen?: () => boolean;
  isGameplayMouseAllowed?: () => boolean;
  isGameplayKeysAllowed?: () => boolean;
  onUiNav?: (action: UiNavAction) => boolean | void;
  onGamepadConnectionChange?: (info: GamepadConnectionInfo, connected: boolean) => void;
  onInputModeChange?: (snapshot: ActiveInputSnapshot) => void;
  isUiNavActive?: () => boolean;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const UI_NAV_INITIAL_DELAY_MS = 320;
const UI_NAV_REPEAT_INTERVAL_MS = 115;
const VIRTUAL_MOVE_DEADZONE_X = 0.18;
const VIRTUAL_MOVE_DEADZONE_Y = 0.22;
const VIRTUAL_AIM_DEADZONE = 0.12;
const VIRTUAL_PEEK_DEADZONE = 0.25;
const AIM_PROJECTION_DIST = 120;

const ARROW_FALLBACKS: Partial<Record<KeyAction, string[]>> = {
  moveLeft: ['ArrowLeft'],
  moveRight: ['ArrowRight'],
  moveUp: ['ArrowUp'],
  moveDown: ['ArrowDown'],
  roll: ['ShiftRight'],
};

const INTERACTIVE_UI_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  '.kc-modal-backdrop',
  '.kc-title-backdrop',
  '.kc-dev-drawer',
  '.kc-loot-card',
  '.kc-merchant-bar',
  '.kc-tube-card',
  '.kc-minimap-shell',
  '.kc-interact-prompt',
  '.kc-flask-widget',
  '.kc-passage-quickbar',
  '.kc-touch-controls',
].join(', ');

function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

function nowHighResMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Computes the fitted 16:9 (480x270) content rectangle inside a canvas element
 * that uses `object-fit: contain`.
 */
export function computeCanvasDrawRect(canvas: HTMLCanvasElement | null): ViewportRect {
  if (!canvas) {
    return { left: 0, top: 0, width: VIEWPORT_W, height: VIEWPORT_H };
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { left: rect.left, top: rect.top, width: VIEWPORT_W, height: VIEWPORT_H };
  }
  const targetAspect = VIEWPORT_W / VIEWPORT_H;
  const rectAspect = rect.width / rect.height;
  let drawW = rect.width;
  let drawH = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (rectAspect > targetAspect) {
    drawW = rect.height * targetAspect;
    offsetX = (rect.width - drawW) * 0.5;
  } else {
    drawH = rect.width / targetAspect;
    offsetY = (rect.height - drawH) * 0.5;
  }
  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    width: drawW,
    height: drawH,
  };
}

export function resolveCameraTopLeft(
  camera: CameraState,
  playerPos?: Vec2,
  mode: CameraOriginMode = 'auto',
  interpAlpha = 1
): Vec2 {
  const cx = camera.prevX + (camera.x - camera.prevX) * interpAlpha + camera.shakeX;
  const cy = camera.prevY + (camera.y - camera.prevY) * interpAlpha + camera.shakeY;
  const zoom = camera.zoom > 0.05 ? camera.zoom : 1;

  let isCenter = mode === 'center';
  if (mode === 'auto' && playerPos) {
    const halfW = VIEWPORT_W / (2 * zoom);
    const halfH = VIEWPORT_H / (2 * zoom);
    const dx = Math.abs(playerPos.x - cx);
    const dy = Math.abs(playerPos.y - cy);
    if (cx >= halfW * 0.9 && cy >= halfH * 0.85 && dx < halfW * 0.42 && dy < halfH * 0.42) {
      isCenter = true;
    }
  }

  if (isCenter) {
    return {
      x: cx - VIEWPORT_W / (2 * zoom),
      y: cy - VIEWPORT_H / (2 * zoom),
    };
  }
  return { x: cx, y: cy };
}

interface PolledGamepadFrame {
  moveLeft: boolean;
  moveRight: boolean;
  moveUp: boolean;
  moveDown: boolean;
  jump: boolean;
  jumpPressed: boolean;
  rollPressed: boolean;
  weapon1Pressed: boolean;
  weapon1Held: boolean;
  weapon2Pressed: boolean;
  weapon2Held: boolean;
  skill1Pressed: boolean;
  skill2Pressed: boolean;
  healPressed: boolean;
  interactPressed: boolean;
  mapTogglePressed: boolean;
  cameraPeekY: number;
}

const EMPTY_GAMEPAD_FRAME: PolledGamepadFrame = {
  moveLeft: false,
  moveRight: false,
  moveUp: false,
  moveDown: false,
  jump: false,
  jumpPressed: false,
  rollPressed: false,
  weapon1Pressed: false,
  weapon1Held: false,
  weapon2Pressed: false,
  weapon2Held: false,
  skill1Pressed: false,
  skill2Pressed: false,
  healPressed: false,
  interactPressed: false,
  mapTogglePressed: false,
  cameraPeekY: 0,
};

export class InputManager {
  private bindings: KeyBindings;
  private controllerSettings: ControllerSettings;
  private canvas: HTMLCanvasElement | null;
  private hotkeys: InputHotkeys;
  private cameraOriginMode: CameraOriginMode = 'auto';
  private touchDetector: TouchDetector;

  private heldKeys = new Set<string>();
  private boundCodeSet = new Set<string>();

  // Latched edge-triggered keyboard/mouse action flags (persisted until consumeInputFrame)
  private latchedJump = false;
  private latchedRoll = false;
  private latchedWeapon1 = false;
  private latchedWeapon2 = false;
  private latchedSkill1 = false;
  private latchedSkill2 = false;
  private latchedHeal = false;
  private latchedInteract = false;
  private latchedMapToggle = false;

  // Mouse state
  private mouseClientX = 0;
  private mouseClientY = 0;
  private mouseHasMoved = false;
  private mouseLeftHeld = false;
  private mouseRightHeld = false;

  // Multi-gamepad state (per-pad tracking prevents ghost index 0 lockups & lost edges)
  private activeGamepadIndex: number | null = null;
  private connectedGamepadInfos = new Map<number, GamepadConnectionInfo>();
  private prevGamepadNormalized = new Map<number, NormalizedGamepadState>();
  private gamepadAimOffset: Vec2 | null = null;

  // Gamepad UI navigation directional repeat timer
  private uiNavRepeatDir: 'up' | 'down' | 'left' | 'right' | null = null;
  private uiNavNextRepeatMs = 0;

  // Virtual touch twin-stick & button state
  private virtualMoveX = 0;
  private virtualMoveY = 0;
  private virtualAimX = 0;
  private virtualAimY = 0;
  private virtualAimActive = false;
  private virtualHeld = new Set<VirtualControlAction>();
  private virtualLatched = new Set<VirtualControlAction>();

  // Last emitted snapshot signature for change deduping
  private lastEmittedSnapshotKey = '';

  // Queued SimCommands from UI / Minimap / Passage / DevDrawer
  private commandQueue: SimCommand[] = [];

  // Live Keybind Rebind Capture Mode
  private capturingAction: KeyAction | null = null;
  private onCaptureResolve: ((action: KeyAction, code: string) => void) | null = null;
  private onCaptureCancel: (() => void) | null = null;

  private attached = false;

  constructor(
    initialBindings?: Partial<KeyBindings>,
    canvas?: HTMLCanvasElement | null,
    hotkeys: InputHotkeys = {},
    initialControllerSettings?: Partial<ControllerSettings>
  ) {
    this.bindings = { ...DEFAULT_KEY_BINDINGS, ...(initialBindings ?? {}) };
    this.controllerSettings = {
      ...DEFAULT_CONTROLLER_SETTINGS,
      ...(initialControllerSettings ?? {}),
    };
    this.touchDetector = new TouchDetector();
    this.rebuildBoundCodeSet();
    this.canvas =
      canvas !== undefined
        ? canvas
        : typeof document !== 'undefined'
          ? (document.getElementById('game-canvas') as HTMLCanvasElement | null)
          : null;
    this.hotkeys = { ...hotkeys };
    this.attach();
    this.seedInitialGamepadsSilently();
    this.lastEmittedSnapshotKey = this.snapshotKey(this.getActiveInputSnapshot());
  }

  public setCanvas(canvas: HTMLCanvasElement | null): void {
    if (this.canvas && this.attached) {
      this.canvas.removeEventListener('contextmenu', this.handleCanvasContextMenu);
    }
    this.canvas = canvas;
    if (this.canvas && this.attached) {
      this.canvas.addEventListener('contextmenu', this.handleCanvasContextMenu);
    }
  }

  public setHotkeys(hotkeys: InputHotkeys): void {
    this.hotkeys = { ...this.hotkeys, ...hotkeys };
  }

  public setCameraOriginMode(mode: CameraOriginMode): void {
    this.cameraOriginMode = mode;
  }

  public getKeyBindings(): KeyBindings {
    return { ...this.bindings };
  }

  public setKeyBindings(next: KeyBindings): void {
    this.bindings = { ...next };
    this.rebuildBoundCodeSet();
  }

  public resetKeyBindings(): KeyBindings {
    this.bindings = { ...DEFAULT_KEY_BINDINGS };
    this.rebuildBoundCodeSet();
    return this.getKeyBindings();
  }

  public setControllerSettings(settings: ControllerSettings): void {
    this.controllerSettings = {
      ...DEFAULT_CONTROLLER_SETTINGS,
      ...settings,
    };
    this.notifyInputModeIfChanged();
  }

  public getControllerSettings(): ControllerSettings {
    return { ...this.controllerSettings };
  }

  public getActiveInputSnapshot(): ActiveInputSnapshot {
    const padInfo =
      this.activeGamepadIndex !== null
        ? (this.connectedGamepadInfos.get(this.activeGamepadIndex) ?? null)
        : null;
    const mode = this.touchDetector.activeMode;
    const touchSensed = this.touchDetector.touchSensed;
    const touchVisible = this.touchDetector.shouldShowTouchControls(
      this.controllerSettings.touchMode
    );
    const isTeslaBrowser = this.touchDetector.isTeslaBrowser;
    const glyphFamily = resolveGlyphFamily(mode, padInfo, this.controllerSettings.glyphStyle);

    return {
      mode,
      touchSensed,
      touchVisible,
      isTeslaBrowser,
      gamepad: padInfo ? { ...padInfo } : null,
      glyphFamily,
    };
  }

  public setVirtualMoveStick(x: number, y: number): void {
    this.virtualMoveX = clampAxis(x);
    this.virtualMoveY = clampAxis(y);
    if (Math.hypot(this.virtualMoveX, this.virtualMoveY) > 0.05) {
      this.notifyTouchActivity();
    }
  }

  public setVirtualAimStick(x: number, y: number, active: boolean): void {
    if (!active) {
      this.virtualAimX = 0;
      this.virtualAimY = 0;
      this.virtualAimActive = false;
      return;
    }
    this.virtualAimX = clampAxis(x);
    this.virtualAimY = clampAxis(y);
    this.virtualAimActive = true;
    this.notifyTouchActivity();
  }

  public setVirtualActionHeld(action: VirtualControlAction, held: boolean): void {
    const wasHeld = this.virtualHeld.has(action);
    if (!held) {
      this.virtualHeld.delete(action);
      return;
    }

    this.virtualHeld.add(action);
    this.notifyTouchActivity();

    if (wasHeld) return;

    // Subtle tactile click feedback on mobile touch devices when haptics enabled
    if (this.controllerSettings.rumbleEnabled && this.controllerSettings.rumbleIntensity > 0) {
      triggerTouchHaptic(10, true);
    }

    if (action === 'pause') {
      this.hotkeys.onTogglePause?.();
      return;
    }

    if (action === 'map') {
      this.virtualLatched.add('map');
      this.hotkeys.onToggleMap?.();
      return;
    }

    if (action === 'interact') {
      const handledLoot = this.hotkeys.onLootShortcut?.('equip1') === true;
      if (!handledLoot) {
        this.virtualLatched.add('interact');
      }
      return;
    }

    this.virtualLatched.add(action);
  }

  public notifyTouchActivity(): void {
    if (this.touchDetector.recordTouchActivity()) {
      this.notifyInputModeIfChanged();
    }
  }

  public clearVirtualInputs(): void {
    this.virtualMoveX = 0;
    this.virtualMoveY = 0;
    this.virtualAimX = 0;
    this.virtualAimY = 0;
    this.virtualAimActive = false;
    this.virtualHeld.clear();
    this.virtualLatched.clear();
  }

  public triggerHapticsForEvents(events: readonly SimEvent[]): void {
    if (
      !this.controllerSettings.rumbleEnabled ||
      this.controllerSettings.rumbleIntensity <= 0 ||
      !events ||
      events.length === 0
    ) {
      return;
    }

    const pulse = computeEventRumble(events);
    if (!pulse) return;

    const pad = this.getActiveRawGamepad();
    if (pad && pad.connected) {
      triggerGamepadRumble(
        pad,
        pulse.weak,
        pulse.strong,
        pulse.durationMs,
        this.controllerSettings.rumbleIntensity
      );
      return;
    }

    if (this.touchDetector.activeMode === 'touch') {
      const vibMs = Math.round(
        Math.min(45, Math.max(8, pulse.durationMs * 0.2 * this.controllerSettings.rumbleIntensity))
      );
      triggerTouchHaptic(vibMs, true);
    }
  }

  public testRumble(): void {
    const intensity = Math.max(0.25, this.controllerSettings.rumbleIntensity);
    const pad = this.getActiveRawGamepad() ?? this.findFirstConnectedRawGamepad();
    if (pad) {
      triggerGamepadRumble(pad, 0.65, 0.85, 220, intensity);
      return;
    }
    if (this.touchDetector.touchSensed) {
      triggerTouchHaptic(35, true);
    }
  }

  public startRebindCapture(
    action: KeyAction,
    onCaptured: (action: KeyAction, code: string) => void,
    onCancel?: () => void
  ): void {
    this.capturingAction = action;
    this.onCaptureResolve = onCaptured;
    this.onCaptureCancel = onCancel ?? null;
    this.clearTransient();
  }

  public cancelRebindCapture(): void {
    const cancel = this.onCaptureCancel;
    this.capturingAction = null;
    this.onCaptureResolve = null;
    this.onCaptureCancel = null;
    cancel?.();
  }

  public isCapturingRebind(): boolean {
    return this.capturingAction !== null;
  }

  public queueCommand(cmd: SimCommand): void {
    this.commandQueue.push(cmd);
  }

  /** Programmatic Health Flask trigger (used by clicking the HUD Flask vessel). */
  public triggerHeal(): void {
    const allowed = this.hotkeys.isGameplayKeysAllowed ? this.hotkeys.isGameplayKeysAllowed() : true;
    if (!allowed || this.isCapturingRebind()) return;
    this.latchedHeal = true;
  }

  public clearTransient(): void {
    this.heldKeys.clear();
    this.mouseLeftHeld = false;
    this.mouseRightHeld = false;
    this.latchedJump = false;
    this.latchedRoll = false;
    this.latchedWeapon1 = false;
    this.latchedWeapon2 = false;
    this.latchedSkill1 = false;
    this.latchedSkill2 = false;
    this.latchedHeal = false;
    this.latchedInteract = false;
    this.latchedMapToggle = false;
    this.uiNavRepeatDir = null;
    this.uiNavNextRepeatMs = 0;
    this.clearVirtualInputs();
  }

  public getMouseLogicalPos(): Vec2 {
    if (!this.mouseHasMoved) {
      return { x: VIEWPORT_W * 0.5, y: VIEWPORT_H * 0.5 };
    }
    const drawRect = computeCanvasDrawRect(this.canvas);
    const lx = ((this.mouseClientX - drawRect.left) / Math.max(1, drawRect.width)) * VIEWPORT_W;
    const ly = ((this.mouseClientY - drawRect.top) / Math.max(1, drawRect.height)) * VIEWPORT_H;
    return {
      x: Math.max(0, Math.min(VIEWPORT_W, lx)),
      y: Math.max(0, Math.min(VIEWPORT_H, ly)),
    };
  }

  public getMouseWorldPos(camera?: CameraState, playerPos?: Vec2): Vec2 | null {
    if (
      this.virtualAimActive &&
      playerPos &&
      Math.hypot(this.virtualAimX, this.virtualAimY) > VIRTUAL_AIM_DEADZONE
    ) {
      return {
        x: playerPos.x + this.virtualAimX * AIM_PROJECTION_DIST,
        y: playerPos.y + this.virtualAimY * AIM_PROJECTION_DIST,
      };
    }
    if (this.gamepadAimOffset && playerPos) {
      return {
        x: playerPos.x + this.gamepadAimOffset.x * AIM_PROJECTION_DIST,
        y: playerPos.y + this.gamepadAimOffset.y * AIM_PROJECTION_DIST,
      };
    }
    if (!camera || !this.mouseHasMoved) {
      return null;
    }
    const zoom = camera.zoom > 0.05 ? camera.zoom : 1;
    const topLeft = resolveCameraTopLeft(camera, playerPos, this.cameraOriginMode, 1);
    const logical = this.getMouseLogicalPos();
    return {
      x: topLeft.x + logical.x / zoom,
      y: topLeft.y + logical.y / zoom,
    };
  }

  /**
   * Produces the InputFrame for the next deterministic 60 Hz sim tick and
   * clears all edge-triggered `Pressed` latches + drained `SimCommand[]`.
   */
  public consumeInputFrame(camera?: CameraState, playerPos?: Vec2): InputFrame {
    const frame = createEmptyInputFrame();
    const gp = this.pollGamepad();

    const keysAllowed = this.hotkeys.isGameplayKeysAllowed
      ? this.hotkeys.isGameplayKeysAllowed()
      : true;

    if (keysAllowed && !this.isCapturingRebind()) {
      const vMoveLeft = this.virtualMoveX < -VIRTUAL_MOVE_DEADZONE_X;
      const vMoveRight = this.virtualMoveX > VIRTUAL_MOVE_DEADZONE_X;
      const vVerticalDominant =
        Math.abs(this.virtualMoveY) >= Math.abs(this.virtualMoveX) * 0.45;
      const vMoveUp = this.virtualMoveY < -VIRTUAL_MOVE_DEADZONE_Y && vVerticalDominant;
      const vMoveDown = this.virtualMoveY > VIRTUAL_MOVE_DEADZONE_Y && vVerticalDominant;

      frame.moveLeft = this.isActionHeld('moveLeft') || gp.moveLeft || vMoveLeft;
      frame.moveRight = this.isActionHeld('moveRight') || gp.moveRight || vMoveRight;
      frame.moveUp = this.isActionHeld('moveUp') || gp.moveUp || vMoveUp;
      frame.moveDown = this.isActionHeld('moveDown') || gp.moveDown || vMoveDown;

      frame.jump = this.isActionHeld('jump') || gp.jump || this.virtualHeld.has('jump');
      frame.jumpPressed = this.latchedJump || this.virtualLatched.has('jump') || gp.jumpPressed;
      frame.rollPressed = this.latchedRoll || this.virtualLatched.has('roll') || gp.rollPressed;
      frame.weapon1Pressed =
        this.latchedWeapon1 || this.virtualLatched.has('weapon1') || gp.weapon1Pressed;
      frame.weapon1Held =
        this.isActionHeld('weapon1') ||
        this.mouseLeftHeld ||
        gp.weapon1Held ||
        this.virtualHeld.has('weapon1');
      frame.weapon2Pressed =
        this.latchedWeapon2 || this.virtualLatched.has('weapon2') || gp.weapon2Pressed;
      frame.weapon2Held =
        this.isActionHeld('weapon2') ||
        this.mouseRightHeld ||
        gp.weapon2Held ||
        this.virtualHeld.has('weapon2');
      frame.skill1Pressed =
        this.latchedSkill1 || this.virtualLatched.has('skill1') || gp.skill1Pressed;
      frame.skill2Pressed =
        this.latchedSkill2 || this.virtualLatched.has('skill2') || gp.skill2Pressed;
      frame.healPressed = this.latchedHeal || this.virtualLatched.has('heal') || gp.healPressed;
      frame.interactPressed =
        this.latchedInteract || this.virtualLatched.has('interact') || gp.interactPressed;
      frame.mapTogglePressed =
        this.latchedMapToggle || this.virtualLatched.has('map') || gp.mapTogglePressed;

      if (this.virtualAimActive && Math.abs(this.virtualAimY) > VIRTUAL_PEEK_DEADZONE) {
        frame.cameraPeekY = clampAxis(this.virtualAimY);
      } else if (gp.cameraPeekY !== 0) {
        frame.cameraPeekY = gp.cameraPeekY;
      }
    }

    // Always clear latched edges once consumed
    this.latchedJump = false;
    this.latchedRoll = false;
    this.latchedWeapon1 = false;
    this.latchedWeapon2 = false;
    this.latchedSkill1 = false;
    this.latchedSkill2 = false;
    this.latchedHeal = false;
    this.latchedInteract = false;
    this.latchedMapToggle = false;
    this.virtualLatched.clear();

    const aim = this.getMouseWorldPos(camera, playerPos);
    if (aim) {
      frame.aimX = aim.x;
      frame.aimY = aim.y;
    }

    if (this.commandQueue.length > 0) {
      frame.commands = this.commandQueue.splice(0, this.commandQueue.length);
    }

    return frame;
  }

  public attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.handleKeyDown, { capture: true });
    window.addEventListener('keyup', this.handleKeyUp, { capture: true });
    window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('pointerdown', this.handleWindowPointerDown, {
      passive: true,
      capture: true,
    });
    window.addEventListener('touchstart', this.handleWindowTouchStart, {
      passive: true,
      capture: true,
    });
    window.addEventListener('gamepadconnected', this.handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
    window.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('blur', this.handleWindowBlur);
    this.canvas?.addEventListener('contextmenu', this.handleCanvasContextMenu);
  }

  public dispose(): void {
    if (!this.attached || typeof window === 'undefined') return;
    this.attached = false;
    window.removeEventListener('keydown', this.handleKeyDown, { capture: true });
    window.removeEventListener('keyup', this.handleKeyUp, { capture: true });
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('pointerdown', this.handleWindowPointerDown, { capture: true });
    window.removeEventListener('touchstart', this.handleWindowTouchStart, { capture: true });
    window.removeEventListener('gamepadconnected', this.handleGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
    window.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.canvas?.removeEventListener('contextmenu', this.handleCanvasContextMenu);
    this.clearTransient();
  }

  private snapshotKey(s: ActiveInputSnapshot): string {
    const g = s.gamepad;
    return [
      s.mode,
      s.touchSensed ? '1' : '0',
      s.touchVisible ? '1' : '0',
      s.isTeslaBrowser ? '1' : '0',
      s.glyphFamily,
      g ? `${g.connected ? '1' : '0'}:${g.index}:${g.family}:${g.id}` : 'none',
    ].join('|');
  }

  private notifyInputModeIfChanged(): void {
    const snap = this.getActiveInputSnapshot();
    const key = this.snapshotKey(snap);
    if (key === this.lastEmittedSnapshotKey) return;
    this.lastEmittedSnapshotKey = key;
    this.hotkeys.onInputModeChange?.(snap);
  }

  private buildGamepadInfo(pad: Gamepad, connected: boolean): GamepadConnectionInfo {
    const isTeslaBrowser = this.touchDetector.isTeslaBrowser;
    const family = detectGamepadFamily(pad.id, isTeslaBrowser);
    return {
      connected,
      index: pad.index,
      id: pad.id ?? '',
      displayName: formatGamepadDisplayName(pad.id ?? '', family, isTeslaBrowser),
      family,
      mapping: pad.mapping ?? '',
      isTeslaBrowser,
      hasRumble: hasGamepadRumbleSupport(pad),
    };
  }

  private readNavigatorGamepads(): Array<Gamepad | null> {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return [];
    }
    try {
      const list = navigator.getGamepads();
      if (!list) return [];
      const out: Array<Gamepad | null> = [];
      for (let i = 0; i < list.length; i++) {
        out.push(list[i] ?? null);
      }
      return out;
    } catch {
      return [];
    }
  }

  private seedInitialGamepadsSilently(): void {
    const pads = this.readNavigatorGamepads();
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const info = this.buildGamepadInfo(pad, true);
      this.connectedGamepadInfos.set(pad.index, info);
      if (this.activeGamepadIndex === null) {
        this.activeGamepadIndex = pad.index;
      }
    }
  }

  private getActiveRawGamepad(): Gamepad | null {
    if (this.activeGamepadIndex === null) return null;
    const pads = this.readNavigatorGamepads();
    for (const pad of pads) {
      if (pad && pad.connected && pad.index === this.activeGamepadIndex) {
        return pad;
      }
    }
    return null;
  }

  private findFirstConnectedRawGamepad(): Gamepad | null {
    const pads = this.readNavigatorGamepads();
    for (const pad of pads) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  private rebuildBoundCodeSet(): void {
    this.boundCodeSet.clear();
    for (const key of Object.keys(this.bindings) as KeyAction[]) {
      this.boundCodeSet.add(this.bindings[key]);
    }
  }

  private matchesAction(action: KeyAction, code: string): boolean {
    if (this.bindings[action] === code) return true;
    const fallbacks = ARROW_FALLBACKS[action];
    if (fallbacks && fallbacks.includes(code) && !this.boundCodeSet.has(code)) {
      return true;
    }
    return false;
  }

  private isActionHeld(action: KeyAction): boolean {
    if (this.heldKeys.has(this.bindings[action])) return true;
    const fallbacks = ARROW_FALLBACKS[action];
    if (fallbacks) {
      for (const fb of fallbacks) {
        if (!this.boundCodeSet.has(fb) && this.heldKeys.has(fb)) return true;
      }
    }
    return false;
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof HTMLElement === 'undefined') return false;
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private isUiInteractiveTarget(target: EventTarget | null): boolean {
    if (!target || typeof HTMLElement === 'undefined') return false;
    if (!(target instanceof HTMLElement)) return false;
    if (
      target.id === 'game-canvas' ||
      target.id === 'viewport-stage' ||
      target.id === 'app' ||
      target.id === 'hud-root' ||
      target.id === 'ui-root'
    ) {
      return false;
    }
    return Boolean(target.closest(INTERACTIVE_UI_SELECTOR));
  }

  private handleWindowTouchStart = (): void => {
    this.notifyTouchActivity();
  };

  private handleWindowPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.notifyTouchActivity();
    } else if (e.pointerType === 'mouse') {
      if (this.touchDetector.recordMouseActivity()) {
        this.notifyInputModeIfChanged();
      }
    }
  };

  private handleGamepadConnected = (e: Event): void => {
    const pad = (e as GamepadEvent).gamepad;
    if (!pad) return;
    const alreadyKnown = this.connectedGamepadInfos.has(pad.index);
    const info = this.buildGamepadInfo(pad, true);
    this.connectedGamepadInfos.set(pad.index, info);
    if (this.activeGamepadIndex === null) {
      this.activeGamepadIndex = pad.index;
    }
    if (!alreadyKnown) {
      this.hotkeys.onGamepadConnectionChange?.({ ...info }, true);
    }
    this.notifyInputModeIfChanged();
  };

  private handleGamepadDisconnected = (e: Event): void => {
    const pad = (e as GamepadEvent).gamepad;
    if (!pad) return;
    const existing = this.connectedGamepadInfos.get(pad.index);
    const info: GamepadConnectionInfo = existing
      ? { ...existing, connected: false }
      : this.buildGamepadInfo(pad, false);

    this.connectedGamepadInfos.delete(pad.index);
    this.prevGamepadNormalized.delete(pad.index);

    if (this.activeGamepadIndex === pad.index) {
      const nextIndex = this.connectedGamepadInfos.keys().next().value;
      this.activeGamepadIndex = typeof nextIndex === 'number' ? nextIndex : null;
      this.gamepadAimOffset = null;
      this.uiNavRepeatDir = null;
      this.uiNavNextRepeatMs = 0;
    }

    if (existing) {
      this.hotkeys.onGamepadConnectionChange?.({ ...info }, false);
    }
    this.notifyInputModeIfChanged();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;

    if (this.touchDetector.recordKeyboardActivity()) {
      this.notifyInputModeIfChanged();
    }

    // 1. Live Keybind Capture Mode intercepts all keys cleanly
    if (this.capturingAction !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (code === 'Escape') {
        this.cancelRebindCapture();
        return;
      }
      if (code === 'F9') return; // Reserve F9 for Dev Drawer
      const action = this.capturingAction;
      const resolve = this.onCaptureResolve;
      this.capturingAction = null;
      this.onCaptureResolve = null;
      this.onCaptureCancel = null;
      this.bindings[action] = code;
      this.rebuildBoundCodeSet();
      resolve?.(action, code);
      return;
    }

    // 2. Always allow F9 Dev Drawer toggle
    if (code === 'F9') {
      e.preventDefault();
      if (!e.repeat) this.hotkeys.onToggleDevDrawer?.();
      return;
    }

    // 3. Do not steal typing inside form controls (except Escape)
    const editable = this.isEditableTarget(e.target);
    if (editable && code !== 'Escape') {
      return;
    }

    // 4. Pause / Escape
    if (code === this.bindings.pause || code === 'Escape') {
      if (!e.repeat) {
        e.preventDefault();
        this.hotkeys.onTogglePause?.();
      }
      return;
    }

    // 5. Quick Scroll selection (1 / 2 / 3) when Scroll modal is open
    if (this.hotkeys.isScrollModalOpen?.()) {
      if (code === 'Digit1' || code === 'Numpad1') {
        e.preventDefault();
        if (!e.repeat) this.hotkeys.onScrollShortcut?.(0);
        return;
      }
      if (code === 'Digit2' || code === 'Numpad2') {
        e.preventDefault();
        if (!e.repeat) this.hotkeys.onScrollShortcut?.(1);
        return;
      }
      if (code === 'Digit3' || code === 'Numpad3') {
        e.preventDefault();
        if (!e.repeat) this.hotkeys.onScrollShortcut?.(2);
        return;
      }
    }

    // 6. Minimap toggle (Tab) — prevent browser focus tabbing
    if (this.matchesAction('map', code) || code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) {
        this.latchedMapToggle = true;
        this.hotkeys.onToggleMap?.();
      }
      return;
    }

    // Prevent scrolling on Space / Arrows during play
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    this.heldKeys.add(code);
    if (e.repeat) return;

    // 7. Contextual loot quick-actions (G = Equip Slot 2, X = Recycle)
    if (code === 'KeyG' && !this.boundCodeSet.has('KeyG')) {
      this.hotkeys.onLootShortcut?.('equip2');
    } else if (code === 'KeyX' && !this.boundCodeSet.has('KeyX')) {
      this.hotkeys.onLootShortcut?.('recycle');
    }

    // 8. Latch edge-triggered gameplay inputs
    if (this.matchesAction('jump', code)) this.latchedJump = true;
    if (this.matchesAction('roll', code)) this.latchedRoll = true;
    if (this.matchesAction('weapon1', code)) this.latchedWeapon1 = true;
    if (this.matchesAction('weapon2', code)) this.latchedWeapon2 = true;
    if (this.matchesAction('skill1', code)) this.latchedSkill1 = true;
    if (this.matchesAction('skill2', code)) this.latchedSkill2 = true;
    if (this.matchesAction('heal', code)) this.latchedHeal = true;
    if (this.matchesAction('interact', code)) {
      const handledLoot = this.hotkeys.onLootShortcut?.('equip1') === true;
      if (!handledLoot) {
        this.latchedInteract = true;
      }
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.heldKeys.delete(e.code);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (this.touchDetector.isWithinSyntheticMouseWindow()) {
      return;
    }
    if (this.touchDetector.recordMouseActivity()) {
      this.notifyInputModeIfChanged();
    }
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
    this.mouseHasMoved = true;
    this.gamepadAimOffset = null;
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (this.touchDetector.isWithinSyntheticMouseWindow()) {
      return;
    }
    if (this.touchDetector.recordMouseActivity()) {
      this.notifyInputModeIfChanged();
    }
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
    this.mouseHasMoved = true;
    this.gamepadAimOffset = null;

    if (this.isCapturingRebind()) return;
    if (this.isUiInteractiveTarget(e.target)) return;
    if (this.hotkeys.isGameplayMouseAllowed && !this.hotkeys.isGameplayMouseAllowed()) return;

    // Release stray button focus when clicking onto the game viewport
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      if (!this.isEditableTarget(document.activeElement)) {
        document.activeElement.blur();
      }
    }

    if (e.button === 0) {
      this.mouseLeftHeld = true;
      this.latchedWeapon1 = true;
    } else if (e.button === 2) {
      this.mouseRightHeld = true;
      this.latchedWeapon2 = true;
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseLeftHeld = false;
    if (e.button === 2) this.mouseRightHeld = false;
  };

  private handleCanvasContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private handleContextMenu = (e: MouseEvent): void => {
    if (!this.isUiInteractiveTarget(e.target)) {
      e.preventDefault();
    }
  };

  private handleWindowBlur = (): void => {
    this.clearTransient();
  };

  private resolvePrimaryUiDirection(
    norm: NormalizedGamepadState
  ): 'up' | 'down' | 'left' | 'right' | null {
    const vDir: 'up' | 'down' | null = norm.ui.up ? 'up' : norm.ui.down ? 'down' : null;
    const hDir: 'left' | 'right' | null = norm.ui.left ? 'left' : norm.ui.right ? 'right' : null;
    if (vDir && !hDir) return vDir;
    if (hDir && !vDir) return hDir;
    if (vDir && hDir) {
      return Math.abs(norm.moveX) > Math.abs(norm.moveY) ? hDir : vDir;
    }
    return null;
  }

  private pollGamepad(): PolledGamepadFrame {
    const pads = this.readNavigatorGamepads();
    const connectedMap = new Map<number, Gamepad>();

    for (const pad of pads) {
      if (pad && pad.connected) {
        connectedMap.set(pad.index, pad);
      }
    }

    // Reconcile newly disconnected pads (catches environments without gamepaddisconnected events)
    let connectionChanged = false;
    for (const [idx, oldInfo] of Array.from(this.connectedGamepadInfos.entries())) {
      if (!connectedMap.has(idx)) {
        this.connectedGamepadInfos.delete(idx);
        this.prevGamepadNormalized.delete(idx);
        if (this.activeGamepadIndex === idx) {
          this.activeGamepadIndex = null;
          this.gamepadAimOffset = null;
          this.uiNavRepeatDir = null;
          this.uiNavNextRepeatMs = 0;
        }
        this.hotkeys.onGamepadConnectionChange?.({ ...oldInfo, connected: false }, false);
        connectionChanged = true;
      }
    }

    // Reconcile newly connected pads & evaluate normalized state for every connected pad
    const evaluated: Array<{
      pad: Gamepad;
      info: GamepadConnectionInfo;
      norm: NormalizedGamepadState;
      prev: NormalizedGamepadState | undefined;
    }> = [];

    for (const pad of connectedMap.values()) {
      const existed = this.connectedGamepadInfos.has(pad.index);
      const info = this.buildGamepadInfo(pad, true);
      this.connectedGamepadInfos.set(pad.index, info);
      if (!existed) {
        this.hotkeys.onGamepadConnectionChange?.({ ...info }, true);
        connectionChanged = true;
      }

      const prev = this.prevGamepadNormalized.get(pad.index);
      const norm = normalizeGamepadState(
        pad,
        this.controllerSettings,
        info.family,
        prev
          ? {
              leftTrigger: prev.leftTriggerHeld,
              rightTrigger: prev.rightTriggerHeld,
            }
          : undefined
      );
      evaluated.push({ pad, info, norm, prev });
    }

    if (evaluated.length === 0) {
      this.activeGamepadIndex = null;
      this.gamepadAimOffset = null;
      this.uiNavRepeatDir = null;
      this.uiNavNextRepeatMs = 0;
      if (connectionChanged) {
        this.notifyInputModeIfChanged();
      }
      return EMPTY_GAMEPAD_FRAME;
    }

    // Active-pad selection: immediately switch to whichever connected pad shows active input
    // so ghost/idle virtual controllers at index 0 never hijack input.
    let selected = evaluated.find((e) => e.pad.index === this.activeGamepadIndex) ?? null;
    if (!selected || !selected.norm.anyActive) {
      const activeEntry = evaluated.find((e) => e.norm.anyActive);
      if (activeEntry) {
        selected = activeEntry;
        this.activeGamepadIndex = activeEntry.pad.index;
      } else if (!selected) {
        selected = evaluated[0]!;
        this.activeGamepadIndex = selected.pad.index;
      }
    }

    // Persist per-pad previous normalized states for clean rising edges on next tick
    for (const entry of evaluated) {
      this.prevGamepadNormalized.set(entry.pad.index, entry.norm);
    }

    const { norm, prev } = selected;

    if (norm.anyActive) {
      this.touchDetector.recordGamepadActivity();
      this.notifyInputModeIfChanged();
    } else if (connectionChanged) {
      this.notifyInputModeIfChanged();
    }

    if (norm.aimActive) {
      this.gamepadAimOffset = { x: norm.aim.x, y: norm.aim.y };
    } else {
      this.gamepadAimOffset = null;
    }

    if (this.isCapturingRebind()) {
      return EMPTY_GAMEPAD_FRAME;
    }

    const edge = (currVal: boolean, prevVal?: boolean): boolean => currVal && !prevVal;
    const uiNavActive = Boolean(this.hotkeys.isUiNavActive?.());

    if (uiNavActive) {
      const nowMs = nowHighResMs();
      const dir = this.resolvePrimaryUiDirection(norm);
      if (dir === null) {
        this.uiNavRepeatDir = null;
        this.uiNavNextRepeatMs = 0;
      } else if (dir !== this.uiNavRepeatDir) {
        this.uiNavRepeatDir = dir;
        this.uiNavNextRepeatMs = nowMs + UI_NAV_INITIAL_DELAY_MS;
        this.hotkeys.onUiNav?.(dir);
      } else if (nowMs >= this.uiNavNextRepeatMs) {
        this.uiNavNextRepeatMs = nowMs + UI_NAV_REPEAT_INTERVAL_MS;
        this.hotkeys.onUiNav?.(dir);
      }

      if (edge(norm.ui.confirm, prev?.ui.confirm)) {
        this.hotkeys.onUiNav?.('confirm');
      }
      if (edge(norm.ui.cancel, prev?.ui.cancel)) {
        this.hotkeys.onUiNav?.('cancel');
      }
      if (edge(norm.ui.tabPrev, prev?.ui.tabPrev)) {
        this.hotkeys.onUiNav?.('tabPrev');
      }
      if (edge(norm.ui.tabNext, prev?.ui.tabNext)) {
        this.hotkeys.onUiNav?.('tabNext');
      }
      if (edge(norm.ui.pause, prev?.ui.pause)) {
        if (this.hotkeys.onUiNav) {
          const handled = this.hotkeys.onUiNav('pause');
          if (handled === false) this.hotkeys.onTogglePause?.();
        } else {
          this.hotkeys.onTogglePause?.();
        }
      }
      if (edge(norm.ui.map, prev?.ui.map)) {
        if (this.hotkeys.onUiNav) {
          const handled = this.hotkeys.onUiNav('map');
          if (handled === false) this.hotkeys.onToggleMap?.();
        } else {
          this.hotkeys.onToggleMap?.();
        }
      }

      return EMPTY_GAMEPAD_FRAME;
    }

    // Gameplay routing
    this.uiNavRepeatDir = null;
    this.uiNavNextRepeatMs = 0;

    if (edge(norm.pause, prev?.pause)) {
      this.hotkeys.onTogglePause?.();
    }
    const mapTogglePressed = edge(norm.map, prev?.map);
    if (mapTogglePressed) {
      this.hotkeys.onToggleMap?.();
    }

    let interactPressed = false;
    if (edge(norm.interact, prev?.interact)) {
      const handledLoot = this.hotkeys.onLootShortcut?.('equip1') === true;
      if (!handledLoot) {
        interactPressed = true;
      }
    }

    if (edge(norm.equip2, prev?.equip2)) {
      this.hotkeys.onLootShortcut?.('equip2');
    }
    if (edge(norm.recycle, prev?.recycle)) {
      this.hotkeys.onLootShortcut?.('recycle');
    }

    return {
      moveLeft: norm.moveLeft,
      moveRight: norm.moveRight,
      moveUp: norm.moveUp,
      moveDown: norm.moveDown,
      jump: norm.jump,
      jumpPressed: edge(norm.jump, prev?.jump),
      rollPressed: edge(norm.roll, prev?.roll),
      weapon1Pressed: edge(norm.weapon1, prev?.weapon1),
      weapon1Held: norm.weapon1,
      weapon2Pressed: edge(norm.weapon2, prev?.weapon2),
      weapon2Held: norm.weapon2,
      skill1Pressed: edge(norm.skill1, prev?.skill1),
      skill2Pressed: edge(norm.skill2, prev?.skill2),
      healPressed: edge(norm.heal, prev?.heal),
      interactPressed,
      mapTogglePressed,
      cameraPeekY: norm.cameraPeekY,
    };
  }
}
