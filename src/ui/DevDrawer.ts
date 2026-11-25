// =============================================================================
// KRUNKED CELLS — F9 Playtest & Telemetry Dev Drawer
// Live PerfStats, FNV-1a state hash, Biome Warp, Boss Spawner, Test Weapons &
// Skills quick-actions, and instant Built-In / Custom Pack Art Mode switcher.
// =============================================================================

import {
  ArtPackMode,
  BiomeId,
  BossId,
  MAX_BOSS_CELLS,
  PerfStats,
  SimState,
} from '../contracts';
import {
  ALL_BIOME_IDS,
  CatalogLookup,
  FALLBACK_SKILLS,
  FALLBACK_WEAPONS,
  escapeHtml,
  getBiomeDisplayName,
} from './HudOverlay';

export interface DevDrawerCallbacks {
  onWarpBiome?(biomeId: BiomeId): void;
  onSpawnBoss?(bossId: BossId): void;
  onGrantScrolls?(brutality: number, tactics: number, survival: number): void;
  onGiveItem?(itemId: string): void;
  onGiveTestSkills?(): void;
  onSetGodMode?(enabled: boolean): void;
  onSetBossCells?(bc: number): void;
  onTriggerCurse?(kills?: number): void;
  onToggleArtPackMode?(mode?: ArtPackMode): ArtPackMode | void;
  onStepTicks?(ticks: number): void;
  onResetSave?(): void;
  onPlayUiClick?(kind?: 'select' | 'confirm' | 'cancel' | 'error'): void;
}

export class DevDrawer {
  private callbacks: DevDrawerCallbacks;
  private catalog?: CatalogLookup;
  private drawerEl: HTMLElement;

  private open = false;
  private lastMetricsUpdateMs = 0;
  private resetConfirmPending = false;
  private resetConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackSkillPairIdx = 0;

  // Dynamic value references (never thrashing selects/inputs!)
  private metricsEl!: HTMLDivElement;
  private biomeSelect!: HTMLSelectElement;
  private weaponSelect!: HTMLSelectElement;
  private skillSelect!: HTMLSelectElement;
  private godBtn!: HTMLButtonElement;
  private artBuiltinBtn!: HTMLButtonElement;
  private artCustomBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private bcBtns: HTMLButtonElement[] = [];

  private lastGodMode = false;
  private lastBossCells = -1;
  private lastArtMode: ArtPackMode | null = null;

  constructor(uiRoot: HTMLElement, callbacks: DevDrawerCallbacks, catalog?: CatalogLookup) {
    this.callbacks = callbacks;
    this.catalog = catalog;

    this.drawerEl = document.createElement('aside');
    this.drawerEl.className = 'kc-dev-drawer kc-hidden';
    this.drawerEl.setAttribute('aria-label', 'F9 Developer Playtest Drawer');
    this.buildDom();
    uiRoot.appendChild(this.drawerEl);
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
    this.populateGearSelects();
    this.populateBiomeSelect();
  }

  public isOpen(): boolean {
    return this.open;
  }

  public toggle(force?: boolean): boolean {
    this.open = force !== undefined ? force : !this.open;
    this.drawerEl.classList.toggle('kc-hidden', !this.open);
    return this.open;
  }

  public update(
    state: SimState,
    perf?: PerfStats,
    backendName: 'webgl2' | 'canvas2d-fallback' = 'webgl2'
  ): void {
    if (!this.open) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastMetricsUpdateMs < 90) return;
    this.lastMetricsUpdateMs = now;

    const dbg = typeof window !== 'undefined' ? window.__KRUNKED_DEBUG__ : undefined;
    const p = perf ?? dbg?.getPerfStats();

    const fps = p ? Math.round(p.fps) : 0;
    const targetFps = p ? p.targetFps : 120;
    const simHz = p ? p.simHz : 60;
    const frameMs = p ? p.frameTimeMs.toFixed(1) : '0.0';
    const drawCalls = p ? p.drawCalls : 0;
    const lights = p ? p.activeLights : state.lights.length;
    const enemies = p ? p.enemyCount : state.enemies.length;
    const particles = p ? p.particleCount : state.particlesSim.length;
    const artMode: ArtPackMode = p ? p.artPackMode : this.lastArtMode ?? 'builtin';
    const packLoaded = p ? p.customPackLoaded : false;
    const hash = p ? p.stateHash : dbg?.getHash() ?? '--------';

