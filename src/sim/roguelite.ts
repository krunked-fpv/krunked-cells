import {
  SCROLL_DAMAGE_BASE,
  type EnemyState,
  type GearInstance,
  type GearQuality,
  type ItemColor,
  type MetaSnapshot,
  type RngAPI,
  type ScrollStat,
  type SimState,
  type WeaponKind,
} from '../contracts';
import {
  AFFIXES,
  AFFIX_MAP,
  BOSS_MAP,
  ENEMY_MAP,
  SKILL_MAP,
  SKILLS,
  WEAPON_MAP,
  WEAPONS,
  getBiome,
  getDifficulty,
} from '../data';

const SCROLL_STATS: readonly ScrollStat[] = ['brutality', 'tactics', 'survival'];
const PIERCE_ELIGIBLE_SKILLS: ReadonlySet<string> = new Set([
  'SinewSlicer',
  'HeavyTurret',
  'KnifeDance',
]);

export function getScrollDamageMultiplier(
  scrolls: Record<ScrollStat, number>,
  color: ItemColor
): number {
  const stat =
    color === 'colorless'
      ? Math.max(scrolls.brutality, scrolls.tactics, scrolls.survival)
      : scrolls[color];
  return Math.pow(SCROLL_DAMAGE_BASE, Math.max(0, stat - 1));
}

export function computePlayerMaxHp(scrolls: Record<ScrollStat, number>): number {
  let hp = 100;

  const extraBrutality = Math.max(0, scrolls.brutality - 1);
  for (let i = 0; i < extraBrutality; i++) {
    const bonus = 0.06 + 0.59 * Math.pow(0.84, i);
    hp *= 1 + bonus;
  }

  const extraTactics = Math.max(0, scrolls.tactics - 1);
  for (let i = 0; i < extraTactics; i++) {
    const bonus = 0.04 + 0.46 * Math.pow(0.82, i);
    hp *= 1 + bonus;
  }

  const extraSurvival = Math.max(0, scrolls.survival - 1);
  for (let i = 0; i < extraSurvival; i++) {
    const bonus = 0.09 + 0.71 * Math.pow(0.85, i);
    hp *= 1 + bonus;
  }

  return Math.max(100, Math.round(hp));
}

export function applyGearScrollDelta(
  state: SimState,
  gear: GearInstance | null,
  sign: 1 | -1
): void {
  if (!gear || !gear.bonusScrolls) return;
  for (let i = 0; i < SCROLL_STATS.length; i++) {
    const stat = SCROLL_STATS[i]!;
    const delta = gear.bonusScrolls[stat] ?? 0;
    if (delta > 0) {
      state.player.scrolls[stat] = Math.max(1, state.player.scrolls[stat] + sign * delta);
    }
  }
  const prevMax = state.player.maxHp;
  const nextMax = computePlayerMaxHp(state.player.scrolls);
  state.player.maxHp = nextMax;
  if (nextMax > prevMax) {
    state.player.hp = Math.min(nextMax, state.player.hp + (nextMax - prevMax));
  } else {
    state.player.hp = Math.min(nextMax, state.player.hp);
  }
}

export function getQualityLevelBonus(quality: GearQuality): number {
  switch (quality) {
    case 'base':
      return 0;
    case '+':
      return 2;
    case '++':
      return 4;
    case 'S':
      return 6;
    case 'L':
      return 6;
  }
}

export function getEffectiveGearColor(
  gear: GearInstance,
  scrolls: Record<ScrollStat, number>
): ItemColor {
  if (gear.quality === 'L' || gear.color === 'colorless') {
    return 'colorless';
  }
  const defColors =
    gear.slotKind === 'weapon'
      ? WEAPON_MAP[gear.defId]?.colors
      : gear.slotKind === 'skill'
        ? SKILL_MAP[gear.defId]?.colors
        : undefined;

  if (defColors && defColors.length > 1 && defColors.includes(gear.color)) {
    let best: ScrollStat = defColors[0]!;
    for (let i = 1; i < defColors.length; i++) {
      if (scrolls[defColors[i]!] > scrolls[best]) {
        best = defColors[i]!;
      }
    }
    return best;
  }

  return gear.color;
}

