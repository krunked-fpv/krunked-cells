// =============================================================================
// KRUNKED CELLS — The Passage Safe Room Modal
// Tabs: The Collector, Guillain (Mutations), Minor Forge, Fountain & Exits.
// Renders real pixel-art icons (zero Unicode emojis!).
// =============================================================================

import {
  ActiveInputSnapshot,
  ArtPackMode,
  BiomeId,
  CustomPackAssetResolver,
  GamepadLayoutPreset,
  GearInstance,
  GearQuality,
  MetaBlueprintDef,
  SimCommand,
  SimState,
} from '../contracts';
import {
  CatalogLookup,
  FALLBACK_META_BLUEPRINTS,
  FALLBACK_MUTATIONS,
  analyzeGearAffixes,
  computeGearDpsSummary,
  escapeHtml,
  formatGearBadge,
  formatTimer,
  getBiomeDisplayName,
  getGearDisplayInfo,
  getMutationDisplayInfo,
  getQualityCssClass,
  renderControllerBadgeHtml,
  renderItemIconHtml,
  renderUiGlyphSvg,
} from './HudOverlay';

export type PassageTab = 'collector' | 'guillain' | 'forge' | 'legendaryForge' | 'exits';

export interface PassageModalCallbacks {
  onDispatchCommand(cmd: SimCommand): void;
  onPlayUiClick?(kind?: 'select' | 'confirm' | 'cancel' | 'error'): void;
}

const NEXT_QUALITY: Record<GearQuality, GearQuality | null> = {
  base: '+',
  '+': '++',
  '++': 'S',
  S: null,
  L: null,
};

export class PassageModal {
  private callbacks: PassageModalCallbacks;
  private catalog?: CatalogLookup;
  private artPackMode: ArtPackMode = 'builtin';
  private customPackResolver: CustomPackAssetResolver | null = null;

  private backdropEl: HTMLDivElement;
  private quickBarEl: HTMLDivElement;
  private activeTab: PassageTab = 'collector';
  private manualOpen = false;
  private lastActiveNpc: 'none' | 'collector' | 'guillain' | 'forge' = 'none';
  private lastQuickBarPostBoss = false;
  private lastRenderSig = '';
  private inputSnapshot: ActiveInputSnapshot | null = null;
  private layoutPreset: GamepadLayoutPreset = 'standard';
  private lastState: SimState | null = null;

  constructor(uiRoot: HTMLElement, callbacks: PassageModalCallbacks, catalog?: CatalogLookup) {
    this.callbacks = callbacks;
    this.catalog = catalog;

    // Non-blocking quick access strip centered cleanly at bottom-center in The Passage
    this.quickBarEl = document.createElement('div');
    this.quickBarEl.className = 'kc-passage-quickbar kc-hidden';
    this.renderQuickBar();
    uiRoot.appendChild(this.quickBarEl);

    // Full Tabbed Passage Modal
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'kc-modal-backdrop kc-hidden';
    this.backdropEl.addEventListener('click', (e) => {
      if (e.target === this.backdropEl) {
        this.close();
      }
    });
    uiRoot.appendChild(this.backdropEl);
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
    this.lastRenderSig = '';
  }

  public setArtPackContext(mode: ArtPackMode, resolver?: CustomPackAssetResolver | null): void {
    this.artPackMode = mode;
    this.customPackResolver = resolver ?? null;
    this.forceRefreshIcons();
  }

  public forceRefreshIcons(): void {
    this.lastRenderSig = '';
    this.renderQuickBar(this.lastQuickBarPostBoss);
  }

  public isOpen(): boolean {
    return !this.backdropEl.classList.contains('kc-hidden');
  }

  public getModalElement(): HTMLElement {
    return this.backdropEl;
  }

  public setInputSnapshot(
    snapshot: ActiveInputSnapshot | null,
    layoutPreset: GamepadLayoutPreset = this.layoutPreset
  ): void {
    const prevMode = this.inputSnapshot?.mode ?? 'keyboard';
    const prevFamily = this.inputSnapshot?.glyphFamily ?? 'keyboard';
    const prevLayout = this.layoutPreset;
    const nextMode = snapshot?.mode ?? 'keyboard';
    const nextFamily = snapshot?.glyphFamily ?? 'keyboard';
    this.inputSnapshot = snapshot;
    this.layoutPreset = layoutPreset;
    if (prevMode !== nextMode || prevFamily !== nextFamily || prevLayout !== layoutPreset) {
      this.lastRenderSig = '';
    }
  }

