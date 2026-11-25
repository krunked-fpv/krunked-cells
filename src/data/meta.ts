import type { MetaBlueprintDef } from '../contracts';
import { WEAPONS } from './weapons';
import { SKILLS } from './skills';
import { MUTATIONS } from './mutations';

const CORE_UPGRADE_BLUEPRINTS: readonly MetaBlueprintDef[] = [
  {
    id: 'health_flask',
    name: 'Health Flask I-IV',
    description: 'Increases maximum Health Flask charges carried per run (up to 4 charges).',
    category: 'upgrade',
    maxTier: 4,
    costs: [5, 25, 50, 100],
  },
  {
    id: 'gold_reserves',
    name: 'Gold Reserves I-IV',
    description: 'Retain up to 2,500 / 5,000 / 10,000 / 15,000 Gold across runs.',
    category: 'upgrade',
    maxTier: 4,
    costs: [10, 30, 60, 120],
  },
  {
    id: 'random_starter',
    name: 'Random Starter Weapons',
    description: 'Begin runs with randomized unlocked weapons instead of only the Rusty Sword.',
    category: 'upgrade',
    maxTier: 1,
    costs: [20],
  },
  {
    id: 'recycling',
    name: 'Recycling',
    description: 'Convert unwanted gear on the ground into instant Gold.',
    category: 'upgrade',
    maxTier: 1,
    costs: [15],
  },
];

const WEAPON_BLUEPRINTS: readonly MetaBlueprintDef[] = WEAPONS.filter((w) => !w.autoUnlocked).map((w) => ({
  id: `bp_${w.id}`,
  name: w.name,
  description: w.description,
  category: 'weapon' as const,
  maxTier: 1,
  costs: [Math.max(10, w.unlockCost)],
  targetId: w.id,
}));

const SKILL_BLUEPRINTS: readonly MetaBlueprintDef[] = SKILLS.filter((s) => !s.autoUnlocked).map((s) => ({
  id: `bp_${s.id}`,
  name: s.name,
  description: s.description,
  category: 'skill' as const,
  maxTier: 1,
  costs: [Math.max(10, s.unlockCost)],
  targetId: s.id,
}));

const MUTATION_BLUEPRINTS: readonly MetaBlueprintDef[] = MUTATIONS.filter((m) => !m.autoUnlocked).map((m) => ({
  id: `bp_${m.id}`,
  name: m.name,
  description: m.description,
  category: 'mutation' as const,
  maxTier: 1,
  costs: [Math.max(10, m.unlockCost)],
  targetId: m.id,
}));

export const META_BLUEPRINTS: readonly MetaBlueprintDef[] = [
  ...CORE_UPGRADE_BLUEPRINTS,
  ...WEAPON_BLUEPRINTS,
  ...SKILL_BLUEPRINTS,
  ...MUTATION_BLUEPRINTS,
];

export const META_BLUEPRINT_MAP: Readonly<Record<string, MetaBlueprintDef>> = META_BLUEPRINTS.reduce(
  (acc, bp) => {
    acc[bp.id] = bp;
    return acc;
  },
  {} as Record<string, MetaBlueprintDef>
);