export function computeGearDamage(
  basePower: number,
  gear: GearInstance | null,
  scrolls: Record<ScrollStat, number>
): number {
  if (!gear) {
    return Math.max(1, Math.round(basePower * getScrollDamageMultiplier(scrolls, 'brutality')));
  }
  const effectiveLevel = Math.max(1, gear.level + getQualityLevelBonus(gear.quality));
  const levelMult = Math.pow(1.07, effectiveLevel - 1);
  const effectiveColor = getEffectiveGearColor(gear, scrolls);
  const scrollMult = getScrollDamageMultiplier(scrolls, effectiveColor);
  return Math.max(1, Math.round(basePower * levelMult * scrollMult));
}

function isAffixEligible(
  affixId: string,
  slotKind?: 'weapon' | 'skill' | 'amulet',
  weaponKind?: WeaponKind,
  defId?: string
): boolean {
  if (!slotKind) return true;

  if (affixId === 'pierce_first') {
    if (slotKind === 'weapon') {
      return weaponKind === 'ranged';
    }
    if (slotKind === 'skill') {
      return Boolean(defId && PIERCE_ELIGIBLE_SKILLS.has(defId));
    }
    return false;
  }

  if (affixId === 'breaks_shields') {
    return slotKind === 'weapon' && (weaponKind === 'melee' || weaponKind === 'ranged');
  }

  if (affixId === 'flame_trail') {
    return slotKind === 'amulet' || slotKind === 'skill';
  }

  if (affixId === 'double_dmg') {
    return slotKind === 'weapon' && weaponKind !== 'shield';
  }

  if (slotKind === 'amulet') {
    return (
      affixId === 'flame_trail' ||
      affixId === 'gold_bonus' ||
      affixId === 'cell_bonus' ||
      affixId === 'explode_toxic' ||
      affixId === 'spread_oil' ||
      affixId === 'apply_burn' ||
      affixId === 'apply_poison' ||
      affixId === 'apply_bleed'
    );
  }

  if (slotKind === 'weapon' && weaponKind === 'shield') {
    return affixId !== 'pierce_first' && affixId !== 'double_dmg' && affixId !== 'breaks_shields';
  }

  return true;
}

export function rollAffixes(
  rng: RngAPI,
  count: number,
  excludeIds?: readonly string[],
  slotKind?: 'weapon' | 'skill' | 'amulet',
  weaponKind?: WeaponKind,
  defId?: string
): string[] {
  const chosen: string[] = [];
  const excluded = new Set(excludeIds ?? []);

  for (let n = 0; n < count; n++) {
    let totalWeight = 0;
    for (let i = 0; i < AFFIXES.length; i++) {
      const a = AFFIXES[i]!;
      if (
        !excluded.has(a.id) &&
        !chosen.includes(a.id) &&
        isAffixEligible(a.id, slotKind, weaponKind, defId)
      ) {
        totalWeight += a.weight;
      }
    }
    if (totalWeight <= 0) break;

    let roll = rng.rangeFloat(0, totalWeight);
    for (let i = 0; i < AFFIXES.length; i++) {
      const a = AFFIXES[i]!;
      if (
        excluded.has(a.id) ||
        chosen.includes(a.id) ||
        !isAffixEligible(a.id, slotKind, weaponKind, defId)
      ) {
        continue;
      }
      roll -= a.weight;
      if (roll <= 0) {
        chosen.push(a.id);
        break;
      }
    }
  }

  return chosen;
}

function rollQuality(
  rng: RngAPI,
  bossCells: number,
  level: number,
  forceLegendary?: boolean,
  meta?: MetaSnapshot
): GearQuality {
  if (forceLegendary) return 'L';
  const r = rng.nextFloat();
  const forgePlusPct = Math.max(0, Math.min(1, (meta?.legendaryForgePlus ?? 0) / 100));
  const forgePlusPlusPct = Math.max(0, Math.min(1, (meta?.legendaryForgePlusPlus ?? 0) / 100));

  const sChance = Math.min(0.45, bossCells * 0.08 + Math.max(0, level - 5) * 0.02);
  const ppChance = Math.min(
    0.75,
    Math.max(forgePlusPlusPct, 0.08 + bossCells * 0.07 + level * 0.025)
  );
  const pChance = Math.min(
    0.95,
    Math.max(forgePlusPct, 0.25 + bossCells * 0.05 + level * 0.02)
  );
  const lChance = level >= 4 ? 0.025 : 0.01;

  if (r < lChance) return 'L';
  if (r < lChance + sChance) return 'S';
  if (r < lChance + sChance + ppChance) return '++';
  if (r < lChance + sChance + ppChance + pChance) return '+';
  return 'base';
}