    this.metricsEl.innerHTML = `
      <div><span>FPS/Tgt:</span> <strong>${fps}/${targetFps}</strong></div>
      <div><span>SimHz:</span> <strong>${simHz} Hz (${frameMs}ms)</strong></div>
      <div><span>Draws:</span> <strong>${drawCalls}</strong></div>
      <div><span>Lights:</span> <strong>${lights}</strong></div>
      <div><span>Enemies:</span> <strong>${enemies}</strong></div>
      <div><span>Particles:</span> <strong>${particles}</strong></div>
      <div><span>Backend:</span> <strong>${escapeHtml(backendName)}</strong></div>
      <div><span>Art:</span> <strong>${escapeHtml(artMode)}${packLoaded ? ' (Pack)' : ''}</strong></div>
      <div><span>Tick:</span> <strong>${state.tick}</strong></div>
      <div><span>Seed:</span> <strong>${state.runSeed}</strong></div>
      <div style="grid-column:span 2"><span>FNV-1a Hash:</span> <strong style="color:var(--cell-cyan)">${escapeHtml(hash)}</strong></div>
    `;

    if (state.player.godMode !== this.lastGodMode) {
      this.lastGodMode = state.player.godMode;
      this.godBtn.textContent = `God Mode: ${this.lastGodMode ? 'ON' : 'OFF'}`;
      this.godBtn.classList.toggle('kc-btn-emerald', this.lastGodMode);
    }

    if (state.bossStemCells !== this.lastBossCells) {
      this.lastBossCells = state.bossStemCells;
      this.bcBtns.forEach((b, idx) => b.classList.toggle('is-selected', idx === this.lastBossCells));
    }

