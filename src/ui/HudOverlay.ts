// =============================================================================
// KRUNKED CELLS — Pixel-Crisp Gothic HUD Overlay, Loot Card, Boss Bar & Floaters
// Decoupled from src/data/** via optional CatalogLookup + curated fallbacks.
// =============================================================================

import {
  AffixDef,
  BiomeDef,
  BiomeId,
  BossDef,
  BossId,
  DifficultyDef,
  GearInstance,
  GearQuality,
  ItemColor,
  KeyBindings,
  MAX_BOSS_CELLS,
  MetaBlueprintDef,
  MutationDef,
  PickupState,
  SCROLL_DAMAGE_BASE,
  SIM_HZ,
  ScrollStat,
  SimCommand,
  SimEvent,
  SimState,
  SkillDef,
  VIEWPORT_H,
  VIEWPORT_W,
  WeaponDef,
} from '../contracts';
import { CameraOriginMode, computeCanvasDrawRect, resolveCameraTopLeft } from '../input';

export interface CatalogLookup {
  getWeapon?(id: string): WeaponDef | undefined;
  getSkill?(id: string): SkillDef | undefined;
  getMutation?(id: string): MutationDef | undefined;
  getAffix?(id: string): AffixDef | undefined;
  getBiome?(id: BiomeId): BiomeDef | undefined;
  getBoss?(id: BossId): BossDef | undefined;
  getDifficulty?(bc: number): DifficultyDef | undefined;
  weapons?: readonly WeaponDef[];
  skills?: readonly SkillDef[];
  mutations?: readonly MutationDef[];
  biomes?: readonly BiomeDef[];
  bosses?: readonly BossDef[];
  metaBlueprints?: readonly MetaBlueprintDef[];
}

export interface HudCallbacks {
  onDispatchCommand(cmd: SimCommand): void;
  onPlayUiClick?(kind?: 'select' | 'confirm' | 'cancel' | 'error'): void;
  onToggleMinimap?(): void;
}

// =============================================================================
// Shared Display Helpers & Oracle-Matched Fallbacks
// =============================================================================

export const ALL_BIOME_IDS: readonly BiomeId[] = [
  'PrisonStart',
  'PrisonCourtyard',
  'Sewer',
  'PrisonRoof',
  'Bridge',
  'StiltVillage',
  'ClockTower',
  'TopClockTower',
  'Castle',
  'Throne',
  'Passage',
];

export const FALLBACK_BIOME_NAMES: Record<BiomeId, string> = {
  PrisonStart: "Prisoner's Quarters",
  PrisonCourtyard: 'Promenade of the Condemned',
  Sewer: 'Toxic Sewers',
  PrisonRoof: 'Ramparts',
  Bridge: 'Black Bridge',
  StiltVillage: 'Stilt Village',
  ClockTower: 'Clock Tower',
  TopClockTower: 'Clock Room',
  Castle: 'High Peak Castle',
  Throne: 'Throne Room',
  Passage: 'The Passage',
};

export const FALLBACK_BOSS_INFO: Record<BossId, { name: string; subtitle: string }> = {
  Behemoth: { name: 'The Iron Concierge', subtitle: 'Warden of the Black Bridge' },
  TimeKeeper: { name: 'The Chrono Warden', subtitle: 'Keeper of the Shattered Clock' },
  KingsHand: { name: 'The Sovereign Hand', subtitle: 'Executioner of the Throne' },
};

export const FALLBACK_WEAPONS: ReadonlyArray<{ id: string; name: string; kind: 'melee' | 'ranged' | 'shield'; color: ScrollStat }> = [
  { id: 'StartSword', name: 'Rusty Sword', kind: 'melee', color: 'brutality' },
  { id: 'QuickSword', name: 'Balanced Blade', kind: 'melee', color: 'brutality' },
  { id: 'DualDaggers', name: 'Twin Daggers', kind: 'melee', color: 'brutality' },
  { id: 'BackStabber', name: "Assassin's Dagger", kind: 'melee', color: 'brutality' },
  { id: 'Bleeder', name: 'Blood Sword', kind: 'melee', color: 'brutality' },
  { id: 'BroadSword', name: 'Broadsword', kind: 'melee', color: 'survival' },
  { id: 'StunMace', name: 'Nutcracker', kind: 'melee', color: 'survival' },
  { id: 'SpeedBlade', name: 'Swift Sword', kind: 'melee', color: 'brutality' },
  { id: 'ImpaleSpear', name: 'Impaler', kind: 'melee', color: 'brutality' },
  { id: 'Rapier', name: 'Rapier', kind: 'melee', color: 'brutality' },
  { id: 'Whip', name: 'Electric Whip', kind: 'ranged', color: 'tactics' },
  { id: 'CloseCombatBow', name: 'Infantry Bow', kind: 'ranged', color: 'tactics' },
  { id: 'FastBow', name: 'Quick Bow', kind: 'ranged', color: 'tactics' },
  { id: 'FrostBow', name: 'Ice Bow', kind: 'ranged', color: 'tactics' },
  { id: 'ThrowingKnife', name: 'Throwing Knife', kind: 'ranged', color: 'tactics' },
  { id: 'Fireball', name: 'Pyrotechnics', kind: 'ranged', color: 'tactics' },
  { id: 'StartShield', name: 'Wooden Shield', kind: 'shield', color: 'survival' },
  { id: 'StunShield', name: 'Cudgel', kind: 'shield', color: 'survival' },
  { id: 'BleedShield', name: 'Bloodthirsty Shield', kind: 'shield', color: 'brutality' },
  { id: 'ForceShield', name: 'Rampart', kind: 'shield', color: 'survival' },
];

export const FALLBACK_SKILLS: ReadonlyArray<{ id: string; name: string; kind: string; color: ScrollStat }> = [
  { id: 'SinewSlicer', name: 'Sinew Slicer', kind: 'turret', color: 'tactics' },
  { id: 'HeavyTurret', name: 'Heavy Turret', kind: 'turret', color: 'tactics' },
  { id: 'InfantryGrenade', name: 'Infantry Grenade', kind: 'grenade', color: 'brutality' },
  { id: 'FireGrenade', name: 'Fire Grenade', kind: 'grenade', color: 'brutality' },
  { id: 'IceGrenade', name: 'Ice Grenade', kind: 'grenade', color: 'survival' },
  { id: 'ClusterGrenade', name: 'Cluster Grenade', kind: 'grenade', color: 'brutality' },
  { id: 'Phaser', name: 'Phaser', kind: 'teleport', color: 'brutality' },
  { id: 'WolfTrap', name: 'Wolf Trap', kind: 'trap', color: 'survival' },
  { id: 'WaveOfDenial', name: 'Wave of Denial', kind: 'wave', color: 'tactics' },
  { id: 'CorruptedPower', name: 'Corrupted Power', kind: 'power', color: 'brutality' },
  { id: 'KnifeDance', name: 'Knife Dance', kind: 'wave', color: 'tactics' },
  { id: 'Tonic', name: 'Tonic', kind: 'power', color: 'survival' },
];

