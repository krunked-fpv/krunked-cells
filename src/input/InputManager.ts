// =============================================================================
// KRUNKED CELLS — Unified Keyboard + Mouse + Gamepad Input Manager
// Edge-triggered Pressed latches guarantee zero dropped inputs at 30/60/120 FPS.
// Accurate 16:9 letterbox world-space aim + direct canvas contextmenu guard.
// =============================================================================

import {
  CameraState,
  DEFAULT_KEY_BINDINGS,
  InputFrame,
  KeyBindings,
  SimCommand,
  VIEWPORT_H,
  VIEWPORT_W,
  Vec2,
  createEmptyInputFrame,
} from '../contracts';

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
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAMEPAD_DEADZONE = 0.26;
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
  '.kc-minimap-shell',
  '.kc-interact-prompt',
  '.kc-flask-widget',
  '.kc-passage-quickbar',
].join(', ');

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

export class InputManager {
  private bindings: KeyBindings;
  private canvas: HTMLCanvasElement | null;
  private hotkeys: InputHotkeys;
  private cameraOriginMode: CameraOriginMode = 'auto';

  private heldKeys = new Set<string>();
  private boundCodeSet = new Set<string>();

  // Latched edge-triggered action flags (persisted until consumeInputFrame)
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

  // Gamepad previous button snapshot for rising-edge detection
  private prevGamepadButtons: boolean[] = [];
  private gamepadAimOffset: Vec2 | null = null;

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
    hotkeys: InputHotkeys = {}
  ) {
    this.bindings = { ...DEFAULT_KEY_BINDINGS, ...(initialBindings ?? {}) };
    this.rebuildBoundCodeSet();
    this.canvas =
      canvas !== undefined
        ? canvas
        : typeof document !== 'undefined'
          ? (document.getElementById('game-canvas') as HTMLCanvasElement | null)
          : null;
    this.hotkeys = { ...hotkeys };
    this.attach();
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
    if (!camera) return null;
    const zoom = camera.zoom > 0.05 ? camera.zoom : 1;
    const topLeft = resolveCameraTopLeft(camera, playerPos, this.cameraOriginMode, 1);
    if (this.gamepadAimOffset && playerPos) {
      return {
        x: playerPos.x + this.gamepadAimOffset.x * 120,
        y: playerPos.y + this.gamepadAimOffset.y * 120,
      };
    }
    if (!this.mouseHasMoved) {
      return null;
    }
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
      frame.moveLeft = this.isActionHeld('moveLeft') || gp.moveLeft;
      frame.moveRight = this.isActionHeld('moveRight') || gp.moveRight;
      frame.moveUp = this.isActionHeld('moveUp') || gp.moveUp;
      frame.moveDown = this.isActionHeld('moveDown') || gp.moveDown;
      frame.jump = this.isActionHeld('jump') || gp.jump;
      frame.jumpPressed = this.latchedJump || gp.jumpPressed;
      frame.rollPressed = this.latchedRoll || gp.rollPressed;
      frame.weapon1Pressed = this.latchedWeapon1 || gp.weapon1Pressed;
      frame.weapon1Held = this.isActionHeld('weapon1') || this.mouseLeftHeld || gp.weapon1Held;
      frame.weapon2Pressed = this.latchedWeapon2 || gp.weapon2Pressed;
      frame.weapon2Held = this.isActionHeld('weapon2') || this.mouseRightHeld || gp.weapon2Held;
      frame.skill1Pressed = this.latchedSkill1 || gp.skill1Pressed;
      frame.skill2Pressed = this.latchedSkill2 || gp.skill2Pressed;
      frame.healPressed = this.latchedHeal || gp.healPressed;
      frame.interactPressed = this.latchedInteract || gp.interactPressed;
      frame.mapTogglePressed = this.latchedMapToggle || gp.mapTogglePressed;
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
    window.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.canvas?.removeEventListener('contextmenu', this.handleCanvasContextMenu);
    this.clearTransient();
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

  private handleKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;

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
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
    this.mouseHasMoved = true;
    this.gamepadAimOffset = null;
  };

  private handleMouseDown = (e: MouseEvent): void => {
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

  private pollGamepad(): {
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
  } {
    const empty = {
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
    };

    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return empty;
    }

    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i]!.connected) {
        pad = pads[i];
        break;
      }
    }
    if (!pad) {
      this.prevGamepadButtons = [];
      return empty;
    }

    const curr = pad.buttons.map((b) => Boolean(b && (b.pressed || b.value > 0.45)));
    const pressed = (idx: number): boolean => Boolean(curr[idx] && !this.prevGamepadButtons[idx]);
    const held = (idx: number): boolean => Boolean(curr[idx]);

    const ax0 = pad.axes[0] ?? 0;
    const ax1 = pad.axes[1] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    if (Math.hypot(rx, ry) > 0.3) {
      this.gamepadAimOffset = { x: rx, y: ry };
    }

    // Start (9) -> Pause, Select (8) -> Map
    if (pressed(9)) this.hotkeys.onTogglePause?.();
    if (pressed(8)) this.hotkeys.onToggleMap?.();

    const result = {
      moveLeft: ax0 < -GAMEPAD_DEADZONE || held(14),
      moveRight: ax0 > GAMEPAD_DEADZONE || held(15),
      moveUp: ax1 < -GAMEPAD_DEADZONE || held(12),
      moveDown: ax1 > GAMEPAD_DEADZONE || held(13),
      jump: held(0),
      jumpPressed: pressed(0),
      rollPressed: pressed(1),
      weapon1Pressed: pressed(2),
      weapon1Held: held(2),
      weapon2Pressed: pressed(3),
      weapon2Held: held(3),
      skill1Pressed: pressed(4),
      skill2Pressed: pressed(5),
      healPressed: pressed(6),
      interactPressed: pressed(7) || pressed(10),
      mapTogglePressed: pressed(8),
    };

    this.prevGamepadButtons = curr;
    return result;
  }
}
