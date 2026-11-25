// =============================================================================
// KRUNKED CELLS — Master GameApp Shell
// Orchestrates fixed-60Hz SimState, 30/60/120 FPS WebGL2Renderer, AudioEngine,
// InputManager, UIManager, CustomPackLoader, SaveManager, and DebugBridge.
// =============================================================================

import {
  FIXED_DT,
  MAX_BOSS_CELLS,
  SIM_HZ,
  createEmptyInputFrame,
  type ArtPackMode,
  type AudioSettings,
  type BiomeId,
  type BossId,
  type CustomPackStatus,
  type DebugBridge,
  type KeyBindings,
  type PerfStats,
  type RenderSettings,
  type SaveData,
  type SimCommand,
  type SimState,
} from '../contracts';
import { CustomPackLoader } from '../assets';
import { AudioEngine } from '../audio';
import {
  BIOMES,
  BOSSES,
  META_BLUEPRINTS,
  MUTATIONS,
  SKILLS,
  WEAPONS,
  getAffix,
  getBiome,
  getBoss,
  getDifficulty,
  getMutation,
  getSkill,
  getWeapon,
} from '../data';
import { InputManager } from '../input';
import { WebGL2Renderer } from '../render';
import { hashSimState } from '../sim/hash';
import { createInitialSimState, stepSim } from '../sim/step';
import { UIManager, type CatalogLookup } from '../ui';
import { createDebugBridge } from './DebugBridge';
import { SaveManager } from './SaveManager';

function buildCatalogLookup(): CatalogLookup {
  return {
    getWeapon: (id) => {
      try {
        return getWeapon(id);
      } catch {
        return undefined;
      }
    },
    getSkill: (id) => {
      try {
        return getSkill(id);
      } catch {
        return undefined;
      }
    },
    getMutation: (id) => {
      try {
        return getMutation(id);
      } catch {
        return undefined;
      }
    },
    getAffix: (id) => {
      try {
        return getAffix(id);
      } catch {
        return undefined;
      }
    },
    getBiome: (id) => {
      try {
        return getBiome(id);
      } catch {
        return undefined;
      }
    },
    getBoss: (id) => {
      try {
        return getBoss(id);
      } catch {
        return undefined;
      }
    },
    getDifficulty: (bc) => getDifficulty(bc),
    weapons: WEAPONS,
    skills: SKILLS,
    mutations: MUTATIONS,
    biomes: BIOMES,
    bosses: BOSSES,
    metaBlueprints: META_BLUEPRINTS,
  };
}

export class GameApp {
  private canvas: HTMLCanvasElement;
  private saveManager: SaveManager;
  private saveData: SaveData;
  private state: SimState;
  private renderer: WebGL2Renderer;
  private customPackLoader: CustomPackLoader;
  private audio: AudioEngine;
  private input: InputManager;
  private ui: UIManager;
  private debugBridge: DebugBridge;

  private rafId: number | null = null;
  private running = false;
  private lastRafMs = 0;
  private accumulatorSec = 0;
  private lastRenderMs = 0;
  private elapsedSec = 0;
  private lastMusicBiome: BiomeId | null = null;
  private lastMusicBoss = false;
  private prevRunStatus: SimState['runStatus'] = 'title';
  private cachedHash = '00000000';
  private hashDirty = true;

  // Rolling FPS telemetry
  private fpsSamples: number[] = [];
  private currentFps = 60;
  private lastFrameMs = 16.67;

  private resizeHandler: (() => void) | null = null;
  private unlockHandler: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.saveManager = new SaveManager();
    this.saveData = this.saveManager.load();

    // Create initial atmospheric live Prisoner's Quarters background for Title Screen
    this.state = createInitialSimState(
      this.saveData.lastSeed,
      this.saveData.selectedBossCells,
      this.saveData.meta
    );
    this.state.runStatus = 'title';
    this.prevRunStatus = 'title';
    this.cachedHash = hashSimState(this.state);
    this.hashDirty = false;

    this.renderer = new WebGL2Renderer();
    this.customPackLoader = new CustomPackLoader();
    this.audio = new AudioEngine();

