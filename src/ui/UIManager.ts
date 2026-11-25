// =============================================================================
// KRUNKED CELLS — Master UI Manager
// Orchestrates Title Screen, Pause Menu, Options Modal, Scroll Picker,
// Run Summary, HUD, Minimap, Passage Modal, and F9 Dev Drawer.
// =============================================================================

import {
  ArtPackMode,
  AudioSettings,
  BiomeId,
  BossId,
  CustomPackStatus,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_RENDER_SETTINGS,
  KeyBindings,
  LightingQuality,
  MAX_BOSS_CELLS,
  MetaSnapshot,
  PerfStats,
  RenderSettings,
  SaveData,
  ScrollStat,
  SimCommand,
  SimEvent,
  SimState,
  TargetFps,
  createDefaultMetaSnapshot,
} from '../contracts';
import { CameraOriginMode, InputManager, KeyAction } from '../input';
import { DevDrawer } from './DevDrawer';
import {
  CatalogLookup,
  HudOverlay,
  computeScrollHpGainPct,
  escapeHtml,
  formatKeyCode,
  formatTimer,
  getBiomeDisplayName,
  getScrollDamagePct,
} from './HudOverlay';
import { Minimap } from './Minimap';
import { PassageModal } from './PassageModal';

export interface UICallbacks {
  onNewRun(seed: number, bossCells: number): void;
  onContinueRun(): void;
  onResume(): void;
  onReturnToTitle(): void;
  onRestartRun(): void;
  onDispatchCommand(cmd: SimCommand): void;
  onUpdateRenderSettings(patch: Partial<RenderSettings>): void;
  onUpdateAudioSettings(patch: Partial<AudioSettings>): void;
  onUpdateKeyBindings(bindings: KeyBindings): void;
  onResetKeyBindings(): void;
  onLoadCustomPackFolder(): Promise<CustomPackStatus | void> | void;
  onToggleArtPackMode(mode?: ArtPackMode): ArtPackMode | void;
  onPlayUiClick?(kind?: 'select' | 'confirm' | 'cancel' | 'error'): void;
  // Optional F9 Dev Drawer hooks (fallback cleanly to window.__KRUNKED_DEBUG__)
  onDevWarpBiome?(biomeId: BiomeId): void;
  onDevSpawnBoss?(bossId: BossId): void;
  onDevGrantScrolls?(brutality: number, tactics: number, survival: number): void;
  onDevGiveItem?(itemId: string): void;
  onDevSetGodMode?(enabled: boolean): void;
  onDevSetBossCells?(bc: number): void;
  onDevTriggerCurse?(kills?: number): void;
  onDevStepTicks?(ticks: number): void;
  onDevResetSave?(): void;
}

export interface UIContainers {
  hudRoot?: HTMLElement | null;
  uiRoot?: HTMLElement | null;
  canvas?: HTMLCanvasElement | null;
}

const KEYBIND_LABELS: ReadonlyArray<{ action: KeyAction; label: string }> = [
  { action: 'moveLeft', label: 'Move Left' },
  { action: 'moveRight', label: 'Move Right' },
  { action: 'moveUp', label: 'Climb / Up' },
  { action: 'moveDown', label: 'Crouch / Drop' },
  { action: 'jump', label: 'Jump / Dive-Slam' },
  { action: 'roll', label: 'Dodge Roll' },
  { action: 'weapon1', label: 'Weapon Slot 1' },
  { action: 'weapon2', label: 'Weapon Slot 2 / Shield' },
  { action: 'skill1', label: 'Skill Slot 1' },
  { action: 'skill2', label: 'Skill Slot 2' },
  { action: 'heal', label: 'Health Flask' },
  { action: 'interact', label: 'Interact / Equip' },
  { action: 'map', label: 'Expand Map' },
  { action: 'pause', label: 'Pause / Back' },
];

export class UIManager {
  private callbacks: UICallbacks;
  private catalog?: CatalogLookup;
  private inputManager: InputManager | null = null;

  private hudRoot: HTMLElement | null;
  private uiRoot: HTMLElement | null;
  private canvas: HTMLCanvasElement | null;

  private hud: HudOverlay | null = null;
  private minimap: Minimap | null = null;
  private passageModal: PassageModal | null = null;
  private devDrawer: DevDrawer | null = null;

  // Managed modal layers inside #ui-root
  private titleLayer: HTMLDivElement | null = null;
  private pauseLayer: HTMLDivElement | null = null;
  private optionsLayer: HTMLDivElement | null = null;
  private scrollLayer: HTMLDivElement | null = null;
  private summaryLayer: HTMLDivElement | null = null;

  // Synced app settings & metadata
  private renderSettings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  private audioSettings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private keyBindings: KeyBindings = { ...DEFAULT_KEY_BINDINGS };
  private customPackStatus: CustomPackStatus = {
    available: false,
    source: 'none',
    atlasCount: 0,
    audioCount: 0,
    loadedAtlases: [],
  };
  private metaSnapshot: MetaSnapshot = createDefaultMetaSnapshot();
  private hasActiveRun = false;
  private selectedBossCells = 0;
  private customSeed = 133742;
  private backendName: 'webgl2' | 'canvas2d-fallback' = 'webgl2';