export const FALLBACK_MUTATIONS: ReadonlyArray<{ id: string; name: string; color: ItemColor; description: string }> = [
  { id: 'Combo', name: 'Combo', color: 'brutality', description: 'Increases melee damage for 8s after each kill.' },
  { id: 'OpenWounds', name: 'Open Wounds', color: 'brutality', description: 'Melee hits inflict Bleed on enemies.' },
  { id: 'Melee', name: 'Melee', color: 'brutality', description: 'Melee attacks apply Slow to enemies.' },
  { id: 'Predator', name: 'Predator', color: 'brutality', description: 'Brief invisibility after a melee kill.' },
  { id: 'Vengeance', name: 'Vengeance', color: 'brutality', description: 'Deal bonus damage and take less damage after being hit.' },
  { id: 'Support', name: 'Support', color: 'tactics', description: 'Bonus DPS while near a deployed turret or trap.' },
  { id: 'PointBlank', name: 'Point Blank', color: 'tactics', description: 'Ranged attacks deal extra damage at close range.' },
  { id: 'BarbedTips', name: 'Barbed Tips', color: 'tactics', description: 'Arrows embedded in foes inflict continuous damage.' },
  { id: 'Tranquility', name: 'Tranquility', color: 'tactics', description: 'Deal bonus damage when no enemies are right next to you.' },
  { id: 'Necromancy', name: 'Necromancy', color: 'survival', description: 'Recover a percentage of max HP on every kill.' },
  { id: 'Gastronomy', name: 'Gastronomy', color: 'survival', description: 'Food heals 65% more HP.' },
  { id: 'WhatDoesntKillMe', name: "What Doesn't Kill Me", color: 'survival', description: 'Parrying a melee attack restores HP.' },
  { id: 'Armadillopack', name: 'Armadillopack', color: 'survival', description: 'Rolling triggers shield parry shockwaves.' },
  { id: 'Disengagement', name: 'Disengagement', color: 'colorless', description: 'Grants an emergency 5s forcefield below 15% HP.' },
  { id: 'InstinctOfTheMaster', name: 'Instinct of the Master', color: 'colorless', description: 'Critical hits reduce active skill cooldowns.' },
];