export function getAffixCountForQuality(quality: GearQuality): number {
  switch (quality) {
    case 'base':
      return 1;
    case '+':
      return 2;
    case '++':
      return 2;
    case 'S':
      return 3;
    case 'L':
      return 4;
  }
}

export function rollGearInstance(
  state: SimState,
  rng: RngAPI,
  slotKind: 'weapon' | 'skill' | 'amulet',
  level: number,
  preferredColor?: ScrollStat,
  forceLegendary?: boolean,
  specificDefId?: string
): GearInstance {
  const diff = getDifficulty(state.bossStemCells);
  const biome = getBiome(state.activeBiomeId);
  const baseLvl = level > 0 ? Math.floor(level) : Math.max(1, biome.depthTier);
  const finalLevel = Math.max(1, baseLvl + diff.extraLootLevel);
  const quality = rollQuality(rng, state.bossStemCells, finalLevel, forceLegendary, state.metaSnapshot);
  const unlockedSet = new Set(state.metaSnapshot.unlockedBlueprints);

  if (slotKind === 'amulet') {
    const primaryStat: ScrollStat = preferredColor ?? rng.pick(SCROLL_STATS);
    const secondaryStat: ScrollStat = rng.pick(SCROLL_STATS);
    const bonusScrolls: Partial<Record<ScrollStat, number>> = {};
    const primaryCount = finalLevel >= 5 ? 2 : 1;
    bonusScrolls[primaryStat] = primaryCount;
    if (quality === '++' || quality === 'S' || quality === 'L') {
      bonusScrolls[secondaryStat] = (bonusScrolls[secondaryStat] ?? 0) + 1;
    }
    const dmgReductionPct = Math.min(25, 5 + finalLevel * 2 + getQualityLevelBonus(quality));

    return {
      uid: state.nextUid++,
      defId: specificDefId ?? `Amulet_${primaryStat}`,
      slotKind: 'amulet',
      level: finalLevel,
      quality,
      color: quality === 'L' ? 'colorless' : primaryStat,
      affixes: rollAffixes(rng, 2, undefined, 'amulet'),
      bonusScrolls,
      dmgReductionPct,
      cooldownTicks: 0,
    };
  }

  if (slotKind === 'skill') {
    let skillDef = specificDefId ? SKILL_MAP[specificDefId] : undefined;
    if (!skillDef) {
      let pool = SKILLS.filter((s) => s.autoUnlocked || unlockedSet.has(s.id));
      if (preferredColor) {
        const colored = pool.filter((s) => s.colors.includes(preferredColor));
        if (colored.length > 0) pool = colored;
      }
      if (pool.length === 0) pool = [...SKILLS];
      skillDef = rng.pick(pool);
    }

    const itemColor: ItemColor =
      quality === 'L'
        ? 'colorless'
        : preferredColor && skillDef.colors.includes(preferredColor)
          ? preferredColor
          : skillDef.colors[0]!;

    const bonusScrolls: Partial<Record<ScrollStat, number>> | undefined =
      quality === '++'
        ? { [skillDef.colors[0]!]: 1 }
        : quality === 'S'
          ? { [skillDef.colors[0]!]: 2 }
          : quality === 'L'
            ? { [preferredColor ?? skillDef.colors[0]!]: 1 }
            : undefined;

    return {
      uid: state.nextUid++,
      defId: skillDef.id,
      slotKind: 'skill',
      level: finalLevel,
      quality,
      color: itemColor,
      affixes: rollAffixes(
        rng,
        getAffixCountForQuality(quality),
        undefined,
        'skill',
        undefined,
        skillDef.id
      ),
      bonusScrolls,
      cooldownTicks: 0,
    };
  }

  // Weapon
  let weaponDef = specificDefId ? WEAPON_MAP[specificDefId] : undefined;
  if (!weaponDef) {
    let pool = WEAPONS.filter((w) => w.autoUnlocked || unlockedSet.has(w.id));
    if (preferredColor) {
      const colored = pool.filter((w) => w.colors.includes(preferredColor));
      if (colored.length > 0) pool = colored;
    }
    if (pool.length === 0) pool = [...WEAPONS];
    weaponDef = rng.pick(pool);
  }

  const itemColor: ItemColor =
    quality === 'L'
      ? 'colorless'
      : preferredColor && weaponDef.colors.includes(preferredColor)
        ? preferredColor
        : weaponDef.colors[0]!;

  const bonusScrolls: Partial<Record<ScrollStat, number>> | undefined =
    quality === '++'
      ? { [weaponDef.colors[0]!]: 1 }
      : quality === 'S'
        ? { [weaponDef.colors[0]!]: 2 }
        : quality === 'L'
          ? { [preferredColor ?? weaponDef.colors[0]!]: 1 }
          : undefined;

  return {
    uid: state.nextUid++,
    defId: weaponDef.id,
    slotKind: 'weapon',
    level: finalLevel,
    quality,
    color: itemColor,
    affixes: rollAffixes(
      rng,
      getAffixCountForQuality(quality),
      undefined,
      'weapon',
      weaponDef.kind,
      weaponDef.id
    ),
    bonusScrolls,
    ammo: weaponDef.ammoCapacity,
    maxAmmo: weaponDef.ammoCapacity,
    cooldownTicks: 0,
  };
}