    this.debugBridge = createDebugBridge({
      getState: () => this.state,
      startNewRun: (seed, bc) => this.startNewRun(seed ?? this.nextRandomishSeed(), bc ?? this.saveData.selectedBossCells),
      toggleArtPack: (mode) => this.toggleArtPackMode(mode),
      setBossCells: (bc) => this.setBossCells(bc),
      resetSave: () => this.resetSave(),
      getPerfStats: () => this.getPerfStats(),
      onStateMutated: () => this.onExternalStateMutated(),
    });

    const catalog = buildCatalogLookup();

    this.ui = new UIManager(
      {
        onNewRun: (seed, bc) => this.startNewRun(seed, bc),
        onContinueRun: () => this.continueRun(),
        onResume: () => this.resumeRun(),
        onReturnToTitle: () => this.returnToTitle(),
        onRestartRun: () => this.startNewRun(this.nextRandomishSeed(), this.state.bossStemCells),
        onDispatchCommand: (cmd) => this.dispatchCommand(cmd),
        onUpdateRenderSettings: (patch) => this.updateRenderSettings(patch),
        onUpdateAudioSettings: (patch) => this.updateAudioSettings(patch),
        onUpdateKeyBindings: (bindings) => this.updateKeyBindings(bindings),
        onResetKeyBindings: () => this.resetKeyBindings(),
        onLoadCustomPackFolder: () => this.loadCustomPackFolder(),
        onToggleArtPackMode: (mode) => this.toggleArtPackMode(mode),
        onPlayUiClick: (kind) => this.audio.playUiClick(kind),
        onDevWarpBiome: (biomeId) => this.debugBridge.warpBiome(biomeId),
        onDevSpawnBoss: (bossId) => this.debugBridge.spawnBoss(bossId),
        onDevGrantScrolls: (b, t, s) => this.debugBridge.grantScrolls(b, t, s),
        onDevGiveItem: (id) => this.debugBridge.giveItem(id),
        onDevSetGodMode: (enabled) => this.debugBridge.setGodMode(enabled),
        onDevSetBossCells: (bc) => this.debugBridge.setBossCells(bc),
        onDevTriggerCurse: (k) => this.debugBridge.triggerCurse(k),
        onDevStepTicks: (n) => {
          this.debugBridge.stepTicks(n);
        },
        onDevResetSave: () => this.debugBridge.resetSave(),
      },
      catalog,
      { canvas: this.canvas }
    );