  public cycleTab(delta: -1 | 1): boolean {
    if (!this.isOpen()) return false;
    const tabs: PassageTab[] = this.lastQuickBarPostBoss
      ? ['collector', 'guillain', 'forge', 'legendaryForge', 'exits']
      : ['collector', 'guillain', 'forge', 'exits'];
    const curIdx = Math.max(0, tabs.indexOf(this.activeTab));
    const nextTab = tabs[(curIdx + delta + tabs.length) % tabs.length] ?? 'collector';
    this.activeTab = nextTab;
    this.callbacks.onPlayUiClick?.('select');
    if (nextTab === 'collector' || nextTab === 'guillain' || nextTab === 'forge') {
      this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: nextTab });
    }
    if (this.lastState) {
      this.lastRenderSig = this.computeSignature(this.lastState);
      this.render(this.lastState);
    } else {
      this.lastRenderSig = '';
    }
    return true;
  }

  public openTab(tab: PassageTab): void {
    this.activeTab = tab;
    this.manualOpen = true;
    this.lastRenderSig = '';
    if (tab === 'collector' || tab === 'guillain' || tab === 'forge') {
      this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: tab });
    }
  }

  public close(): void {
    if (!this.isOpen()) return;
    this.callbacks.onPlayUiClick?.('cancel');
    this.manualOpen = false;
    this.backdropEl.classList.add('kc-hidden');
    this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: 'none' });
  }

  public update(state: SimState): void {
    this.lastState = state;
    const inPassage =
      (state.runStatus === 'passage' || state.runStatus === 'playing') &&
      (state.passageState.active || state.activeBiomeId === 'Passage');

    if (!inPassage) {
      this.manualOpen = false;
      this.lastActiveNpc = 'none';
      this.backdropEl.classList.add('kc-hidden');
      this.quickBarEl.classList.add('kc-hidden');
      return;
    }

    const isPostBoss = this.isPostBossPassage(state);
    if (isPostBoss !== this.lastQuickBarPostBoss) {
      this.lastQuickBarPostBoss = isPostBoss;
      this.renderQuickBar(isPostBoss);
    }
    if (!isPostBoss && this.activeTab === 'legendaryForge') {
      this.activeTab = 'collector';
    }

    const npc = state.passageState.activeNpc;
    if (npc !== this.lastActiveNpc) {
      this.lastActiveNpc = npc;
      if (npc !== 'none') {
        this.activeTab = npc;
        this.manualOpen = true;
        this.lastRenderSig = '';
      }
    }

    const shouldShowModal = this.manualOpen || npc !== 'none';
    this.quickBarEl.classList.toggle('kc-hidden', shouldShowModal);
    this.backdropEl.classList.toggle('kc-hidden', !shouldShowModal);

    if (!shouldShowModal) return;

    const sig = this.computeSignature(state);
    if (sig !== this.lastRenderSig) {
      this.lastRenderSig = sig;
      this.render(state);
    }
  }

  public dispose(): void {
    this.backdropEl.remove();
    this.quickBarEl.remove();
  }

  private isPostBossPassage(state: SimState): boolean {
    const from = state.passageState.fromBiome;
    return from === 'Bridge' || from === 'TopClockTower';
  }

  private renderQuickBar(showLegendaryForge = false): void {
    const cellIcon = renderItemIconHtml('Cell', this.artPackMode, this.customPackResolver, {
      size: 14,
      fallbackKind: 'cell',
      alt: 'Collector',
    });
    const mutIcon = renderUiGlyphSvg('mutation', 14, '#a855f7');
    const forgeIcon = renderUiGlyphSvg('forge', 14, '#fbbf24');
    const starIcon = renderUiGlyphSvg('star', 14, '#ffd84d');
    const exitIcon = renderUiGlyphSvg('door', 14, '#22c55e');

    this.quickBarEl.innerHTML = `
      <button class="kc-btn kc-btn-sm kc-btn-cyan kc-btn-icon" data-open-tab="collector">${cellIcon}<span>Collector</span></button>
      <button class="kc-btn kc-btn-sm kc-btn-icon" data-open-tab="guillain">${mutIcon}<span>Guillain</span></button>
      <button class="kc-btn kc-btn-sm kc-btn-icon" data-open-tab="forge">${forgeIcon}<span>Forge</span></button>
      ${
        showLegendaryForge
          ? `<button class="kc-btn kc-btn-sm kc-btn-gold kc-btn-icon" data-open-tab="legendaryForge">${starIcon}<span>Leg. Forge</span></button>`
          : ''
      }
      <button class="kc-btn kc-btn-sm kc-btn-emerald kc-btn-icon" data-open-tab="exits">${exitIcon}<span>Exits</span></button>
    `;
    this.quickBarEl.querySelectorAll<HTMLButtonElement>('[data-open-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.openTab as PassageTab;
        this.callbacks.onPlayUiClick?.('select');
        this.openTab(tab);
      });
    });
  }

  private computeSignature(state: SimState): string {
    const p = state.player;
    const ps = state.passageState;
    const ms = state.metaSnapshot;
    const progKey = Object.entries(ms.blueprintProgress)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const gearKey = [p.loadout.weapon1, p.loadout.weapon2, p.loadout.skill1, p.loadout.skill2]
      .map((g) => (g ? `${g.uid}:${g.quality}:${g.affixes.join('.')}` : 'none'))
      .join('|');
    const inMode = this.inputSnapshot?.mode ?? 'keyboard';
    const inFamily = this.inputSnapshot?.glyphFamily ?? 'keyboard';
    return `${this.activeTab}|fb:${ps.fromBiome}|art:${this.artPackMode}|in:${inMode}:${inFamily}:${this.layoutPreset}|c${p.cells}|g${p.gold}|hp${Math.ceil(p.hp)}/${Math.ceil(p.maxHp)}|fl${p.flaskCharges}/${p.maxFlaskCharges}|f${ps.fountainUsed}:${state.fountainRefillsLeft ?? -1}:${state.singleFlaskRefillsLeft ?? -1}|td${ps.timedDoorOpen}${ps.timedDoorClaimed}|kd${ps.killStreakDoorOpen}${ps.killStreakDoorClaimed}|fd${ps.flawlessBossDoorOpen ? 1 : 0}${ps.flawlessBossDoorClaimed ? 1 : 0}|lf${ms.legendaryForgePlus ?? 0}/${ms.legendaryForgePlusPlus ?? 0}|rf${ps.reforgeCount}|m${p.mutations.join(',')}|ub${ms.unlockedBlueprints.length}|ft${ms.flaskTier}|gr${ms.goldReserveTier}|rs${ms.randomStarterUnlocked}|rc${ms.recycleUnlocked}|${progKey}|${gearKey}|nb${ps.nextBiomes.join(',')}`;
  }

  private render(state: SimState): void {
    const p = state.player;
    const ps = state.passageState;
    const postBoss = this.isPostBossPassage(state);

    const cellIcon = renderItemIconHtml('Cell', this.artPackMode, this.customPackResolver, {
      size: 16,
      fallbackKind: 'cell',
      alt: 'Cells',
    });
    const goldIcon = renderItemIconHtml('Gold', this.artPackMode, this.customPackResolver, {
      size: 16,
      fallbackKind: 'gold',
      alt: 'Gold',
    });
    const mutIcon = renderUiGlyphSvg('mutation', 15, '#a855f7');
    const forgeIcon = renderUiGlyphSvg('forge', 15, '#fbbf24');
    const starIcon = renderUiGlyphSvg('star', 15, '#ffd84d');
    const exitIcon = renderUiGlyphSvg('door', 15, '#22c55e');

    const tabBtn = (id: PassageTab, iconHtml: string, label: string, extraCls = '') =>
      `<button class="kc-tab ${extraCls} ${this.activeTab === id ? 'is-active' : ''}" data-tab="${id}">${iconHtml}<span>${label}</span></button>`;

    let bodyHtml = '';
    if (this.activeTab === 'collector') {
      bodyHtml = this.renderCollectorTab(state);
    } else if (this.activeTab === 'guillain') {
      bodyHtml = this.renderGuillainTab(state);
    } else if (this.activeTab === 'forge') {
      bodyHtml = this.renderForgeTab(state);
    } else if (this.activeTab === 'legendaryForge' && postBoss) {
      bodyHtml = this.renderLegendaryForgeTab(state);
    } else {
      bodyHtml = this.renderExitsTab(state);
    }

    const mode = this.inputSnapshot?.mode ?? 'keyboard';
    const closeBtnLabel =
      mode === 'gamepad'
        ? `Close${renderControllerBadgeHtml('cancel', this.inputSnapshot, undefined, { extraClass: 'is-inline-after', layoutPreset: this.layoutPreset })}`
        : mode === 'touch'
          ? 'Close'
          : 'Close [Esc]';
    const prevTabHint =
      mode === 'gamepad'
        ? `<span class="kc-tabs-gp-hint" aria-hidden="true">${renderControllerBadgeHtml('skill1', this.inputSnapshot, undefined, { layoutPreset: this.layoutPreset })}</span>`
        : '';
    const nextTabHint =
      mode === 'gamepad'
        ? `<span class="kc-tabs-gp-hint" aria-hidden="true">${renderControllerBadgeHtml('skill2', this.inputSnapshot, undefined, { layoutPreset: this.layoutPreset })}</span>`
        : '';

    this.backdropEl.innerHTML = `
      <div class="kc-passage-modal kc-iron-panel">
        <div class="kc-passage-head">
          <div>
            <h2 class="kc-modal-title" style="font-size:19px;text-align:left">The Passage — Safe Haven</h2>
            <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">
              Cleared: ${escapeHtml(getBiomeDisplayName(ps.fromBiome, this.catalog))}
            </div>
          </div>
          <div class="kc-passage-wallet">
            <span class="kc-res-item kc-res-cells">${cellIcon}<span>${Math.floor(p.cells)} Cells</span></span>
            <span class="kc-res-item kc-res-gold">${goldIcon}<span>${Math.floor(p.gold)} Gold</span></span>
            <button class="kc-btn kc-btn-sm" data-act="close">${closeBtnLabel}</button>
          </div>
        </div>
        <div class="kc-tabs">
          ${prevTabHint}
          ${tabBtn('collector', cellIcon, 'The Collector')}
          ${tabBtn('guillain', mutIcon, 'Guillain (Mutations)')}
          ${tabBtn('forge', forgeIcon, 'Minor Forge')}
          ${postBoss ? tabBtn('legendaryForge', starIcon, 'Legendary Forge', 'is-legendary-tab') : ''}
          ${tabBtn('exits', exitIcon, 'Fountain & Next Biome')}
          ${nextTabHint}
        </div>
        <div class="kc-passage-body">
          ${bodyHtml}
        </div>
      </div>
    `;

    this.bindEvents(state);
  }

  private resolveBlueprintIconId(bp: MetaBlueprintDef): string {
    if (bp.targetId) return bp.targetId;
    if (bp.id === 'HealthFlask' || bp.id === 'flask') return 'HealthFlask';
    if (bp.id === 'GoldReserves' || bp.id === 'goldReserve' || bp.id === 'Recycling' || bp.id === 'recycle') {
      return 'Gold';
    }
    if (bp.id === 'RandomStarter' || bp.id === 'randomStarter') return 'StartSword';
    return bp.id;
  }

  private renderCollectorTab(state: SimState): string {
    const blueprints: readonly MetaBlueprintDef[] =
      this.catalog?.metaBlueprints && this.catalog.metaBlueprints.length > 0
        ? this.catalog.metaBlueprints
        : FALLBACK_META_BLUEPRINTS;
    const cells = Math.floor(state.player.cells);

    const cards = blueprints
      .map((bp) => {
        const status = this.getBlueprintStatus(bp, state);
        const pct = status.maxed ? 100 : Math.min(100, Math.round((status.invested / Math.max(1, status.cost)) * 100));
        const rem = Math.max(0, status.cost - status.invested);
        const iconId = this.resolveBlueprintIconId(bp);
        const iconHtml = renderItemIconHtml(iconId, this.artPackMode, this.customPackResolver, {
          size: 30,
          alt: bp.name,
        });

        return `
          <div class="kc-npc-card ${status.maxed ? 'is-maxed' : ''}">
            <div class="kc-npc-card-top">
              <div class="kc-npc-icon-frame">${iconHtml}</div>
              <div class="kc-npc-card-titles">
                <div class="kc-npc-card-head">
                  <span class="kc-npc-card-name">${escapeHtml(bp.name)}</span>
                  <span class="kc-npc-tier" style="color:${status.maxed ? 'var(--survival)' : 'var(--cell-cyan)'}">
                    ${status.maxed ? 'UNLOCKED' : status.tierLabel}
                  </span>
                </div>
                <div class="kc-npc-card-desc">${escapeHtml(bp.description)}</div>
              </div>
            </div>
            <div class="kc-progress-track">
              <div class="kc-progress-fill" style="width:${pct}%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">
              <span>${status.maxed ? 'Complete' : `${status.invested} / ${status.cost} Cells`}</span>
              <span style="text-transform:uppercase">${escapeHtml(bp.category)}</span>
            </div>
            ${
              status.maxed
                ? ''
                : `<div class="kc-dev-row" style="margin-top:2px">
                    <button class="kc-btn kc-btn-sm kc-btn-cyan" data-invest="${escapeHtml(bp.id)}" data-amt="1" ${cells < 1 ? 'disabled' : ''}>+1</button>
                    <button class="kc-btn kc-btn-sm kc-btn-cyan" data-invest="${escapeHtml(bp.id)}" data-amt="5" ${cells < 1 ? 'disabled' : ''}>+5</button>
                    <button class="kc-btn kc-btn-sm kc-btn-cyan" data-invest="${escapeHtml(bp.id)}" data-amt="${rem}" ${cells < 1 ? 'disabled' : ''}>Max (${Math.min(cells, rem)})</button>
                  </div>`
            }
          </div>
        `;
      })
      .join('');

    return `
      <div style="font-size:12px;color:var(--text-parchment)">
        Spend glowing <strong style="color:var(--cell-cyan)">Cells</strong> to permanently unlock flasks, gold reserves, weapons, skills, and mutations.
      </div>
      <div class="kc-card-grid">${cards}</div>
    `;
  }

  private getBlueprintStatus(
    bp: MetaBlueprintDef,
    state: SimState
  ): { maxed: boolean; invested: number; cost: number; tierLabel: string } {
    const ms = state.metaSnapshot;
    const invested = ms.blueprintProgress[bp.id] ?? 0;

    if (bp.id === 'HealthFlask' || bp.id === 'flask') {
      const tier = ms.flaskTier;
      const maxed = tier >= bp.maxTier;
      const idx = Math.min(Math.max(0, tier - 1), bp.costs.length - 1);
      return {
        maxed,
        invested,
        cost: bp.costs[idx] ?? 25,
        tierLabel: `Tier ${tier}/${bp.maxTier}`,
      };
    }

    if (bp.id === 'GoldReserves' || bp.id === 'goldReserve') {
      const tier = ms.goldReserveTier;
      const maxed = tier >= bp.maxTier;
      const idx = Math.min(Math.max(0, tier), bp.costs.length - 1);
      return {
        maxed,
        invested,
        cost: bp.costs[idx] ?? 25,
        tierLabel: `Tier ${tier}/${bp.maxTier}`,
      };
    }

    if (bp.id === 'RandomStarter' || bp.id === 'randomStarter') {
      return {
        maxed: ms.randomStarterUnlocked,
        invested,
        cost: bp.costs[0] ?? 20,
        tierLabel: '0/1',
      };
    }

    if (bp.id === 'Recycling' || bp.id === 'recycle') {
      return {
        maxed: ms.recycleUnlocked,
        invested,
        cost: bp.costs[0] ?? 15,
        tierLabel: '0/1',
      };
    }

    const target = bp.targetId ?? bp.id;
    const maxed = ms.unlockedBlueprints.includes(target) || ms.unlockedBlueprints.includes(bp.id);
    return {
      maxed,
      invested,
      cost: bp.costs[0] ?? 25,
      tierLabel: 'Blueprint',
    };
  }

  private renderGuillainTab(state: SimState): string {
    const equipped = state.player.mutations;
    const allMuts =
      this.catalog?.mutations && this.catalog.mutations.length > 0
        ? this.catalog.mutations.map((m) => ({
            id: m.id,
            name: m.name,
            color: m.color,
            description: m.description,
            unlocked: m.autoUnlocked || state.metaSnapshot.unlockedBlueprints.includes(m.id),
          }))
        : FALLBACK_MUTATIONS.map((m) => ({
            ...m,
            unlocked:
              m.id === 'Combo' ||
              m.id === 'Necromancy' ||
              m.id === 'Support' ||
              m.id === 'OpenWounds' ||
              m.id === 'Melee' ||
              m.id === 'Vengeance' ||
              m.id === 'PointBlank' ||
              m.id === 'Gastronomy' ||
              m.id === 'WhatDoesntKillMe' ||
              m.id === 'Disengagement' ||
              state.metaSnapshot.unlockedBlueprints.includes(m.id),
          }));

    const respecCost = 1000 * (state.passageState.reforgeCount + 1);
    const activeSlotsHtml = [0, 1, 2]
      .map((idx) => {
        const id = equipped[idx];
        if (!id) {
          return `<div class="kc-npc-card" style="opacity:0.6"><div class="kc-npc-card-name">Slot ${idx + 1} — Empty</div><div class="kc-npc-card-desc">Choose a mutation below.</div></div>`;
        }
        const info = getMutationDisplayInfo(id, this.catalog);
        const iconHtml = renderItemIconHtml(id, this.artPackMode, this.customPackResolver, {
          size: 30,
          fallbackKind: 'mutation',
          alt: info.name,
        });
        return `
          <div class="kc-npc-card kc-color-${info.color}">
            <div class="kc-npc-card-top">
              <div class="kc-npc-icon-frame kc-color-${info.color}">${iconHtml}</div>
              <div class="kc-npc-card-titles">
                <div class="kc-npc-card-head">
                  <span class="kc-npc-card-name">${escapeHtml(info.name)}</span>
                  <span class="kc-npc-tier">SLOT ${idx + 1}</span>
                </div>
                <div class="kc-npc-card-desc">${escapeHtml(info.description)}</div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const cards = allMuts
      .filter((m) => m.unlocked)
      .map((m) => {
        const isEquipped = equipped.includes(m.id);
        const full = equipped.length >= 3 && !isEquipped;
        const iconHtml = renderItemIconHtml(m.id, this.artPackMode, this.customPackResolver, {
          size: 30,
          fallbackKind: 'mutation',
          alt: m.name,
        });
        return `
          <div class="kc-npc-card kc-color-${m.color}">
            <div class="kc-npc-card-top">
              <div class="kc-npc-icon-frame kc-color-${m.color}">${iconHtml}</div>
              <div class="kc-npc-card-titles">
                <div class="kc-npc-card-head">
                  <span class="kc-npc-card-name">${escapeHtml(m.name)}</span>
                  <span class="kc-npc-tier" style="text-transform:uppercase">${escapeHtml(m.color)}</span>
                </div>
                <div class="kc-npc-card-desc">${escapeHtml(m.description)}</div>
              </div>
            </div>
            <button class="kc-btn kc-btn-sm ${isEquipped ? '' : 'kc-btn-primary'}" data-pick-mut="${escapeHtml(m.id)}" ${isEquipped || full ? 'disabled' : ''}>
              ${isEquipped ? 'Equipped' : full ? 'Slots Full (Respec)' : 'Equip Mutation'}
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-parchment)">Select up to <strong>3 Mutations</strong> (${equipped.length}/3 equipped).</span>
        <button class="kc-btn kc-btn-sm" data-act="respec" ${equipped.length === 0 ? 'disabled' : ''}>
          Respec Mutations (~${respecCost} Gold)
        </button>
      </div>
      <div class="kc-card-grid">${activeSlotsHtml}</div>
      <div style="font-family:var(--font-display);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gold-amber);margin-top:4px">
        Available Mutations
      </div>
      <div class="kc-card-grid">${cards}</div>
    `;
  }

  private renderForgeTab(state: SimState): string {
    const slots: Array<{ key: 'weapon1' | 'weapon2' | 'skill1' | 'skill2'; label: string; gear: GearInstance | null }> = [
      { key: 'weapon1', label: 'Weapon 1', gear: state.player.loadout.weapon1 },
      { key: 'weapon2', label: 'Weapon 2', gear: state.player.loadout.weapon2 },
      { key: 'skill1', label: 'Skill 1', gear: state.player.loadout.skill1 },
      { key: 'skill2', label: 'Skill 2', gear: state.player.loadout.skill2 },
    ];

    const cards = slots
      .map(({ key, label, gear }) => {
        if (!gear) {
          return `
            <div class="kc-npc-card" style="opacity:0.55">
              <div class="kc-npc-card-head"><span class="kc-npc-card-name">${label}</span><span>Empty</span></div>
              <div class="kc-npc-card-desc">No gear equipped in this slot.</div>
            </div>
          `;
        }
        const info = getGearDisplayInfo(gear, this.catalog);
        const summary = computeGearDpsSummary(gear, state, this.catalog);
        const badge = formatGearBadge(gear.level, gear.quality);
        const qClass = getQualityCssClass(gear.quality);
        const nextQ = NEXT_QUALITY[gear.quality];
        const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
        const iconHtml = renderItemIconHtml(gear.defId, this.artPackMode, this.customPackResolver, {
          size: 34,
          alt: info.name,
        });
        const analyzed = analyzeGearAffixes(gear, state, this.catalog);
        const affixesHtml =
          analyzed.length > 0
            ? `<ul class="kc-affix-list kc-dc-affix-list">${analyzed
                .map((af) => {
                  const cls = af.isActiveSynergy
                    ? 'kc-affix-item is-synergy'
                    : af.isStar
                      ? 'kc-affix-item is-star'
                      : 'kc-affix-item';
                  const prefix = af.isStar || af.isActiveSynergy ? '<span class="kc-affix-star">★</span>' : '<span class="kc-affix-dot">·</span>';
                  return `<li class="${cls}">${prefix}<span class="kc-affix-text">${escapeHtml(af.label)}</span></li>`;
                })
                .join('')}</ul>`
            : `<div class="kc-npc-card-desc">No active affixes yet.</div>`;

        const statStr = summary.isSkill
          ? `${label} · DMG ${summary.dps}`
          : `${label} · DPS ${summary.dps}${summary.critDps !== null ? ` · <span style="color:#ffd84d">CRIT ${summary.critDps}</span>` : ''}`;

        return `
          <div class="kc-npc-card ${colorClass}">
            <div class="kc-npc-card-top">
              <div class="kc-npc-icon-frame ${colorClass}">${iconHtml}</div>
              <div class="kc-npc-card-titles">
                <div class="kc-npc-card-head">
                  <span class="kc-npc-card-name">${escapeHtml(info.name)} <span class="kc-gear-badge ${qClass}" style="position:static">${escapeHtml(badge)}</span></span>
                  <span class="kc-npc-tier">${statStr}</span>
                </div>
                ${affixesHtml}
              </div>
            </div>
            <div class="kc-dev-row" style="margin-top:auto">
              <button class="kc-btn kc-btn-sm kc-btn-primary" data-forge-up="${key}" ${nextQ ? '' : 'disabled'}>
                ${nextQ ? `Upgrade → ${escapeHtml(nextQ)}` : 'Max Quality'}
              </button>
              <button class="kc-btn kc-btn-sm" data-forge-reforge="${key}">
                Reforge Affixes (Gold)
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const legendaryCallout = this.isPostBossPassage(state)
      ? `<div class="kc-legendary-forge-inline">${this.renderLegendaryForgeSection(state)}</div>`
      : '';

    return `
      <div style="font-size:12px;color:var(--text-parchment)">
        Upgrade gear quality (<code>base → + → ++ → S</code>) or re-roll combat synergy affixes with <strong style="color:var(--gold-amber)">Gold</strong>.
      </div>
      <div class="kc-card-grid">${cards}</div>
      ${legendaryCallout}
    `;
  }

  private renderLegendaryForgeSection(state: SimState): string {
    const cells = Math.floor(state.player.cells);
    const plusPct = Math.max(0, Math.min(100, Math.round(state.metaSnapshot.legendaryForgePlus ?? 0)));
    const plusPlusPct = Math.max(0, Math.min(100, Math.round(state.metaSnapshot.legendaryForgePlusPlus ?? 0)));

    const starIcon = renderUiGlyphSvg('star', 26, '#ffd84d');
    const forgeIcon = renderUiGlyphSvg('forge', 26, '#38e8ff');

    const renderTierCard = (
      tier: 'plus' | 'plusPlus',
      title: string,
      qualityBadge: string,
      badgeCls: string,
      desc: string,
      pct: number,
      iconHtml: string
    ): string => {
      const maxed = pct >= 100;
      return `
        <div class="kc-npc-card kc-leg-forge-card ${maxed ? 'is-maxed' : ''}">
          <div class="kc-npc-card-top">
            <div class="kc-npc-icon-frame kc-leg-forge-icon">${iconHtml}</div>
            <div class="kc-npc-card-titles">
              <div class="kc-npc-card-head">
                <span class="kc-npc-card-name">${escapeHtml(title)} <span class="kc-gear-badge ${badgeCls}" style="position:static">${escapeHtml(qualityBadge)}</span></span>
                <span class="kc-npc-tier" style="color:${maxed ? 'var(--survival)' : '#ffd84d'}">${maxed ? 'MAXED (100%)' : `${pct}% CHANCE`}</span>
              </div>
              <div class="kc-npc-card-desc">${escapeHtml(desc)}</div>
            </div>
          </div>
          <div class="kc-progress-track kc-leg-progress-track">
            <div class="kc-progress-fill ${tier === 'plusPlus' ? 'is-gold' : ''}" style="width:${pct}%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">
            <span>Permanent Drop Quality: <strong style="color:var(--text-bone)">${pct}%</strong></span>
            <span>POST-BOSS FORGE</span>
          </div>
          ${
            maxed
              ? ''
              : `<div class="kc-dev-row" style="margin-top:2px">
                  <button class="kc-btn kc-btn-sm kc-btn-cyan" data-leg-forge="${tier}" data-amt="1" ${cells < 1 ? 'disabled' : ''}>+1 Cell</button>
                  <button class="kc-btn kc-btn-sm kc-btn-cyan" data-leg-forge="${tier}" data-amt="5" ${cells < 1 ? 'disabled' : ''}>+5 Cells</button>
                  <button class="kc-btn kc-btn-sm kc-btn-cyan" data-leg-forge="${tier}" data-amt="25" ${cells < 1 ? 'disabled' : ''}>+25 Cells</button>
                  <button class="kc-btn kc-btn-sm kc-btn-gold" data-leg-forge="${tier}" data-amt="${Math.max(1, cells)}" ${cells < 1 ? 'disabled' : ''}>All (${cells})</button>
                </div>`
          }
        </div>
      `;
    };

    return `
      <div class="kc-leg-forge-banner">
        <div class="kc-leg-forge-heading">
          ${renderUiGlyphSvg('star', 16, '#ffd84d')}
          <span>The Legendary Forge — Permanent Drop Quality</span>
        </div>
        <div style="font-size:11px;color:var(--text-parchment)">
          Invest glowing <strong style="color:var(--cell-cyan)">Cells</strong> after defeating a Boss to permanently raise the drop rate of <strong>+</strong> and <strong>++</strong> gear across all future runs.
        </div>
      </div>
      <div class="kc-card-grid">
        ${renderTierCard(
          'plus',
          'Forged Quality',
          '+',
          'kc-q-plus',
          'Increases chance that found items spawn at + quality (+2 effective gear levels).',
          plusPct,
          forgeIcon
        )}
        ${renderTierCard(
          'plusPlus',
          'Superior Quality',
          '++',
          'kc-q-plusplus',
          'Increases chance that found items spawn at ++ quality (+4 levels & +1 bonus scroll).',
          plusPlusPct,
          starIcon
        )}
      </div>
    `;
  }

  private renderLegendaryForgeTab(state: SimState): string {
    return this.renderLegendaryForgeSection(state);
  }

  private renderExitsTab(state: SimState): string {
    const ps = state.passageState;
    const p = state.player;
    const nextBiomes: BiomeId[] = ps.nextBiomes.length > 0 ? ps.nextBiomes : ['PrisonCourtyard'];

    const timerIcon = renderUiGlyphSvg('timer', 16, '#fbbf24');
    const crownIcon = renderUiGlyphSvg('crown', 16, '#fbbf24');
    const starIcon = renderUiGlyphSvg('star', 16, '#ffd84d');
    const flaskIcon = renderItemIconHtml('HealthFlask', this.artPackMode, this.customPackResolver, {
      size: 30,
      fallbackKind: 'flask',
      alt: 'Health Fountain',
    });

    const timedText = ps.timedDoorClaimed
      ? 'CLAIMED'
      : ps.timedDoorOpen
        ? 'UNLOCKED'
        : ps.timedTargetTicks > 0
          ? `LOCKED (< ${formatTimer(ps.timedTargetTicks)})`
          : 'NONE';
    const killText = ps.killStreakDoorClaimed
      ? 'CLAIMED'
      : ps.killStreakDoorOpen
        ? 'UNLOCKED'
        : ps.killStreakTarget > 0
          ? `LOCKED (${state.maxKillStreak}/${ps.killStreakTarget} Streak)`
          : 'NONE';

    const showFlawlessDoor =
      Boolean(ps.flawlessBossDoorOpen) ||
      ps.fromBiome === 'Bridge' ||
      ps.fromBiome === 'TopClockTower' ||
      ps.fromBiome === 'Throne';
    const flawlessText = ps.flawlessBossDoorClaimed
      ? 'CLAIMED'
      : ps.flawlessBossDoorOpen
        ? 'UNLOCKED — LEGENDARY'
        : 'LOCKED (Took Hit)';

    const flawlessBadgeHtml = showFlawlessDoor
      ? `
        <div class="kc-door-badge ${ps.flawlessBossDoorOpen ? 'is-open is-flawless-open' : ''}">
          <div style="display:flex;align-items:center;gap:9px">
            ${starIcon}
            <div>
              <div style="font-weight:700;color:${ps.flawlessBossDoorOpen ? '#ffd84d' : 'var(--text-bone)'}">Flawless Boss Door</div>
              <div style="font-size:11px;color:var(--text-muted)">Defeat Boss Untouched (Legendary Item + 25 Cells)</div>
            </div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;font-weight:800;color:${ps.flawlessBossDoorOpen ? '#ffd84d' : 'var(--text-muted)'}">${flawlessText}</span>
        </div>
      `
      : '';

    const fountainChargesNote =
      state.fountainRefillsLeft !== undefined || state.singleFlaskRefillsLeft !== undefined
        ? ` Remaining run refills: ${state.fountainRefillsLeft ?? 0} Full / ${state.singleFlaskRefillsLeft ?? 0} Flask.`
        : '';

    const exitButtons = nextBiomes
      .map((biomeId) => {
        const name = getBiomeDisplayName(biomeId, this.catalog);
        const def = this.catalog?.getBiome?.(biomeId);
        const desc = def?.isBossArena
          ? 'Boss Arena — Prepare for battle!'
          : def
            ? `Stage ${def.stageIndex} · ${def.scrollCount} Scrolls`
            : 'Proceed to the next biome';
        const doorIcon = renderUiGlyphSvg('door', 28, def?.isBossArena ? '#e83b4a' : '#22c55e');
        return `
          <div class="kc-npc-card" style="border-color:${def?.isBossArena ? 'var(--brutality)' : 'var(--survival)'}">
            <div class="kc-npc-card-top">
              <div class="kc-npc-icon-frame">${doorIcon}</div>
              <div class="kc-npc-card-titles">
                <div class="kc-npc-card-head">
                  <span class="kc-npc-card-name">${escapeHtml(name)}</span>
                  <span class="kc-npc-tier" style="color:${def?.isBossArena ? 'var(--brutality)' : 'var(--survival)'}">${def?.isBossArena ? 'BOSS GATE' : 'EXIT DOOR'}</span>
                </div>
                <div class="kc-npc-card-desc">${escapeHtml(desc)}</div>
              </div>
            </div>
            <button class="kc-btn kc-btn-sm ${def?.isBossArena ? 'kc-btn-primary' : 'kc-btn-emerald'}" data-enter-biome="${escapeHtml(biomeId)}">
              Enter ${escapeHtml(name)} →
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="kc-door-status-row">
        <div class="kc-door-badge ${ps.timedDoorOpen ? 'is-open' : ''}">
          <div style="display:flex;align-items:center;gap:9px">
            ${timerIcon}
            <div>
              <div style="font-weight:700">Timed Door</div>
              <div style="font-size:11px;color:var(--text-muted)">Run Time: ${formatTimer(p.runTimerTicks)}</div>
            </div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;color:${ps.timedDoorOpen ? 'var(--survival)' : 'var(--text-muted)'}">${timedText}</span>
        </div>
        <div class="kc-door-badge ${ps.killStreakDoorOpen ? 'is-open' : ''}">
          <div style="display:flex;align-items:center;gap:9px">
            ${crownIcon}
            <div>
              <div style="font-weight:700">No-Hit Kill Door</div>
              <div style="font-size:11px;color:var(--text-muted)">Best Streak: ${state.maxKillStreak}</div>
            </div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;color:${ps.killStreakDoorOpen ? 'var(--survival)' : 'var(--text-muted)'}">${killText}</span>
        </div>
        ${flawlessBadgeHtml}
      </div>

      <div class="kc-npc-card" style="border-color:var(--cell-cyan)">
        <div class="kc-npc-card-top">
          <div class="kc-npc-icon-frame" style="border-color:var(--cell-cyan)">${flaskIcon}</div>
          <div class="kc-npc-card-titles">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">Health Fountain</span>
              <span class="kc-npc-tier" style="color:${ps.fountainUsed ? 'var(--text-muted)' : 'var(--survival)'}">
                ${ps.fountainUsed ? 'DEPLETED' : 'READY'}
              </span>
            </div>
            <div class="kc-npc-card-desc">
              Restores HP (${Math.ceil(p.hp)}/${Math.ceil(p.maxHp)}) and refills Health Flask charges (${p.flaskCharges}/${p.maxFlaskCharges}) per Boss Cell difficulty rules.${fountainChargesNote}
            </div>
          </div>
        </div>
        <div>
          <button class="kc-btn kc-btn-sm kc-btn-cyan" data-act="fountain" ${ps.fountainUsed ? 'disabled' : ''}>
            ${ps.fountainUsed ? 'Fountain Already Used' : 'Drink from Health Fountain'}
          </button>
        </div>
      </div>

      <div style="font-family:var(--font-display);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--gold-amber)">
        Choose Next Biome
      </div>
      <div class="kc-card-grid">${exitButtons}</div>
    `;
  }

  private bindEvents(state: SimState): void {
    this.backdropEl.querySelector('[data-act="close"]')?.addEventListener('click', () => this.close());

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.tab as PassageTab;
        this.callbacks.onPlayUiClick?.('select');
        this.activeTab = next;
        this.lastRenderSig = '';
        if (next === 'collector' || next === 'guillain' || next === 'forge') {
          this.callbacks.onDispatchCommand({ type: 'openPassageNpc', npc: next });
        }
        this.render(state);
      });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-invest]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const blueprintId = btn.dataset.invest!;
        const amount = Math.max(1, Number(btn.dataset.amt) || 1);
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'collectorInvest', blueprintId, amount });
      });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-pick-mut]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mutationId = btn.dataset.pickMut!;
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'pickMutation', mutationId });
      });
    });

    this.backdropEl.querySelector('[data-act="respec"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({ type: 'respecMutations' });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-forge-up]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.dataset.forgeUp as 'weapon1' | 'weapon2' | 'skill1' | 'skill2';
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'forgeUpgrade', slot });
      });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-forge-reforge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.dataset.forgeReforge as 'weapon1' | 'weapon2' | 'skill1' | 'skill2';
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'forgeReforge', slot });
      });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-leg-forge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tier = btn.dataset.legForge as 'plus' | 'plusPlus';
        const amount = Math.max(1, Number(btn.dataset.amt) || 1);
        this.callbacks.onPlayUiClick?.('confirm');
        this.callbacks.onDispatchCommand({ type: 'legendaryForgeInvest', tier, amount });
      });
    });

    this.backdropEl.querySelector('[data-act="fountain"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('confirm');
      this.callbacks.onDispatchCommand({ type: 'useFountain' });
    });

    this.backdropEl.querySelectorAll<HTMLButtonElement>('[data-enter-biome]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const biomeId = btn.dataset.enterBiome as BiomeId;
        this.callbacks.onPlayUiClick?.('confirm');
        this.manualOpen = false;
        this.backdropEl.classList.add('kc-hidden');
        this.callbacks.onDispatchCommand({ type: 'enterBiome', biomeId });
      });
    });
  }
}