  // Modal state flags & dirty signatures
  private optionsOpen = false;
  private capturingKeyAction: KeyAction | null = null;
  private standaloneCaptureListener: ((e: KeyboardEvent) => void) | null = null;

  private lastTitleSig = '';
  private lastPauseSig = '';
  private lastOptionsSig = '';
  private lastScrollSig = '';
  private lastSummarySig = '';
  private lastFrameMs = 0;
  private lastSimState: SimState | null = null;

  constructor(callbacks: UICallbacks, catalog?: CatalogLookup, containers?: UIContainers) {
    this.callbacks = callbacks;
    this.catalog = catalog;

    if (typeof document === 'undefined') {
      this.hudRoot = null;
      this.uiRoot = null;
      this.canvas = null;
      return;
    }

    this.hudRoot = containers?.hudRoot ?? document.getElementById('hud-root');
    this.uiRoot = containers?.uiRoot ?? document.getElementById('ui-root');
    this.canvas =
      containers?.canvas ?? (document.getElementById('game-canvas') as HTMLCanvasElement | null);

    if (this.hudRoot && this.uiRoot) {
      this.hud = new HudOverlay(
        this.hudRoot,
        this.canvas,
        {
          onDispatchCommand: (cmd) => this.callbacks.onDispatchCommand(cmd),
          onPlayUiClick: (kind) => this.callbacks.onPlayUiClick?.(kind),
          onToggleMinimap: () => this.toggleMinimapExpanded(),
        },
        this.catalog
      );

      this.minimap = new Minimap(
        this.hud.getMinimapHost(),
        this.uiRoot,
        {
          onDispatchCommand: (cmd) => this.callbacks.onDispatchCommand(cmd),
          onPlayUiClick: (kind) => this.callbacks.onPlayUiClick?.(kind),
        },
        this.catalog
      );

      this.passageModal = new PassageModal(
        this.uiRoot,
        {
          onDispatchCommand: (cmd) => this.callbacks.onDispatchCommand(cmd),
          onPlayUiClick: (kind) => this.callbacks.onPlayUiClick?.(kind),
        },
        this.catalog
      );

      this.titleLayer = this.createLayer(this.uiRoot, 'kc-modal-backdrop kc-title-backdrop kc-hidden');
      this.scrollLayer = this.createLayer(this.uiRoot, 'kc-modal-backdrop kc-hidden');
      this.pauseLayer = this.createLayer(this.uiRoot, 'kc-modal-backdrop kc-hidden');
      this.summaryLayer = this.createLayer(this.uiRoot, 'kc-modal-backdrop kc-hidden');
      this.optionsLayer = this.createLayer(this.uiRoot, 'kc-modal-backdrop kc-hidden');

      this.devDrawer = new DevDrawer(
        this.uiRoot,
        {
          onWarpBiome: this.callbacks.onDevWarpBiome,
          onSpawnBoss: this.callbacks.onDevSpawnBoss,
          onGrantScrolls: this.callbacks.onDevGrantScrolls,
          onGiveItem: this.callbacks.onDevGiveItem,
          onSetGodMode: this.callbacks.onDevSetGodMode,
          onSetBossCells: this.callbacks.onDevSetBossCells,
          onTriggerCurse: this.callbacks.onDevTriggerCurse,
          onToggleArtPackMode: (m) => this.callbacks.onToggleArtPackMode(m),
          onStepTicks: this.callbacks.onDevStepTicks,
          onResetSave: this.callbacks.onDevResetSave,
          onPlayUiClick: (kind) => this.callbacks.onPlayUiClick?.(kind),
        },
        this.catalog
      );
    }
  }

  public setInputManager(input: InputManager): void {
    this.inputManager = input;
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
    this.hud?.setCatalog(catalog);
    this.minimap?.setCatalog(catalog);
    this.passageModal?.setCatalog(catalog);
    this.devDrawer?.setCatalog(catalog);
  }

  public setCameraOriginMode(mode: CameraOriginMode): void {
    this.hud?.setCameraOriginMode(mode);
  }

  public syncSettings(
    renderSettings: RenderSettings,
    audioSettings: AudioSettings,
    keyBindings: KeyBindings,
    customPackStatus?: CustomPackStatus,
    saveData?: Partial<SaveData>,
    backendName?: 'webgl2' | 'canvas2d-fallback'
  ): void {
    this.renderSettings = { ...renderSettings };
    this.audioSettings = { ...audioSettings };
    this.keyBindings = { ...keyBindings };
    if (customPackStatus) this.customPackStatus = { ...customPackStatus };
    if (saveData?.meta) this.metaSnapshot = saveData.meta;
    if (saveData?.hasActiveRun !== undefined) this.hasActiveRun = saveData.hasActiveRun;
    if (saveData?.selectedBossCells !== undefined) {
      this.selectedBossCells = Math.max(
        0,
        Math.min(this.metaSnapshot.bossCellsUnlocked, saveData.selectedBossCells)
      );
    }
    if (saveData?.lastSeed !== undefined && this.lastTitleSig === '') {
      this.customSeed = saveData.lastSeed;
    }
    if (backendName) this.backendName = backendName;

    this.lastTitleSig = '';
    this.lastOptionsSig = '';
  }