    this.input = new InputManager(this.saveData.keyBindings, this.canvas, {
      onToggleDevDrawer: () => {
        this.audio.playUiClick('select');
        this.ui.toggleDevDrawer();
      },
      onTogglePause: () => this.handleEscapeAction(),
      onToggleMap: () => {
        if (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') {
          this.audio.playUiClick('select');
          this.ui.toggleMinimapExpanded();
        }
      },
      onScrollShortcut: (idx) => {
        this.ui.handleScrollShortcut(idx, this.state);
      },
      onLootShortcut: (action) => this.ui.handleLootShortcut(action, this.state),
      isScrollModalOpen: () => this.ui.isScrollModalOpen(this.state),
      isGameplayMouseAllowed: () =>
        (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') &&
        !this.ui.isAnyModalBlockingGameplay(this.state),
      isGameplayKeysAllowed: () =>
        (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') &&
        !this.ui.isAnyModalBlockingGameplay(this.state),
    });

    this.input.setCameraOriginMode('topLeft');
    this.ui.setCameraOriginMode('topLeft');
    this.ui.setInputManager(this.input);
  }

  public getDebugBridge(): DebugBridge {
    return this.debugBridge;
  }

  public async init(): Promise<void> {
    await this.renderer.init(this.canvas, this.saveData.renderSettings);
    this.handleResize();

    this.audio.init(this.saveData.audioSettings);

    // Register global debug bridge
    if (typeof window !== 'undefined') {
      window.__KRUNKED_DEBUG__ = this.debugBridge;
      this.resizeHandler = () => this.handleResize();
      window.addEventListener('resize', this.resizeHandler);

      this.unlockHandler = () => {
        void this.audio.unlock();
        this.syncBiomeMusic(true);
      };
      window.addEventListener('pointerdown', this.unlockHandler, { once: true });
      window.addEventListener('keydown', this.unlockHandler, { once: true });
    }

    // Probe Vite dev custom pack middleware and/or IndexedDB cached pack
    const packStatus = await this.customPackLoader.autoDetect();
    this.applyCustomPackStatus(packStatus);

    this.syncUiSettings();
    this.ui.update(this.state, this.getPerfStats(), 1);
    this.startLoop();
  }

  private applyCustomPackStatus(status: CustomPackStatus): void {
    this.renderer.setCustomPackAvailable(status, this.customPackLoader);
    const useCustom = status.available && this.saveData.renderSettings.artPackMode === 'custom';
    this.audio.setCustomPackResolver(status.available ? this.customPackLoader : null, useCustom);
    // If saved preference was custom but no pack exists right now, fall back visually to builtin without losing preference
    this.renderer.updateSettings({
      ...this.saveData.renderSettings,
      artPackMode: useCustom ? 'custom' : 'builtin',
    });
    this.syncUiSettings();
  }

  private syncUiSettings(): void {
    this.ui.syncSettings(
      this.saveData.renderSettings,
      this.saveData.audioSettings,
      this.saveData.keyBindings,
      this.customPackLoader.getStatus(),
      this.saveData,
      this.renderer.getBackendName()
    );
  }

  private handleResize(): void {
    if (typeof window === 'undefined') return;
    const width = window.innerWidth || 1280;
    const height = window.innerHeight || 720;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(width, height, dpr);
  }

  private nextRandomishSeed(): number {
    // Derived cleanly from previous seed & tick (never affects intra-run determinism)
    const mixed = ((this.saveData.lastSeed * 1664525 + 1013904223 + this.state.tick * 7919) >>> 0) % 899999 + 100000;
    return mixed;
  }

  public startNewRun(seed: number, bossCells: number): void {
    const cleanSeed = Math.max(1, Math.floor(Number.isFinite(seed) ? seed : 133742));
    const maxUnlocked = Math.max(this.saveData.meta.bossCellsUnlocked, this.state.metaSnapshot.bossCellsUnlocked);
    const cleanBc = Math.max(0, Math.min(MAX_BOSS_CELLS, Math.min(Math.max(maxUnlocked, bossCells), bossCells)));

    this.saveData.lastSeed = cleanSeed;
    this.saveData.selectedBossCells = cleanBc;
    this.saveData.hasActiveRun = true;
    this.saveData.meta.totalRuns += 1;
    this.persistSave();

    this.state = createInitialSimState(cleanSeed, cleanBc, this.saveData.meta);
    this.state.runStatus = 'playing';
    this.prevRunStatus = 'playing';
    this.accumulatorSec = 0;
    this.hashDirty = true;

    this.ui.toggleOptions(false);
    this.ui.toggleMinimapExpanded(false);
    this.input.clearTransient();
    this.syncUiSettings();
    this.syncBiomeMusic(true);
    void this.audio.unlock();
    this.ui.showToast(`NEW RUN — SEED #${cleanSeed} (${cleanBc}BC)`, 2.2);
  }

  public continueRun(): void {
    if (this.state.runStatus === 'title' && this.saveData.hasActiveRun) {
      this.state.runStatus = this.state.activeBiomeId === 'Passage' ? 'passage' : 'playing';
      this.prevRunStatus = this.state.runStatus;
      this.input.clearTransient();
      this.syncBiomeMusic(true);
      void this.audio.unlock();
    } else if (this.state.runStatus === 'paused') {
      this.resumeRun();
    } else {
      this.startNewRun(this.saveData.lastSeed, this.saveData.selectedBossCells);
    }
  }

  public resumeRun(): void {
    if (this.state.runStatus === 'paused') {
      this.state.runStatus = this.state.activeBiomeId === 'Passage' ? 'passage' : 'playing';
      this.prevRunStatus = this.state.runStatus;
      this.input.clearTransient();
      this.syncUiSettings();
    }
  }

  public returnToTitle(): void {
    this.persistMetaFromState();
    this.state.runStatus = 'title';
    this.prevRunStatus = 'title';
    this.ui.toggleOptions(false);
    this.ui.toggleMinimapExpanded(false);
    this.input.clearTransient();
    this.syncUiSettings();
    this.syncBiomeMusic(true);
  }

  private handleEscapeAction(): void {
    if (this.ui.handleEscapeKey(this.state)) {
      return;
    }
    if (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') {
      this.audio.playUiClick('select');
      this.state.runStatus = 'paused';
      this.prevRunStatus = 'paused';
      this.input.clearTransient();
      this.syncUiSettings();
    }
  }

  private dispatchCommand(cmd: SimCommand): void {
    this.input.queueCommand(cmd);
    // Execute immediately if paused on a modal (Scroll Picker / Passage NPC) so UI feels instant
    if (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') {
      const frame = createEmptyInputFrame();
      frame.commands = [cmd];
      // Avoid double execution if we dispatch immediately — pop from queue
      this.input.consumeInputFrame(this.state.camera, this.state.player.pos);
      stepSim(this.state, frame);
      this.processPostTickSideEffects();
      this.persistMetaFromState();
      this.hashDirty = true;
    }
  }

  private updateRenderSettings(patch: Partial<RenderSettings>): void {
    this.saveData.renderSettings = {
      ...this.saveData.renderSettings,
      ...patch,
    };
    const status = this.customPackLoader.getStatus();
    const useCustom = status.available && this.saveData.renderSettings.artPackMode === 'custom';
    this.renderer.updateSettings({
      ...this.saveData.renderSettings,
      artPackMode: useCustom ? 'custom' : 'builtin',
    });
    this.audio.setCustomPackResolver(status.available ? this.customPackLoader : null, useCustom);
    this.persistSave();
    this.syncUiSettings();
  }

  private updateAudioSettings(patch: Partial<AudioSettings>): void {
    this.saveData.audioSettings = {
      ...this.saveData.audioSettings,
      ...patch,
    };
    this.audio.updateSettings(this.saveData.audioSettings);
    this.persistSave();
    this.syncUiSettings();
  }

  private updateKeyBindings(bindings: KeyBindings): void {
    this.saveData.keyBindings = { ...bindings };
    this.input.setKeyBindings(this.saveData.keyBindings);
    this.persistSave();
    this.syncUiSettings();
  }

  private resetKeyBindings(): void {
    const reset = this.input.resetKeyBindings();
    this.saveData.keyBindings = reset;
    this.persistSave();
    this.syncUiSettings();
  }

  private async loadCustomPackFolder(): Promise<CustomPackStatus> {
    const status = await this.customPackLoader.pickCustomPackFolder();
    if (status.available) {
      this.saveData.renderSettings.artPackMode = 'custom';
      this.persistSave();
      this.applyCustomPackStatus(status);
      this.syncBiomeMusic(true);
      this.ui.showToast(`CUSTOM PACK LOADED (${status.atlasCount} ATLASES)`, 2.8);
    } else {
      this.ui.showToast('NO CUSTOM PACK SELECTED — USING BUILT-IN ART', 2.4);
    }
    return status;
  }

  private toggleArtPackMode(mode?: ArtPackMode): ArtPackMode {
    const status = this.customPackLoader.getStatus();
    const desired: ArtPackMode =
      mode ?? (this.saveData.renderSettings.artPackMode === 'custom' ? 'builtin' : 'custom');

    if (desired === 'custom' && !status.available) {
      this.saveData.renderSettings.artPackMode = 'builtin';
      this.ui.showToast('LOAD A CUSTOM PACK FOLDER FIRST (USING BUILT-IN ART)', 2.4);
    } else {
      this.saveData.renderSettings.artPackMode = desired;
      this.ui.showToast(
        desired === 'custom' ? 'ART MODE: OWNED CUSTOM PACK' : 'ART MODE: BUILT-IN KRUNKED ART',
        2.0
      );
    }

    this.applyCustomPackStatus(status);
    this.persistSave();
    this.syncBiomeMusic(true);
    return this.saveData.renderSettings.artPackMode;
  }

  private setBossCells(bc: number): void {
    const clamped = Math.max(0, Math.min(MAX_BOSS_CELLS, Math.floor(bc)));
    if (clamped > this.saveData.meta.bossCellsUnlocked) {
      this.saveData.meta.bossCellsUnlocked = clamped;
      this.state.metaSnapshot.bossCellsUnlocked = clamped;
    }
    this.saveData.selectedBossCells = clamped;
    this.state.bossStemCells = clamped;
    this.persistSave();
    this.syncUiSettings();
  }

  private resetSave(): void {
    this.saveData = this.saveManager.reset();
    this.state = createInitialSimState(
      this.saveData.lastSeed,
      this.saveData.selectedBossCells,
      this.saveData.meta
    );
    this.state.runStatus = 'title';
    this.prevRunStatus = 'title';
    this.input.setKeyBindings(this.saveData.keyBindings);
    this.audio.updateSettings(this.saveData.audioSettings);
    this.applyCustomPackStatus(this.customPackLoader.getStatus());
    this.hashDirty = true;
    this.ui.showToast('SAVE DATA RESET TO DEFAULT', 2.2);
  }

  private persistMetaFromState(): void {
    const m = this.state.metaSnapshot;
    this.saveData.meta = {
      bossCellsUnlocked: Math.max(this.saveData.meta.bossCellsUnlocked, m.bossCellsUnlocked),
      flaskTier: Math.max(this.saveData.meta.flaskTier, m.flaskTier),
      goldReserveTier: Math.max(this.saveData.meta.goldReserveTier, m.goldReserveTier),
      randomStarterUnlocked: this.saveData.meta.randomStarterUnlocked || m.randomStarterUnlocked,
      recycleUnlocked: this.saveData.meta.recycleUnlocked || m.recycleUnlocked,
      unlockedBlueprints: Array.from(
        new Set([...this.saveData.meta.unlockedBlueprints, ...m.unlockedBlueprints])
      ),
      blueprintProgress: { ...m.blueprintProgress },
      runesUnlocked: { ...m.runesUnlocked },
      totalRuns: Math.max(this.saveData.meta.totalRuns, m.totalRuns),
      totalKills: Math.max(this.saveData.meta.totalKills, m.totalKills),
      bestClearTicks:
        m.bestClearTicks !== null &&
        (this.saveData.meta.bestClearTicks === null || m.bestClearTicks < this.saveData.meta.bestClearTicks)
          ? m.bestClearTicks
          : this.saveData.meta.bestClearTicks,
    };
    this.persistSave();
  }

  private persistSave(): void {
    this.saveData = this.saveManager.save(this.saveData);
  }

  private onExternalStateMutated(): void {
    this.hashDirty = true;
    this.processPostTickSideEffects();
    this.persistMetaFromState();
    this.syncBiomeMusic(false);
    this.syncUiSettings();
  }

  private processPostTickSideEffects(): void {
    if (this.state.events.length > 0) {
      this.renderer.ingestEvents(this.state.events, this.state);
      this.audio.ingestEvents(this.state.events, this.state.player.pos.x, this.state.player.pos.y);
      this.ui.ingestEvents(this.state.events, this.state);
    }

    if (this.state.runStatus !== this.prevRunStatus) {
      if (this.state.runStatus === 'dead' || this.state.runStatus === 'victory') {
        this.saveData.hasActiveRun = false;
        this.persistMetaFromState();
      }
      this.prevRunStatus = this.state.runStatus;
      this.syncUiSettings();
    }

    this.syncBiomeMusic(false);
  }

  private syncBiomeMusic(force: boolean): void {
    const isBoss =
      this.state.bossArenaState.active &&
      !this.state.bossArenaState.defeated &&
      this.state.runStatus === 'playing';
    const musicBiome: BiomeId =
      this.state.runStatus === 'title' ? 'PrisonStart' : this.state.activeBiomeId;

    if (force || musicBiome !== this.lastMusicBiome || isBoss !== this.lastMusicBoss) {
      this.lastMusicBiome = musicBiome;
      this.lastMusicBoss = isBoss;
      this.audio.setBiomeMusic(musicBiome, isBoss);
    }
  }

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.lastRafMs = typeof performance !== 'undefined' ? performance.now() : 0;
    this.lastRenderMs = this.lastRafMs;

    const frame = (nowMs: number): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);

