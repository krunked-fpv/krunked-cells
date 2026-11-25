import type {
  AffixDef,
  BiomeDef,
  BiomeId,
  BossDef,
  BossId,
  DifficultyDef,
  EnemyDef,
  MutationDef,
  SkillDef,
  WeaponDef,
} from '../contracts';
import { BIOMES, BIOME_MAP } from './biomes';
import { WEAPONS, WEAPON_MAP } from './weapons';
import { SKILLS, SKILL_MAP } from './skills';
import { MUTATIONS, MUTATION_MAP } from './mutations';
import { AFFIXES, AFFIX_MAP } from './affixes';
import { ENEMIES, ENEMY_MAP } from './enemies';
import { BOSSES, BOSS_MAP } from './bosses';
import { DIFFICULTIES } from './difficulty';
import { META_BLUEPRINTS, META_BLUEPRINT_MAP } from './meta';

export {
  BIOMES,
  BIOME_MAP,
  WEAPONS,
  WEAPON_MAP,
  SKILLS,
  SKILL_MAP,
  MUTATIONS,
  MUTATION_MAP,
  AFFIXES,
  AFFIX_MAP,
  ENEMIES,
  ENEMY_MAP,
  BOSSES,
  BOSS_MAP,
  DIFFICULTIES,
  META_BLUEPRINTS,
  META_BLUEPRINT_MAP,
};

export function getDifficulty(bc: number): DifficultyDef {
  const clamped = Math.max(0, Math.min(DIFFICULTIES.length - 1, Math.floor(bc)));
  return DIFFICULTIES[clamped];
}

export function getWeapon(id: string): WeaponDef {
  return WEAPON_MAP[id] ?? WEAPONS[0];
}

export function getSkill(id: string): SkillDef {
  return SKILL_MAP[id] ?? SKILLS[0];
}

export function getEnemy(id: string): EnemyDef {
  return ENEMY_MAP[id] ?? ENEMIES[0];
}

export function getBoss(id: BossId): BossDef {
  return BOSS_MAP[id] ?? BOSSES[0];
}

export function getBiome(id: BiomeId): BiomeDef {
  return BIOME_MAP[id] ?? BIOMES[0];
}

export function getMutation(id: string): MutationDef {
  return MUTATION_MAP[id] ?? MUTATIONS[0];
}

export function getAffix(id: string): AffixDef {
  return AFFIX_MAP[id] ?? AFFIXES[0];
}
