// =============================================================================
// KRUNKED CELLS — Translucent Twin-Stick Virtual Touch Controls Overlay
// Native Dead Cells-grade frosted dark-gothic glass controls for Mobile,
// Tablet, and Tesla touchscreens. Starts hidden (`kc-hidden`); revealed ONLY
// when UIManager calls `setVisible(true)`. Zero Unicode emojis anywhere.
// =============================================================================

import {
  ControllerSettings,
  DEFAULT_CONTROLLER_SETTINGS,
  GearInstance,
  ItemColor,
  SIM_HZ,
  SimState,
  VirtualControlAction,
} from '../contracts';

export interface TouchControlsCallbacks {
  onMoveStick(x: number, y: number): void;
  onAimStick(x: number, y: number, active: boolean): void;
  onActionChange(action: VirtualControlAction, held: boolean): void;
  onTouchActivity(): void;
}

type WeaponVisualKind = 'melee' | 'ranged' | 'shield' | 'empty';
type SkillVisualKind = 'grenade' | 'turret' | 'trap' | 'wave' | 'teleport' | 'power' | 'empty';

const SHIELD_WEAPON_IDS = new Set([
  'StartShield',
  'StunShield',
  'BleedShield',
  'ForceShield',
]);

const RANGED_WEAPON_IDS = new Set([
  'CloseCombatBow',
  'FastBow',
  'FrostBow',
  'ThrowingKnife',
  'Fireball',
  'Whip',
]);

const SKILL_META: Readonly<Record<string, { kind: Exclude<SkillVisualKind, 'empty'>; cooldownTicks: number }>> = {
  SinewSlicer: { kind: 'turret', cooldownTicks: 600 },
  HeavyTurret: { kind: 'turret', cooldownTicks: 660 },
  InfantryGrenade: { kind: 'grenade', cooldownTicks: 240 },
  FireGrenade: { kind: 'grenade', cooldownTicks: 480 },
  IceGrenade: { kind: 'grenade', cooldownTicks: 600 },
  ClusterGrenade: { kind: 'grenade', cooldownTicks: 780 },
  Phaser: { kind: 'teleport', cooldownTicks: 180 },
  WolfTrap: { kind: 'trap', cooldownTicks: 540 },
  WaveOfDenial: { kind: 'wave', cooldownTicks: 300 },
  CorruptedPower: { kind: 'power', cooldownTicks: 900 },
  KnifeDance: { kind: 'wave', cooldownTicks: 420 },
  Tonic: { kind: 'power', cooldownTicks: 1200 },
};

const STICK_MICRO_DEADZONE = 0.05;
const CARDINAL_GLOW_THRESHOLD = 0.35;

// =============================================================================
// Crisp Pixel-Grid SVGs (`shape-rendering="crispEdges"` — Zero Emojis)
// =============================================================================

function svgWrap(inner: string, size = 20, cls = 'kc-touch-svg'): string {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
}

const SVG_SWORD = svgWrap(
  `<rect x="12" y="2" width="2" height="2" fill="currentColor"/>` +
    `<rect x="10" y="3" width="3" height="2" fill="currentColor"/>` +
    `<rect x="9" y="5" width="2" height="2" fill="currentColor"/>` +
    `<rect x="7" y="7" width="2" height="2" fill="currentColor"/>` +
    `<rect x="5" y="9" width="2" height="2" fill="currentColor"/>` +
    `<rect x="3" y="8" width="2" height="2" fill="#fbbf24"/>` +
    `<rect x="6" y="11" width="2" height="2" fill="#fbbf24"/>` +
    `<rect x="4" y="10" width="3" height="2" fill="#fbbf24"/>` +
    `<rect x="3" y="12" width="2" height="2" fill="currentColor" opacity="0.85"/>` +
    `<rect x="2" y="13" width="2" height="2" fill="#fbbf24"/>`,
  24
);

const SVG_DUAL_BLADE = svgWrap(
  `<rect x="11" y="2" width="3" height="2" fill="currentColor"/>` +
    `<rect x="9" y="4" width="3" height="2" fill="currentColor"/>` +
    `<rect x="7" y="6" width="3" height="2" fill="currentColor"/>` +
    `<rect x="5" y="8" width="3" height="2" fill="currentColor"/>` +
    `<rect x="3" y="10" width="3" height="2" fill="#fbbf24"/>` +
    `<rect x="2" y="12" width="2" height="2" fill="currentColor"/>` +
    `<rect x="2" y="2" width="3" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="4" y="4" width="3" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="10" y="10" width="3" height="2" fill="#fbbf24" opacity="0.82"/>` +
    `<rect x="12" y="12" width="2" height="2" fill="currentColor" opacity="0.72"/>`,
  22
);

const SVG_SHIELD = svgWrap(
  `<rect x="3" y="2" width="10" height="2" fill="currentColor"/>` +
    `<rect x="2" y="4" width="12" height="5" fill="currentColor" opacity="0.28"/>` +
    `<rect x="2" y="4" width="2" height="6" fill="currentColor"/>` +
    `<rect x="12" y="4" width="2" height="6" fill="currentColor"/>` +
    `<rect x="4" y="10" width="2" height="2" fill="currentColor"/>` +
    `<rect x="10" y="10" width="2" height="2" fill="currentColor"/>` +
    `<rect x="6" y="12" width="4" height="2" fill="currentColor"/>` +
    `<rect x="7" y="14" width="2" height="1" fill="currentColor"/>` +
    `<rect x="7" y="5" width="2" height="6" fill="#fde047"/>` +
    `<rect x="5" y="7" width="6" height="2" fill="#fde047"/>`,
  22
);

const SVG_BOW = svgWrap(
  `<rect x="4" y="2" width="2" height="12" fill="currentColor" opacity="0.45"/>` +
    `<rect x="6" y="2" width="3" height="2" fill="currentColor"/>` +
    `<rect x="9" y="4" width="2" height="2" fill="currentColor"/>` +
    `<rect x="10" y="6" width="2" height="4" fill="currentColor"/>` +
    `<rect x="9" y="10" width="2" height="2" fill="currentColor"/>` +
    `<rect x="6" y="12" width="3" height="2" fill="currentColor"/>` +
    `<rect x="3" y="7" width="10" height="2" fill="#fde047"/>` +
    `<rect x="12" y="5" width="2" height="2" fill="#fde047"/>` +
    `<rect x="13" y="7" width="2" height="2" fill="#ffffff"/>` +
    `<rect x="12" y="9" width="2" height="2" fill="#fde047"/>`,
  22
);

