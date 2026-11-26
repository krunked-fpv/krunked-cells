import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTROLLER_SETTINGS,
  DEFAULT_KEY_BINDINGS,
  SAVE_KEY,
  createDefaultSaveData,
  type ControllerSettings,
  type GamepadConnectionInfo,
  type SimEvent,
  type UiNavAction,
} from '../src/contracts';
import { SaveManager, parseSaveData, type StorageLike } from '../src/app/SaveManager';
import {
  InputManager,
  SYNTHETIC_MOUSE_SUPPRESS_MS,
  TouchDetector,
  applyStickDeadzone,
  computeEventRumble,
  detectGamepadFamily,
  detectInitialTouchEnvironment,
  detectTeslaBrowser,
  formatGamepadDisplayName,
  getActionGlyph,
  normalizeGamepadState,
  resolveGlyphFamily,
  triggerGamepadRumble,
  type ActionGlyphId,
  type GlyphFamily,
} from '../src/input';

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

interface MockGamepadOptions {
  index?: number;
  id?: string;
  connected?: boolean;
  mapping?: GamepadMappingType;
  buttonCount?: number;
  axisCount?: number;
  buttons?: Record<number, { pressed?: boolean; value?: number } | number | boolean>;
  axes?: Record<number, number>;
  vibrationActuator?: {
    type?: string;
    playEffect?: ReturnType<typeof vi.fn>;
  };
  hapticActuators?: Array<{ pulse: ReturnType<typeof vi.fn> }>;
}

function createMockGamepad(opts: MockGamepadOptions = {}): Gamepad {
  const btnCount = opts.buttonCount ?? 16;
  const axisCount = opts.axisCount ?? 4;
  const buttons: GamepadButton[] = [];
  for (let i = 0; i < btnCount; i++) {
    const spec = opts.buttons?.[i];
    if (typeof spec === 'boolean') {
      buttons.push({ pressed: spec, touched: spec, value: spec ? 1 : 0 });
    } else if (typeof spec === 'number') {
      buttons.push({ pressed: spec > 0.5, touched: spec > 0, value: spec });
    } else if (spec) {
      const value = spec.value ?? (spec.pressed ? 1 : 0);
      const pressed = spec.pressed ?? value > 0.5;
      buttons.push({ pressed, touched: pressed || value > 0, value });
    } else {
      buttons.push({ pressed: false, touched: false, value: 0 });
    }
  }

  const axes: number[] = new Array(axisCount).fill(0);
  if (opts.axes) {
    for (const [k, v] of Object.entries(opts.axes)) {
      const idx = Number(k);
      if (idx >= 0 && idx < axes.length) axes[idx] = v;
    }
  }

  const pad = {
    id: opts.id ?? 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
    index: opts.index ?? 0,
    connected: opts.connected ?? true,
    timestamp: 100,
    mapping: (opts.mapping ?? 'standard') as GamepadMappingType,
    axes,
    buttons,
    vibrationActuator: opts.vibrationActuator,
    hapticActuators: opts.hapticActuators,
  };
  return pad as unknown as Gamepad;
}

function createMockStorage(initial: Record<string, string> = {}): StorageLike & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

