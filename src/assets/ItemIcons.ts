// =============================================================================
// KRUNKED CELLS — PIXEL-ART ITEM / SKILL / MUTATION / HUD ICON PROVIDER
// Resolves crisp 24x24 pixel-art icons from Owned Custom Pack (`cardIcons.png`)
// in Custom Pack Mode, or hand-crafted Built-In Krunked 24x24 pixel icons
// (nearest-neighbor upscaled 2x to 48x48 PNG data URLs) in Built-In Mode.
// Zero external dependencies; safe no-op in headless Node/Vitest.
// =============================================================================

import type { ArtPackMode, CustomPackAssetResolver } from '../contracts';

const ICON_SIZE = 24;
const UPSCALE_SIZE = 48;
const OUTLINE_HEX = '#090710';

const builtinCache = new Map<string, string>();
let scratchSmallCanvas: HTMLCanvasElement | null = null;
let scratchSmallCtx: CanvasRenderingContext2D | null = null;
let scratchBigCanvas: HTMLCanvasElement | null = null;
let scratchBigCtx: CanvasRenderingContext2D | null = null;

type RGBA = readonly [number, number, number, number];

const hexCache = new Map<string, RGBA>();

function parseHexRgba(hex: string, alphaOverride?: number): RGBA {
  const key = alphaOverride !== undefined ? `${hex}@${alphaOverride}` : hex;
  const hit = hexCache.get(key);
  if (hit) return hit;
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  let a = 255;
  if (alphaOverride !== undefined) {
    a = Math.max(0, Math.min(255, Math.round(alphaOverride * 255)));
  } else if (clean.length === 8) {
    a = parseInt(clean.slice(6, 8), 16);
  }
  const rgba: RGBA = [r, g, b, a];
  hexCache.set(key, rgba);
  return rgba;
}

// =============================================================================
// Zero-Dependency 24x24 Pixel-Art Icon Painter
// =============================================================================

class PixelIconPainter {
  readonly data = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);

  px(x: number, y: number, hex: string, alpha?: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= ICON_SIZE || iy >= ICON_SIZE) return;
    const [r, g, b, a] = parseHexRgba(hex, alpha);
    const o = (iy * ICON_SIZE + ix) * 4;
    if (a >= 255 || this.data[o + 3] === 0) {
      this.data[o] = r;
      this.data[o + 1] = g;
      this.data[o + 2] = b;
      this.data[o + 3] = a;
    } else if (a > 0) {
      const sa = a / 255;
      const da = (this.data[o + 3] / 255) * (1 - sa);
      const outA = sa + da;
      if (outA > 0) {
        this.data[o] = Math.round((r * sa + this.data[o] * da) / outA);
        this.data[o + 1] = Math.round((g * sa + this.data[o + 1] * da) / outA);
        this.data[o + 2] = Math.round((b * sa + this.data[o + 2] * da) / outA);
        this.data[o + 3] = Math.round(outA * 255);
      }
    }
  }

  clear(x: number, y: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= ICON_SIZE || iy >= ICON_SIZE) return;
    const o = (iy * ICON_SIZE + ix) * 4;
    this.data[o] = 0;
    this.data[o + 1] = 0;
    this.data[o + 2] = 0;
    this.data[o + 3] = 0;
  }

  rect(x: number, y: number, w: number, h: number, hex: string, alpha?: number): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.px(x + dx, y + dy, hex, alpha);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, hex: string, thickness = 1): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
    const rad = Math.max(0, (thickness - 1) * 0.5);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      if (rad <= 0.15) {
        this.px(cx, cy, hex);
      } else {
        const rr = Math.ceil(rad);
        for (let oy = -rr; oy <= rr; oy++) {
          for (let ox = -rr; ox <= rr; ox++) {
            if (Math.hypot(ox, oy) <= rad + 0.35) {
              this.px(cx + ox, cy + oy, hex);
            }
          }
        }
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, hex: string, alpha?: number): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / Math.max(0.4, rx);
        const ny = (y - cy) / Math.max(0.4, ry);
        if (nx * nx + ny * ny <= 1.0) {
          this.px(x, y, hex, alpha);
        }
      }
    }
  }

  ring(cx: number, cy: number, rOuter: number, rInner: number, hex: string, alpha?: number): void {
    const x0 = Math.floor(cx - rOuter - 1);
    const x1 = Math.ceil(cx + rOuter + 1);
    const y0 = Math.floor(cy - rOuter - 1);
    const y1 = Math.ceil(cy + rOuter + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rOuter && d >= rInner) {
          this.px(x, y, hex, alpha);
        }
      }
    }
  }

  poly(pts: ReadonlyArray<readonly [number, number]>, hex: string, alpha?: number): void {
    if (pts.length < 3) return;
    let minY = ICON_SIZE;
    let maxY = 0;
    for (const [, py] of pts) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(ICON_SIZE - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const scanY = y + 0.05;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if ((yi > scanY) !== (yj > scanY)) {
          xs.push(xi + ((scanY - yi) * (xj - xi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx = Math.max(0, Math.floor(xs[k]));
        const ex = Math.min(ICON_SIZE - 1, Math.ceil(xs[k + 1]));
        for (let x = sx; x <= ex; x++) {
          this.px(x, y, hex, alpha);
        }
      }
    }
  }

  /** Paints an ASCII pixel art grid centered or offset by (ox, oy). '.' or ' ' = transparent. */
  sprite(rows: readonly string[], palette: Readonly<Record<string, string>>, ox = 0, oy = 0): void {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const col = palette[ch];
        if (col) this.px(ox + x, oy + y, col);
      }
    }
  }

  /** Soft pixel aura drawn strictly BEHIND already-painted opaque pixels. */
  underGlow(cx: number, cy: number, radius: number, hex: string, maxAlpha = 0.42): void {
    const [r, g, b] = parseHexRgba(hex);
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const o = (y * ICON_SIZE + x) * 4;
        if (this.data[o + 3] > 20) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d < radius) {
          const k = 1 - d / radius;
          const a = Math.round(k * k * maxAlpha * 255);
          if (a > 12) {
            this.data[o] = r;
            this.data[o + 1] = g;
            this.data[o + 2] = b;
            this.data[o + 3] = a;
          }
        }
      }
    }
  }

  /** Crisp 1px 4-connected dark outline (`#090710`) around all solid foreground pixels. */
  outline(hex = OUTLINE_HEX): void {
    const mask = new Uint8Array(ICON_SIZE * ICON_SIZE);
    for (let i = 0; i < ICON_SIZE * ICON_SIZE; i++) {
      if (this.data[i * 4 + 3] >= 180) mask[i] = 1;
    }
    const [r, g, b, a] = parseHexRgba(hex);
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const idx = y * ICON_SIZE + x;
        if (mask[idx] === 1) continue;
        const hit =
          (x > 0 && mask[idx - 1] === 1) ||
          (x < ICON_SIZE - 1 && mask[idx + 1] === 1) ||
          (y > 0 && mask[idx - ICON_SIZE] === 1) ||
          (y < ICON_SIZE - 1 && mask[idx + ICON_SIZE] === 1);
        if (hit) {
          const o = idx * 4;
          this.data[o] = r;
          this.data[o + 1] = g;
          this.data[o + 2] = b;
          this.data[o + 3] = a;
        }
      }
    }
  }
}

type IconPainterFn = (p: PixelIconPainter) => void;