      const rawDtSec = Math.max(0, Math.min(0.1, (nowMs - this.lastRafMs) / 1000));
      this.lastRafMs = nowMs;
      this.elapsedSec += rawDtSec;

      // 1. Fixed 60 Hz deterministic simulation ticks
      if (this.state.runStatus === 'playing' || this.state.runStatus === 'passage') {
        this.accumulatorSec += rawDtSec;
        let steps = 0;
        const maxSteps = 5;
        while (this.accumulatorSec >= FIXED_DT && steps < maxSteps) {
          const inputFrame = this.input.consumeInputFrame(this.state.camera, this.state.player.pos);
          stepSim(this.state, inputFrame);
          this.processPostTickSideEffects();
          this.accumulatorSec -= FIXED_DT;
          this.hashDirty = true;
          steps++;
        }
        if (steps === maxSteps && this.accumulatorSec > FIXED_DT * 2) {
          this.accumulatorSec = 0;
        }
      } else {
        // Still drain any pending UI commands safely when not advancing combat
        this.input.consumeInputFrame(this.state.camera, this.state.player.pos);
        this.accumulatorSec = 0;
      }

      // 2. Decoupled Render Pacing (30 / 60 / 120 FPS, default 120)
      const targetFps = this.saveData.renderSettings.targetFps;
      const minRenderIntervalMs = targetFps >= 120 ? 0 : 1000 / targetFps - 0.5;
      const sinceRenderMs = nowMs - this.lastRenderMs;