const SVG_JUMP = svgWrap(
  `<rect x="7" y="2" width="2" height="2" fill="currentColor"/>` +
    `<rect x="5" y="4" width="6" height="2" fill="currentColor"/>` +
    `<rect x="3" y="6" width="3" height="2" fill="currentColor"/>` +
    `<rect x="10" y="6" width="3" height="2" fill="currentColor"/>` +
    `<rect x="7" y="6" width="2" height="8" fill="currentColor"/>` +
    `<rect x="5" y="10" width="2" height="2" fill="currentColor" opacity="0.62"/>` +
    `<rect x="9" y="10" width="2" height="2" fill="currentColor" opacity="0.62"/>`,
  22
);

const SVG_ROLL = svgWrap(
  `<rect x="2" y="5" width="2" height="2" fill="currentColor" opacity="0.48"/>` +
    `<rect x="2" y="9" width="3" height="2" fill="currentColor" opacity="0.48"/>` +
    `<rect x="6" y="4" width="2" height="2" fill="currentColor" opacity="0.8"/>` +
    `<rect x="8" y="6" width="2" height="4" fill="currentColor" opacity="0.8"/>` +
    `<rect x="6" y="10" width="2" height="2" fill="currentColor" opacity="0.8"/>` +
    `<rect x="10" y="3" width="2" height="2" fill="currentColor"/>` +
    `<rect x="12" y="5" width="2" height="6" fill="currentColor"/>` +
    `<rect x="10" y="11" width="2" height="2" fill="currentColor"/>` +
    `<rect x="4" y="7" width="8" height="2" fill="currentColor"/>`,
  21
);

const SVG_FLASK = svgWrap(
  `<rect x="6" y="1" width="4" height="2" fill="#d6b078"/>` +
    `<rect x="5" y="3" width="6" height="2" fill="currentColor"/>` +
    `<rect x="4" y="5" width="8" height="2" fill="currentColor"/>` +
    `<rect x="3" y="7" width="10" height="6" fill="currentColor" opacity="0.28"/>` +
    `<rect x="3" y="7" width="2" height="6" fill="currentColor"/>` +
    `<rect x="11" y="7" width="2" height="6" fill="currentColor"/>` +
    `<rect x="4" y="13" width="8" height="2" fill="currentColor"/>` +
    `<rect x="5" y="8" width="6" height="5" fill="#4ade80"/>` +
    `<rect x="5" y="8" width="2" height="2" fill="#dcfce7"/>`,
  19
);

const SVG_INTERACT = svgWrap(
  `<rect x="7" y="1" width="2" height="3" fill="currentColor"/>` +
    `<rect x="5" y="4" width="6" height="2" fill="currentColor"/>` +
    `<rect x="3" y="6" width="10" height="4" fill="currentColor" opacity="0.32"/>` +
    `<rect x="3" y="6" width="2" height="4" fill="currentColor"/>` +
    `<rect x="11" y="6" width="2" height="4" fill="currentColor"/>` +
    `<rect x="7" y="7" width="2" height="2" fill="#ffffff"/>` +
    `<rect x="5" y="10" width="6" height="2" fill="currentColor"/>` +
    `<rect x="7" y="12" width="2" height="3" fill="currentColor"/>`,
  17
);

const SVG_PAUSE = svgWrap(
  `<rect x="4" y="3" width="3" height="10" fill="currentColor"/>` +
    `<rect x="9" y="3" width="3" height="10" fill="currentColor"/>`,
  14
);

const SVG_MAP = svgWrap(
  `<rect x="2" y="3" width="12" height="2" fill="currentColor"/>` +
    `<rect x="2" y="11" width="12" height="2" fill="currentColor"/>` +
    `<rect x="2" y="5" width="2" height="6" fill="currentColor"/>` +
    `<rect x="12" y="5" width="2" height="6" fill="currentColor"/>` +
    `<rect x="6" y="4" width="1" height="8" fill="currentColor" opacity="0.6"/>` +
    `<rect x="10" y="4" width="1" height="8" fill="currentColor" opacity="0.6"/>` +
    `<rect x="4" y="7" width="2" height="2" fill="#38e8ff"/>` +
    `<rect x="8" y="6" width="2" height="2" fill="#fbbf24"/>`,
  14
);

