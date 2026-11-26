// =============================================================================
// KRUNKED CELLS — Dead Cells-Grade Pixel-Crisp Gothic HUD Overlay
// Zero Unicode emojis, zero truncated slot labels, real pixel-art icons
// (Custom Pack cardIcons.png / Built-In pixel art + crisp pixel-SVG fallback),
// sculpted Glass Health Flask, beveled HP+Rally bar, smooth trailing Boss Bar,
// Loot Comparison Card with pixel icons & DPS delta, and floating combat text.
// =============================================================================

import { getItemIconUrl } from '../assets/ItemIcons';
import {
  ActiveInputSnapshot,
  AffixDef,
  ArtPackMode,
  BiomeDef,
  BiomeId,
  BossDef,
  BossId,
  CritCondition,
  CustomPackAssetResolver,
  DEFAULT_KEY_BINDINGS,
  DifficultyDef,
  GamepadLayoutPreset,
  GamepadVendorFamily,
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
  ShrineState,
  SimCommand,
  SimEvent,
  SimState,
  SkillDef,
  StatusKind,
  VIEWPORT_H,
  VIEWPORT_W,
  WeaponDef,
} from '../contracts';
import { CameraOriginMode, computeCanvasDrawRect, getActionGlyph, resolveCameraTopLeft } from '../input';

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
  onTriggerHeal?(): void;
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

