// =============================================================================
// KRUNKED CELLS — Compact Corner Minimap + Expandable Tab Map & Rune Teleport
// Clicking any discovered Teleportation Rune dispatches { type: 'teleportTo' }.
// =============================================================================

import { SimCommand, SimState, TILE_SIZE, TileKind } from '../contracts';
import { CatalogLookup, escapeHtml, getBiomeDisplayName } from './HudOverlay';

export interface MinimapCallbacks {
  onDispatchCommand(cmd: SimCommand): void;
  onPlayUiClick?(kind?: 'select' | 'confirm' | 'cancel' | 'error'): void;
}

interface ProjectedRune {
  uid: number;
  x: number;
  y: number;
  r: number;
  label: string;
}

export class Minimap {
  private callbacks: MinimapCallbacks;
  private catalog?: CatalogLookup;

  private miniShell: HTMLDivElement;
  private miniCanvas: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D | null;
  private miniFooterLabel: HTMLSpanElement;

  private modalBackdrop: HTMLDivElement;
  private modalTitleEl: HTMLHeadingElement;
  private expandedCanvas: HTMLCanvasElement;
  private expandedCtx: CanvasRenderingContext2D | null;
  private runeListEl: HTMLDivElement;

  private expanded = false;
  private expandedRunes: ProjectedRune[] = [];
  private hoveredRuneUid: number | null = null;
  private lastRuneListSig = '';
  private lastState: SimState | null = null;
  private animTime = 0;