export const FALLBACK_META_BLUEPRINTS: readonly MetaBlueprintDef[] = [
  { id: 'HealthFlask', name: 'Health Flask', description: 'Add permanent healing flask charges (up to IV).', category: 'upgrade', maxTier: 4, costs: [5, 15, 35, 65] },
  { id: 'GoldReserves', name: 'Gold Reserves', description: 'Retain Gold between runs upon death (up to IV).', category: 'upgrade', maxTier: 4, costs: [10, 25, 45, 75] },
  { id: 'RandomStarter', name: 'Random Starter Weapons', description: 'Start each run with random unlocked weapons.', category: 'upgrade', maxTier: 1, costs: [20] },
  { id: 'Recycling', name: 'Recycling', description: 'Convert unwanted ground gear directly into Gold.', category: 'upgrade', maxTier: 1, costs: [15] },
  { id: 'BackStabber', name: "Assassin's Dagger", description: 'Always crits when striking enemies from behind.', category: 'weapon', maxTier: 1, costs: [25], targetId: 'BackStabber' },
  { id: 'Bleeder', name: 'Blood Sword', description: 'Rapid slashes that stack lethal Bleed.', category: 'weapon', maxTier: 1, costs: [20], targetId: 'Bleeder' },
  { id: 'BroadSword', name: 'Broadsword', description: 'Massive two-handed cleaves with high breach.', category: 'weapon', maxTier: 1, costs: [25], targetId: 'BroadSword' },
  { id: 'Rapier', name: 'Rapier', description: 'Guaranteed Crits right after rolling or parrying.', category: 'weapon', maxTier: 1, costs: [30], targetId: 'Rapier' },
  { id: 'Whip', name: 'Electric Whip', description: 'Auto-aimed chain lightning arc.', category: 'weapon', maxTier: 1, costs: [30], targetId: 'Whip' },
  { id: 'Fireball', name: 'Pyrotechnics', description: 'Hurls searing fireballs that ignite oil.', category: 'weapon', maxTier: 1, costs: [30], targetId: 'Fireball' },
  { id: 'ForceShield', name: 'Rampart', description: 'Parrying grants a 2-second invulnerable forcefield.', category: 'weapon', maxTier: 1, costs: [35], targetId: 'ForceShield' },
  { id: 'HeavyTurret', name: 'Heavy Turret', description: 'Armored turret that boosts nearby player DPS.', category: 'skill', maxTier: 1, costs: [30], targetId: 'HeavyTurret' },
  { id: 'FireGrenade', name: 'Fire Grenade', description: 'Engulfs a wide zone in burning flames.', category: 'skill', maxTier: 1, costs: [25], targetId: 'FireGrenade' },
  { id: 'Phaser', name: 'Phaser', description: 'Teleport behind the nearest enemy and empower next hit.', category: 'skill', maxTier: 1, costs: [35], targetId: 'Phaser' },
  { id: 'WaveOfDenial', name: 'Wave of Denial', description: 'Shockwave blasting foes into walls & reflecting projectiles.', category: 'skill', maxTier: 1, costs: [30], targetId: 'WaveOfDenial' },
  { id: 'OpenWounds', name: 'Open Wounds', description: 'Mutation: melee hits inflict Bleed.', category: 'mutation', maxTier: 1, costs: [25], targetId: 'OpenWounds' },
  { id: 'InstinctOfTheMaster', name: 'Instinct of the Master', description: 'Mutation: critical hits shave skill cooldowns.', category: 'mutation', maxTier: 1, costs: [35], targetId: 'InstinctOfTheMaster' },
];

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function humanizeId(id: string): string {
  return id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

export function formatRoman(level: number): string {
  const n = Math.max(1, Math.min(20, Math.floor(level)));
  const table: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let rem = n;
  let out = '';
  for (const [val, sym] of table) {
    while (rem >= val) {
      out += sym;
      rem -= val;
    }
  }
  return out;
}

export function formatGearBadge(level: number, quality: GearQuality): string {
  const rom = formatRoman(level);
  if (quality === 'base') return rom;
  if (quality === '+' || quality === '++') return `${rom}${quality}`;
  return `${rom}-${quality}`;
}

export function formatTimer(ticks: number): string {
  const totalSec = Math.max(0, Math.floor(ticks / SIM_HZ));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatKeyCode(code: string): string {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Space: 'SPC',
    ShiftLeft: 'L-SHF',
    ShiftRight: 'R-SHF',
    ControlLeft: 'L-CTL',
    ControlRight: 'R-CTL',
    AltLeft: 'L-ALT',
    AltRight: 'R-ALT',
    Escape: 'ESC',
    Tab: 'TAB',
    Enter: 'ENT',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    Backspace: 'BKSP',
  };
  return map[code] ?? code.toUpperCase().slice(0, 5);
}

export function getScrollDamageMultiplier(count: number): number {
  return Math.pow(SCROLL_DAMAGE_BASE, Math.max(0, count - 1));
}

export function getScrollDamagePct(count: number): number {
  return Math.round(getScrollDamageMultiplier(count) * 100);
}

export function computeScrollHpGainPct(stat: ScrollStat, currentCount: number): number {
  const n = Math.max(1, currentCount);
  if (stat === 'brutality') {
    return Math.max(6, Math.round(65 * Math.pow(0.84, n - 1)));
  }
  if (stat === 'tactics') {
    return Math.max(4, Math.round(50 * Math.pow(0.82, n - 1)));
  }
  return Math.max(9, Math.round(80 * Math.pow(0.86, n - 1)));
}

export function getQualityBonus(quality: GearQuality): number {
  switch (quality) {
    case '+':
      return 2;
    case '++':
      return 4;
    case 'S':
    case 'L':
      return 6;
    default:
      return 0;
  }
}

export function getBiomeDisplayName(id: BiomeId, catalog?: CatalogLookup): string {
  return catalog?.getBiome?.(id)?.name ?? FALLBACK_BIOME_NAMES[id] ?? humanizeId(id);
}

export function getBossDisplayInfo(id: BossId, catalog?: CatalogLookup): { name: string; subtitle: string } {
  const def = catalog?.getBoss?.(id);
  if (def) return { name: def.name, subtitle: def.subtitle };
  return FALLBACK_BOSS_INFO[id] ?? { name: humanizeId(id), subtitle: 'Guardian' };
}

export function getGearDisplayInfo(
  gear: GearInstance,
  catalog?: CatalogLookup
): { name: string; description: string; glyph: string; basePower: number; cooldownTicks: number } {
  if (gear.slotKind === 'weapon') {
    const def = catalog?.getWeapon?.(gear.defId);
    if (def) {
      const glyph = def.kind === 'shield' ? '🛡' : def.kind === 'ranged' ? '🏹' : '⚔';
      const bp = def.strikeChain[0]?.basePower ?? 45;
      return { name: def.name, description: def.description, glyph, basePower: bp, cooldownTicks: 0 };
    }
    const fb = FALLBACK_WEAPONS.find((w) => w.id === gear.defId);
    const glyph = fb?.kind === 'shield' ? '🛡' : fb?.kind === 'ranged' ? '🏹' : '⚔';
    return {
      name: fb?.name ?? humanizeId(gear.defId),
      description: 'Battle-forged weapon.',
      glyph,
      basePower: 50,
      cooldownTicks: 0,
    };
  }

  if (gear.slotKind === 'skill') {
    const def = catalog?.getSkill?.(gear.defId);
    if (def) {
      const glyphMap: Record<string, string> = {
        turret: '⚙',
        grenade: '💣',
        power: '✦',
        trap: '⛓',
        wave: '◈',
        teleport: '⚡',
      };
      return {
        name: def.name,
        description: def.description,
        glyph: glyphMap[def.kind] ?? '✦',
        basePower: def.basePower,
        cooldownTicks: def.cooldownTicks,
      };
    }
    const fb = FALLBACK_SKILLS.find((s) => s.id === gear.defId);
    return {
      name: fb?.name ?? humanizeId(gear.defId),
      description: 'Tactical combat skill.',
      glyph: fb?.kind === 'grenade' ? '💣' : fb?.kind === 'turret' ? '⚙' : '✦',
      basePower: 70,
      cooldownTicks: 360,
    };
  }

  return {
    name: humanizeId(gear.defId),
    description: gear.dmgReductionPct ? `-${gear.dmgReductionPct}% damage taken` : 'Mystic amulet.',
    glyph: '❖',
    basePower: 0,
    cooldownTicks: 0,
  };
}

export function getMutationDisplayInfo(
  id: string,
  catalog?: CatalogLookup
): { name: string; description: string; color: ItemColor; monogram: string } {
  const def = catalog?.getMutation?.(id);
  if (def) {
    return {
      name: def.name,
      description: def.description,
      color: def.color,
      monogram: def.name
        .split(/\s+/)
        .map((w) => w[0] ?? '')
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    };
  }
  const fb = FALLBACK_MUTATIONS.find((m) => m.id === id);
  const name = fb?.name ?? humanizeId(id);
  return {
    name,
    description: fb?.description ?? 'Enhances combat capabilities.',
    color: fb?.color ?? 'colorless',
    monogram: name
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase(),
  };
}

export function getAffixDisplayLabel(affixId: string, catalog?: CatalogLookup): string {
  return catalog?.getAffix?.(affixId)?.label ?? humanizeId(affixId);
}

export function estimateGearPower(gear: GearInstance, state: SimState, catalog?: CatalogLookup): number {
  const info = getGearDisplayInfo(gear, catalog);
  if (info.basePower <= 0) return 0;
  const effLevel = gear.level + getQualityBonus(gear.quality);
  const levelMult = Math.pow(1.07, Math.max(0, effLevel - 1));
  const scrolls = state.player.scrolls;
  const statCount =
    gear.color === 'colorless' || gear.quality === 'L'
      ? Math.max(scrolls.brutality, scrolls.tactics, scrolls.survival)
      : scrolls[gear.color];
  return Math.round(info.basePower * levelMult * getScrollDamageMultiplier(statCount));
}

// =============================================================================
// Floating Combat Numbers Pool
// =============================================================================

interface FloatingTextItem {
  id: number;
  simUid: number | null;
  worldX: number;
  worldY: number;
  vx: number;
  vy: number;
  text: string;
  className: string;
  color: string;
  ttl: number;
  maxTtl: number;
  el: HTMLDivElement;
}

const MAX_FLOATERS = 36;

export class HudOverlay {
  private hudRoot: HTMLElement;
  private canvas: HTMLCanvasElement | null;
  private catalog?: CatalogLookup;
  private callbacks: HudCallbacks;
  private cameraOriginMode: CameraOriginMode = 'auto';

  // Persistent DOM containers
  private floatLayer: HTMLDivElement;
  private bossBanner: HTMLDivElement;
  private toastBanner: HTMLDivElement;
  private trContainer: HTMLDivElement;
  private minimapHost: HTMLDivElement;
  private blContainer: HTMLDivElement;
  private lootCardEl: HTMLDivElement;
  private interactEl: HTMLDivElement;

  // Dynamic cached regions
  private biomeNameEl!: HTMLSpanElement;
  private bcPipsEl!: HTMLDivElement;
  private goldEl!: HTMLSpanElement;
  private cellsEl!: HTMLSpanElement;
  private timerEl!: HTMLSpanElement;
  private streakEl!: HTMLDivElement;
  private curseEl!: HTMLDivElement;

  private flaskLiquidEl!: HTMLDivElement;
  private flaskPipsEl!: HTMLDivElement;
  private flaskKeyEl!: HTMLSpanElement;
  private hpTextEl!: HTMLSpanElement;
  private hpStatusEl!: HTMLDivElement;
  private hpRallyEl!: HTMLDivElement;
  private hpFillEl!: HTMLDivElement;
  private gearSlotEls: HTMLDivElement[] = [];
  private scrollSlotEls: Record<ScrollStat, { count: HTMLSpanElement; pct: HTMLSpanElement }> = {} as Record<
    ScrollStat,
    { count: HTMLSpanElement; pct: HTMLSpanElement }
  >;
  private mutationEls: HTMLDivElement[] = [];

  private bossTitleEl!: HTMLSpanElement;
  private bossSubEl!: HTMLSpanElement;
  private bossPhaseEl!: HTMLSpanElement;
  private bossFillEl!: HTMLDivElement;
  private bossHpTextEl!: HTMLDivElement;

  private floaters: FloatingTextItem[] = [];
  private seenParticleUids = new Set<number>();
  private nextFloaterId = 1;
  private toastTimer = 0;

  private lastLootSignature = '';
  private lastInteractSignature = '';
  private lastLoadoutSignature = '';
  private activeNearbyPickup: PickupState | null = null;
  private visible = false;

  constructor(
    hudRoot: HTMLElement,
    canvas: HTMLCanvasElement | null,
    callbacks: HudCallbacks,
    catalog?: CatalogLookup
  ) {
    this.hudRoot = hudRoot;
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.catalog = catalog;

    this.hudRoot.innerHTML = '';

    this.floatLayer = document.createElement('div');
    this.floatLayer.className = 'kc-float-layer';
    this.hudRoot.appendChild(this.floatLayer);

    this.bossBanner = this.createBossBanner();
    this.hudRoot.appendChild(this.bossBanner);

    this.toastBanner = document.createElement('div');
    this.toastBanner.className = 'kc-toast-banner';
    this.hudRoot.appendChild(this.toastBanner);

    this.trContainer = document.createElement('div');
    this.trContainer.className = 'kc-hud-tr';
    this.minimapHost = document.createElement('div');
    this.buildTopRight();
    this.hudRoot.appendChild(this.trContainer);

    this.blContainer = document.createElement('div');
    this.blContainer.className = 'kc-hud-bl';
    this.buildBottomLeft();
    this.hudRoot.appendChild(this.blContainer);

    this.interactEl = document.createElement('div');
    this.interactEl.className = 'kc-interact-prompt kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.interactEl);

    this.lootCardEl = document.createElement('div');
    this.lootCardEl.className = 'kc-loot-card kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.lootCardEl);

    this.setVisible(false);
  }

  public getMinimapHost(): HTMLDivElement {
    return this.minimapHost;
  }

  public setCameraOriginMode(mode: CameraOriginMode): void {
    this.cameraOriginMode = mode;
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
    this.lastLoadoutSignature = '';
    this.lastLootSignature = '';
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.hudRoot.classList.toggle('kc-hidden', !visible);
  }

  public showToast(text: string, durationSec = 2.6): void {
    this.toastBanner.textContent = text;
    this.toastBanner.classList.add('is-visible');
    this.toastTimer = durationSec;
  }

  public triggerQuickLootAction(action: 'equip1' | 'equip2' | 'recycle', state: SimState): boolean {
    const pickup = this.activeNearbyPickup;
    if (!pickup || !pickup.gear || pickup.collected) return false;
    if (action === 'recycle') {
      if (!state.metaSnapshot.recycleUnlocked || (pickup.priceGold && pickup.priceGold > 0)) {
        return false;
      }
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({ type: 'recyclePickup', pickupUid: pickup.uid });
      return true;
    }
    const price = pickup.priceGold ?? 0;
    if (price > state.player.gold) {
      this.callbacks.onPlayUiClick?.('error');
      this.showToast(`Need ${price} Gold`, 1.4);
      return true;
    }
    const targetSlot: 1 | 2 = action === 'equip2' ? 2 : 1;
    this.callbacks.onPlayUiClick?.('confirm');
    this.callbacks.onDispatchCommand({
      type: 'equipPickup',
      pickupUid: pickup.uid,
      targetSlot,
    });
    return true;
  }

  public ingestEvents(events: readonly SimEvent[], state: SimState): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'hitImpact':
          this.spawnFloater(
            ev.x,
            ev.y - 14,
            `${Math.max(1, Math.round(ev.damage))}`,
            'kc-float-num',
            '#ffffff',
            0.75
          );
          break;
        case 'critImpact':
          this.spawnFloater(
            ev.x,
            ev.y - 20,
            `CRIT! ${Math.max(1, Math.round(ev.damage))}`,
            'kc-float-num is-crit',
            '#fbbf24',
            0.95
          );
          break;
        case 'parrySuccess':
          this.spawnFloater(
            ev.x,
            ev.y - 24,
            ev.reflected ? 'PARRY! REFLECT!' : 'PARRY!',
            'kc-float-num is-parry',
            '#fff3b0',
            1.05
          );
          break;
        case 'playerDamaged':
          this.spawnFloater(
            ev.x,
            ev.y - 20,
            `-${Math.max(1, Math.round(ev.amount))}`,
            'kc-float-num is-player-dmg',
            '#ff4757',
            0.95
          );
          break;
        case 'flaskDrink':
          this.spawnFloater(
            ev.x,
            ev.y - 22,
            `+${Math.round(ev.healed)} HP`,
            'kc-float-num is-heal',
            '#4ade80',
            1.0
          );
          break;
        case 'rallyRecovered':
          if (ev.amount >= 1) {
            this.spawnFloater(
              ev.x,
              ev.y - 16,
              `+${Math.round(ev.amount)}`,
              'kc-float-num is-status',
              '#ff8c24',
              0.7
            );
          }
          break;
        case 'statusProc': {
          const statusColorMap: Record<string, string> = {
            bleed: '#f43f5e',
            poison: '#4ade80',
            burn: '#fb923c',
            oil: '#a78bfa',
            frost: '#7dd3fc',
            freeze: '#38bdf8',
            root: '#86efac',
            slow: '#93c5fd',
            electrify: '#fde047',
            stun: '#fbbf24',
            speed: '#38e8ff',
            shield: '#93c5fd',
            corrupted: '#c084fc',
          };
          this.spawnFloater(
            ev.x,
            ev.y - 18,
            ev.status.toUpperCase(),
            'kc-float-num is-status',
            statusColorMap[ev.status] ?? '#e2e8f0',
            0.75
          );
          break;
        }
        case 'curseTriggered':
          this.showToast(`CURSED! KILL ${ev.killsRequired} ENEMIES WITHOUT TAKING A HIT`, 3.2);
          break;
        case 'curseCleared':
          this.showToast('CURSE LIFTED!', 2.2);
          break;
        case 'biomeTransition':
          this.showToast(getBiomeDisplayName(ev.to, this.catalog), 2.8);
          break;
        case 'bossPhaseShift': {
          const boss = getBossDisplayInfo(ev.bossId, this.catalog);
          this.showToast(`${boss.name} — PHASE ${ev.phase}`, 2.4);
          break;
        }
        default:
          break;
      }
    }

    // Sync any simulation-emitted floating text particles (deduplicated by uid)
    for (const p of state.particlesSim) {
      if (p.kind === 'text' && p.text && !this.seenParticleUids.has(p.uid)) {
        this.seenParticleUids.add(p.uid);
        const isCrit = p.text.includes('CRIT') || p.text.includes('!');
        this.spawnFloater(
          p.pos.x,
          p.pos.y,
          p.text,
          isCrit ? 'kc-float-num is-crit' : 'kc-float-num',
          p.color || '#ffffff',
          Math.max(0.5, p.ttlTicks / SIM_HZ),
          p.uid
        );
      }
    }
    if (this.seenParticleUids.size > 256) {
      this.seenParticleUids.clear();
    }
  }

  public update(state: SimState, bindings: KeyBindings, dtSec: number, interpAlpha = 1): void {
    const showHud =
      state.runStatus === 'playing' ||
      state.runStatus === 'passage' ||
      state.runStatus === 'paused';
    this.setVisible(showHud);
    if (!showHud) return;

    this.updateTopRight(state);
    this.updateBottomLeft(state, bindings);
    this.updateBossBar(state);
    this.updateNearbyLootAndPrompts(state, bindings);
    this.updateFloaters(state, dtSec, interpAlpha);

    if (this.toastTimer > 0) {
      this.toastTimer -= dtSec;
      if (this.toastTimer <= 0) {
        this.toastBanner.classList.remove('is-visible');
      }
    }
  }

  public dispose(): void {
    this.hudRoot.innerHTML = '';
    this.floaters = [];
  }

  private createBossBanner(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'kc-boss-banner kc-iron-panel kc-hidden';
    el.innerHTML = `
      <div class="kc-boss-header">
        <div>
          <span class="kc-boss-title"></span>
          <span class="kc-boss-subtitle"></span>
        </div>
        <span class="kc-boss-phase"></span>
      </div>
      <div class="kc-boss-bar-track">
        <div class="kc-boss-bar-fill"></div>
        <div class="kc-boss-bar-ticks"></div>
        <div class="kc-boss-hp-text"></div>
      </div>
    `;
    this.bossTitleEl = el.querySelector('.kc-boss-title') as HTMLSpanElement;
    this.bossSubEl = el.querySelector('.kc-boss-subtitle') as HTMLSpanElement;
    this.bossPhaseEl = el.querySelector('.kc-boss-phase') as HTMLSpanElement;
    this.bossFillEl = el.querySelector('.kc-boss-bar-fill') as HTMLDivElement;
    this.bossHpTextEl = el.querySelector('.kc-boss-hp-text') as HTMLDivElement;
    return el;
  }

  private buildTopRight(): void {
    const biomeRow = document.createElement('div');
    biomeRow.className = 'kc-biome-header kc-iron-panel';
    this.biomeNameEl = document.createElement('span');
    this.biomeNameEl.className = 'kc-biome-name';
    this.bcPipsEl = document.createElement('div');
    this.bcPipsEl.className = 'kc-bc-pips';
    for (let i = 0; i < MAX_BOSS_CELLS; i++) {
      const pip = document.createElement('span');
      pip.className = 'kc-bc-pip';
      this.bcPipsEl.appendChild(pip);
    }
    biomeRow.append(this.biomeNameEl, this.bcPipsEl);
    this.trContainer.appendChild(biomeRow);

    // Minimap mount right below biome banner
    this.trContainer.appendChild(this.minimapHost);

    // Gold / Cells / Timer pill
    const resBar = document.createElement('div');
    resBar.className = 'kc-resource-bar kc-iron-panel';
    resBar.innerHTML = `
      <span class="kc-res-item kc-res-gold" title="Gold"><span>◈</span><span data-el="gold">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-cells" title="Cells"><span>✦</span><span data-el="cells">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-timer" title="Run Timer"><span>⧖</span><span data-el="timer">00:00</span></span>
    `;
    this.goldEl = resBar.querySelector('[data-el="gold"]') as HTMLSpanElement;
    this.cellsEl = resBar.querySelector('[data-el="cells"]') as HTMLSpanElement;
    this.timerEl = resBar.querySelector('[data-el="timer"]') as HTMLSpanElement;
    this.trContainer.appendChild(resBar);

    this.streakEl = document.createElement('div');
    this.streakEl.className = 'kc-streak-badge kc-iron-panel kc-hidden';
    this.trContainer.appendChild(this.streakEl);

    this.curseEl = document.createElement('div');
    this.curseEl.className = 'kc-curse-banner kc-hidden';
    this.trContainer.appendChild(this.curseEl);
  }

  private buildBottomLeft(): void {
    // Row 1: Flask + HP Bar
    const vitalsRow = document.createElement('div');
    vitalsRow.className = 'kc-vitals-row';

    const flaskEl = document.createElement('div');
    flaskEl.className = 'kc-flask-widget kc-iron-panel';
    flaskEl.title = 'Health Flask (Restores 60% Max HP)';
    flaskEl.innerHTML = `
      <div class="kc-flask-bottle"><div class="kc-flask-liquid"></div></div>
      <div class="kc-flask-pips"></div>
      <span class="kc-gear-key" style="bottom:2px;right:2px;left:auto;">R</span>
    `;
    this.flaskLiquidEl = flaskEl.querySelector('.kc-flask-liquid') as HTMLDivElement;
    this.flaskPipsEl = flaskEl.querySelector('.kc-flask-pips') as HTMLDivElement;
    this.flaskKeyEl = flaskEl.querySelector('.kc-gear-key') as HTMLSpanElement;

    const hpBlock = document.createElement('div');
    hpBlock.className = 'kc-hp-block kc-iron-panel';
    hpBlock.innerHTML = `
      <div class="kc-hp-top">
        <span class="kc-hp-numbers">100 / 100</span>
        <div class="kc-hp-status-tags"></div>
      </div>
      <div class="kc-hp-track">
        <div class="kc-hp-rally"></div>
        <div class="kc-hp-fill"></div>
      </div>
    `;
    this.hpTextEl = hpBlock.querySelector('.kc-hp-numbers') as HTMLSpanElement;
    this.hpStatusEl = hpBlock.querySelector('.kc-hp-status-tags') as HTMLDivElement;
    this.hpRallyEl = hpBlock.querySelector('.kc-hp-rally') as HTMLDivElement;
    this.hpFillEl = hpBlock.querySelector('.kc-hp-fill') as HTMLDivElement;

    vitalsRow.append(flaskEl, hpBlock);
    this.blContainer.appendChild(vitalsRow);

    // Row 2: 2 Weapons + 2 Skills
    const loadoutRow = document.createElement('div');
    loadoutRow.className = 'kc-loadout-row';
    const gearGroup = document.createElement('div');
    gearGroup.className = 'kc-gear-group';

    for (let i = 0; i < 4; i++) {
      const slot = document.createElement('div');
      slot.className = 'kc-gear-slot is-empty';
      gearGroup.appendChild(slot);
      this.gearSlotEls.push(slot);
    }
    loadoutRow.appendChild(gearGroup);
    this.blContainer.appendChild(loadoutRow);

    // Row 3: 3 Scrolls + 3 Mutations
    const subRow = document.createElement('div');
    subRow.className = 'kc-sub-row';

    const scrollsBar = document.createElement('div');
    scrollsBar.className = 'kc-scrolls-bar';
    const stats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of stats) {
      const pill = document.createElement('div');
      pill.className = `kc-scroll-pill kc-color-${stat}`;
      pill.title = `${stat.toUpperCase()} Scrolls (1.15^(n-1) damage scaling)`;
      pill.innerHTML = `
        <span class="kc-scroll-gem"></span>
        <span class="kc-scroll-count">1</span>
        <span class="kc-scroll-pct">100%</span>
      `;
      this.scrollSlotEls[stat] = {
        count: pill.querySelector('.kc-scroll-count') as HTMLSpanElement,
        pct: pill.querySelector('.kc-scroll-pct') as HTMLSpanElement,
      };
      scrollsBar.appendChild(pill);
    }

    const mutsBar = document.createElement('div');
    mutsBar.className = 'kc-mutations-bar';
    for (let i = 0; i < 3; i++) {
      const mut = document.createElement('div');
      mut.className = 'kc-mut-slot';
      mut.textContent = '—';
      mutsBar.appendChild(mut);
      this.mutationEls.push(mut);
    }

    subRow.append(scrollsBar, mutsBar);
    this.blContainer.appendChild(subRow);
  }

  private updateTopRight(state: SimState): void {
    this.biomeNameEl.textContent = getBiomeDisplayName(state.activeBiomeId, this.catalog);

    const pips = this.bcPipsEl.children;
    for (let i = 0; i < pips.length; i++) {
      pips[i]!.classList.toggle('is-active', i < state.bossStemCells);
    }
    this.bcPipsEl.title = `Boss Stem Cells: ${state.bossStemCells}BC`;

    this.goldEl.textContent = String(Math.floor(state.player.gold));
    this.cellsEl.textContent = String(Math.floor(state.player.cells));
    this.timerEl.textContent = formatTimer(state.player.runTimerTicks);

    // Kill Streak
    const streak = state.player.killStreak;
    if (streak > 0) {
      this.streakEl.classList.remove('kc-hidden');
      this.streakEl.classList.toggle('is-tier1', streak >= 30 && streak < 60);
      this.streakEl.classList.toggle('is-tier2', streak >= 60);
      const crown = streak >= 60 ? '★ ' : streak >= 30 ? '✦ ' : '';
      this.streakEl.textContent = `${crown}STREAK ${streak}`;
    } else {
      this.streakEl.classList.add('kc-hidden');
    }

    // Curse Banner
    if (state.player.curseKillsLeft > 0) {
      this.curseEl.classList.remove('kc-hidden');
      this.curseEl.innerHTML = `<span class="kc-curse-skull">☠</span><span>CURSED: ${state.player.curseKillsLeft} KILLS LEFT</span>`;
    } else {
      this.curseEl.classList.add('kc-hidden');
    }
  }

  private updateBottomLeft(state: SimState, bindings: KeyBindings): void {
    const p = state.player;
    const maxHp = Math.max(1, p.maxHp);
    const hpPct = Math.max(0, Math.min(100, (p.hp / maxHp) * 100));
    const rallyPct = Math.max(hpPct, Math.min(100, ((p.hp + p.rallyHp) / maxHp) * 100));

    this.hpTextEl.textContent = `${Math.max(0, Math.ceil(p.hp))} / ${Math.ceil(maxHp)}`;
    this.hpFillEl.style.width = `${hpPct.toFixed(2)}%`;
    this.hpFillEl.classList.toggle('is-cursed', p.curseKillsLeft > 0);
    this.hpRallyEl.style.width = `${rallyPct.toFixed(2)}%`;

    // Status tags (godMode, speed buff, shield/corrupted)
    const tags: string[] = [];
    if (p.godMode) tags.push('<span class="kc-status-pill" style="color:#38e8ff;border-color:#38e8ff">GOD</span>');
    if (p.speedBuffTicks > 0) tags.push('<span class="kc-status-pill" style="color:#fbbf24;border-color:#fbbf24">SPD+</span>');
    for (const st of p.statusEffects) {
      if (st.ticksLeft > 0 && tags.length < 3) {
        tags.push(`<span class="kc-status-pill">${escapeHtml(st.kind.slice(0, 4))}</span>`);
      }
    }
    this.hpStatusEl.innerHTML = tags.join('');

    // Flask
    const maxFlask = Math.max(1, p.maxFlaskCharges);
    const flaskPct = Math.max(0, Math.min(100, (p.flaskCharges / maxFlask) * 100));
    this.flaskLiquidEl.style.height = `${flaskPct.toFixed(0)}%`;
    this.flaskKeyEl.textContent = formatKeyCode(bindings.heal);
    if (this.flaskPipsEl.childElementCount !== maxFlask) {
      this.flaskPipsEl.innerHTML = '';
      for (let i = 0; i < maxFlask; i++) {
        const pip = document.createElement('span');
        pip.className = 'kc-flask-pip';
        this.flaskPipsEl.appendChild(pip);
      }
    }
    for (let i = 0; i < this.flaskPipsEl.children.length; i++) {
      this.flaskPipsEl.children[i]!.classList.toggle('is-full', i < p.flaskCharges);
    }

    // Scrolls
    const scrollStats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of scrollStats) {
      const count = p.scrolls[stat];
      this.scrollSlotEls[stat].count.textContent = String(count);
      this.scrollSlotEls[stat].pct.textContent = `${getScrollDamagePct(count)}%`;
    }

    // Weapons & Skills + Cooldown sweeps
    const slots: Array<{ gear: GearInstance | null; keyCode: string; label: string }> = [
      { gear: p.loadout.weapon1, keyCode: bindings.weapon1, label: 'W1' },
      { gear: p.loadout.weapon2, keyCode: bindings.weapon2, label: 'W2' },
      { gear: p.loadout.skill1, keyCode: bindings.skill1, label: 'S1' },
      { gear: p.loadout.skill2, keyCode: bindings.skill2, label: 'S2' },
    ];

    const sig =
      slots
        .map((s) =>
          s.gear
            ? `${s.gear.uid}:${s.gear.level}:${s.gear.quality}:${s.gear.color}:${s.gear.ammo ?? -1}:${Math.ceil(s.gear.cooldownTicks / 6)}:${s.keyCode}`
            : `empty:${s.keyCode}`
        )
        .join('|') +
      '||' +
      p.mutations.join(',');

    if (sig !== this.lastLoadoutSignature) {
      this.lastLoadoutSignature = sig;
      for (let i = 0; i < 4; i++) {
        const el = this.gearSlotEls[i]!;
        const { gear, keyCode, label } = slots[i]!;
        const keyTxt = formatKeyCode(keyCode);

        el.className = 'kc-gear-slot';
        if (!gear) {
          el.classList.add('is-empty');
          el.title = `Empty ${label} Slot`;
          el.innerHTML = `
            <span class="kc-gear-short">${label}</span>
            <span class="kc-gear-key">${escapeHtml(keyTxt)}</span>
          `;
          continue;
        }

        const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
        el.classList.add(colorClass);
        const info = getGearDisplayInfo(gear, this.catalog);
        const badge = formatGearBadge(gear.level, gear.quality);
        const isLeg = gear.quality === 'L';
        const maxCd = Math.max(1, info.cooldownTicks || 300);
        const cdPct = gear.cooldownTicks > 0 ? Math.min(100, (gear.cooldownTicks / maxCd) * 100) : 0;
        const cdSec = (gear.cooldownTicks / SIM_HZ).toFixed(1);

        el.title = `${info.name} (${badge}) — ${info.description}`;
        el.innerHTML = `
          <span class="kc-gear-glyph">${info.glyph}</span>
          <span class="kc-gear-short">${escapeHtml(info.name)}</span>
          <span class="kc-gear-badge ${isLeg ? 'is-legendary' : ''}">${escapeHtml(badge)}</span>
          ${
            gear.maxAmmo !== undefined && gear.maxAmmo > 0
              ? `<span class="kc-gear-ammo">${gear.ammo ?? 0}/${gear.maxAmmo}</span>`
              : ''
          }
          <span class="kc-gear-key">${escapeHtml(keyTxt)}</span>
          ${
            gear.cooldownTicks > 0
              ? `<div class="kc-cd-sweep" style="background: conic-gradient(rgba(5,4,10,0.8) ${cdPct * 3.6}deg, rgba(5,4,10,0.18) 0deg);">${cdSec}s</div>`
              : ''
          }
        `;
      }

      // Mutations
      for (let i = 0; i < 3; i++) {
        const mutEl = this.mutationEls[i]!;
        const mutId = p.mutations[i];
        mutEl.className = 'kc-mut-slot';
        if (!mutId) {
          mutEl.textContent = '·';
          mutEl.title = `Empty Mutation Slot ${i + 1}`;
        } else {
          const m = getMutationDisplayInfo(mutId, this.catalog);
          mutEl.classList.add('is-filled', `kc-color-${m.color}`);
          mutEl.textContent = m.monogram;
          mutEl.title = `${m.name}: ${m.description}`;
        }
      }
    }
  }

  private updateBossBar(state: SimState): void {
    const arena = state.bossArenaState;
    if (!arena.active || arena.defeated) {
      this.bossBanner.classList.add('kc-hidden');
      return;
    }

    const boss = state.enemies.find(
      (e) => (arena.bossUid !== null && e.uid === arena.bossUid) || (e.isBoss && e.hp > 0)
    );
    if (!boss || boss.hp <= 0) {
      this.bossBanner.classList.add('kc-hidden');
      return;
    }

    this.bossBanner.classList.remove('kc-hidden');
    const info = boss.bossId
      ? getBossDisplayInfo(boss.bossId, this.catalog)
      : { name: boss.name, subtitle: 'Boss' };
    const pct = Math.max(0, Math.min(100, (boss.hp / Math.max(1, boss.maxHp)) * 100));

    this.bossTitleEl.textContent = info.name;
    this.bossSubEl.textContent = ` — ${info.subtitle}`;
    this.bossPhaseEl.textContent = `PHASE ${Math.max(1, boss.bossPhase + 1)}`;
    this.bossFillEl.style.width = `${pct.toFixed(2)}%`;
    this.bossHpTextEl.textContent = `${Math.max(0, Math.ceil(boss.hp))} / ${Math.ceil(boss.maxHp)}`;
  }

  private updateNearbyLootAndPrompts(state: SimState, bindings: KeyBindings): void {
    const px = state.player.pos.x + state.player.width * 0.5;
    const py = state.player.pos.y + state.player.height * 0.5;

    // 1. Find nearest gear pickup within reach
    let nearestGear: PickupState | null = null;
    let nearestDist = 48;
    for (const pk of state.pickups) {
      if (pk.collected || pk.kind !== 'gear' || !pk.gear) continue;
      const d = Math.hypot(pk.pos.x - px, pk.pos.y - py);
      if (d < nearestDist) {
        nearestDist = d;
        nearestGear = pk;
      }
    }
    this.activeNearbyPickup = nearestGear;

    const suppressLoot =
      state.pendingScroll !== null ||
      state.runStatus === 'paused' ||
      (state.passageState.active && state.passageState.activeNpc !== 'none');

    if (nearestGear && nearestGear.gear && !suppressLoot) {
      this.interactEl.classList.add('kc-hidden');
      const g = nearestGear.gear;
      const price = nearestGear.priceGold ?? 0;
      const canAfford = state.player.gold >= price;
      const canRecycle = state.metaSnapshot.recycleUnlocked && price === 0;
      const keyF = formatKeyCode(bindings.interact);
      const sig = `${nearestGear.uid}:${g.level}:${g.quality}:${price}:${canAfford}:${canRecycle}:${state.player.loadout.weapon1?.uid ?? 0}:${state.player.loadout.weapon2?.uid ?? 0}:${state.player.loadout.skill1?.uid ?? 0}:${state.player.loadout.skill2?.uid ?? 0}:${keyF}`;

      this.lootCardEl.classList.remove('kc-hidden');
      if (sig !== this.lastLootSignature) {
        this.lastLootSignature = sig;
        this.renderLootComparisonCard(nearestGear, g, state, keyF, canAfford, canRecycle);
      }
      return;
    }

    this.lootCardEl.classList.add('kc-hidden');
    this.lastLootSignature = '';

    // 2. Otherwise show contextual interaction prompt
    if (suppressLoot) {
      this.interactEl.classList.add('kc-hidden');
      return;
    }

    const prompt = this.findNearestPrompt(state, px, py, bindings);
    if (!prompt) {
      this.interactEl.classList.add('kc-hidden');
      this.lastInteractSignature = '';
      return;
    }

    this.interactEl.classList.remove('kc-hidden');
    const sig = `${prompt.key}:${prompt.label}`;
    if (sig !== this.lastInteractSignature) {
      this.lastInteractSignature = sig;
      this.interactEl.innerHTML = `<span class="kc-keycap">${escapeHtml(prompt.key)}</span><span>${escapeHtml(prompt.label)}</span>`;
      this.interactEl.onclick = prompt.onClick ?? null;
    }
  }

  private renderLootComparisonCard(
    pickup: PickupState,
    gear: GearInstance,
    state: SimState,
    keyF: string,
    canAfford: boolean,
    canRecycle: boolean
  ): void {
    const info = getGearDisplayInfo(gear, this.catalog);
    const badge = formatGearBadge(gear.level, gear.quality);
    const pwr = estimateGearPower(gear, state, this.catalog);
    const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;

    const slot1 = gear.slotKind === 'skill' ? state.player.loadout.skill1 : state.player.loadout.weapon1;
    const slot2 = gear.slotKind === 'skill' ? state.player.loadout.skill2 : state.player.loadout.weapon2;
    const renderEquippedLine = (label: string, eq: GearInstance | null): string => {
      if (!eq) return `<div class="kc-loot-meta"><strong>${label}:</strong> Empty</div>`;
      const ei = getGearDisplayInfo(eq, this.catalog);
      const ep = estimateGearPower(eq, state, this.catalog);
      const diff = pwr - ep;
      const diffHtml =
        diff > 0
          ? `<span style="color:#4ade80">(+${diff})</span>`
          : diff < 0
            ? `<span style="color:#f87171">(${diff})</span>`
            : `<span style="color:#94a3b8">(=)</span>`;
      return `<div class="kc-loot-meta"><strong>${label}:</strong> ${escapeHtml(ei.name)} ${escapeHtml(formatGearBadge(eq.level, eq.quality))} · ${ep} ${diffHtml}</div>`;
    };

    const affixesHtml =
      gear.affixes.length > 0
        ? `<ul class="kc-affix-list">${gear.affixes
            .map((a) => `<li>${escapeHtml(getAffixDisplayLabel(a, this.catalog))}</li>`)
            .join('')}</ul>`
        : `<div class="kc-loot-meta">No special affixes</div>`;

    const price = pickup.priceGold ?? 0;

    this.lootCardEl.innerHTML = `
      <div class="kc-loot-grid">
        <div class="kc-loot-col ${colorClass}" style="border-width:1px">
          <div class="kc-loot-title-row">
            <span class="kc-loot-name">${info.glyph} ${escapeHtml(info.name)}</span>
            <span class="kc-gear-badge ${gear.quality === 'L' ? 'is-legendary' : ''}" style="position:static">${escapeHtml(badge)}</span>
          </div>
          <div class="kc-loot-meta">
            <span>${escapeHtml(gear.color.toUpperCase())}</span>
            <span>·</span>
            <span>${escapeHtml(gear.slotKind.toUpperCase())}</span>
            ${pwr > 0 ? `<span>·</span><strong>PWR ${pwr}</strong>` : ''}
          </div>
          ${affixesHtml}
        </div>
        <div class="kc-loot-col">
          <div class="kc-loot-meta" style="color:var(--gold-amber);font-weight:700">EQUIPPED COMPARISON</div>
          ${renderEquippedLine(gear.slotKind === 'skill' ? 'Skill 1' : 'Slot 1', slot1)}
          ${renderEquippedLine(gear.slotKind === 'skill' ? 'Skill 2' : 'Slot 2', slot2)}
          <div class="kc-loot-meta" style="margin-top:auto">${escapeHtml(info.description)}</div>
        </div>
      </div>
      <div class="kc-loot-actions">
        ${
          price > 0
            ? `<span class="kc-price-tag ${canAfford ? '' : 'is-unaffordable'}">◈ ${price} Gold${canAfford ? '' : ' (Insufficient)'}</span>`
            : ''
        }
        <button class="kc-btn kc-btn-sm kc-btn-primary" data-loot-act="equip1" ${canAfford ? '' : 'disabled'}>[${escapeHtml(keyF)}] Equip Slot 1</button>
        ${
          gear.slotKind !== 'amulet'
            ? `<button class="kc-btn kc-btn-sm" data-loot-act="equip2" ${canAfford ? '' : 'disabled'}>[G] Slot 2</button>`
            : ''
        }
        ${
          canRecycle
            ? `<button class="kc-btn kc-btn-sm kc-btn-emerald" data-loot-act="recycle">[X] Recycle</button>`
            : ''
        }
      </div>
    `;

    this.lootCardEl.querySelectorAll<HTMLButtonElement>('[data-loot-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.lootAct as 'equip1' | 'equip2' | 'recycle';
        this.triggerQuickLootAction(act, state);
      });
    });
  }

  private findNearestPrompt(
    state: SimState,
    px: number,
    py: number,
    bindings: KeyBindings
  ): { key: string; label: string; onClick?: () => void } | null {
    const keyF = formatKeyCode(bindings.interact);
    const keyTab = formatKeyCode(bindings.map);

    // Chests
    for (const c of state.chests) {
      if (c.opened) continue;
      if (Math.hypot(c.pos.x - px, c.pos.y - py) < 44) {
        const label =
          c.kind === 'cursed'
            ? 'Open Cursed Chest (10-Kill Curse!)'
            : c.kind === 'boss'
              ? 'Open Boss Chest'
              : 'Open Treasure Chest';
        return { key: keyF, label };
      }
    }

    // Shrines / Passage NPCs
    for (const s of state.shrines) {
      if (Math.hypot(s.pos.x - px, s.pos.y - py) < 46) {
        if (s.kind === 'collector') {
          return {
            key: keyF,
            label: 'Talk to The Collector',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'collector' }),
          };
        }
        if (s.kind === 'guillain') {
          return {
            key: keyF,
            label: 'Talk to Guillain (Mutations)',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'guillain' }),
          };
        }
        if (s.kind === 'forge') {
          return {
            key: keyF,
            label: 'Use Minor Forge',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'forge' }),
          };
        }
        if (s.kind === 'fountain' && !s.used) {
          return {
            key: keyF,
            label: 'Drink Health Fountain',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'useFountain' }),
          };
        }
        if (!s.used) {
          return { key: keyF, label: s.label || 'Activate Shrine' };
        }
      }
    }

    // Doors (Biome Exit / Timed / KillStreak)
    for (const d of state.doors) {
      if (d.broken) continue;
      const cx = d.pos.x + d.width * 0.5;
      const cy = d.pos.y + d.height * 0.5;
      if (Math.hypot(cx - px, cy - py) < 48) {
        if (d.kind === 'biomeExit') {
          const dest = d.targetBiomeId ? getBiomeDisplayName(d.targetBiomeId, this.catalog) : 'The Passage';
          return {
            key: keyF,
            label: d.label || `Enter ${dest}`,
            onClick: d.targetBiomeId
              ? () => this.callbacks.onDispatchCommand({ type: 'enterBiome', biomeId: d.targetBiomeId! })
              : undefined,
          };
        }
        if (d.kind === 'timed' || d.kind === 'killStreak') {
          return { key: keyF, label: d.label || 'Open Reward Door' };
        }
      }
    }

    // Teleporters
    for (const tp of state.teleporters) {
      if (Math.hypot(tp.pos.x - px, tp.pos.y - py) < 44) {
        return {
          key: keyTab,
          label: `Teleportation Rune (${tp.label}) — Open Map`,
          onClick: () => this.callbacks.onToggleMinimap?.(),
        };
      }
    }

    // Scrolls / Food
    for (const pk of state.pickups) {
      if (pk.collected) continue;
      if (pk.kind !== 'scroll' && pk.kind !== 'dualScroll' && pk.kind !== 'food' && pk.kind !== 'flaskRefill') {
        continue;
      }
      if (Math.hypot(pk.pos.x - px, pk.pos.y - py) < 42) {
        const priceSuffix = pk.priceGold ? ` (${pk.priceGold} Gold)` : '';
        const label =
          pk.kind === 'scroll' || pk.kind === 'dualScroll'
            ? `Read Power Scroll${priceSuffix}`
            : pk.kind === 'flaskRefill'
              ? `Refill Health Flask${priceSuffix}`
              : `Eat Food${priceSuffix}`;
        return { key: keyF, label };
      }
    }

    return null;
  }

  private spawnFloater(
    worldX: number,
    worldY: number,
    text: string,
    className: string,
    color: string,
    durationSec: number,
    simUid: number | null = null
  ): void {
    if (this.floaters.length >= MAX_FLOATERS) {
      const oldest = this.floaters.shift();
      oldest?.el.remove();
    }
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    el.style.color = color;
    this.floatLayer.appendChild(el);

    const jitterX = ((this.nextFloaterId * 37) % 17) - 8;
    this.floaters.push({
      id: this.nextFloaterId++,
      simUid,
      worldX: worldX + jitterX * 0.5,
      worldY,
      vx: jitterX * 1.4,
      vy: -34,
      text,
      className,
      color,
      ttl: durationSec,
      maxTtl: durationSec,
      el,
    });
  }

  private updateFloaters(state: SimState, dtSec: number, interpAlpha: number): void {
    if (this.floaters.length === 0) return;

    const drawRect = computeCanvasDrawRect(this.canvas);
    const stageRect = this.hudRoot.getBoundingClientRect();
    const zoom = state.camera.zoom > 0.05 ? state.camera.zoom : 1;
    const topLeft = resolveCameraTopLeft(state.camera, state.player.pos, this.cameraOriginMode, interpAlpha);

    const scaleX = drawRect.width / VIEWPORT_W;
    const scaleY = drawRect.height / VIEWPORT_H;
    const originX = drawRect.left - stageRect.left;
    const originY = drawRect.top - stageRect.top;

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!;
      f.ttl -= dtSec;
      if (f.ttl <= 0) {
        f.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }

      f.worldX += f.vx * dtSec;
      f.worldY += f.vy * dtSec;
      f.vy += 44 * dtSec; // gentle arc

      const lx = (f.worldX - topLeft.x) * zoom;
      const ly = (f.worldY - topLeft.y) * zoom;
      const px = originX + lx * scaleX;
      const py = originY + ly * scaleY;

      const t = 1 - f.ttl / f.maxTtl;
      const alpha = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
      const popScale = t < 0.12 ? 0.75 + (t / 0.12) * 0.35 : 1.0;

      f.el.style.left = `${px.toFixed(1)}px`;
      f.el.style.top = `${py.toFixed(1)}px`;
      f.el.style.opacity = alpha.toFixed(2);
      f.el.style.transform = `translate(-50%, -50%) scale(${popScale.toFixed(2)})`;
    }
  }
}