export const BOSS_SPLASH_EPITHETS: Record<BossId, string> = {
  Behemoth: 'THE BRIDGE GUARDIAN',
  TimeKeeper: 'KEEPER OF THE CLOCK ROOM',
  KingsHand: 'ROYAL CHAMPION',
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

export type IconFallbackKind =
  | 'melee'
  | 'ranged'
  | 'shield'
  | 'turret'
  | 'grenade'
  | 'trap'
  | 'wave'
  | 'teleport'
  | 'power'
  | 'amulet'
  | 'mutation'
  | 'flask'
  | 'cell'
  | 'gold'
  | 'skull'
  | 'scroll'
  | 'bossCell'
  | 'timer'
  | 'forge'
  | 'door'
  | 'crown'
  | 'flame'
  | 'dice'
  | 'rune'
  | 'crackedSkull'
  | 'malaise'
  | 'star'
  | 'shop'
  | 'tube';

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
    ShiftLeft: 'SHF',
    ShiftRight: 'SHF',
    ControlLeft: 'CTL',
    ControlRight: 'CTL',
    AltLeft: 'ALT',
    AltRight: 'ALT',
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

export type GlyphAction =
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

export function resolveBadgeClasses(
  _action: GlyphAction,
  glyphFamily: 'keyboard' | GamepadVendorFamily | 'touch',
  rawStyleClass: string,
  label: string
): string {
  const classes = new Set<string>();
  if (rawStyleClass) {
    for (const part of rawStyleClass.split(/\s+/)) {
      if (part) classes.add(part);
    }
  }
  const upper = label.trim().toUpperCase();

  if (
    upper === 'LB' ||
    upper === 'RB' ||
    upper === 'L1' ||
    upper === 'R1' ||
    upper === 'L' ||
    upper === 'R'
  ) {
    classes.add('is-bumper');
  } else if (
    upper === 'LT' ||
    upper === 'RT' ||
    upper === 'L2' ||
    upper === 'R2' ||
    upper === 'ZL' ||
    upper === 'ZR'
  ) {
    classes.add('is-trigger');
  } else if (
    upper === 'LS' ||
    upper === 'RS' ||
    upper === 'L3' ||
    upper === 'R3' ||
    upper === 'VIEW' ||
    upper === 'MENU' ||
    upper === 'SHARE' ||
    upper === 'OPT' ||
    upper === 'OPTIONS' ||
    upper === 'START' ||
    upper === 'SELECT' ||
    upper === '-' ||
    upper === '+'
  ) {
    classes.add('is-stick');
  } else if (glyphFamily === 'playstation') {
    classes.add('is-ps');
    if (label === '✕' || upper === 'CROSS') classes.add('is-ps-cross');
    else if (label === '○' || upper === 'CIRCLE') classes.add('is-ps-circle');
    else if (label === '□' || upper === 'SQUARE') classes.add('is-ps-square');
    else if (label === '△' || upper === 'TRIANGLE') classes.add('is-ps-triangle');
  } else if (glyphFamily === 'nintendo') {
    classes.add('is-nintendo');
  } else if (glyphFamily !== 'keyboard' && glyphFamily !== 'touch') {
    if (upper === 'A') classes.add('is-xbox-a');
    else if (upper === 'B') classes.add('is-xbox-b');
    else if (upper === 'X') classes.add('is-xbox-x');
    else if (upper === 'Y') classes.add('is-xbox-y');
  }

  return Array.from(classes).join(' ');
}

export function renderControllerBadgeHtml(
  action: GlyphAction,
  snapshot: ActiveInputSnapshot | null | undefined,
  keyBindings?: KeyBindings,
  opts?: { extraClass?: string; layoutPreset?: GamepadLayoutPreset }
): string {
  const family = snapshot?.glyphFamily ?? 'keyboard';
  const glyph = getActionGlyph(action, family, keyBindings, opts?.layoutPreset);
  const semantic = resolveBadgeClasses(action, family, glyph.styleClass, glyph.label);
  const extra = opts?.extraClass ? ` ${opts.extraClass}` : '';
  return `<span class="kc-gp-badge ${semantic}${extra}">${escapeHtml(glyph.label)}</span>`;
}

export function renderGamepadIconSvg(size = 16, accent = '#4ade80'): string {
  return `<svg class="kc-pixel-svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="3" y="4" width="10" height="1" fill="${accent}"/>
    <rect x="2" y="5" width="12" height="5" fill="#1e192c"/>
    <rect x="1" y="6" width="1" height="5" fill="${accent}"/>
    <rect x="14" y="6" width="1" height="5" fill="${accent}"/>
    <rect x="2" y="10" width="3" height="2" fill="#1e192c"/>
    <rect x="11" y="10" width="3" height="2" fill="#1e192c"/>
    <rect x="5" y="10" width="6" height="1" fill="${accent}"/>
    <rect x="2" y="12" width="3" height="1" fill="${accent}"/>
    <rect x="11" y="12" width="3" height="1" fill="${accent}"/>
    <rect x="4" y="6" width="1" height="3" fill="#f2ead8"/>
    <rect x="3" y="7" width="3" height="1" fill="#f2ead8"/>
    <rect x="11" y="6" width="1" height="1" fill="#fbbf24"/>
    <rect x="10" y="7" width="1" height="1" fill="#60a5fa"/>
    <rect x="12" y="7" width="1" height="1" fill="#f87171"/>
    <rect x="11" y="8" width="1" height="1" fill="#4ade80"/>
  </svg>`;
}

export function renderTouchStickIconSvg(size = 16, accent = '#fbbf24'): string {
  return `<svg class="kc-pixel-svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="5" y="2" width="6" height="1" fill="${accent}"/>
    <rect x="5" y="13" width="6" height="1" fill="${accent}"/>
    <rect x="2" y="5" width="1" height="6" fill="${accent}"/>
    <rect x="13" y="5" width="1" height="6" fill="${accent}"/>
    <rect x="3" y="3" width="2" height="2" fill="${accent}"/>
    <rect x="11" y="3" width="2" height="2" fill="${accent}"/>
    <rect x="3" y="11" width="2" height="2" fill="${accent}"/>
    <rect x="11" y="11" width="2" height="2" fill="${accent}"/>
    <rect x="6" y="6" width="4" height="4" fill="#f2ead8"/>
    <rect x="7" y="7" width="2" height="2" fill="${accent}"/>
  </svg>`;
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
      const bp = def.strikeChain[0]?.basePower ?? 45;
      return {
        name: def.name,
        description: def.description,
        glyph: def.kind.toUpperCase(),
        basePower: bp,
        cooldownTicks: 0,
      };
    }
    const fb = FALLBACK_WEAPONS.find((w) => w.id === gear.defId);
    return {
      name: fb?.name ?? humanizeId(gear.defId),
      description: 'Battle-forged weapon.',
      glyph: (fb?.kind ?? 'melee').toUpperCase(),
      basePower: 50,
      cooldownTicks: 0,
    };
  }

  if (gear.slotKind === 'skill') {
    const def = catalog?.getSkill?.(gear.defId);
    if (def) {
      return {
        name: def.name,
        description: def.description,
        glyph: def.kind.toUpperCase(),
        basePower: def.basePower,
        cooldownTicks: def.cooldownTicks,
      };
    }
    const fb = FALLBACK_SKILLS.find((s) => s.id === gear.defId);
    return {
      name: fb?.name ?? humanizeId(gear.defId),
      description: 'Tactical combat skill.',
      glyph: (fb?.kind ?? 'power').toUpperCase(),
      basePower: 70,
      cooldownTicks: 360,
    };
  }

  return {
    name: humanizeId(gear.defId),
    description: gear.dmgReductionPct ? `-${gear.dmgReductionPct}% damage taken` : 'Mystic amulet.',
    glyph: 'AMULET',
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

const FALLBACK_AFFIX_META: Readonly<
  Record<
    string,
    {
      label: string;
      isStar?: boolean;
      targetStatus?: StatusKind;
      applyStatus?: StatusKind;
    }
  >
> = {
  bonus_bleed: { label: '+60% damage to bleeding targets', isStar: true, targetStatus: 'bleed' },
  bonus_poison: { label: '+80% damage to poisoned targets', isStar: true, targetStatus: 'poison' },
  bonus_burning_oil: { label: '+100% damage to targets covered in burning oil', isStar: true, targetStatus: 'oil' },
  bonus_burn: { label: '+40% damage to burning targets', isStar: true, targetStatus: 'burn' },
  bonus_electrify: { label: '+40% damage to electrified targets', isStar: true, targetStatus: 'electrify' },
  bonus_frozen: { label: '+50% damage to frozen targets', isStar: true, targetStatus: 'freeze' },
  bonus_rooted: { label: '+50% damage to rooted targets', isStar: true, targetStatus: 'root' },
  bonus_slow: { label: '+30% damage to slowed targets', isStar: true, targetStatus: 'slow' },
  apply_bleed: { label: 'Causes the victim to bleed', applyStatus: 'bleed' },
  apply_poison: { label: 'Poisons the target', applyStatus: 'poison' },
  apply_burn: { label: 'Ignites the target on hit', applyStatus: 'burn' },
  apply_oil: { label: 'Covers the target in inflammable oil', applyStatus: 'oil' },
  pierce_first: { label: 'Pierces the first target', isStar: true },
  explode_toxic: { label: 'Victims explode into a toxic cloud', isStar: true, applyStatus: 'poison' },
  flame_trail: { label: 'Leaves a trail of flames', isStar: true, applyStatus: 'burn' },
  dmg_dealt_taken: { label: '+20% damage dealt, +20% damage taken', isStar: true },
  breaks_shields: { label: 'Ignores and breaks enemy shields', isStar: true },
  spread_oil: { label: 'Spreads inflammable oil on hit', isStar: true, applyStatus: 'oil' },
  freeze_death: { label: 'Victims freeze nearby enemies on death', isStar: true, applyStatus: 'freeze' },
  double_dmg: { label: '+100% damage dealt, +100% damage taken', isStar: true },
  gold_bonus: { label: '+20% Gold dropped by slain enemies' },
  cell_bonus: { label: '+25% bonus Cell drop chance' },
};

const CRIT_CONDITION_LABELS: Record<CritCondition, string | null> = {
  none: null,
  backstab: 'Inflicts critical hits when striking enemies from behind.',
  finalHit: 'Inflicts a critical hit on the final strike of the combo.',
  bleeding: 'Inflicts critical hits against bleeding targets.',
  poisoned: 'Inflicts critical hits against poisoned targets.',
  burning: 'Inflicts critical hits against burning targets.',
  oiled: 'Inflicts critical hits against targets covered in inflammable oil.',
  frozenOrRooted: 'Inflicts critical hits against stunned, frozen, or rooted foes.',
  speedBuff: 'Inflicts critical hits while your speed boost is active.',
  afterRoll: 'Inflicts a critical hit immediately after dodging or parrying.',
  afterParry: 'Inflicts a critical counter-strike on a successful parry.',
  isolated: 'Inflicts critical hits on isolated enemies.',
  wallSlam: 'Inflicts critical hits when pinning or slamming foes against a wall.',
  highCombo: 'Inflicts critical hits on sustained consecutive strikes.',
  stuckArrows3: 'Inflicts critical hits when 3+ arrows are stuck in the target.',
  closeRange: 'Inflicts critical hits on enemies at close range.',
  midRange: 'Inflicts critical hits at medium range.',
  always: 'Always inflicts critical hits.',
};

export interface GearDpsSummary {
  dps: number;
  critDps: number | null;
  critCondition: CritCondition;
  critConditionLabel: string | null;
  baseDamageScaled: number;
  isSkill: boolean;
  isShield: boolean;
  isAmulet: boolean;
  cooldownSec: number | null;
  blockDrPct: number | null;
  parryPassiveLabel: string | null;
  colors: ScrollStat[];
  bonusScrolls: Array<{ stat: ScrollStat; amount: number }>;
}

export interface AffixSynergyInfo {
  id: string;
  label: string;
  isStar: boolean;
  isActiveSynergy: boolean;
  targetStatus?: StatusKind;
}

export function getQualityCssClass(quality: GearQuality): string {
  switch (quality) {
    case '+':
      return 'kc-q-plus';
    case '++':
      return 'kc-q-plusplus';
    case 'S':
      return 'kc-q-s';
    case 'L':
      return 'kc-q-l';
    default:
      return 'kc-q-base';
  }
}

export function getCritConditionLabel(condition: CritCondition, weaponId?: string): string | null {
  if (condition === 'none') return null;
  if (condition === 'finalHit' && weaponId === 'DualDaggers') {
    return 'The 3rd strike in the combo is always a critical hit.';
  }
  if (condition === 'finalHit' && weaponId === 'BroadSword') {
    return '2nd and 3rd combo strikes always inflict critical hits.';
  }
  if (condition === 'highCombo' && weaponId === 'QuickSword') {
    return 'Inflicts critical hits at 10+ consecutive strikes.';
  }
  return CRIT_CONDITION_LABELS[condition] ?? null;
}

export function getAffixDisplayLabel(affixId: string, catalog?: CatalogLookup): string {
  return catalog?.getAffix?.(affixId)?.label ?? FALLBACK_AFFIX_META[affixId]?.label ?? humanizeId(affixId);
}

export function computeGearDpsSummary(
  gear: GearInstance,
  state: SimState,
  catalog?: CatalogLookup
): GearDpsSummary {
  const effLevel = gear.level + getQualityBonus(gear.quality);
  const levelMult = Math.pow(1.07, Math.max(0, effLevel - 1));
  const scrolls = state.player.scrolls;

  const bonusScrolls: Array<{ stat: ScrollStat; amount: number }> = [];
  if (gear.bonusScrolls) {
    (['brutality', 'tactics', 'survival'] as ScrollStat[]).forEach((stat) => {
      const amt = gear.bonusScrolls?.[stat] ?? 0;
      if (amt > 0) bonusScrolls.push({ stat, amount: amt });
    });
  }

  const weaponDef = gear.slotKind === 'weapon' ? catalog?.getWeapon?.(gear.defId) : undefined;
  const skillDef = gear.slotKind === 'skill' ? catalog?.getSkill?.(gear.defId) : undefined;

  const colors: ScrollStat[] =
    weaponDef?.colors && weaponDef.colors.length > 0
      ? [...weaponDef.colors]
      : skillDef?.colors && skillDef.colors.length > 0
        ? [...skillDef.colors]
        : gear.color !== 'colorless'
          ? [gear.color]
          : [];

  let statCount: number;
  if (gear.color === 'colorless' || gear.quality === 'L') {
    statCount = Math.max(scrolls.brutality, scrolls.tactics, scrolls.survival);
  } else if (colors.length > 1) {
    statCount = Math.max(...colors.map((c) => scrolls[c]));
  } else {
    statCount = scrolls[gear.color];
  }
  const scrollMult = getScrollDamageMultiplier(statCount);

  if (gear.slotKind === 'amulet') {
    return {
      dps: 0,
      critDps: null,
      critCondition: 'none',
      critConditionLabel: null,
      baseDamageScaled: 0,
      isSkill: false,
      isShield: false,
      isAmulet: true,
      cooldownSec: null,
      blockDrPct: gear.dmgReductionPct ?? null,
      parryPassiveLabel: null,
      colors,
      bonusScrolls,
    };
  }

  if (gear.slotKind === 'skill') {
    const bp = skillDef?.basePower ?? 70;
    const scaled = bp > 0 ? Math.round(bp * levelMult * scrollMult) : 0;
    const cdTicks = skillDef?.cooldownTicks ?? 360;
    return {
      dps: scaled,
      critDps: null,
      critCondition: 'none',
      critConditionLabel: null,
      baseDamageScaled: scaled,
      isSkill: true,
      isShield: false,
      isAmulet: false,
      cooldownSec: Math.round((cdTicks / SIM_HZ) * 10) / 10,
      blockDrPct: null,
      parryPassiveLabel: null,
      colors,
      bonusScrolls,
    };
  }

  // Weapon (melee, ranged, or shield)
  const fallbackWep = FALLBACK_WEAPONS.find((w) => w.id === gear.defId);
  const isShield = weaponDef ? weaponDef.kind === 'shield' : fallbackWep?.kind === 'shield';

  if (isShield) {
    const step0 = weaponDef?.strikeChain[0];
    const bp = step0?.basePower ?? 45;
    const parryDmg = Math.round(bp * levelMult * scrollMult);
    const critMul = step0?.critMul ?? 2.0;
    const critCondition: CritCondition = weaponDef?.critCondition ?? 'afterParry';
    const blockDrPct = Math.round(
      (weaponDef?.blockDrPct ?? (gear.defId === 'ForceShield' ? 0.85 : 0.75)) * 100
    );
    const passiveMap: Record<string, string> = {
      stun: 'Parry & block stun melee attackers.',
      bleed: 'Parry erupts in an AoE bleed wave.',
      forcefield: 'Melee parry grants a 2s invulnerable forcefield.',
      damageBuff: 'Parry boosts your next melee attack.',
    };
    const parryPassiveLabel =
      weaponDef?.parryPassive && weaponDef.parryPassive !== 'none'
        ? passiveMap[weaponDef.parryPassive] ?? null
        : null;

    return {
      dps: parryDmg,
      critDps: critCondition !== 'none' ? Math.round(parryDmg * critMul) : null,
      critCondition,
      critConditionLabel: getCritConditionLabel(critCondition, gear.defId),
      baseDamageScaled: parryDmg,
      isSkill: false,
      isShield: true,
      isAmulet: false,
      cooldownSec: null,
      blockDrPct,
      parryPassiveLabel,
      colors,
      bonusScrolls,
    };
  }

  if (weaponDef && weaponDef.strikeChain.length > 0) {
    let sumPower = 0;
    let sumCritPower = 0;
    let sumTicks = 0;
    for (const step of weaponDef.strikeChain) {
      sumPower += step.basePower;
      sumCritPower += step.basePower * (step.critMul > 0 ? step.critMul : 2.0);
      sumTicks += Math.max(1, step.windupTicks + step.activeTicks + step.recoveryTicks);
    }
    const comboSec = Math.max(1 / SIM_HZ, sumTicks / SIM_HZ);
    const dps = Math.round((sumPower / comboSec) * levelMult * scrollMult);
    const critCondition = weaponDef.critCondition;
    const critDps =
      critCondition !== 'none'
        ? Math.round((sumCritPower / comboSec) * levelMult * scrollMult)
        : null;
    const avgHit = Math.round((sumPower / weaponDef.strikeChain.length) * levelMult * scrollMult);
    return {
      dps,
      critDps,
      critCondition,
      critConditionLabel: getCritConditionLabel(critCondition, gear.defId),
      baseDamageScaled: avgHit,
      isSkill: false,
      isShield: false,
      isAmulet: false,
      cooldownSec: null,
      blockDrPct: null,
      parryPassiveLabel: null,
      colors,
      bonusScrolls,
    };
  }

  // Fallback when catalog is absent
  const fallbackDps = Math.round(160 * levelMult * scrollMult);
  return {
    dps: fallbackDps,
    critDps: null,
    critCondition: 'none',
    critConditionLabel: null,
    baseDamageScaled: Math.round(50 * levelMult * scrollMult),
    isSkill: false,
    isShield: false,
    isAmulet: false,
    cooldownSec: null,
    blockDrPct: null,
    parryPassiveLabel: null,
    colors,
    bonusScrolls,
  };
}

export function estimateGearPower(gear: GearInstance, state: SimState, catalog?: CatalogLookup): number {
  return computeGearDpsSummary(gear, state, catalog).dps;
}

function collectAppliedStatusesFromGear(gear: GearInstance, catalog?: CatalogLookup): Set<StatusKind> {
  const out = new Set<StatusKind>();
  if (gear.slotKind === 'weapon') {
    const def = catalog?.getWeapon?.(gear.defId);
    if (def) {
      for (const step of def.strikeChain) {
        if (step.applyStatus) out.add(step.applyStatus);
      }
      if (def.parryPassive === 'stun') out.add('stun');
      if (def.parryPassive === 'bleed') out.add('bleed');
    } else {
      if (gear.defId === 'Bleeder' || gear.defId === 'ThrowingKnife' || gear.defId === 'BleedShield') {
        out.add('bleed');
      }
      if (gear.defId === 'Fireball') out.add('burn');
      if (gear.defId === 'FrostBow') out.add('freeze');
      if (gear.defId === 'Whip') out.add('electrify');
      if (gear.defId === 'StunMace' || gear.defId === 'StunShield') out.add('stun');
    }
  } else if (gear.slotKind === 'skill') {
    const def = catalog?.getSkill?.(gear.defId);
    if (def) {
      if (def.applyStatus) out.add(def.applyStatus);
      if (def.secondStatus) out.add(def.secondStatus);
    } else {
      if (gear.defId === 'SinewSlicer' || gear.defId === 'KnifeDance') out.add('bleed');
      if (gear.defId === 'FireGrenade') {
        out.add('burn');
        out.add('oil');
      }
      if (gear.defId === 'IceGrenade') {
        out.add('freeze');
        out.add('slow');
      }
      if (gear.defId === 'WolfTrap' || gear.defId === 'Phaser') out.add('root');
    }
  }

  for (const affixId of gear.affixes) {
    const def = catalog?.getAffix?.(affixId);
    if (def) {
      if (def.kind === 'applyStatus' && def.applyStatus) out.add(def.applyStatus);
      if (def.kind === 'explodeToxic') out.add('poison');
      if (def.kind === 'flameTrail') out.add('burn');
    } else {
      const fb = FALLBACK_AFFIX_META[affixId];
      if (fb?.applyStatus) out.add(fb.applyStatus);
    }
  }
  return out;
}

export function analyzeGearAffixes(
  gear: GearInstance,
  state: SimState,
  catalog?: CatalogLookup
): AffixSynergyInfo[] {
  const otherStatuses = new Set<StatusKind>();
  const loadout = state.player.loadout;
  const equippedSlots: Array<GearInstance | null> = [
    loadout.weapon1,
    loadout.weapon2,
    loadout.skill1,
    loadout.skill2,
    loadout.amulet,
  ];
  for (const eq of equippedSlots) {
    if (!eq || eq.uid === gear.uid) continue;
    for (const st of collectAppliedStatusesFromGear(eq, catalog)) {
      otherStatuses.add(st);
    }
  }
  if (state.player.mutations.includes('OpenWounds')) otherStatuses.add('bleed');
  if (state.player.mutations.includes('Melee')) otherStatuses.add('slow');

  return gear.affixes.map((id) => {
    const def = catalog?.getAffix?.(id);
    const fb = FALLBACK_AFFIX_META[id];
    const label = def?.label ?? fb?.label ?? humanizeId(id);
    const targetStatus = def?.targetStatus ?? fb?.targetStatus;
    const isStar = Boolean(
      fb?.isStar ||
        def?.kind === 'bonusDmg' ||
        def?.kind === 'pierce' ||
        def?.kind === 'explodeToxic' ||
        def?.kind === 'flameTrail' ||
        def?.kind === 'dmgDealtTaken'
    );
    const isActiveSynergy = Boolean(
      targetStatus &&
        (otherStatuses.has(targetStatus) ||
          (targetStatus === 'freeze' && otherStatuses.has('frost')) ||
          (targetStatus === 'slow' && otherStatuses.has('freeze')))
    );
    return {
      id,
      label,
      isStar,
      isActiveSynergy,
      targetStatus,
    };
  });
}

// =============================================================================
// Crisp Pixel-Art Icon Renderer (getItemIconUrl + crisp pixel-SVG fallback)
// =============================================================================

function resolveFallbackKind(itemId: string, explicit?: IconFallbackKind): IconFallbackKind {
  if (explicit) return explicit;
  const lower = itemId.toLowerCase();
  if (itemId === 'HealthFlask' || lower.includes('flask')) return 'flask';
  if (itemId === 'Cell') return 'cell';
  if (itemId === 'Gold' || lower.includes('gold')) return 'gold';
  if (itemId === 'Skull' || lower.includes('curse')) return 'skull';
  if (itemId === 'BossCell') return 'bossCell';
  if (lower.startsWith('scroll')) return 'scroll';
  if (lower.includes('shield')) return 'shield';
  if (lower.includes('bow') || lower.includes('knife') || lower.includes('whip') || lower.includes('fireball')) {
    return 'ranged';
  }
  if (lower.includes('turret') || lower.includes('slicer')) return 'turret';
  if (lower.includes('grenade')) return 'grenade';
  if (lower.includes('trap')) return 'trap';
  if (lower.includes('wave') || lower.includes('dance')) return 'wave';
  if (lower.includes('phaser')) return 'teleport';
  if (lower.includes('tonic') || lower.includes('corrupted')) return 'power';
  if (FALLBACK_MUTATIONS.some((m) => m.id === itemId)) return 'mutation';
  return 'melee';
}

function resolveItemAccent(itemId: string, explicit?: string): string {
  if (explicit) return explicit;
  if (itemId === 'ScrollBrutality' || itemId === 'Bleeder' || itemId === 'FireGrenade' || itemId === 'Fireball') {
    return '#e83b4a';
  }
  if (itemId === 'ScrollTactics' || itemId === 'Whip' || itemId === 'Phaser' || itemId === 'CorruptedPower') {
    return '#a855f7';
  }
  if (itemId === 'ScrollSurvival' || itemId === 'Tonic' || itemId === 'HealthFlask') {
    return '#22c55e';
  }
  if (itemId === 'IceGrenade' || itemId === 'FrostBow' || itemId === 'WaveOfDenial' || itemId === 'Cell') {
    return '#38e8ff';
  }
  if (itemId === 'Gold' || itemId === 'GoldReserves') return '#fbbf24';
  if (itemId === 'Skull' || itemId === 'BossCell') return '#ef4444';
  const w = FALLBACK_WEAPONS.find((x) => x.id === itemId);
  if (w) return w.color === 'brutality' ? '#e83b4a' : w.color === 'tactics' ? '#a855f7' : '#22c55e';
  const s = FALLBACK_SKILLS.find((x) => x.id === itemId);
  if (s) return s.color === 'brutality' ? '#e83b4a' : s.color === 'tactics' ? '#a855f7' : '#22c55e';
  const m = FALLBACK_MUTATIONS.find((x) => x.id === itemId);
  if (m) {
    if (m.color === 'brutality') return '#e83b4a';
    if (m.color === 'tactics') return '#a855f7';
    if (m.color === 'survival') return '#22c55e';
    return '#fbbf24';
  }
  return '#e2e8f0';
}

/**
 * Renders a razor-sharp 16x16 pixel-grid SVG emblem (shape-rendering="crispEdges")
 * ONLY as a geometric fallback when `getItemIconUrl` returns null or for pure UI chrome.
 */
export function renderUiGlyphSvg(
  kind: IconFallbackKind,
  size = 18,
  accent = '#e83b4a',
  className = ''
): string {
  const cls = `kc-pixel-svg ${className}`.trim();
  let shapes = '';
  switch (kind) {
    case 'melee':
      shapes = `
        <path d="M11 2h3v3l-7 7-2-2z" fill="#d8e2f0"/>
        <path d="M12 2h2v2l-6 6-1-1z" fill="#ffffff"/>
        <rect x="4" y="8" width="4" height="2" fill="${accent}"/>
        <rect x="6" y="10" width="2" height="2" fill="${accent}"/>
        <rect x="3" y="11" width="2" height="2" fill="#8b5e3c"/>
        <rect x="2" y="12" width="2" height="2" fill="#fbbf24"/>
      `;
      break;
    case 'ranged':
      shapes = `
        <path d="M5 2h2v2H5v8h2v2H5v-1H4v-2H3V5h1V3h1z" fill="#c7955b"/>
        <rect x="7" y="3" width="1" height="10" fill="#cbd5e1"/>
        <rect x="5" y="7" width="8" height="2" fill="${accent}"/>
        <rect x="12" y="6" width="2" height="4" fill="#ffffff"/>
      `;
      break;
    case 'shield':
      shapes = `
        <path d="M3 2h10v6l-5 6-5-6z" fill="#2c3347" stroke="#090710" stroke-width="1"/>
        <path d="M4 3h8v4l-4 5-4-5z" fill="${accent}"/>
        <rect x="7" y="4" width="2" height="6" fill="#fff3d6"/>
        <rect x="5" y="6" width="6" height="2" fill="#fff3d6"/>
      `;
      break;
    case 'turret':
      shapes = `
        <rect x="4" y="5" width="8" height="5" fill="#475569"/>
        <rect x="11" y="6" width="4" height="2" fill="${accent}"/>
        <rect x="5" y="4" width="6" height="2" fill="#cbd5e1"/>
        <rect x="5" y="10" width="2" height="4" fill="#94a3b8"/>
        <rect x="9" y="10" width="2" height="4" fill="#94a3b8"/>
        <rect x="6" y="6" width="2" height="2" fill="#38e8ff"/>
      `;
      break;
    case 'grenade':
      shapes = `
        <rect x="6" y="2" width="4" height="2" fill="#94a3b8"/>
        <rect x="9" y="1" width="3" height="2" fill="#fbbf24"/>
        <rect x="4" y="4" width="8" height="9" fill="#1e2433"/>
        <rect x="5" y="5" width="6" height="7" fill="${accent}"/>
        <rect x="6" y="6" width="2" height="2" fill="#fff6d6"/>
      `;
      break;
    case 'trap':
      shapes = `
        <rect x="2" y="10" width="12" height="3" fill="#64748b"/>
        <rect x="3" y="6" width="2" height="4" fill="${accent}"/>
        <rect x="7" y="7" width="2" height="3" fill="${accent}"/>
        <rect x="11" y="6" width="2" height="4" fill="${accent}"/>
        <rect x="6" y="10" width="4" height="2" fill="#fbbf24"/>
      `;
      break;
    case 'wave':
      shapes = `
        <rect x="3" y="6" width="2" height="4" fill="${accent}"/>
        <rect x="6" y="4" width="2" height="8" fill="#7dd3fc"/>
        <rect x="9" y="3" width="2" height="10" fill="${accent}"/>
        <rect x="12" y="5" width="2" height="6" fill="#ffffff"/>
      `;
      break;
    case 'teleport':
      shapes = `
        <path d="M9 1h3l-3 5h4l-7 9 2-6H4z" fill="${accent}"/>
        <rect x="7" y="5" width="2" height="3" fill="#ffffff"/>
      `;
      break;
    case 'power':
      shapes = `
        <path d="M8 1l2 4 5 1-3 3 1 5-5-2-5 2 1-5-3-3 5-1z" fill="${accent}"/>
        <rect x="7" y="6" width="2" height="3" fill="#ffffff"/>
      `;
      break;
    case 'mutation':
      shapes = `
        <rect x="4" y="2" width="8" height="12" fill="#171224"/>
        <rect x="5" y="3" width="6" height="2" fill="${accent}"/>
        <rect x="7" y="5" width="2" height="2" fill="#ffffff"/>
        <rect x="5" y="7" width="6" height="2" fill="${accent}"/>
        <rect x="7" y="9" width="2" height="2" fill="#ffffff"/>
        <rect x="5" y="11" width="6" height="2" fill="${accent}"/>
      `;
      break;
    case 'flask':
      shapes = `
        <rect x="6" y="1" width="4" height="2" fill="#cbd5e1"/>
        <rect x="7" y="3" width="2" height="2" fill="#94a3b8"/>
        <rect x="4" y="5" width="8" height="9" fill="#1a2433"/>
        <rect x="5" y="8" width="6" height="5" fill="#22c55e"/>
        <rect x="6" y="9" width="2" height="2" fill="#86efac"/>
      `;
      break;
    case 'cell':
      shapes = `
        <rect x="6" y="2" width="4" height="12" fill="#0891b2"/>
        <rect x="4" y="4" width="8" height="8" fill="#38e8ff"/>
        <rect x="6" y="5" width="4" height="5" fill="#cffafe"/>
        <rect x="6" y="5" width="2" height="2" fill="#ffffff"/>
      `;
      break;
    case 'gold':
      shapes = `
        <rect x="5" y="2" width="6" height="12" fill="#b45309"/>
        <rect x="4" y="3" width="8" height="10" fill="#fbbf24"/>
        <rect x="6" y="4" width="4" height="8" fill="#fde68a"/>
        <rect x="7" y="5" width="2" height="6" fill="#d97706"/>
      `;
      break;
    case 'skull':
      shapes = `
        <rect x="4" y="2" width="8" height="8" fill="#f1f5f9"/>
        <rect x="3" y="4" width="10" height="5" fill="#e2e8f0"/>
        <rect x="5" y="10" width="6" height="3" fill="#cbd5e1"/>
        <rect x="5" y="5" width="2" height="2" fill="#dc2626"/>
        <rect x="9" y="5" width="2" height="2" fill="#dc2626"/>
        <rect x="7" y="8" width="2" height="2" fill="#090710"/>
        <rect x="6" y="11" width="1" height="2" fill="#090710"/>
        <rect x="9" y="11" width="1" height="2" fill="#090710"/>
      `;
      break;
    case 'scroll':
      shapes = `
        <rect x="3" y="2" width="10" height="2" fill="#d4b483"/>
        <rect x="4" y="4" width="8" height="8" fill="#efe2c4"/>
        <rect x="3" y="12" width="10" height="2" fill="#d4b483"/>
        <rect x="6" y="6" width="4" height="4" fill="${accent}"/>
        <rect x="7" y="7" width="2" height="2" fill="#ffffff"/>
      `;
      break;
    case 'bossCell':
      shapes = `
        <rect x="5" y="2" width="6" height="12" fill="#7f1d1d"/>
        <rect x="3" y="4" width="10" height="8" fill="#e83b4a"/>
        <rect x="5" y="5" width="6" height="6" fill="#fb7185"/>
        <rect x="6" y="6" width="3" height="3" fill="#fff1f2"/>
      `;
      break;
    case 'timer':
      shapes = `
        <rect x="4" y="2" width="8" height="2" fill="#d4b483"/>
        <rect x="5" y="4" width="6" height="2" fill="#94a3b8"/>
        <rect x="7" y="6" width="2" height="4" fill="#fbbf24"/>
        <rect x="5" y="10" width="6" height="2" fill="#fbbf24"/>
        <rect x="4" y="12" width="8" height="2" fill="#d4b483"/>
      `;
      break;
    case 'forge':
      shapes = `
        <rect x="2" y="5" width="12" height="3" fill="#94a3b8"/>
        <rect x="4" y="8" width="8" height="2" fill="#64748b"/>
        <rect x="5" y="10" width="6" height="2" fill="#475569"/>
        <rect x="3" y="12" width="10" height="2" fill="#94a3b8"/>
        <rect x="7" y="2" width="2" height="2" fill="#ff8c24"/>
      `;
      break;
    case 'door':
      shapes = `
        <rect x="4" y="2" width="8" height="12" fill="#166534"/>
        <rect x="5" y="3" width="6" height="11" fill="#22c55e"/>
        <rect x="6" y="4" width="4" height="9" fill="#86efac"/>
        <rect x="9" y="8" width="2" height="2" fill="#14532d"/>
      `;
      break;
    case 'crown':
      shapes = `
        <rect x="2" y="10" width="12" height="3" fill="#fbbf24"/>
        <rect x="2" y="5" width="2" height="5" fill="#fbbf24"/>
        <rect x="7" y="3" width="2" height="7" fill="#fde047"/>
        <rect x="12" y="5" width="2" height="5" fill="#fbbf24"/>
        <rect x="4" y="8" width="8" height="2" fill="#f59e0b"/>
        <rect x="7" y="10" width="2" height="2" fill="#e83b4a"/>
      `;
      break;
    case 'flame':
      shapes = `
        <rect x="7" y="2" width="2" height="3" fill="#fde047"/>
        <rect x="5" y="5" width="6" height="4" fill="#ff6b35"/>
        <rect x="4" y="8" width="8" height="5" fill="#e83b4a"/>
        <rect x="6" y="9" width="4" height="4" fill="#fbbf24"/>
        <rect x="7" y="10" width="2" height="2" fill="#fffbeb"/>
      `;
      break;
    case 'dice':
      shapes = `
        <rect x="3" y="3" width="10" height="10" fill="#e2e8f0"/>
        <rect x="4" y="4" width="8" height="8" fill="#1e1b2e"/>
        <rect x="5" y="5" width="2" height="2" fill="#fbbf24"/>
        <rect x="9" y="5" width="2" height="2" fill="#fbbf24"/>
        <rect x="7" y="7" width="2" height="2" fill="#fbbf24"/>
        <rect x="5" y="9" width="2" height="2" fill="#fbbf24"/>
        <rect x="9" y="9" width="2" height="2" fill="#fbbf24"/>
      `;
      break;
    case 'rune':
      shapes = `
        <rect x="7" y="1" width="2" height="14" fill="#38e8ff"/>
        <rect x="5" y="3" width="6" height="10" fill="#0ea5e9"/>
        <rect x="3" y="6" width="10" height="4" fill="#38e8ff"/>
        <rect x="6" y="6" width="4" height="4" fill="#ffffff"/>
      `;
      break;
    case 'crackedSkull':
      shapes = `
        <rect x="4" y="2" width="8" height="8" fill="#fca5a5"/>
        <rect x="3" y="4" width="10" height="5" fill="#ef4444"/>
        <rect x="5" y="10" width="6" height="3" fill="#dc2626"/>
        <rect x="5" y="5" width="2" height="2" fill="#1a0305"/>
        <rect x="9" y="5" width="2" height="2" fill="#1a0305"/>
        <path d="M8 2h1v3h1v2h-1v2h1v2h-1V9H8V6H7V4h1z" fill="#09030a"/>
        <rect x="7" y="8" width="2" height="2" fill="#09030a"/>
      `;
      break;
    case 'malaise':
      shapes = `
        <rect x="6" y="1" width="4" height="3" fill="#c084fc"/>
        <rect x="4" y="4" width="8" height="7" fill="#9333ea"/>
        <rect x="2" y="6" width="3" height="5" fill="#e11d48"/>
        <rect x="11" y="6" width="3" height="5" fill="#e11d48"/>
        <rect x="5" y="6" width="2" height="2" fill="#fde047"/>
        <rect x="9" y="6" width="2" height="2" fill="#fde047"/>
        <rect x="6" y="11" width="4" height="3" fill="#be123c"/>
      `;
      break;
    case 'star':
      shapes = `
        <rect x="7" y="1" width="2" height="14" fill="${accent}"/>
        <rect x="1" y="7" width="14" height="2" fill="${accent}"/>
        <rect x="5" y="5" width="6" height="6" fill="#fff3b0"/>
        <rect x="7" y="7" width="2" height="2" fill="#ffffff"/>
      `;
      break;
    case 'shop':
      shapes = `
        <rect x="2" y="2" width="12" height="3" fill="#dc2626"/>
        <rect x="4" y="2" width="2" height="3" fill="#fbbf24"/>
        <rect x="10" y="2" width="2" height="3" fill="#fbbf24"/>
        <rect x="3" y="5" width="10" height="2" fill="#7c2d12"/>
        <rect x="3" y="7" width="2" height="7" fill="#92400e"/>
        <rect x="11" y="7" width="2" height="7" fill="#92400e"/>
        <rect x="5" y="10" width="6" height="4" fill="#b45309"/>
        <rect x="7" y="7" width="2" height="2" fill="#fde047"/>
      `;
      break;
    case 'tube':
      shapes = `
        <rect x="4" y="1" width="8" height="2" fill="#94a3b8"/>
        <rect x="5" y="3" width="6" height="10" fill="#0f293a"/>
        <rect x="6" y="4" width="4" height="8" fill="${accent}"/>
        <rect x="6" y="5" width="1" height="6" fill="#ffffff"/>
        <rect x="4" y="13" width="8" height="2" fill="#94a3b8"/>
      `;
      break;
    case 'amulet':
    default:
      shapes = `
        <rect x="6" y="2" width="4" height="2" fill="#fbbf24"/>
        <rect x="5" y="5" width="6" height="7" fill="${accent}"/>
        <rect x="6" y="6" width="4" height="5" fill="#ffffff"/>
      `;
      break;
  }

  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${shapes}</svg>`;
}

/**
 * Renders a crisp pixel-art `<img>` icon fetched from `getItemIconUrl`, with a
 * crisp pixel-styled SVG geometric fallback ONLY if `getItemIconUrl` returns null.
 */
export function renderItemIconHtml(
  itemId: string,
  artPackMode: ArtPackMode,
  customPack?: CustomPackAssetResolver | null,
  opts?: {
    size?: number;
    className?: string;
    alt?: string;
    fallbackKind?: IconFallbackKind;
    accentColor?: string;
  }
): string {
  const size = opts?.size ?? 34;
  const className = opts?.className ?? '';
  const alt = opts?.alt ?? humanizeId(itemId);
  const url = getItemIconUrl(itemId, artPackMode, customPack);
  if (url) {
    return `<img class="kc-pixel-icon ${className}" src="${url}" width="${size}" height="${size}" alt="${escapeHtml(alt)}" draggable="false" />`;
  }
  const kind = resolveFallbackKind(itemId, opts?.fallbackKind);
  const accent = resolveItemAccent(itemId, opts?.accentColor);
  return renderUiGlyphSvg(kind, size, accent, className);
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
  gravity: number;
  punchScale: boolean;
  text: string;
  className: string;
  color: string;
  ttl: number;
  maxTtl: number;
  el: HTMLDivElement;
}

const MAX_FLOATERS = 44;
const MAX_SHOP_REROLLS = 3;

export class HudOverlay {
  private hudRoot: HTMLElement;
  private canvas: HTMLCanvasElement | null;
  private catalog?: CatalogLookup;
  private callbacks: HudCallbacks;
  private cameraOriginMode: CameraOriginMode = 'auto';
  private artPackMode: ArtPackMode = 'builtin';
  private customPackResolver: CustomPackAssetResolver | null = null;

  // Persistent DOM containers
  private curseVignetteEl: HTMLDivElement;
  private priceTagLayer: HTMLDivElement;
  private floatLayer: HTMLDivElement;
  private bossSplashEl: HTMLDivElement;
  private bossSplashEpithetEl!: HTMLDivElement;
  private bossSplashTitleEl!: HTMLDivElement;
  private bossSplashBandEl!: HTMLDivElement;
  private bossLetterTopEl!: HTMLDivElement;
  private bossLetterBotEl!: HTMLDivElement;
  private bossBanner: HTMLDivElement;
  private toastBanner: HTMLDivElement;
  private trContainer: HTMLDivElement;
  private minimapHost: HTMLDivElement;
  private blContainer: HTMLDivElement;
  private slotTooltipEl: HTMLDivElement;
  private merchantBarEl: HTMLDivElement;
  private tubeCardEl: HTMLDivElement;
  private lootCardEl: HTMLDivElement;
  private interactEl: HTMLDivElement;

  // Dynamic cached regions (Top-Right)
  private biomeNameEl!: HTMLSpanElement;
  private bcPipsEl!: HTMLDivElement;
  private cellsIconEl!: HTMLSpanElement;
  private goldIconEl!: HTMLSpanElement;
  private timerIconEl!: HTMLSpanElement;
  private goldEl!: HTMLSpanElement;
  private cellsEl!: HTMLSpanElement;
  private timerEl!: HTMLSpanElement;
  private streakEl!: HTMLDivElement;
  private curseEl!: HTMLDivElement;

  // Dynamic cached regions (Bottom-Left)
  private flaskWidgetEl!: HTMLButtonElement;
  private flaskLiquidEl!: HTMLDivElement;
  private flaskPipsEl!: HTMLDivElement;
  private flaskKeyEl!: HTMLSpanElement;
  private malaiseWrapEl!: HTMLDivElement;
  private malaiseIconEl!: HTMLSpanElement;
  private malaiseSegEls: HTMLSpanElement[] = [];
  private malaiseTextEl!: HTMLSpanElement;
  private hpTextEl!: HTMLSpanElement;
  private hpStatusEl!: HTMLDivElement;
  private hpRallyEl!: HTMLDivElement;
  private hpFillEl!: HTMLDivElement;
  private hpShieldEl!: HTMLDivElement;
  private gearSlotEls: HTMLDivElement[] = [];
  private amuletSlotEl!: HTMLDivElement;
  private scrollSlotEls: Record<
    ScrollStat,
    { icon: HTMLSpanElement; count: HTMLSpanElement; wrap: HTMLDivElement }
  > = {} as Record<ScrollStat, { icon: HTMLSpanElement; count: HTMLSpanElement; wrap: HTMLDivElement }>;
  private mutationEls: HTMLDivElement[] = [];

  // Dynamic cached regions (Boss Bar + smooth damage-drain trail + Boss Intro Splash)
  private bossTitleEl!: HTMLSpanElement;
  private bossSubEl!: HTMLSpanElement;
  private bossPhaseEl!: HTMLSpanElement;
  private bossTrailEl!: HTMLDivElement;
  private bossFillEl!: HTMLDivElement;
  private bossHpTextEl!: HTMLDivElement;
  private lastBossUid: number | null = null;
  private bossTrailPct = 100;
  private bossTrailHoldSec = 0;
  private bossIntroMaxTicks = 150;
  private lastBossSplashBossId: BossId | null = null;
  private wasBossArenaActive = false;

  // Active-cast golden flash timers per slot [W1, W2, S1, S2]
  private slotFlashSec: [number, number, number, number] = [0, 0, 0, 0];

  // Kill-streak & curse transition tracking
  private lastBiomeIdForStreak: BiomeId | null = null;
  private hasEnteredCombat = false;
  private prevStreakValue = 0;
  private streakBreakTimerSec = 0;
  private streakMilestoneTimerSec = 0;
  private lastStreakSig = '';

  // Anchored bottom-left slot hover/focus tooltip tracking
  private hoveredSlotIndex: number | null = null;
  private lastTooltipSig = '';
  private lastState: SimState | null = null;
  private lastBindings: KeyBindings = { ...DEFAULT_KEY_BINDINGS };

  // World-projected shop price tag pool keyed by pickup uid
  private priceTagEls = new Map<number, HTMLDivElement>();
  private selectedShopColorFilter: ScrollStat | undefined = undefined;
  private lastMerchantShrineUid: number | null = null;
  private lastMerchantSig = '';
  private lastTubeSig = '';
  private activeNearbyTube: ShrineState | null = null;

  private floaters: FloatingTextItem[] = [];
  private seenParticleUids = new Set<number>();
  private nextFloaterId = 1;
  private toastTimer = 0;

  private lastLootSignature = '';
  private lastInteractSignature = '';
  private lastLoadoutSignature = '';
  private lastCurseRendered = -1;
  private lastStatusSig = '';
  private activeNearbyPickup: PickupState | null = null;
  private lastInputSnapshot: ActiveInputSnapshot | null = null;
  private layoutPreset: GamepadLayoutPreset = 'standard';
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

    // Organic pulsing crimson Curse Vignette screen border (non-blocking)
    this.curseVignetteEl = document.createElement('div');
    this.curseVignetteEl.className = 'dc-curse-vignette';
    this.curseVignetteEl.setAttribute('aria-hidden', 'true');
    this.hudRoot.appendChild(this.curseVignetteEl);

    // Floating world-projected Shop Gold Price Tags (non-blocking)
    this.priceTagLayer = document.createElement('div');
    this.priceTagLayer.className = 'kc-price-tag-layer';
    this.hudRoot.appendChild(this.priceTagLayer);

    this.floatLayer = document.createElement('div');
    this.floatLayer.className = 'kc-float-layer';
    this.hudRoot.appendChild(this.floatLayer);

    // Cinematic Non-Blocking Boss Intro Splash Card
    this.bossSplashEl = this.createBossSplash();
    this.hudRoot.appendChild(this.bossSplashEl);

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

    // Anchored Hover/Focus Tooltip Card above bottom-left gear/amulet slots
    this.slotTooltipEl = document.createElement('div');
    this.slotTooltipEl.className = 'kc-slot-tooltip kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.slotTooltipEl);

    this.interactEl = document.createElement('div');
    this.interactEl.className = 'kc-interact-prompt kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.interactEl);

    // In-Biome Merchant Reroll & Category Filter Bar
    this.merchantBarEl = document.createElement('div');
    this.merchantBarEl.className = 'kc-merchant-bar kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.merchantBarEl);

    // Recycling Tube 4-Slot Loadout Preview Card
    this.tubeCardEl = document.createElement('div');
    this.tubeCardEl.className = 'kc-tube-card kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.tubeCardEl);

    this.lootCardEl = document.createElement('div');
    this.lootCardEl.className = 'kc-loot-card kc-iron-panel kc-hidden';
    this.hudRoot.appendChild(this.lootCardEl);

    this.refreshStaticIcons();
    this.setVisible(false);
  }

  public getMinimapHost(): HTMLDivElement {
    return this.minimapHost;
  }

  public setCameraOriginMode(mode: CameraOriginMode): void {
    this.cameraOriginMode = mode;
  }

  public setLayoutPreset(layoutPreset: GamepadLayoutPreset): void {
    if (this.layoutPreset === layoutPreset) return;
    this.layoutPreset = layoutPreset;
    this.lastLoadoutSignature = '';
    this.lastLootSignature = '';
    this.lastTubeSig = '';
    this.lastInteractSignature = '';
    this.lastTooltipSig = '';
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
    this.forceRefreshIcons();
  }

  public setArtPackContext(mode: ArtPackMode, resolver?: CustomPackAssetResolver | null): void {
    this.artPackMode = mode;
    this.customPackResolver = resolver ?? null;
    this.forceRefreshIcons();
  }

  public forceRefreshIcons(): void {
    this.lastLoadoutSignature = '';
    this.lastLootSignature = '';
    this.lastCurseRendered = -1;
    this.lastStreakSig = '';
    this.lastTooltipSig = '';
    this.lastMerchantSig = '';
    this.lastTubeSig = '';
    this.refreshStaticIcons();
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.hudRoot.classList.toggle('kc-hidden', !visible);
    if (!visible) {
      this.hideSlotTooltip();
    }
  }

  public hasActiveInteractable(): boolean {
    if (!this.visible) return false;
    return (
      this.activeNearbyPickup !== null ||
      this.activeNearbyTube !== null ||
      !this.interactEl.classList.contains('kc-hidden')
    );
  }

  public showToast(text: string, durationSec = 2.6): void {
    this.toastBanner.textContent = text;
    this.toastBanner.classList.add('is-visible');
    this.toastTimer = durationSec;
  }

  private clearToast(): void {
    this.toastTimer = 0;
    this.toastBanner.classList.remove('is-visible');
    this.toastBanner.textContent = '';
  }

  public triggerQuickLootAction(action: 'equip1' | 'equip2' | 'recycle', state: SimState): boolean {
    const pickup = this.activeNearbyPickup;
    if (pickup && pickup.gear && !pickup.collected) {
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

    // [F] while standing beside an unused Recycling Tube equips the full 4-slot loadout!
    if (action === 'equip1' && this.activeNearbyTube && !this.activeNearbyTube.used) {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({
        type: 'pickRecyclingTube',
        shrineUid: this.activeNearbyTube.uid,
      });
      return true;
    }

    return false;
  }

  public ingestEvents(events: readonly SimEvent[], state: SimState): void {
    const heroX = state.player.pos.x;
    let pendingGoldAmount = 0;
    let pendingGoldX = 0;
    let pendingGoldY = 0;
    let pendingCellCount = 0;
    let pendingCellX = 0;
    let pendingCellY = 0;
    for (const ev of events) {
      switch (ev.type) {
        case 'attackSwing': {
          const slotIdx = state.player.activeWeaponSlot === 2 ? 1 : 0;
          this.slotFlashSec[slotIdx] = 0.22;
          break;
        }
        case 'parryStart':
        case 'parrySuccess':
        case 'shieldBlock': {
          const w1 = state.player.loadout.weapon1;
          const w1Def = w1 ? this.catalog?.getWeapon?.(w1.defId) : undefined;
          const slotIdx = w1Def?.kind === 'shield' ? 0 : 1;
          this.slotFlashSec[slotIdx] = 0.28;
          if (ev.type === 'parrySuccess') {
            this.spawnFloater(
              ev.x,
              ev.y - 26,
              ev.reflected ? 'PARRY! REFLECT!' : 'PARRY!',
              'kc-float-num is-parry',
              '#ffd84d',
              1.05,
              null,
              { vy: -76, gravity: 120, punchScale: true }
            );
          } else if (ev.type === 'shieldBlock') {
            const amt = Math.round(ev.reducedDamage);
            this.spawnFloater(
              ev.x,
              ev.y - 22,
              amt > 0 ? `BLOCKED -${amt}` : 'BLOCKED',
              'kc-float-num is-blocked',
              '#93c5fd',
              0.82,
              null,
              { vy: -62, gravity: 125 }
            );
          }
          break;
        }
        case 'skillCast': {
          if (state.player.loadout.skill1?.defId === ev.skillId) {
            this.slotFlashSec[2] = 0.3;
          } else if (state.player.loadout.skill2?.defId === ev.skillId) {
            this.slotFlashSec[3] = 0.3;
          }
          break;
        }
        case 'hitImpact':
          this.spawnFloater(
            ev.x,
            ev.y - 16,
            `${Math.max(1, Math.round(ev.damage))}`,
            'kc-float-num',
            '#ffffff',
            0.78,
            null,
            { awayFromX: heroX, vy: -68, gravity: 140 }
          );
          break;
        case 'critImpact':
          this.spawnFloater(
            ev.x,
            ev.y - 22,
            `${Math.max(1, Math.round(ev.damage))}!`,
            'kc-float-num is-crit',
            '#ffd84d',
            0.98,
            null,
            { awayFromX: heroX, vy: -74, gravity: 140, punchScale: true }
          );
          break;
        case 'bleedBurst':
          this.spawnFloater(
            ev.x,
            ev.y - 24,
            `BLEED! ${Math.max(1, Math.round(ev.damage))}`,
            'kc-float-num is-bleed-burst',
            '#ff2e4c',
            1.0,
            null,
            { awayFromX: heroX, vy: -76, gravity: 135, punchScale: true }
          );
          break;
        case 'freezeShatter':
          this.spawnFloater(
            ev.x,
            ev.y - 24,
            'SHATTER!',
            'kc-float-num is-shatter',
            '#7ce8ff',
            0.92,
            null,
            { awayFromX: heroX, vy: -72, gravity: 130, punchScale: true }
          );
          break;
        case 'fallStun':
          this.spawnFloater(
            ev.x,
            ev.y - 24,
            'DIZZY!',
            'kc-float-num is-status',
            '#fbbf24',
            0.85,
            null,
            { vy: -52, gravity: 110 }
          );
          break;
        case 'playerDamaged':
          this.spawnFloater(
            ev.x,
            ev.y - 22,
            `-${Math.max(1, Math.round(ev.amount))}`,
            'kc-float-num is-player-dmg',
            '#ff4757',
            0.95,
            null,
            { vy: -72, gravity: 140, punchScale: true }
          );
          break;
        case 'flaskDrink':
          this.spawnFloater(
            ev.x,
            ev.y - 24,
            `+${Math.round(ev.healed)} HP`,
            'kc-float-num is-heal',
            '#4ade80',
            1.0,
            null,
            { vy: -60, gravity: 95 }
          );
          break;
        case 'flaskEmpty':
          this.spawnFloater(
            ev.x,
            ev.y - 22,
            ev.reason === 'fullHp' ? 'FULL HP' : 'FLASK EMPTY',
            'kc-float-num is-status',
            ev.reason === 'fullHp' ? '#86efac' : '#f87171',
            0.82,
            null,
            { vy: -52, gravity: 95 }
          );
          break;
        case 'rallyRecovered':
          if (ev.amount >= 1) {
            this.spawnFloater(
              ev.x,
              ev.y - 18,
              `+${Math.round(ev.amount)}`,
              'kc-float-num is-status',
              '#ff8c24',
              0.7,
              null,
              { vy: -54, gravity: 105 }
            );
          }
          break;
        case 'goldCollect':
          if (ev.amount >= 1) {
            pendingGoldAmount += Math.round(ev.amount);
            pendingGoldX = ev.x;
            pendingGoldY = ev.y;
          }
          break;
        case 'cellCollect':
          if (ev.count >= 1) {
            pendingCellCount += Math.round(ev.count);
            pendingCellX = ev.x;
            pendingCellY = ev.y;
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
            0.75,
            null,
            { awayFromX: heroX, vy: -58, gravity: 120 }
          );
          break;
        }
        case 'curseTriggered':
          this.showToast(`CURSED — SLAY ${ev.killsRequired} ENEMIES UNTOUCHED`, 3.2);
          break;
        case 'curseCleared':
          this.spawnFloater(
            ev.x,
            ev.y - 30,
            'CURSE LIFTED!',
            'kc-float-num is-curse-lifted',
            '#4ade80',
            1.25,
            null,
            { vy: -64, gravity: 85, punchScale: true }
          );
          this.showToast('CURSE LIFTED', 2.2);
          break;
        case 'perfectKillStreak':
          this.streakMilestoneTimerSec = 1.25;
          this.lastStreakSig = '';
          this.showToast(`${ev.count} NO-HIT KILL STREAK!`, 2.2);
          break;
        case 'shopReroll':
          this.spawnFloater(
            ev.x,
            ev.y - 26,
            'RESTOCKED!',
            'kc-float-num is-parry',
            '#fbbf24',
            0.95,
            null,
            { vy: -58, gravity: 95, punchScale: true }
          );
          break;
        case 'biomeTransition':
          // Boss arenas announce themselves via the Cinematic Boss Intro Splash & Boss Banner;
          // clear any lingering prior biome toast so it never sits under the Boss HP bar.
          if (ev.to === 'Bridge' || ev.to === 'TopClockTower' || ev.to === 'Throne') {
            this.clearToast();
          } else {
            this.showToast(getBiomeDisplayName(ev.to, this.catalog), 2.8);
          }
          break;
        case 'bossPhaseShift': {
          const boss = getBossDisplayInfo(ev.bossId, this.catalog);
          this.showToast(`${boss.name} — PHASE ${formatRoman(ev.phase)}`, 2.4);
          break;
        }
        default:
          break;
      }
    }

    if (pendingGoldAmount >= 1) {
      this.spawnFloater(
        pendingGoldX,
        pendingGoldY - 16,
        `+${pendingGoldAmount} G`,
        'kc-float-num is-micro is-gold-pop',
        '#fbbf24',
        0.72,
        null,
        { vx: 0, vy: -50, gravity: 95, staggerVertical: true }
      );
    }
    if (pendingCellCount >= 1) {
      this.spawnFloater(
        pendingCellX,
        pendingCellY - 18,
        `+${pendingCellCount} CELL`,
        'kc-float-num is-micro is-cell-pop',
        '#38e8ff',
        0.76,
        null,
        { vx: 0, vy: -54, gravity: 90, staggerVertical: true }
      );
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
          p.uid,
          { awayFromX: heroX, vy: -66, gravity: 135, punchScale: isCrit }
        );
      }
    }
    if (this.seenParticleUids.size > 256) {
      this.seenParticleUids.clear();
    }
  }

  public update(
    state: SimState,
    bindings: KeyBindings,
    dtSec: number,
    interpAlpha = 1,
    inputSnapshot?: ActiveInputSnapshot
  ): void {
    this.lastState = state;
    this.lastBindings = bindings;
    this.lastInputSnapshot = inputSnapshot ?? null;

    const showHud =
      state.runStatus === 'playing' ||
      state.runStatus === 'passage' ||
      state.runStatus === 'paused';
    this.setVisible(showHud);
    if (!showHud) return;

    // Decay active-cast golden flashes
    for (let i = 0; i < 4; i++) {
      if (this.slotFlashSec[i]! > 0) {
        this.slotFlashSec[i] = Math.max(0, this.slotFlashSec[i]! - dtSec);
      }
      this.gearSlotEls[i]?.classList.toggle('is-casting', this.slotFlashSec[i]! > 0);
    }

    // Decay kill-streak animation timers
    if (this.streakBreakTimerSec > 0) {
      this.streakBreakTimerSec = Math.max(0, this.streakBreakTimerSec - dtSec);
      if (this.streakBreakTimerSec === 0) {
        this.lastStreakSig = '';
      }
    }
    if (this.streakMilestoneTimerSec > 0) {
      this.streakMilestoneTimerSec = Math.max(0, this.streakMilestoneTimerSec - dtSec);
      if (this.streakMilestoneTimerSec === 0) {
        this.lastStreakSig = '';
      }
    }

    this.updateTopRight(state);
    this.updateBottomLeft(state, bindings);
    this.updateBossBar(state, dtSec);
    this.updateNearbyLootAndPrompts(state, bindings);
    this.updateShopPriceTags(state, interpAlpha);
    this.updateFloaters(state, dtSec, interpAlpha);

    if (this.hoveredSlotIndex !== null) {
      this.renderSlotTooltip(this.hoveredSlotIndex, state, bindings);
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dtSec;
      if (this.toastTimer <= 0) {
        this.toastBanner.classList.remove('is-visible');
      }
    }
  }

  public dispose(): void {
    this.priceTagEls.clear();
    this.hudRoot.innerHTML = '';
    this.floaters = [];
    this.wasBossArenaActive = false;
    this.toastTimer = 0;
  }

  private refreshStaticIcons(): void {
    if (this.cellsIconEl) {
      this.cellsIconEl.innerHTML = renderItemIconHtml('Cell', this.artPackMode, this.customPackResolver, {
        size: 16,
        fallbackKind: 'cell',
        alt: 'Cells',
      });
    }
    if (this.goldIconEl) {
      this.goldIconEl.innerHTML = renderItemIconHtml('Gold', this.artPackMode, this.customPackResolver, {
        size: 16,
        fallbackKind: 'gold',
        alt: 'Gold',
      });
    }
    if (this.timerIconEl) {
      this.timerIconEl.innerHTML = renderUiGlyphSvg('timer', 14, '#d1c6b4');
    }
    if (this.malaiseIconEl) {
      this.malaiseIconEl.innerHTML = renderUiGlyphSvg('malaise', 13, '#d946ef');
    }
    const scrollIcons: Record<ScrollStat, string> = {
      brutality: 'ScrollBrutality',
      tactics: 'ScrollTactics',
      survival: 'ScrollSurvival',
    };
    (['brutality', 'tactics', 'survival'] as ScrollStat[]).forEach((stat) => {
      const slot = this.scrollSlotEls[stat];
      if (slot?.icon) {
        slot.icon.innerHTML = renderItemIconHtml(scrollIcons[stat], this.artPackMode, this.customPackResolver, {
          size: 16,
          fallbackKind: 'scroll',
          alt: stat,
        });
      }
    });
  }

  private createBossSplash(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'kc-boss-splash kc-hidden';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="kc-boss-letterbox kc-boss-letterbox-top"></div>
      <div class="kc-boss-splash-band">
        <div class="kc-boss-splash-epithet"></div>
        <div class="kc-boss-splash-title"></div>
        <div class="kc-boss-splash-slash">
          <span class="kc-boss-splash-slash-line"></span>
          <span class="kc-boss-splash-slash-gem"></span>
          <span class="kc-boss-splash-slash-line"></span>
        </div>
      </div>
      <div class="kc-boss-letterbox kc-boss-letterbox-bottom"></div>
    `;
    this.bossLetterTopEl = el.querySelector('.kc-boss-letterbox-top') as HTMLDivElement;
    this.bossLetterBotEl = el.querySelector('.kc-boss-letterbox-bottom') as HTMLDivElement;
    this.bossSplashBandEl = el.querySelector('.kc-boss-splash-band') as HTMLDivElement;
    this.bossSplashEpithetEl = el.querySelector('.kc-boss-splash-epithet') as HTMLDivElement;
    this.bossSplashTitleEl = el.querySelector('.kc-boss-splash-title') as HTMLDivElement;
    return el;
  }

  private createBossBanner(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'kc-boss-banner kc-hidden';
    el.innerHTML = `
      <div class="kc-boss-header">
        <div class="kc-boss-identity">
          <span class="kc-boss-title"></span>
          <span class="kc-boss-subtitle"></span>
        </div>
        <span class="kc-boss-phase"></span>
      </div>
      <div class="kc-boss-frame">
        <span class="kc-boss-cap is-left" aria-hidden="true"></span>
        <div class="kc-boss-bar-track">
          <div class="kc-boss-bar-trail"></div>
          <div class="kc-boss-bar-fill"></div>
          <div class="kc-boss-bar-ticks"></div>
          <div class="kc-boss-hp-text"></div>
        </div>
        <span class="kc-boss-cap is-right" aria-hidden="true"></span>
      </div>
    `;
    this.bossTitleEl = el.querySelector('.kc-boss-title') as HTMLSpanElement;
    this.bossSubEl = el.querySelector('.kc-boss-subtitle') as HTMLSpanElement;
    this.bossPhaseEl = el.querySelector('.kc-boss-phase') as HTMLSpanElement;
    this.bossTrailEl = el.querySelector('.kc-boss-bar-trail') as HTMLDivElement;
    this.bossFillEl = el.querySelector('.kc-boss-bar-fill') as HTMLDivElement;
    this.bossHpTextEl = el.querySelector('.kc-boss-hp-text') as HTMLDivElement;
    return el;
  }

  private buildTopRight(): void {
    // Frameless Biome title + glowing Boss Cell pips
    const biomeRow = document.createElement('div');
    biomeRow.className = 'kc-biome-header';
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

    // Translucent Minimap mount directly underneath
    this.trContainer.appendChild(this.minimapHost);

    // Razor-sharp translucent Resource Strip (Cells, Gold, Timer) with pixel icons
    const resBar = document.createElement('div');
    resBar.className = 'kc-resource-bar';
    resBar.innerHTML = `
      <span class="kc-res-item kc-res-cells" aria-label="Cells"><span class="kc-res-icon" data-icon="cells"></span><span data-el="cells">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-gold" aria-label="Gold"><span class="kc-res-icon" data-icon="gold"></span><span data-el="gold">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-timer" aria-label="Run Timer"><span class="kc-res-icon" data-icon="timer"></span><span data-el="timer">00:00</span></span>
    `;
    this.cellsIconEl = resBar.querySelector('[data-icon="cells"]') as HTMLSpanElement;
    this.goldIconEl = resBar.querySelector('[data-icon="gold"]') as HTMLSpanElement;
    this.timerIconEl = resBar.querySelector('[data-icon="timer"]') as HTMLSpanElement;
    this.goldEl = resBar.querySelector('[data-el="gold"]') as HTMLSpanElement;
    this.cellsEl = resBar.querySelector('[data-el="cells"]') as HTMLSpanElement;
    this.timerEl = resBar.querySelector('[data-el="timer"]') as HTMLSpanElement;
    this.trContainer.appendChild(resBar);

    // Kill Streak + Curse Counter row
    const badgesRow = document.createElement('div');
    badgesRow.className = 'kc-tr-badges';
    this.streakEl = document.createElement('div');
    this.streakEl.className = 'kc-streak-badge kc-hidden';
    this.curseEl = document.createElement('div');
    this.curseEl.className = 'kc-curse-banner kc-hidden';
    badgesRow.append(this.streakEl, this.curseEl);
    this.trContainer.appendChild(badgesRow);
  }

  private buildBottomLeft(): void {
    const cluster = document.createElement('div');
    cluster.className = 'kc-bl-cluster';

    // Far-left: Sculpted Glass Health Flask Vessel (clicking drinks!)
    this.flaskWidgetEl = document.createElement('button');
    this.flaskWidgetEl.type = 'button';
    this.flaskWidgetEl.className = 'kc-flask-widget';
    this.flaskWidgetEl.setAttribute('aria-label', 'Drink Health Flask');
    this.flaskWidgetEl.innerHTML = `
      <div class="kc-flask-vessel">
        <div class="kc-flask-stopper"></div>
        <div class="kc-flask-neck"></div>
        <div class="kc-flask-body">
          <div class="kc-flask-liquid">
            <span class="kc-flask-meniscus"></span>
          </div>
          <div class="kc-flask-glint"></div>
        </div>
      </div>
      <div class="kc-flask-pips"></div>
      <span class="kc-flask-key kc-keycap">R</span>
    `;
    this.flaskWidgetEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onPlayUiClick?.('select');
      this.callbacks.onTriggerHeal?.();
    });
    this.flaskLiquidEl = this.flaskWidgetEl.querySelector('.kc-flask-liquid') as HTMLDivElement;
    this.flaskPipsEl = this.flaskWidgetEl.querySelector('.kc-flask-pips') as HTMLDivElement;
    this.flaskKeyEl = this.flaskWidgetEl.querySelector('.kc-flask-key') as HTMLSpanElement;

    // Right column extending from Flask collar: Status Chips + 5BC Malaise + HP Bar + Gear/Amulet Slots + Scrolls/Mutations
    const mainCol = document.createElement('div');
    mainCol.className = 'kc-bl-main';

    // Floating status chips right above HP/Malaise bar
    this.hpStatusEl = document.createElement('div');
    this.hpStatusEl.className = 'kc-hp-status-tags';
    mainCol.appendChild(this.hpStatusEl);

    // 5BC Segmented Crimson-Violet Malaise Gauge (shown only at bossStemCells >= 5)
    this.malaiseWrapEl = document.createElement('div');
    this.malaiseWrapEl.className = 'kc-malaise-wrap kc-hidden';
    this.malaiseWrapEl.innerHTML = `
      <span class="kc-malaise-icon"></span>
      <div class="kc-malaise-track">
        ${Array.from({ length: 10 }, () => '<span class="kc-malaise-seg"></span>').join('')}
      </div>
      <span class="kc-malaise-text">MALAISE 0%</span>
    `;
    this.malaiseIconEl = this.malaiseWrapEl.querySelector('.kc-malaise-icon') as HTMLSpanElement;
    this.malaiseSegEls = Array.from(this.malaiseWrapEl.querySelectorAll('.kc-malaise-seg'));
    this.malaiseTextEl = this.malaiseWrapEl.querySelector('.kc-malaise-text') as HTMLSpanElement;
    mainCol.appendChild(this.malaiseWrapEl);

    // Beveled Crimson HP + Glowing Orange Rally + Translucent Temp Overheal Shield Bar
    const hpWrap = document.createElement('div');
    hpWrap.className = 'kc-hp-block';
    hpWrap.innerHTML = `
      <div class="kc-hp-track">
        <div class="kc-hp-rally"></div>
        <div class="kc-hp-fill"></div>
        <div class="kc-hp-shield"></div>
        <span class="kc-hp-numbers">100 / 100</span>
      </div>
    `;
    this.hpTextEl = hpWrap.querySelector('.kc-hp-numbers') as HTMLSpanElement;
    this.hpRallyEl = hpWrap.querySelector('.kc-hp-rally') as HTMLDivElement;
    this.hpFillEl = hpWrap.querySelector('.kc-hp-fill') as HTMLDivElement;
    this.hpShieldEl = hpWrap.querySelector('.kc-hp-shield') as HTMLDivElement;
    mainCol.appendChild(hpWrap);

    // Gear Bar (4 Weapon/Skill slots + Amulet slot) + Diamond Scroll Medallions & Mutations
    const loadoutRow = document.createElement('div');
    loadoutRow.className = 'kc-loadout-row';

    const gearGroup = document.createElement('div');
    gearGroup.className = 'kc-gear-group';
    for (let i = 0; i < 4; i++) {
      if (i === 2) {
        const sep = document.createElement('span');
        sep.className = 'kc-gear-divider';
        gearGroup.appendChild(sep);
      }
      const slot = document.createElement('div');
      slot.className = 'kc-gear-slot is-empty';
      slot.tabIndex = 0;
      this.bindSlotTooltipEvents(slot, i);
      gearGroup.appendChild(slot);
      this.gearSlotEls.push(slot);
    }

    // Amulet slot (index 4)
    const amuSep = document.createElement('span');
    amuSep.className = 'kc-gear-divider';
    gearGroup.appendChild(amuSep);

    this.amuletSlotEl = document.createElement('div');
    this.amuletSlotEl.className = 'kc-gear-slot kc-amulet-slot is-empty';
    this.amuletSlotEl.tabIndex = 0;
    this.bindSlotTooltipEvents(this.amuletSlotEl, 4);
    gearGroup.appendChild(this.amuletSlotEl);

    // Scrolls & Mutations stacked beside gear bar
    const statsSide = document.createElement('div');
    statsSide.className = 'kc-stats-side';

    const scrollsBar = document.createElement('div');
    scrollsBar.className = 'kc-scrolls-bar';
    const stats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of stats) {
      const med = document.createElement('div');
      med.className = `kc-scroll-medallion kc-color-${stat}`;
      med.innerHTML = `
        <span class="kc-scroll-diamond"><span class="kc-scroll-icon"></span></span>
        <span class="kc-scroll-count">1</span>
      `;
      this.scrollSlotEls[stat] = {
        wrap: med,
        icon: med.querySelector('.kc-scroll-icon') as HTMLSpanElement,
        count: med.querySelector('.kc-scroll-count') as HTMLSpanElement,
      };
      scrollsBar.appendChild(med);
    }

    const mutsBar = document.createElement('div');
    mutsBar.className = 'kc-mutations-bar';
    for (let i = 0; i < 3; i++) {
      const mut = document.createElement('div');
      mut.className = 'kc-mut-slot';
      mutsBar.appendChild(mut);
      this.mutationEls.push(mut);
    }

    statsSide.append(scrollsBar, mutsBar);
    loadoutRow.append(gearGroup, statsSide);
    mainCol.appendChild(loadoutRow);

    cluster.append(this.flaskWidgetEl, mainCol);
    this.blContainer.appendChild(cluster);
  }

  private bindSlotTooltipEvents(slotEl: HTMLDivElement, slotIndex: number): void {
    const show = (): void => {
      this.hoveredSlotIndex = slotIndex;
      this.lastTooltipSig = '';
      if (this.lastState && this.visible) {
        this.renderSlotTooltip(slotIndex, this.lastState, this.lastBindings);
      }
    };
    const hide = (): void => {
      if (this.hoveredSlotIndex === slotIndex) {
        this.hideSlotTooltip();
      }
    };
    slotEl.addEventListener('mouseenter', show);
    slotEl.addEventListener('focus', show);
    slotEl.addEventListener('mouseleave', hide);
    slotEl.addEventListener('blur', hide);
  }

  private hideSlotTooltip(): void {
    this.hoveredSlotIndex = null;
    this.lastTooltipSig = '';
    this.slotTooltipEl.classList.add('kc-hidden');
  }

  private renderSlotTooltip(slotIndex: number, state: SimState, bindings: KeyBindings): void {
    const p = state.player;
    const mode = this.lastInputSnapshot?.mode ?? 'keyboard';
    const glyphFamily = this.lastInputSnapshot?.glyphFamily ?? 'keyboard';

    const buildHint = (action: GlyphAction | null, kbFallback: string): { text: string; html: string } => {
      if (!action) {
        return { text: kbFallback, html: `[${escapeHtml(kbFallback)}]` };
      }
      if (mode === 'gamepad') {
        const g = getActionGlyph(action, glyphFamily, bindings, this.layoutPreset);
        const cls = resolveBadgeClasses(action, glyphFamily, g.styleClass, g.label);
        return {
          text: `gp:${glyphFamily}:${this.layoutPreset}:${g.label}`,
          html: `<span class="kc-gp-badge ${cls}">${escapeHtml(g.label)}</span>`,
        };
      }
      if (mode === 'touch') {
        return { text: '', html: '' };
      }
      return { text: kbFallback, html: `<span class="kc-tt-key-inline">[${escapeHtml(kbFallback)}]</span>` };
    };

    const slotDefs: Array<{
      gear: GearInstance | null;
      slotLabel: string;
      hint: { text: string; html: string };
    }> = [
      {
        gear: p.loadout.weapon1,
        slotLabel: 'Weapon Slot 1',
        hint: buildHint('weapon1', `LMB / ${formatKeyCode(bindings.weapon1)}`),
      },
      {
        gear: p.loadout.weapon2,
        slotLabel: 'Weapon Slot 2',
        hint: buildHint('weapon2', `RMB / ${formatKeyCode(bindings.weapon2)}`),
      },
      {
        gear: p.loadout.skill1,
        slotLabel: 'Skill Slot 1',
        hint: buildHint('skill1', formatKeyCode(bindings.skill1)),
      },
      {
        gear: p.loadout.skill2,
        slotLabel: 'Skill Slot 2',
        hint: buildHint('skill2', formatKeyCode(bindings.skill2)),
      },
      {
        gear: p.loadout.amulet,
        slotLabel: 'Amulet Slot',
        hint: buildHint(null, 'PASSIVE'),
      },
    ];

    const slot = slotDefs[slotIndex];
    const anchorEl = slotIndex === 4 ? this.amuletSlotEl : this.gearSlotEls[slotIndex];
    if (!slot || !anchorEl) {
      this.hideSlotTooltip();
      return;
    }

    const g = slot.gear;
    const sig = g
      ? `i${slotIndex}:${g.uid}:${g.level}:${g.quality}:${g.color}:${g.affixes.join('.')}:${JSON.stringify(g.bonusScrolls ?? {})}:${p.scrolls.brutality}/${p.scrolls.tactics}/${p.scrolls.survival}:${p.loadout.weapon1?.uid ?? 0}:${p.loadout.weapon2?.uid ?? 0}:${p.loadout.skill1?.uid ?? 0}:${p.loadout.skill2?.uid ?? 0}:${p.loadout.amulet?.uid ?? 0}:${p.mutations.join(',')}:${this.artPackMode}:${mode}:${glyphFamily}:${slot.hint.text}`
      : `i${slotIndex}:empty:${slot.hint.text}:${mode}:${glyphFamily}`;

    this.slotTooltipEl.classList.remove('kc-hidden');

    if (sig !== this.lastTooltipSig) {
      this.lastTooltipSig = sig;
      if (!g) {
        const bindSuffix = slot.hint.html
          ? ` · Bind: ${mode === 'gamepad' ? slot.hint.html : `<span class="kc-keycap">${escapeHtml(slot.hint.text)}</span>`}`
          : '';
        this.slotTooltipEl.innerHTML = `
          <div class="kc-tt-empty">
            <div class="kc-tt-empty-title">${escapeHtml(slot.slotLabel)}</div>
            <div class="kc-tt-empty-sub">Empty${bindSuffix}</div>
          </div>
          <span class="kc-tt-arrow" aria-hidden="true"></span>
        `;
      } else {
        this.slotTooltipEl.innerHTML = `
          ${this.renderGearCardBodyHtml(g, state, { slotLabel: slot.slotLabel, keyHintHtml: slot.hint.html })}
          <span class="kc-tt-arrow" aria-hidden="true"></span>
        `;
      }
    }

    // Position anchored directly above the hovered/focused slot, clamped cleanly inside stage
    const stageRect = this.hudRoot.getBoundingClientRect();
    const slotRect = anchorEl.getBoundingClientRect();
    if (stageRect.width > 0 && slotRect.width > 0) {
      const tipRect = this.slotTooltipEl.getBoundingClientRect();
      const tipW = tipRect.width || 276;
      const slotCenterX = slotRect.left - stageRect.left + slotRect.width * 0.5;
      const rawLeft = slotCenterX - tipW * 0.5;
      const clampedLeft = Math.max(12, Math.min(stageRect.width - tipW - 12, rawLeft));
      const bottomPx = Math.max(82, stageRect.bottom - slotRect.top + 12);
      const arrowX = Math.max(16, Math.min(tipW - 16, slotCenterX - clampedLeft));

      this.slotTooltipEl.style.left = `${clampedLeft.toFixed(1)}px`;
      this.slotTooltipEl.style.bottom = `${bottomPx.toFixed(1)}px`;
      this.slotTooltipEl.style.setProperty('--tt-arrow-x', `${arrowX.toFixed(1)}px`);
    }
  }

  private renderDualColorBarHtml(colors: ScrollStat[], quality: GearQuality): string {
    if (quality === 'L' || colors.length === 0) {
      return '<div class="kc-color-bar is-colorless"></div>';
    }
    if (colors.length === 1) {
      return `<div class="kc-color-bar is-single kc-bar-${colors[0]}"></div>`;
    }
    return `
      <div class="kc-color-bar is-dual">
        <span class="kc-bar-half kc-bar-${colors[0]}"></span>
        <span class="kc-bar-half kc-bar-${colors[1]}"></span>
      </div>
    `;
  }

  private renderBonusScrollsHtml(bonusScrolls: Array<{ stat: ScrollStat; amount: number }>): string {
    if (bonusScrolls.length === 0) return '';
    const statNames: Record<ScrollStat, string> = {
      brutality: 'Brutality',
      tactics: 'Tactics',
      survival: 'Survival',
    };
    const pills = bonusScrolls
      .map(
        ({ stat, amount }) =>
          `<span class="kc-bonus-scroll-pill kc-color-${stat}"><span class="kc-bonus-scroll-pip"></span>+${amount} ${statNames[stat]}</span>`
      )
      .join('');
    return `<div class="kc-bonus-scrolls-row">${pills}</div>`;
  }

  private renderAffixesListHtml(gear: GearInstance, state: SimState): string {
    const analyzed = analyzeGearAffixes(gear, state, this.catalog);
    if (analyzed.length === 0) {
      return '<div class="kc-tt-no-affix">Standard forged gear</div>';
    }
    const rows = analyzed
      .map((af) => {
        const cls = af.isActiveSynergy
          ? 'kc-affix-item is-synergy'
          : af.isStar
            ? 'kc-affix-item is-star'
            : 'kc-affix-item';
        const prefix = af.isStar || af.isActiveSynergy ? '<span class="kc-affix-star">★</span>' : '<span class="kc-affix-dot">·</span>';
        const tag = af.isActiveSynergy ? '<span class="kc-synergy-tag">SYNERGY</span>' : '';
        return `<li class="${cls}">${prefix}<span class="kc-affix-text">${escapeHtml(af.label)}</span>${tag}</li>`;
      })
      .join('');
    return `<ul class="kc-affix-list kc-dc-affix-list">${rows}</ul>`;
  }

  private renderGearCardBodyHtml(
    gear: GearInstance,
    state: SimState,
    opts?: { slotLabel?: string; keyHint?: string; keyHintHtml?: string }
  ): string {
    const info = getGearDisplayInfo(gear, this.catalog);
    const summary = computeGearDpsSummary(gear, state, this.catalog);
    const badge = formatGearBadge(gear.level, gear.quality);
    const qClass = getQualityCssClass(gear.quality);
    const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
    const iconHtml = renderItemIconHtml(gear.defId, this.artPackMode, this.customPackResolver, {
      size: 36,
      fallbackKind: gear.slotKind === 'amulet' ? 'amulet' : undefined,
      alt: info.name,
    });

    // Primary DPS / Crit / Skill / Shield stat strip
    const statChips: string[] = [];
    if (summary.isAmulet) {
      if (summary.blockDrPct !== null && summary.blockDrPct > 0) {
        statChips.push(`<span class="kc-stat-dps">DR <strong>-${summary.blockDrPct}%</strong></span>`);
      } else {
        statChips.push('<span class="kc-stat-dps">PASSIVE <strong>AMULET</strong></span>');
      }
    } else if (summary.isSkill) {
      if (summary.dps > 0) {
        statChips.push(`<span class="kc-stat-dps">DMG <strong>${summary.dps}</strong></span>`);
      }
      if (summary.cooldownSec !== null) {
        statChips.push(`<span class="kc-stat-cd">CD <strong>${summary.cooldownSec.toFixed(1)}s</strong></span>`);
      }
    } else if (summary.isShield) {
      statChips.push(`<span class="kc-stat-dps">PARRY <strong>${summary.dps}</strong></span>`);
      if (summary.critDps !== null) {
        statChips.push(`<span class="kc-stat-crit">CRIT <strong>${summary.critDps}</strong></span>`);
      }
      if (summary.blockDrPct !== null) {
        statChips.push(`<span class="kc-stat-cd">BLOCK <strong>${summary.blockDrPct}%</strong></span>`);
      }
    } else {
      statChips.push(`<span class="kc-stat-dps">DPS <strong>${summary.dps}</strong></span>`);
      if (summary.critDps !== null) {
        statChips.push(`<span class="kc-stat-crit">CRIT <strong>${summary.critDps}</strong></span>`);
      }
    }

    const critLineHtml = summary.critConditionLabel
      ? `<div class="kc-crit-cond-line">${escapeHtml(summary.critConditionLabel)}</div>`
      : '';
    const passiveLineHtml = summary.parryPassiveLabel
      ? `<div class="kc-passive-line">${escapeHtml(summary.parryPassiveLabel)}</div>`
      : '';
    const bonusScrollsHtml = this.renderBonusScrollsHtml(summary.bonusScrolls);
    const affixesHtml = this.renderAffixesListHtml(gear, state);
    const colorBarHtml = this.renderDualColorBarHtml(summary.colors, gear.quality);

    return `
      <div class="kc-dc-card-inner ${colorClass}">
        ${colorBarHtml}
        <div class="kc-loot-head">
          <div class="kc-loot-icon-box ${colorClass}">${iconHtml}</div>
          <div class="kc-loot-head-text">
            <div class="kc-loot-title-row">
              <span class="kc-loot-name">${escapeHtml(info.name)}</span>
              <span class="kc-gear-badge ${qClass} ${gear.quality === 'L' ? 'is-legendary' : ''}" style="position:static">${escapeHtml(badge)}</span>
            </div>
            <div class="kc-loot-meta">
              <span>${escapeHtml(summary.colors.length > 0 ? summary.colors.map((c) => c.toUpperCase()).join(' / ') : 'COLORLESS')}</span>
              <span>·</span>
              <span>${escapeHtml(info.glyph)}</span>
              ${
                opts?.keyHintHtml
                  ? `<span>·</span>${opts.keyHintHtml}`
                  : opts?.keyHint
                    ? `<span>·</span><span class="kc-tt-key-inline">[${escapeHtml(opts.keyHint)}]</span>`
                    : ''
              }
            </div>
          </div>
        </div>
        <div class="kc-stat-bar">${statChips.join('<span class="kc-stat-sep">|</span>')}</div>
        ${critLineHtml}
        ${passiveLineHtml}
        ${bonusScrollsHtml}
        <div class="kc-loot-desc">${escapeHtml(info.description)}</div>
        ${affixesHtml}
      </div>
    `;
  }

  private getBiomeKillStreakTarget(biomeId: BiomeId): number {
    const def = this.catalog?.getBiome?.(biomeId);
    if (def) return def.killStreakDoorTarget;
    if (biomeId === 'PrisonStart') return 30;
    if (biomeId === 'Bridge' || biomeId === 'TopClockTower' || biomeId === 'Throne' || biomeId === 'Passage') {
      return 0;
    }
    return 60;
  }

  private updateTopRight(state: SimState): void {
    this.biomeNameEl.textContent = getBiomeDisplayName(state.activeBiomeId, this.catalog);

    const pips = this.bcPipsEl.children;
    for (let i = 0; i < pips.length; i++) {
      pips[i]!.classList.toggle('is-active', i < state.bossStemCells);
    }
    this.bcPipsEl.setAttribute('aria-label', `Boss Stem Cells: ${state.bossStemCells}BC`);

    this.goldEl.textContent = String(Math.floor(state.player.gold));
    this.cellsEl.textContent = String(Math.floor(state.player.cells));
    this.timerEl.textContent = formatTimer(state.player.runTimerTicks);

    // Track per-biome Kill-Streak state, milestone celebration & break shake
    const biomeId = state.activeBiomeId;
    const target = this.getBiomeKillStreakTarget(biomeId);
    const streak = state.player.killStreak;

    if (biomeId !== this.lastBiomeIdForStreak) {
      this.lastBiomeIdForStreak = biomeId;
      this.hasEnteredCombat = streak > 0;
      this.prevStreakValue = streak;
      this.streakBreakTimerSec = 0;
      this.streakMilestoneTimerSec = 0;
      this.lastStreakSig = '';
    } else {
      if (state.runKills === 0 && streak === 0 && state.tick < 15) {
        this.hasEnteredCombat = false;
      }
      if (streak > 0 || state.runKills > 0 || state.player.hp < state.player.maxHp) {
        this.hasEnteredCombat = true;
      }
      if (this.prevStreakValue > 0 && streak === 0) {
        this.streakBreakTimerSec = 0.45;
        this.streakMilestoneTimerSec = 0;
        this.lastStreakSig = '';
      } else if (target > 0 && this.prevStreakValue < target && streak >= target) {
        this.streakMilestoneTimerSec = 1.25;
        this.lastStreakSig = '';
      }
      this.prevStreakValue = streak;
    }

    const isBroken = this.streakBreakTimerSec > 0;
    const isMilestoneFlash = this.streakMilestoneTimerSec > 0;
    const showStreak = streak > 0 || isBroken || (this.hasEnteredCombat && target > 0);
    const hitTarget = target > 0 ? streak >= target : streak >= 30;
    const streakSig = `${showStreak}:${streak}:${target}:${isBroken}:${isMilestoneFlash}:${hitTarget}`;

    if (streakSig !== this.lastStreakSig) {
      this.lastStreakSig = streakSig;
      if (!showStreak) {
        this.streakEl.classList.add('kc-hidden');
      } else {
        this.streakEl.classList.remove('kc-hidden');
        const isDimmed = streak === 0 && !isBroken;
        this.streakEl.classList.toggle('is-dimmed', isDimmed);
        this.streakEl.classList.toggle('is-broken', isBroken);
        this.streakEl.classList.toggle('is-tier1', !isBroken && hitTarget && (target > 0 ? target < 60 : streak < 60));
        this.streakEl.classList.toggle('is-tier2', !isBroken && ((target >= 60 && streak >= target) || streak >= 60));
        this.streakEl.classList.toggle('is-milestone-flash', isMilestoneFlash && !isBroken);

        const iconKind: IconFallbackKind = isBroken ? 'crackedSkull' : hitTarget ? 'crown' : 'skull';
        const iconAccent = isBroken
          ? '#ff4757'
          : hitTarget
            ? '#fde047'
            : isDimmed
              ? '#64748b'
              : '#cbd5e1';
        const iconHtml = renderUiGlyphSvg(iconKind, 14, iconAccent);
        const countText = target > 0 ? `${streak}<span class="kc-streak-target">/${target}</span>` : `${streak}`;
        const badgeLabel = isBroken
          ? 'BROKEN'
          : hitTarget
            ? 'DOOR OPEN'
            : target > 0
              ? 'NO-HIT'
              : 'STREAK';
        this.streakEl.innerHTML = `${iconHtml}<span class="kc-streak-num">${countText}</span><span class="kc-streak-tag">${badgeLabel}</span>`;
      }
    }

    // Crimson Curse Skull Counter + Organic Pulsing Crimson Curse Screen Vignette
    const curseLeft = state.player.curseKillsLeft;
    this.curseVignetteEl.classList.toggle('is-active', curseLeft > 0);
    if (curseLeft !== this.lastCurseRendered) {
      this.lastCurseRendered = curseLeft;
      if (curseLeft > 0) {
        this.curseEl.classList.remove('kc-hidden');
        const skullHtml = renderItemIconHtml('Skull', this.artPackMode, this.customPackResolver, {
          size: 18,
          fallbackKind: 'skull',
          alt: 'Curse',
        });
        this.curseEl.innerHTML = `${skullHtml}<span class="kc-curse-count">${curseLeft}</span><span class="kc-curse-label">CURSED</span>`;
      } else {
        this.curseEl.classList.add('kc-hidden');
      }
    }
  }

  private updateBottomLeft(state: SimState, bindings: KeyBindings): void {
    const p = state.player;
    const maxHp = Math.max(1, p.maxHp);
    const hpPct = Math.max(0, Math.min(100, (p.hp / maxHp) * 100));
    const rallyPct = Math.max(hpPct, Math.min(100, ((p.hp + p.rallyHp) / maxHp) * 100));
    const tempShield = Math.max(0, p.tempShieldHp ?? 0);

    if (tempShield > 0) {
      this.hpTextEl.innerHTML = `${Math.max(0, Math.ceil(p.hp))} / ${Math.ceil(maxHp)} <span class="kc-hp-shield-num">+${Math.ceil(tempShield)}</span>`;
      const shieldWidthPct = Math.max(4, Math.min(100, (tempShield / maxHp) * 100));
      const shieldLeftPct = Math.max(0, Math.min(100 - shieldWidthPct, hpPct));
      this.hpShieldEl.style.left = `${shieldLeftPct.toFixed(2)}%`;
      this.hpShieldEl.style.width = `${shieldWidthPct.toFixed(2)}%`;
      this.hpShieldEl.classList.add('is-active');
    } else {
      this.hpTextEl.textContent = `${Math.max(0, Math.ceil(p.hp))} / ${Math.ceil(maxHp)}`;
      this.hpShieldEl.style.width = '0%';
      this.hpShieldEl.classList.remove('is-active');
    }

    this.hpFillEl.style.width = `${hpPct.toFixed(2)}%`;
    this.hpFillEl.classList.toggle('is-cursed', p.curseKillsLeft > 0);
    this.hpRallyEl.style.width = `${rallyPct.toFixed(2)}%`;

    // 5BC Segmented Malaise Bar right above HP bar
    const showMalaise = state.bossStemCells >= 5;
    this.malaiseWrapEl.classList.toggle('kc-hidden', !showMalaise);
    if (showMalaise) {
      const malaise = Math.max(0, Math.min(100, p.malaise ?? 0));
      const filledSegs = Math.floor(malaise / 10);
      const partialFrac = (malaise % 10) / 10;
      for (let i = 0; i < this.malaiseSegEls.length; i++) {
        const seg = this.malaiseSegEls[i]!;
        const isFull = i < filledSegs;
        const isPartial = i === filledSegs && partialFrac > 0.05;
        seg.classList.toggle('is-full', isFull);
        seg.classList.toggle('is-partial', isPartial);
        seg.style.setProperty('--seg-fill', isFull ? '100%' : isPartial ? `${Math.round(partialFrac * 100)}%` : '0%');
      }
      this.malaiseWrapEl.classList.toggle('is-danger', malaise >= 60);
      this.malaiseTextEl.textContent = `MALAISE ${Math.round(malaise)}%`;
    }

    // Active status chips above HP bar
    const chipKeys: string[] = [];
    const chipHtml: string[] = [];
    if (p.godMode) {
      chipKeys.push('god');
      chipHtml.push('<span class="kc-status-pill is-cyan">GOD</span>');
    }
    if (tempShield > 0) {
      chipKeys.push(`shd${Math.ceil(tempShield)}`);
      chipHtml.push(`<span class="kc-status-pill is-overheal">SHIELD +${Math.ceil(tempShield)}</span>`);
    }
    if (p.shieldBlocking) {
      chipKeys.push('block');
      chipHtml.push('<span class="kc-status-pill is-shield">GUARD</span>');
    }
    if (p.curseKillsLeft > 0) {
      chipKeys.push(`cur${p.curseKillsLeft}`);
      chipHtml.push(`<span class="kc-status-pill is-curse">CURSE ${p.curseKillsLeft}</span>`);
    }
    if (p.speedBuffTicks > 0) {
      chipKeys.push('spd');
      chipHtml.push('<span class="kc-status-pill is-speed">SPEED</span>');
    }
    if ((p.phaserBuffTicks ?? 0) > 0) {
      chipKeys.push('phs');
      chipHtml.push('<span class="kc-status-pill is-cyan">EMPOWERED</span>');
    }
    if ((p.vengeanceTicks ?? 0) > 0) {
      chipKeys.push('vng');
      chipHtml.push('<span class="kc-status-pill is-curse">VENGEANCE</span>');
    }
    if ((p.stealthTicks ?? 0) > 0) {
      chipKeys.push('stl');
      chipHtml.push('<span class="kc-status-pill is-corrupted">STEALTH</span>');
    }
    for (const st of p.statusEffects) {
      if (st.ticksLeft > 0 && chipHtml.length < 6) {
        chipKeys.push(st.kind);
        const cls =
          st.kind === 'shield'
            ? 'is-shield'
            : st.kind === 'corrupted'
              ? 'is-corrupted'
              : st.kind === 'speed'
                ? 'is-speed'
                : '';
        chipHtml.push(`<span class="kc-status-pill ${cls}">${escapeHtml(st.kind.toUpperCase())}</span>`);
      }
    }
    const statusSig = chipKeys.join('|');
    if (statusSig !== this.lastStatusSig) {
      this.lastStatusSig = statusSig;
      this.hpStatusEl.innerHTML = chipHtml.join('');
    }

    // Sculpted Glass Health Flask
    const mode = this.lastInputSnapshot?.mode ?? 'keyboard';
    const glyphFamily = this.lastInputSnapshot?.glyphFamily ?? 'keyboard';

    const maxFlask = Math.max(1, p.maxFlaskCharges);
    const flaskPct = Math.max(0, Math.min(100, (p.flaskCharges / maxFlask) * 100));
    this.flaskLiquidEl.style.height = `${flaskPct.toFixed(0)}%`;
    this.flaskWidgetEl.classList.toggle('is-empty', p.flaskCharges <= 0);
    this.flaskWidgetEl.classList.toggle('is-low-hp', p.flaskCharges > 0 && hpPct < 45);
    if (mode === 'gamepad') {
      const healGlyph = getActionGlyph('heal', glyphFamily, bindings, this.layoutPreset);
      const badgeCls = resolveBadgeClasses('heal', glyphFamily, healGlyph.styleClass, healGlyph.label);
      this.flaskKeyEl.className = `kc-flask-key kc-gp-badge ${badgeCls}`;
      this.flaskKeyEl.textContent = healGlyph.label;
    } else if (mode === 'touch') {
      this.flaskKeyEl.className = 'kc-flask-key kc-keycap kc-hidden';
      this.flaskKeyEl.textContent = '';
    } else {
      this.flaskKeyEl.className = 'kc-flask-key kc-keycap';
      this.flaskKeyEl.textContent = formatKeyCode(bindings.heal);
    }
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

    // Diamond Scroll Medallions
    const scrollStats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of scrollStats) {
      const count = p.scrolls[stat];
      const slot = this.scrollSlotEls[stat];
      slot.count.textContent = String(count);
      slot.wrap.setAttribute('aria-label', `${stat.toUpperCase()} ${count} (${getScrollDamagePct(count)}% Damage)`);
    }

    // Four Crisp Square Gear Slots + Amulet Slot (anchored hover/focus tooltip cards, ZERO native title=""!)
    const w1KeyLabel =
      bindings.weapon1 === DEFAULT_KEY_BINDINGS.weapon1 ? 'LMB' : formatKeyCode(bindings.weapon1);
    const w2KeyLabel =
      bindings.weapon2 === DEFAULT_KEY_BINDINGS.weapon2 ? 'RMB' : formatKeyCode(bindings.weapon2);

    const resolveSlotBadge = (
      action: 'weapon1' | 'weapon2' | 'skill1' | 'skill2',
      kbLabel: string
    ): { sigKey: string; html: string } => {
      if (mode === 'gamepad') {
        const g = getActionGlyph(action, glyphFamily, bindings, this.layoutPreset);
        const cls = resolveBadgeClasses(action, glyphFamily, g.styleClass, g.label);
        return {
          sigKey: `gp:${glyphFamily}:${this.layoutPreset}:${g.label}`,
          html: `<span class="kc-gear-key kc-gp-badge ${cls}">${escapeHtml(g.label)}</span>`,
        };
      }
      if (mode === 'touch') {
        return { sigKey: 'touch', html: '' };
      }
      return {
        sigKey: `kb:${kbLabel}`,
        html: `<span class="kc-gear-key">${escapeHtml(kbLabel)}</span>`,
      };
    };

    const slots: Array<{
      gear: GearInstance | null;
      badge: { sigKey: string; html: string };
      emptyTag: string;
    }> = [
      { gear: p.loadout.weapon1, badge: resolveSlotBadge('weapon1', w1KeyLabel), emptyTag: 'W1' },
      { gear: p.loadout.weapon2, badge: resolveSlotBadge('weapon2', w2KeyLabel), emptyTag: 'W2' },
      { gear: p.loadout.skill1, badge: resolveSlotBadge('skill1', formatKeyCode(bindings.skill1)), emptyTag: 'S1' },
      { gear: p.loadout.skill2, badge: resolveSlotBadge('skill2', formatKeyCode(bindings.skill2)), emptyTag: 'S2' },
    ];
    const amulet = p.loadout.amulet;

    const sig =
      slots
        .map((s) =>
          s.gear
            ? `${s.gear.uid}:${s.gear.defId}:${s.gear.level}:${s.gear.quality}:${s.gear.color}:${s.gear.ammo ?? -1}/${s.gear.maxAmmo ?? -1}:${Math.ceil(s.gear.cooldownTicks / 6)}:${s.badge.sigKey}`
            : `empty:${s.badge.sigKey}`
        )
        .join('|') +
      '||amu:' +
      (amulet ? `${amulet.uid}:${amulet.defId}:${amulet.level}:${amulet.quality}:${amulet.color}:${amulet.dmgReductionPct ?? 0}` : 'empty') +
      '||' +
      p.mutations.join(',') +
      '||' +
      this.artPackMode +
      '||' +
      mode +
      ':' +
      glyphFamily;

    if (sig !== this.lastLoadoutSignature) {
      this.lastLoadoutSignature = sig;
      for (let i = 0; i < 4; i++) {
        const el = this.gearSlotEls[i]!;
        const { gear, badge: keyBadge, emptyTag } = slots[i]!;
        const casting = this.slotFlashSec[i]! > 0;

        el.className = 'kc-gear-slot';
        el.removeAttribute('title');
        if (casting) el.classList.add('is-casting');

        if (!gear) {
          el.classList.add('is-empty');
          el.setAttribute('aria-label', `Empty ${emptyTag} Slot`);
          el.innerHTML = `
            <span class="kc-gear-empty-mark">${emptyTag}</span>
            ${keyBadge.html}
          `;
          continue;
        }

        const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
        el.classList.add(colorClass);
        const info = getGearDisplayInfo(gear, this.catalog);
        const badge = formatGearBadge(gear.level, gear.quality);
        const qClass = getQualityCssClass(gear.quality);
        const isLeg = gear.quality === 'L';
        const maxCd = Math.max(1, info.cooldownTicks || 300);
        const cdPct = gear.cooldownTicks > 0 ? Math.min(100, (gear.cooldownTicks / maxCd) * 100) : 0;
        const cdSec = (gear.cooldownTicks / SIM_HZ).toFixed(1);

        const iconHtml = renderItemIconHtml(gear.defId, this.artPackMode, this.customPackResolver, {
          size: 36,
          className: 'kc-gear-art',
          alt: info.name,
        });

        let ammoHtml = '';
        if (gear.maxAmmo !== undefined && gear.maxAmmo > 0) {
          const curAmmo = Math.max(0, gear.ammo ?? 0);
          if (gear.maxAmmo <= 6) {
            const pips = Array.from(
              { length: gear.maxAmmo },
              (_, idx) => `<span class="kc-ammo-pip ${idx < curAmmo ? 'is-loaded' : ''}"></span>`
            ).join('');
            ammoHtml = `<div class="kc-gear-ammo-pips" aria-label="Ammo ${curAmmo}/${gear.maxAmmo}">${pips}</div>`;
          } else {
            ammoHtml = `<span class="kc-gear-ammo">${curAmmo}/${gear.maxAmmo}</span>`;
          }
        }

        el.setAttribute('aria-label', `${info.name} ${badge}`);
        el.innerHTML = `
          <div class="kc-gear-icon-wrap">${iconHtml}</div>
          <span class="kc-gear-badge ${qClass} ${isLeg ? 'is-legendary' : ''}">${escapeHtml(badge)}</span>
          ${ammoHtml}
          ${keyBadge.html}
          ${
            gear.cooldownTicks > 0
              ? `<div class="kc-cd-overlay"><div class="kc-cd-curtain" style="height:${cdPct.toFixed(1)}%"></div><span class="kc-cd-text">${cdSec}s</span></div>`
              : ''
          }
        `;
      }

      // Render Amulet Slot (no native title="")
      const amuEl = this.amuletSlotEl;
      amuEl.className = 'kc-gear-slot kc-amulet-slot';
      amuEl.removeAttribute('title');
      if (!amulet) {
        amuEl.classList.add('is-empty');
        amuEl.setAttribute('aria-label', 'Empty Amulet Slot');
        amuEl.innerHTML = `
          <span class="kc-gear-empty-mark">AMU</span>
          <span class="kc-gear-key">AMU</span>
        `;
      } else {
        const amuColorClass = amulet.quality === 'L' ? 'kc-color-colorless' : `kc-color-${amulet.color}`;
        amuEl.classList.add(amuColorClass);
        const amuInfo = getGearDisplayInfo(amulet, this.catalog);
        const amuBadge = formatGearBadge(amulet.level, amulet.quality);
        const amuQClass = getQualityCssClass(amulet.quality);
        const amuIcon = renderItemIconHtml(amulet.defId, this.artPackMode, this.customPackResolver, {
          size: 32,
          fallbackKind: 'amulet',
          className: 'kc-gear-art',
          alt: amuInfo.name,
        });
        const drTag =
          amulet.dmgReductionPct && amulet.dmgReductionPct > 0
            ? `<span class="kc-gear-ammo">-${amulet.dmgReductionPct}%</span>`
            : '';
        amuEl.setAttribute('aria-label', `${amuInfo.name} ${amuBadge}`);
        amuEl.innerHTML = `
          <div class="kc-gear-icon-wrap">${amuIcon}</div>
          <span class="kc-gear-badge ${amuQClass} ${amulet.quality === 'L' ? 'is-legendary' : ''}">${escapeHtml(amuBadge)}</span>
          ${drTag}
          <span class="kc-gear-key">AMU</span>
        `;
      }

      // Mutation Badges (real pixel-art icons!)
      for (let i = 0; i < 3; i++) {
        const mutEl = this.mutationEls[i]!;
        const mutId = p.mutations[i];
        mutEl.className = 'kc-mut-slot';
        if (!mutId) {
          mutEl.innerHTML = '<span class="kc-mut-empty"></span>';
          mutEl.setAttribute('aria-label', `Empty Mutation Slot ${i + 1}`);
        } else {
          const m = getMutationDisplayInfo(mutId, this.catalog);
          mutEl.classList.add('is-filled', `kc-color-${m.color}`);
          mutEl.innerHTML = renderItemIconHtml(mutId, this.artPackMode, this.customPackResolver, {
            size: 22,
            fallbackKind: 'mutation',
            alt: m.name,
          });
          mutEl.setAttribute('aria-label', `${m.name}: ${m.description}`);
        }
      }
    }
  }

  private updateBossBar(state: SimState, dtSec: number): void {
    const arena = state.bossArenaState;
    if (!arena.active || arena.defeated) {
      this.bossBanner.classList.add('kc-hidden');
      this.bossSplashEl.classList.add('kc-hidden');
      this.lastBossUid = null;
      this.lastBossSplashBossId = null;
      this.wasBossArenaActive = false;
      return;
    }

    const boss = state.enemies.find(
      (e) => (arena.bossUid !== null && e.uid === arena.bossUid) || (e.isBoss && e.hp > 0)
    );
    if (!boss || boss.hp <= 0) {
      this.bossBanner.classList.add('kc-hidden');
      this.bossSplashEl.classList.add('kc-hidden');
      this.lastBossUid = null;
      this.lastBossSplashBossId = null;
      this.wasBossArenaActive = false;
      return;
    }

    if (!this.wasBossArenaActive) {
      this.wasBossArenaActive = true;
      this.clearToast();
    }

    const bossId: BossId = boss.bossId ?? arena.bossId ?? 'Behemoth';
    const info = getBossDisplayInfo(bossId, this.catalog);

    // 1. Cinematic Non-Blocking Boss Intro Splash Card driven by arena.bannerTicks
    if (arena.bannerTicks > 0) {
      if (this.lastBossSplashBossId !== bossId || arena.bannerTicks > this.bossIntroMaxTicks) {
        this.lastBossSplashBossId = bossId;
        this.bossIntroMaxTicks = Math.max(120, arena.bannerTicks);
        this.bossSplashEpithetEl.textContent = BOSS_SPLASH_EPITHETS[bossId] ?? info.subtitle.toUpperCase();
        this.bossSplashTitleEl.textContent = info.name.toUpperCase();
      }
      const p = 1 - arena.bannerTicks / Math.max(1, this.bossIntroMaxTicks);
      const fadeIn = Math.min(1, p / 0.14);
      const fadeOut = p > 0.74 ? Math.max(0, 1 - (p - 0.74) / 0.26) : 1;
      const alpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
      const letterSlide = Math.max(0, 1 - alpha);
      const scaleX = 0.92 + Math.min(1, p / 0.18) * 0.08 + (p > 0.74 ? (p - 0.74) * 0.16 : 0);
      const trackingEm = (0.14 + p * 0.07).toFixed(3);

      this.bossSplashEl.classList.remove('kc-hidden');
      this.bossSplashEl.style.opacity = alpha.toFixed(3);
      this.bossLetterTopEl.style.transform = `translateY(${(-letterSlide * 100).toFixed(1)}%)`;
      this.bossLetterBotEl.style.transform = `translateY(${(letterSlide * 100).toFixed(1)}%)`;
      this.bossSplashBandEl.style.transform = `scaleX(${scaleX.toFixed(3)})`;
      this.bossSplashTitleEl.style.letterSpacing = `${trackingEm}em`;
    } else {
      this.bossSplashEl.classList.add('kc-hidden');
    }

    // 2. Ornate Boss Health Bar with Trailing Yellow Burst-Damage Drain
    this.bossBanner.classList.remove('kc-hidden');
    const pct = Math.max(0, Math.min(100, (boss.hp / Math.max(1, boss.maxHp)) * 100));

    if (this.lastBossUid !== boss.uid) {
      this.lastBossUid = boss.uid;
      this.bossTrailPct = pct;
      this.bossTrailHoldSec = 0;
    } else if (pct > this.bossTrailPct) {
      this.bossTrailPct = pct;
    } else if (pct < this.bossTrailPct) {
      if (this.bossTrailHoldSec <= 0 && this.bossTrailPct - pct > 1.2) {
        this.bossTrailHoldSec = 0.16;
      }
      if (this.bossTrailHoldSec > 0) {
        this.bossTrailHoldSec = Math.max(0, this.bossTrailHoldSec - dtSec);
      } else {
        const dropRate = Math.max(22, (this.bossTrailPct - pct) * 2.8);
        this.bossTrailPct = Math.max(pct, this.bossTrailPct - dropRate * dtSec);
      }
    }

    this.bossTitleEl.textContent = info.name;
    this.bossSubEl.textContent = info.subtitle;
    this.bossPhaseEl.textContent = `PHASE ${formatRoman(Math.max(1, boss.bossPhase))}`;
    this.bossTrailEl.style.width = `${this.bossTrailPct.toFixed(2)}%`;
    this.bossFillEl.style.width = `${pct.toFixed(2)}%`;
    this.bossHpTextEl.textContent = `${Math.max(0, Math.ceil(boss.hp))} / ${Math.ceil(boss.maxHp)}`;
  }

  private updateNearbyLootAndPrompts(state: SimState, bindings: KeyBindings): void {
    const px = state.player.pos.x;
    const py = state.player.pos.y;

    const suppressOverlays =
      state.pendingScroll !== null ||
      state.runStatus === 'paused' ||
      (state.passageState.active && state.passageState.activeNpc !== 'none');

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

    // 2. Find nearest Merchant shrine (either directly nearby or matching active shop pickup)
    let activeMerchant: ShrineState | null = null;
    if (!suppressOverlays) {
      let bestMerchDist = 92;
      for (const s of state.shrines) {
        if (s.kind !== 'merchant') continue;
        const d = Math.hypot(s.pos.x - px, s.pos.y - py);
        const matchesPickupShop =
          nearestGear?.shopId !== undefined && s.shopId !== undefined && nearestGear.shopId === s.shopId;
        if (matchesPickupShop || d < bestMerchDist) {
          if (matchesPickupShop) {
            activeMerchant = s;
            break;
          }
          bestMerchDist = d;
          activeMerchant = s;
        }
      }
    }

    // 3. Find nearest unused Recycling Tube shrine
    let nearestTube: ShrineState | null = null;
    if (!suppressOverlays && !nearestGear) {
      let bestTubeDist = 54;
      for (const s of state.shrines) {
        if (s.kind !== 'recyclingTube' || s.used || !s.tubeLoadout) continue;
        const d = Math.hypot(s.pos.x - px, s.pos.y - py);
        if (d < bestTubeDist) {
          bestTubeDist = d;
          nearestTube = s;
        }
      }
    }
    this.activeNearbyTube = nearestTube;

    // 4. Render Merchant Bar whenever near a merchant stall
    const hasLootBelow = Boolean(nearestGear && nearestGear.gear && !suppressOverlays);
    if (activeMerchant) {
      if (this.lastMerchantShrineUid !== activeMerchant.uid) {
        this.lastMerchantShrineUid = activeMerchant.uid;
        this.selectedShopColorFilter = activeMerchant.colorFilter;
      }
      this.merchantBarEl.classList.remove('kc-hidden');
      this.merchantBarEl.classList.toggle('has-loot-below', hasLootBelow);
      const rerollCount = activeMerchant.rerollCount ?? 0;
      const cost = 250 * Math.pow(2, rerollCount);
      const canAfford = state.player.gold >= cost;
      const merchSig = `${activeMerchant.uid}:${rerollCount}:${cost}:${canAfford}:${this.selectedShopColorFilter ?? 'any'}:${activeMerchant.shopKind ?? 'weapon'}:${this.artPackMode}`;
      if (merchSig !== this.lastMerchantSig) {
        this.lastMerchantSig = merchSig;
        this.renderMerchantBar(activeMerchant, state, rerollCount, cost, canAfford);
      }
    } else {
      this.merchantBarEl.classList.add('kc-hidden');
      this.lastMerchantSig = '';
      this.lastMerchantShrineUid = null;
    }

    // 5. Render Ground Loot Comparison Card
    const inputMode = this.lastInputSnapshot?.mode ?? 'keyboard';
    const glyphFamily = this.lastInputSnapshot?.glyphFamily ?? 'keyboard';

    if (hasLootBelow && nearestGear && nearestGear.gear) {
      this.interactEl.classList.add('kc-hidden');
      this.tubeCardEl.classList.add('kc-hidden');
      this.lastTubeSig = '';

      const g = nearestGear.gear;
      const price = nearestGear.priceGold ?? 0;
      const canAfford = state.player.gold >= price;
      const canRecycle = state.metaSnapshot.recycleUnlocked && price === 0;
      const keyF = formatKeyCode(bindings.interact);
      const p = state.player;
      const sig = `${nearestGear.uid}:${g.level}:${g.quality}:${g.color}:${g.affixes.join('.')}:${price}:${canAfford}:${canRecycle}:${p.scrolls.brutality}/${p.scrolls.tactics}/${p.scrolls.survival}:${p.loadout.weapon1?.uid ?? 0}:${p.loadout.weapon2?.uid ?? 0}:${p.loadout.skill1?.uid ?? 0}:${p.loadout.skill2?.uid ?? 0}:${p.loadout.amulet?.uid ?? 0}:${keyF}:${this.artPackMode}:${inputMode}:${glyphFamily}`;

      this.lootCardEl.classList.remove('kc-hidden');
      if (sig !== this.lastLootSignature) {
        this.lastLootSignature = sig;
        this.renderLootComparisonCard(nearestGear, g, state, bindings, keyF, canAfford, canRecycle);
      }
      return;
    }

    this.lootCardEl.classList.add('kc-hidden');
    this.lastLootSignature = '';

    // 6. Render Recycling Tube 4-Slot Loadout Preview Card
    if (nearestTube && nearestTube.tubeLoadout) {
      this.interactEl.classList.add('kc-hidden');
      this.tubeCardEl.classList.remove('kc-hidden');
      const keyF = formatKeyCode(bindings.interact);
      const tl = nearestTube.tubeLoadout;
      const tubeSig = `${nearestTube.uid}:${tl.theme}:${tl.weapon1.uid}:${tl.weapon2.uid}:${tl.skill1.uid}:${tl.skill2.uid}:${keyF}:${this.artPackMode}:${inputMode}:${glyphFamily}`;
      if (tubeSig !== this.lastTubeSig) {
        this.lastTubeSig = tubeSig;
        this.renderRecyclingTubeCard(nearestTube, state, bindings, keyF);
      }
      return;
    }

    this.tubeCardEl.classList.add('kc-hidden');
    this.lastTubeSig = '';

    // 7. Otherwise show contextual interaction prompt
    if (suppressOverlays) {
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
    const sig = `${prompt.action}:${prompt.key}:${prompt.label}:${inputMode}:${glyphFamily}`;
    if (sig !== this.lastInteractSignature) {
      this.lastInteractSignature = sig;
      if (inputMode === 'gamepad') {
        const badgeHtml = renderControllerBadgeHtml(prompt.action, this.lastInputSnapshot, bindings, {
          layoutPreset: this.layoutPreset,
        });
        this.interactEl.innerHTML = `${badgeHtml}<span>${escapeHtml(prompt.label)}</span>`;
      } else if (inputMode === 'touch') {
        this.interactEl.innerHTML = `<span class="kc-touch-tap-hint">USE</span><span>${escapeHtml(prompt.label)}</span>`;
      } else {
        this.interactEl.innerHTML = `<span class="kc-keycap">${escapeHtml(prompt.key)}</span><span>${escapeHtml(prompt.label)}</span>`;
      }
      this.interactEl.onclick = prompt.onClick ?? null;
    }
  }

  private renderMerchantBar(
    shrine: ShrineState,
    state: SimState,
    rerollCount: number,
    cost: number,
    canAfford: boolean
  ): void {
    const shopKind = shrine.shopKind ?? 'weapon';
    const title =
      shopKind === 'skill'
        ? 'SKILL MERCHANT'
        : shopKind === 'food'
          ? 'GASTRONOMY MERCHANT'
          : 'WEAPON MERCHANT';
    const maxedOut = rerollCount >= MAX_SHOP_REROLLS;
    const shopIcon = renderUiGlyphSvg('shop', 16, '#fbbf24');
    const goldIcon = renderItemIconHtml('Gold', this.artPackMode, this.customPackResolver, {
      size: 13,
      fallbackKind: 'gold',
      alt: 'Gold',
    });

    const showCategories = shopKind !== 'food';
    const filters: Array<{ value: ScrollStat | 'any'; label: string; cls: string }> = [
      { value: 'any', label: 'Any', cls: '' },
      { value: 'brutality', label: 'Brutality', cls: 'kc-color-brutality' },
      { value: 'tactics', label: 'Tactics', cls: 'kc-color-tactics' },
      { value: 'survival', label: 'Survival', cls: 'kc-color-survival' },
    ];
    const filterPillsHtml = showCategories
      ? `<div class="kc-merchant-filters" role="group" aria-label="Merchandise Category">
          ${filters
            .map((f) => {
              const active =
                f.value === 'any'
                  ? this.selectedShopColorFilter === undefined
                  : this.selectedShopColorFilter === f.value;
              return `<button type="button" class="kc-merch-pill ${f.cls} ${active ? 'is-active' : ''}" data-merch-color="${f.value}">${f.label}</button>`;
            })
            .join('')}
        </div>`
      : '';

    this.merchantBarEl.innerHTML = `
      <div class="kc-merchant-head">
        <span class="kc-merchant-title">${shopIcon}<span>${escapeHtml(shrine.label || title)}</span></span>
        <span class="kc-merchant-count">Rerolls: <strong>${rerollCount}/${MAX_SHOP_REROLLS}</strong></span>
      </div>
      <div class="kc-merchant-controls">
        ${filterPillsHtml}
        <button
          type="button"
          class="kc-btn kc-btn-sm ${maxedOut || !canAfford ? '' : 'kc-btn-primary'} kc-btn-icon"
          data-act="shop-reroll"
          ${maxedOut || !canAfford ? 'disabled' : ''}
        >
          ${maxedOut ? '<span>Out of Stock (3/3)</span>' : `${goldIcon}<span>Restock / Reroll (${cost}G)</span>`}
        </button>
      </div>
    `;

    this.merchantBarEl.querySelectorAll<HTMLButtonElement>('[data-merch-color]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = btn.dataset.merchColor;
        this.selectedShopColorFilter =
          val === 'brutality' || val === 'tactics' || val === 'survival' ? val : undefined;
        this.callbacks.onPlayUiClick?.('select');
        this.lastMerchantSig = '';
        this.renderMerchantBar(shrine, state, rerollCount, cost, canAfford);
      });
    });

    this.merchantBarEl.querySelector('[data-act="shop-reroll"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (maxedOut) return;
      if (state.player.gold < cost) {
        this.callbacks.onPlayUiClick?.('error');
        this.showToast(`Need ${cost} Gold to restock`, 1.4);
        return;
      }
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({
        type: 'shopReroll',
        shrineUid: shrine.uid,
        preferredColor: showCategories ? this.selectedShopColorFilter : undefined,
      });
    });
  }

  private renderRecyclingTubeCard(
    shrine: ShrineState,
    state: SimState,
    bindings: KeyBindings,
    keyF: string
  ): void {
    const tl = shrine.tubeLoadout;
    if (!tl) return;
    const mode = this.lastInputSnapshot?.mode ?? 'keyboard';
    const theme = tl.theme;
    const themeLabel = `${theme.toUpperCase()} LOADOUT`;
    const tubeIcon = renderUiGlyphSvg(
      'tube',
      18,
      theme === 'brutality' ? '#e83b4a' : theme === 'tactics' ? '#a855f7' : '#22c55e'
    );

    const items: Array<{ label: string; gear: GearInstance }> = [
      { label: 'W1', gear: tl.weapon1 },
      { label: 'W2', gear: tl.weapon2 },
      { label: 'S1', gear: tl.skill1 },
      { label: 'S2', gear: tl.skill2 },
    ];

    const slotsHtml = items
      .map(({ label, gear }) => {
        const info = getGearDisplayInfo(gear, this.catalog);
        const summary = computeGearDpsSummary(gear, state, this.catalog);
        const badge = formatGearBadge(gear.level, gear.quality);
        const qClass = getQualityCssClass(gear.quality);
        const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
        const iconHtml = renderItemIconHtml(gear.defId, this.artPackMode, this.customPackResolver, {
          size: 32,
          alt: info.name,
        });
        const statText = summary.isSkill
          ? `DMG ${summary.dps}`
          : summary.isShield
            ? `PARRY ${summary.dps}`
            : `DPS ${summary.dps}`;

        return `
          <div class="kc-tube-slot ${colorClass}">
            <div class="kc-tube-slot-top">
              <span class="kc-tube-slot-tag">${label}</span>
              <span class="kc-gear-badge ${qClass}" style="position:static">${escapeHtml(badge)}</span>
            </div>
            <div class="kc-tube-icon-box ${colorClass}">${iconHtml}</div>
            <div class="kc-tube-item-name">${escapeHtml(info.name)}</div>
            <div class="kc-tube-item-stat">${statText}</div>
          </div>
        `;
      })
      .join('');

    const equipBtnContent =
      mode === 'gamepad'
        ? `${renderControllerBadgeHtml('interact', this.lastInputSnapshot, bindings, { extraClass: 'is-inline', layoutPreset: this.layoutPreset })}Equip Loadout`
        : mode === 'touch'
          ? 'Equip Loadout'
          : `[${escapeHtml(keyF)}] Equip Loadout`;

    this.tubeCardEl.innerHTML = `
      <div class="kc-tube-head">
        <div class="kc-tube-title-wrap">
          ${tubeIcon}
          <span class="kc-tube-title">RECYCLING TUBE</span>
          <span class="kc-tube-theme-pill kc-color-${theme}">${escapeHtml(themeLabel)}</span>
        </div>
        <span class="kc-tube-hint">Replaces all 4 gear slots</span>
      </div>
      <div class="kc-tube-grid">${slotsHtml}</div>
      <div class="kc-tube-actions">
        <button type="button" class="kc-btn kc-btn-sm kc-btn-primary" data-act="pick-tube">
          ${equipBtnContent}
        </button>
      </div>
    `;

    this.tubeCardEl.querySelector('[data-act="pick-tube"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({
        type: 'pickRecyclingTube',
        shrineUid: shrine.uid,
      });
    });
  }

  private updateShopPriceTags(state: SimState, interpAlpha: number): void {
    const hideTags =
      state.runStatus !== 'playing' ||
      state.pendingScroll !== null;

    if (hideTags) {
      for (const el of this.priceTagEls.values()) {
        el.classList.add('kc-hidden');
      }
      return;
    }

    const activeUids = new Set<number>();
    const drawRect = computeCanvasDrawRect(this.canvas);
    const stageRect = this.hudRoot.getBoundingClientRect();
    const zoom = state.camera.zoom > 0.05 ? state.camera.zoom : 1;
    const topLeft = resolveCameraTopLeft(state.camera, state.player.pos, this.cameraOriginMode, interpAlpha);
    const scaleX = drawRect.width / VIEWPORT_W;
    const scaleY = drawRect.height / VIEWPORT_H;
    const originX = drawRect.left - stageRect.left;
    const originY = drawRect.top - stageRect.top;

    for (const pk of state.pickups) {
      if (pk.collected || !pk.priceGold || pk.priceGold <= 0) continue;
      activeUids.add(pk.uid);

      let el = this.priceTagEls.get(pk.uid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'kc-world-price-tag';
        el.innerHTML = `${renderUiGlyphSvg('gold', 11, '#fbbf24')}<span class="kc-world-price-val"></span>`;
        this.priceTagLayer.appendChild(el);
        this.priceTagEls.set(pk.uid, el);
      }

      const pkX = pk.prevPos.x + (pk.pos.x - pk.prevPos.x) * interpAlpha;
      const pkY = pk.prevPos.y + (pk.pos.y - pk.prevPos.y) * interpAlpha;
      const lx = (pkX - topLeft.x) * zoom;
      const ly = (pkY - 26 - topLeft.y) * zoom;
      const visibleOnScreen = lx >= -24 && lx <= VIEWPORT_W + 24 && ly >= -20 && ly <= VIEWPORT_H + 20;
      el.classList.toggle('kc-hidden', !visibleOnScreen);
      if (!visibleOnScreen) continue;

      const affordable = state.player.gold >= pk.priceGold;
      el.classList.toggle('is-unaffordable', !affordable);
      const valEl = el.querySelector('.kc-world-price-val');
      if (valEl) {
        const txt = `${pk.priceGold}G`;
        if (valEl.textContent !== txt) valEl.textContent = txt;
      }

      const px = originX + lx * scaleX;
      const py = originY + ly * scaleY;
      el.style.left = `${px.toFixed(1)}px`;
      el.style.top = `${py.toFixed(1)}px`;
    }

    for (const [uid, el] of this.priceTagEls) {
      if (!activeUids.has(uid)) {
        el.remove();
        this.priceTagEls.delete(uid);
      }
    }
  }

  private renderLootComparisonCard(
    pickup: PickupState,
    gear: GearInstance,
    state: SimState,
    bindings: KeyBindings,
    keyF: string,
    canAfford: boolean,
    canRecycle: boolean
  ): void {
    const mode = this.lastInputSnapshot?.mode ?? 'keyboard';
    const groundSummary = computeGearDpsSummary(gear, state, this.catalog);
    const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;

    const formatDelta = (delta: number, unit: string, isCrit = false): string => {
      const cls = isCrit ? 'kc-dps-delta is-crit-delta' : 'kc-dps-delta';
      if (delta > 0) {
        return `<span class="${cls} is-up">+${delta} ${unit} ▲</span>`;
      }
      if (delta < 0) {
        return `<span class="${cls} is-down">${delta} ${unit} ▼</span>`;
      }
      return `<span class="${cls} is-flat">= 0 ${unit}</span>`;
    };

    const renderEquippedRow = (label: string, eq: GearInstance | null): string => {
      const unitLabel = groundSummary.isSkill ? 'DMG' : groundSummary.isShield ? 'PARRY' : 'DPS';
      if (!eq) {
        return `
          <div class="kc-loot-cmp-row is-empty">
            <div>
              <div class="kc-loot-cmp-slot">${label}</div>
              <div class="kc-loot-cmp-name">Empty Slot</div>
            </div>
            <div class="kc-loot-delta-stack">
              ${groundSummary.dps > 0 ? formatDelta(groundSummary.dps, unitLabel) : ''}
              ${groundSummary.critDps !== null ? formatDelta(groundSummary.critDps, 'CRIT', true) : ''}
            </div>
          </div>
        `;
      }
      const ei = getGearDisplayInfo(eq, this.catalog);
      const eqSummary = computeGearDpsSummary(eq, state, this.catalog);
      const diff = groundSummary.dps - eqSummary.dps;
      const eqColor = eq.quality === 'L' ? 'kc-color-colorless' : `kc-color-${eq.color}`;
      const eqIcon = renderItemIconHtml(eq.defId, this.artPackMode, this.customPackResolver, {
        size: 24,
        fallbackKind: eq.slotKind === 'amulet' ? 'amulet' : undefined,
        alt: ei.name,
      });

      let deltaStackHtml = '';
      if (gear.slotKind === 'amulet') {
        const drDiff = (groundSummary.blockDrPct ?? 0) - (eqSummary.blockDrPct ?? 0);
        deltaStackHtml = formatDelta(drDiff, '% DR');
      } else {
        const critDeltaHtml =
          groundSummary.critDps !== null || eqSummary.critDps !== null
            ? formatDelta((groundSummary.critDps ?? 0) - (eqSummary.critDps ?? 0), 'CRIT', true)
            : '';
        deltaStackHtml = `${formatDelta(diff, unitLabel)}${critDeltaHtml}`;
      }

      const subText =
        gear.slotKind === 'amulet'
          ? `${label} · DR -${eqSummary.blockDrPct ?? 0}%`
          : `${label} · ${eqSummary.isSkill ? 'DMG' : 'DPS'} ${eqSummary.dps}${eqSummary.critDps !== null ? ` · CRIT ${eqSummary.critDps}` : ''}`;

      return `
        <div class="kc-loot-cmp-row">
          <div class="kc-loot-mini-icon ${eqColor}">${eqIcon}</div>
          <div class="kc-loot-cmp-info">
            <div class="kc-loot-cmp-name">${escapeHtml(ei.name)} <span class="kc-loot-cmp-tier">${escapeHtml(formatGearBadge(eq.level, eq.quality))}</span></div>
            <div class="kc-loot-cmp-sub">${subText}</div>
          </div>
          <div class="kc-loot-delta-stack">${deltaStackHtml}</div>
        </div>
      `;
    };

    const comparisonRowsHtml =
      gear.slotKind === 'amulet'
        ? renderEquippedRow('Amulet', state.player.loadout.amulet)
        : `
            ${renderEquippedRow(
              gear.slotKind === 'skill' ? 'Skill 1' : 'Weapon 1',
              gear.slotKind === 'skill' ? state.player.loadout.skill1 : state.player.loadout.weapon1
            )}
            ${renderEquippedRow(
              gear.slotKind === 'skill' ? 'Skill 2' : 'Weapon 2',
              gear.slotKind === 'skill' ? state.player.loadout.skill2 : state.player.loadout.weapon2
            )}
          `;

    const price = pickup.priceGold ?? 0;
    const goldIconHtml = renderItemIconHtml('Gold', this.artPackMode, this.customPackResolver, {
      size: 14,
      fallbackKind: 'gold',
      alt: 'Gold',
    });

    const equip1Text = gear.slotKind === 'amulet' ? 'Equip Amulet' : 'Equip Slot 1';
    const equip1Label =
      mode === 'gamepad'
        ? `${renderControllerBadgeHtml('interact', this.lastInputSnapshot, bindings, { extraClass: 'is-inline', layoutPreset: this.layoutPreset })}${equip1Text}`
        : mode === 'touch'
          ? equip1Text
          : `[${escapeHtml(keyF)}] ${equip1Text}`;
    const equip2Label =
      mode === 'gamepad'
        ? `${renderControllerBadgeHtml('equip2', this.lastInputSnapshot, bindings, { extraClass: 'is-inline', layoutPreset: this.layoutPreset })}Equip Slot 2`
        : mode === 'touch'
          ? 'Equip Slot 2'
          : '[G] Equip Slot 2';
    const recycleLabel =
      mode === 'gamepad'
        ? `${renderControllerBadgeHtml('recycle', this.lastInputSnapshot, bindings, { extraClass: 'is-inline', layoutPreset: this.layoutPreset })}Recycle`
        : mode === 'touch'
          ? 'Recycle'
          : '[X] Recycle';

    this.lootCardEl.innerHTML = `
      <div class="kc-loot-grid">
        <div class="kc-loot-col kc-loot-ground ${colorClass}">
          ${this.renderGearCardBodyHtml(gear, state)}
        </div>
        <div class="kc-loot-col kc-loot-equipped">
          <div class="kc-loot-cmp-title">EQUIPPED COMPARISON</div>
          ${comparisonRowsHtml}
        </div>
      </div>
      <div class="kc-loot-actions">
        ${
          price > 0
            ? `<span class="kc-price-tag ${canAfford ? '' : 'is-unaffordable'}">${goldIconHtml}<span>${price} Gold${canAfford ? '' : ' (Insufficient)'}</span></span>`
            : ''
        }
        <button class="kc-btn kc-btn-sm kc-btn-primary" data-loot-act="equip1" ${canAfford ? '' : 'disabled'}>${equip1Label}</button>
        ${
          gear.slotKind !== 'amulet'
            ? `<button class="kc-btn kc-btn-sm" data-loot-act="equip2" ${canAfford ? '' : 'disabled'}>${equip2Label}</button>`
            : ''
        }
        ${
          canRecycle
            ? `<button class="kc-btn kc-btn-sm kc-btn-emerald" data-loot-act="recycle">${recycleLabel}</button>`
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
  ): { action: 'interact' | 'map'; key: string; label: string; onClick?: () => void } | null {
    const keyF = formatKeyCode(bindings.interact);
    const keyTab = formatKeyCode(bindings.map);

    for (const c of state.chests) {
      if (c.opened) continue;
      if (Math.hypot(c.pos.x - px, c.pos.y - py) < 44) {
        const label =
          c.kind === 'cursed'
            ? 'Open Cursed Chest (10-Kill Curse)'
            : c.kind === 'boss'
              ? 'Open Boss Chest'
              : 'Open Treasure Chest';
        return { action: 'interact', key: keyF, label };
      }
    }

    for (const s of state.shrines) {
      if (Math.hypot(s.pos.x - px, s.pos.y - py) < 46) {
        if (s.kind === 'merchant' || s.kind === 'recyclingTube') {
          continue; // Handled by dedicated Merchant Bar & Recycling Tube Card!
        }
        if (s.kind === 'collector') {
          return {
            action: 'interact',
            key: keyF,
            label: 'Talk to The Collector',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'collector' }),
          };
        }
        if (s.kind === 'guillain') {
          return {
            action: 'interact',
            key: keyF,
            label: 'Talk to Guillain (Mutations)',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'guillain' }),
          };
        }
        if (s.kind === 'forge') {
          return {
            action: 'interact',
            key: keyF,
            label: 'Use Minor Forge',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'forge' }),
          };
        }
        if (s.kind === 'fountain' && !s.used) {
          return {
            action: 'interact',
            key: keyF,
            label: 'Drink Health Fountain',
            onClick: () => this.callbacks.onDispatchCommand({ type: 'useFountain' }),
          };
        }
        if (!s.used) {
          return { action: 'interact', key: keyF, label: s.label || 'Activate Shrine' };
        }
      }
    }

    for (const d of state.doors) {
      if (d.broken) continue;
      const cx = d.pos.x + d.width * 0.5;
      const cy = d.pos.y + d.height * 0.5;
      if (Math.hypot(cx - px, cy - py) < 48) {
        if (d.kind === 'biomeExit') {
          const dest = d.targetBiomeId ? getBiomeDisplayName(d.targetBiomeId, this.catalog) : 'The Passage';
          return {
            action: 'interact',
            key: keyF,
            label: d.label || `Enter ${dest}`,
            onClick: d.targetBiomeId
              ? () => this.callbacks.onDispatchCommand({ type: 'enterBiome', biomeId: d.targetBiomeId! })
              : undefined,
          };
        }
        if (d.kind === 'timed' || d.kind === 'killStreak') {
          return { action: 'interact', key: keyF, label: d.label || 'Open Reward Door' };
        }
      }
    }

    for (const tp of state.teleporters) {
      if (Math.hypot(tp.pos.x - px, tp.pos.y - py) < 44) {
        return {
          action: 'map',
          key: keyTab,
          label: `Teleportation Rune (${tp.label}) — Open Map`,
          onClick: () => this.callbacks.onToggleMinimap?.(),
        };
      }
    }

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
        return { action: 'interact', key: keyF, label };
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
    simUid: number | null = null,
    opts?: {
      awayFromX?: number;
      vx?: number;
      vy?: number;
      gravity?: number;
      punchScale?: boolean;
      staggerVertical?: boolean;
    }
  ): void {
    if (this.floaters.length >= MAX_FLOATERS) {
      const oldest = this.floaters.shift();
      oldest?.el.remove();
    }
    const el = document.createElement('div');
    el.className = className;
    if (className.includes('is-crit') && !text.includes('CRIT')) {
      el.innerHTML = `<span class="kc-crit-super">CRIT</span>${escapeHtml(text)}`;
    } else {
      el.textContent = text;
    }
    el.style.color = color;
    this.floatLayer.appendChild(el);

    const id = this.nextFloaterId++;
    const jitter = ((id * 37) % 19) - 9;
    let spawnX = opts?.staggerVertical ? worldX : worldX + jitter * 0.45;
    let spawnY = worldY;

    if (opts?.staggerVertical) {
      for (let step = 0; step < 6; step++) {
        const collides = this.floaters.some(
          (f) =>
            f.ttl > f.maxTtl - 0.45 &&
            Math.abs(f.worldX - spawnX) < 26 &&
            Math.abs(f.worldY - spawnY) < 13
        );
        if (!collides) break;
        spawnY -= 13;
      }
    }

    let vx = opts?.vx;
    if (vx === undefined) {
      if (opts?.awayFromX !== undefined) {
        const dir = worldX >= opts.awayFromX ? 1 : -1;
        vx = dir * (22 + ((id * 17) % 16));
      } else {
        vx = opts?.staggerVertical ? 0 : jitter * 1.8;
      }
    }

    this.floaters.push({
      id,
      simUid,
      worldX: spawnX,
      worldY: spawnY,
      vx,
      vy: opts?.vy ?? -68,
      gravity: opts?.gravity ?? 140,
      punchScale: opts?.punchScale ?? false,
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
      f.vy += f.gravity * dtSec;

      const lx = (f.worldX - topLeft.x) * zoom;
      const ly = (f.worldY - topLeft.y) * zoom;
      const px = originX + lx * scaleX;
      const py = originY + ly * scaleY;

      const elapsed = f.maxTtl - f.ttl;
      const t = elapsed / Math.max(0.01, f.maxTtl);
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      let popScale = 1.0;
      if (f.punchScale) {
        // 120ms elastic punch scale (1.5 -> 1.0)
        if (elapsed < 0.12) {
          const p = elapsed / 0.12;
          popScale = 1.5 - (1 - Math.pow(1 - p, 2)) * 0.5;
        } else {
          popScale = 1.0;
        }
      } else if (elapsed < 0.08) {
        const p = elapsed / 0.08;
        popScale = 0.8 + p * 0.25;
      }

      f.el.style.left = `${px.toFixed(1)}px`;
      f.el.style.top = `${py.toFixed(1)}px`;
      f.el.style.opacity = alpha.toFixed(2);
      f.el.style.transform = `translate(-50%, -50%) scale(${popScale.toFixed(2)})`;
    }
  }
}
