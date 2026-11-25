import type { StatusEffect, StatusKind } from '../contracts';
import { AFFIX_MAP } from '../data';

const DOT_KINDS: ReadonlySet<StatusKind> = new Set(['bleed', 'poison', 'burn', 'electrify']);

const MAX_STACKS: Readonly<Partial<Record<StatusKind, number>>> = {
  bleed: 5,
  poison: 5,
  burn: 3,
  electrify: 3,
  frost: 3,
};

export function applyStatus(
  effects: StatusEffect[],
  kind: StatusKind,
  ticks: number,
  dps = 0,
  sourceId = 0
): StatusEffect {
  const safeTicks = Math.max(1, Math.round(ticks));
  const existing = effects.find((e) => e.kind === kind && e.ticksLeft > 0);
  if (existing) {
    existing.ticksLeft = Math.max(existing.ticksLeft, safeTicks);
    const maxStack = MAX_STACKS[kind] ?? 1;
    if (existing.stacks < maxStack) {
      existing.stacks += 1;
    }
    if (dps > existing.dps) {
      existing.dps = dps;
    }
    if (sourceId !== 0) {
      existing.sourceId = sourceId;
    }
    if (kind === 'frost' && existing.stacks >= 3) {
      existing.ticksLeft = 0;
      applyStatus(effects, 'freeze', 90, 0, sourceId);
    }
    return existing;
  }

  const created: StatusEffect = {
    kind,
    ticksLeft: safeTicks,
    stacks: 1,
    dps: Math.max(0, dps),
    sourceId,
  };
  effects.push(created);
  return created;
}

export function hasStatus(effects: readonly StatusEffect[], kind: StatusKind): boolean {
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (e.kind === kind && e.ticksLeft > 0) {
      return true;
    }
  }
  return false;
}

export function getStatusStacks(effects: readonly StatusEffect[], kind: StatusKind): number {
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (e.kind === kind && e.ticksLeft > 0) {
      return e.stacks;
    }
  }
  return 0;
}

export function clearNegativeStatuses(effects: StatusEffect[]): void {
  const keep: ReadonlySet<StatusKind> = new Set(['speed', 'shield', 'corrupted']);
  for (let i = effects.length - 1; i >= 0; i--) {
    if (!keep.has(effects[i].kind)) {
      effects.splice(i, 1);
    }
  }
}

export function tickEntityStatuses(
  effects: StatusEffect[],
  onDamage: (kind: StatusKind, amount: number) => void,
  onExpire?: (kind: StatusKind) => void
): void {
  if (effects.length === 0) return;

  const hasOil = hasStatus(effects, 'oil');
  let applyThawSlow = false;

  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i];
    if (effect.ticksLeft <= 0) {
      effects.splice(i, 1);
      continue;
    }

    effect.ticksLeft -= 1;

    if (DOT_KINDS.has(effect.kind) && effect.dps > 0 && effect.ticksLeft % 15 === 0) {
      const stackBonus = 1 + (effect.stacks - 1) * 0.45;
      let tickDmg = (effect.dps / 4) * stackBonus;

      // Oil + Burn synergy doubles burn DoT damage
      if (effect.kind === 'burn' && hasOil) {
        tickDmg *= 2.0;
      }

      // 5-stack bleed hemorrhage burst
      if (effect.kind === 'bleed' && effect.stacks >= 5) {
        tickDmg *= 1.5;
      }

      const finalDmg = Math.max(1, Math.round(tickDmg));
      onDamage(effect.kind, finalDmg);
    }

    if (effect.ticksLeft <= 0) {
      const expiredKind = effect.kind;
      effects.splice(i, 1);
      if (expiredKind === 'freeze') {
        applyThawSlow = true;
      }
      if (onExpire) {
        onExpire(expiredKind);
      }
    }
  }

  if (applyThawSlow && !hasStatus(effects, 'slow')) {
    applyStatus(effects, 'slow', 90, 0, 0);
  }
}

export function computeSynergyMultiplier(
  affixes: readonly string[] | undefined,
  targetEffects: readonly StatusEffect[]
): number {
  if (!affixes || affixes.length === 0) return 1.0;

  let mult = 1.0;
  const targetHasOil = hasStatus(targetEffects, 'oil');
  const targetHasBurn = hasStatus(targetEffects, 'burn');

  for (let i = 0; i < affixes.length; i++) {
    const def = AFFIX_MAP[affixes[i]];
    if (!def) continue;

    if (def.kind === 'bonusDmg' && def.targetStatus && def.multiplier) {
      if (def.id === 'bonus_burning_oil') {
        if (targetHasOil && targetHasBurn) {
          mult *= def.multiplier;
        } else if (targetHasOil) {
          mult *= 1.35;
        }
      } else if (hasStatus(targetEffects, def.targetStatus)) {
        mult *= def.multiplier;
      } else if (def.targetStatus === 'freeze' && hasStatus(targetEffects, 'frost')) {
        mult *= 1.25;
      }
    } else if (def.kind === 'dmgDealtTaken' && def.multiplier) {
      mult *= def.multiplier;
    }
  }

  return Math.min(6.0, mult);
}

export function getStatusColor(kind: StatusKind): string {
  switch (kind) {
    case 'bleed':
      return '#ff2e4c';
    case 'poison':
      return '#6ee642';
    case 'burn':
      return '#ff7b29';
    case 'oil':
      return '#4a355c';
    case 'frost':
    case 'freeze':
      return '#70e4ff';
    case 'root':
      return '#b58d52';
    case 'slow':
      return '#8bb8e8';
    case 'electrify':
      return '#6ef2ff';
    case 'stun':
      return '#ffe852';
    case 'speed':
      return '#5cf2ff';
    case 'shield':
      return '#66f5c8';
    case 'corrupted':
      return '#c852ff';
  }
}