export function applyScrollPickup(state: SimState, stat: ScrollStat): void {
  const player = state.player;
  const prevMaxHp = player.maxHp;
  player.scrolls[stat] += 1;
  const nextMaxHp = computePlayerMaxHp(player.scrolls);
  const gainedHp = Math.max(0, nextMaxHp - prevMaxHp);
  player.maxHp = nextMaxHp;
  player.hp = Math.min(nextMaxHp, player.hp + gainedHp);

  state.events.push({
    type: 'scrollPickup',
    x: player.pos.x,
    y: player.pos.y,
    stat,
  });

  const statColor =
    stat === 'brutality' ? '#ff4d4d' : stat === 'tactics' ? '#b86bff' : '#4dff88';
  state.particlesSim.push({
    uid: state.nextUid++,
    pos: { x: player.pos.x, y: player.pos.y - 24 },
    vel: { x: 0, y: -32 },
    size: 10,
    color: statColor,
    alpha: 1,
    ttlTicks: 50,
    maxTtlTicks: 50,
    gravity: 0,
    emissive: true,
    kind: 'text',
    text: `+1 ${stat.toUpperCase()}`,
  });
}

export function triggerCurse(state: SimState, kills: number): void {
  const addKills = Math.max(1, Math.floor(kills));
  state.player.curseKillsLeft += addKills;
  state.events.push({
    type: 'curseTriggered',
    x: state.player.pos.x,
    y: state.player.pos.y,
    killsRequired: state.player.curseKillsLeft,
  });

  state.particlesSim.push({
    uid: state.nextUid++,
    pos: { x: state.player.pos.x, y: state.player.pos.y - 26 },
    vel: { x: 0, y: -24 },
    size: 11,
    color: '#c842ff',
    alpha: 1,
    ttlTicks: 65,
    maxTtlTicks: 65,
    gravity: 0,
    emissive: true,
    kind: 'text',
    text: `CURSED (${state.player.curseKillsLeft})`,
  });
}

export function hasLoadoutAffixKind(
  state: SimState,
  kind: 'dmgDealtTaken' | 'goldBonus' | 'cellBonus' | 'flameTrail'
): boolean {
  const slots = [
    state.player.loadout.weapon1,
    state.player.loadout.weapon2,
    state.player.loadout.skill1,
    state.player.loadout.skill2,
    state.player.loadout.amulet,
  ];
  for (let i = 0; i < slots.length; i++) {
    const g = slots[i];
    if (!g) continue;
    for (let j = 0; j < g.affixes.length; j++) {
      const def = AFFIX_MAP[g.affixes[j]!];
      if (def && def.kind === kind) return true;
    }
  }
  return false;
}