// Shared Dead Cells-inspired pixel palette swatches
const C = {
  steelDark: '#4a556e',
  steelMid: '#8a99b8',
  steelHi: '#cfdcf2',
  steelSpec: '#ffffff',
  ironDark: '#2a3040',
  ironMid: '#515b75',
  ironHi: '#8b99b5',
  goldDark: '#8c5d18',
  goldMid: '#dfa834',
  goldHi: '#ffe985',
  woodDark: '#52301d',
  woodMid: '#875434',
  woodHi: '#b87d52',
  redDark: '#8a1426',
  redMid: '#e02842',
  redHi: '#ff6378',
  orgDark: '#b83c14',
  orgMid: '#ff7722',
  orgHi: '#ffd257',
  vioDark: '#56238a',
  vioMid: '#9c4dff',
  vioHi: '#d8a6ff',
  cyanDark: '#16759c',
  cyanMid: '#36d6ff',
  cyanHi: '#b5f7ff',
  grnDark: '#196e3c',
  grnMid: '#34d474',
  grnHi: '#a3ffbf',
  boneDark: '#8f8574',
  boneMid: '#d6ccb8',
  boneHi: '#f7f2e6',
  rust: '#9c4e2a',
};

// =============================================================================
// Hand-Crafted 24x24 Pixel-Art Icon Registry (ALL 56 Items, Skills, Mutations, HUD)
// =============================================================================

