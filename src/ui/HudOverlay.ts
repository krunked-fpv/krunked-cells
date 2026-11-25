// =============================================================================
// KRUNKED CELLS — Dead Cells-Grade Pixel-Crisp Gothic HUD Overlay
// Zero Unicode emojis, zero truncated slot labels, real pixel-art icons
// (Custom Pack cardIcons.png / Built-In pixel art + crisp pixel-SVG fallback),
// sculpted Glass Health Flask, beveled HP+Rally bar, smooth trailing Boss Bar,
// Loot Comparison Card with pixel icons & DPS delta, and floating combat text.
// =============================================================================

import { getItemIconUrl } from '../assets/ItemIcons';
import {
  AffixDef,
  ArtPackMode,
  BiomeDef,
  BiomeId,
  BossDef,
  BossId,
  CustomPackAssetResolver,
  DEFAULT_KEY_BINDINGS,
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
  | 'rune';

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
  private artPackMode: ArtPackMode = 'builtin';
  private customPackResolver: CustomPackAssetResolver | null = null;

  // Persistent DOM containers
  private floatLayer: HTMLDivElement;
  private bossBanner: HTMLDivElement;
  private toastBanner: HTMLDivElement;
  private trContainer: HTMLDivElement;
  private minimapHost: HTMLDivElement;
  private blContainer: HTMLDivElement;
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
  private hpTextEl!: HTMLSpanElement;
  private hpStatusEl!: HTMLDivElement;
  private hpRallyEl!: HTMLDivElement;
  private hpFillEl!: HTMLDivElement;
  private gearSlotEls: HTMLDivElement[] = [];
  private scrollSlotEls: Record<
    ScrollStat,
    { icon: HTMLSpanElement; count: HTMLSpanElement; wrap: HTMLDivElement }
  > = {} as Record<ScrollStat, { icon: HTMLSpanElement; count: HTMLSpanElement; wrap: HTMLDivElement }>;
  private mutationEls: HTMLDivElement[] = [];

  // Dynamic cached regions (Boss Bar + smooth damage-drain trail)
  private bossTitleEl!: HTMLSpanElement;
  private bossSubEl!: HTMLSpanElement;
  private bossPhaseEl!: HTMLSpanElement;
  private bossTrailEl!: HTMLDivElement;
  private bossFillEl!: HTMLDivElement;
  private bossHpTextEl!: HTMLDivElement;
  private lastBossUid: number | null = null;
  private bossTrailPct = 100;
  private bossTrailHoldSec = 0;

  // Active-cast golden flash timers per slot [W1, W2, S1, S2]
  private slotFlashSec: [number, number, number, number] = [0, 0, 0, 0];

  private floaters: FloatingTextItem[] = [];
  private seenParticleUids = new Set<number>();
  private nextFloaterId = 1;
  private toastTimer = 0;

  private lastLootSignature = '';
  private lastInteractSignature = '';
  private lastLoadoutSignature = '';
  private lastCurseRendered = -1;
  private lastStreakRendered = -1;
  private lastStatusSig = '';
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

    this.refreshStaticIcons();
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
    this.lastStreakRendered = -1;
    this.refreshStaticIcons();
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
              ev.y - 24,
              ev.reflected ? 'PARRY! REFLECT!' : 'PARRY!',
              'kc-float-num is-parry',
              '#fff3b0',
              1.05
            );
          } else if (ev.type === 'shieldBlock') {
            this.spawnFloater(
              ev.x,
              ev.y - 20,
              `BLOCK -${Math.max(1, Math.round(ev.reducedDamage))}`,
              'kc-float-num is-status',
              '#93c5fd',
              0.8
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
        case 'flaskEmpty':
          this.spawnFloater(
            ev.x,
            ev.y - 20,
            ev.reason === 'fullHp' ? 'FULL HP' : 'FLASK EMPTY',
            'kc-float-num is-status',
            ev.reason === 'fullHp' ? '#86efac' : '#f87171',
            0.8
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
          this.showToast(`CURSED — SLAY ${ev.killsRequired} ENEMIES UNTOUCHED`, 3.2);
          break;
        case 'curseCleared':
          this.showToast('CURSE LIFTED', 2.2);
          break;
        case 'biomeTransition':
          // Boss arenas already announce themselves via the ornate top-center Boss Banner!
          if (ev.to !== 'Bridge' && ev.to !== 'TopClockTower' && ev.to !== 'Throne') {
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

    // Decay active-cast golden flashes
    for (let i = 0; i < 4; i++) {
      if (this.slotFlashSec[i]! > 0) {
        this.slotFlashSec[i] = Math.max(0, this.slotFlashSec[i]! - dtSec);
      }
      this.gearSlotEls[i]?.classList.toggle('is-casting', this.slotFlashSec[i]! > 0);
    }

    this.updateTopRight(state);
    this.updateBottomLeft(state, bindings);
    this.updateBossBar(state, dtSec);
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
      <span class="kc-res-item kc-res-cells" title="Cells"><span class="kc-res-icon" data-icon="cells"></span><span data-el="cells">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-gold" title="Gold"><span class="kc-res-icon" data-icon="gold"></span><span data-el="gold">0</span></span>
      <span class="kc-res-sep"></span>
      <span class="kc-res-item kc-res-timer" title="Run Timer"><span class="kc-res-icon" data-icon="timer"></span><span data-el="timer">00:00</span></span>
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
    this.flaskWidgetEl.title = 'Health Flask — Click or press [R] to drink (Restores 60% Max HP)';
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

    // Right column extending from Flask collar: Status Chips + HP Bar + Gear Slots + Scrolls/Mutations
    const mainCol = document.createElement('div');
    mainCol.className = 'kc-bl-main';

    // Floating status chips right above HP bar
    this.hpStatusEl = document.createElement('div');
    this.hpStatusEl.className = 'kc-hp-status-tags';
    mainCol.appendChild(this.hpStatusEl);

    // Beveled Crimson HP + Glowing Orange Rally Bar
    const hpWrap = document.createElement('div');
    hpWrap.className = 'kc-hp-block';
    hpWrap.innerHTML = `
      <div class="kc-hp-track">
        <div class="kc-hp-rally"></div>
        <div class="kc-hp-fill"></div>
        <span class="kc-hp-numbers">100 / 100</span>
      </div>
    `;
    this.hpTextEl = hpWrap.querySelector('.kc-hp-numbers') as HTMLSpanElement;
    this.hpRallyEl = hpWrap.querySelector('.kc-hp-rally') as HTMLDivElement;
    this.hpFillEl = hpWrap.querySelector('.kc-hp-fill') as HTMLDivElement;
    mainCol.appendChild(hpWrap);

    // Gear Bar + Diamond Scroll Medallions & Mutations
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
      gearGroup.appendChild(slot);
      this.gearSlotEls.push(slot);
    }

    // Scrolls & Mutations stacked beside gear bar
    const statsSide = document.createElement('div');
    statsSide.className = 'kc-stats-side';

    const scrollsBar = document.createElement('div');
    scrollsBar.className = 'kc-scrolls-bar';
    const stats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of stats) {
      const med = document.createElement('div');
      med.className = `kc-scroll-medallion kc-color-${stat}`;
      med.title = `${stat.toUpperCase()} Scrolls (100% DMG)`;
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
      mut.title = `Empty Mutation Slot ${i + 1}`;
      mutsBar.appendChild(mut);
      this.mutationEls.push(mut);
    }

    statsSide.append(scrollsBar, mutsBar);
    loadoutRow.append(gearGroup, statsSide);
    mainCol.appendChild(loadoutRow);

    cluster.append(this.flaskWidgetEl, mainCol);
    this.blContainer.appendChild(cluster);
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

    // Kill Streak Counter (glows gold at 30+, radiant at 60+)
    const streak = state.player.killStreak;
    if (streak !== this.lastStreakRendered) {
      this.lastStreakRendered = streak;
      if (streak > 0) {
        this.streakEl.classList.remove('kc-hidden');
        this.streakEl.classList.toggle('is-tier1', streak >= 30 && streak < 60);
        this.streakEl.classList.toggle('is-tier2', streak >= 60);
        const iconHtml = renderUiGlyphSvg(
          streak >= 30 ? 'crown' : 'skull',
          14,
          streak >= 60 ? '#fde047' : streak >= 30 ? '#fbbf24' : '#cbd5e1'
        );
        const badgeLabel = streak >= 60 ? '60+ NO-HIT' : streak >= 30 ? '30+ DOOR' : 'STREAK';
        this.streakEl.innerHTML = `${iconHtml}<span class="kc-streak-num">${streak}</span><span class="kc-streak-tag">${badgeLabel}</span>`;
      } else {
        this.streakEl.classList.add('kc-hidden');
      }
    }

    // Crimson Curse Skull Counter
    const curseLeft = state.player.curseKillsLeft;
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

    this.hpTextEl.textContent = `${Math.max(0, Math.ceil(p.hp))} / ${Math.ceil(maxHp)}`;
    this.hpFillEl.style.width = `${hpPct.toFixed(2)}%`;
    this.hpFillEl.classList.toggle('is-cursed', p.curseKillsLeft > 0);
    this.hpRallyEl.style.width = `${rallyPct.toFixed(2)}%`;

    // Active status chips above HP bar
    const chipKeys: string[] = [];
    const chipHtml: string[] = [];
    if (p.godMode) {
      chipKeys.push('god');
      chipHtml.push('<span class="kc-status-pill is-cyan">GOD</span>');
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
    for (const st of p.statusEffects) {
      if (st.ticksLeft > 0 && chipHtml.length < 5) {
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
    const maxFlask = Math.max(1, p.maxFlaskCharges);
    const flaskPct = Math.max(0, Math.min(100, (p.flaskCharges / maxFlask) * 100));
    this.flaskLiquidEl.style.height = `${flaskPct.toFixed(0)}%`;
    this.flaskWidgetEl.classList.toggle('is-empty', p.flaskCharges <= 0);
    this.flaskWidgetEl.classList.toggle('is-low-hp', p.flaskCharges > 0 && hpPct < 45);
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

    // Diamond Scroll Medallions
    const scrollStats: ScrollStat[] = ['brutality', 'tactics', 'survival'];
    for (const stat of scrollStats) {
      const count = p.scrolls[stat];
      const slot = this.scrollSlotEls[stat];
      slot.count.textContent = String(count);
      slot.wrap.title = `${stat.toUpperCase()} ${count} (${getScrollDamagePct(count)}% Damage)`;
    }

    // Four Crisp Square Gear Slots (Weapon 1, Weapon 2, Skill 1, Skill 2) — ZERO truncated names!
    const w1KeyLabel =
      bindings.weapon1 === DEFAULT_KEY_BINDINGS.weapon1 ? 'LMB' : formatKeyCode(bindings.weapon1);
    const w2KeyLabel =
      bindings.weapon2 === DEFAULT_KEY_BINDINGS.weapon2 ? 'RMB' : formatKeyCode(bindings.weapon2);

    const slots: Array<{ gear: GearInstance | null; keyLabel: string; keyHint: string; emptyTag: string }> = [
      { gear: p.loadout.weapon1, keyLabel: w1KeyLabel, keyHint: `LMB / ${formatKeyCode(bindings.weapon1)}`, emptyTag: 'W1' },
      { gear: p.loadout.weapon2, keyLabel: w2KeyLabel, keyHint: `RMB / ${formatKeyCode(bindings.weapon2)}`, emptyTag: 'W2' },
      { gear: p.loadout.skill1, keyLabel: formatKeyCode(bindings.skill1), keyHint: formatKeyCode(bindings.skill1), emptyTag: 'S1' },
      { gear: p.loadout.skill2, keyLabel: formatKeyCode(bindings.skill2), keyHint: formatKeyCode(bindings.skill2), emptyTag: 'S2' },
    ];

    const sig =
      slots
        .map((s) =>
          s.gear
            ? `${s.gear.uid}:${s.gear.defId}:${s.gear.level}:${s.gear.quality}:${s.gear.color}:${s.gear.ammo ?? -1}/${s.gear.maxAmmo ?? -1}:${Math.ceil(s.gear.cooldownTicks / 6)}:${s.keyLabel}`
            : `empty:${s.keyLabel}`
        )
        .join('|') +
      '||' +
      p.mutations.join(',') +
      '||' +
      this.artPackMode;

    if (sig !== this.lastLoadoutSignature) {
      this.lastLoadoutSignature = sig;
      for (let i = 0; i < 4; i++) {
        const el = this.gearSlotEls[i]!;
        const { gear, keyLabel, keyHint, emptyTag } = slots[i]!;
        const casting = this.slotFlashSec[i]! > 0;

        el.className = 'kc-gear-slot';
        if (casting) el.classList.add('is-casting');

        if (!gear) {
          el.classList.add('is-empty');
          el.title = `Empty ${emptyTag} Slot [${keyHint}]`;
          el.innerHTML = `
            <span class="kc-gear-empty-mark">${emptyTag}</span>
            <span class="kc-gear-key">${escapeHtml(keyLabel)}</span>
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

        const affixSummary =
          gear.affixes.length > 0
            ? `\nAffixes: ${gear.affixes.map((a) => getAffixDisplayLabel(a, this.catalog)).join(', ')}`
            : '';
        el.title = `${info.name} (${badge}) [${keyHint}]\n${info.description}${affixSummary}`;

        el.innerHTML = `
          <div class="kc-gear-icon-wrap">${iconHtml}</div>
          <span class="kc-gear-badge ${isLeg ? 'is-legendary' : ''}">${escapeHtml(badge)}</span>
          ${ammoHtml}
          <span class="kc-gear-key">${escapeHtml(keyLabel)}</span>
          ${
            gear.cooldownTicks > 0
              ? `<div class="kc-cd-overlay"><div class="kc-cd-curtain" style="height:${cdPct.toFixed(1)}%"></div><span class="kc-cd-text">${cdSec}s</span></div>`
              : ''
          }
        `;
      }

      // Mutation Badges (real pixel-art icons!)
      for (let i = 0; i < 3; i++) {
        const mutEl = this.mutationEls[i]!;
        const mutId = p.mutations[i];
        mutEl.className = 'kc-mut-slot';
        if (!mutId) {
          mutEl.innerHTML = '<span class="kc-mut-empty"></span>';
          mutEl.title = `Empty Mutation Slot ${i + 1}`;
        } else {
          const m = getMutationDisplayInfo(mutId, this.catalog);
          mutEl.classList.add('is-filled', `kc-color-${m.color}`);
          mutEl.innerHTML = renderItemIconHtml(mutId, this.artPackMode, this.customPackResolver, {
            size: 22,
            fallbackKind: 'mutation',
            alt: m.name,
          });
          mutEl.title = `${m.name}: ${m.description}`;
        }
      }
    }
  }

  private updateBossBar(state: SimState, dtSec: number): void {
    const arena = state.bossArenaState;
    if (!arena.active || arena.defeated) {
      this.bossBanner.classList.add('kc-hidden');
      this.lastBossUid = null;
      return;
    }

    const boss = state.enemies.find(
      (e) => (arena.bossUid !== null && e.uid === arena.bossUid) || (e.isBoss && e.hp > 0)
    );
    if (!boss || boss.hp <= 0) {
      this.bossBanner.classList.add('kc-hidden');
      this.lastBossUid = null;
      return;
    }

    this.bossBanner.classList.remove('kc-hidden');
    const info = boss.bossId
      ? getBossDisplayInfo(boss.bossId, this.catalog)
      : { name: boss.name, subtitle: 'Guardian' };
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
      const sig = `${nearestGear.uid}:${g.level}:${g.quality}:${price}:${canAfford}:${canRecycle}:${state.player.loadout.weapon1?.uid ?? 0}:${state.player.loadout.weapon2?.uid ?? 0}:${state.player.loadout.skill1?.uid ?? 0}:${state.player.loadout.skill2?.uid ?? 0}:${keyF}:${this.artPackMode}`;

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

    const groundIconHtml = renderItemIconHtml(gear.defId, this.artPackMode, this.customPackResolver, {
      size: 38,
      alt: info.name,
    });

    const slot1 = gear.slotKind === 'skill' ? state.player.loadout.skill1 : state.player.loadout.weapon1;
    const slot2 = gear.slotKind === 'skill' ? state.player.loadout.skill2 : state.player.loadout.weapon2;

    const renderEquippedRow = (label: string, eq: GearInstance | null): string => {
      if (!eq) {
        return `
          <div class="kc-loot-cmp-row is-empty">
            <span class="kc-loot-cmp-slot">${label}</span>
            <span class="kc-loot-cmp-name">Empty Slot</span>
            ${pwr > 0 ? `<span class="kc-dps-delta is-up">▲ +${pwr}</span>` : ''}
          </div>
        `;
      }
      const ei = getGearDisplayInfo(eq, this.catalog);
      const ep = estimateGearPower(eq, state, this.catalog);
      const diff = pwr - ep;
      const eqColor = eq.quality === 'L' ? 'kc-color-colorless' : `kc-color-${eq.color}`;
      const eqIcon = renderItemIconHtml(eq.defId, this.artPackMode, this.customPackResolver, {
        size: 24,
        alt: ei.name,
      });
      const diffHtml =
        diff > 0
          ? `<span class="kc-dps-delta is-up">▲ +${diff}</span>`
          : diff < 0
            ? `<span class="kc-dps-delta is-down">▼ ${diff}</span>`
            : `<span class="kc-dps-delta is-flat">= 0</span>`;

      return `
        <div class="kc-loot-cmp-row">
          <div class="kc-loot-mini-icon ${eqColor}">${eqIcon}</div>
          <div class="kc-loot-cmp-info">
            <div class="kc-loot-cmp-name">${escapeHtml(ei.name)} <span class="kc-loot-cmp-tier">${escapeHtml(formatGearBadge(eq.level, eq.quality))}</span></div>
            <div class="kc-loot-cmp-sub">${label} · DPS ${ep}</div>
          </div>
          ${diffHtml}
        </div>
      `;
    };

    const affixesHtml =
      gear.affixes.length > 0
        ? `<ul class="kc-affix-list">${gear.affixes
            .map((a) => `<li>${escapeHtml(getAffixDisplayLabel(a, this.catalog))}</li>`)
            .join('')}</ul>`
        : `<div class="kc-loot-meta">Standard forged gear</div>`;

    const price = pickup.priceGold ?? 0;
    const goldIconHtml = renderItemIconHtml('Gold', this.artPackMode, this.customPackResolver, {
      size: 14,
      fallbackKind: 'gold',
      alt: 'Gold',
    });

    this.lootCardEl.innerHTML = `
      <div class="kc-loot-grid">
        <div class="kc-loot-col kc-loot-ground ${colorClass}">
          <div class="kc-loot-head">
            <div class="kc-loot-icon-box ${colorClass}">${groundIconHtml}</div>
            <div class="kc-loot-head-text">
              <div class="kc-loot-title-row">
                <span class="kc-loot-name">${escapeHtml(info.name)}</span>
                <span class="kc-gear-badge ${gear.quality === 'L' ? 'is-legendary' : ''}" style="position:static">${escapeHtml(badge)}</span>
              </div>
              <div class="kc-loot-meta">
                <span>${escapeHtml(gear.color.toUpperCase())}</span>
                <span>·</span>
                <span>${escapeHtml(gear.slotKind.toUpperCase())}</span>
                ${pwr > 0 ? `<span>·</span><strong>DPS ${pwr}</strong>` : ''}
              </div>
            </div>
          </div>
          <div class="kc-loot-desc">${escapeHtml(info.description)}</div>
          ${affixesHtml}
        </div>
        <div class="kc-loot-col kc-loot-equipped">
          <div class="kc-loot-cmp-title">EQUIPPED COMPARISON</div>
          ${renderEquippedRow(gear.slotKind === 'skill' ? 'Skill 1' : 'Weapon 1', slot1)}
          ${renderEquippedRow(gear.slotKind === 'skill' ? 'Skill 2' : 'Weapon 2', slot2)}
        </div>
      </div>
      <div class="kc-loot-actions">
        ${
          price > 0
            ? `<span class="kc-price-tag ${canAfford ? '' : 'is-unaffordable'}">${goldIconHtml}<span>${price} Gold${canAfford ? '' : ' (Insufficient)'}</span></span>`
            : ''
        }
        <button class="kc-btn kc-btn-sm kc-btn-primary" data-loot-act="equip1" ${canAfford ? '' : 'disabled'}>[${escapeHtml(keyF)}] Equip Slot 1</button>
        ${
          gear.slotKind !== 'amulet'
            ? `<button class="kc-btn kc-btn-sm" data-loot-act="equip2" ${canAfford ? '' : 'disabled'}>[G] Equip Slot 2</button>`
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

    for (const c of state.chests) {
      if (c.opened) continue;
      if (Math.hypot(c.pos.x - px, c.pos.y - py) < 44) {
        const label =
          c.kind === 'cursed'
            ? 'Open Cursed Chest (10-Kill Curse)'
            : c.kind === 'boss'
              ? 'Open Boss Chest'
              : 'Open Treasure Chest';
        return { key: keyF, label };
      }
    }

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

    for (const tp of state.teleporters) {
      if (Math.hypot(tp.pos.x - px, tp.pos.y - py) < 44) {
        return {
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
      f.vy += 44 * dtSec;

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