      if (sinceRenderMs >= minRenderIntervalMs) {
        this.lastFrameMs = sinceRenderMs > 0 ? sinceRenderMs : 16.67;
        this.lastRenderMs = nowMs;

        this.fpsSamples.push(1000 / Math.max(1, this.lastFrameMs));
        if (this.fpsSamples.length > 30) this.fpsSamples.shift();
        let sum = 0;
        for (let i = 0; i < this.fpsSamples.length; i++) sum += this.fpsSamples[i]!;
        this.currentFps = Math.round(sum / this.fpsSamples.length);

        const interpAlpha =
          this.saveData.renderSettings.snapToSimRate ||
          (this.state.runStatus !== 'playing' && this.state.runStatus !== 'passage')
            ? 1
            : Math.max(0, Math.min(1, this.accumulatorSec / FIXED_DT));

        this.renderer.render(this.state, interpAlpha, this.elapsedSec);
        this.ui.update(this.state, this.getPerfStats(), interpAlpha);
      }
    };

    this.rafId = requestAnimationFrame(frame);
  }

  public getPerfStats(): PerfStats {
    if (this.hashDirty) {
      this.cachedHash = hashSimState(this.state);
      this.hashDirty = false;
    }
    const status = this.customPackLoader.getStatus();
    const activeArtMode: ArtPackMode =
      status.available && this.saveData.renderSettings.artPackMode === 'custom'
        ? 'custom'
        : 'builtin';

    return {
      fps: this.currentFps,
      targetFps: this.saveData.renderSettings.targetFps,
      simHz: SIM_HZ,
      frameTimeMs: Math.round(this.lastFrameMs * 100) / 100,
      drawCalls: this.renderer.getDrawCallCount(),
      activeLights: this.renderer.getActiveLightCount(),
      enemyCount: this.state.enemies.filter((e) => e.state !== 'dead' && e.hp > 0).length,
      particleCount: this.state.particlesSim.length,
      artPackMode: activeArtMode,
      customPackLoaded: status.available,
      stateHash: this.cachedHash,
    };
  }

  public dispose(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (typeof window !== 'undefined') {
      if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
      if (this.unlockHandler) {
        window.removeEventListener('pointerdown', this.unlockHandler);
        window.removeEventListener('keydown', this.unlockHandler);
      }
    }
    this.input.dispose();
    this.ui.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }
}