describe('Controller, Multi-Gamepad, Strict Touch Detection & SaveManager Suite', () => {
  const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalGetGamepads =
    typeof navigator !== 'undefined' ? navigator.getGamepads : undefined;

  function mockNavigatorGamepads(getter: () => Array<Gamepad | null>): void {
    if (typeof navigator === 'undefined') {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: { getGamepads: getter },
      });
    } else {
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        writable: true,
        value: getter,
      });
    }
  }

  afterEach(() => {
    if (typeof navigator !== 'undefined' && originalGetGamepads !== undefined) {
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        writable: true,
        value: originalGetGamepads,
      });
    } else if (originalNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc);
    } else if ('navigator' in globalThis) {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Vendor Detection, Tesla Browser & Display Names
  // ---------------------------------------------------------------------------
  describe('Controller Vendor Detection & Tesla Browser Recognition', () => {
    it('detects Tesla in-car browsers accurately without false positives on desktop or mobile', () => {
      expect(
        detectTeslaBrowser(
          'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/114.0 Tesla/2024.32.7'
        )
      ).toBe(true);
      expect(detectTeslaBrowser('Mozilla/5.0 QtCarBrowser Safari/537.36')).toBe(true);
      expect(detectTeslaBrowser('Mozilla/5.0 TeslaCar/1.0')).toBe(true);

      expect(
        detectTeslaBrowser(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
        )
      ).toBe(false);
      expect(
        detectTeslaBrowser(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        )
      ).toBe(false);
    });

    it('classifies Xbox, PlayStation, Nintendo, Tesla USB/BT, and Generic controllers cleanly', () => {
      // Xbox
      expect(detectGamepadFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)')).toBe('xbox');
      expect(detectGamepadFamily('Microsoft X-Box 360 pad (Vendor: 045e Product: 028e)')).toBe('xbox');
      expect(detectGamepadFamily('XInput STANDARD GAMEPAD')).toBe('xbox');

      // PlayStation
      expect(detectGamepadFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
      expect(detectGamepadFamily('Sony Interactive Entertainment Wireless Controller (054c-09cc)')).toBe('playstation');
      expect(detectGamepadFamily('DualShock 4 Controller')).toBe('playstation');
      expect(detectGamepadFamily('Wireless Controller (STANDARD GAMEPAD)')).toBe('playstation');

      // Nintendo
      expect(detectGamepadFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
      expect(detectGamepadFamily('Nintendo Switch Joy-Con (L+R)')).toBe('nintendo');

      // Tesla browser preserves recognizable physical vendor glyphs, while generic/Logitech/Tesla pads become 'tesla'
      expect(detectGamepadFamily('Xbox Wireless Controller (045e)', true)).toBe('xbox');
      expect(detectGamepadFamily('DualSense Wireless Controller (054c)', true)).toBe('playstation');
      expect(detectGamepadFamily('Nintendo Switch Pro Controller', true)).toBe('nintendo');
      expect(detectGamepadFamily('Logitech Gamepad F310 (Vendor: 046d Product: c216)', true)).toBe('tesla');
      expect(detectGamepadFamily('Tesla Bluetooth Controller', false)).toBe('tesla');
      expect(detectGamepadFamily('Generic USB Joystick', true)).toBe('tesla');

      // Desktop generic
      expect(detectGamepadFamily('Logitech Gamepad F310 (Vendor: 046d Product: c216)', false)).toBe('generic');
      expect(detectGamepadFamily('USB Gamepad (Vendor: 0079 Product: 0006)', false)).toBe('generic');
    });

    it('formats clean, zero-emoji human-readable controller display names', () => {
      const names = [
        formatGamepadDisplayName('Xbox Wireless Controller (Vendor: 045e Product: 02fd)', 'xbox'),
        formatGamepadDisplayName('DualSense Wireless Controller (054c-0ce6)', 'playstation'),
        formatGamepadDisplayName('DualShock 4 (054c-09cc)', 'playstation'),
        formatGamepadDisplayName('Pro Controller (057e-2009)', 'nintendo'),
        formatGamepadDisplayName('Logitech Gamepad F310 (046d-c216)', 'tesla', true),
        formatGamepadDisplayName('Tesla Bluetooth Gamepad', 'tesla', true),
        formatGamepadDisplayName('0079-0006 (STANDARD GAMEPAD)', 'generic', false),
        formatGamepadDisplayName('8BitDo Pro 2 (Vendor: 2dc8 Product: 6003)', 'generic', false),
      ];

      expect(names[0]).toBe('Xbox Wireless Controller');
      expect(names[1]).toBe('DualSense Controller');
      expect(names[2]).toBe('DualShock 4 Controller');
      expect(names[3]).toBe('Nintendo Switch Pro');
      expect(names[4]).toContain('Logitech F310');
      expect(names[5]).toContain('Tesla');
      expect(names[6]).toBe('USB Gamepad');
      expect(names[7]).toBe('8BitDo Controller');

      for (const n of names) {
        expect(n.length).toBeGreaterThan(2);
        expect(EMOJI_REGEX.test(n)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Deadzone Rescaling, Non-Standard HID Normalization & Layout Presets
  // ---------------------------------------------------------------------------
  describe('Deadzone Rescaling, Non-Standard HID Normalization & Layout Presets', () => {
    it('applies radial + axial deadzone rescaling cleanly without stick drift', () => {
      const inside = applyStickDeadzone(0.15, -0.1, 0.24);
      expect(inside.x).toBe(0);
      expect(inside.y).toBe(0);
      expect(inside.magnitude).toBe(0);

      // Slight vertical drift while pushing strongly right should be cleaned by axial deadzone
      const rightWithMinorDrift = applyStickDeadzone(0.8, 0.04, 0.24, 0.45);
      expect(rightWithMinorDrift.x).toBeGreaterThan(0.7);
      expect(rightWithMinorDrift.y).toBe(0);

      // Full deflection saturates cleanly to magnitude 1.0
      const fullDiag = applyStickDeadzone(1, 1, 0.24);
      expect(fullDiag.magnitude).toBeCloseTo(1, 3);
    });

    it('maps Standard, Classic, and Nintendo presets properly while keeping Classic UI Cancel intact', () => {
      const settingsBase: ControllerSettings = { ...DEFAULT_CONTROLLER_SETTINGS, deadzone: 0.24 };

      // Standard preset: A(0)=Jump, B(1)=Roll, X(2)=W1, Y(3)=W2, LB(4)=S1, RB(5)=S2, LT(6)=Heal, RT(7)=Interact
      const padStd = createMockGamepad({
        buttons: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: 0.8, 7: 0.8, 8: true, 9: true, 10: true, 11: true },
        axes: { 0: 0.9, 1: 0, 2: 0.6, 3: -0.75 },
      });
      const normStd = normalizeGamepadState(padStd, { ...settingsBase, layoutPreset: 'standard' }, 'xbox');
      expect(normStd.jump).toBe(true);
      expect(normStd.roll).toBe(true);
      expect(normStd.weapon1).toBe(true);
      expect(normStd.weapon2).toBe(true);
      expect(normStd.skill1).toBe(true);
      expect(normStd.skill2).toBe(true);
      expect(normStd.heal).toBe(true);
      expect(normStd.interact).toBe(true);
      expect(normStd.map).toBe(true);
      expect(normStd.pause).toBe(true);
      expect(normStd.recycle).toBe(true);
      expect(normStd.equip2).toBe(true);
      expect(normStd.moveRight).toBe(true);
      expect(normStd.aimActive).toBe(true);
      expect(normStd.cameraPeekY).toBeLessThan(-0.3);
      expect(normStd.ui.confirm).toBe(true);
      expect(normStd.ui.cancel).toBe(true);

      // Classic preset: RT(7)=Roll, B(1)=Interact, AND B(1) still cancels in UI!
      const padClassicB = createMockGamepad({ buttons: { 1: true } });
      const normClassicB = normalizeGamepadState(padClassicB, { ...settingsBase, layoutPreset: 'classic' }, 'xbox');
      expect(normClassicB.interact).toBe(true);
      expect(normClassicB.roll).toBe(false);
      expect(normClassicB.ui.cancel).toBe(true);

      const padClassicRt = createMockGamepad({ buttons: { 7: 0.9 } });
      const normClassicRt = normalizeGamepadState(padClassicRt, { ...settingsBase, layoutPreset: 'classic' }, 'xbox');
      expect(normClassicRt.roll).toBe(true);
      expect(normClassicRt.interact).toBe(false);

      // Nintendo preset: East(1)=Jump/Confirm, South(0)=Roll/Cancel, North(3)=Weapon1, West(2)=Weapon2
      const padNinEastNorth = createMockGamepad({ buttons: { 1: true, 3: true } });
      const normNin1 = normalizeGamepadState(padNinEastNorth, { ...settingsBase, layoutPreset: 'nintendo' }, 'nintendo');
      expect(normNin1.jump).toBe(true);
      expect(normNin1.ui.confirm).toBe(true);
      expect(normNin1.weapon1).toBe(true);
      expect(normNin1.roll).toBe(false);
      expect(normNin1.weapon2).toBe(false);

      const padNinSouthWest = createMockGamepad({ buttons: { 0: true, 2: true } });
      const normNin2 = normalizeGamepadState(padNinSouthWest, { ...settingsBase, layoutPreset: 'nintendo' }, 'nintendo');
      expect(normNin2.roll).toBe(true);
      expect(normNin2.ui.cancel).toBe(true);
      expect(normNin2.weapon2).toBe(true);
      expect(normNin2.jump).toBe(false);
    });

    it('applies analog trigger hysteresis cleanly (>0.35 engage, <0.22 release)', () => {
      const settings: ControllerSettings = { ...DEFAULT_CONTROLLER_SETTINGS };

      // 0.30 from rest does not engage
      const pad30 = createMockGamepad({ buttons: { 6: { pressed: false, value: 0.30 } } });
      expect(normalizeGamepadState(pad30, settings, 'xbox', { leftTrigger: false }).heal).toBe(false);

      // 0.40 engages
      const pad40 = createMockGamepad({ buttons: { 6: { pressed: false, value: 0.40 } } });
      expect(normalizeGamepadState(pad40, settings, 'xbox', { leftTrigger: false }).heal).toBe(true);

      // Holding at 0.28 stays engaged due to hysteresis
      const pad28 = createMockGamepad({ buttons: { 6: { pressed: false, value: 0.28 } } });
      expect(normalizeGamepadState(pad28, settings, 'xbox', { leftTrigger: true }).heal).toBe(true);

      // Dropping to 0.18 releases
      const pad18 = createMockGamepad({ buttons: { 6: { pressed: false, value: 0.18 } } });
      expect(normalizeGamepadState(pad18, settings, 'xbox', { leftTrigger: true }).heal).toBe(false);
    });

    it('normalizes non-standard DirectInput POV hats, Logitech D-mode face buttons, and Linux/Tesla evdev trigger axes', () => {
      const settings: ControllerSettings = { ...DEFAULT_CONTROLLER_SETTINGS };

      // 10-axis DirectInput Logitech F310 (D-mode): POV hat on axis 9 + rotated face buttons (0=West, 1=South, 2=East)
      const logitechUp = createMockGamepad({
        id: 'Logitech Dual Action F310 (Vendor: 046d Product: c216)',
        mapping: '',
        axisCount: 10,
        buttonCount: 12,
        axes: { 9: -1.0 }, // POV North
        buttons: { 0: true, 1: true }, // West=Weapon1, South=Jump
      });
      const normLogiUp = normalizeGamepadState(logitechUp, settings, 'tesla');
      expect(normLogiUp.moveUp).toBe(true);
      expect(normLogiUp.ui.up).toBe(true);
      expect(normLogiUp.weapon1).toBe(true);
      expect(normLogiUp.jump).toBe(true);

      // POV hat East (-3/7) & Neutral (3.2857)
      const logitechEast = createMockGamepad({
        id: 'Logitech F310',
        mapping: '',
        axisCount: 10,
        axes: { 9: -3 / 7 },
      });
      expect(normalizeGamepadState(logitechEast, settings, 'generic').moveRight).toBe(true);

      const logitechNeutral = createMockGamepad({
        id: 'Logitech F310',
        mapping: '',
        axisCount: 10,
        axes: { 9: 3.2857 },
      });
      const normNeutral = normalizeGamepadState(logitechNeutral, settings, 'generic');
      expect(normNeutral.moveUp || normNeutral.moveDown || normNeutral.moveLeft || normNeutral.moveRight).toBe(false);

      // 8-axis Linux / Tesla evdev pad: LT=axis 2 (-1..+1), RStick=(3,4), RT=axis 5 (-1..+1), DPad=(6,7)
      const linuxPad = createMockGamepad({
        id: 'Generic Linux Evdev Gamepad',
        mapping: '',
        axisCount: 8,
        buttonCount: 11,
        axes: { 2: 0.7, 3: 0.9, 4: -0.5, 5: -1.0, 6: -1.0, 7: 0 },
        buttons: { 6: true, 7: true }, // View=6, Menu=7 on 11-button xpad
      });
      const normLinux = normalizeGamepadState(linuxPad, settings, 'tesla');
      expect(normLinux.heal).toBe(true); // LT pressed (+0.7 in [-1..+1] => 0.85)
      expect(normLinux.interact).toBe(false); // RT resting at -1.0 => 0
      expect(normLinux.moveLeft).toBe(true); // DPad X axis 6 = -1
      expect(normLinux.aimActive).toBe(true);
      expect(normLinux.aim.x).toBeGreaterThan(0.5);
      expect(normLinux.map).toBe(true);
      expect(normLinux.pause).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Dynamic Action Glyphs & Event Rumble
  // ---------------------------------------------------------------------------
  describe('Dynamic Action Glyphs & Rumble Selection', () => {
    const ALL_ACTIONS: ActionGlyphId[] = [
      'jump',
      'roll',
      'weapon1',
      'weapon2',
      'skill1',
      'skill2',
      'heal',
      'interact',
      'equip2',
      'recycle',
      'map',
      'pause',
      'confirm',
      'cancel',
    ];

    it('resolves glyph family from active mode, connected pad vendor, and user override', () => {
      const psInfo: GamepadConnectionInfo = {
        connected: true,
        index: 0,
        id: 'DualSense',
        displayName: 'DualSense Controller',
        family: 'playstation',
        mapping: 'standard',
        isTeslaBrowser: false,
        hasRumble: true,
      };
      expect(resolveGlyphFamily('keyboard', psInfo, 'auto')).toBe('keyboard');
      expect(resolveGlyphFamily('touch', psInfo, 'auto')).toBe('touch');
      expect(resolveGlyphFamily('gamepad', psInfo, 'auto')).toBe('playstation');
      expect(resolveGlyphFamily('gamepad', psInfo, 'nintendo')).toBe('nintendo');
      expect(resolveGlyphFamily('gamepad', null, 'auto')).toBe('xbox');
    });

    it('returns crisp zero-emoji glyphs across Xbox, PlayStation, Nintendo, Keyboard, and Touch', () => {
      expect(getActionGlyph('jump', 'xbox').label).toBe('A');
      expect(getActionGlyph('weapon1', 'xbox').label).toBe('X');
      expect(getActionGlyph('skill1', 'xbox').label).toBe('LB');
      expect(getActionGlyph('heal', 'xbox').label).toBe('LT');
      expect(getActionGlyph('map', 'xbox').label).toBe('VIEW');

      expect(getActionGlyph('jump', 'playstation').label).toBe('✕');
      expect(getActionGlyph('roll', 'playstation').label).toBe('○');
      expect(getActionGlyph('weapon1', 'playstation').label).toBe('□');
      expect(getActionGlyph('weapon2', 'playstation').label).toBe('△');
      expect(getActionGlyph('skill1', 'playstation').label).toBe('L1');
      expect(getActionGlyph('interact', 'playstation').label).toBe('R2');
      expect(getActionGlyph('map', 'playstation').label).toBe('SHARE');

      expect(getActionGlyph('jump', 'nintendo').label).toBe('B');
      expect(getActionGlyph('roll', 'nintendo').label).toBe('A');
      expect(getActionGlyph('skill1', 'nintendo').label).toBe('L');
      expect(getActionGlyph('heal', 'nintendo').label).toBe('ZL');
      expect(getActionGlyph('map', 'nintendo').label).toBe('-');

      // Classic preset swaps Roll & Interact glyphs on gamepad
      expect(getActionGlyph('roll', 'xbox', undefined, 'classic').label).toBe('RT');
      expect(getActionGlyph('interact', 'xbox', undefined, 'classic').label).toBe('B');

      // Custom keyboard bindings reflect in keyboard glyphs
      const customKb = { ...DEFAULT_KEY_BINDINGS, heal: 'KeyH', map: 'KeyM' };
      expect(getActionGlyph('heal', 'keyboard', customKb).label).toBe('H');
      expect(getActionGlyph('map', 'keyboard', customKb).label).toBe('M');

      expect(getActionGlyph('interact', 'touch').label).toBe('USE');

      const families: GlyphFamily[] = ['xbox', 'playstation', 'nintendo', 'tesla', 'generic', 'keyboard', 'touch'];
      for (const fam of families) {
        for (const act of ALL_ACTIONS) {
          const g = getActionGlyph(act, fam, DEFAULT_KEY_BINDINGS);
          expect(g.label.length).toBeGreaterThan(0);
          expect(g.styleClass.length).toBeGreaterThan(0);
          expect(EMOJI_REGEX.test(g.label)).toBe(false);
        }
      }
    });

    it('computes strongest rumble pulse from SimEvents and fires actuator safely', () => {
      const events: SimEvent[] = [
        { type: 'hitImpact', x: 0, y: 0, damage: 10, breach: false, color: '#fff' },
        { type: 'parrySuccess', x: 0, y: 0, reflected: true },
        { type: 'critImpact', x: 0, y: 0, damage: 50, weaponId: 'StartSword' },
      ];
      const pulse = computeEventRumble(events);
      expect(pulse).not.toBeNull();
      expect(pulse!.strong).toBeGreaterThanOrEqual(0.7); // parrySuccess beats crit & hitImpact

      const deathEvents: SimEvent[] = [
        ...events,
        { type: 'playerDeath', x: 0, y: 0, cause: 'Zombie' },
      ];
      const deathPulse = computeEventRumble(deathEvents);
      expect(deathPulse!.strong).toBe(1.0);

      const playEffect = vi.fn().mockResolvedValue('complete');
      const pad = createMockGamepad({ vibrationActuator: { type: 'dual-rumble', playEffect } });
      triggerGamepadRumble(pad, 0.6, 0.8, 150, 0.5);
      expect(playEffect).toHaveBeenCalledTimes(1);
      expect(playEffect).toHaveBeenCalledWith(
        'dual-rumble',
        expect.objectContaining({ duration: 150, weakMagnitude: 0.3, strongMagnitude: 0.4 })
      );

      // Unsupported / throwing pad never throws
      const badPad = createMockGamepad({
        vibrationActuator: {
          playEffect: vi.fn(() => {
            throw new Error('unsupported');
          }),
        },
      });
      expect(() => triggerGamepadRumble(badPad, 1, 1, 200, 1)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. TouchDetector STRICTNESS (Desktop Never False-Positives!)
  // ---------------------------------------------------------------------------
  describe('TouchDetector Strictness & Mode Handoff', () => {
    it('NEVER senses touch on desktop mouse+keyboard PCs even when Chromium exposes ontouchstart and maxTouchPoints > 0', () => {
      const desktopEnv = {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        maxTouchPoints: 10,
        hasOntouchstart: true,
        matchMedia: (q: string) => ({
          matches: q === '(pointer: fine)' || q === '(hover: hover)',
        }),
      };

      const init = detectInitialTouchEnvironment(desktopEnv);
      expect(init.touchSensed).toBe(false);
      expect(init.isTeslaBrowser).toBe(false);
      expect(init.initialMode).toBe('keyboard');

      const detector = new TouchDetector(desktopEnv);
      expect(detector.touchSensed).toBe(false);
      expect(detector.activeMode).toBe('keyboard');
      expect(detector.shouldShowTouchControls('auto')).toBe(false);
      expect(detector.shouldShowTouchControls('off')).toBe(false);
      expect(detector.shouldShowTouchControls('always')).toBe(true);
    });

    it('detects mobile coarse+no-hover and Tesla browser touchscreen environments accurately', () => {
      const mobileInit = detectInitialTouchEnvironment({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148',
        maxTouchPoints: 5,
        hasOntouchstart: true,
        pointerCoarse: true,
        hoverNone: true,
      });
      expect(mobileInit.touchSensed).toBe(true);
      expect(mobileInit.initialMode).toBe('touch');

      const mobileDetector = new TouchDetector({
        pointerCoarse: true,
        hoverNone: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      });
      expect(mobileDetector.touchSensed).toBe(true);
      expect(mobileDetector.shouldShowTouchControls('auto')).toBe(true);
      expect(mobileDetector.shouldShowTouchControls('off')).toBe(false);

      const teslaDetector = new TouchDetector({
        userAgent: 'Mozilla/5.0 (X11; GNU/Linux) Chromium/114.0 Tesla/2024.32.7',
        maxTouchPoints: 5,
        hasOntouchstart: true,
        pointerCoarse: false,
        hoverNone: false,
      });
      expect(teslaDetector.isTeslaBrowser).toBe(true);
      expect(teslaDetector.touchSensed).toBe(true);
      expect(teslaDetector.shouldShowTouchControls('auto')).toBe(true);
    });

    it('activates touch on runtime touch, suppresses synthetic mouse events for 750ms, and auto-hides on real mouse/keyboard/gamepad', () => {
      const detector = new TouchDetector({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
        maxTouchPoints: 10,
        hasOntouchstart: true,
        pointerCoarse: false,
        hoverNone: false,
      });
      expect(detector.shouldShowTouchControls('auto')).toBe(false);

      // Runtime touch activates touch controls
      expect(detector.recordTouchActivity(1000)).toBe(true);
      expect(detector.touchSensed).toBe(true);
      expect(detector.activeMode).toBe('touch');
      expect(detector.shouldShowTouchControls('auto')).toBe(true);

      // Synthetic mouse event within 750ms MUST NOT hide touch controls
      expect(detector.recordMouseActivity(1000 + SYNTHETIC_MOUSE_SUPPRESS_MS - 1)).toBe(false);
      expect(detector.activeMode).toBe('touch');
      expect(detector.shouldShowTouchControls('auto')).toBe(true);

      // Real mouse event at >= 750ms auto-hides touch controls
      expect(detector.recordMouseActivity(1000 + SYNTHETIC_MOUSE_SUPPRESS_MS)).toBe(true);
      expect(detector.activeMode).toBe('keyboard');
      expect(detector.shouldShowTouchControls('auto')).toBe(false);

      // Touching again re-shows touch controls; physical gamepad immediately auto-hides them
      expect(detector.recordTouchActivity(3000)).toBe(true);
      expect(detector.shouldShowTouchControls('auto')).toBe(true);

      expect(detector.recordGamepadActivity()).toBe(true);
      expect(detector.activeMode).toBe('gamepad');
      expect(detector.shouldShowTouchControls('auto')).toBe(false);

      // Touching again re-shows; keyboard immediately auto-hides
      expect(detector.recordTouchActivity(4000)).toBe(true);
      expect(detector.shouldShowTouchControls('auto')).toBe(true);
      expect(detector.recordKeyboardActivity()).toBe(true);
      expect(detector.shouldShowTouchControls('auto')).toBe(false);

      // 'off' always hides, 'always' always shows regardless of mode
      expect(detector.shouldShowTouchControls('off')).toBe(false);
      expect(detector.shouldShowTouchControls('always')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. InputManager Multi-Gamepad, Virtual Twin-Sticks, Latches & UI Nav
  // ---------------------------------------------------------------------------
  describe('InputManager Multi-Gamepad, Virtual Twin-Sticks & Latches', () => {
    it('selects whichever connected gamepad is active (never stuck on ghost pad at index 0) and hides touch on gamepad input', () => {
      const ghostPad = createMockGamepad({
        index: 0,
        id: 'Virtual Ghost Controller (0000-0000)',
        buttons: {},
        axes: {},
      });
      let activePad = createMockGamepad({
        index: 1,
        id: 'DualSense Wireless Controller (054c-0ce6)',
        buttons: { 0: true, 2: true }, // Jump + Weapon1
        axes: { 0: 0.9, 2: 0.8, 3: -0.6 },
      });

      let pads: Array<Gamepad | null> = [ghostPad, activePad];
      mockNavigatorGamepads(() => pads);

      const connEvents: Array<{ family: string; connected: boolean; index: number }> = [];
      const modeEvents: string[] = [];

      const im = new InputManager(DEFAULT_KEY_BINDINGS, null, {
        onGamepadConnectionChange: (info, connected) => {
          connEvents.push({ family: info.family, connected, index: info.index });
        },
        onInputModeChange: (snap) => {
          modeEvents.push(`${snap.mode}:${snap.glyphFamily}:${snap.touchVisible ? 1 : 0}`);
        },
      });

      // Simulate touch active first, then poll gamepads -> gamepad takes over & hides touch
      im.notifyTouchActivity();
      expect(im.getActiveInputSnapshot().touchVisible).toBe(true);

      const frame1 = im.consumeInputFrame(undefined, { x: 100, y: 200 });
      expect(frame1.moveRight).toBe(true);
      expect(frame1.jump).toBe(true);
      expect(frame1.jumpPressed).toBe(true);
      expect(frame1.weapon1Pressed).toBe(true);
      expect(frame1.weapon1Held).toBe(true);
      expect(frame1.aimX).toBeGreaterThan(100);
      expect(frame1.aimY).toBeLessThan(200);
      expect(frame1.cameraPeekY).toBeLessThan(-0.25);

      const snap = im.getActiveInputSnapshot();
      expect(snap.mode).toBe('gamepad');
      expect(snap.touchVisible).toBe(false);
      expect(snap.gamepad?.index).toBe(1);
      expect(snap.gamepad?.family).toBe('playstation');
      expect(snap.glyphFamily).toBe('playstation');
      expect(modeEvents.length).toBeGreaterThan(0);

      // Holding buttons on next tick does NOT re-trigger edge-triggered Pressed flags
      const frame2 = im.consumeInputFrame(undefined, { x: 100, y: 200 });
      expect(frame2.jump).toBe(true);
      expect(frame2.jumpPressed).toBe(false);
      expect(frame2.weapon1Pressed).toBe(false);
      expect(frame2.weapon1Held).toBe(true);

      // Disconnect pad 1 -> emits disconnect callback cleanly
      pads = [ghostPad, null];
      im.consumeInputFrame();
      expect(connEvents.some((e) => e.index === 1 && !e.connected)).toBe(true);

      // Release pad 1 buttons (avoid unused warning)
      activePad = createMockGamepad({ index: 1, connected: false });
      expect(activePad.connected).toBe(false);
      im.dispose();
    });

    it('routes gamepad UI nav actions cleanly when isUiNavActive() is true', () => {
      let pad = createMockGamepad({
        index: 0,
        id: 'Xbox Wireless Controller (045e-02fd)',
        buttons: { 13: true, 0: true, 5: true }, // DPad Down + A confirm + RB tabNext
      });
      mockNavigatorGamepads(() => [pad]);

      const navLog: UiNavAction[] = [];
      const im = new InputManager(DEFAULT_KEY_BINDINGS, null, {
        isUiNavActive: () => true,
        onUiNav: (action) => {
          navLog.push(action);
          return true;
        },
      });

      const frame = im.consumeInputFrame();
      expect(frame.jumpPressed).toBe(false);
      expect(frame.moveDown).toBe(false);
      expect(navLog).toContain('down');
      expect(navLog).toContain('confirm');
      expect(navLog).toContain('tabNext');

      pad = createMockGamepad({ index: 0, buttons: { 1: true } }); // Cancel
      im.consumeInputFrame();
      expect(navLog).toContain('cancel');
      im.dispose();
    });

    it('supports virtual twin-stick movement, 360-degree aim projection, cameraPeekY, edge-triggered latches, and clearVirtualInputs', () => {
      mockNavigatorGamepads(() => []);

      let pauseCount = 0;
      let mapCount = 0;
      let lootHandled = false;

      const im = new InputManager(DEFAULT_KEY_BINDINGS, null, {
        onTogglePause: () => {
          pauseCount++;
        },
        onToggleMap: () => {
          mapCount++;
        },
        onLootShortcut: (act) => {
          if (act === 'equip1' && lootHandled) return true;
          return false;
        },
      });

      // Left stick right + Right aim stick up-right + Jump & Weapon1 held
      im.setVirtualMoveStick(0.85, 0.1);
      im.setVirtualAimStick(0.6, -0.8, true);
      im.setVirtualActionHeld('jump', true);
      im.setVirtualActionHeld('weapon1', true);
      im.setVirtualActionHeld('interact', true);

      const snap = im.getActiveInputSnapshot();
      expect(snap.mode).toBe('touch');
      expect(snap.touchSensed).toBe(true);
      expect(snap.touchVisible).toBe(true);

      const frame1 = im.consumeInputFrame(undefined, { x: 240, y: 120 });
      expect(frame1.moveRight).toBe(true);
      expect(frame1.moveLeft).toBe(false);
      expect(frame1.jump).toBe(true);
      expect(frame1.jumpPressed).toBe(true);
      expect(frame1.weapon1Pressed).toBe(true);
      expect(frame1.weapon1Held).toBe(true);
      expect(frame1.interactPressed).toBe(true);
      expect(frame1.aimX).toBeCloseTo(240 + 0.6 * 120, 2);
      expect(frame1.aimY).toBeCloseTo(120 - 0.8 * 120, 2);
      expect(frame1.cameraPeekY).toBeCloseTo(-0.8, 3);

      // Second tick while still held: edge latches are cleared, continuous holds persist
      const frame2 = im.consumeInputFrame(undefined, { x: 240, y: 120 });
      expect(frame2.jump).toBe(true);
      expect(frame2.jumpPressed).toBe(false);
      expect(frame2.weapon1Pressed).toBe(false);
      expect(frame2.weapon1Held).toBe(true);
      expect(frame2.interactPressed).toBe(false);

      // Utility actions route to hotkeys; interact consumed by loot card does not double-latch interactPressed
      lootHandled = true;
      im.setVirtualActionHeld('interact', false);
      im.setVirtualActionHeld('interact', true);
      im.setVirtualActionHeld('pause', true);
      im.setVirtualActionHeld('map', true);
      const frame3 = im.consumeInputFrame(undefined, { x: 240, y: 120 });
      expect(frame3.interactPressed).toBe(false);
      expect(frame3.mapTogglePressed).toBe(true);
      expect(pauseCount).toBe(1);
      expect(mapCount).toBe(1);

      // clearVirtualInputs wipes everything cleanly
      im.clearVirtualInputs();
      const frame4 = im.consumeInputFrame(undefined, { x: 240, y: 120 });
      expect(frame4.moveRight).toBe(false);
      expect(frame4.jump).toBe(false);
      expect(frame4.weapon1Held).toBe(false);
      expect(frame4.aimX).toBeUndefined();
      expect(frame4.cameraPeekY).toBeUndefined();

      im.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. SaveManager controllerSettings Round-Trip & Corruption Clamping
  // ---------------------------------------------------------------------------
  describe('SaveManager controllerSettings Persistence & Recovery', () => {
    it('round-trips valid controllerSettings faithfully through SaveManager', () => {
      const storage = createMockStorage();
      const manager = new SaveManager(storage);
      const custom = createDefaultSaveData();
      custom.controllerSettings = {
        deadzone: 0.32,
        rumbleEnabled: false,
        rumbleIntensity: 0.4,
        layoutPreset: 'classic',
        glyphStyle: 'playstation',
        autoPauseOnDisconnect: false,
        touchMode: 'always',
        touchOpacity: 0.7,
        touchScale: 1.2,
      };

      manager.save(custom);
      const reloaded = new SaveManager(storage).load();
      expect(reloaded.controllerSettings).toEqual(custom.controllerSettings);
    });

    it('recovers legacy saves and clamps corrupted/out-of-range controllerSettings safely', () => {
      // Legacy save lacking controllerSettings
      const legacyParsed = parseSaveData(JSON.stringify({ schemaVersion: 1, lastSeed: 4242 }));
      expect(legacyParsed.controllerSettings).toEqual(DEFAULT_CONTROLLER_SETTINGS);

      // Corrupted bounds & invalid enum values
      const corrupted = parseSaveData(
        JSON.stringify({
          controllerSettings: {
            deadzone: 99,
            rumbleEnabled: 'yes',
            rumbleIntensity: -5,
            layoutPreset: 'invalid_preset',
            glyphStyle: 'sega',
            autoPauseOnDisconnect: 123,
            touchMode: 'sometimes',
            touchOpacity: 0.01,
            touchScale: 4.5,
          },
        })
      );
      expect(corrupted.controllerSettings).toEqual({
        deadzone: 0.5,
        rumbleEnabled: DEFAULT_CONTROLLER_SETTINGS.rumbleEnabled,
        rumbleIntensity: 0,
        layoutPreset: DEFAULT_CONTROLLER_SETTINGS.layoutPreset,
        glyphStyle: DEFAULT_CONTROLLER_SETTINGS.glyphStyle,
        autoPauseOnDisconnect: DEFAULT_CONTROLLER_SETTINGS.autoPauseOnDisconnect,
        touchMode: DEFAULT_CONTROLLER_SETTINGS.touchMode,
        touchOpacity: 0.2,
        touchScale: 1.35,
      });

      // Lower-bound clamping check via SaveManager storage
      const storage = createMockStorage({
        [SAVE_KEY]: JSON.stringify({
          controllerSettings: {
            deadzone: 0.001,
            rumbleIntensity: 9.9,
            touchOpacity: 10,
            touchScale: 0.1,
          },
        }),
      });
      const loaded = new SaveManager(storage).load();
      expect(loaded.controllerSettings.deadzone).toBe(0.08);
      expect(loaded.controllerSettings.rumbleIntensity).toBe(1);
      expect(loaded.controllerSettings.touchOpacity).toBe(0.85);
      expect(loaded.controllerSettings.touchScale).toBe(0.75);
    });
  });
});
