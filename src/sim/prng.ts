// =============================================================================
// KRUNKED CELLS — Deterministic PRNG (SplitMix32 Seeder + xoshiro128**)
// Pure simulation module: strictly deterministic, zero browser/DOM/clock dependencies.
// =============================================================================

import type { RngAPI, RngState } from '../contracts';

const FALLBACK_WORDS: readonly [number, number, number, number] = [
  0x9e3779b9,
  0x85ebca6b,
  0xc2b2ae35,
  0x27d4eb2f,
];

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function splitMix32Next(state: number): [number, number] {
  const next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return [next, z];
}

/**
 * Expands a numeric seed into 4 non-zero 32-bit unsigned words using SplitMix32.
 */
export function seedToRngState(seed: number): RngState {
  let acc = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 133742;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;

  [acc, s0] = splitMix32Next(acc);
  [acc, s1] = splitMix32Next(acc);
  [acc, s2] = splitMix32Next(acc);
  [, s3] = splitMix32Next(acc);

  if (s0 === 0) s0 = FALLBACK_WORDS[0];
  if (s1 === 0) s1 = FALLBACK_WORDS[1];
  if (s2 === 0) s2 = FALLBACK_WORDS[2];
  if (s3 === 0) s3 = FALLBACK_WORDS[3];

  return { s0, s1, s2, s3 };
}

/**
 * Creates a deterministic xoshiro128** PRNG instance from either a numeric seed
 * or a persisted `RngState`. Call `getState()` at the end of every tick/pass to
 * persist exact replay state back into `SimState.rngState`.
 */
export function createRng(seedOrState: number | RngState): RngAPI {
  const initial =
    typeof seedOrState === 'number'
      ? seedToRngState(seedOrState)
      : {
          s0: seedOrState.s0 >>> 0,
          s1: seedOrState.s1 >>> 0,
          s2: seedOrState.s2 >>> 0,
          s3: seedOrState.s3 >>> 0,
        };

  let s0 = initial.s0;
  let s1 = initial.s1;
  let s2 = initial.s2;
  let s3 = initial.s3;

  // Guard against degenerate all-zero state
  if ((s0 | s1 | s2 | s3) === 0) {
    s0 = FALLBACK_WORDS[0];
    s1 = FALLBACK_WORDS[1];
    s2 = FALLBACK_WORDS[2];
    s3 = FALLBACK_WORDS[3];
  }

  function nextU32(): number {
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;

    s2 = (s2 ^ t) >>> 0;
    s3 = rotl32(s3, 11);

    return result;
  }

  function nextFloat(): number {
    return nextU32() / 4294967296;
  }

  function rangeInt(minInclusive: number, maxInclusive: number): number {
    const lo = Math.ceil(Math.min(minInclusive, maxInclusive));
    const hi = Math.floor(Math.max(minInclusive, maxInclusive));
    if (hi <= lo) return lo;
    const span = hi - lo + 1;
    return lo + (nextU32() % span);
  }

  function rangeFloat(min: number, max: number): number {
    return min + nextFloat() * (max - min);
  }

  function chance(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return nextFloat() < probability;
  }

  function pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('RngAPI.pick called on an empty array');
    }
    return items[nextU32() % items.length]!;
  }

  function getState(): RngState {
    return { s0, s1, s2, s3 };
  }

  return {
    nextU32,
    nextFloat,
    rangeInt,
    rangeFloat,
    chance,
    pick,
    getState,
  };
}
