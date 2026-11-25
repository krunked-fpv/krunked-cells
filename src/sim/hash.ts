// =============================================================================
// KRUNKED CELLS — Deterministic FNV-1a 32-Bit SimState Hasher
// Pure simulation module: produces stable 8-char hex digests for replay checks.
// =============================================================================

import type { GearInstance, SimState } from '../contracts';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mixByte(h: number, b: number): number {
  return Math.imul((h ^ (b & 0xff)) >>> 0, FNV_PRIME) >>> 0;
}

function mixU32(h: number, v: number): number {
  const u = v >>> 0;
  h = mixByte(h, u & 0xff);
  h = mixByte(h, (u >>> 8) & 0xff);
  h = mixByte(h, (u >>> 16) & 0xff);
  h = mixByte(h, (u >>> 24) & 0xff);
  return h;
}

function mixNum(h: number, n: number): number {
  if (!Number.isFinite(n)) {
    return mixU32(h, 0x7fffffff);
  }
  // Quantize to fixed-point milli-units to avoid -0/+0 or float formatting noise
  const q = Math.round(n * 1000) | 0;
  return mixU32(h, q >>> 0);
}

function mixBool(h: number, b: boolean): number {
  return mixByte(h, b ? 1 : 0);
}

function mixStr(h: number, s: string): number {
  h = mixU32(h, s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = mixByte(h, c & 0xff);
    if (c > 0xff) {
      h = mixByte(h, (c >>> 8) & 0xff);
    }
  }
  return h;
}

function mixGear(h: number, gear: GearInstance | null): number {
  if (!gear) {
    return mixByte(h, 0);
  }
  h = mixByte(h, 1);
  h = mixStr(h, gear.defId);
  h = mixU32(h, gear.level);
  h = mixStr(h, gear.quality);
  h = mixStr(h, gear.color);
  h = mixU32(h, gear.cooldownTicks);
  h = mixU32(h, gear.ammo ?? 0xffff);
  return h;
}

/**
 * Computes a fast, deterministic 32-bit FNV-1a hex digest (8 chars) of SimState.
 */
export function hashSimState(state: SimState): string {
  let h = FNV_OFFSET_BASIS;

  // Core tick, RNG, biome, status, kills
  h = mixU32(h, state.tick);
  h = mixU32(h, state.rngState.s0);
  h = mixU32(h, state.rngState.s1);
  h = mixU32(h, state.rngState.s2);
  h = mixU32(h, state.rngState.s3);
  h = mixStr(h, state.activeBiomeId);
  h = mixStr(h, state.runStatus);
  h = mixU32(h, state.bossStemCells);
  h = mixU32(h, state.runKills);
  h = mixU32(h, state.maxKillStreak);

  // Player state
  const p = state.player;
  h = mixNum(h, p.pos.x);
  h = mixNum(h, p.pos.y);
  h = mixNum(h, p.vel.x);
  h = mixNum(h, p.vel.y);
  h = mixByte(h, p.facing === 1 ? 1 : 2);
  h = mixBool(h, p.grounded);
  h = mixNum(h, p.hp);
  h = mixNum(h, p.maxHp);
  h = mixNum(h, p.rallyHp);
  h = mixU32(h, p.flaskCharges);
  h = mixU32(h, p.scrolls.brutality);
  h = mixU32(h, p.scrolls.tactics);
  h = mixU32(h, p.scrolls.survival);
  h = mixU32(h, Math.floor(p.gold));
  h = mixU32(h, Math.floor(p.cells));
  h = mixU32(h, p.killStreak);
  h = mixU32(h, p.curseKillsLeft);
  h = mixU32(h, p.speedBuffTicks);
  h = mixStr(h, p.actionState);
  h = mixU32(h, p.comboStep);
  h = mixStr(h, p.attackPhase);
  h = mixU32(h, p.iframeTicks);
  h = mixU32(h, p.parryWindowTicks);
  h = mixStr(h, p.diveSlamState);
  h = mixGear(h, p.loadout.weapon1);
  h = mixGear(h, p.loadout.weapon2);
  h = mixGear(h, p.loadout.skill1);
  h = mixGear(h, p.loadout.skill2);
  h = mixGear(h, p.loadout.amulet);
  h = mixU32(h, p.mutations.length);
  for (let i = 0; i < p.mutations.length; i++) {
    h = mixStr(h, p.mutations[i]!);
  }

  // Enemies
  h = mixU32(h, state.enemies.length);
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i]!;
    h = mixU32(h, e.uid);
    h = mixNum(h, e.pos.x);
    h = mixNum(h, e.pos.y);
    h = mixNum(h, e.hp);
    h = mixStr(h, e.state);
    h = mixU32(h, e.bossPhase);
    h = mixU32(h, e.stunTicks);
  }

  // Projectiles
  h = mixU32(h, state.projectiles.length);
  for (let i = 0; i < state.projectiles.length; i++) {
    const pr = state.projectiles[i]!;
    h = mixU32(h, pr.uid);
    h = mixNum(h, pr.pos.x);
    h = mixNum(h, pr.pos.y);
    h = mixU32(h, pr.ttlTicks);
  }

  // Pickups
  h = mixU32(h, state.pickups.length);
  for (let i = 0; i < state.pickups.length; i++) {
    const pk = state.pickups[i]!;
    h = mixU32(h, pk.uid);
    h = mixBool(h, pk.collected);
    h = mixNum(h, pk.pos.x);
    h = mixNum(h, pk.pos.y);
  }

  // Chests
  h = mixU32(h, state.chests.length);
  for (let i = 0; i < state.chests.length; i++) {
    const c = state.chests[i]!;
    h = mixU32(h, c.uid);
    h = mixBool(h, c.opened);
  }

  // Doors
  h = mixU32(h, state.doors.length);
  for (let i = 0; i < state.doors.length; i++) {
    const d = state.doors[i]!;
    h = mixU32(h, d.uid);
    h = mixBool(h, d.opened);
    h = mixBool(h, d.broken);
  }

  // Boss arena state
  const ba = state.bossArenaState;
  h = mixBool(h, ba.active);
  h = mixStr(h, ba.bossId ?? '');
  h = mixU32(h, ba.bossUid ?? 0);
  h = mixBool(h, ba.defeated);

  // Passage state
  const ps = state.passageState;
  h = mixBool(h, ps.active);
  h = mixBool(h, ps.fountainUsed);
  h = mixBool(h, ps.timedDoorOpen);
  h = mixBool(h, ps.killStreakDoorOpen);

  return (h >>> 0).toString(16).padStart(8, '0');
}
