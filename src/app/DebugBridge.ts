// =============================================================================
// KRUNKED CELLS — DebugBridge (`window.__KRUNKED_DEBUG__`)
// Exposes deterministic state inspection, tick stepping, biome/boss warps,
// scroll/item/curse cheats, art pack switching, and live telemetry.
// =============================================================================

import {
  MAX_BOSS_CELLS,
  createEmptyInputFrame,
  type ArtPackMode,
  type BiomeId,
  type BossId,
  type DebugBridge,
  type InputFrame,
  type PerfStats,
  type SimCommand,
  type SimState,
} from '../contracts';
import { SKILL_MAP, WEAPON_MAP } from '../data';
import { hashSimState } from '../sim/hash';
import { createRng } from '../sim/prng';
import { applyScrollPickup, rollGearInstance, triggerCurse } from '../sim/roguelite';
import { spawnBossEncounter, stepSim, warpToBiome } from '../sim/step';

export interface DebugBridgeHost {
  getState(): SimState;
  startNewRun(seed?: number, bossCells?: number): void;
  toggleArtPack(mode?: ArtPackMode): ArtPackMode;
  setBossCells(bc: number): void;
  resetSave(): void;
  getPerfStats(): PerfStats;
  onStateMutated(): void;
}

export function createDebugBridge(host: DebugBridgeHost): DebugBridge {
  const bridge: DebugBridge = {
    getState(): SimState {
      return host.getState();
    },

    getHash(): string {
      return hashSimState(host.getState());
    },

    stepTicks(n: number, partialInput?: Partial<InputFrame>): string {
      const count = Math.max(0, Math.min(36000, Math.floor(n)));
      const state = host.getState();
      const baseInput: InputFrame = {
        ...createEmptyInputFrame(),
        ...(partialInput ?? {}),
      };
      for (let i = 0; i < count; i++) {
        // Commands only dispatch on first tick of a batch
        const frame: InputFrame =
          i === 0 ? baseInput : { ...baseInput, commands: undefined };
        stepSim(state, frame);
      }
      host.onStateMutated();
      return hashSimState(state);
    },

    warpBiome(biomeId: BiomeId): void {
      const state = host.getState();
      if (state.runStatus === 'title' || state.runStatus === 'dead' || state.runStatus === 'victory') {
        host.startNewRun(state.runSeed, state.bossStemCells);
      }
      const active = host.getState();
      warpToBiome(active, biomeId);
      host.onStateMutated();
    },

    spawnBoss(bossId: BossId): void {
      const state = host.getState();
      if (state.runStatus === 'title' || state.runStatus === 'dead' || state.runStatus === 'victory') {
        host.startNewRun(state.runSeed, state.bossStemCells);
      }
      const active = host.getState();
      spawnBossEncounter(active, bossId);
      host.onStateMutated();
    },

    grantScrolls(brutality: number, tactics: number, survival: number): void {
      const state = host.getState();
      const b = Math.max(0, Math.min(40, Math.floor(brutality)));
      const t = Math.max(0, Math.min(40, Math.floor(tactics)));
      const s = Math.max(0, Math.min(40, Math.floor(survival)));
      for (let i = 0; i < b; i++) applyScrollPickup(state, 'brutality');
      for (let i = 0; i < t; i++) applyScrollPickup(state, 'tactics');
      for (let i = 0; i < s; i++) applyScrollPickup(state, 'survival');
      host.onStateMutated();
    },

    giveItem(itemId: string): void {
      const state = host.getState();
      const rng = createRng(state.rngState);
      const isWeapon = Object.prototype.hasOwnProperty.call(WEAPON_MAP, itemId);
      const isSkill = Object.prototype.hasOwnProperty.call(SKILL_MAP, itemId);
      const slotKind: 'weapon' | 'skill' = isSkill && !isWeapon ? 'skill' : 'weapon';
      const gearLevel = Math.max(1, 2 + state.bossStemCells + state.biomesVisited.length);
      const gear = rollGearInstance(
        state,
        rng,
        slotKind,
        gearLevel,
        undefined,
        false,
        isWeapon || isSkill ? itemId : undefined
      );
      state.rngState = rng.getState();

      if (slotKind === 'weapon') {
        const def = WEAPON_MAP[gear.defId];
        if (def?.kind === 'shield') {
          state.player.loadout.weapon2 = gear;
        } else {
          state.player.loadout.weapon1 = gear;
        }
      } else if (!state.player.loadout.skill1) {
        state.player.loadout.skill1 = gear;
      } else {
        state.player.loadout.skill2 = gear;
      }

      state.events.push({
        type: 'itemPickup',
        x: state.player.pos.x,
        y: state.player.pos.y,
        itemId: gear.defId,
      });
      host.onStateMutated();
    },

    setGodMode(enabled: boolean): void {
      const state = host.getState();
      state.player.godMode = Boolean(enabled);
      if (state.player.godMode) {
        state.player.hp = state.player.maxHp;
      }
      host.onStateMutated();
    },

    setBossCells(bc: number): void {
      const clamped = Math.max(0, Math.min(MAX_BOSS_CELLS, Math.floor(bc)));
      host.setBossCells(clamped);
    },

    toggleArtPack(mode?: ArtPackMode): ArtPackMode {
      return host.toggleArtPack(mode);
    },

    triggerCurse(kills = 10): void {
      const state = host.getState();
      triggerCurse(state, Math.max(1, Math.floor(kills)));
      host.onStateMutated();
    },

    resetSave(): void {
      host.resetSave();
    },

    getPerfStats(): PerfStats {
      return host.getPerfStats();
    },

    dispatchCommand(cmd: SimCommand): void {
      const state = host.getState();
      stepSim(state, { ...createEmptyInputFrame(), commands: [cmd] });
      host.onStateMutated();
    },

    startNewRun(seed?: number, bossCells?: number): void {
      host.startNewRun(seed, bossCells);
    },
  };

  return bridge;
}