const ICON_PAINTERS: Record<string, IconPainterFn> = {
  // ---------------------------------------------------------------------------
  // WEAPONS (20)
  // ---------------------------------------------------------------------------

  StartSword: (p) => {
    // Weathered prison iron sword with notched blade, rust spots & leather grip
    p.poly([[19, 3], [20, 4], [10, 14], [8, 12]], C.steelMid);
    p.line(19, 3, 9, 13, C.steelHi, 1);
    p.line(20, 5, 10, 15, C.steelDark, 1);
    p.px(19, 3, C.steelSpec);
    p.px(16, 6, C.steelSpec);
    // Rust patches & blade nick
    p.px(13, 10, C.rust);
    p.px(15, 9, C.rust);
    p.clear(14, 7);
    // Brass crossguard
    p.line(6, 11, 12, 17, C.goldMid, 2);
    p.px(7, 11, C.goldHi);
    p.px(11, 16, C.goldDark);
    // Leather grip & pommel
    p.line(8, 15, 4, 19, C.woodMid, 2);
    p.px(6, 17, C.woodDark);
    p.rect(3, 18, 3, 3, C.goldMid);
    p.px(3, 18, C.goldHi);
    p.outline();
  },

  QuickSword: (p) => {
    // Balanced Blade: sleek crimson-gold rapier-saber with rapid slash sheen
    p.poly([[20, 3], [21, 5], [10, 15], [8, 13]], C.steelHi);
    p.line(20, 3, 10, 13, C.steelSpec, 1);
    p.line(20, 6, 11, 15, C.redMid, 1);
    p.line(18, 9, 12, 15, C.redDark, 1);
    // Speed gleam arcs
    p.line(10, 5, 16, 3, C.orgHi, 1);
    p.px(8, 7, C.redHi);
    // Winged gold guard
    p.line(6, 11, 13, 18, C.goldMid, 2);
    p.px(6, 11, C.goldHi);
    p.px(12, 17, C.goldHi);
    // Crimson hilt & gold pommel
    p.line(8, 15, 4, 19, C.redDark, 2);
    p.px(7, 16, C.redHi);
    p.rect(3, 19, 2, 2, C.goldHi);
    p.outline();
  },

  DualDaggers: (p) => {
    // Twin Daggers: X-crossed gleaming paired blades with crimson wraps
    // Back dagger (top-left -> bottom-right)
    p.line(4, 4, 14, 14, C.steelMid, 2);
    p.line(4, 4, 13, 13, C.steelHi, 1);
    p.px(4, 4, C.steelSpec);
    p.line(12, 16, 16, 12, C.goldMid, 2);
    p.line(15, 15, 19, 19, C.redMid, 2);
    p.px(19, 19, C.goldHi);
    // Front dagger (top-right -> bottom-left)
    p.line(19, 4, 9, 14, C.steelHi, 2);
    p.line(19, 4, 10, 13, C.cyanHi, 1);
    p.px(19, 4, C.steelSpec);
    p.line(7, 12, 11, 16, C.goldHi, 2);
    p.line(8, 15, 4, 19, C.redHi, 2);
    p.px(4, 19, C.goldHi);
    p.outline();
  },

  BackStabber: (p) => {
    // Assassin's Dagger: wicked curved violet-obsidian stiletto dripping crimson
    p.poly([[19, 3], [21, 6], [16, 11], [10, 15], [8, 12], [14, 7]], C.vioMid);
    p.line(19, 3, 14, 7, C.vioHi, 1);
    p.line(14, 7, 9, 12, C.steelSpec, 1);
    p.line(20, 6, 11, 14, C.vioDark, 1);
    p.px(19, 3, C.steelSpec);
    p.px(20, 5, C.redHi);
    // Serrated crimson back-edge glint
    p.px(16, 11, C.redMid);
    p.px(14, 13, C.redMid);
    // Dark angled guard & wrap
    p.line(6, 11, 12, 17, C.ironHi, 2);
    p.px(9, 14, C.redHi);
    p.line(8, 15, 4, 19, C.ironDark, 2);
    p.px(4, 19, C.vioHi);
    p.outline();
    p.underGlow(15, 8, 7, C.vioMid, 0.35);
  },

  Bleeder: (p) => {
    // Blood Sword: jagged crimson-edged blade with falling scarlet droplets
    p.poly([[20, 3], [21, 5], [10, 16], [8, 13]], C.steelMid);
    p.line(20, 3, 9, 14, C.redHi, 1);
    p.line(20, 4, 10, 14, C.redMid, 1);
    p.line(18, 7, 11, 15, C.redDark, 1);
    p.px(20, 3, C.steelSpec);
    p.px(15, 7, C.steelSpec);
    // Blood droplets dripping off blade
    p.rect(17, 11, 2, 3, C.redMid);
    p.px(17, 11, C.redHi);
    p.rect(14, 16, 2, 2, C.redMid);
    p.px(14, 16, C.redHi);
    p.px(19, 15, C.redDark);
    // Crimson horned crossguard & hilt
    p.line(6, 11, 12, 17, C.ironHi, 2);
    p.px(9, 14, C.redHi);
    p.line(7, 15, 4, 19, C.ironDark, 2);
    p.rect(3, 18, 2, 2, C.redMid);
    p.outline();
  },

  BroadSword: (p) => {
    // Massive wide two-handed greatsword with sculpted emerald crossguard & silver fuller
    p.poly([[19, 2], [21, 4], [20, 7], [11, 16], [7, 12], [16, 3]], C.steelMid);
    p.poly([[19, 2], [20, 3], [10, 13], [8, 12]], C.steelHi);
    p.line(18, 5, 10, 13, C.steelDark, 1); // central fuller groove
    p.px(19, 2, C.steelSpec);
    p.px(15, 6, C.steelSpec);
    p.px(12, 9, C.steelSpec);
    // Heavy emerald-gold crossguard
    p.line(5, 10, 13, 18, C.goldMid, 2.5);
    p.px(6, 10, C.goldHi);
    p.px(9, 14, C.grnHi);
    p.px(10, 14, C.grnMid);
    // Two-handed grip & heavy pommel
    p.line(8, 15, 3, 20, C.grnDark, 2);
    p.rect(2, 19, 3, 3, C.goldMid);
    p.px(2, 19, C.goldHi);
    p.outline();
  },

  StunMace: (p) => {
    // Nutcracker: brutal heavy iron warhammer/mace with spikes & golden shock gleam
    // Diagonal wooden shaft
    p.line(4, 20, 14, 10, C.woodMid, 2.5);
    p.line(4, 19, 13, 10, C.woodHi, 1);
    p.rect(3, 19, 2, 2, C.goldMid);
    // Massive octagonal iron hammer head
    p.poly([[10, 6], [14, 3], [20, 9], [17, 13], [13, 13], [10, 10]], C.ironMid);
    p.poly([[11, 6], [14, 4], [18, 8], [15, 10]], C.steelHi);
    p.line(12, 8, 16, 12, C.ironDark, 1);
    // Brass reinforcement band & top spike
    p.line(12, 5, 18, 11, C.goldMid, 1.5);
    p.px(14, 4, C.steelSpec);
    p.px(18, 4, C.goldHi);
    p.px(19, 3, C.steelSpec);
    // Stun spark accents
    p.px(7, 5, C.orgHi);
    p.px(20, 15, C.orgHi);
    p.outline();
  },

  SpeedBlade: (p) => {
    // Swift Sword: sweeping curved cyan-silver scimitar with wind streaks
    p.poly([[20, 3], [21, 5], [19, 9], [14, 14], [9, 15], [8, 13], [13, 11], [17, 6]], C.cyanMid);
    p.line(20, 3, 16, 7, C.steelSpec, 1);
    p.line(16, 7, 10, 13, C.cyanHi, 1);
    p.line(18, 9, 12, 14, C.cyanDark, 1);
    // Motion trails
    p.line(5, 6, 12, 4, C.cyanHi, 1);
    p.line(4, 9, 9, 8, C.cyanMid, 1);
    // Gold curved handguard & grip
    p.line(6, 12, 11, 17, C.goldHi, 2);
    p.line(7, 16, 4, 19, C.woodMid, 2);
    p.px(4, 19, C.goldHi);
    p.outline();
    p.underGlow(15, 9, 7, C.cyanMid, 0.35);
  },

  ImpaleSpear: (p) => {
    // Impaler: long diagonal steel pike with golden barbed spearhead & crimson tassel
    p.line(3, 20, 15, 8, C.woodMid, 2);
    p.line(3, 19, 14, 8, C.woodHi, 1);
    // Crimson silk tassel behind collar
    p.line(12, 11, 14, 16, C.redMid, 2);
    p.px(13, 13, C.redHi);
    p.px(15, 16, C.redDark);
    // Barbed steel spear tip
    p.poly([[21, 2], [19, 8], [15, 9], [15, 5]], C.steelHi);
    p.line(21, 2, 15, 8, C.steelSpec, 1);
    p.line(19, 7, 15, 9, C.steelDark, 1);
    p.rect(13, 8, 3, 3, C.goldMid);
    p.px(13, 8, C.goldHi);
    p.outline();
  },

  Rapier: (p) => {
    // Rapier: ultra-slender silver fencing needle with ornate golden swept basket hilt
    p.line(21, 2, 9, 14, C.steelHi, 1.5);
    p.line(21, 2, 10, 13, C.steelSpec, 1);
    // Golden ornate cup/basket hilt
    p.ellipse(8, 15, 3.2, 3.2, C.goldMid);
    p.ellipse(8, 15, 1.8, 1.8, C.ironDark);
    p.px(7, 13, C.goldHi);
    p.px(10, 14, C.goldHi);
    p.line(5, 12, 11, 18, C.goldHi, 1);
    // Grip & pommel
    p.line(6, 17, 3, 20, C.redDark, 2);
    p.px(3, 20, C.goldHi);
    // Glint star at needle tip
    p.px(21, 2, C.steelSpec);
    p.px(19, 2, C.goldHi);
    p.px(21, 4, C.goldHi);
    p.outline();
  },

  Whip: (p) => {
    // Electric Whip: brass grip coiled into crackling cyan-white lightning arcs
    // Handle
    p.line(4, 19, 8, 15, C.goldMid, 2.5);
    p.px(5, 18, C.goldHi);
    p.px(8, 15, C.ironHi);
    // Whip lash curving in an S-crack
    p.line(8, 15, 11, 9, C.cyanDark, 2);
    p.line(11, 9, 17, 12, C.cyanMid, 2);
    p.line(17, 12, 20, 5, C.cyanHi, 2);
    // Electric bolt core & jagged sparks
    p.line(9, 14, 11, 9, C.cyanHi, 1);
    p.line(11, 9, 17, 12, C.steelSpec, 1);
    p.line(17, 12, 20, 5, C.steelSpec, 1);
    p.px(8, 7, C.cyanHi);
    p.px(14, 6, C.steelSpec);
    p.px(20, 11, C.cyanHi);
    p.px(14, 16, C.cyanMid);
    p.outline();
    p.underGlow(14, 10, 8, C.cyanMid, 0.4);
  },

  CloseCombatBow: (p) => {
    // Infantry Bow: stout oak & crimson warbow with drawn heavy broadhead arrow
    // Bowstring
    p.line(6, 4, 6, 19, C.boneMid, 1);
    // Curved oak limbs
    p.line(6, 4, 13, 6, C.woodMid, 2.5);
    p.line(13, 6, 16, 11, C.woodHi, 2.5);
    p.line(16, 11, 13, 17, C.woodHi, 2.5);
    p.line(13, 17, 6, 19, C.woodMid, 2.5);
    p.rect(14, 10, 3, 3, C.redMid); // crimson grip wrap
    // Heavy broadhead arrow
    p.line(5, 11, 19, 11, C.boneHi, 1.5);
    p.poly([[21, 11], [17, 8], [17, 14]], C.steelHi);
    p.px(20, 11, C.steelSpec);
    p.px(5, 10, C.redHi);
    p.px(5, 12, C.redHi);
    p.outline();
  },

  FastBow: (p) => {
    // Quick Bow: sleek violet-gold recurve bow firing twin luminous energy arrows
    p.line(5, 4, 5, 19, C.vioHi, 1);
    p.line(5, 4, 12, 7, C.vioDark, 2);
    p.line(12, 7, 14, 11, C.vioMid, 2.5);
    p.line(14, 11, 12, 16, C.vioMid, 2.5);
    p.line(12, 16, 5, 19, C.vioDark, 2);
    p.px(13, 11, C.goldHi);
    // Twin rapid arrows
    p.line(6, 9, 20, 9, C.vioHi, 1);
    p.px(20, 9, C.steelSpec);
    p.px(18, 8, C.goldHi);
    p.line(6, 14, 19, 14, C.cyanHi, 1);
    p.px(19, 14, C.steelSpec);
    p.px(17, 15, C.cyanMid);
    p.outline();
    p.underGlow(13, 11, 8, C.vioMid, 0.35);
  },

  FrostBow: (p) => {
    // Ice Bow: sculpted crystalline glacial bow with icicle bolt
    p.line(5, 4, 5, 19, C.cyanHi, 1);
    p.line(5, 4, 12, 6, C.cyanDark, 2.5);
    p.line(12, 6, 15, 11, C.cyanMid, 2.5);
    p.line(15, 11, 12, 17, C.cyanMid, 2.5);
    p.line(12, 17, 5, 19, C.cyanDark, 2.5);
    p.px(12, 6, C.steelSpec);
    p.px(15, 11, C.steelSpec);
    p.px(12, 17, C.cyanHi);
    // Glacial frost icicle arrow
    p.line(5, 11, 18, 11, C.cyanHi, 1.5);
    p.poly([[21, 11], [16, 8], [18, 11], [16, 14]], C.steelSpec);
    p.px(17, 10, C.cyanHi);
    p.px(17, 12, C.cyanMid);
    p.outline();
    p.underGlow(14, 11, 8, C.cyanMid, 0.38);
  },

  ThrowingKnife: (p) => {
    // Fan of 3 razor steel throwing kunai with crimson ring hilts & bloodied tips
    const drawKnife = (x0: number, y0: number, x1: number, y1: number, tipCol: string): void => {
      p.line(x0, y0, x1, y1, C.steelHi, 2);
      p.line(x0, y0, x1, y1, C.steelSpec, 1);
      p.px(x1, y1, tipCol);
      p.ellipse(x0, y0, 1.6, 1.6, C.redMid);
      p.px(x0, y0, C.ironDark);
    };
    drawKnife(5, 19, 13, 5, C.redHi);
    drawKnife(7, 19, 18, 8, C.redHi);
    drawKnife(9, 20, 20, 14, C.redMid);
    p.outline();
  },

  Fireball: (p) => {
    // Pyrotechnics: blazing layered flame orb with incandescent white-gold core & embers
    p.poly([[12, 2], [17, 6], [20, 12], [18, 18], [12, 20], [6, 18], [4, 12], [7, 7]], C.redMid);
    p.poly([[12, 4], [16, 8], [18, 13], [15, 18], [9, 18], [6, 13], [9, 8]], C.orgMid);
    p.ellipse(12, 13, 4.2, 4.6, C.orgHi);
    p.ellipse(12, 14, 2.3, 2.6, C.steelSpec);
    p.px(11, 3, C.orgHi);
    p.px(19, 7, C.orgHi);
    p.px(5, 8, C.redHi);
    p.outline();
    p.underGlow(12, 12, 9, C.orgMid, 0.45);
  },

  StartShield: (p) => {
    // Wooden Shield: sturdy banded oak round buckler with iron boss & wood grain
    p.ellipse(12, 12, 8.2, 8.6, C.ironMid);
    p.ellipse(12, 12, 6.8, 7.2, C.woodMid);
    p.line(9, 5, 9, 19, C.woodDark, 1);
    p.line(15, 5, 15, 19, C.woodDark, 1);
    p.line(12, 5, 12, 19, C.woodHi, 1);
    // Iron boss & rim rivets
    p.ellipse(12, 12, 2.6, 2.6, C.steelMid);
    p.px(11, 11, C.steelSpec);
    p.px(7, 8, C.steelHi);
    p.px(17, 8, C.steelHi);
    p.px(7, 16, C.steelHi);
    p.px(17, 16, C.steelHi);
    p.outline();
  },

  StunShield: (p) => {
    // Cudgel: heavy reinforced iron heater shield emblazoned with golden stun bolt
    p.poly([[5, 4], [19, 4], [19, 13], [12, 20], [5, 13]], C.ironHi);
    p.poly([[7, 6], [17, 6], [17, 12], [12, 18], [7, 12]], C.ironDark);
    p.line(6, 5, 18, 5, C.steelSpec, 1);
    // Golden stun lightning emblem
    p.line(13, 7, 10, 12, C.goldHi, 2);
    p.line(10, 12, 14, 12, C.goldHi, 1.5);
    p.line(14, 12, 11, 16, C.orgHi, 2);
    p.px(12, 8, C.steelSpec);
    p.px(7, 7, C.goldMid);
    p.px(17, 7, C.goldMid);
    p.outline();
  },

  BleedShield: (p) => {
    // Bloodthirsty Shield: jagged spiked crimson-black gothic shield with scarlet crest
    p.poly([[4, 5], [12, 3], [20, 5], [19, 14], [12, 20], [5, 14]], C.redDark);
    p.poly([[6, 6], [18, 6], [17, 13], [12, 18], [7, 13]], C.ironDark);
    // Perimeter steel spikes
    p.px(3, 8, C.steelSpec);
    p.px(20, 8, C.steelSpec);
    p.px(12, 2, C.steelSpec);
    p.px(12, 21, C.steelSpec);
    // Crimson blood droplet/fang centerpiece
    p.poly([[12, 7], [15, 12], [12, 16], [9, 12]], C.redMid);
    p.px(11, 10, C.redHi);
    p.px(11, 9, C.steelSpec);
    p.outline();
  },

  ForceShield: (p) => {
    // Rampart: towering gilded emerald fortress kite shield with cyan energy core
    p.poly([[5, 3], [19, 3], [18, 14], [12, 21], [6, 14]], C.goldMid);
    p.poly([[7, 5], [17, 5], [16, 13], [12, 19], [8, 13]], C.grnDark);
    p.line(6, 4, 18, 4, C.goldHi, 1);
    // Glowing cyan-emerald forcefield diamond
    p.poly([[12, 7], [15, 11], [12, 16], [9, 11]], C.grnMid);
    p.poly([[12, 9], [14, 11], [12, 14], [10, 11]], C.cyanHi);
    p.px(12, 11, C.steelSpec);
    p.outline();
    p.underGlow(12, 11, 8, C.grnMid, 0.35);
  },

  // ---------------------------------------------------------------------------
  // SKILLS (12)
  // ---------------------------------------------------------------------------

  SinewSlicer: (p) => {
    // Spinning toothed silver-crimson sawblade on clockwork iron tripod
    // Tripod base
    p.line(12, 14, 6, 20, C.ironMid, 2);
    p.line(12, 14, 18, 20, C.ironMid, 2);
    p.rect(9, 13, 6, 4, C.ironHi);
    // Circular toothed sawblade
    p.ellipse(12, 10, 6.2, 6.2, C.steelMid);
    p.ellipse(12, 10, 4.5, 4.5, C.steelHi);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.px(12 + Math.cos(a) * 7.2, 10 + Math.sin(a) * 7.2, C.steelSpec);
      p.px(12 + Math.cos(a + 0.25) * 6.4, 10 + Math.sin(a + 0.25) * 6.4, C.redHi);
    }
    p.ellipse(12, 10, 2.2, 2.2, C.redMid);
    p.px(12, 10, C.orgHi);
    p.outline();
  },

  HeavyTurret: (p) => {
    // Fortified brass-and-violet siege cannon on armored legs with glowing muzzle
    // Legs
    p.line(10, 15, 5, 20, C.ironMid, 2.5);
    p.line(14, 15, 19, 20, C.ironMid, 2.5);
    p.rect(7, 13, 10, 4, C.ironDark);
    // Armored turret body + twin barrels
    p.rect(5, 7, 11, 7, C.vioDark);
    p.rect(6, 8, 9, 4, C.goldMid);
    p.line(6, 8, 14, 8, C.goldHi, 1);
    p.rect(15, 7, 5, 3, C.ironHi);
    p.rect(15, 11, 5, 2, C.ironMid);
    // Glowing muzzle & top beacon
    p.rect(19, 7, 2, 3, C.orgHi);
    p.px(20, 8, C.steelSpec);
    p.rect(9, 5, 3, 2, C.vioHi);
    p.outline();
  },

  InfantryGrenade: (p) => {
    // Chunky segmented dark-iron frag grenade with spoon lever & sparking fuse
    p.ellipse(11, 14, 6.2, 6.5, C.ironDark);
    p.ellipse(10, 13, 4.8, 5.0, C.ironMid);
    // Frag grid lines
    p.line(6, 14, 16, 14, C.ironDark, 1);
    p.line(11, 8, 11, 20, C.ironDark, 1);
    p.px(8, 11, C.steelHi);
    p.px(9, 10, C.steelSpec);
    // Collar + pin ring
    p.rect(9, 6, 4, 3, C.goldMid);
    p.line(13, 7, 16, 9, C.ironHi, 1.5);
    // Sparking orange-white fuse
    p.line(11, 6, 15, 3, C.woodHi, 1);
    p.ellipse(17, 4, 2.2, 2.2, C.orgMid);
    p.px(17, 4, C.steelSpec);
    p.px(19, 2, C.orgHi);
    p.outline();
  },

  FireGrenade: (p) => {
    // Glass incendiary bomb brimming with liquid fire & blazing flame neck
    p.ellipse(12, 15, 6.0, 5.8, C.redDark);
    p.ellipse(12, 15, 4.8, 4.6, C.orgMid);
    p.ellipse(12, 16, 3.2, 3.0, C.orgHi);
    p.px(9, 13, C.steelSpec);
    // Glass bottle neck
    p.rect(10, 8, 4, 3, C.steelHi);
    // Roaring flame plume above cork
    p.poly([[12, 2], [16, 6], [14, 9], [10, 9], [8, 6]], C.redMid);
    p.poly([[12, 3], [14, 6], [12, 8], [10, 6]], C.orgHi);
    p.px(12, 6, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 9, C.orgMid, 0.42);
  },

  IceGrenade: (p) => {
    // Faceted hexagonal glacial-cyan frost bomb with sharp ice crystal spikes
    p.poly([[12, 4], [18, 8], [18, 16], [12, 20], [6, 16], [6, 8]], C.cyanDark);
    p.poly([[12, 5], [16, 9], [16, 15], [12, 18], [8, 15], [8, 9]], C.cyanMid);
    p.poly([[12, 7], [14, 11], [12, 15], [10, 11]], C.cyanHi);
    // Protruding frost crystal spikes
    p.line(12, 2, 12, 5, C.steelSpec, 1.5);
    p.line(18, 6, 20, 4, C.cyanHi, 1.5);
    p.line(6, 6, 4, 4, C.cyanHi, 1.5);
    p.line(18, 17, 20, 19, C.cyanHi, 1.5);
    p.line(6, 17, 4, 19, C.cyanHi, 1.5);
    p.px(11, 9, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 9, C.cyanMid, 0.42);
  },

  ClusterGrenade: (p) => {
    // Triple-bundled crimson-iron cluster bombs with blazing multi-fuse
    const bomb = (cx: number, cy: number): void => {
      p.ellipse(cx, cy, 4.2, 4.2, C.ironDark);
      p.ellipse(cx - 0.5, cy - 0.5, 2.8, 2.8, C.redDark);
      p.px(cx - 1.5, cy - 1.5, C.redHi);
    };
    bomb(8, 16);
    bomb(16, 16);
    bomb(12, 11);
    // Gold binding strap + top fuses
    p.rect(10, 6, 4, 2, C.goldMid);
    p.line(12, 6, 12, 3, C.orgMid, 1.5);
    p.px(12, 2, C.steelSpec);
    p.px(9, 4, C.orgHi);
    p.px(15, 4, C.orgHi);
    p.outline();
  },

  Phaser: (p) => {
    // Hooded cyan-violet phantom blink figure with electric warp streaks
    // Afterimage trail lines on left
    p.line(3, 8, 9, 8, C.vioMid, 1.5);
    p.line(2, 12, 9, 12, C.cyanMid, 1.5);
    p.line(4, 16, 10, 16, C.vioHi, 1.5);
    // Forward blinking phantom cloak silhouette
    p.poly([[14, 4], [18, 7], [17, 13], [20, 19], [11, 19], [12, 12], [10, 8]], C.vioDark);
    p.poly([[14, 5], [17, 8], [16, 14], [18, 18], [13, 17], [13, 9]], C.cyanMid);
    // Glowing cyan blink eye & lightning spark
    p.rect(14, 8, 3, 2, C.steelSpec);
    p.line(19, 4, 21, 9, C.cyanHi, 1);
    p.outline();
    p.underGlow(13, 12, 9, C.cyanMid, 0.42);
  },

  WolfTrap: (p) => {
    // Open toothed steel bear trap with glowing crimson trigger plate
    // Hinged base bar & coil spring
    p.rect(4, 16, 16, 3, C.ironMid);
    p.rect(5, 16, 14, 1, C.steelHi);
    // Left & right curved jagged steel jaws
    p.line(5, 16, 4, 9, C.steelMid, 2);
    p.line(4, 9, 8, 6, C.steelHi, 2);
    p.line(19, 16, 20, 9, C.steelMid, 2);
    p.line(20, 9, 16, 6, C.steelHi, 2);
    // Sharp metallic jaw teeth
    p.px(6, 10, C.steelSpec);
    p.px(8, 8, C.steelSpec);
    p.px(10, 7, C.steelSpec);
    p.px(18, 10, C.steelSpec);
    p.px(16, 8, C.steelSpec);
    p.px(14, 7, C.steelSpec);
    // Crimson pressure plate in center
    p.ellipse(12, 15, 3.2, 1.8, C.redMid);
    p.px(12, 14, C.redHi);
    p.outline();
  },

  WaveOfDenial: (p) => {
    // Concentric expanding cyan-violet kinetic shockwave rings from bright blast core
    p.ring(12, 12, 9.2, 7.6, C.vioMid);
    p.ring(12, 12, 6.4, 4.6, C.cyanMid);
    p.ellipse(12, 12, 3.2, 3.2, C.cyanHi);
    p.ellipse(12, 12, 1.6, 1.6, C.steelSpec);
    // Directional wind flare rays
    p.line(12, 2, 12, 5, C.steelSpec, 1);
    p.line(12, 19, 12, 22, C.steelSpec, 1);
    p.line(2, 12, 5, 12, C.steelSpec, 1);
    p.line(19, 12, 22, 12, C.steelSpec, 1);
    p.outline();
    p.underGlow(12, 12, 10, C.cyanMid, 0.4);
  },

  CorruptedPower: (p) => {
    // Volatile dark-crimson & electric-violet surge orb crackling with jagged lightning
    p.ellipse(12, 12, 6.2, 6.2, C.redDark);
    p.ellipse(12, 12, 4.4, 4.4, C.redMid);
    p.ellipse(12, 12, 2.2, 2.2, C.vioHi);
    p.px(12, 12, C.steelSpec);
    // Crackling jagged corruption arcs
    p.line(12, 2, 10, 6, C.vioHi, 1.5);
    p.line(12, 21, 14, 17, C.vioHi, 1.5);
    p.line(3, 9, 7, 11, C.redHi, 1.5);
    p.line(21, 14, 17, 12, C.redHi, 1.5);
    p.line(5, 19, 8, 15, C.orgHi, 1);
    p.line(19, 5, 16, 8, C.orgHi, 1);
    p.outline();
    p.underGlow(12, 12, 10, C.redMid, 0.45);
  },

  KnifeDance: (p) => {
    // Radial storm of 6 spinning silver-crimson daggers circling an energy ring
    p.ring(12, 12, 5.2, 3.8, C.redMid);
    p.ellipse(12, 12, 2.0, 2.0, C.vioHi);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - 0.35;
      const sx = 12 + Math.cos(a) * 4.0;
      const sy = 12 + Math.sin(a) * 4.0;
      const ex = 12 + Math.cos(a) * 9.5;
      const ey = 12 + Math.sin(a) * 9.5;
      p.line(sx, sy, ex, ey, C.steelHi, 1.8);
      p.px(ex, ey, C.steelSpec);
      p.px(sx, sy, C.redHi);
    }
    p.outline();
    p.underGlow(12, 12, 9, C.redMid, 0.35);
  },

  Tonic: (p) => {
    // Ornate emerald-gold alchemical healing elixir bottle with glowing vitality core
    // Cork & brass collar
    p.rect(10, 3, 4, 3, C.woodHi);
    p.rect(9, 6, 6, 2, C.goldHi);
    p.rect(10, 8, 4, 2, C.cyanHi);
    // Faceted glass body brimming with emerald elixir
    p.poly([[9, 10], [15, 10], [18, 14], [17, 19], [7, 19], [6, 14]], C.grnDark);
    p.poly([[9, 11], [15, 11], [16, 15], [15, 18], [9, 18], [8, 15]], C.grnMid);
    // Glowing health cross inside vial
    p.rect(11, 12, 2, 5, C.grnHi);
    p.rect(9, 14, 6, 2, C.grnHi);
    p.px(11, 14, C.steelSpec);
    p.px(8, 13, C.steelSpec); // glass specular glint
    p.outline();
    p.underGlow(12, 14, 9, C.grnMid, 0.42);
  },

  // ---------------------------------------------------------------------------
  // MUTATIONS (15)
  // ---------------------------------------------------------------------------

  Combo: (p) => {
    // Brutality crossed twin flaming blades with bright combo flare
    p.line(5, 18, 18, 5, C.redMid, 2.5);
    p.line(6, 17, 18, 5, C.steelSpec, 1);
    p.line(18, 18, 5, 5, C.redMid, 2.5);
    p.line(17, 17, 5, 5, C.steelSpec, 1);
    // Glowing orange-gold burst at crossing
    p.ellipse(12, 12, 3.2, 3.2, C.orgMid);
    p.px(12, 12, C.steelSpec);
    p.px(12, 7, C.orgHi);
    p.px(12, 17, C.orgHi);
    p.outline();
    p.underGlow(12, 12, 9, C.redMid, 0.4);
  },

  OpenWounds: (p) => {
    // Brutality triple crimson claw slash dripping scarlet blood drops
    p.line(4, 15, 13, 4, C.redHi, 2);
    p.line(8, 18, 18, 5, C.redMid, 2.5);
    p.line(13, 19, 20, 10, C.redHi, 2);
    p.line(9, 16, 17, 6, C.steelSpec, 1);
    // Falling blood droplets
    p.rect(6, 18, 2, 3, C.redMid);
    p.px(6, 18, C.redHi);
    p.rect(16, 17, 2, 3, C.redMid);
    p.px(16, 17, C.redHi);
    p.outline();
    p.underGlow(12, 12, 9, C.redMid, 0.35);
  },

  Melee: (p) => {
    // Brutality armored crimson-steel gauntlet radiating frost-chill shockwaves
    p.rect(8, 12, 8, 7, C.redDark);
    p.rect(7, 8, 10, 6, C.redMid);
    p.rect(8, 7, 2, 3, C.redHi);
    p.rect(11, 6, 2, 4, C.redHi);
    p.rect(14, 7, 2, 3, C.redHi);
    p.rect(8, 17, 8, 2, C.goldMid);
    // Frost-slow arcs around fist
    p.line(4, 7, 6, 12, C.cyanHi, 1.5);
    p.line(20, 7, 18, 12, C.cyanHi, 1.5);
    p.px(12, 4, C.cyanHi);
    p.px(9, 8, C.steelSpec);
    p.outline();
  },

  Predator: (p) => {
    // Brutality shadowy hooded phantom eye fading into crimson stealth smoke
    p.poly([[12, 4], [19, 11], [17, 19], [7, 19], [5, 11]], C.ironDark);
    p.poly([[12, 6], [17, 11], [15, 17], [9, 17], [7, 11]], C.redDark);
    // Slit predator glowing crimson eyes
    p.line(8, 12, 11, 13, C.redHi, 1.5);
    p.line(16, 12, 13, 13, C.redHi, 1.5);
    p.px(9, 12, C.steelSpec);
    p.px(15, 12, C.steelSpec);
    // Fading mist wisps
    p.px(5, 17, C.redMid);
    p.px(19, 17, C.redMid);
    p.px(12, 20, C.redDark);
    p.outline();
  },

  Vengeance: (p) => {
    // Brutality blazing wrathful iron helmet engulfed in fiery crimson rage
    // Flames behind helm
    p.poly([[12, 2], [19, 8], [20, 15], [12, 18], [4, 15], [5, 8]], C.redMid);
    p.poly([[12, 4], [17, 9], [16, 15], [8, 15], [7, 9]], C.orgMid);
    // Dark horned helm center
    p.poly([[8, 9], [16, 9], [15, 19], [12, 21], [9, 19]], C.ironDark);
    p.rect(9, 10, 6, 3, C.ironMid);
    // Blazing white-orange wrath visor
    p.rect(9, 13, 6, 2, C.orgHi);
    p.px(10, 13, C.steelSpec);
    p.px(14, 13, C.steelSpec);
    p.outline();
  },

  Support: (p) => {
    // Tactics violet clockwork gear emitting bright upward empowerment chevrons
    p.ellipse(12, 14, 5.5, 5.5, C.vioDark);
    p.ellipse(12, 14, 4.0, 4.0, C.vioMid);
    p.ellipse(12, 14, 1.6, 1.6, C.ironDark);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.px(12 + Math.cos(a) * 6.2, 14 + Math.sin(a) * 6.2, C.vioHi);
    }
    // Upward buff chevrons
    p.line(8, 7, 12, 3, C.cyanHi, 2);
    p.line(12, 3, 16, 7, C.cyanHi, 2);
    p.px(12, 3, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 9, C.vioMid, 0.35);
  },

  PointBlank: (p) => {
    // Tactics glowing violet-gold bullseye crosshair pierced by close-range bolt
    p.ring(12, 12, 8.2, 6.6, C.vioMid);
    p.ring(12, 12, 4.8, 3.4, C.vioHi);
    p.line(12, 2, 12, 6, C.goldHi, 1.5);
    p.line(12, 18, 12, 22, C.goldHi, 1.5);
    p.line(2, 12, 6, 12, C.goldHi, 1.5);
    p.line(18, 12, 22, 12, C.goldHi, 1.5);
    // Close-range impact star at center
    p.ellipse(12, 12, 2.2, 2.2, C.orgHi);
    p.px(12, 12, C.steelSpec);
    p.outline();
  },

  BarbedTips: (p) => {
    // Tactics jagged barbed violet-steel arrowhead dripping glowing venom
    p.line(4, 20, 12, 12, C.woodMid, 2);
    p.poly([[20, 3], [17, 13], [13, 11], [11, 7]], C.vioMid);
    p.line(20, 3, 12, 11, C.steelSpec, 1);
    // Razor barbs
    p.line(15, 11, 13, 15, C.vioHi, 1.5);
    p.line(13, 9, 9, 11, C.vioHi, 1.5);
    // Toxic green-violet droplets
    p.rect(17, 15, 2, 3, C.grnHi);
    p.rect(13, 18, 2, 2, C.vioHi);
    p.outline();
  },

  Tranquility: (p) => {
    // Tactics serene violet-cyan mystic lotus eye framed by calm aura ring
    p.ring(12, 12, 8.8, 7.6, C.vioMid);
    // Lotus petals
    p.poly([[12, 5], [15, 10], [12, 13], [9, 10]], C.vioHi);
    p.poly([[5, 12], [10, 10], [12, 14], [7, 16]], C.vioMid);
    p.poly([[19, 12], [14, 10], [12, 14], [17, 16]], C.vioMid);
    // Serene luminous cyan core
    p.ellipse(12, 12, 3.0, 2.2, C.cyanMid);
    p.px(12, 12, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 9, C.vioMid, 0.35);
  },

  Necromancy: (p) => {
    // Survival luminous emerald-crowned gothic skull with rising soul wisps
    p.ellipse(12, 10, 6.2, 5.5, C.boneMid);
    p.ellipse(11, 9, 4.5, 3.6, C.boneHi);
    p.rect(8, 14, 8, 5, C.boneMid);
    // Teeth notches
    p.px(10, 17, C.ironDark);
    p.px(12, 17, C.ironDark);
    p.px(14, 17, C.ironDark);
    // Glowing emerald necromantic eyes
    p.rect(8, 10, 3, 2, C.grnHi);
    p.rect(13, 10, 3, 2, C.grnHi);
    p.px(9, 10, C.steelSpec);
    p.px(14, 10, C.steelSpec);
    // Emerald soul flame wisps rising off cranium
    p.line(7, 5, 5, 2, C.grnMid, 1.5);
    p.line(12, 4, 12, 2, C.grnHi, 1.5);
    p.line(17, 5, 19, 2, C.grnMid, 1.5);
    p.outline();
    p.underGlow(12, 10, 9, C.grnMid, 0.4);
  },

  Gastronomy: (p) => {
    // Survival succulent roasted drumstick haunch on bone with emerald sparkle
    // Protruding bone end
    p.line(4, 19, 10, 13, C.boneHi, 2.5);
    p.ellipse(4, 18, 1.8, 1.8, C.boneHi);
    p.ellipse(6, 20, 1.8, 1.8, C.boneMid);
    // Glazed meat haunch
    p.ellipse(14, 10, 6.2, 5.4, C.orgDark);
    p.ellipse(13, 9, 4.8, 4.0, C.woodHi);
    p.ellipse(12, 8, 2.4, 1.8, C.orgHi);
    p.px(11, 7, C.steelSpec);
    // Emerald healing sparkle
    p.px(19, 5, C.grnHi);
    p.px(18, 4, C.grnMid);
    p.px(20, 4, C.grnMid);
    p.outline();
  },

  WhatDoesntKillMe: (p) => {
    // Survival emerald-trimmed iron shield housing a radiant green healing heart
    p.poly([[5, 4], [19, 4], [18, 14], [12, 20], [6, 14]], C.grnMid);
    p.poly([[7, 6], [17, 6], [16, 13], [12, 18], [8, 13]], C.ironDark);
    // Luminous green healing heart inside shield
    p.ellipse(10, 10, 2.1, 2.1, C.grnHi);
    p.ellipse(14, 10, 2.1, 2.1, C.grnHi);
    p.poly([[8, 11], [16, 11], [12, 16]], C.grnMid);
    p.px(10, 9, C.steelSpec);
    p.outline();
  },

  Armadillopack: (p) => {
    // Survival curled armored emerald-steel rolling carapace with golden parry sparks
    p.ellipse(12, 13, 7.6, 7.0, C.grnDark);
    p.ellipse(12, 13, 6.0, 5.4, C.grnMid);
    // Segmented shell armor plates
    p.line(7, 10, 17, 10, C.ironDark, 1);
    p.line(6, 14, 18, 14, C.ironDark, 1);
    p.ellipse(11, 13, 2.8, 2.4, C.steelHi);
    // Motion & parry sparks
    p.line(4, 6, 8, 4, C.goldHi, 1.5);
    p.line(16, 4, 20, 6, C.goldHi, 1.5);
    p.px(18, 4, C.steelSpec);
    p.px(9, 11, C.steelSpec);
    p.outline();
  },

  Disengagement: (p) => {
    // Colorless shimmering cyan-gold hexagonal emergency barrier protecting a crimson heart
    p.poly([[12, 2], [20, 7], [20, 17], [12, 22], [4, 17], [4, 7]], C.cyanMid);
    p.poly([[12, 4], [18, 8], [18, 16], [12, 20], [6, 16], [6, 8]], C.ironDark);
    p.line(12, 3, 19, 7, C.steelSpec, 1);
    // Protected glowing heart inside barrier
    p.ellipse(10, 11, 2.1, 2.1, C.redHi);
    p.ellipse(14, 11, 2.1, 2.1, C.redHi);
    p.poly([[8, 12], [16, 12], [12, 17]], C.redMid);
    p.px(10, 10, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.cyanHi, 0.42);
  },

  InstinctOfTheMaster: (p) => {
    // Colorless golden-cyan hourglass pierced by a radiant crit flash star
    // Top & bottom golden frames
    p.rect(6, 3, 12, 2, C.goldHi);
    p.rect(6, 19, 12, 2, C.goldHi);
    // Glass cones
    p.poly([[7, 5], [17, 5], [12, 12]], C.cyanDark);
    p.poly([[12, 12], [17, 19], [7, 19]], C.cyanDark);
    // Glowing golden sand
    p.poly([[9, 6], [15, 6], [12, 10]], C.goldMid);
    p.poly([[12, 14], [16, 18], [8, 18]], C.goldHi);
    // Brilliant white-cyan crit star across waist
    p.line(4, 12, 20, 12, C.cyanHi, 1.5);
    p.line(12, 8, 12, 16, C.steelSpec, 1);
    p.px(12, 12, C.steelSpec);
    p.outline();
  },

  // ---------------------------------------------------------------------------
  // CORE HUD ICONS (9)
  // ---------------------------------------------------------------------------

  HealthFlask: (p) => {
    // Iconic Dead Cells tall glass alchemical flask with cork, iron collar & emerald-teal glow
    p.rect(10, 2, 4, 3, C.woodHi);
    p.rect(9, 5, 6, 2, C.goldMid);
    p.rect(10, 7, 4, 3, C.steelHi);
    // Rounded glass body
    p.poly([[9, 10], [15, 10], [18, 14], [18, 18], [15, 21], [9, 21], [6, 18], [6, 14]], C.cyanDark);
    p.poly([[9, 12], [15, 12], [17, 15], [16, 19], [8, 19], [7, 15]], C.grnMid);
    p.rect(9, 13, 6, 2, C.grnHi);
    // Specular glass highlight & bubbles
    p.line(8, 13, 8, 17, C.steelSpec, 1);
    p.px(13, 15, C.steelSpec);
    p.px(11, 17, C.cyanHi);
    p.outline();
    p.underGlow(12, 15, 9, C.grnMid, 0.4);
  },

  Cell: (p) => {
    // Luminous Dead Cells cyan-aqua floating soul cell orb with electric white core
    p.ellipse(12, 12, 7.0, 7.6, C.cyanDark);
    p.ellipse(12, 12, 5.4, 5.8, C.cyanMid);
    p.ellipse(11.5, 11.5, 3.4, 3.6, C.cyanHi);
    p.ellipse(11, 10.5, 1.8, 1.8, C.steelSpec);
    // Wispy upper plasma tail
    p.poly([[10, 5], [12, 2], [14, 5]], C.cyanHi);
    p.px(12, 3, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.cyanMid, 0.5);
  },

  Gold: (p) => {
    // Gleaming embossed gold coin stack with specular sheen
    p.ellipse(12, 12, 7.4, 7.8, C.goldDark);
    p.ellipse(12, 12, 6.2, 6.6, C.goldMid);
    p.ellipse(11.5, 11.5, 4.6, 5.0, C.goldHi);
    // Inner stamped diamond emblem
    p.poly([[12, 8], [14, 12], [12, 16], [10, 12]], C.goldDark);
    p.px(12, 12, C.orgHi);
    // Crisp specular glint
    p.px(8, 8, C.steelSpec);
    p.px(9, 7, C.steelSpec);
    p.outline();
  },

  ScrollBrutality: (p) => {
    // Brutality crimson power scroll with gilded end-caps & scarlet blade sigil
    p.rect(5, 3, 14, 3, C.goldMid);
    p.rect(5, 18, 14, 3, C.goldMid);
    p.line(6, 3, 18, 3, C.goldHi, 1);
    p.rect(6, 6, 12, 12, C.redDark);
    p.rect(7, 7, 10, 10, C.redMid);
    // Glowing Brutality crimson sword/flame sigil
    p.line(12, 8, 12, 15, C.orgHi, 2);
    p.line(10, 13, 14, 13, C.goldHi, 1);
    p.px(12, 9, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.redMid, 0.42);
  },

  ScrollTactics: (p) => {
    // Tactics violet power scroll with silver end-caps & luminous purple eye/arrow sigil
    p.rect(5, 3, 14, 3, C.steelMid);
    p.rect(5, 18, 14, 3, C.steelMid);
    p.line(6, 3, 18, 3, C.steelSpec, 1);
    p.rect(6, 6, 12, 12, C.vioDark);
    p.rect(7, 7, 10, 10, C.vioMid);
    // Glowing Tactics diamond/eye sigil
    p.poly([[12, 8], [16, 12], [12, 16], [8, 12]], C.vioHi);
    p.px(12, 12, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.vioMid, 0.42);
  },

  ScrollSurvival: (p) => {
    // Survival emerald power scroll with brass end-caps & vibrant green shield sigil
    p.rect(5, 3, 14, 3, C.goldMid);
    p.rect(5, 18, 14, 3, C.goldMid);
    p.line(6, 3, 18, 3, C.goldHi, 1);
    p.rect(6, 6, 12, 12, C.grnDark);
    p.rect(7, 7, 10, 10, C.grnMid);
    // Glowing Survival shield sigil
    p.poly([[9, 9], [15, 9], [15, 13], [12, 16], [9, 13]], C.grnHi);
    p.px(12, 11, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.grnMid, 0.42);
  },

  ScrollAny: (p) => {
    // Radiant tri-color Power Scroll with crimson, violet & emerald energy bands
    p.rect(5, 3, 14, 3, C.goldHi);
    p.rect(5, 18, 14, 3, C.goldHi);
    p.rect(6, 6, 4, 12, C.redMid);
    p.rect(10, 6, 4, 12, C.vioMid);
    p.rect(14, 6, 4, 12, C.grnMid);
    // Luminous golden star sigil in center
    p.line(12, 8, 12, 16, C.steelSpec, 1.5);
    p.line(8, 12, 16, 12, C.goldHi, 1.5);
    p.px(12, 12, C.steelSpec);
    p.outline();
    p.underGlow(12, 12, 10, C.goldHi, 0.45);
  },

  Skull: (p) => {
    // Menacing Cursed Skull with blazing crimson eye sockets & violet curse aura
    p.ellipse(12, 10, 6.8, 6.0, C.boneMid);
    p.ellipse(11, 8.5, 4.8, 3.8, C.boneHi);
    p.rect(8, 14, 8, 5, C.boneMid);
    // Nose & teeth
    p.px(12, 14, C.ironDark);
    p.px(10, 17, C.ironDark);
    p.px(12, 17, C.ironDark);
    p.px(14, 17, C.ironDark);
    // Blazing cursed crimson eyes
    p.rect(7, 10, 4, 3, C.ironDark);
    p.rect(13, 10, 4, 3, C.ironDark);
    p.rect(8, 11, 2, 1, C.redHi);
    p.rect(14, 11, 2, 1, C.redHi);
    p.px(9, 11, C.steelSpec);
    p.px(15, 11, C.steelSpec);
    p.outline();
    p.underGlow(12, 11, 10, C.vioMid, 0.42);
  },

  BossCell: (p) => {
    // Boss Stem Cell: intense crimson-magenta core sphere wrapped in dark gold/violet tendrils
    p.ellipse(12, 12, 7.6, 7.6, C.vioDark);
    p.ellipse(12, 12, 6.2, 6.2, C.redDark);
    p.ellipse(12, 12, 4.6, 4.6, C.redMid);
    p.ellipse(11.5, 11.5, 2.8, 2.8, C.redHi);
    p.px(11, 10, C.steelSpec);
    // Dark-gold orbital stem tendrils
    p.line(5, 8, 19, 16, C.goldHi, 1.5);
    p.line(19, 8, 5, 16, C.vioHi, 1.2);
    p.px(12, 4, C.goldHi);
    p.px(12, 20, C.goldHi);
    p.outline();
    p.underGlow(12, 12, 10, C.redMid, 0.5);
  },
};