const SKILL_SVGS: Record<SkillVisualKind, string> = {
  grenade: svgWrap(
    `<rect x="9" y="2" width="3" height="2" fill="#fbbf24"/>` +
      `<rect x="6" y="4" width="4" height="2" fill="currentColor"/>` +
      `<rect x="4" y="6" width="8" height="7" fill="currentColor"/>` +
      `<rect x="5" y="13" width="6" height="2" fill="currentColor"/>` +
      `<rect x="6" y="7" width="2" height="2" fill="#ffffff" opacity="0.7"/>`,
    19
  ),
  turret: svgWrap(
    `<rect x="4" y="4" width="7" height="5" fill="currentColor"/>` +
      `<rect x="11" y="5" width="4" height="2" fill="#fde047"/>` +
      `<rect x="6" y="9" width="4" height="2" fill="currentColor"/>` +
      `<rect x="4" y="11" width="2" height="3" fill="currentColor"/>` +
      `<rect x="10" y="11" width="2" height="3" fill="currentColor"/>`,
    19
  ),
  trap: svgWrap(
    `<rect x="3" y="5" width="2" height="5" fill="currentColor"/>` +
      `<rect x="11" y="5" width="2" height="5" fill="currentColor"/>` +
      `<rect x="5" y="4" width="2" height="2" fill="#ffffff"/>` +
      `<rect x="9" y="4" width="2" height="2" fill="#ffffff"/>` +
      `<rect x="3" y="10" width="10" height="3" fill="currentColor"/>` +
      `<rect x="7" y="8" width="2" height="2" fill="#ef4444"/>`,
    19
  ),
  wave: svgWrap(
    `<rect x="3" y="6" width="2" height="4" fill="currentColor" opacity="0.55"/>` +
      `<rect x="6" y="4" width="2" height="8" fill="currentColor" opacity="0.8"/>` +
      `<rect x="9" y="2" width="2" height="12" fill="currentColor"/>` +
      `<rect x="12" y="4" width="2" height="8" fill="#38e8ff"/>`,
    19
  ),
  teleport: svgWrap(
    `<rect x="2" y="5" width="4" height="2" fill="currentColor" opacity="0.5"/>` +
      `<rect x="2" y="9" width="5" height="2" fill="currentColor" opacity="0.5"/>` +
      `<rect x="8" y="3" width="4" height="3" fill="currentColor"/>` +
      `<rect x="7" y="6" width="6" height="4" fill="currentColor"/>` +
      `<rect x="9" y="10" width="4" height="4" fill="currentColor"/>` +
      `<rect x="10" y="5" width="2" height="2" fill="#ffffff"/>`,
    19
  ),
  power: svgWrap(
    `<rect x="7" y="2" width="2" height="12" fill="currentColor"/>` +
      `<rect x="2" y="7" width="12" height="2" fill="currentColor"/>` +
      `<rect x="5" y="5" width="6" height="6" fill="currentColor" opacity="0.45"/>` +
      `<rect x="7" y="7" width="2" height="2" fill="#ffffff"/>`,
    19
  ),
  empty: svgWrap(
    `<rect x="7" y="3" width="2" height="2" fill="currentColor" opacity="0.55"/>` +
      `<rect x="5" y="5" width="6" height="6" fill="currentColor" opacity="0.22"/>` +
      `<rect x="3" y="7" width="2" height="2" fill="currentColor" opacity="0.55"/>` +
      `<rect x="11" y="7" width="2" height="2" fill="currentColor" opacity="0.55"/>` +
      `<rect x="7" y="11" width="2" height="2" fill="currentColor" opacity="0.55"/>`,
    18
  ),
};

const SVG_STICK_KNOB_MOVE = svgWrap(
  `<rect x="7" y="3" width="2" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="7" y="11" width="2" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="3" y="7" width="2" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="11" y="7" width="2" height="2" fill="currentColor" opacity="0.72"/>` +
    `<rect x="6" y="6" width="4" height="4" fill="currentColor" opacity="0.32"/>` +
    `<rect x="7" y="7" width="2" height="2" fill="currentColor" opacity="0.92"/>`,
  18,
  'kc-stick-knob-glyph'
);

const SVG_STICK_KNOB_AIM = svgWrap(
  `<rect x="7" y="2" width="2" height="3" fill="currentColor" opacity="0.88"/>` +
    `<rect x="7" y="11" width="2" height="3" fill="currentColor" opacity="0.88"/>` +
    `<rect x="2" y="7" width="3" height="2" fill="currentColor" opacity="0.88"/>` +
    `<rect x="11" y="7" width="3" height="2" fill="currentColor" opacity="0.88"/>` +
    `<rect x="7" y="7" width="2" height="2" fill="#ffffff"/>`,
  16,
  'kc-stick-knob-glyph'
);

interface StickElements {
  zone: HTMLDivElement;
  base: HTMLDivElement;
  knob: HTMLDivElement;
  dirGlow: HTMLDivElement;
}

interface ActionButtonRefs {
  action: VirtualControlAction;
  el: HTMLButtonElement;
  iconEl: HTMLSpanElement;
  labelEl: HTMLSpanElement;
  cdWrapEl?: HTMLDivElement;
  cdFillEl?: HTMLDivElement;
  cdTextEl?: HTMLSpanElement;
  badgeEl?: HTMLSpanElement;
}

interface ActiveStickState {
  pointerId: number;
  originX: number;
  originY: number;
  maxTravel: number;
  lastX: number;
  lastY: number;
}

function classifyWeapon(gear: GearInstance | null): WeaponVisualKind {
  if (!gear) return 'empty';
  if (SHIELD_WEAPON_IDS.has(gear.defId) || /shield/i.test(gear.defId)) return 'shield';
  if (
    RANGED_WEAPON_IDS.has(gear.defId) ||
    /bow|knife|whip|fireball/i.test(gear.defId)
  ) {
    return 'ranged';
  }
  return 'melee';
}

function classifySkill(gear: GearInstance | null): { kind: SkillVisualKind; maxCdTicks: number } {
  if (!gear) return { kind: 'empty', maxCdTicks: 360 };
  const known = SKILL_META[gear.defId];
  if (known) return { kind: known.kind, maxCdTicks: known.cooldownTicks };
  if (/grenade/i.test(gear.defId)) return { kind: 'grenade', maxCdTicks: 420 };
  if (/turret|slicer/i.test(gear.defId)) return { kind: 'turret', maxCdTicks: 600 };
  if (/trap/i.test(gear.defId)) return { kind: 'trap', maxCdTicks: 540 };
  if (/wave|dance/i.test(gear.defId)) return { kind: 'wave', maxCdTicks: 360 };
  if (/phase|blink/i.test(gear.defId)) return { kind: 'teleport', maxCdTicks: 180 };
  return { kind: 'power', maxCdTicks: 600 };
}

function colorAccentClass(color: ItemColor | undefined): string {
  switch (color) {
    case 'brutality':
      return 'is-col-brutality';
    case 'tactics':
      return 'is-col-tactics';
    case 'survival':
      return 'is-col-survival';
    case 'colorless':
      return 'is-col-colorless';
    default:
      return '';
  }
}