  public ingestEvents(events: readonly SimEvent[], state: SimState): void {
    this.hud?.ingestEvents(events, state);
  }

  public showToast(text: string, durationSec = 2.4): void {
    this.hud?.showToast(text, durationSec);
  }

  public toggleDevDrawer(force?: boolean): boolean {
    return this.devDrawer?.toggle(force) ?? false;
  }

  public isDevDrawerOpen(): boolean {
    return this.devDrawer?.isOpen() ?? false;
  }

  public toggleMinimapExpanded(force?: boolean): boolean {
    if (!this.minimap) return false;
    if (this.lastSimState && this.lastSimState.runStatus === 'title') {
      return this.minimap.toggleExpanded(false);
    }
    return this.minimap.toggleExpanded(force);
  }

  public isMinimapExpanded(): boolean {
    return this.minimap?.isExpanded() ?? false;
  }

  public toggleOptions(force?: boolean): boolean {
    const next = force !== undefined ? force : !this.optionsOpen;
    if (!next) this.cancelRebindCapture();
    this.optionsOpen = next;
    this.lastOptionsSig = '';
    this.lastTitleSig = '';
    this.lastPauseSig = '';
    return this.optionsOpen;
  }

  public isOptionsOpen(): boolean {
    return this.optionsOpen;
  }

  public isScrollModalOpen(state?: SimState): boolean {
    const s = state ?? this.lastSimState;
    return Boolean(s && s.pendingScroll !== null && s.runStatus !== 'title');
  }

  public isAnyModalBlockingGameplay(state?: SimState): boolean {
    const s = state ?? this.lastSimState;
    if (this.optionsOpen) return true;
    if (this.isMinimapExpanded()) return true;
    if (this.passageModal?.isOpen()) return true;
    if (!s) return false;
    if (s.pendingScroll !== null) return true;
    return s.runStatus !== 'playing' && s.runStatus !== 'passage';
  }

  /**
   * Handles Escape/Pause hierarchy cleanly:
   * Options -> Minimap -> Passage Modal -> returns false so GameApp toggles Pause.
   */
  public handleEscapeKey(state: SimState): boolean {
    if (this.capturingKeyAction !== null) {
      this.cancelRebindCapture();
      return true;
    }
    if (this.optionsOpen) {
      this.callbacks.onPlayUiClick?.('cancel');
      this.toggleOptions(false);
      return true;
    }
    if (this.minimap?.isExpanded()) {
      this.callbacks.onPlayUiClick?.('cancel');
      this.minimap.toggleExpanded(false);
      return true;
    }
    if (this.passageModal?.isOpen()) {
      this.passageModal.close();
      return true;
    }
    if (state.runStatus === 'paused') {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onResume();
      return true;
    }
    return false;
  }

  public handleScrollShortcut(index: 0 | 1 | 2, state?: SimState): boolean {
    const s = state ?? this.lastSimState;
    if (!s || !s.pendingScroll) return false;
    const choice = s.pendingScroll.choices[index];
    if (!choice) return false;
    this.callbacks.onPlayUiClick?.('confirm');
    this.callbacks.onDispatchCommand({ type: 'pickScroll', stat: choice });
    return true;
  }

  public handleLootShortcut(action: 'equip1' | 'equip2' | 'recycle', state?: SimState): boolean {
    const s = state ?? this.lastSimState;
    if (!s || this.isAnyModalBlockingGameplay(s)) return false;
    return this.hud?.triggerQuickLootAction(action, s) ?? false;
  }

  public update(state: SimState, perf?: PerfStats, interpAlpha = 1): void {
    this.lastSimState = state;
    this.metaSnapshot = state.metaSnapshot;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dtSec = this.lastFrameMs > 0 ? Math.min(0.1, Math.max(0.001, (now - this.lastFrameMs) / 1000)) : 1 / 60;
    this.lastFrameMs = now;

    this.hud?.update(state, this.keyBindings, dtSec, interpAlpha);
    this.minimap?.update(state, dtSec);
    this.passageModal?.update(state);
    this.devDrawer?.update(state, perf, this.backendName);

    this.updateTitleScreen(state);
    this.updateScrollModal(state);
    this.updatePauseMenu(state);
    this.updateSummaryModal(state);
    this.updateOptionsModal();
  }

  public dispose(): void {
    this.cancelRebindCapture();
    this.hud?.dispose();
    this.minimap?.dispose();
    this.passageModal?.dispose();
    this.devDrawer?.dispose();
    this.titleLayer?.remove();
    this.scrollLayer?.remove();
    this.pauseLayer?.remove();
    this.summaryLayer?.remove();
    this.optionsLayer?.remove();
  }

  private createLayer(parent: HTMLElement, className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    parent.appendChild(el);
    return el;
  }

