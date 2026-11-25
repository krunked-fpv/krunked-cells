import type { AffixDef } from '../contracts';

export const AFFIXES: readonly AffixDef[] = [
  {
    id: 'bonus_bleed',
    label: '+60% damage to bleeding targets',
    kind: 'bonusDmg',
    targetStatus: 'bleed',
    multiplier: 1.6,
    weight: 10,
  },
  {
    id: 'bonus_poison',
    label: '+80% damage to poisoned targets',
    kind: 'bonusDmg',
    targetStatus: 'poison',
    multiplier: 1.8,
    weight: 10,
  },
  {
    id: 'bonus_burning_oil',
    label: '+100% damage to targets covered in burning oil',
    kind: 'bonusDmg',
    targetStatus: 'oil',
    multiplier: 2.0,
    weight: 7,
  },
  {
    id: 'bonus_burn',
    label: '+40% damage to burning targets',
    kind: 'bonusDmg',
    targetStatus: 'burn',
    multiplier: 1.4,
    weight: 10,
  },
  {
    id: 'bonus_electrify',
    label: '+40% damage to electrified targets',
    kind: 'bonusDmg',
    targetStatus: 'electrify',
    multiplier: 1.4,
    weight: 9,
  },
  {
    id: 'bonus_frozen',
    label: '+50% damage to frozen targets',
    kind: 'bonusDmg',
    targetStatus: 'freeze',
    multiplier: 1.5,
    weight: 9,
  },
  {
    id: 'bonus_rooted',
    label: '+50% damage to rooted targets',
    kind: 'bonusDmg',
    targetStatus: 'root',
    multiplier: 1.5,
    weight: 9,
  },
  {
    id: 'bonus_slow',
    label: '+30% damage to slowed targets',
    kind: 'bonusDmg',
    targetStatus: 'slow',
    multiplier: 1.3,
    weight: 10,
  },
  {
    id: 'apply_bleed',
    label: 'Causes the victim to bleed',
    kind: 'applyStatus',
    applyStatus: 'bleed',
    weight: 8,
  },
  {
    id: 'apply_poison',
    label: 'Poisons the target',
    kind: 'applyStatus',
    applyStatus: 'poison',
    weight: 8,
  },
  {
    id: 'apply_burn',
    label: 'Ignites the target on hit',
    kind: 'applyStatus',
    applyStatus: 'burn',
    weight: 8,
  },
  {
    id: 'apply_oil',
    label: 'Covers the target in inflammable oil',
    kind: 'applyStatus',
    applyStatus: 'oil',
    weight: 7,
  },
  {
    id: 'pierce_first',
    label: 'Pierces the first target',
    kind: 'pierce',
    multiplier: 1,
    weight: 7,
  },
  {
    id: 'explode_toxic',
    label: 'Victims explode into a toxic cloud',
    kind: 'explodeToxic',
    weight: 6,
  },
  {
    id: 'flame_trail',
    label: 'Leaves a trail of flames',
    kind: 'flameTrail',
    weight: 6,
  },
  {
    id: 'dmg_dealt_taken',
    label: '+20% damage dealt, +20% damage taken',
    kind: 'dmgDealtTaken',
    multiplier: 1.2,
    weight: 5,
  },
  {
    id: 'gold_bonus',
    label: '+20% Gold dropped by slain enemies',
    kind: 'goldBonus',
    multiplier: 1.2,
    weight: 6,
  },
  {
    id: 'cell_bonus',
    label: '+25% bonus Cell drop chance',
    kind: 'cellBonus',
    multiplier: 1.25,
    weight: 4,
  },
];

export const AFFIX_MAP: Readonly<Record<string, AffixDef>> = AFFIXES.reduce(
  (acc, affix) => {
    acc[affix.id] = affix;
    return acc;
  },
  {} as Record<string, AffixDef>
);