function formatCooldownText(ticks: number): string {
  const sec = Math.max(0.1, ticks / SIM_HZ);
  if (sec >= 9.95) return `${Math.ceil(sec)}s`;
  return `${sec.toFixed(1)}s`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function safeSetCapture(el: Element, pointerId: number): void {
  try {
    (el as HTMLElement).setPointerCapture?.(pointerId);
  } catch {
    // Synthetic PointerEvents in headless tests do not register active pointer IDs.
  }
}

function safeReleaseCapture(el: Element, pointerId: number): void {
  try {
    const h = el as HTMLElement;
    if (h.hasPointerCapture?.(pointerId)) {
      h.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore release failure on detached or synthetic pointer events.
  }
}

// =============================================================================
// TouchControls Controller Class
// =============================================================================

export class TouchControls {
  private readonly callbacks: TouchControlsCallbacks;
  private readonly root: HTMLDivElement | null = null;
  private readonly moveStickEls: StickElements | null = null;
  private readonly aimStickEls: StickElements | null = null;
  private readonly buttons = new Map<VirtualControlAction, ActionButtonRefs>();

  private visible = false;
  private disposed = false;
  private touchScale = DEFAULT_CONTROLLER_SETTINGS.touchScale;

  // Settings cache to avoid redundant style writes
  private lastSettingsSig = '';

  // Active multi-touch pointer isolation state
  private moveStick: ActiveStickState | null = null;
  private aimStick: ActiveStickState | null = null;
  private readonly actionPointers = new Map<number, { action: VirtualControlAction; el: HTMLElement }>();
  private readonly heldActionCounts = new Map<VirtualControlAction, number>();

  // Dirty-state caches for zero-churn 120fps updateState()
  private lastWeapon1Sig = '';
  private lastWeapon2Sig = '';
  private lastSkill1Sig = '';
  private lastSkill2Sig = '';
  private lastFlaskSig = '';
  private lastInteractSig = '';
  private lastRollCooling = false;
  private lastShieldBlocking = false;
  private readonly observedSkillMaxCd = new Map<number, number>();

  // Bound global handlers for clean disposal
  private readonly onWindowPointerMove: (e: PointerEvent) => void;
  private readonly onWindowPointerUp: (e: PointerEvent) => void;
  private readonly onWindowBlur: () => void;
  private readonly onVisibilityChange: () => void;

  constructor(host: HTMLElement, callbacks: TouchControlsCallbacks) {
    this.callbacks = callbacks;

    this.onWindowPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
    this.onWindowPointerUp = (e: PointerEvent) => this.handlePointerEnd(e);
    this.onWindowBlur = () => this.releaseAllInputs(false);
    this.onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        this.releaseAllInputs(false);
      }
    };

    if (typeof document === 'undefined' || !host) {
      return;
    }

    const root = document.createElement('div');
    root.className = 'kc-touch-controls kc-hidden';
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-touch-overlay', 'true');
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // 1. Top-Left Translucent Utility Pills (PAUSE + MAP)
    const topPills = document.createElement('div');
    topPills.className = 'kc-touch-top-pills';
    topPills.appendChild(this.createUtilityPill('pause', SVG_PAUSE, 'PAUSE', 'Pause Game'));
    topPills.appendChild(this.createUtilityPill('map', SVG_MAP, 'MAP', 'Toggle Map'));
    root.appendChild(topPills);

    // 2. Bottom-Left Translucent Movement Game Stick
    const moveEls = this.createStickZone('move', 'is-left', SVG_STICK_KNOB_MOVE, '');
    this.moveStickEls = moveEls;
    root.appendChild(moveEls.zone);

    // 3. Bottom-Right Deck: Compact Translucent Aim Stick + Ergonomic Action Arc
    const rightDeck = document.createElement('div');
    rightDeck.className = 'kc-touch-right-deck';

    // Aim stick + Contextual USE pill stacked gracefully on the inner-left of the right deck
    const aimColumn = document.createElement('div');
    aimColumn.className = 'kc-touch-aim-column';

    const interactBtn = this.createActionButton('interact', 'kc-touch-btn kc-touch-btn-interact is-idle', SVG_INTERACT, 'USE', 'Interact / Equip');
    aimColumn.appendChild(interactBtn.el);

    const aimEls = this.createStickZone('aim', 'is-right', SVG_STICK_KNOB_AIM, 'AIM');
    this.aimStickEls = aimEls;
    aimColumn.appendChild(aimEls.zone);
    rightDeck.appendChild(aimColumn);

    // Right Translucent Action Cluster (Dead Cells ergonomic thumb arc)
    const actionCluster = document.createElement('div');
    actionCluster.className = 'kc-touch-action-cluster';

    const healBtn = this.createActionButton('heal', 'kc-touch-btn kc-touch-btn-heal', SVG_FLASK, 'FLASK', 'Health Flask', {
      withBadge: true,
    });
    const skill1Btn = this.createActionButton('skill1', 'kc-touch-btn kc-touch-btn-skill1 is-empty', SKILL_SVGS.empty, 'S1', 'Skill 1', {
      withCooldown: true,
    });
    const skill2Btn = this.createActionButton('skill2', 'kc-touch-btn kc-touch-btn-skill2 is-empty', SKILL_SVGS.empty, 'S2', 'Skill 2', {
      withCooldown: true,
    });
    const weapon2Btn = this.createActionButton('weapon2', 'kc-touch-btn kc-touch-btn-weapon2', SVG_DUAL_BLADE, 'ATK 2', 'Weapon 2 / Parry');
    const jumpBtn = this.createActionButton('jump', 'kc-touch-btn kc-touch-btn-jump', SVG_JUMP, 'JUMP', 'Jump');
    const rollBtn = this.createActionButton('roll', 'kc-touch-btn kc-touch-btn-roll', SVG_ROLL, 'ROLL', 'Dodge Roll');
    const weapon1Btn = this.createActionButton('weapon1', 'kc-touch-btn kc-touch-btn-weapon1', SVG_SWORD, 'ATK', 'Primary Attack');

    actionCluster.append(
      healBtn.el,
      skill1Btn.el,
      skill2Btn.el,
      weapon2Btn.el,
      jumpBtn.el,
      rollBtn.el,
      weapon1Btn.el
    );

    rightDeck.appendChild(actionCluster);
    root.appendChild(rightDeck);

    host.appendChild(root);
    this.root = root;

    // Apply initial visual defaults
    this.applySettings(DEFAULT_CONTROLLER_SETTINGS, false);

    // Attach global pointer lifecycle & focus-loss guards
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this.onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', this.onWindowPointerUp, { passive: false });
      window.addEventListener('pointercancel', this.onWindowPointerUp, { passive: false });
      window.addEventListener('blur', this.onWindowBlur);
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  public setVisible(visible: boolean): void {
    if (this.disposed) return;
    const next = Boolean(visible);
    if (!next) {
      const hadVisibleOrActive =
        this.visible ||
        this.moveStick !== null ||
        this.aimStick !== null ||
        this.heldActionCounts.size > 0;
      this.visible = false;
      if (this.root) {
        this.root.classList.add('kc-hidden');
        this.root.setAttribute('aria-hidden', 'true');
      }
      if (hadVisibleOrActive) {
        this.releaseAllInputs(true);
      }
      return;
    }

    if (this.visible) return;
    this.visible = true;
    if (this.root) {
      this.root.classList.remove('kc-hidden');
      this.root.setAttribute('aria-hidden', 'false');
    }
  }

  public applySettings(settings: ControllerSettings, isTeslaBrowser = false): void {
    if (this.disposed) return;
    const opacity = clamp(
      Number.isFinite(settings.touchOpacity) ? settings.touchOpacity : DEFAULT_CONTROLLER_SETTINGS.touchOpacity,
      0.2,
      0.85
    );
    const activeOpacity = Math.min(0.95, opacity + 0.28);
    const scale = clamp(
      Number.isFinite(settings.touchScale) ? settings.touchScale : DEFAULT_CONTROLLER_SETTINGS.touchScale,
      0.75,
      1.35
    );
    const teslaFlag = Boolean(isTeslaBrowser);

    const sig = `${opacity.toFixed(3)}|${scale.toFixed(3)}|${teslaFlag ? 1 : 0}`;
    if (sig === this.lastSettingsSig) return;
    this.lastSettingsSig = sig;
    this.touchScale = scale;

    if (!this.root) return;
    this.root.style.setProperty('--kc-touch-opacity', opacity.toFixed(3));
    this.root.style.setProperty('--kc-touch-opacity-active', activeOpacity.toFixed(3));
    this.root.style.setProperty('--kc-touch-scale', scale.toFixed(3));
    if (teslaFlag) {
      this.root.setAttribute('data-tesla', 'true');
    } else {
      this.root.removeAttribute('data-tesla');
    }
  }

  public updateState(state: SimState, hasInteractable: boolean): void {
    if (this.disposed || !this.root) return;

    const player = state.player;
    const loadout = player.loadout;

    // 1. Weapon 1 dynamic icon & color accent
    const w1 = loadout.weapon1;
    const w1Kind = classifyWeapon(w1);
    const w1Color = w1?.color ?? 'brutality';
    const w1Sig = `${w1Kind}|${w1Color}`;
    if (w1Sig !== this.lastWeapon1Sig) {
      this.lastWeapon1Sig = w1Sig;
      const ref = this.buttons.get('weapon1');
      if (ref) {
        ref.el.classList.toggle('is-empty', w1Kind === 'empty');
        this.applyColorAccent(ref.el, w1?.color);
        if (w1Kind === 'ranged') {
          ref.iconEl.innerHTML = SVG_BOW;
          ref.labelEl.textContent = 'SHOT';
        } else if (w1Kind === 'shield') {
          ref.iconEl.innerHTML = SVG_SHIELD;
          ref.labelEl.textContent = 'PARRY';
        } else {
          ref.iconEl.innerHTML = SVG_SWORD;
          ref.labelEl.textContent = 'ATK';
        }
      }
    }

    // 2. Weapon 2 dynamic shield vs ranged vs blade icon & label
    const w2 = loadout.weapon2;
    const w2Kind = classifyWeapon(w2);
    const w2Color = w2?.color ?? 'survival';
    const w2Sig = `${w2Kind}|${w2Color}`;
    if (w2Sig !== this.lastWeapon2Sig) {
      this.lastWeapon2Sig = w2Sig;
      const ref = this.buttons.get('weapon2');
      if (ref) {
        ref.el.classList.toggle('is-empty', w2Kind === 'empty');
        ref.el.classList.toggle('is-shield', w2Kind === 'shield');
        ref.el.classList.toggle('is-ranged', w2Kind === 'ranged');
        this.applyColorAccent(ref.el, w2?.color);
        if (w2Kind === 'shield') {
          ref.iconEl.innerHTML = SVG_SHIELD;
          ref.labelEl.textContent = 'PARRY';
          ref.el.setAttribute('aria-label', 'Shield Parry / Block');
        } else if (w2Kind === 'ranged') {
          ref.iconEl.innerHTML = SVG_BOW;
          ref.labelEl.textContent = 'ATK 2';
          ref.el.setAttribute('aria-label', 'Ranged Secondary Weapon');
        } else {
          ref.iconEl.innerHTML = SVG_DUAL_BLADE;
          ref.labelEl.textContent = 'ATK 2';
          ref.el.setAttribute('aria-label', 'Secondary Weapon');
        }
      }
    }

    const blocking = Boolean(player.shieldBlocking);
    if (blocking !== this.lastShieldBlocking) {
      this.lastShieldBlocking = blocking;
      this.buttons.get('weapon2')?.el.classList.toggle('is-blocking', blocking);
    }

    // 3. Skill 1 & Skill 2 live cooldown curtain + timer text + color/icon
    this.updateSkillButton('skill1', loadout.skill1, 'S1');
    this.updateSkillButton('skill2', loadout.skill2, 'S2');

    // 4. Health Flask count badge + empty dim + low-HP emerald pulse
    const charges = Math.max(0, Math.floor(player.flaskCharges));
    const lowHp = charges > 0 && player.maxHp > 0 && player.hp / player.maxHp < 0.45;
    const flaskSig = `${charges}|${lowHp ? 1 : 0}`;
    if (flaskSig !== this.lastFlaskSig) {
      this.lastFlaskSig = flaskSig;
      const ref = this.buttons.get('heal');
      if (ref) {
        ref.el.classList.toggle('is-empty', charges <= 0);
        ref.el.classList.toggle('is-urgent', lowHp);
        if (ref.badgeEl) {
          ref.badgeEl.textContent = String(charges);
        }
      }
    }

    // 5. Contextual USE / Interact button warm amber-gold glow
    const interactSig = hasInteractable ? '1' : '0';
    if (interactSig !== this.lastInteractSig) {
      this.lastInteractSig = interactSig;
      const ref = this.buttons.get('interact');
      if (ref) {
        ref.el.classList.toggle('is-highlighted', hasInteractable);
        ref.el.classList.toggle('is-idle', !hasInteractable);
      }
    }

    // 6. Dodge Roll subtle cooldown cue
    const rollCooling = player.rollCooldownTicks > 0;
    if (rollCooling !== this.lastRollCooling) {
      this.lastRollCooling = rollCooling;
      this.buttons.get('roll')?.el.classList.toggle('is-cooling', rollCooling);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.releaseAllInputs(false);
    this.disposed = true;
    this.visible = false;

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this.onWindowPointerMove);
      window.removeEventListener('pointerup', this.onWindowPointerUp);
      window.removeEventListener('pointercancel', this.onWindowPointerUp);
      window.removeEventListener('blur', this.onWindowBlur);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.root?.remove();
    this.buttons.clear();
    this.observedSkillMaxCd.clear();
  }

  // ===========================================================================
  // DOM Builders
  // ===========================================================================

  private createStickZone(
    stickKind: 'move' | 'aim',
    sideClass: 'is-left' | 'is-right',
    knobGlyphSvg: string,
    rimLabel: string
  ): StickElements {
    const zone = document.createElement('div');
    zone.className = `kc-touch-stick-zone ${sideClass}`;
    zone.setAttribute('data-touch-stick', stickKind);
    zone.setAttribute('role', 'application');
    zone.setAttribute('aria-label', stickKind === 'move' ? 'Movement Stick' : 'Aim and Look Stick');

    const base = document.createElement('div');
    base.className = 'kc-touch-stick-base';

    const dirGlow = document.createElement('div');
    dirGlow.className = 'kc-stick-dir-glow';
    dirGlow.innerHTML = `<span class="kc-stick-dir-arrow" aria-hidden="true"></span>`;

    const innerRing = document.createElement('div');
    innerRing.className = 'kc-stick-inner-ring';

    // Crisp cardinal notches at N / E / S / W
    const ticks = document.createElement('div');
    ticks.className = 'kc-stick-ticks';
    ticks.innerHTML =
      `<span class="kc-stick-tick is-n" aria-hidden="true"></span>` +
      `<span class="kc-stick-tick is-e" aria-hidden="true"></span>` +
      `<span class="kc-stick-tick is-s" aria-hidden="true"></span>` +
      `<span class="kc-stick-tick is-w" aria-hidden="true"></span>`;

    const knob = document.createElement('div');
    knob.className = 'kc-touch-stick-knob';
    knob.innerHTML = `<span class="kc-stick-knob-specular" aria-hidden="true"></span>${knobGlyphSvg}`;

    base.append(dirGlow, innerRing, ticks);
    if (rimLabel) {
      const lbl = document.createElement('span');
      lbl.className = 'kc-stick-rim-label';
      lbl.textContent = rimLabel;
      base.appendChild(lbl);
    }
    base.appendChild(knob);
    zone.appendChild(base);

    zone.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        this.handleStickPointerDown(stickKind, e);
      },
      { passive: false }
    );
    zone.addEventListener('lostpointercapture', (e: PointerEvent) => {
      if (stickKind === 'move' && this.moveStick?.pointerId === e.pointerId) {
        this.releaseMoveStick(true);
      } else if (stickKind === 'aim' && this.aimStick?.pointerId === e.pointerId) {
        this.releaseAimStick(true);
      }
    });
    zone.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );

    return { zone, base, knob, dirGlow };
  }

  private createActionButton(
    action: VirtualControlAction,
    className: string,
    iconSvg: string,
    label: string,
    ariaLabel: string,
    opts?: { withCooldown?: boolean; withBadge?: boolean }
  ): ActionButtonRefs {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('data-touch-action', action);
    btn.setAttribute('aria-label', ariaLabel);

    const glassSpec = document.createElement('span');
    glassSpec.className = 'kc-touch-btn-spec';
    glassSpec.setAttribute('aria-hidden', 'true');

    const iconEl = document.createElement('span');
    iconEl.className = 'kc-touch-btn-icon';
    iconEl.innerHTML = iconSvg;

    const labelEl = document.createElement('span');
    labelEl.className = 'kc-touch-btn-label';
    labelEl.textContent = label;

    btn.append(glassSpec, iconEl, labelEl);

    const refs: ActionButtonRefs = { action, el: btn, iconEl, labelEl };

    if (opts?.withCooldown) {
      const cdWrap = document.createElement('div');
      cdWrap.className = 'kc-touch-cd-wrap kc-hidden';
      const cdFill = document.createElement('div');
      cdFill.className = 'kc-touch-cd-fill';
      const cdText = document.createElement('span');
      cdText.className = 'kc-touch-cd-text';
      cdWrap.append(cdFill, cdText);
      btn.appendChild(cdWrap);
      refs.cdWrapEl = cdWrap;
      refs.cdFillEl = cdFill;
      refs.cdTextEl = cdText;
    }

    if (opts?.withBadge) {
      const badge = document.createElement('span');
      badge.className = 'kc-touch-badge';
      badge.textContent = '0';
      btn.appendChild(badge);
      refs.badgeEl = badge;
    }

    this.bindButtonPointerEvents(btn, action);
    this.buttons.set(action, refs);
    return refs;
  }

  private createUtilityPill(
    action: VirtualControlAction,
    iconSvg: string,
    label: string,
    ariaLabel: string
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `kc-touch-pill kc-touch-pill-${action}`;
    btn.setAttribute('data-touch-action', action);
    btn.setAttribute('aria-label', ariaLabel);

    const iconEl = document.createElement('span');
    iconEl.className = 'kc-touch-pill-icon';
    iconEl.innerHTML = iconSvg;

    const labelEl = document.createElement('span');
    labelEl.className = 'kc-touch-pill-label';
    labelEl.textContent = label;

    btn.append(iconEl, labelEl);
    this.bindButtonPointerEvents(btn, action);
    this.buttons.set(action, { action, el: btn, iconEl, labelEl });
    return btn;
  }

  private bindButtonPointerEvents(btn: HTMLButtonElement, action: VirtualControlAction): void {
    btn.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (!this.visible || this.disposed) return;
        e.preventDefault();
        e.stopPropagation();
        this.callbacks.onTouchActivity();

        if (this.actionPointers.has(e.pointerId)) return;
        safeSetCapture(btn, e.pointerId);

        this.actionPointers.set(e.pointerId, { action, el: btn });
        const prevCount = this.heldActionCounts.get(action) ?? 0;
        this.heldActionCounts.set(action, prevCount + 1);
        btn.classList.add('is-active');
        if (prevCount === 0) {
          this.callbacks.onActionChange(action, true);
        }
      },
      { passive: false }
    );

    btn.addEventListener('lostpointercapture', (e: PointerEvent) => {
      this.releaseActionPointer(e.pointerId);
    });

    btn.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
  }

  // ===========================================================================
  // Stick Pointer & Vector Logic (Floating Origin + Multi-Touch Isolation)
  // ===========================================================================

  private handleStickPointerDown(stickKind: 'move' | 'aim', e: PointerEvent): void {
    if (!this.visible || this.disposed) return;
    e.preventDefault();
    e.stopPropagation();
    this.callbacks.onTouchActivity();

    const els = stickKind === 'move' ? this.moveStickEls : this.aimStickEls;
    if (!els) return;

    // Strict per-stick pointerId isolation: ignore extra fingers on an active stick
    if (stickKind === 'move' && this.moveStick !== null) return;
    if (stickKind === 'aim' && this.aimStick !== null) return;

    safeSetCapture(els.zone, e.pointerId);

    const zoneRect = els.zone.getBoundingClientRect();
    const baseRect = els.base.getBoundingClientRect();
    const fallbackBaseDiam = (stickKind === 'move' ? 124 : 90) * this.touchScale;
    const baseDiam = baseRect.width > 10 ? Math.min(baseRect.width, baseRect.height) : fallbackBaseDiam;
    const baseRadius = baseDiam * 0.5;
    const maxTravel = Math.max(18, baseRadius * 0.68);

    // Floating / dynamic origin clamped cleanly inside the stick zone
    let originX = e.clientX;
    let originY = e.clientY;
    let shiftX = 0;
    let shiftY = 0;

    if (zoneRect.width > 10 && zoneRect.height > 10) {
      const restCenterX = zoneRect.left + zoneRect.width * 0.5;
      const restCenterY = zoneRect.top + zoneRect.height * 0.5;
      const padX = Math.min(zoneRect.width * 0.45, baseRadius * 0.72);
      const padY = Math.min(zoneRect.height * 0.45, baseRadius * 0.72);

      originX = clamp(e.clientX, zoneRect.left + padX, zoneRect.right - padX);
      originY = clamp(e.clientY, zoneRect.top + padY, zoneRect.bottom - padY);
      shiftX = originX - restCenterX;
      shiftY = originY - restCenterY;
    }

    els.zone.classList.add('is-active');
    els.base.style.transform = `translate3d(${shiftX.toFixed(1)}px, ${shiftY.toFixed(1)}px, 0)`;

    const active: ActiveStickState = {
      pointerId: e.pointerId,
      originX,
      originY,
      maxTravel,
      lastX: Number.NaN,
      lastY: Number.NaN,
    };

    if (stickKind === 'move') {
      this.moveStick = active;
    } else {
      this.aimStick = active;
    }

    this.updateStickFromPoint(stickKind, e.clientX, e.clientY, true);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.disposed) return;

    if (this.moveStick && e.pointerId === this.moveStick.pointerId) {
      e.preventDefault();
      this.updateStickFromPoint('move', e.clientX, e.clientY, false);
      return;
    }

    if (this.aimStick && e.pointerId === this.aimStick.pointerId) {
      e.preventDefault();
      this.updateStickFromPoint('aim', e.clientX, e.clientY, false);
    }
  }

  private handlePointerEnd(e: PointerEvent): void {
    if (this.disposed) return;

    if (this.moveStick && e.pointerId === this.moveStick.pointerId) {
      this.releaseMoveStick(true);
      return;
    }

    if (this.aimStick && e.pointerId === this.aimStick.pointerId) {
      this.releaseAimStick(true);
      return;
    }

    if (this.actionPointers.has(e.pointerId)) {
      this.releaseActionPointer(e.pointerId);
    }
  }

  private updateStickFromPoint(
    stickKind: 'move' | 'aim',
    clientX: number,
    clientY: number,
    forceEmit: boolean
  ): void {
    const active = stickKind === 'move' ? this.moveStick : this.aimStick;
    const els = stickKind === 'move' ? this.moveStickEls : this.aimStickEls;
    if (!active || !els) return;

    const dx = clientX - active.originX;
    const dy = clientY - active.originY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, active.maxTravel);
    const angle = dist > 0.001 ? Math.atan2(dy, dx) : 0;
    const knobX = dist > 0.001 ? Math.cos(angle) * clampedDist : 0;
    const knobY = dist > 0.001 ? Math.sin(angle) * clampedDist : 0;

    const rawMag = active.maxTravel > 0 ? clampedDist / active.maxTravel : 0;
    let outX = 0;
    let outY = 0;
    if (rawMag >= STICK_MICRO_DEADZONE) {
      const scaledMag = clamp((rawMag - STICK_MICRO_DEADZONE) / (1 - STICK_MICRO_DEADZONE), 0, 1);
      outX = Math.cos(angle) * scaledMag;
      outY = Math.sin(angle) * scaledMag;
    }

    els.knob.style.transform = `translate3d(${knobX.toFixed(1)}px, ${knobY.toFixed(1)}px, 0)`;

    // Directional rim glow tracks exact tilt angle (0 deg = North/Up)
    const angleDeg = (angle * 180) / Math.PI + 90;
    els.dirGlow.style.setProperty('--stick-angle', `${angleDeg.toFixed(1)}deg`);
    els.dirGlow.style.setProperty('--stick-mag', rawMag > 0.1 ? rawMag.toFixed(3) : '0');

    // Cardinal directional notch illumination
    els.zone.classList.toggle('is-dir-l', outX <= -CARDINAL_GLOW_THRESHOLD);
    els.zone.classList.toggle('is-dir-r', outX >= CARDINAL_GLOW_THRESHOLD);
    els.zone.classList.toggle('is-dir-u', outY <= -CARDINAL_GLOW_THRESHOLD);
    els.zone.classList.toggle('is-dir-d', outY >= CARDINAL_GLOW_THRESHOLD);

    const changed =
      forceEmit ||
      Math.abs(outX - active.lastX) > 1e-4 ||
      Math.abs(outY - active.lastY) > 1e-4;
    if (!changed) return;

    active.lastX = outX;
    active.lastY = outY;

    if (stickKind === 'move') {
      this.callbacks.onMoveStick(outX, outY);
    } else {
      this.callbacks.onAimStick(outX, outY, true);
    }
  }

  private releaseMoveStick(emitNeutral: boolean): void {
    const active = this.moveStick;
    this.moveStick = null;
    if (this.moveStickEls) {
      if (active) safeReleaseCapture(this.moveStickEls.zone, active.pointerId);
      this.resetStickVisuals(this.moveStickEls);
    }
    if (emitNeutral) {
      this.callbacks.onMoveStick(0, 0);
    }
  }

  private releaseAimStick(emitNeutral: boolean): void {
    const active = this.aimStick;
    this.aimStick = null;
    if (this.aimStickEls) {
      if (active) safeReleaseCapture(this.aimStickEls.zone, active.pointerId);
      this.resetStickVisuals(this.aimStickEls);
    }
    if (emitNeutral) {
      this.callbacks.onAimStick(0, 0, false);
    }
  }

  private resetStickVisuals(els: StickElements): void {
    els.zone.classList.remove('is-active', 'is-dir-l', 'is-dir-r', 'is-dir-u', 'is-dir-d');
    els.base.style.transform = '';
    els.knob.style.transform = '';
    els.dirGlow.style.setProperty('--stick-mag', '0');
  }

  private releaseActionPointer(pointerId: number): void {
    const entry = this.actionPointers.get(pointerId);
    if (!entry) return;
    this.actionPointers.delete(pointerId);
    safeReleaseCapture(entry.el, pointerId);

    const remaining = Math.max(0, (this.heldActionCounts.get(entry.action) ?? 1) - 1);
    if (remaining === 0) {
      this.heldActionCounts.delete(entry.action);
      entry.el.classList.remove('is-active');
      this.callbacks.onActionChange(entry.action, false);
    } else {
      this.heldActionCounts.set(entry.action, remaining);
    }
  }

  private releaseAllInputs(forceEmitSticks: boolean): void {
    const moveWasActive = this.moveStick !== null;
    const aimWasActive = this.aimStick !== null;

    this.releaseMoveStick(moveWasActive || forceEmitSticks);
    this.releaseAimStick(aimWasActive || forceEmitSticks);

    // Release captures for every tracked action pointer
    for (const [pointerId, entry] of this.actionPointers) {
      safeReleaseCapture(entry.el, pointerId);
      entry.el.classList.remove('is-active');
    }
    this.actionPointers.clear();

    // Emit released state for every currently held action so zero inputs stick
    const held = Array.from(this.heldActionCounts.keys());
    this.heldActionCounts.clear();
    for (const action of held) {
      this.buttons.get(action)?.el.classList.remove('is-active');
      this.callbacks.onActionChange(action, false);
    }
  }

  // ===========================================================================
  // Live HUD State Helpers
  // ===========================================================================

  private updateSkillButton(
    action: 'skill1' | 'skill2',
    gear: GearInstance | null,
    slotLabel: 'S1' | 'S2'
  ): void {
    const ref = this.buttons.get(action);
    if (!ref) return;

    const meta = classifySkill(gear);
    let cdTicks = 0;
    let cdPct = 0;
    let cdText = '';

    if (gear && gear.cooldownTicks > 0) {
      cdTicks = gear.cooldownTicks;
      const prevObserved = this.observedSkillMaxCd.get(gear.uid) ?? meta.maxCdTicks;
      const maxCd = Math.max(prevObserved, cdTicks, 1);
      if (maxCd !== prevObserved) {
        this.observedSkillMaxCd.set(gear.uid, maxCd);
      }
      cdPct = clamp(cdTicks / maxCd, 0, 1);
      cdText = formatCooldownText(cdTicks);
    }

    const colorKey = gear?.color ?? 'none';
    const pctBucket = Math.round(cdPct * 100);
    const sig = `${gear?.defId ?? 'empty'}|${meta.kind}|${colorKey}|${pctBucket}|${cdText}`;
    const lastSig = action === 'skill1' ? this.lastSkill1Sig : this.lastSkill2Sig;
    if (sig === lastSig) return;

    if (action === 'skill1') {
      this.lastSkill1Sig = sig;
    } else {
      this.lastSkill2Sig = sig;
    }

    const isEmpty = gear === null;
    ref.el.classList.toggle('is-empty', isEmpty);
    ref.el.classList.toggle('is-on-cooldown', cdTicks > 0);
    this.applyColorAccent(ref.el, gear?.color);

    if (ref.el.dataset.skillIconKind !== meta.kind) {
      ref.el.dataset.skillIconKind = meta.kind;
      ref.iconEl.innerHTML = SKILL_SVGS[meta.kind];
    }
    ref.labelEl.textContent = slotLabel;

    if (ref.cdWrapEl && ref.cdFillEl && ref.cdTextEl) {
      if (cdTicks > 0) {
        ref.cdWrapEl.classList.remove('kc-hidden');
        ref.cdFillEl.style.height = `${pctBucket}%`;
        ref.cdTextEl.textContent = cdText;
      } else {
        ref.cdWrapEl.classList.add('kc-hidden');
        ref.cdFillEl.style.height = '0%';
        ref.cdTextEl.textContent = '';
      }
    }
  }

  private applyColorAccent(el: HTMLElement, color?: ItemColor): void {
    el.classList.remove(
      'is-col-brutality',
      'is-col-tactics',
      'is-col-survival',
      'is-col-colorless'
    );
    const cls = colorAccentClass(color);
    if (cls) el.classList.add(cls);
  }
}