  // ===========================================================================
  // 1. Title Screen
  // ===========================================================================

  private updateTitleScreen(state: SimState): void {
    if (!this.titleLayer) return;
    const show = state.runStatus === 'title' && !this.optionsOpen;
    this.titleLayer.classList.toggle('kc-hidden', !show);
    if (!show) return;

    const sig = `bc${this.selectedBossCells}/${this.metaSnapshot.bossCellsUnlocked}|cont${this.hasActiveRun}|art${this.renderSettings.artPackMode}|pack${this.customPackStatus.available}:${this.customPackStatus.atlasCount}:${this.customPackStatus.audioCount}|runs${this.metaSnapshot.totalRuns}`;
    if (sig === this.lastTitleSig) return;
    this.lastTitleSig = sig;

    const unlockedBc = this.metaSnapshot.bossCellsUnlocked;
    const bcButtonsHtml = Array.from({ length: MAX_BOSS_CELLS + 1 }, (_, bc) => {
      const locked = bc > unlockedBc;
      const selected = bc === this.selectedBossCells;
      return `<button class="kc-bc-btn ${selected ? 'is-selected' : ''}" data-title-bc="${bc}" ${locked ? 'disabled' : ''} title="${locked ? 'Defeat Final Boss to unlock' : `${bc} Boss Stem Cells`}">${bc}BC</button>`;
    }).join('');

    const isCustom = this.renderSettings.artPackMode === 'custom';
    const packLabel = this.customPackStatus.available
      ? `Pack Ready (${this.customPackStatus.atlasCount} atlases, ${this.customPackStatus.audioCount} audio)`
      : 'No Custom Pack Loaded';

    this.titleLayer.innerHTML = `
      <div class="kc-title-card kc-iron-panel">
        <h1 class="kc-game-logo">Krunked Cells</h1>
        <div class="kc-game-tagline">Normal-Mapped Gothic Action Roguelite</div>

        <div class="kc-title-config">
          <div class="kc-config-row">
            <span>Boss Stem Cells</span>
            <div class="kc-bc-selector">${bcButtonsHtml}</div>
          </div>
          <div class="kc-config-row">
            <span>Custom Run Seed</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input class="kc-input" data-el="seed-input" type="number" value="${this.customSeed}" style="width:128px" />
              <button class="kc-btn kc-btn-sm" data-act="rand-seed" title="Randomize Seed">🎲</button>
            </div>
          </div>
        </div>

        <div class="kc-title-actions">
          <button class="kc-btn kc-btn-primary kc-btn-span2" data-act="new-run">⚔ New Run</button>
          <button class="kc-btn" data-act="continue" ${this.hasActiveRun ? '' : 'disabled'}>Continue Run</button>
          <button class="kc-btn" data-act="options">⚙ Options</button>
        </div>

        <div class="kc-pack-bar">
          <div class="kc-pack-status">
            <div><strong>${isCustom ? 'CUSTOM PACK ACTIVE' : 'BUILT-IN ART ACTIVE'}</strong></div>
            <div>${escapeHtml(packLabel)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="kc-btn kc-btn-sm kc-btn-cyan" data-act="load-pack">Load Custom Pack</button>
            <button class="kc-btn kc-btn-sm" data-act="toggle-art">
              ${isCustom ? 'Use Built-In Art' : 'Use Custom Pack'}
            </button>
          </div>
        </div>

        <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
          <span>WASD Move</span>
          <span>Space Jump</span>
          <span>Shift Roll</span>
          <span>LMB/J & RMB/K Weapons</span>
          <span>Q/E Skills</span>
          <span>Tab Map</span>
          <span>F9 Dev</span>
        </div>
      </div>
    `;

    const seedInput = this.titleLayer.querySelector('[data-el="seed-input"]') as HTMLInputElement | null;
    seedInput?.addEventListener('change', () => {
      const v = Number(seedInput.value);
      if (Number.isFinite(v)) this.customSeed = Math.floor(Math.abs(v)) || 1;
    });

    this.titleLayer.querySelector('[data-act="rand-seed"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      this.customSeed = Math.floor(Math.random() * 899999 + 100000);
      if (seedInput) seedInput.value = String(this.customSeed);
    });

