// =============================================================================
// KRUNKED CELLS — The Passage Safe Room Modal
// Tabs: The Collector, Guillain (Mutations), Minor Forge, Fountain & Exits.
// =============================================================================

import {
  BiomeId,
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
  escapeHtml,
  estimateGearPower,
  formatGearBadge,
  formatTimer,
  getAffixDisplayLabel,
  getBiomeDisplayName,
  getGearDisplayInfo,
  getMutationDisplayInfo,
} from './HudOverlay';

export type PassageTab = 'collector' | 'guillain' | 'forge' | 'exits';

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

  private backdropEl: HTMLDivElement;
  private quickBarEl: HTMLDivElement;
  private activeTab: PassageTab = 'collector';
  private manualOpen = false;
  private lastActiveNpc: 'none' | 'collector' | 'guillain' | 'forge' = 'none';
  private lastRenderSig = '';

  constructor(uiRoot: HTMLElement, callbacks: PassageModalCallbacks, catalog?: CatalogLookup) {
    this.callbacks = callbacks;
    this.catalog = catalog;

    // Non-blocking quick access strip while standing inside The Passage safe room
    this.quickBarEl = document.createElement('div');
    this.quickBarEl.className = 'kc-iron-panel kc-hidden';
    this.quickBarEl.style.cssText =
      'position:absolute;bottom:14px;right:14px;padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:auto;z-index:25;';
    this.quickBarEl.innerHTML = `
      <button class="kc-btn kc-btn-sm kc-btn-cyan" data-open-tab="collector">✦ Collector</button>
      <button class="kc-btn kc-btn-sm" data-open-tab="guillain">◈ Guillain</button>
      <button class="kc-btn kc-btn-sm" data-open-tab="forge">⚒ Minor Forge</button>
      <button class="kc-btn kc-btn-sm kc-btn-emerald" data-open-tab="exits">⚑ Fountain & Exits</button>
    `;
    this.quickBarEl.querySelectorAll<HTMLButtonElement>('[data-open-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.openTab as PassageTab;
        this.callbacks.onPlayUiClick?.('select');
        this.openTab(tab);
      });
    });
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

  public isOpen(): boolean {
    return !this.backdropEl.classList.contains('kc-hidden');
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

    // Sync NPC interaction triggered by walking up to shrines in-world
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
    return `${this.activeTab}|c${p.cells}|g${p.gold}|hp${Math.ceil(p.hp)}/${Math.ceil(p.maxHp)}|fl${p.flaskCharges}/${p.maxFlaskCharges}|f${ps.fountainUsed}|td${ps.timedDoorOpen}${ps.timedDoorClaimed}|kd${ps.killStreakDoorOpen}${ps.killStreakDoorClaimed}|rf${ps.reforgeCount}|m${p.mutations.join(',')}|ub${ms.unlockedBlueprints.length}|ft${ms.flaskTier}|gr${ms.goldReserveTier}|rs${ms.randomStarterUnlocked}|rc${ms.recycleUnlocked}|${progKey}|${gearKey}|nb${ps.nextBiomes.join(',')}`;
  }

  private render(state: SimState): void {
    const p = state.player;
    const ps = state.passageState;

    const tabBtn = (id: PassageTab, label: string) =>
      `<button class="kc-tab ${this.activeTab === id ? 'is-active' : ''}" data-tab="${id}">${label}</button>`;

    let bodyHtml = '';
    if (this.activeTab === 'collector') {
      bodyHtml = this.renderCollectorTab(state);
    } else if (this.activeTab === 'guillain') {
      bodyHtml = this.renderGuillainTab(state);
    } else if (this.activeTab === 'forge') {
      bodyHtml = this.renderForgeTab(state);
    } else {
      bodyHtml = this.renderExitsTab(state);
    }

    this.backdropEl.innerHTML = `
      <div class="kc-passage-modal kc-iron-panel">
        <div class="kc-passage-head">
          <div>
            <h2 class="kc-modal-title" style="font-size:19px;text-align:left">The Passage — Safe Haven</h2>
            <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">
              Cleared: ${escapeHtml(getBiomeDisplayName(ps.fromBiome, this.catalog))}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:13px;font-weight:700">
            <span class="kc-res-cells">✦ ${Math.floor(p.cells)} Cells</span>
            <span class="kc-res-gold">◈ ${Math.floor(p.gold)} Gold</span>
            <button class="kc-btn kc-btn-sm" data-act="close">Close [Esc]</button>
          </div>
        </div>
        <div class="kc-tabs">
          ${tabBtn('collector', '✦ The Collector')}
          ${tabBtn('guillain', '◈ Guillain (Mutations)')}
          ${tabBtn('forge', '⚒ Minor Forge')}
          ${tabBtn('exits', '⚑ Fountain & Next Biome')}
        </div>
        <div class="kc-passage-body">
          ${bodyHtml}
        </div>
      </div>
    `;

    this.bindEvents(state);
  }

  private renderCollectorTab(state: SimState): string {
    const blueprints: readonly MetaBlueprintDef[] =
      this.catalog?.metaBlueprints && this.catalog.metaBlueprints.length > 0
        ? this.catalog.metaBlueprints
        : FALLBACK_META_BLUEPRINTS;
    const ms = state.metaSnapshot;
    const cells = Math.floor(state.player.cells);

    const cards = blueprints
      .map((bp) => {
        const status = this.getBlueprintStatus(bp, state);
        const pct = status.maxed ? 100 : Math.min(100, Math.round((status.invested / Math.max(1, status.cost)) * 100));
        const rem = Math.max(0, status.cost - status.invested);

        return `
          <div class="kc-npc-card">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">${escapeHtml(bp.name)}</span>
              <span style="font-family:var(--font-mono);font-size:10px;color:${status.maxed ? 'var(--survival)' : 'var(--cell-cyan)'}">
                ${status.maxed ? 'UNLOCKED' : status.tierLabel}
              </span>
            </div>
            <div class="kc-npc-card-desc">${escapeHtml(bp.description)}</div>
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
          return `<div class="kc-npc-card" style="opacity:0.65"><div class="kc-npc-card-name">Slot ${idx + 1} — Empty</div><div class="kc-npc-card-desc">Choose a mutation below.</div></div>`;
        }
        const info = getMutationDisplayInfo(id, this.catalog);
        return `
          <div class="kc-npc-card kc-color-${info.color}">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">${escapeHtml(info.name)}</span>
              <span style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase">SLOT ${idx + 1}</span>
            </div>
            <div class="kc-npc-card-desc">${escapeHtml(info.description)}</div>
          </div>
        `;
      })
      .join('');

    const cards = allMuts
      .filter((m) => m.unlocked)
      .map((m) => {
        const isEquipped = equipped.includes(m.id);
        const full = equipped.length >= 3 && !isEquipped;
        return `
          <div class="kc-npc-card kc-color-${m.color}">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">${escapeHtml(m.name)}</span>
              <span style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase">${escapeHtml(m.color)}</span>
            </div>
            <div class="kc-npc-card-desc">${escapeHtml(m.description)}</div>
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
        const badge = formatGearBadge(gear.level, gear.quality);
        const nextQ = NEXT_QUALITY[gear.quality];
        const pwr = estimateGearPower(gear, state, this.catalog);
        const colorClass = gear.quality === 'L' ? 'kc-color-colorless' : `kc-color-${gear.color}`;
        const affixesHtml =
          gear.affixes.length > 0
            ? `<ul class="kc-affix-list">${gear.affixes
                .map((a) => `<li>${escapeHtml(getAffixDisplayLabel(a, this.catalog))}</li>`)
                .join('')}</ul>`
            : `<div class="kc-npc-card-desc">No active affixes yet.</div>`;

        return `
          <div class="kc-npc-card ${colorClass}">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">${info.glyph} ${escapeHtml(info.name)} <span style="font-family:var(--font-mono);color:var(--gold-amber)">${escapeHtml(badge)}</span></span>
              <span style="font-family:var(--font-mono);font-size:10px">${label} · PWR ${pwr}</span>
            </div>
            ${affixesHtml}
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

    return `
      <div style="font-size:12px;color:var(--text-parchment)">
        Upgrade gear quality (<code>base → + → ++ → S</code>) or re-roll combat synergy affixes with <strong style="color:var(--gold-amber)">Gold</strong>.
      </div>
      <div class="kc-card-grid">${cards}</div>
    `;
  }

  private renderExitsTab(state: SimState): string {
    const ps = state.passageState;
    const p = state.player;
    const nextBiomes: BiomeId[] = ps.nextBiomes.length > 0 ? ps.nextBiomes : ['PrisonCourtyard'];

    const timedText = ps.timedDoorClaimed
      ? 'CLAIMED'
      : ps.timedDoorOpen
        ? 'UNLOCKED!'
        : `LOCKED (< ${formatTimer(ps.timedTargetTicks)})`;
    const killText = ps.killStreakDoorClaimed
      ? 'CLAIMED'
      : ps.killStreakDoorOpen
        ? 'UNLOCKED!'
        : `LOCKED (${state.maxKillStreak}/${ps.killStreakTarget} Streak)`;

    const exitButtons = nextBiomes
      .map((biomeId) => {
        const name = getBiomeDisplayName(biomeId, this.catalog);
        const def = this.catalog?.getBiome?.(biomeId);
        const desc = def?.isBossArena
          ? 'Boss Arena — Prepare for battle!'
          : def
            ? `Stage ${def.stageIndex} · ${def.scrollCount} Scrolls`
            : 'Proceed to the next biome';
        return `
          <div class="kc-npc-card" style="border-color:var(--survival)">
            <div class="kc-npc-card-head">
              <span class="kc-npc-card-name">${escapeHtml(name)}</span>
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--survival)">EXIT DOOR</span>
            </div>
            <div class="kc-npc-card-desc">${escapeHtml(desc)}</div>
            <button class="kc-btn kc-btn-sm kc-btn-emerald" data-enter-biome="${escapeHtml(biomeId)}">
              Enter ${escapeHtml(name)} →
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="kc-door-status-row">
        <div class="kc-door-badge ${ps.timedDoorOpen ? 'is-open' : ''}">
          <div>
            <div style="font-weight:700">⧖ Timed Door</div>
            <div style="font-size:11px;color:var(--text-muted)">Run Time: ${formatTimer(p.runTimerTicks)}</div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;color:${ps.timedDoorOpen ? 'var(--survival)' : 'var(--text-muted)'}">${timedText}</span>
        </div>
        <div class="kc-door-badge ${ps.killStreakDoorOpen ? 'is-open' : ''}">
          <div>
            <div style="font-weight:700">★ No-Hit Kill Door</div>
            <div style="font-size:11px;color:var(--text-muted)">Best Streak: ${state.maxKillStreak}</div>
          </div>
          <span style="font-family:var(--font-mono);font-size:11px;color:${ps.killStreakDoorOpen ? 'var(--survival)' : 'var(--text-muted)'}">${killText}</span>
        </div>
      </div>

      <div class="kc-npc-card" style="border-color:var(--cell-cyan)">
        <div class="kc-npc-card-head">
          <span class="kc-npc-card-name">💧 Health Fountain</span>
          <span style="font-family:var(--font-mono);font-size:11px;color:${ps.fountainUsed ? 'var(--text-muted)' : 'var(--survival)'}">
            ${ps.fountainUsed ? 'DEPLETED' : 'READY'}
          </span>
        </div>
        <div class="kc-npc-card-desc">
          Restores HP (${Math.ceil(p.hp)}/${Math.ceil(p.maxHp)}) and refills Health Flask charges (${p.flaskCharges}/${p.maxFlaskCharges}) per Boss Cell difficulty rules.
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