    if (artMode !== this.lastArtMode) {
      this.lastArtMode = artMode;
      this.artBuiltinBtn.classList.toggle('is-active', artMode === 'builtin');
      this.artCustomBtn.classList.toggle('is-active', artMode === 'custom');
    }
  }

  public dispose(): void {
    if (this.resetConfirmTimer !== null) {
      clearTimeout(this.resetConfirmTimer);
    }
    this.drawerEl.remove();
  }

  private buildDom(): void {
    this.drawerEl.innerHTML = `
      <div class="kc-dev-head">
        <span class="kc-dev-title">[F9] DEV PLAYTEST DRAWER</span>
        <button class="kc-btn kc-btn-sm" data-act="close">×</button>
      </div>
      <div class="kc-dev-metrics" data-el="metrics"></div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Art Mode Switcher</span>
        <div class="kc-seg-group" style="width:100%">
          <button class="kc-seg-btn is-active" data-art-mode="builtin" style="flex:1">Built-In Art</button>
          <button class="kc-seg-btn" data-art-mode="custom" style="flex:1">Custom Pack</button>
        </div>
      </div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Biome Warp</span>
        <div class="kc-dev-row">
          <select class="kc-dev-select" data-el="biome-select"></select>
          <button class="kc-btn kc-btn-sm kc-btn-cyan" data-act="warp">Warp</button>
        </div>
      </div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Spawn Boss</span>
        <div class="kc-dev-row">
          <button class="kc-btn kc-btn-sm kc-btn-primary" data-boss="Behemoth">Concierge</button>
          <button class="kc-btn kc-btn-sm kc-btn-primary" data-boss="TimeKeeper">TimeKeeper</button>
          <button class="kc-btn kc-btn-sm kc-btn-primary" data-boss="KingsHand">KingsHand</button>
        </div>
      </div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Test All Weapons & Skills</span>
        <div class="kc-dev-row">
          <select class="kc-dev-select" data-el="weapon-select" aria-label="Test All Weapons"></select>
          <button class="kc-btn kc-btn-sm" data-act="give-weapon">Equip</button>
        </div>
        <div class="kc-dev-row">
          <select class="kc-dev-select" data-el="skill-select" aria-label="Test All Skills"></select>
          <button class="kc-btn kc-btn-sm" data-act="give-skill">Equip</button>
        </div>
        <div class="kc-dev-row">
          <button class="kc-btn kc-btn-sm kc-btn-cyan" data-act="give-all-skills" style="width:100%">Give All Test Skills (Cycle + Drop)</button>
        </div>
      </div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Scrolls & Boss Cells</span>
        <div class="kc-dev-row">
          <button class="kc-btn kc-btn-sm" data-act="scrolls-all">+3 All</button>
          <button class="kc-btn kc-btn-sm kc-color-brutality" data-scroll-one="b">+1 B</button>
          <button class="kc-btn kc-btn-sm kc-color-tactics" data-scroll-one="t">+1 T</button>
          <button class="kc-btn kc-btn-sm kc-color-survival" data-scroll-one="s">+1 S</button>
        </div>
        <div class="kc-bc-selector" data-el="bc-row"></div>
      </div>

      <div class="kc-dev-group">
        <span class="kc-dev-label">Sandbox & Determinism</span>
        <div class="kc-dev-row">
          <button class="kc-btn kc-btn-sm" data-act="god">God Mode: OFF</button>
          <button class="kc-btn kc-btn-sm kc-btn-primary" data-act="curse">10-Kill Curse</button>
          <button class="kc-btn kc-btn-sm" data-act="step60">+60 Ticks</button>
        </div>
        <div class="kc-dev-row">
          <button class="kc-btn kc-btn-sm" data-act="reset-save" style="border-color:#b91c1c;color:#fca5a5;width:100%">Reset Save</button>
        </div>
      </div>
    `;

    this.metricsEl = this.drawerEl.querySelector('[data-el="metrics"]') as HTMLDivElement;
    this.biomeSelect = this.drawerEl.querySelector('[data-el="biome-select"]') as HTMLSelectElement;
    this.weaponSelect = this.drawerEl.querySelector('[data-el="weapon-select"]') as HTMLSelectElement;
    this.skillSelect = this.drawerEl.querySelector('[data-el="skill-select"]') as HTMLSelectElement;
    this.godBtn = this.drawerEl.querySelector('[data-act="god"]') as HTMLButtonElement;
    this.artBuiltinBtn = this.drawerEl.querySelector('[data-art-mode="builtin"]') as HTMLButtonElement;
    this.artCustomBtn = this.drawerEl.querySelector('[data-art-mode="custom"]') as HTMLButtonElement;
    this.resetBtn = this.drawerEl.querySelector('[data-act="reset-save"]') as HTMLButtonElement;

    const bcRow = this.drawerEl.querySelector('[data-el="bc-row"]') as HTMLDivElement;
    for (let bc = 0; bc <= MAX_BOSS_CELLS; bc++) {
      const btn = document.createElement('button');
      btn.className = 'kc-bc-btn';
      btn.textContent = `${bc}BC`;
      btn.addEventListener('click', () => {
        this.callbacks.onPlayUiClick?.('select');
        if (this.callbacks.onSetBossCells) {
          this.callbacks.onSetBossCells(bc);
        } else {
          window.__KRUNKED_DEBUG__?.setBossCells(bc);
        }
      });
      bcRow.appendChild(btn);
      this.bcBtns.push(btn);
    }

    this.populateBiomeSelect();
    this.populateGearSelects();
    this.bindHandlers();
  }

  private populateBiomeSelect(): void {
    const prev = this.biomeSelect.value;
    this.biomeSelect.innerHTML = ALL_BIOME_IDS.map(
      (id) => `<option value="${id}">${escapeHtml(getBiomeDisplayName(id, this.catalog))} (${id})</option>`
    ).join('');
    if (prev) this.biomeSelect.value = prev;
  }

  private populateGearSelects(): void {
    const prevW = this.weaponSelect.value;
    const prevS = this.skillSelect.value;

    const weapons =
      this.catalog?.weapons && this.catalog.weapons.length > 0
        ? this.catalog.weapons.map((w) => ({ id: w.id, name: w.name, kind: w.kind }))
        : FALLBACK_WEAPONS.map((w) => ({ id: w.id, name: w.name, kind: w.kind }));
    const skills =
      this.catalog?.skills && this.catalog.skills.length > 0
        ? this.catalog.skills.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))
        : FALLBACK_SKILLS.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));

    this.weaponSelect.innerHTML = weapons
      .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.kind)})</option>`)
      .join('');
    this.skillSelect.innerHTML = skills
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.kind)})</option>`)
      .join('');

    if (prevW) this.weaponSelect.value = prevW;
    if (prevS) this.skillSelect.value = prevS;
  }

  private giveSingleItem(itemId: string): void {
    if (!itemId) return;
    this.callbacks.onPlayUiClick?.('confirm');
    if (this.callbacks.onGiveItem) {
      this.callbacks.onGiveItem(itemId);
    } else {
      window.__KRUNKED_DEBUG__?.giveItem(itemId);
    }
  }

  private bindHandlers(): void {
    this.drawerEl.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('cancel');
      this.toggle(false);
    });

    const handleArtClick = (mode: ArtPackMode): void => {
      this.callbacks.onPlayUiClick?.('select');
      if (this.callbacks.onToggleArtPackMode) {
        this.callbacks.onToggleArtPackMode(mode);
      } else {
        window.__KRUNKED_DEBUG__?.toggleArtPack(mode);
      }
    };
    this.artBuiltinBtn.addEventListener('click', () => handleArtClick('builtin'));
    this.artCustomBtn.addEventListener('click', () => handleArtClick('custom'));

    this.drawerEl.querySelector('[data-act="warp"]')?.addEventListener('click', () => {
      const biomeId = this.biomeSelect.value as BiomeId;
      this.callbacks.onPlayUiClick?.('confirm');
      if (this.callbacks.onWarpBiome) {
        this.callbacks.onWarpBiome(biomeId);
      } else {
        window.__KRUNKED_DEBUG__?.warpBiome(biomeId);
      }
    });

    this.drawerEl.querySelectorAll<HTMLButtonElement>('[data-boss]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bossId = btn.dataset.boss as BossId;
        this.callbacks.onPlayUiClick?.('confirm');
        if (this.callbacks.onSpawnBoss) {
          this.callbacks.onSpawnBoss(bossId);
        } else {
          window.__KRUNKED_DEBUG__?.spawnBoss(bossId);
        }
      });
    });

    this.drawerEl.querySelector('[data-act="give-weapon"]')?.addEventListener('click', () => {
      this.giveSingleItem(this.weaponSelect.value);
    });

    this.drawerEl.querySelector('[data-act="give-skill"]')?.addEventListener('click', () => {
      this.giveSingleItem(this.skillSelect.value);
    });

    this.drawerEl.querySelector('[data-act="give-all-skills"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      if (this.callbacks.onGiveTestSkills) {
        this.callbacks.onGiveTestSkills();
        return;
      }
      const pairs: Array<[string, string]> = [
        ['FireGrenade', 'HeavyTurret'],
        ['Phaser', 'WaveOfDenial'],
        ['IceGrenade', 'WolfTrap'],
        ['ClusterGrenade', 'CorruptedPower'],
        ['KnifeDance', 'Tonic'],
        ['InfantryGrenade', 'SinewSlicer'],
      ];
      const [s1, s2] = pairs[this.fallbackSkillPairIdx % pairs.length]!;
      this.fallbackSkillPairIdx++;
      this.giveSingleItem(s1);
      this.giveSingleItem(s2);
    });

    this.drawerEl.querySelector('[data-act="scrolls-all"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      if (this.callbacks.onGrantScrolls) {
        this.callbacks.onGrantScrolls(3, 3, 3);
      } else {
        window.__KRUNKED_DEBUG__?.grantScrolls(3, 3, 3);
      }
    });

    this.drawerEl.querySelectorAll<HTMLButtonElement>('[data-scroll-one]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.scrollOne;
        const b = k === 'b' ? 1 : 0;
        const t = k === 't' ? 1 : 0;
        const s = k === 's' ? 1 : 0;
        this.callbacks.onPlayUiClick?.('confirm');
        if (this.callbacks.onGrantScrolls) {
          this.callbacks.onGrantScrolls(b, t, s);
        } else {
          window.__KRUNKED_DEBUG__?.grantScrolls(b, t, s);
        }
      });
    });

    this.godBtn.addEventListener('click', () => {
      const next = !this.lastGodMode;
      this.callbacks.onPlayUiClick?.('select');
      if (this.callbacks.onSetGodMode) {
        this.callbacks.onSetGodMode(next);
      } else {
        window.__KRUNKED_DEBUG__?.setGodMode(next);
      }
    });

    this.drawerEl.querySelector('[data-act="curse"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      if (this.callbacks.onTriggerCurse) {
        this.callbacks.onTriggerCurse(10);
      } else {
        window.__KRUNKED_DEBUG__?.triggerCurse(10);
      }
    });

    this.drawerEl.querySelector('[data-act="step60"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      if (this.callbacks.onStepTicks) {
        this.callbacks.onStepTicks(60);
      } else {
        window.__KRUNKED_DEBUG__?.stepTicks(60);
      }
    });

    this.resetBtn.addEventListener('click', () => {
      if (!this.resetConfirmPending) {
        this.resetConfirmPending = true;
        this.resetBtn.textContent = 'Click Again to Confirm Save Wipe';
        this.callbacks.onPlayUiClick?.('error');
        this.resetConfirmTimer = setTimeout(() => {
          this.resetConfirmPending = false;
          this.resetBtn.textContent = 'Reset Save';
        }, 3200);
        return;
      }
      this.resetConfirmPending = false;
      if (this.resetConfirmTimer !== null) clearTimeout(this.resetConfirmTimer);
      this.resetBtn.textContent = 'Reset Save';
      this.callbacks.onPlayUiClick?.('confirm');
      if (this.callbacks.onResetSave) {
        this.callbacks.onResetSave();
      } else {
        window.__KRUNKED_DEBUG__?.resetSave();
      }
    });
  }
}