    this.titleLayer.querySelectorAll<HTMLButtonElement>('[data-title-bc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.callbacks.onPlayUiClick?.('select');
        this.selectedBossCells = Number(btn.dataset.titleBc) || 0;
        this.lastTitleSig = '';
        this.updateTitleScreen(state);
      });
    });

    this.titleLayer.querySelector('[data-act="new-run"]')?.addEventListener('click', () => {
      const seedVal = seedInput ? Math.floor(Math.abs(Number(seedInput.value))) || this.customSeed : this.customSeed;
      this.customSeed = seedVal;
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onNewRun(this.customSeed, this.selectedBossCells);
    });

    this.titleLayer.querySelector('[data-act="continue"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onContinueRun();
    });

    this.titleLayer.querySelector('[data-act="options"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      this.toggleOptions(true);
    });

    this.titleLayer.querySelector('[data-act="load-pack"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      void this.callbacks.onLoadCustomPackFolder();
    });

    this.titleLayer.querySelector('[data-act="toggle-art"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      const target: ArtPackMode = this.renderSettings.artPackMode === 'custom' ? 'builtin' : 'custom';
      this.callbacks.onToggleArtPackMode(target);
    });
  }

  // ===========================================================================
  // 2. Scroll Picker Modal (with exact HP% & 1.15^(n-1) DPS% preview)
  // ===========================================================================

  private updateScrollModal(state: SimState): void {
    if (!this.scrollLayer) return;
    const pending = state.pendingScroll;
    const show = Boolean(pending && state.runStatus !== 'title' && state.runStatus !== 'paused' && !this.optionsOpen);
    this.scrollLayer.classList.toggle('kc-hidden', !show);
    if (!show || !pending) {
      this.lastScrollSig = '';
      return;
    }

    const sig = `${pending.pickupUid}:${pending.choices.join(',')}:${state.player.scrolls.brutality}:${state.player.scrolls.tactics}:${state.player.scrolls.survival}`;
    if (sig === this.lastScrollSig) return;
    this.lastScrollSig = sig;

    const labels: Record<ScrollStat, { title: string; role: string }> = {
      brutality: { title: 'Brutality', role: 'Melee, Bleed & Grenades' },
      tactics: { title: 'Tactics', role: 'Ranged, Turrets & Lightning' },
      survival: { title: 'Survival', role: 'Shields, Heavy & Max HP' },
    };

    const cardsHtml = pending.choices
      .map((stat, idx) => {
        const curr = state.player.scrolls[stat];
        const next = curr + 1;
        const hpGain = computeScrollHpGainPct(stat, curr);
        const currDps = getScrollDamagePct(curr);
        const nextDps = getScrollDamagePct(next);

        return `
          <button class="kc-scroll-card kc-color-${stat}" data-scroll-stat="${stat}">
            <span class="kc-keycap">[${idx + 1}]</span>
            <div class="kc-scroll-card-gem"></div>
            <div class="kc-scroll-card-name">${labels[stat].title}</div>
            <div class="kc-scroll-card-stat">${curr} → ${next}</div>
            <div class="kc-scroll-card-delta">
              <div style="color:#4ade80;font-weight:700">+${hpGain}% Max HP</div>
              <div>DMG: ${currDps}% → <strong>${nextDps}%</strong> (+15%)</div>
            </div>
            <div style="font-size:11px;color:var(--text-muted)">${labels[stat].role}</div>
          </button>
        `;
      })
      .join('');

    this.scrollLayer.innerHTML = `
      <div class="kc-scroll-modal kc-iron-panel">
        <h2 class="kc-modal-title">${escapeHtml(pending.title || 'Scroll of Power')}</h2>
        <p class="kc-modal-subtitle">Choose an attribute to amplify — Press [1], [2], or [3]</p>
        <div class="kc-scroll-cards">${cardsHtml}</div>
      </div>
    `;

    this.scrollLayer.querySelectorAll<HTMLButtonElement>('[data-scroll-stat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stat = btn.dataset.scrollStat as ScrollStat;
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'pickScroll', stat });
      });
    });
  }

  // ===========================================================================
  // 3. Pause Menu
  // ===========================================================================

  private updatePauseMenu(state: SimState): void {
    if (!this.pauseLayer) return;
    const show = state.runStatus === 'paused' && !this.optionsOpen;
    this.pauseLayer.classList.toggle('kc-hidden', !show);
    if (!show) {
      this.lastPauseSig = '';
      return;
    }

    const sig = `${state.activeBiomeId}:${state.bossStemCells}:${state.runKills}:${Math.floor(state.player.runTimerTicks / 60)}`;
    if (sig === this.lastPauseSig) return;
    this.lastPauseSig = sig;

    this.pauseLayer.innerHTML = `
      <div class="kc-pause-card kc-iron-panel">
        <h2 class="kc-modal-title">Paused</h2>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">
          ${escapeHtml(getBiomeDisplayName(state.activeBiomeId, this.catalog))} · ${state.bossStemCells}BC · ${formatTimer(state.player.runTimerTicks)} · ${state.runKills} Kills
        </div>
        <button class="kc-btn kc-btn-primary" data-act="resume">Resume [Esc]</button>
        <button class="kc-btn" data-act="options">Options</button>
        <button class="kc-btn" data-act="restart">Restart Run</button>
        <button class="kc-btn" data-act="title">Return to Title</button>
      </div>
    `;

    this.pauseLayer.querySelector('[data-act="resume"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onResume();
    });
    this.pauseLayer.querySelector('[data-act="options"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      this.toggleOptions(true);
    });
    this.pauseLayer.querySelector('[data-act="restart"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onRestartRun();
    });
    this.pauseLayer.querySelector('[data-act="title"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('cancel');
      this.callbacks.onReturnToTitle();
    });
  }

  // ===========================================================================
  // 4. Options Modal (30/60/120 FPS, Snap 60Hz, Lighting, Bloom, Shake, Audio, Keybinds)
  // ===========================================================================

  private updateOptionsModal(): void {
    if (!this.optionsLayer) return;
    this.optionsLayer.classList.toggle('kc-hidden', !this.optionsOpen);
    if (!this.optionsOpen) {
      this.lastOptionsSig = '';
      return;
    }

    const r = this.renderSettings;
    const a = this.audioSettings;
    const sig = `${r.targetFps}:${r.snapToSimRate}:${r.lightingQuality}:${r.bloomEnabled}:${r.screenShakeScale.toFixed(2)}:${r.artPackMode}|${a.masterVolume.toFixed(2)}:${a.musicVolume.toFixed(2)}:${a.sfxVolume.toFixed(2)}:${a.muted}|${JSON.stringify(this.keyBindings)}|cap:${this.capturingKeyAction ?? ''}`;
    if (sig === this.lastOptionsSig) return;
    this.lastOptionsSig = sig;

    const fpsBtns = ([30, 60, 120] as TargetFps[])
      .map(
        (fps) =>
          `<button class="kc-seg-btn ${r.targetFps === fps ? 'is-active' : ''}" data-fps="${fps}">${fps} FPS</button>`
      )
      .join('');

    const lightBtns = (['low', 'medium', 'high'] as LightingQuality[])
      .map(
        (q) =>
          `<button class="kc-seg-btn ${r.lightingQuality === q ? 'is-active' : ''}" data-light="${q}">${q.toUpperCase()}</button>`
      )
      .join('');

    const keybindRows = KEYBIND_LABELS.map(({ action, label }) => {
      const capturing = this.capturingKeyAction === action;
      return `
        <div class="kc-keybind-item">
          <span>${escapeHtml(label)}</span>
          <button class="kc-keybind-btn ${capturing ? 'is-capturing' : ''}" data-rebind="${action}">
            ${capturing ? 'PRESS KEY...' : escapeHtml(formatKeyCode(this.keyBindings[action]))}
          </button>
        </div>
      `;
    }).join('');

    this.optionsLayer.innerHTML = `
      <div class="kc-options-modal kc-iron-panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 class="kc-modal-title" style="font-size:19px">Options</h2>
          <button class="kc-btn kc-btn-sm" data-act="close">Done [Esc]</button>
        </div>
        <div class="kc-options-body">
          <section class="kc-opt-section">
            <h3>Graphics & Frame Pacing</h3>
            <div class="kc-opt-row">
              <span>Target Frame Rate</span>
              <div class="kc-seg-group">${fpsBtns}</div>
            </div>
            <div class="kc-opt-row">
              <span>Snap Render to 60Hz Sim Rate</span>
              <button class="kc-seg-btn ${r.snapToSimRate ? 'is-active' : ''}" data-act="snap60">${r.snapToSimRate ? 'ON (Snap 60Hz)' : 'OFF (Interpolated)'}</button>
            </div>
            <div class="kc-opt-row">
              <span>Dynamic Lighting Quality</span>
              <div class="kc-seg-group">${lightBtns}</div>
            </div>
            <div class="kc-opt-row">
              <span>Additive Bloom</span>
              <button class="kc-seg-btn ${r.bloomEnabled ? 'is-active' : ''}" data-act="bloom">${r.bloomEnabled ? 'ENABLED' : 'DISABLED'}</button>
            </div>
            <div class="kc-opt-row">
              <span>Screen Shake (<strong data-el="shake-val">${Math.round(r.screenShakeScale * 100)}%</strong>)</span>
              <input class="kc-range" data-range="shake" type="range" min="0" max="150" step="5" value="${Math.round(r.screenShakeScale * 100)}" />
            </div>
            <div class="kc-opt-row">
              <span>Art Pack Mode</span>
              <div class="kc-seg-group">
                <button class="kc-seg-btn ${r.artPackMode === 'builtin' ? 'is-active' : ''}" data-art="builtin">Built-In Art</button>
                <button class="kc-seg-btn ${r.artPackMode === 'custom' ? 'is-active' : ''}" data-art="custom">Custom Pack</button>
              </div>
            </div>
          </section>

          <section class="kc-opt-section">
            <h3>Audio</h3>
            <div class="kc-opt-row">
              <span>Master Volume (<strong data-el="vol-master">${Math.round(a.masterVolume * 100)}%</strong>)</span>
              <input class="kc-range" data-range="master" type="range" min="0" max="100" step="1" value="${Math.round(a.masterVolume * 100)}" />
            </div>
            <div class="kc-opt-row">
              <span>Music Volume (<strong data-el="vol-music">${Math.round(a.musicVolume * 100)}%</strong>)</span>
              <input class="kc-range" data-range="music" type="range" min="0" max="100" step="1" value="${Math.round(a.musicVolume * 100)}" />
            </div>
            <div class="kc-opt-row">
              <span>SFX Volume (<strong data-el="vol-sfx">${Math.round(a.sfxVolume * 100)}%</strong>)</span>
              <input class="kc-range" data-range="sfx" type="range" min="0" max="100" step="1" value="${Math.round(a.sfxVolume * 100)}" />
            </div>
            <div class="kc-opt-row">
              <span>Mute All Audio</span>
              <button class="kc-seg-btn ${a.muted ? 'is-active' : ''}" data-act="mute">${a.muted ? 'MUTED' : 'ACTIVE'}</button>
            </div>
          </section>

          <section class="kc-opt-section">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <h3>Controls & Keybinds</h3>
              <button class="kc-btn kc-btn-sm" data-act="reset-keys">Reset Defaults</button>
            </div>
            <div class="kc-keybind-grid">${keybindRows}</div>
          </section>
        </div>
      </div>
    `;

    this.bindOptionsEvents();
  }

  private bindOptionsEvents(): void {
    if (!this.optionsLayer) return;

    this.optionsLayer.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('cancel');
      this.toggleOptions(false);
    });

    this.optionsLayer.querySelectorAll<HTMLButtonElement>('[data-fps]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetFps = Number(btn.dataset.fps) as TargetFps;
        this.renderSettings = { ...this.renderSettings, targetFps };
        this.callbacks.onPlayUiClick?.('select');
        this.callbacks.onUpdateRenderSettings({ targetFps });
        this.lastOptionsSig = '';
        this.updateOptionsModal();
      });
    });

    this.optionsLayer.querySelector('[data-act="snap60"]')?.addEventListener('click', () => {
      const snapToSimRate = !this.renderSettings.snapToSimRate;
      this.renderSettings = { ...this.renderSettings, snapToSimRate };
      this.callbacks.onPlayUiClick?.('select');
      this.callbacks.onUpdateRenderSettings({ snapToSimRate });
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    });

    this.optionsLayer.querySelectorAll<HTMLButtonElement>('[data-light]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lightingQuality = btn.dataset.light as LightingQuality;
        this.renderSettings = { ...this.renderSettings, lightingQuality };
        this.callbacks.onPlayUiClick?.('select');
        this.callbacks.onUpdateRenderSettings({ lightingQuality });
        this.lastOptionsSig = '';
        this.updateOptionsModal();
      });
    });

    this.optionsLayer.querySelector('[data-act="bloom"]')?.addEventListener('click', () => {
      const bloomEnabled = !this.renderSettings.bloomEnabled;
      this.renderSettings = { ...this.renderSettings, bloomEnabled };
      this.callbacks.onPlayUiClick?.('select');
      this.callbacks.onUpdateRenderSettings({ bloomEnabled });
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    });

    this.optionsLayer.querySelectorAll<HTMLButtonElement>('[data-art]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.art as ArtPackMode;
        this.callbacks.onPlayUiClick?.('select');
        this.callbacks.onToggleArtPackMode(mode);
      });
    });

    const shakeSlider = this.optionsLayer.querySelector('[data-range="shake"]') as HTMLInputElement | null;
    const shakeVal = this.optionsLayer.querySelector('[data-el="shake-val"]');
    shakeSlider?.addEventListener('input', () => {
      const pct = Number(shakeSlider.value);
      if (shakeVal) shakeVal.textContent = `${pct}%`;
      const screenShakeScale = pct / 100;
      this.renderSettings = { ...this.renderSettings, screenShakeScale };
      this.callbacks.onUpdateRenderSettings({ screenShakeScale });
    });

    const wireAudioRange = (name: 'master' | 'music' | 'sfx', field: 'masterVolume' | 'musicVolume' | 'sfxVolume') => {
      const slider = this.optionsLayer?.querySelector(`[data-range="${name}"]`) as HTMLInputElement | null;
      const valEl = this.optionsLayer?.querySelector(`[data-el="vol-${name}"]`);
      slider?.addEventListener('input', () => {
        const pct = Number(slider.value);
        if (valEl) valEl.textContent = `${pct}%`;
        const v = pct / 100;
        this.audioSettings = { ...this.audioSettings, [field]: v };
        this.callbacks.onUpdateAudioSettings({ [field]: v });
      });
    };
    wireAudioRange('master', 'masterVolume');
    wireAudioRange('music', 'musicVolume');
    wireAudioRange('sfx', 'sfxVolume');

    this.optionsLayer.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
      const muted = !this.audioSettings.muted;
      this.audioSettings = { ...this.audioSettings, muted };
      this.callbacks.onUpdateAudioSettings({ muted });
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    });

    this.optionsLayer.querySelector('[data-act="reset-keys"]')?.addEventListener('click', () => {
      this.cancelRebindCapture();
      this.keyBindings = { ...DEFAULT_KEY_BINDINGS };
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onResetKeyBindings();
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    });

    this.optionsLayer.querySelectorAll<HTMLButtonElement>('[data-rebind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.rebind as KeyAction;
        this.callbacks.onPlayUiClick?.('select');
        this.beginRebindCapture(action);
      });
    });
  }

  private beginRebindCapture(action: KeyAction): void {
    this.cancelRebindCapture();
    this.capturingKeyAction = action;
    this.lastOptionsSig = '';
    this.updateOptionsModal();

    const finish = (act: KeyAction, code: string) => {
      this.capturingKeyAction = null;
      this.keyBindings = { ...this.keyBindings, [act]: code };
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onUpdateKeyBindings({ ...this.keyBindings });
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    };

    const cancel = () => {
      this.capturingKeyAction = null;
      this.lastOptionsSig = '';
      this.updateOptionsModal();
    };

    if (this.inputManager) {
      this.inputManager.startRebindCapture(action, finish, cancel);
      return;
    }

    // Standalone window capture fallback if InputManager was not linked
    this.standaloneCaptureListener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'F9') return;
      this.removeStandaloneCapture();
      if (e.code === 'Escape') {
        cancel();
      } else {
        finish(action, e.code);
      }
    };
    window.addEventListener('keydown', this.standaloneCaptureListener, { capture: true });
  }

  private cancelRebindCapture(): void {
    if (this.inputManager?.isCapturingRebind()) {
      this.inputManager.cancelRebindCapture();
    }
    this.removeStandaloneCapture();
    this.capturingKeyAction = null;
  }

  private removeStandaloneCapture(): void {
    if (this.standaloneCaptureListener && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.standaloneCaptureListener, { capture: true });
      this.standaloneCaptureListener = null;
    }
  }

  // ===========================================================================
  // 5. Death / Victory Run Summary Screen
  // ===========================================================================

  private updateSummaryModal(state: SimState): void {
    if (!this.summaryLayer) return;
    const show = (state.runStatus === 'dead' || state.runStatus === 'victory') && !this.optionsOpen;
    this.summaryLayer.classList.toggle('kc-hidden', !show);
    if (!show) {
      this.lastSummarySig = '';
      return;
    }

    const summary = state.runSummary ?? {
      victory: state.runStatus === 'victory',
      bossCells: state.bossStemCells,
      biomeReached: state.activeBiomeId,
      kills: state.runKills,
      maxKillStreak: state.maxKillStreak,
      runTimerTicks: state.player.runTimerTicks,
      scrolls: state.player.scrolls,
      cellsCollected: state.totalCellsEarned,
      goldCollected: state.totalGoldEarned,
      causeOfDeath: state.lastDamageSource || 'Slain in combat',
      unlockedNewBossCell: false,
    };

    const sig = `${summary.victory}:${summary.biomeReached}:${summary.kills}:${summary.runTimerTicks}:${summary.unlockedNewBossCell}:${summary.causeOfDeath}`;
    if (sig === this.lastSummarySig) return;
    this.lastSummarySig = sig;

    const titleText = summary.victory ? 'Victory — The Sovereign Falls!' : 'You Died';
    const titleClass = summary.victory ? 'is-victory' : 'is-dead';

    this.summaryLayer.innerHTML = `
      <div class="kc-summary-card kc-iron-panel">
        <h2 class="kc-modal-title kc-summary-title ${titleClass}">${titleText}</h2>
        ${
          summary.unlockedNewBossCell
            ? `<div style="padding:8px 12px;border:1px solid var(--gold-amber);background:rgba(251,191,36,0.16);border-radius:3px;color:var(--gold-amber);font-family:var(--font-display);font-weight:700;letter-spacing:0.08em">
                ★ NEW BOSS STEM CELL ABSORBED! ★
              </div>`
            : ''
        }
        ${
          !summary.victory
            ? `<div style="font-size:13px;color:#fca5a5;font-family:var(--font-display);font-style:italic">
                ${escapeHtml(summary.causeOfDeath)}
              </div>`
            : ''
        }
        <div class="kc-summary-grid">
          <div class="kc-summary-stat"><span>Biome Reached</span><strong>${escapeHtml(getBiomeDisplayName(summary.biomeReached, this.catalog))}</strong></div>
          <div class="kc-summary-stat"><span>Difficulty</span><strong>${summary.bossCells}BC</strong></div>
          <div class="kc-summary-stat"><span>Run Time</span><strong>${formatTimer(summary.runTimerTicks)}</strong></div>
          <div class="kc-summary-stat"><span>Enemies Slain</span><strong>${summary.kills}</strong></div>
          <div class="kc-summary-stat"><span>Max Kill Streak</span><strong>${summary.maxKillStreak}</strong></div>
          <div class="kc-summary-stat"><span>Scrolls (B / T / S)</span><strong>${summary.scrolls.brutality} / ${summary.scrolls.tactics} / ${summary.scrolls.survival}</strong></div>
          <div class="kc-summary-stat"><span>Gold Collected</span><strong style="color:var(--gold-amber)">◈ ${summary.goldCollected}</strong></div>
          <div class="kc-summary-stat"><span>Cells Collected</span><strong style="color:var(--cell-cyan)">✦ ${summary.cellsCollected}</strong></div>
        </div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:4px">
          <button class="kc-btn kc-btn-primary" data-act="new-run">⚔ New Run</button>
          <button class="kc-btn" data-act="title">Title Screen</button>
        </div>
      </div>
    `;

    this.summaryLayer.querySelector('[data-act="new-run"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onRestartRun();
    });
    this.summaryLayer.querySelector('[data-act="title"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('cancel');
      this.callbacks.onReturnToTitle();
    });
  }
}