export function getLoadoutDamageTakenMultiplier(state: SimState): number {
  let mult = 1.0;
  const slots = [
    state.player.loadout.weapon1,
    state.player.loadout.weapon2,
    state.player.loadout.skill1,
    state.player.loadout.skill2,
    state.player.loadout.amulet,
  ];
  let saw20 = false;
  let sawDouble = false;
  for (let i = 0; i < slots.length; i++) {
    const g = slots[i];
    if (!g) continue;
    for (let j = 0; j < g.affixes.length; j++) {
      const id = g.affixes[j]!;
      if (id === 'double_dmg') sawDouble = true;
      else if (id === 'dmg_dealt_taken') saw20 = true;
    }
  }
  if (sawDouble) mult *= 2.0;
  if (saw20) mult *= 1.2;
  return mult;
}

export function onEnemyKilledForCurseAndStreak(
  state: SimState,
  rng: RngAPI,
  enemy: EnemyState
): void {
  const player = state.player;
  const biome = getBiome(state.activeBiomeId);
  const diff = getDifficulty(state.bossStemCells);

  state.runKills += 1;
  state.metaSnapshot.totalKills += 1;
  player.killStreak += 1;
  if (player.killStreak > state.maxKillStreak) {
    state.maxKillStreak = player.killStreak;
  }

  if (biome.killStreakDoorTarget > 0 && player.killStreak === biome.killStreakDoorTarget) {
    state.events.push({
      type: 'perfectKillStreak',
      count: player.killStreak,
    });
  }

  // 5BC Malaise clear on enemy / elite / boss kill
  if (diff.malaiseEnabled && (player.malaise ?? 0) > 0) {
    const clearAmt = enemy.isBoss ? 50 : enemy.isElite ? 10 : 2;
    player.malaise = Math.max(0, (player.malaise ?? 0) - clearAmt);
  }

  // Speed kill-streak buff: 8 kills within 10s decay window triggers speed boost for 8s
  player.speedKillCount += 1;
  player.speedComboDecayTicks = 600;
  if (player.speedKillCount >= 8 || player.speedBuffTicks > 0) {
    player.speedBuffTicks = Math.max(player.speedBuffTicks, 480);
  }

  // Curse decrement & clear
  if (player.curseKillsLeft > 0) {
    player.curseKillsLeft = Math.max(0, player.curseKillsLeft - 1);
    if (player.curseKillsLeft === 0) {
      state.events.push({
        type: 'curseCleared',
        x: player.pos.x,
        y: player.pos.y,
      });
      state.particlesSim.push({
        uid: state.nextUid++,
        pos: { x: player.pos.x, y: player.pos.y - 24 },
        vel: { x: 0, y: -28 },
        size: 11,
        color: '#ffe666',
        alpha: 1,
        ttlTicks: 55,
        maxTtlTicks: 55,
        gravity: 0,
        emissive: true,
        kind: 'text',
        text: 'CURSE LIFTED!',
      });
    }
  }

  state.events.push({
    type: 'enemyDeath',
    x: enemy.pos.x,
    y: enemy.pos.y,
    defId: enemy.defId,
    isElite: enemy.isElite,
    isBoss: enemy.isBoss,
  });

  // Compute gold & cell drops
  let goldBase = 18;
  let cellBase = 1;
  if (enemy.isBoss && enemy.bossId) {
    const bossDef = BOSS_MAP[enemy.bossId];
    goldBase = bossDef ? bossDef.goldReward : 400;
    cellBase = bossDef ? bossDef.cellReward : 25;
  } else {
    const def = ENEMY_MAP[enemy.defId];
    if (def) {
      goldBase = def.goldDrop;
      cellBase = def.cellDrop;
    }
  }

  const goldMult =
    (1 + Math.max(0, biome.depthTier - 1) * 0.16) *
    (enemy.isElite ? 2.2 : 1.0) *
    (hasLoadoutAffixKind(state, 'goldBonus') ? 1.2 : 1.0);
  const totalGold = Math.max(5, Math.round(goldBase * goldMult));

  let totalCells = Math.round(cellBase * diff.cellDropMult);
  if (enemy.isElite) totalCells += 2;
  if (hasLoadoutAffixKind(state, 'cellBonus') && rng.chance(0.25)) {
    totalCells += 1;
  }
  if (!enemy.isBoss && !enemy.isElite && totalCells === 1 && !rng.chance(0.55)) {
    totalCells = 0;
  }

  const goldChunks = enemy.isBoss ? 8 : enemy.isElite ? 4 : 2;
  const goldPerChunk = Math.max(1, Math.round(totalGold / goldChunks));
  for (let i = 0; i < goldChunks; i++) {
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gold',
      pos: { x: enemy.pos.x + rng.rangeFloat(-6, 6), y: enemy.pos.y - 6 },
      prevPos: { x: enemy.pos.x, y: enemy.pos.y - 6 },
      vel: { x: rng.rangeFloat(-75, 75), y: rng.rangeFloat(-170, -90) },
      value: goldPerChunk,
      magnetTicks: 10,
      collected: false,
      bobPhase: rng.rangeFloat(0, 6.28),
    });
  }

  if (totalCells > 0) {
    const cellOrbs = enemy.isBoss ? Math.min(10, totalCells) : Math.min(4, totalCells);
    const cellPerOrb = Math.max(1, Math.round(totalCells / cellOrbs));
    for (let i = 0; i < cellOrbs; i++) {
      state.pickups.push({
        uid: state.nextUid++,
        kind: 'cell',
        pos: { x: enemy.pos.x + rng.rangeFloat(-6, 6), y: enemy.pos.y - 10 },
        prevPos: { x: enemy.pos.x, y: enemy.pos.y - 10 },
        vel: { x: rng.rangeFloat(-65, 65), y: rng.rangeFloat(-195, -110) },
        value: cellPerOrb,
        magnetTicks: 14,
        collected: false,
        bobPhase: rng.rangeFloat(0, 6.28),
      });
    }
    state.events.push({
      type: 'cellSpawn',
      x: enemy.pos.x,
      y: enemy.pos.y,
      count: totalCells,
    });
  }

  // Elites drop an amulet or high-quality gear; bosses drop a Legendary item
  if (enemy.isBoss) {
    const legGear = rollGearInstance(
      state,
      rng,
      rng.chance(0.7) ? 'weapon' : 'skill',
      Math.max(2, biome.depthTier + 1),
      undefined,
      true
    );
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gear',
      pos: { x: enemy.pos.x, y: enemy.pos.y - 12 },
      prevPos: { x: enemy.pos.x, y: enemy.pos.y - 12 },
      vel: { x: 0, y: -150 },
      value: 0,
      gear: legGear,
      label: `Legendary ${legGear.defId}`,
      magnetTicks: 0,
      collected: false,
      bobPhase: 0,
    });
  } else if (enemy.isElite) {
    const amulet = rollGearInstance(state, rng, 'amulet', Math.max(1, biome.depthTier));
    state.pickups.push({
      uid: state.nextUid++,
      kind: 'gear',
      pos: { x: enemy.pos.x, y: enemy.pos.y - 10 },
      prevPos: { x: enemy.pos.x, y: enemy.pos.y - 10 },
      vel: { x: rng.rangeFloat(-40, 40), y: -140 },
      value: 0,
      gear: amulet,
      label: 'Elite Amulet',
      magnetTicks: 0,
      collected: false,
      bobPhase: 0,
    });
  }
}