  constructor(
    miniHost: HTMLElement,
    uiRoot: HTMLElement,
    callbacks: MinimapCallbacks,
    catalog?: CatalogLookup
  ) {
    this.callbacks = callbacks;
    this.catalog = catalog;

    // 1. Compact corner minimap
    this.miniShell = document.createElement('div');
    this.miniShell.className = 'kc-minimap-shell kc-iron-panel';
    this.miniShell.title = 'Click or press [Tab] to expand Map & Teleport';

    this.miniCanvas = document.createElement('canvas');
    this.miniCanvas.className = 'kc-minimap-canvas';
    this.miniCanvas.width = 176;
    this.miniCanvas.height = 98;
    this.miniCtx = this.miniCanvas.getContext('2d');

    const footer = document.createElement('div');
    footer.className = 'kc-minimap-footer';
    this.miniFooterLabel = document.createElement('span');
    this.miniFooterLabel.textContent = '[TAB] MAP';
    const tpHint = document.createElement('span');
    tpHint.style.color = '#38e8ff';
    tpHint.textContent = '◈ TELEPORT';
    footer.append(this.miniFooterLabel, tpHint);

    this.miniShell.append(this.miniCanvas, footer);
    this.miniShell.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('select');
      this.toggleExpanded(true);
    });
    miniHost.appendChild(this.miniShell);

    // 2. Expanded Tab Map Overlay
    this.modalBackdrop = document.createElement('div');
    this.modalBackdrop.className = 'kc-modal-backdrop kc-hidden';
    this.modalBackdrop.innerHTML = `
      <div class="kc-minimap-modal kc-iron-panel">
        <div class="kc-minimap-modal-head">
          <div>
            <h2 class="kc-modal-title" style="font-size:18px;text-align:left">Biome Map</h2>
            <div style="font-size:11px;color:var(--cell-cyan);font-family:var(--font-mono)">Click any glowing cyan Teleportation Rune to Fast Travel</div>
          </div>
          <button class="kc-btn kc-btn-sm" data-act="close">Close [Tab / Esc]</button>
        </div>
        <canvas class="kc-minimap-expanded-canvas" width="780" height="440"></canvas>
        <div class="kc-dev-row" data-el="rune-pills"></div>
        <div class="kc-minimap-legend">
          <span><i class="kc-legend-dot" style="background:#ffffff"></i>You</span>
          <span><i class="kc-legend-dot" style="background:#38e8ff;box-shadow:0 0 6px #38e8ff"></i>Teleport Rune (Click)</span>
          <span><i class="kc-legend-dot" style="background:#22c55e"></i>Biome Exit</span>
          <span><i class="kc-legend-dot" style="background:#fbbf24"></i>Chest / Shop</span>
          <span><i class="kc-legend-dot" style="background:#a855f7"></i>Power Scroll</span>
          <span><i class="kc-legend-dot" style="background:#e83b4a"></i>Cursed / Boss</span>
        </div>
      </div>
    `;

    this.modalTitleEl = this.modalBackdrop.querySelector('.kc-modal-title') as HTMLHeadingElement;
    this.expandedCanvas = this.modalBackdrop.querySelector('.kc-minimap-expanded-canvas') as HTMLCanvasElement;
    this.expandedCtx = this.expandedCanvas.getContext('2d');
    this.runeListEl = this.modalBackdrop.querySelector('[data-el="rune-pills"]') as HTMLDivElement;

    this.modalBackdrop.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      this.callbacks.onPlayUiClick?.('cancel');
      this.toggleExpanded(false);
    });
    this.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === this.modalBackdrop) {
        this.callbacks.onPlayUiClick?.('cancel');
        this.toggleExpanded(false);
      }
    });

    this.expandedCanvas.addEventListener('mousemove', this.handleExpandedMouseMove);
    this.expandedCanvas.addEventListener('click', this.handleExpandedClick);

    uiRoot.appendChild(this.modalBackdrop);
  }

  public setCatalog(catalog?: CatalogLookup): void {
    this.catalog = catalog;
  }

  public isExpanded(): boolean {
    return this.expanded;
  }

  public toggleExpanded(force?: boolean): boolean {
    const next = force !== undefined ? force : !this.expanded;
    this.expanded = next;
    this.modalBackdrop.classList.toggle('kc-hidden', !this.expanded);
    if (this.expanded && this.lastState) {
      this.renderRuneButtons(this.lastState);
      this.renderCanvas(this.expandedCtx, this.expandedCanvas, this.lastState, true);
    }
    return this.expanded;
  }

  public update(state: SimState, dtSec: number): void {
    this.lastState = state;
    this.animTime += dtSec;

    const exploredRooms = state.rooms.filter((r) => r.discovered).length;
    const totalRooms = Math.max(1, state.rooms.length);
    this.miniFooterLabel.textContent = `MAP ${exploredRooms}/${totalRooms}`;

    this.renderCanvas(this.miniCtx, this.miniCanvas, state, false);

    if (this.expanded) {
      this.modalTitleEl.textContent = `${getBiomeDisplayName(state.activeBiomeId, this.catalog)} — Map`;
      const runeSig = this.getDiscoverableTeleporters(state)
        .map((tp) => `${tp.uid}:${tp.label}`)
        .join('|');
      if (runeSig !== this.lastRuneListSig) {
        this.lastRuneListSig = runeSig;
        this.renderRuneButtons(state);
      }
      this.renderCanvas(this.expandedCtx, this.expandedCanvas, state, true);
    }
  }

  public dispose(): void {
    this.expandedCanvas.removeEventListener('mousemove', this.handleExpandedMouseMove);
    this.expandedCanvas.removeEventListener('click', this.handleExpandedClick);
    this.miniShell.remove();
    this.modalBackdrop.remove();
  }

  private renderRuneButtons(state: SimState): void {
    const discovered = this.getDiscoverableTeleporters(state);
    if (discovered.length === 0) {
      this.runeListEl.innerHTML =
        '<span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">Explore rooms to discover Teleportation Runes.</span>';
      return;
    }
    this.runeListEl.innerHTML = discovered
      .map(
        (tp) =>
          `<button class="kc-btn kc-btn-sm kc-btn-cyan" data-tp-uid="${tp.uid}">◈ ${escapeHtml(tp.label || `Rune #${tp.uid}`)}</button>`
      )
      .join('');
    this.runeListEl.querySelectorAll<HTMLButtonElement>('[data-tp-uid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = Number(btn.dataset.tpUid);
        this.teleportTo(uid);
      });
    });
  }

  private teleportTo(teleporterUid: number): void {
    this.callbacks.onPlayUiClick?.('confirm');
    this.callbacks.onDispatchCommand({ type: 'teleportTo', teleporterUid });
    this.toggleExpanded(false);
  }

  private getDiscoverableTeleporters(state: SimState) {
    return state.teleporters.filter((tp) => {
      if (tp.activated) return true;
      const room = state.rooms.find((r) => r.id === tp.roomId);
      if (room?.discovered) return true;
      const tx = Math.floor(tp.pos.x / TILE_SIZE);
      const ty = Math.floor(tp.pos.y / TILE_SIZE);
      const idx = ty * state.tileGrid.width + tx;
      return Boolean(state.tileGrid.explored[idx]);
    });
  }

  private renderCanvas(
    ctx: CanvasRenderingContext2D | null,
    canvas: HTMLCanvasElement,
    state: SimState,
    isExpanded: boolean
  ): void {
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#08060f';
    ctx.fillRect(0, 0, w, h);

    const grid = state.tileGrid;
    if (grid.width <= 0 || grid.height <= 0) return;

    // Determine visible bounding box in tile coordinates
    let minTx = grid.width;
    let minTy = grid.height;
    let maxTx = 0;
    let maxTy = 0;
    let hasExplored = false;

    for (const r of state.rooms) {
      if (!r.discovered && state.rooms.some((rm) => rm.discovered)) continue;
      hasExplored = true;
      if (r.tx < minTx) minTx = r.tx;
      if (r.ty < minTy) minTy = r.ty;
      if (r.tx + r.tw > maxTx) maxTx = r.tx + r.tw;
      if (r.ty + r.th > maxTy) maxTy = r.ty + r.th;
    }

    const ptx = state.player.pos.x / TILE_SIZE;
    const pty = state.player.pos.y / TILE_SIZE;
    if (!hasExplored) {
      minTx = Math.max(0, Math.floor(ptx - 24));
      maxTx = Math.min(grid.width, Math.ceil(ptx + 24));
      minTy = Math.max(0, Math.floor(pty - 14));
      maxTy = Math.min(grid.height, Math.ceil(pty + 14));
    } else {
      minTx = Math.max(0, minTx - 3);
      minTy = Math.max(0, minTy - 3);
      maxTx = Math.min(grid.width, maxTx + 3);
      maxTy = Math.min(grid.height, maxTy + 3);
    }

    const pad = isExpanded ? 26 : 8;
    let scale: number;
    let originX: number;
    let originY: number;

    if (!isExpanded) {
      // Compact corner map follows player smoothly at crisp tile scale
      scale = 2.6;
      originX = w * 0.5 - ptx * scale;
      originY = h * 0.5 - pty * scale;
    } else {
      const spanX = Math.max(12, maxTx - minTx);
      const spanY = Math.max(8, maxTy - minTy);
      scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
      scale = Math.max(2, Math.min(12, scale));
      originX = (w - spanX * scale) * 0.5 - minTx * scale;
      originY = (h - spanY * scale) * 0.5 - minTy * scale;
    }

    const toX = (wx: number) => originX + (wx / TILE_SIZE) * scale;
    const toY = (wy: number) => originY + (wy / TILE_SIZE) * scale;

    // 1. Draw discovered rooms fill
    for (const r of state.rooms) {
      if (!r.discovered && hasExplored) continue;
      const rx = originX + r.tx * scale;
      const ry = originY + r.ty * scale;
      const rw = r.tw * scale;
      const rh = r.th * scale;

      let fill = 'rgba(42, 34, 62, 0.52)';
      let stroke = 'rgba(116, 98, 152, 0.55)';
      if (r.type === 'bossArena') {
        fill = 'rgba(128, 22, 38, 0.45)';
        stroke = '#e83b4a';
      } else if (r.type === 'treasure') {
        fill = 'rgba(120, 92, 24, 0.42)';
        stroke = '#fbbf24';
      } else if (r.type === 'weaponShop' || r.type === 'skillShop' || r.type === 'foodShop') {
        fill = 'rgba(104, 74, 24, 0.4)';
        stroke = '#f59e0b';
      } else if (r.type === 'cursedChest') {
        fill = 'rgba(130, 18, 32, 0.45)';
        stroke = '#dc2626';
      } else if (r.type === 'exit') {
        fill = 'rgba(20, 96, 52, 0.45)';
        stroke = '#22c55e';
      } else if (r.type === 'teleporter') {
        fill = 'rgba(14, 74, 96, 0.42)';
        stroke = '#38e8ff';
      }

      ctx.fillStyle = fill;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    }

    // 2. Draw explored tile outlines (solid walls, platforms, acid/water)
    const startTx = Math.max(0, Math.floor(-originX / scale));
    const endTx = Math.min(grid.width - 1, Math.ceil((w - originX) / scale));
    const startTy = Math.max(0, Math.floor(-originY / scale));
    const endTy = Math.min(grid.height - 1, Math.ceil((h - originY) / scale));

    const hasAnyExploredTile = grid.explored.some((v) => v > 0);
    const tileDrawSize = Math.max(1.2, Math.ceil(scale));

    for (let ty = startTy; ty <= endTy; ty++) {
      const rowOff = ty * grid.width;
      for (let tx = startTx; tx <= endTx; tx++) {
        const idx = rowOff + tx;
        if (hasAnyExploredTile && !grid.explored[idx]) continue;
        const kind = grid.tiles[idx];
        if (kind === TileKind.EMPTY || kind === TileKind.BG_WALL) continue;

        if (kind === TileKind.SOLID || kind === TileKind.SECRET_WALL) {
          // Only draw boundary solid tiles for crisp architectural outline
          const openNeighbor =
            (tx > 0 && grid.tiles[idx - 1] !== TileKind.SOLID) ||
            (tx < grid.width - 1 && grid.tiles[idx + 1] !== TileKind.SOLID) ||
            (ty > 0 && grid.tiles[idx - grid.width] !== TileKind.SOLID) ||
            (ty < grid.height - 1 && grid.tiles[idx + grid.width] !== TileKind.SOLID);
          if (!openNeighbor) continue;
          ctx.fillStyle = '#8b7ea8';
        } else if (kind === TileKind.ONE_WAY) {
          ctx.fillStyle = '#5c5278';
        } else if (kind === TileKind.ACID) {
          ctx.fillStyle = '#4ade80';
        } else if (kind === TileKind.WATER) {
          ctx.fillStyle = '#38bdf8';
        } else if (kind === TileKind.SPIKES) {
          ctx.fillStyle = '#f87171';
        } else if (kind === TileKind.EXIT_GATE) {
          ctx.fillStyle = '#22c55e';
        } else {
          continue;
        }
        ctx.fillRect(originX + tx * scale, originY + ty * scale, tileDrawSize, tileDrawSize);
      }
    }

    // 3. Markers: Chests
    for (const c of state.chests) {
      if (c.opened) continue;
      const room = state.rooms.find((r) => r.id === c.roomId);
      if (hasExplored && room && !room.discovered) continue;
      const mx = toX(c.pos.x);
      const my = toY(c.pos.y);
      ctx.fillStyle = c.kind === 'cursed' ? '#e83b4a' : '#fbbf24';
      const sz = isExpanded ? 7 : 4;
      ctx.fillRect(mx - sz * 0.5, my - sz * 0.5, sz, sz);
    }

    // 4. Markers: Scrolls & Shops (pickups)
    for (const pk of state.pickups) {
      if (pk.collected) continue;
      if (pk.kind !== 'scroll' && pk.kind !== 'dualScroll' && !(pk.priceGold && pk.priceGold > 0)) continue;
      const tx = Math.floor(pk.pos.x / TILE_SIZE);
      const ty = Math.floor(pk.pos.y / TILE_SIZE);
      if (hasAnyExploredTile && !grid.explored[ty * grid.width + tx]) continue;
      const mx = toX(pk.pos.x);
      const my = toY(pk.pos.y);
      ctx.fillStyle = pk.kind === 'scroll' || pk.kind === 'dualScroll' ? '#a855f7' : '#f59e0b';
      ctx.beginPath();
      ctx.arc(mx, my, isExpanded ? 3.5 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Markers: Biome Exits
    for (const d of state.doors) {
      if (d.kind !== 'biomeExit') continue;
      const mx = toX(d.pos.x + d.width * 0.5);
      const my = toY(d.pos.y + d.height * 0.5);
      ctx.fillStyle = '#22c55e';
      const sz = isExpanded ? 8 : 5;
      ctx.fillRect(mx - sz * 0.5, my - sz * 0.65, sz, sz * 1.3);
    }

    // 6. Markers: Discovered Teleportation Runes (Glowing Pulsing Cyan Diamonds!)
    if (isExpanded) this.expandedRunes = [];
    const pulse = 0.72 + Math.sin(this.animTime * 5.2) * 0.28;
    const discoveredRunes = this.getDiscoverableTeleporters(state);

    for (const tp of discoveredRunes) {
      const mx = toX(tp.pos.x);
      const my = toY(tp.pos.y);
      const isHovered = isExpanded && this.hoveredRuneUid === tp.uid;
      const r = isExpanded ? (isHovered ? 9 : 7) : 4;

      if (isExpanded) {
        this.expandedRunes.push({ uid: tp.uid, x: mx, y: my, r: 15, label: tp.label || `Rune #${tp.uid}` });
      }

      // Outer glow ring
      ctx.save();
      ctx.strokeStyle = `rgba(56, 232, 255, ${(isHovered ? 1 : 0.65 * pulse).toFixed(2)})`;
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(mx, my, r + 3 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      // Glowing cyan diamond
      ctx.fillStyle = isHovered ? '#ffffff' : '#38e8ff';
      ctx.beginPath();
      ctx.moveTo(mx, my - r);
      ctx.lineTo(mx + r * 0.8, my);
      ctx.lineTo(mx, my + r);
      ctx.lineTo(mx - r * 0.8, my);
      ctx.closePath();
      ctx.fill();

      if (isExpanded) {
        ctx.font = 'bold 11px Consolas, monospace';
        ctx.fillStyle = isHovered ? '#ffffff' : '#9beeff';
        ctx.textAlign = 'center';
        ctx.fillText(tp.label || `Rune #${tp.uid}`, mx, my - r - 7);
      }
      ctx.restore();
    }

    // 7. Player Directional Arrow
    const px = toX(state.player.pos.x + state.player.width * 0.5);
    const py = toY(state.player.pos.y + state.player.height * 0.5);
    const dir = state.player.facing;
    const pr = isExpanded ? 7 : 4.5;

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#07060b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + dir * pr * 1.25, py);
    ctx.lineTo(px - dir * pr * 0.85, py - pr * 0.85);
    ctx.lineTo(px - dir * pr * 0.4, py);
    ctx.lineTo(px - dir * pr * 0.85, py + pr * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private hitTestExpandedRune(e: MouseEvent): ProjectedRune | null {
    const rect = this.expandedCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const cx = ((e.clientX - rect.left) / rect.width) * this.expandedCanvas.width;
    const cy = ((e.clientY - rect.top) / rect.height) * this.expandedCanvas.height;

    let best: ProjectedRune | null = null;
    let bestDist = Infinity;
    for (const rune of this.expandedRunes) {
      const d = Math.hypot(cx - rune.x, cy - rune.y);
      if (d <= rune.r && d < bestDist) {
        best = rune;
        bestDist = d;
      }
    }
    return best;
  }

  private handleExpandedMouseMove = (e: MouseEvent): void => {
    const hit = this.hitTestExpandedRune(e);
    this.hoveredRuneUid = hit ? hit.uid : null;
    this.expandedCanvas.style.cursor = hit ? 'pointer' : 'default';
    this.expandedCanvas.title = hit ? `Click to Teleport to ${hit.label}` : 'Biome Map';
  };

  private handleExpandedClick = (e: MouseEvent): void => {
    const hit = this.hitTestExpandedRune(e);
    if (hit) {
      this.teleportTo(hit.uid);
    }
  };
}