export const BUILTIN_ICON_IDS: readonly string[] = Object.keys(ICON_PAINTERS);

function paintFallbackIcon(p: PixelIconPainter, itemId: string): void {
  // Deterministic gem emblem if an unrecognized ID is ever requested
  let h = 2166136261;
  for (let i = 0; i < itemId.length; i++) {
    h ^= itemId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const palettes: ReadonlyArray<readonly [string, string, string]> = [
    [C.redDark, C.redMid, C.redHi],
    [C.vioDark, C.vioMid, C.vioHi],
    [C.grnDark, C.grnMid, C.grnHi],
    [C.cyanDark, C.cyanMid, C.cyanHi],
    [C.goldDark, C.goldMid, C.goldHi],
  ];
  const [dark, mid, hi] = palettes[(h >>> 0) % palettes.length];
  p.poly([[12, 3], [19, 12], [12, 21], [5, 12]], dark);
  p.poly([[12, 5], [17, 12], [12, 19], [7, 12]], mid);
  p.poly([[12, 7], [14, 11], [12, 14], [10, 11]], hi);
  p.px(11, 9, C.steelSpec);
  p.outline();
}

function ensureScratchCanvases(): boolean {
  if (typeof document === 'undefined') return false;
  if (!scratchSmallCanvas) {
    scratchSmallCanvas = document.createElement('canvas');
    scratchSmallCanvas.width = ICON_SIZE;
    scratchSmallCanvas.height = ICON_SIZE;
    scratchSmallCtx = scratchSmallCanvas.getContext('2d');
  }
  if (!scratchBigCanvas) {
    scratchBigCanvas = document.createElement('canvas');
    scratchBigCanvas.width = UPSCALE_SIZE;
    scratchBigCanvas.height = UPSCALE_SIZE;
    scratchBigCtx = scratchBigCanvas.getContext('2d');
  }
  return Boolean(scratchSmallCtx && scratchBigCtx);
}

function normalizeIconId(itemId: string): string {
  if (ICON_PAINTERS[itemId]) return itemId;
  const stripped = itemId.replace(/^(?:weapon|skill|mut)[:_]/, '');
  if (ICON_PAINTERS[stripped]) return stripped;
  return itemId;
}

/**
 * Returns a crisp pixel-art PNG data URL (nearest-neighbor upscaled 2x from 24x24
 * to 48x48, lazily cached in memory) for any weapon, skill, mutation, or HUD icon ID
 * (`HealthFlask`, `Cell`, `Gold`, `ScrollBrutality`, `ScrollTactics`, `ScrollSurvival`,
 * `ScrollAny`, `Skull`, `BossCell`). Safe no-op (`null`) in headless Node/Vitest.
 */
export function getBuiltinItemIconUrl(itemId: string): string | null {
  if (typeof document === 'undefined') return null;
  const key = normalizeIconId(itemId);
  const cached = builtinCache.get(key);
  if (cached) return cached;

  if (!ensureScratchCanvases() || !scratchSmallCtx || !scratchBigCtx || !scratchSmallCanvas || !scratchBigCanvas) {
    return null;
  }

  const painter = new PixelIconPainter();
  const fn = ICON_PAINTERS[key];
  if (fn) {
    fn(painter);
  } else {
    paintFallbackIcon(painter, key);
  }

  const imgData = scratchSmallCtx.createImageData(ICON_SIZE, ICON_SIZE);
  imgData.data.set(painter.data);
  scratchSmallCtx.putImageData(imgData, 0, 0);

  scratchBigCtx.imageSmoothingEnabled = false;
  scratchBigCtx.clearRect(0, 0, UPSCALE_SIZE, UPSCALE_SIZE);
  scratchBigCtx.drawImage(
    scratchSmallCanvas,
    0,
    0,
    ICON_SIZE,
    ICON_SIZE,
    0,
    0,
    UPSCALE_SIZE,
    UPSCALE_SIZE
  );

  const url = scratchBigCanvas.toDataURL('image/png');
  builtinCache.set(key, url);
  if (key !== itemId) builtinCache.set(itemId, url);
  return url;
}

/**
 * Unified art-mode-aware icon resolver:
 * - In `custom` mode, returns the real extracted `cardIcons.png` icon when loaded.
 * - Falls back cleanly to Built-In Krunked pixel-art icons in `builtin` mode or before load.
 */
export function getItemIconUrl(
  itemId: string,
  artPackMode: ArtPackMode,
  customPack?: CustomPackAssetResolver | null
): string | null {
  if (artPackMode === 'custom' && customPack?.getCardIconDataUrl) {
    const customUrl = customPack.getCardIconDataUrl(itemId);
    if (customUrl) return customUrl;
  }
  return getBuiltinItemIconUrl(itemId);
}