export function hasMutation(state: SimState, id: string): boolean {
  return state.player.mutations.includes(id);
}

export function applyMutationCooldownReduction(state: SimState, wasCrit: boolean): void {
  if (!wasCrit || !hasMutation(state, 'InstinctOfTheMaster')) return;
  const scrolls = state.player.scrolls;
  const maxStat = Math.max(scrolls.brutality, scrolls.tactics, scrolls.survival);
  const reduceTicks = 48 + maxStat * 3;
  if (state.player.loadout.skill1 && state.player.loadout.skill1.cooldownTicks > 0) {
    state.player.loadout.skill1.cooldownTicks = Math.max(
      0,
      state.player.loadout.skill1.cooldownTicks - reduceTicks
    );
  }
  if (state.player.loadout.skill2 && state.player.loadout.skill2.cooldownTicks > 0) {
    state.player.loadout.skill2.cooldownTicks = Math.max(
      0,
      state.player.loadout.skill2.cooldownTicks - reduceTicks
    );
  }
}

export function applyMutationOnKill(
  state: SimState,
  _enemy: EnemyState,
  wasMelee: boolean,
  wasCrit: boolean
): void {
  const player = state.player;
  if (hasMutation(state, 'Combo')) {
    player.comboMutationTicks = 480;
  }
  if (wasMelee && hasMutation(state, 'Predator')) {
    const dur = 180 + player.scrolls.brutality * 10;
    const stealthDur = 120 + player.scrolls.brutality * 6;
    player.speedBuffTicks = Math.max(player.speedBuffTicks, dur);
    player.stealthTicks = Math.max(player.stealthTicks ?? 0, stealthDur);
  }
  if (hasMutation(state, 'Necromancy')) {
    const capHp = Math.round(player.maxHp * 0.5);
    if (player.hp < capHp) {
      const pct = 0.025 + 0.002 * player.scrolls.survival;
      const heal = Math.max(1, Math.round(player.maxHp * pct));
      player.hp = Math.min(capHp, player.hp + heal);
    }
  }
  if (wasCrit) {
    applyMutationCooldownReduction(state, true);
  }
}

export function applyMutationOnParry(state: SimState, isProjectile = false): void {
  const player = state.player;
  if (
    !isProjectile &&
    hasMutation(state, 'WhatDoesntKillMe') &&
    (player.wdlmCooldownTicks ?? 0) <= 0
  ) {
    const pct = 0.04 + 0.003 * player.scrolls.survival;
    const heal = Math.max(2, Math.round(player.maxHp * pct));
    player.hp = Math.min(player.maxHp, player.hp + heal);
    player.wdlmCooldownTicks = 240;
  }
  if (hasMutation(state, 'InstinctOfTheMaster')) {
    if (player.loadout.skill1 && player.loadout.skill1.cooldownTicks > 0) {
      player.loadout.skill1.cooldownTicks = Math.max(0, player.loadout.skill1.cooldownTicks - 30);
    }
    if (player.loadout.skill2 && player.loadout.skill2.cooldownTicks > 0) {
      player.loadout.skill2.cooldownTicks = Math.max(0, player.loadout.skill2.cooldownTicks - 30);
    }
  }
}

export function getMutationDamageMultiplier(
  state: SimState,
  isMelee: boolean,
  targetDist: number
): number {
  const player = state.player;
  let mult = 1.0;

  if (isMelee && player.comboMutationTicks > 0 && hasMutation(state, 'Combo')) {
    mult *= 1 + 0.25 + 0.04 * Math.max(0, player.scrolls.brutality - 1);
  }

  if ((player.vengeanceTicks ?? 0) > 0 && hasMutation(state, 'Vengeance')) {
    mult *= 1 + 0.4 + 0.03 * Math.max(0, player.scrolls.brutality - 1);
  }

  if (hasMutation(state, 'Support')) {
    const nearTurret = state.turrets.some(
      (t) =>
        t.owner === 'player' &&
        Math.hypot(t.pos.x - player.pos.x, t.pos.y - player.pos.y) <= 130
    );
    if (nearTurret) {
      mult *= 1 + 0.25 + 0.03 * Math.max(0, player.scrolls.tactics - 1);
    }
  }

  if (!isMelee && targetDist <= 96 && hasMutation(state, 'PointBlank')) {
    mult *= 1 + 0.3 + 0.025 * Math.max(0, player.scrolls.tactics - 1);
  }

  if (hasMutation(state, 'Tranquility')) {
    const anyCloseEnemy = state.enemies.some(
      (e) =>
        e.state !== 'dead' &&
        e.hp > 0 &&
        Math.hypot(e.pos.x - player.pos.x, e.pos.y - player.pos.y) <= 84
    );
    if (!anyCloseEnemy) {
      mult *= 1 + 0.25 + 0.025 * Math.max(0, player.scrolls.tactics - 1);
    }
  }

  return mult;
}
