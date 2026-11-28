// =============================================================================
// KRUNKED CELLS — PROCEDURAL PIXEL-ART ATLAS (ALBEDO + SOBEL NORMAL + EMISSIVE)
// Generates three pixel-aligned 2048x2048 RGBA textures at startup with
// sculpted heightfields -> tangent-space normal maps (Y-down world space) and
// crisp emissive glow masks. Zero DOM dependencies required for getAtlasKeys().
// =============================================================================

import {
  BUILTIN_BAKED_SPRITES,
  BUILTIN_HERO_HEAD_ANCHORS_DATA,
  BUILTIN_TITLE_BACKDROP,
  type BakedPixelSprite,
} from './builtinArtData';

export interface SpriteRegion {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  pivotX: number;
  pivotY: number;
}

export interface ProceduralAtlasData {
  width: number;
  height: number;
  albedoPixels: Uint8Array;
  normalPixels: Uint8Array;
  emissivePixels: Uint8Array;
  albedoCanvas: HTMLCanvasElement | null;
  normalCanvas: HTMLCanvasElement | null;
  emissiveCanvas: HTMLCanvasElement | null;
  regions: Record<string, SpriteRegion>;
  keys: string[];
}

export const TILESET_THEMES = [
  'prison',
  'promenade',
  'sewer',
  'ramparts',
  'bridge',
  'stilt',
  'clock',
  'castle',
  'throne',
  'passage',
] as const;

export type TilesetTheme = (typeof TILESET_THEMES)[number];

export const ENEMY_ARCHETYPE_IDS = [
  'Zombie',
  'Archer',
  'Grenader',
  'Shield',
  'Mage360',
  'Runner',
  'BatKamikaze',
  'BatDasher',
  'Worm',
  'Protector',
  'Scorpio',
  'Comboter',
  'Ninja',
  'LeapingDuelyst',
  'ClusterGrenader',
  'PirateChief',
  'CastleKnight',
  'Lancer',
] as const;

export const BOSS_ARCHETYPE_IDS = ['Behemoth', 'TimeKeeper', 'KingsHand'] as const;

export const WEAPON_ICON_IDS = [
  'StartSword',
  'QuickSword',
  'DualDaggers',
  'BackStabber',
  'Bleeder',
  'BroadSword',
  'StunMace',
  'SpeedBlade',
  'ImpaleSpear',
  'Rapier',
  'Whip',
  'CloseCombatBow',
  'FastBow',
  'FrostBow',
  'ThrowingKnife',
  'Fireball',
  'StartShield',
  'StunShield',
  'BleedShield',
  'ForceShield',
] as const;

export const SKILL_ICON_IDS = [
  'SinewSlicer',
  'HeavyTurret',
  'InfantryGrenade',
  'FireGrenade',
  'IceGrenade',
  'ClusterGrenade',
  'Phaser',
  'WolfTrap',
  'WaveOfDenial',
  'CorruptedPower',
  'KnifeDance',
  'Tonic',
] as const;

const ATLAS_W = 2048;
const ATLAS_H = 2048;
const PAD = 2;

/**
 * Neck-socket attachment offsets [ox, oy] (in facing-right sprite pixels relative
 * to bottom-center feet pivot [w * 0.5, h]) for mounting live animated
 * `hero:head_flame_0..3` cleanly onto every headless Built-In hero pose!
 */
export const BUILTIN_HERO_HEAD_ANCHORS: Readonly<Record<string, readonly [number, number]>> = {
  'hero:idle_0': [1, -30],
  'hero:idle_1': [1, -29],
  'hero:idle_2': [1, -29],
  'hero:idle_3': [1, -30],
  'hero:run_0': [4, -29],
  'hero:run_1': [4, -28],
  'hero:run_2': [5, -30],
  'hero:run_3': [4, -29],
  'hero:run_4': [4, -28],
  'hero:run_5': [5, -30],
  'hero:attack_0': [4, -28],
  'hero:attack_1': [3, -29],
  'hero:attack_2': [3, -30],
  'hero:jump': [2, -31],
  'hero:fall': [1, -30],
  'hero:wall_slide': [2, -29],
  'hero:roll_0': [4, -18],
  'hero:roll_1': [0, -14],
  'hero:roll_2': [-3, -15],
  'hero:roll_3': [2, -17],
  'hero:dive_slam': [1, -24],
  'hero:parry': [2, -29],
  'hero:heal': [1, -30],
  'hero:hurt': [-2, -28],
  'hero:dead': [6, -7],
  ...BUILTIN_HERO_HEAD_ANCHORS_DATA,
};

type RGBA = readonly [number, number, number, number];
type RGB = readonly [number, number, number];

// Deterministic integer hash for crisp pixel masonry grain & cracks
function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function hexRgb(hex: string): RGB {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    clampByte(a[0] + (b[0] - a[0]) * k),
    clampByte(a[1] + (b[1] - a[1]) * k),
    clampByte(a[2] + (b[2] - a[2]) * k),
  ];
}

function scaleRgb(c: RGB, mul: number): RGB {
  return [clampByte(c[0] * mul), clampByte(c[1] * mul), clampByte(c[2] * mul)];
}

// =============================================================================
// Atlas Canvas Surface + Sculpted Heightfield -> Tangent-Space Sobel Normals
// =============================================================================

class PixelAtlasBuilder {
  readonly width = ATLAS_W;
  readonly height = ATLAS_H;
  readonly albedo = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  readonly normal = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  readonly emissive = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  private readonly heightMap = new Float32Array(ATLAS_W * ATLAS_H);
  private readonly customNormalFlag = new Uint8Array(ATLAS_W * ATLAS_H);

  readonly regions: Record<string, SpriteRegion> = {};
  private cursorX = PAD;
  private cursorY = PAD;
  private rowH = 0;

  // Current active region bounds for local drawing
  private rx = 0;
  private ry = 0;
  private rw = 0;
  private rh = 0;

  constructor() {
    // Initialize normal buffer to flat up (+Z = 255)
    for (let i = 0; i < ATLAS_W * ATLAS_H; i++) {
      const o = i * 4;
      this.normal[o] = 128;
      this.normal[o + 1] = 128;
      this.normal[o + 2] = 255;
      this.normal[o + 3] = 255;
    }
  }

  alloc(key: string, w: number, h: number, pivotX = 0.5, pivotY = 1.0): SpriteRegion {
    if (this.cursorX + w + PAD > this.width) {
      this.cursorX = PAD;
      this.cursorY += this.rowH + PAD;
      this.rowH = 0;
    }
    if (this.cursorY + h + PAD > this.height) {
      throw new Error(`ProceduralAtlas overflow placing ${key} (${w}x${h}) at y=${this.cursorY}`);
    }
    const x = this.cursorX;
    const y = this.cursorY;
    this.cursorX += w + PAD;
    if (h > this.rowH) this.rowH = h;

    const region: SpriteRegion = {
      key,
      x,
      y,
      w,
      h,
      u0: x / this.width,
      v0: y / this.height,
      u1: (x + w) / this.width,
      v1: (y + h) / this.height,
      pivotX,
      pivotY,
    };
    this.regions[key] = region;
    this.rx = x;
    this.ry = y;
    this.rw = w;
    this.rh = h;
    return region;
  }

  alias(aliasKey: string, existingKey: string): void {
    const src = this.regions[existingKey];
    if (src && !this.regions[aliasKey]) {
      this.regions[aliasKey] = { ...src, key: aliasKey };
    }
  }

  px(
    lx: number,
    ly: number,
    r: number,
    g: number,
    b: number,
    a = 255,
    height = 0.5,
    er = 0,
    eg = 0,
    eb = 0,
    ea = 0
  ): void {
    const ix = lx | 0;
    const iy = ly | 0;
    if (ix < 0 || iy < 0 || ix >= this.rw || iy >= this.rh) return;
    const gx = this.rx + ix;
    const gy = this.ry + iy;
    const idx = gy * this.width + gx;
    const o = idx * 4;
    if (a >= 255 || this.albedo[o + 3] === 0) {
      this.albedo[o] = clampByte(r);
      this.albedo[o + 1] = clampByte(g);
      this.albedo[o + 2] = clampByte(b);
      this.albedo[o + 3] = clampByte(a);
    } else if (a > 0) {
      const sa = a / 255;
      const da = 1 - sa;
      this.albedo[o] = clampByte(r * sa + this.albedo[o] * da);
      this.albedo[o + 1] = clampByte(g * sa + this.albedo[o + 1] * da);
      this.albedo[o + 2] = clampByte(b * sa + this.albedo[o + 2] * da);
      this.albedo[o + 3] = clampByte(Math.min(255, this.albedo[o + 3] + a));
    }
    this.heightMap[idx] = height;
    if (ea > 0) {
      this.emissive[o] = clampByte(Math.max(this.emissive[o], er));
      this.emissive[o + 1] = clampByte(Math.max(this.emissive[o + 1], eg));
      this.emissive[o + 2] = clampByte(Math.max(this.emissive[o + 2], eb));
      this.emissive[o + 3] = clampByte(Math.max(this.emissive[o + 3], ea));
    }
  }

  pxRgb(lx: number, ly: number, rgb: RGB, height = 0.5, em?: RGB, emA = 0): void {
    if (em && emA > 0) {
      this.px(lx, ly, rgb[0], rgb[1], rgb[2], 255, height, em[0], em[1], em[2], emA);
    } else {
      this.px(lx, ly, rgb[0], rgb[1], rgb[2], 255, height);
    }
  }

  setNormalDirect(lx: number, ly: number, nx: number, ny: number, nz: number): void {
    const ix = lx | 0;
    const iy = ly | 0;
    if (ix < 0 || iy < 0 || ix >= this.rw || iy >= this.rh) return;
    const gx = this.rx + ix;
    const gy = this.ry + iy;
    const idx = gy * this.width + gx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const o = idx * 4;
    this.normal[o] = clampByte(((nx / len) * 0.5 + 0.5) * 255);
    this.normal[o + 1] = clampByte(((ny / len) * 0.5 + 0.5) * 255);
    this.normal[o + 2] = clampByte(((nz / len) * 0.5 + 0.5) * 255);
    this.normal[o + 3] = 255;
    this.customNormalFlag[idx] = 1;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    rgb: RGB,
    height = 0.5,
    bevel = 0,
    em?: RGB,
    emA = 0
  ): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        let hh = height;
        let col = rgb;
        if (bevel > 0) {
          const ex = Math.min(dx, w - 1 - dx);
          const ey = Math.min(dy, h - 1 - dy);
          const edge = Math.min(ex, ey);
          if (edge < bevel) {
            hh = height * (0.45 + 0.55 * (edge / bevel));
            if (dy < bevel || dx < bevel) {
              col = scaleRgb(rgb, 1.14);
            } else {
              col = scaleRgb(rgb, 0.78);
            }
          }
        }
        this.pxRgb(x + dx, y + dy, col, hh, em, emA);
      }
    }
  }

  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rgb: RGB,
    baseHeight = 0.65,
    domeScale = 0.35,
    em?: RGB,
    emA = 0,
    outline?: RGB
  ): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / Math.max(0.5, rx);
        const ny = (y - cy) / Math.max(0.5, ry);
        const d2 = nx * nx + ny * ny;
        if (d2 <= 1.0) {
          const dome = Math.sqrt(Math.max(0, 1 - d2));
          // Slight pixel shading from upper-left to make silhouette rich even before lighting
          const shade = 0.84 + 0.24 * Math.max(0, -nx * 0.4 - ny * 0.65 + dome * 0.45);
          const col = outline && d2 > 0.78 ? outline : scaleRgb(rgb, shade);
          this.pxRgb(x, y, col, baseHeight + dome * domeScale, em, emA);
        }
      }
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rgb: RGB,
    thickness = 1,
    height = 0.75,
    em?: RGB,
    emA = 0
  ): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
    const rad = Math.max(0, (thickness - 1) * 0.5);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      if (rad <= 0.2) {
        this.pxRgb(Math.round(px), Math.round(py), rgb, height, em, emA);
      } else {
        for (let oy = -Math.ceil(rad); oy <= Math.ceil(rad); oy++) {
          for (let ox = -Math.ceil(rad); ox <= Math.ceil(rad); ox++) {
            const dist = Math.hypot(ox, oy);
            if (dist <= rad + 0.35) {
              const hLocal = height + (1 - dist / (rad + 0.5)) * 0.15;
              this.pxRgb(Math.round(px + ox), Math.round(py + oy), rgb, hLocal, em, emA);
            }
          }
        }
      }
    }
  }

  /**
   * Scanline-filled sculpted polygon with domed heightfield & directional upper-left
   * shading for organic gothic armor plates, horned pauldrons, tattered cloaks & blades.
   */
  polygon(
    pts: ReadonlyArray<readonly [number, number]>,
    rgb: RGB,
    baseHeight = 0.72,
    bevelScale = 0.24,
    em?: RGB,
    emA = 0
  ): void {
    if (pts.length < 3) return;
    let minX = this.rw;
    let maxX = 0;
    let minY = this.rh;
    let maxY = 0;
    for (const [px, py] of pts) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const halfW = Math.max(1, (maxX - minX) * 0.5);
    const halfH = Math.max(1, (maxY - minY) * 0.5);
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.rh - 1, Math.ceil(maxY));

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
        const ex = Math.min(this.rw - 1, Math.ceil(xs[k + 1]));
        for (let x = sx; x <= ex; x++) {
          const nx = (x - cx) / halfW;
          const ny = (y - cy) / halfH;
          const d = Math.min(1, Math.hypot(nx * 0.85, ny * 0.85));
          const dome = Math.sqrt(Math.max(0, 1 - d * d));
          const shade = 0.82 + 0.26 * Math.max(0, -nx * 0.35 - ny * 0.6 + dome * 0.45);
          const col = scaleRgb(rgb, shade);
          this.pxRgb(x, y, col, baseHeight + dome * bevelScale, em, emA);
        }
      }
    }
  }

  /**
   * Computes genuine 3x3 Sobel tangent-space normal maps strictly within the
   * current region bounds.
   * Convention (World Y-Down):
   *   nx = -gx * strength   (left-facing edge => nx < 0, catches light on left)
   *   ny = -gy * strength   (top-facing edge  => ny < 0, catches overhead light)
   *   nz = +1.0             (outward toward viewer)
   */
  bakeRegionNormals(strength = 3.2, tileWrap = false): void {
    const rx = this.rx;
    const ry = this.ry;
    const rw = this.rw;
    const rh = this.rh;

    const sampleH = (lx: number, ly: number): number => {
      let sx = lx;
      let sy = ly;
      if (tileWrap) {
        sx = ((lx % rw) + rw) % rw;
        sy = ((ly % rh) + rh) % rh;
      } else {
        sx = lx < 0 ? 0 : lx >= rw ? rw - 1 : lx;
        sy = ly < 0 ? 0 : ly >= rh ? rh - 1 : ly;
      }
      const idx = (ry + sy) * this.width + (rx + sx);
      if (this.albedo[idx * 4 + 3] < 20) return 0.0;
      return this.heightMap[idx];
    };

    for (let ly = 0; ly < rh; ly++) {
      for (let lx = 0; lx < rw; lx++) {
        const idx = (ry + ly) * this.width + (rx + lx);
        if (this.customNormalFlag[idx] === 1) continue;
        const o = idx * 4;
        if (this.albedo[o + 3] < 10) {
          this.normal[o] = 128;
          this.normal[o + 1] = 128;
          this.normal[o + 2] = 255;
          this.normal[o + 3] = 255;
          continue;
        }
        const tl = sampleH(lx - 1, ly - 1);
        const tc = sampleH(lx, ly - 1);
        const tr = sampleH(lx + 1, ly - 1);
        const ml = sampleH(lx - 1, ly);
        const mr = sampleH(lx + 1, ly);
        const bl = sampleH(lx - 1, ly + 1);
        const bc = sampleH(lx, ly + 1);
        const br = sampleH(lx + 1, ly + 1);

        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);

        let nx = -gx * strength;
        let ny = -gy * strength;
        let nz = 1.0;
        const invLen = 1 / Math.hypot(nx, ny, nz);
        nx *= invLen;
        ny *= invLen;
        nz *= invLen;

        this.normal[o] = clampByte((nx * 0.5 + 0.5) * 255);
        this.normal[o + 1] = clampByte((ny * 0.5 + 0.5) * 255);
        this.normal[o + 2] = clampByte((nz * 0.5 + 0.5) * 255);
        this.normal[o + 3] = 255;
      }
    }
  }

  /** Adds a crisp 1px dark silhouette outline around opaque sprite pixels. */
  addOutline(outlineColor: RGB = [16, 14, 24], edgeHeight = 0.22): void {
    const rw = this.rw;
    const rh = this.rh;
    const rx = this.rx;
    const ry = this.ry;
    const mask = new Uint8Array(rw * rh);

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const a = this.albedo[((ry + y) * this.width + (rx + x)) * 4 + 3];
        if (a > 120) mask[y * rw + x] = 1;
      }
    }

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (mask[y * rw + x] === 1) continue;
        const neighbor =
          (x > 0 && mask[y * rw + (x - 1)] === 1) ||
          (x < rw - 1 && mask[y * rw + (x + 1)] === 1) ||
          (y > 0 && mask[(y - 1) * rw + x] === 1) ||
          (y < rh - 1 && mask[(y + 1) * rw + x] === 1);
        if (neighbor) {
          this.pxRgb(x, y, outlineColor, edgeHeight);
        }
      }
    }
  }
}

// =============================================================================
// Biome Tileset Palettes (Rich Medieval / Gothic / Toxic / Brass / Royal Art)
// =============================================================================

interface TilesetPalette {
  stoneBase: RGB;
  stoneHi: RGB;
  stoneDark: RGB;
  mortar: RGB;
  trimTop: RGB;
  trimAccent: RGB;
  wood: RGB;
  woodHi: RGB;
  bgStone: RGB;
  bgAccent: RGB;
  glow: RGB;
  style: 'masonry' | 'moss' | 'pipe' | 'wood' | 'brass' | 'marble';
}

const TILESET_PALETTES: Record<TilesetTheme, TilesetPalette> = {
  prison: {
    stoneBase: hexRgb('#2e384d'),
    stoneHi: hexRgb('#4c5c7a'),
    stoneDark: hexRgb('#192030'),
    mortar: hexRgb('#0b0e18'),
    trimTop: hexRgb('#5b6e8f'),
    trimAccent: hexRgb('#377a66'),
    wood: hexRgb('#543826'),
    woodHi: hexRgb('#7d553a'),
    bgStone: hexRgb('#171e2d'),
    bgAccent: hexRgb('#28344c'),
    glow: hexRgb('#4de8ff'),
    style: 'masonry',
  },
  promenade: {
    stoneBase: hexRgb('#3b4045'),
    stoneHi: hexRgb('#5c636b'),
    stoneDark: hexRgb('#1e2429'),
    mortar: hexRgb('#0e1217'),
    trimTop: hexRgb('#2e6e44'),
    trimAccent: hexRgb('#4fa360'),
    wood: hexRgb('#543b2a'),
    woodHi: hexRgb('#7a5840'),
    bgStone: hexRgb('#1c2429'),
    bgAccent: hexRgb('#2b3b3a'),
    glow: hexRgb('#ffcf54'),
    style: 'moss',
  },
  sewer: {
    stoneBase: hexRgb('#2c3b2e'),
    stoneHi: hexRgb('#496148'),
    stoneDark: hexRgb('#152118'),
    mortar: hexRgb('#0a120c'),
    trimTop: hexRgb('#478524'),
    trimAccent: hexRgb('#7ce03d'),
    wood: hexRgb('#473b2a'),
    woodHi: hexRgb('#69573f'),
    bgStone: hexRgb('#142017'),
    bgAccent: hexRgb('#253b29'),
    glow: hexRgb('#80ff38'),
    style: 'pipe',
  },
  ramparts: {
    stoneBase: hexRgb('#4d403c'),
    stoneHi: hexRgb('#756159'),
    stoneDark: hexRgb('#29201e'),
    mortar: hexRgb('#140f0e'),
    trimTop: hexRgb('#917263'),
    trimAccent: hexRgb('#c76a46'),
    wood: hexRgb('#593824'),
    woodHi: hexRgb('#855538'),
    bgStone: hexRgb('#241c1c'),
    bgAccent: hexRgb('#3d2e2c'),
    glow: hexRgb('#ff9e44'),
    style: 'masonry',
  },
  bridge: {
    stoneBase: hexRgb('#2c3347'),
    stoneHi: hexRgb('#4a5575'),
    stoneDark: hexRgb('#161a29'),
    mortar: hexRgb('#0a0c16'),
    trimTop: hexRgb('#5a6a8f'),
    trimAccent: hexRgb('#b84530'),
    wood: hexRgb('#473128'),
    woodHi: hexRgb('#6b4c3e'),
    bgStone: hexRgb('#141829'),
    bgAccent: hexRgb('#242d47'),
    glow: hexRgb('#ff5733'),
    style: 'masonry',
  },
  stilt: {
    stoneBase: hexRgb('#403c36'),
    stoneHi: hexRgb('#635c53'),
    stoneDark: hexRgb('#211f1c'),
    mortar: hexRgb('#100f0d'),
    trimTop: hexRgb('#694c33'),
    trimAccent: hexRgb('#3f7d67'),
    wood: hexRgb('#5e3f28'),
    woodHi: hexRgb('#8a5f3e'),
    bgStone: hexRgb('#1d1c1a'),
    bgAccent: hexRgb('#332e29'),
    glow: hexRgb('#ffbe4f'),
    style: 'wood',
  },
  clock: {
    stoneBase: hexRgb('#3d2e38'),
    stoneHi: hexRgb('#634b5b'),
    stoneDark: hexRgb('#1f151c'),
    mortar: hexRgb('#10090e'),
    trimTop: hexRgb('#a87e36'),
    trimAccent: hexRgb('#e0be65'),
    wood: hexRgb('#573428'),
    woodHi: hexRgb('#825240'),
    bgStone: hexRgb('#20131c'),
    bgAccent: hexRgb('#3d2732'),
    glow: hexRgb('#52f2e2'),
    style: 'brass',
  },
  castle: {
    stoneBase: hexRgb('#6e6863'),
    stoneHi: hexRgb('#9c9489'),
    stoneDark: hexRgb('#3b3736'),
    mortar: hexRgb('#1c1a1c'),
    trimTop: hexRgb('#8f2230'),
    trimAccent: hexRgb('#cfa246'),
    wood: hexRgb('#5e3927'),
    woodHi: hexRgb('#8a583d'),
    bgStone: hexRgb('#302d36'),
    bgAccent: hexRgb('#4f454b'),
    glow: hexRgb('#ffd269'),
    style: 'marble',
  },
  throne: {
    stoneBase: hexRgb('#3c485e'),
    stoneHi: hexRgb('#637594'),
    stoneDark: hexRgb('#1e2536'),
    mortar: hexRgb('#0e121e'),
    trimTop: hexRgb('#b08d3c'),
    trimAccent: hexRgb('#52b8e8'),
    wood: hexRgb('#4d362b'),
    woodHi: hexRgb('#735342'),
    bgStone: hexRgb('#182033'),
    bgAccent: hexRgb('#2c3954'),
    glow: hexRgb('#6ad2ff'),
    style: 'marble',
  },
  passage: {
    stoneBase: hexRgb('#3d313b'),
    stoneHi: hexRgb('#614f5e'),
    stoneDark: hexRgb('#1f181f'),
    mortar: hexRgb('#0f0b10'),
    trimTop: hexRgb('#755868'),
    trimAccent: hexRgb('#d98336'),
    wood: hexRgb('#593a27'),
    woodHi: hexRgb('#82583d'),
    bgStone: hexRgb('#1d151c'),
    bgAccent: hexRgb('#332430'),
    glow: hexRgb('#ffaa44'),
    style: 'masonry',
  },
};

// =============================================================================
// Tileset Baking — 12-Tile Biome Autotile Sets (Top Variants, Chamfered Corners,
// Chiseled Wall Edges, Ceiling Overhangs, Bracketed Catwalks, Moss/Pipe/Brass/Marble)
// =============================================================================

function paintBrickTile(
  b: PixelAtlasBuilder,
  pal: TilesetPalette,
  seed: number,
  variant: 'top' | 'mid' | 'deep' | 'var',
  topStyleIdx = 0
): void {
  const S = 24;

  // Deep interior bedrock surrounded on all 4 sides by SOLID:
  // Velvety obsidian dungeon rock with subtle recessed carved slabs (zero bright brick noise!)
  if (variant === 'deep') {
    const deepBase = scaleRgb(pal.mortar, 0.72);
    const deepFaint = mixRgb(pal.mortar, pal.stoneDark, 0.22);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const g = hash2(x, y, seed + 131);
        const macro = hash2(Math.floor(x / 8), Math.floor(y / 8), seed + 19);
        const isCrack =
          ((x + y * 2) % 23 === 0 && g > 0.78) ||
          (y === 12 && x > 5 && x < 16 && macro > 0.68);
        const rgb = isCrack
          ? scaleRgb(pal.mortar, 0.55)
          : scaleRgb(mixRgb(deepBase, deepFaint, macro * 0.35), 0.90 + g * 0.14);
        const h = isCrack ? 0.16 : 0.42 + macro * 0.05 + (g - 0.5) * 0.03;
        b.pxRgb(x, y, rgb, h);
      }
    }
    b.bakeRegionNormals(0.7, true);
    return;
  }

  // Exposed masonry: organic hand-hewn uneven gothic stone courses varied per topStyleIdx
  const courseSplitY =
    variant === 'var' ? 11 : topStyleIdx === 1 ? 14 : topStyleIdx === 2 ? 12 : topStyleIdx === 3 ? 15 : 13;
  const xSplits =
    variant === 'var'
      ? [11, 17]
      : topStyleIdx === 1
      ? [10, 16]
      : topStyleIdx === 2
      ? [14, 7]
      : topStyleIdx === 3
      ? [12, 18]
      : [15, 8];
  const xOffsets =
    variant === 'mid' ? [3, 11] : topStyleIdx === 1 ? [6, 2] : topStyleIdx === 2 ? [2, 9] : [0, 5];

  for (let y = 0; y < S; y++) {
    const row = y < courseSplitY ? 0 : 1;
    const ly = row === 0 ? y : y - courseSplitY;
    const rowH = row === 0 ? courseSplitY : S - courseSplitY;
    const split = xSplits[row];
    const offX = xOffsets[row];

    for (let x = 0; x < S; x++) {
      const sx = (x + offX) % S;
      const colIdx = sx < split ? 0 : 1;
      const lx = colIdx === 0 ? sx : sx - split;
      const brickW = colIdx === 0 ? split : S - split;

      const brickSeed = seed * 37 + row * 19 + colIdx * 11 + topStyleIdx * 53;
      const grain = hash2(x, y, brickSeed);
      const chip = hash2(x + row * 7, y + colIdx * 5, seed + 91 + topStyleIdx * 17);
      const brickTint = 0.84 + hash2(colIdx, row, seed + topStyleIdx * 13) * 0.24;

      const cornerDist = Math.min(lx, brickW - 1 - lx) + Math.min(ly, rowH - 1 - ly);
      const isChippedCorner = cornerDist <= 1 && chip > (topStyleIdx === 1 ? 0.28 : 0.42);
      const isMortar = ly === 0 || lx === 0 || isChippedCorner;
      const isTopBevel = ly === 1 && !isChippedCorner;
      const isBotBevel = ly === rowH - 1;
      const isLeftBevel = lx === 1 && !isChippedCorner;
      const isRightBevel = lx === brickW - 1;

      let rgb: RGB;
      let h: number;

      if (isMortar) {
        rgb = pal.mortar;
        h = 0.06;
      } else {
        const baseMix = variant === 'var' ? 0.50 : variant === 'mid' ? 0.38 : 0.28;
        let base = mixRgb(pal.stoneBase, pal.stoneDark, baseMix);
        const vertShade = 1.06 - (ly / Math.max(1, rowH)) * 0.22;
        base = scaleRgb(base, brickTint * vertShade * (0.90 + grain * 0.18));

        const ex = Math.min(lx, brickW - 1 - lx);
        const ey = Math.min(ly, rowH - 1 - ly);
        const bevelFactor = Math.min(1, Math.min(ex, ey) / 2.5);
        h = 0.34 + bevelFactor * 0.56 + (grain - 0.5) * 0.10;

        if (isTopBevel) {
          rgb = mixRgb(base, pal.stoneHi, 0.28);
        } else if (isLeftBevel) {
          rgb = mixRgb(base, pal.stoneHi, 0.16);
        } else if (isBotBevel || isRightBevel) {
          rgb = mixRgb(base, pal.stoneDark, 0.58);
        } else {
          rgb = base;
        }

        // Weathered hairline cracks & stone pitting
        if (grain > (topStyleIdx === 1 ? 0.84 : 0.90) && ly > 2 && ly < rowH - 2) {
          rgb = mixRgb(rgb, pal.stoneDark, 0.48);
          h *= 0.70;
        }

        // Style-specific architectural details
        if (pal.style === 'brass' && row === 1 && (lx === 2 || lx === brickW - 2) && ly === 4) {
          rgb = pal.trimTop;
          h = 0.95;
        } else if (pal.style === 'marble' && grain > 0.86) {
          rgb = mixRgb(rgb, pal.stoneHi, 0.22);
        } else if (pal.style === 'wood') {
          const woodWave = Math.sin(x * 0.45 + row * 2.1 + topStyleIdx) * 0.5 + 0.5;
          rgb = mixRgb(pal.wood, pal.woodHi, woodWave * 0.32);
          if (ly === 0 || ly === 5) {
            rgb = pal.mortar;
            h = 0.12;
          }
        }

        // Variant-specific weathering for top_1 (cracked), top_2 (stained/mossy/slime), top_3 (carved/riveted)
        if (variant === 'top' && topStyleIdx === 1) {
          if (Math.abs((x - 10) - (y - 6) * 0.7) < 0.85 && y >= 5 && y <= 19) {
            rgb = pal.mortar;
            h = 0.10;
          }
        } else if (variant === 'top' && topStyleIdx === 2) {
          const dripLen = 6 + Math.floor(hash2(x, 3, seed + 207) * 8);
          if (y < dripLen && (x % 7 === 2 || x % 7 === 3)) {
            rgb = mixRgb(rgb, pal.trimAccent, pal.style === 'pipe' ? 0.65 : 0.48);
            h = Math.min(1, h + 0.12);
          }
        } else if (variant === 'top' && topStyleIdx === 3) {
          // Carved frieze band + iron/gold studs along upper course
          if (y === 8 || y === 11) {
            rgb = mixRgb(rgb, pal.mortar, 0.62);
            h = 0.24;
          } else if (y === 9 || y === 10) {
            const isStud = x % 6 === 2 || x % 6 === 3;
            rgb = isStud ? mixRgb(pal.stoneHi, pal.trimAccent, 0.35) : mixRgb(rgb, pal.stoneHi, 0.2);
            h = isStud ? 0.94 : 0.76;
          }
        }

        if (variant === 'var' && ((x + y * 2) % 15 === 0) && grain > 0.45) {
          rgb = pal.mortar;
          h = 0.12;
        }
      }

      // Sculpted overhanging flagstone / moss / pipe / carpet top cap (5px beveled lip + dark cast shadow!)
      if (variant === 'top' && y < 6) {
        if (pal.style === 'moss' || (topStyleIdx === 2 && pal.style === 'masonry')) {
          const drape = 2 + Math.floor(hash2(x, topStyleIdx, seed + 7) * (topStyleIdx === 2 ? 4.6 : 3.8));
          if (y < drape) {
            rgb = y === 0 ? pal.trimAccent : pal.trimTop;
            h = 0.88 - y * 0.06;
          } else if (y === drape) {
            rgb = pal.mortar;
            h = 0.14;
          }
        } else if (pal.style === 'pipe') {
          if (y < 3) {
            rgb = y === 0 ? pal.trimAccent : pal.trimTop;
            h = 0.92;
            if (y === 0 && (x + topStyleIdx * 2) % 5 === 1) {
              b.pxRgb(x, y, pal.trimAccent, 0.95, pal.glow, topStyleIdx === 2 ? 210 : 170);
              continue;
            }
          } else if (y === 3) {
            rgb = pal.mortar;
            h = 0.14;
          }
        } else {
          const c1 = topStyleIdx === 1 ? 5 : topStyleIdx === 2 ? 9 : topStyleIdx === 3 ? 11 : 7;
          const c2 = topStyleIdx === 1 ? 15 : topStyleIdx === 2 ? 20 : topStyleIdx === 3 ? 21 : 18;
          const slabCrack = (x === c1 || x === c2) && y < 4;
          const chippedNotch = topStyleIdx === 1 && y === 0 && (x === 6 || x === 16);
          if (slabCrack || chippedNotch) {
            rgb = pal.mortar;
            h = 0.12;
          } else if (y === 0) {
            rgb = mixRgb(pal.trimTop, pal.stoneHi, topStyleIdx === 3 ? 0.52 : 0.38);
            h = 0.95;
          } else if (y <= 2) {
            rgb = scaleRgb(pal.trimTop, 0.88 + grain * 0.16);
            h = 0.84;
          } else if (y === 3) {
            rgb = mixRgb(pal.stoneDark, pal.mortar, 0.65);
            h = 0.30;
          } else if (y === 4) {
            rgb = mixRgb(rgb, pal.mortar, 0.72);
            h = 0.18;
          }
        }
      }

      b.pxRgb(x, y, rgb, h);
    }
  }
  b.bakeRegionNormals(2.9, true);
}

/**
 * Chamfered organic outer corner caps (`corner_tl`, `corner_tr`, `corner_bl`, `corner_br`)
 * so stone platforms have sculpted beveled silhouettes instead of raw square boxes.
 */
function paintCornerTile(
  b: PixelAtlasBuilder,
  pal: TilesetPalette,
  seed: number,
  corner: 'tl' | 'tr' | 'bl' | 'br'
): void {
  const S = 24;
  const isTop = corner === 'tl' || corner === 'tr';
  const isLeft = corner === 'tl' || corner === 'bl';

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = isLeft ? x : S - 1 - x; // distance from exposed vertical edge
      const dy = isTop ? y : S - 1 - y; // distance from exposed horiz edge
      const diag = dx + dy;

      // 3px organic chamfer cutaway at the outer corner
      if (diag < 3) continue;

      const grain = hash2(x, y, seed + 307);
      const isOuterOutline = diag === 3 || dx === 0 || (!isTop && dy === 0);
      const isChamferBevel = diag === 4 || diag === 5;
      const isEdgeQuoin = dx <= 4 && (y % 8 !== 0);

      let rgb: RGB;
      let h: number;

      if (isOuterOutline) {
        rgb = pal.mortar;
        h = 0.14;
      } else if (isTop && y < 4) {
        if (y === 0 || isChamferBevel) {
          rgb = mixRgb(pal.trimTop, pal.stoneHi, isLeft ? 0.55 : 0.38);
          h = 0.96;
        } else if (y <= 2) {
          rgb = scaleRgb(pal.trimTop, 0.88 + grain * 0.16);
          h = 0.86;
        } else {
          rgb = mixRgb(pal.stoneDark, pal.mortar, 0.68);
          h = 0.28;
        }
      } else if (!isTop && dy <= 3) {
        // Shadowed overhanging underside stone bevel
        rgb = dy === 1 ? mixRgb(pal.stoneDark, pal.mortar, 0.55) : scaleRgb(pal.stoneDark, 0.86 + grain * 0.14);
        h = 0.24 + dy * 0.12;
      } else if (dx <= 2) {
        // Crisp chiseled vertical side bevel catching light on left, deep shadow on right
        rgb = isLeft
          ? mixRgb(pal.stoneBase, pal.stoneHi, 0.35 + grain * 0.12)
          : mixRgb(pal.stoneDark, pal.mortar, 0.35);
        h = isLeft ? 0.84 : 0.55;
      } else {
        const courseY = y === 12 || (dx > 5 && x === (isLeft ? 13 : 10));
        if (courseY) {
          rgb = pal.mortar;
          h = 0.08;
        } else {
          const base = isEdgeQuoin ? mixRgb(pal.stoneBase, pal.stoneHi, 0.12) : mixRgb(pal.stoneBase, pal.stoneDark, 0.36);
          rgb = scaleRgb(base, 0.88 + grain * 0.18);
          h = 0.56 + grain * 0.14;
        }
      }

      // Moss or glowing acid accent wrapping over top corners
      if (isTop && pal.style === 'moss' && y < 4 && diag >= 4) {
        rgb = y <= 1 ? pal.trimAccent : pal.trimTop;
        h = 0.90;
      } else if (isTop && pal.style === 'pipe' && y === 1 && diag >= 4 && x % 4 === 1) {
        b.pxRgb(x, y, pal.trimAccent, 0.96, pal.glow, 185);
        continue;
      }

      b.pxRgb(x, y, rgb, h);
    }
  }
  b.bakeRegionNormals(3.2, false);
}

/**
 * Chiseled vertical wall flank tiles (`edge_left`, `edge_right`) with alternating
 * protruding masonry quoins and recessed mortar notches.
 */
function paintWallEdgeTile(
  b: PixelAtlasBuilder,
  pal: TilesetPalette,
  seed: number,
  side: 'left' | 'right'
): void {
  const S = 24;
  const isLeft = side === 'left';

  for (let y = 0; y < S; y++) {
    const course = Math.floor(y / 8); // 3 vertical ashlar courses
    const ly = y - course * 8;
    const quoinW = course % 2 === 0 ? 7 : 5;
    const indent = ly === 0 || ly === 7 ? 1 : 0;

    for (let x = 0; x < S; x++) {
      const dx = isLeft ? x : S - 1 - x;
      if (dx < indent) continue;

      const grain = hash2(x, y, seed + 419 + course * 13);
      const isMortar = ly === 0 || dx === quoinW;
      const isOuter = dx === indent;
      const isBevel = dx === indent + 1 || dx === indent + 2;

      let rgb: RGB;
      let h: number;

      if (isOuter || isMortar) {
        rgb = pal.mortar;
        h = 0.10;
      } else if (isBevel) {
        rgb = isLeft
          ? mixRgb(pal.stoneBase, pal.stoneHi, 0.42)
          : mixRgb(pal.stoneDark, pal.mortar, 0.32);
        h = isLeft ? 0.90 : 0.62;
      } else if (dx < quoinW) {
        const shade = 0.92 + (1 - ly / 8) * 0.16;
        rgb = scaleRgb(mixRgb(pal.stoneBase, pal.stoneHi, 0.12), shade * (0.9 + grain * 0.16));
        h = 0.78 + grain * 0.1;
      } else {
        const innerFade = Math.min(1, (dx - quoinW) / 14);
        const base = mixRgb(pal.stoneBase, pal.stoneDark, 0.35 + innerFade * 0.35);
        rgb = scaleRgb(base, 0.88 + grain * 0.16);
        h = 0.56 - innerFade * 0.12 + grain * 0.08;
      }

      if (pal.style === 'brass' && dx === 3 && ly === 4) {
        rgb = pal.trimAccent;
        h = 0.96;
      }
      b.pxRgb(x, y, rgb, h);
    }
  }
  b.bakeRegionNormals(3.3, false);
}

/**
 * Underside overhanging ceiling tiles (`solid_ceil_0`, `solid_ceil_1`) with
 * shadowed stone cornice lips, stalactite teeth, or iron brackets.
 */
function paintCeilingTile(
  b: PixelAtlasBuilder,
  pal: TilesetPalette,
  seed: number,
  variant: 0 | 1
): void {
  const S = 24;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const grain = hash2(x, y, seed + 521 + variant * 41);
      // Irregular sculpted stone bottom profile at y=20..23
      const wave =
        variant === 0
          ? Math.sin(x * 0.65) * 1.4 + (x % 9 === 3 ? 1.8 : 0)
          : Math.cos(x * 0.55 + 1.2) * 1.5 + (x % 7 === 4 ? 1.6 : 0);
      const bottomY = Math.min(23, Math.max(19, Math.round(21.5 + wave)));
      if (y > bottomY) continue;

      const isBottomOutline = y === bottomY;
      const isUnderLip = y >= bottomY - 3;
      const isMortar = (y === 11 && (x + variant * 5) % 12 !== 0) || ((x + (y < 11 ? 3 : 9) + variant * 4) % 14 === 0 && y < 18);

      let rgb: RGB;
      let h: number;

      if (isBottomOutline || isMortar) {
        rgb = pal.mortar;
        h = 0.10;
      } else if (isUnderLip) {
        const lipShade = y === bottomY - 1 ? 0.68 : 0.84;
        rgb = scaleRgb(mixRgb(pal.stoneDark, pal.stoneBase, 0.35), lipShade * (0.9 + grain * 0.14));
        h = 0.34 + (bottomY - y) * 0.14;
        // Glowing green sewer acid drip or brass bolt under ceiling
        if (pal.style === 'pipe' && y === bottomY - 1 && (x === 6 || x === 18)) {
          b.pxRgb(x, y, pal.trimAccent, 0.92, pal.glow, 195);
          continue;
        }
        if ((pal.style === 'brass' || pal.style === 'marble') && y === bottomY - 2 && x % 6 === 3) {
          rgb = pal.trimTop;
          h = 0.92;
        }
      } else {
        const base = mixRgb(pal.stoneDark, pal.stoneBase, 0.38);
        rgb = scaleRgb(base, 0.86 + grain * 0.18);
        h = 0.52 + grain * 0.12;
      }
      b.pxRgb(x, y, rgb, h);
    }
  }
  b.bakeRegionNormals(3.0, false);
}

function paintOneWayTile(
  b: PixelAtlasBuilder,
  pal: TilesetPalette,
  cap: 'left' | 'mid' | 'right' = 'mid'
): void {
  const S = 24;
  const xMin = cap === 'left' ? 2 : 0;
  const xMax = cap === 'right' ? S - 3 : S - 1;

  // Biome-adapted plank & bracket materials
  const plankHi = pal.style === 'brass' ? pal.trimAccent : pal.style === 'marble' ? pal.stoneHi : pal.woodHi;
  const plankMid = pal.style === 'brass' ? pal.trimTop : pal.style === 'marble' ? pal.stoneBase : pal.wood;
  const bracketHi = pal.style === 'brass' ? pal.trimAccent : pal.stoneHi;
  const bracketMid = pal.style === 'brass' ? pal.trimTop : pal.stoneBase;

  for (let y = 0; y < 9; y++) {
    for (let x = xMin; x <= xMax; x++) {
      // Chamfer outer top/bottom pixels on endcaps
      if (cap === 'left' && x === xMin && (y === 0 || y === 8)) continue;
      if (cap === 'right' && x === xMax && (y === 0 || y === 8)) continue;

      const grain = hash2(x, y, 77 + (cap === 'left' ? 11 : cap === 'right' ? 23 : 0));
      const isEndCap = (cap === 'left' && x <= 5) || (cap === 'right' && x >= S - 6);
      const isIronStrap = isEndCap || (cap === 'mid' && (x === 3 || x === 4 || x === 19 || x === 20));
      const isPlankSeam = !isIronStrap && x === 11 && y >= 1 && y <= 6;

      let col: RGB;
      let h = 0.72;
      if (isIronStrap) {
        const isRivet =
          (y === 2 || y === 5) &&
          ((cap === 'left' && x === 4) ||
            (cap === 'right' && x === S - 5) ||
            (cap === 'mid' && (x === 3 || x === 19)));
        col = isRivet
          ? [235, 240, 250]
          : y === 0
          ? bracketHi
          : y <= 5
          ? bracketMid
          : pal.stoneDark;
        h = isRivet ? 0.98 : 0.90;
      } else if (isPlankSeam) {
        col = pal.mortar;
        h = 0.24;
      } else if (y === 0) {
        col = mixRgb(plankHi, [245, 224, 190], 0.22);
        h = 0.94;
      } else if (y === 1 || y === 2) {
        col = scaleRgb(plankHi, 0.88 + grain * 0.16);
        h = 0.86;
      } else if (y === 3) {
        col = scaleRgb(plankMid, 0.92 + grain * 0.14);
        h = 0.78;
      } else if (y <= 6) {
        col = scaleRgb(plankMid, 0.78 + grain * 0.14);
        h = 0.68;
      } else if (y === 7) {
        col = scaleRgb(plankMid, 0.45);
        h = 0.36;
      } else {
        col = pal.mortar;
        h = 0.14;
      }
      b.pxRgb(x, y, col, h);
    }
  }

  // Sculpted forged-iron support corbel brackets beneath catwalk
  if (cap === 'mid') {
    for (const bx of [3, 19]) {
      b.pxRgb(bx - 1, 9, pal.mortar, 0.3);
      b.pxRgb(bx, 9, bracketMid, 0.78);
      b.pxRgb(bx + 1, 9, pal.stoneDark, 0.68);
      b.pxRgb(bx + 2, 9, pal.mortar, 0.3);
      b.pxRgb(bx, 10, pal.stoneDark, 0.52);
      b.pxRgb(bx + 1, 10, pal.mortar, 0.28);
    }
  } else if (cap === 'left') {
    // Curved end-bracket corbel bracing left edge
    b.line(4, 9, 10, 9, bracketHi, 2, 0.84);
    b.line(4, 9, 4, 14, bracketMid, 2, 0.80);
    b.line(5, 13, 9, 9, pal.stoneDark, 1.5, 0.72);
    b.pxRgb(4, 15, pal.mortar, 0.24);
  } else {
    // Curved end-bracket corbel bracing right edge
    b.line(S - 11, 9, S - 5, 9, bracketHi, 2, 0.84);
    b.line(S - 5, 9, S - 5, 14, bracketMid, 2, 0.80);
    b.line(S - 6, 13, S - 10, 9, pal.stoneDark, 1.5, 0.72);
    b.pxRgb(S - 5, 15, pal.mortar, 0.24);
  }
  b.bakeRegionNormals(3.0, false);
}

function paintBgWallTile(b: PixelAtlasBuilder, pal: TilesetPalette, seed: number, kind: 'wall' | 'arch' | 'pillar'): void {
  const S = 24;
  if (kind === 'pillar') {
    // Recessed dark gothic carved masonry pilaster (blends naturally with bg_wall — NO bright flat grey stripe!)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const g = hash2(x, y, seed + 61);
        if (x < 5 || x >= 19) {
          // Flanking recessed background stonework
          const isSeam = y % 8 === 0 || x === 0;
          b.pxRgb(x, y, isSeam ? pal.mortar : scaleRgb(pal.bgStone, 0.82 + g * 0.18), isSeam ? 0.08 : 0.35);
          continue;
        }
        const u = ((x - 5) / 13) * 2 - 1;
        const flute = Math.sin((x - 5) * 1.55) * 0.14;
        const nx = Math.max(-0.9, Math.min(0.9, u * 0.82 + flute));
        const nz = Math.sqrt(Math.max(0.1, 1 - nx * nx));
        const shade = 0.45 + nz * 0.48 + (g - 0.5) * 0.08;
        const isCourse = y === 0 || y === 12;
        const isEdge = x === 5 || x === 18;
        const col = isCourse || isEdge ? pal.mortar : scaleRgb(pal.bgAccent, shade);
        b.pxRgb(x, y, col, isCourse ? 0.18 : 0.62);
        b.setNormalDirect(x, y, nx, isCourse ? 0.25 : 0, nz);
      }
    }
    return;
  }

  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / 6);
    const ly = y - row * 6;
    const offset = row % 2 === 0 ? 0 : 6;
    for (let x = 0; x < S; x++) {
      const sx = (x + offset) % S;
      const lx = sx % 12;
      const g = hash2(x, y, seed + 51);
      const isSeam = ly === 0 || lx === 0;
      let col = isSeam ? pal.mortar : scaleRgb(pal.bgStone, 0.88 + g * 0.22);
      let h = isSeam ? 0.12 : 0.46 + g * 0.1;

      if (kind === 'arch') {
        const dx = (x - 11.5) / 8.5;
        const dy = (y - 9.0) / 11.0;
        const inArch = (y > 9 && Math.abs(x - 11.5) < 7.5) || (dx * dx + dy * dy < 1.0 && y <= 10);
        const onRim =
          !inArch &&
          ((y > 8 && Math.abs(x - 11.5) < 9.5) || (dx * dx + dy * dy < 1.48 && y <= 10));
        if (inArch) {
          // Deep iron-grated alcove
          const isBar = x === 8 || x === 12 || x === 16 || y === 12 || y === 18;
          col = isBar ? pal.stoneDark : scaleRgb(pal.mortar, 0.65);
          h = isBar ? 0.62 : 0.04;
        } else if (onRim) {
          col = pal.bgAccent;
          h = 0.78;
        }
      }
      b.pxRgb(x, y, col, h);
    }
  }
  b.bakeRegionNormals(2.6, true);
}

function paintCrackedOrSecretTile(b: PixelAtlasBuilder, pal: TilesetPalette, seed: number, isSecret: boolean): void {
  paintBrickTile(b, pal, seed + (isSecret ? 99 : 44), 'mid');
  if (isSecret) {
    // Faint glowing ancient glyph in center
    const pts: Array<[number, number]> = [
      [12, 6], [11, 7], [13, 7], [10, 9], [14, 9], [12, 11],
      [9, 13], [15, 13], [12, 15], [12, 17],
    ];
    for (const [px, py] of pts) {
      b.pxRgb(px, py, mixRgb(pal.stoneHi, pal.glow, 0.55), 0.3, pal.glow, 175);
    }
  } else {
    // Deep diagonal fracture fissures with subtle amber/cyan crack glow
    b.line(3, 2, 11, 11, pal.mortar, 2, 0.05);
    b.line(11, 11, 20, 21, pal.mortar, 2, 0.05);
    b.line(18, 4, 11, 11, pal.mortar, 1, 0.05);
    b.line(11, 11, 5, 20, pal.mortar, 1, 0.05);
    b.line(4, 3, 19, 20, pal.glow, 1, 0.12, pal.glow, 165);
  }
  b.bakeRegionNormals(3.4, false);
}

// =============================================================================
// Universal Tiles, Props, Doors, Chests, Shrines & NPCs
// =============================================================================

function paintUniversalTiles(b: PixelAtlasBuilder): void {
  // Ladder (24x24)
  b.alloc('tile:ladder', 24, 24, 0.5, 0.5);
  const railDark = hexRgb('#4a3122');
  const railHi = hexRgb('#916344');
  const iron = hexRgb('#737f94');
  for (let y = 0; y < 24; y++) {
    for (const rx of [4, 18]) {
      b.pxRgb(rx, y, railDark, 0.55);
      b.pxRgb(rx + 1, y, railHi, 0.88);
      b.pxRgb(rx + 2, y, railDark, 0.55);
    }
  }
  for (const ry of [4, 10, 16, 22]) {
    for (let x = 5; x <= 18; x++) {
      b.pxRgb(x, ry - 1, railHi, 0.85);
      b.pxRgb(x, ry, railDark, 0.65);
    }
    b.pxRgb(5, ry - 1, iron, 0.95);
    b.pxRgb(18, ry - 1, iron, 0.95);
  }
  b.bakeRegionNormals(3.0, false);

  // Chain (24x24)
  b.alloc('tile:chain', 24, 24, 0.5, 0.5);
  const chDark = hexRgb('#373d4f');
  const chMid = hexRgb('#68738f');
  const chHi = hexRgb('#a8b5d4');
  for (let link = 0; link < 4; link++) {
    const cy = link * 6 + 3;
    if (link % 2 === 0) {
      for (let dy = -2; dy <= 2; dy++) {
        b.pxRgb(10, cy + dy, dy === -2 ? chHi : chMid, 0.82);
        b.pxRgb(13, cy + dy, dy === 2 ? chDark : chMid, 0.82);
      }
      b.pxRgb(11, cy - 2, chHi, 0.92);
      b.pxRgb(12, cy - 2, chHi, 0.92);
      b.pxRgb(11, cy + 2, chDark, 0.7);
      b.pxRgb(12, cy + 2, chDark, 0.7);
    } else {
      for (let dy = -2; dy <= 2; dy++) {
        b.pxRgb(11, cy + dy, chHi, 0.95);
        b.pxRgb(12, cy + dy, chDark, 0.78);
      }
    }
  }
  b.bakeRegionNormals(3.2, false);

  // Spikes (24x24)
  b.alloc('tile:spikes', 24, 24, 0.5, 1.0);
  const steelHi = hexRgb('#cfd8ea');
  const steelMid = hexRgb('#7e8ba3');
  const steelDark = hexRgb('#394154');
  const crimson = hexRgb('#b82838');
  for (let s = 0; s < 3; s++) {
    const cx = s * 8 + 4;
    for (let y = 6; y < 24; y++) {
      const halfW = Math.floor(((y - 6) / 18) * 3.8);
      for (let dx = -halfW; dx <= halfW; dx++) {
        const isTip = y < 10;
        const col = isTip ? crimson : dx < 0 ? steelHi : dx === 0 ? steelMid : steelDark;
        const h = 0.95 - Math.abs(dx) * 0.18;
        b.pxRgb(cx + dx, y, col, h);
      }
    }
  }
  b.bakeRegionNormals(3.6, false);

  // Acid (2 animated frames, strongly emissive toxic green bubbles!)
  for (let f = 0; f < 2; f++) {
    b.alloc(`tile:acid_${f}`, 24, 24, 0.5, 0.5);
    const acidDeep = hexRgb('#1f5e10');
    const acidMid = hexRgb('#44b81a');
    const acidBright = hexRgb('#a8ff4d');
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const wave = Math.sin((x + f * 12) * 0.52) * 1.4;
        if (y < 2 + wave) continue;
        const nearTop = y < 6 + wave;
        const col = nearTop ? acidBright : y < 12 ? acidMid : acidDeep;
        const emA = nearTop ? 235 : 130;
        b.pxRgb(x, y, col, nearTop ? 0.82 : 0.45, nearTop ? acidBright : acidMid, emA);
      }
    }
    // Glowing rising bubbles
    b.ellipse(6 + f * 7, 13 - f * 3, 2.2, 2.2, acidBright, 0.9, 0.1, acidBright, 240);
    b.ellipse(17 - f * 5, 18 - f * 2, 1.8, 1.8, acidBright, 0.9, 0.1, acidBright, 220);
    b.bakeRegionNormals(2.0, true);
  }

  // Water (2 animated frames)
  for (let f = 0; f < 2; f++) {
    b.alloc(`tile:water_${f}`, 24, 24, 0.5, 0.5);
    const wDeep = hexRgb('#22396e');
    const wMid = hexRgb('#3a65ad');
    const wFoam = hexRgb('#a6dcff');
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const wave = Math.sin((x + f * 12) * 0.48) * 1.3;
        if (y < 2 + wave) continue;
        const nearTop = y < 5 + wave;
        const col = nearTop ? wFoam : y < 13 ? wMid : wDeep;
        b.px(x, y, col[0], col[1], col[2], nearTop ? 225 : 185, nearTop ? 0.8 : 0.4, nearTop ? wFoam[0] : 0, nearTop ? wFoam[1] : 0, nearTop ? wFoam[2] : 0, nearTop ? 95 : 0);
      }
    }
    b.bakeRegionNormals(1.8, true);
  }
}

function paintPropsAndNpcs(b: PixelAtlasBuilder): void {
  const ironDark = hexRgb('#2a2e3d');
  const ironMid = hexRgb('#525a70');
  const ironHi = hexRgb('#8d99b8');
  const goldDark = hexRgb('#8a6220');
  const goldMid = hexRgb('#d9a438');
  const goldHi = hexRgb('#ffe885');
  const flameRed = hexRgb('#ff4e1c');
  const flameOrg = hexRgb('#ffa426');
  const flameYel = hexRgb('#fff49c');

  // Braziers (3 flame frames, 24x32)
  for (let f = 0; f < 3; f++) {
    b.alloc(`prop:brazier_${f}`, 24, 32, 0.5, 1.0);
    // Iron bowl & pedestal
    b.rect(5, 16, 14, 5, ironMid, 0.78, 1);
    b.rect(7, 21, 10, 3, ironDark, 0.65);
    b.rect(10, 24, 4, 6, ironMid, 0.72);
    b.rect(6, 29, 12, 3, ironHi, 0.82, 1);
    // Glowing coal bed
    b.rect(7, 14, 10, 3, flameRed, 0.85, 0, flameRed, 235);
    // Animated multi-layered flame
    const sway = (f - 1) * 1.5;
    b.ellipse(12 + sway * 0.5, 11, 5.2, 6.2, flameRed, 0.7, 0.2, flameRed, 245);
    b.ellipse(12 + sway, 10, 3.6, 5.2, flameOrg, 0.8, 0.2, flameOrg, 255);
    b.ellipse(12 + sway * 0.8, 11.5, 2.0, 3.0, flameYel, 0.9, 0.1, flameYel, 255);
    // Rising spark pixel
    b.pxRgb(11 + f * 2, 3 + (f % 2), flameYel, 0.9, flameYel, 255);
    b.bakeRegionNormals(3.0, false);
  }

  // Wall Torches (3 flame frames, 16x24)
  for (let f = 0; f < 3; f++) {
    b.alloc(`prop:torch_${f}`, 16, 24, 0.5, 0.85);
    b.rect(6, 12, 4, 10, hexRgb('#5c3d28'), 0.72, 1);
    b.rect(5, 11, 6, 3, ironHi, 0.85);
    const sway = (f - 1) * 1.1;
    b.ellipse(8 + sway * 0.4, 8, 3.8, 4.8, flameRed, 0.75, 0.2, flameRed, 240);
    b.ellipse(8 + sway, 7.5, 2.4, 3.6, flameOrg, 0.85, 0.15, flameOrg, 255);
    b.ellipse(8 + sway * 0.6, 8.5, 1.3, 2.0, flameYel, 0.92, 0.08, flameYel, 255);
    b.bakeRegionNormals(2.6, false);
  }

  // Gothic Banners (2 sway frames, 18x36)
  for (let f = 0; f < 2; f++) {
    b.alloc(`prop:banner_${f}`, 18, 36, 0.5, 0.0);
    b.rect(1, 1, 16, 3, goldMid, 0.9, 1);
    const crimson = hexRgb('#8f1d2c');
    const crimsonHi = hexRgb('#c42d40');
    for (let y = 4; y < 34; y++) {
      const sway = Math.round(Math.sin(y * 0.22 + f * 1.4) * (y / 22));
      const cut = y > 26 ? Math.max(0, y - 26) : 0;
      for (let x = 3; x <= 14; x++) {
        if (Math.abs(x - 8.5) < cut * 0.6) continue;
        const fold = Math.sin((x + sway) * 0.7) * 0.5 + 0.5;
        const isTrim = x === 3 || x === 14 || (y === 14 && x > 5 && x < 12);
        const col = isTrim ? goldHi : mixRgb(crimson, crimsonHi, fold);
        b.pxRgb(x + sway, y, col, 0.55 + fold * 0.35);
      }
    }
    b.bakeRegionNormals(2.8, false);
  }

  // Hanging Cage (24x36)
  b.alloc('prop:cage', 24, 36, 0.5, 0.0);
  b.rect(11, 0, 2, 8, ironMid, 0.8);
  b.rect(4, 8, 16, 3, ironHi, 0.88, 1);
  b.rect(4, 31, 16, 3, ironHi, 0.88, 1);
  for (const bx of [5, 9, 14, 18]) {
    b.rect(bx, 11, 2, 20, ironMid, 0.82);
  }
  // Skull inside cage
  b.ellipse(12, 27, 3.2, 3.2, hexRgb('#d9d2c1'), 0.8, 0.2);
  b.pxRgb(11, 27, hexRgb('#1a141e'), 0.2);
  b.pxRgb(13, 27, hexRgb('#1a141e'), 0.2);
  b.bakeRegionNormals(3.0, false);

  // Fallen Dungeon Warrior Remains (28x20) — weathered muted bone, ribcage, tattered cloak & rusted sword
  b.alloc('prop:skeleton', 28, 20, 0.5, 1.0);
  const boneHiSk = hexRgb('#a89f8d');
  const boneSk = hexRgb('#7d7567');
  const boneDarkSk = hexRgb('#47423c');
  const cloakTatter = hexRgb('#4d1c28');
  const cloakSh = hexRgb('#261019');
  // Tattered cloth mound & weathered ribcage
  b.polygon([[3, 19], [7, 13], [19, 13], [24, 19]], cloakSh, 0.52, 0.16);
  b.polygon([[6, 18], [9, 13], [16, 14], [19, 18]], cloakTatter, 0.64, 0.14);
  for (let r = 0; r < 3; r++) {
    b.line(11 + r * 2, 13, 12 + r * 2, 17, boneSk, 1.3, 0.78);
  }
  // Weathered shaded skull resting cleanly against rubble
  b.ellipse(8, 12.5, 3.2, 3.0, boneSk, 0.82, 0.18);
  b.ellipse(7.4, 11.4, 1.8, 1.4, boneHiSk, 0.88, 0.12);
  b.pxRgb(7, 13, hexRgb('#15111c'), 0.18);
  b.pxRgb(9, 13, hexRgb('#15111c'), 0.18);
  b.pxRgb(8, 15, boneDarkSk, 0.35);
  // Broken rusted blade & parchment lore scroll beside remains
  b.line(18, 17, 25, 11, ironMid, 1.6, 0.84);
  b.pxRgb(20, 15, goldDark, 0.9);
  b.rect(17, 16, 5, 3, hexRgb('#9e8c68'), 0.78);
  b.addOutline([12, 10, 18]);
  b.bakeRegionNormals(2.9, false);

  // Doors (wood, wood_open, gold, exit, boss)
  const oak = hexRgb('#6e462c');
  const oakHi = hexRgb('#9e6842');
  b.alloc('prop:door_wood', 16, 48, 0.5, 1.0);
  b.rect(2, 2, 12, 46, oak, 0.72, 2);
  for (let x = 5; x <= 11; x += 3) b.line(x, 3, x, 46, hexRgb('#3d2517'), 1, 0.45);
  b.rect(2, 10, 12, 3, ironHi, 0.92, 1);
  b.rect(2, 34, 12, 3, ironHi, 0.92, 1);
  b.rect(10, 22, 3, 4, goldHi, 0.95);
  b.bakeRegionNormals(3.4, false);

  b.alloc('prop:door_wood_open', 16, 48, 0.5, 1.0);
  b.rect(1, 0, 3, 48, oakHi, 0.78, 1);
  b.rect(12, 0, 3, 48, oak, 0.78, 1);
  b.rect(1, 0, 14, 4, ironMid, 0.85, 1);
  b.bakeRegionNormals(2.8, false);

  b.alloc('prop:door_gold', 20, 52, 0.5, 1.0);
  b.rect(2, 2, 16, 50, goldDark, 0.78, 2);
  b.rect(4, 5, 12, 44, goldMid, 0.85, 1);
  b.ellipse(10, 24, 4.2, 5.2, goldHi, 0.95, 0.05, hexRgb('#ffe875'), 210);
  b.bakeRegionNormals(3.4, false);

  b.alloc('prop:door_exit', 32, 56, 0.5, 1.0);
  // Towering gothic stone archway with glowing cyan-violet mist portal
  const portalCyan = hexRgb('#4ee8ff');
  const portalDeep = hexRgb('#193366');
  b.rect(2, 12, 28, 44, ironMid, 0.75, 2);
  b.ellipse(16, 16, 14, 14, ironHi, 0.82, 0.15);
  b.rect(7, 18, 18, 38, portalDeep, 0.25, 0, portalDeep, 160);
  b.ellipse(16, 20, 9, 10, portalDeep, 0.25, 0.05, portalCyan, 190);
  b.ellipse(16, 34, 6, 16, portalCyan, 0.3, 0.05, portalCyan, 245);
  b.bakeRegionNormals(3.2, false);

  b.alloc('prop:door_boss', 24, 56, 0.5, 1.0);
  b.rect(2, 2, 20, 54, hexRgb('#2a1d2b'), 0.75, 2);
  for (const bx of [5, 11, 17]) b.rect(bx, 4, 2, 50, ironHi, 0.9);
  b.ellipse(12, 26, 5, 6, hexRgb('#ff3b3b'), 0.92, 0.08, hexRgb('#ff4422'), 235);
  b.bakeRegionNormals(3.4, false);

  // Treasure Chests (normal, cursed, boss — closed & open)
  const paintChest = (key: string, w: number, h: number, body: RGB, trim: RGB, glow: RGB, open: boolean, cursed: boolean): void => {
    b.alloc(key, w, h, 0.5, 1.0);
    const topY = open ? 8 : 5;
    b.rect(3, topY + 6, w - 6, h - topY - 7, body, 0.75, 2);
    b.rect(2, topY, w - 4, 7, open ? scaleRgb(body, 0.7) : scaleRgb(body, 1.1), 0.85, 1);
    b.rect(2, topY + 5, w - 4, 2, trim, 0.94);
    b.rect(Math.floor(w / 2) - 2, topY + 4, 4, 5, trim, 0.98, 0, glow, open ? 240 : 140);
    if (open) {
      b.rect(5, topY + 2, w - 10, 4, glow, 0.9, 0, glow, 245);
    }
    if (cursed) {
      // Glowing demonic eyes on cursed chest!
      b.ellipse(w * 0.34, topY + 10, 2.2, 2.0, glow, 0.95, 0.05, glow, 255);
      b.ellipse(w * 0.66, topY + 10, 2.2, 2.0, glow, 0.95, 0.05, glow, 255);
    }
    b.addOutline();
    b.bakeRegionNormals(3.4, false);
  };

  paintChest('prop:chest_closed', 28, 22, oak, goldMid, goldHi, false, false);
  paintChest('prop:chest_open', 28, 22, oak, goldMid, goldHi, true, false);
  paintChest('prop:chest_cursed_closed', 30, 26, hexRgb('#2d1a38'), hexRgb('#75309e'), hexRgb('#ff3366'), false, true);
  paintChest('prop:chest_cursed_open', 30, 26, hexRgb('#2d1a38'), hexRgb('#75309e'), hexRgb('#ff3366'), true, true);
  paintChest('prop:chest_boss_closed', 34, 26, hexRgb('#6e2330'), goldHi, hexRgb('#ffe875'), false, false);
  paintChest('prop:chest_boss_open', 34, 26, hexRgb('#6e2330'), goldHi, hexRgb('#ffe875'), true, false);

  // Teleporter Rune Monolith (idle & active, 28x44)
  for (const active of [false, true]) {
    b.alloc(active ? 'prop:teleporter_active' : 'prop:teleporter_idle', 28, 44, 0.5, 1.0);
    b.rect(6, 36, 16, 8, ironMid, 0.85, 2);
    b.rect(8, 10, 12, 26, hexRgb('#353d54'), 0.78, 2);
    b.ellipse(14, 10, 6, 7, hexRgb('#4a5473'), 0.82, 0.15);
    const crys = active ? hexRgb('#52f2ff') : hexRgb('#7a55bd');
    const emA = active ? 255 : 150;
    // Floating rune crystal
    b.ellipse(14, 20, 3.6, 7.2, crys, 0.95, 0.05, crys, emA);
    b.pxRgb(14, 18, [255, 255, 255], 1.0, [255, 255, 255], emA);
    b.addOutline();
    b.bakeRegionNormals(3.2, false);
  }

  // Health Fountain (full & empty, 44x36)
  for (const full of [true, false]) {
    b.alloc(full ? 'prop:fountain_full' : 'prop:fountain_empty', 44, 36, 0.5, 1.0);
    b.rect(6, 22, 32, 14, hexRgb('#67738a'), 0.82, 2);
    b.rect(16, 8, 12, 16, hexRgb('#7a87a1'), 0.85, 2);
    b.ellipse(22, 10, 8, 4, hexRgb('#95a3bd'), 0.9, 0.1);
    if (full) {
      const heal = hexRgb('#42f59b');
      const healHi = hexRgb('#b8ffe0');
      b.rect(19, 10, 6, 14, heal, 0.88, 0, heal, 235);
      b.rect(9, 21, 26, 4, healHi, 0.92, 0, heal, 245);
    }
    b.addOutline();
    b.bakeRegionNormals(3.2, false);
  }

  // Scroll Altar & Challenge Rift
  b.alloc('prop:scroll_altar', 24, 34, 0.5, 1.0);
  b.rect(5, 20, 14, 14, hexRgb('#69718a'), 0.82, 2);
  b.rect(3, 18, 18, 4, hexRgb('#9aa5c4'), 0.9, 1);
  b.rect(9, 6, 6, 9, hexRgb('#ffe8a3'), 0.92, 1, hexRgb('#ffd452'), 230);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('prop:challenge_rift', 28, 36, 0.5, 1.0);
  const riftCol = hexRgb('#c44dff');
  const riftCore = hexRgb('#ff8ce8');
  b.ellipse(14, 20, 8, 13, riftCol, 0.85, 0.15, riftCol, 240);
  b.ellipse(14, 20, 3.5, 8, riftCore, 0.95, 0.05, riftCore, 255);
  b.bakeRegionNormals(2.4, false);

  // Passage NPCs: Collector, Guillain, Blacksmith Forge
  b.alloc('prop:npc_collector', 34, 44, 0.5, 1.0);
  b.ellipse(16, 28, 10, 14, hexRgb('#2e334d'), 0.78, 0.22); // robe
  b.ellipse(16, 11, 7, 8, hexRgb('#3d4363'), 0.86, 0.14); // deep hood
  b.pxRgb(14, 12, hexRgb('#4ee8ff'), 0.95, hexRgb('#4ee8ff'), 255);
  b.pxRgb(18, 12, hexRgb('#4ee8ff'), 0.95, hexRgb('#4ee8ff'), 255);
  // Giant glowing cell syringe on back!
  b.line(22, 6, 29, 28, hexRgb('#4ee8ff'), 4, 0.92, hexRgb('#4ee8ff'), 240);
  b.line(21, 5, 23, 9, goldHi, 3, 0.95);
  b.addOutline();
  b.bakeRegionNormals(3.2, false);

  b.alloc('prop:npc_guillain', 26, 32, 0.5, 1.0);
  b.ellipse(13, 21, 8, 9, hexRgb('#3a4f45'), 0.78, 0.22);
  b.ellipse(12, 10, 5.5, 5.5, hexRgb('#537364'), 0.86, 0.14);
  b.pxRgb(14, 10, hexRgb('#62ff9e'), 0.95, hexRgb('#62ff9e'), 255);
  // Glowing emerald mutation vial
  b.ellipse(20, 19, 3.2, 4.0, hexRgb('#52ff91'), 0.92, 0.08, hexRgb('#52ff91'), 245);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('prop:npc_forge', 38, 40, 0.5, 1.0);
  b.rect(4, 22, 16, 18, hexRgb('#474d5e'), 0.82, 2); // stone hearth
  b.ellipse(12, 21, 6, 5, flameOrg, 0.9, 0.1, flameOrg, 250);
  // Anvil + Blacksmith silhouette
  b.rect(22, 29, 13, 5, ironHi, 0.92, 1);
  b.rect(25, 34, 7, 6, ironDark, 0.85);
  b.ellipse(28, 18, 6.5, 9, hexRgb('#693f32'), 0.82, 0.18);
  b.ellipse(28, 8, 4.5, 4.5, hexRgb('#d9a882'), 0.88, 0.12);
  b.addOutline();
  b.bakeRegionNormals(3.2, false);

  // ===========================================================================
  // Rich Architectural Dungeon Props (Paired Normal + Emissive Maps)
  // ===========================================================================

  // 1. Reinforced Wooden Supply Crate (24x22)
  b.alloc('prop:crate', 24, 22, 0.5, 1.0);
  const crateDark = hexRgb('#472c1c');
  const crateMid = hexRgb('#754a2e');
  const crateHi = hexRgb('#a86e46');
  b.rect(2, 2, 20, 19, crateMid, 0.72, 2);
  // Horizontal plank seams & wood grain
  for (let y = 3; y < 20; y++) {
    for (let x = 3; x < 21; x++) {
      const g = hash2(x, y, 401);
      if (y === 8 || y === 14) {
        b.pxRgb(x, y, crateDark, 0.32);
      } else {
        b.pxRgb(x, y, scaleRgb(y < 8 ? crateHi : crateMid, 0.88 + g * 0.2), 0.74 + g * 0.08);
      }
    }
  }
  // Diagonal cross-brace & outer timber frame
  b.line(4, 18, 19, 4, crateHi, 3, 0.86);
  b.line(4, 19, 20, 5, crateDark, 1, 0.52);
  b.rect(2, 2, 20, 3, crateHi, 0.88, 1);
  b.rect(2, 18, 20, 3, crateDark, 0.84, 1);
  b.rect(2, 2, 3, 19, crateHi, 0.86, 1);
  b.rect(19, 2, 3, 19, crateDark, 0.84, 1);
  // Iron corner brackets & nails
  for (const [bx, by] of [[2, 2], [18, 2], [2, 17], [18, 17]] as const) {
    b.rect(bx, by, 4, 4, ironMid, 0.94, 1);
    b.pxRgb(bx + 1, by + 1, ironHi, 0.98);
  }
  b.addOutline([14, 11, 20]);
  b.bakeRegionNormals(3.5, false);

  // 2. Iron-Banded Oak Dungeon Barrel (20x24) — cylindrical horizontal normals!
  b.alloc('prop:barrel', 20, 24, 0.5, 1.0);
  for (let y = 2; y < 23; y++) {
    const vNorm = (y - 12.5) / 10.5;
    const bulge = Math.sqrt(Math.max(0.15, 1 - vNorm * vNorm * 0.42));
    const halfW = Math.round(7.4 * bulge);
    const isHoop = y === 6 || y === 7 || y === 17 || y === 18;
    const isRim = y === 2 || y === 3 || y === 21 || y === 22;
    for (let dx = -halfW; dx <= halfW; dx++) {
      const x = 10 + dx;
      const u = dx / Math.max(1, halfW); // -1..1
      const nz = Math.sqrt(Math.max(0.12, 1 - u * u * 0.82));
      const staveSeam = !isHoop && (Math.abs(dx) === 3 || dx === 0);
      const shade = 0.58 + nz * 0.5 + (u < -0.15 ? 0.1 : -0.06);
      let col: RGB;
      if (isHoop) {
        col = scaleRgb(y === 6 || y === 17 ? ironHi : ironDark, shade);
      } else if (isRim) {
        col = scaleRgb(crateDark, shade);
      } else if (staveSeam) {
        col = scaleRgb(crateDark, 0.72);
      } else {
        const g = hash2(x, y, 509);
        col = scaleRgb(mixRgb(crateMid, crateHi, 0.25 + g * 0.25), shade);
      }
      b.pxRgb(x, y, col, isHoop ? 0.92 : staveSeam ? 0.48 : 0.78);
      b.setNormalDirect(x, y, u * 0.88, isHoop ? -0.18 : vNorm * 0.22, nz);
    }
  }
  // Wooden bung plug + rivets on hoops
  b.ellipse(10, 12, 1.6, 1.6, crateDark, 0.85, 0.12);
  b.pxRgb(6, 6, ironHi, 0.98);
  b.pxRgb(14, 6, ironHi, 0.98);
  b.pxRgb(6, 17, ironHi, 0.98);
  b.pxRgb(14, 17, ironHi, 0.98);
  b.addOutline([14, 11, 20]);

  // 3. Gothic Skull Pile (26x16) — bone cluster with hollow sockets & eerie faint soul sheen
  b.alloc('prop:skull_pile', 26, 16, 0.5, 1.0);
  const boneHi = hexRgb('#eee7d6');
  const boneMid = hexRgb('#bfb6a1');
  const boneSh = hexRgb('#6e665a');
  const socketCol = hexRgb('#14101c');
  const soulWisp = hexRgb('#5be0ff');
  // Base bone rubble & rib fragments
  b.polygon([[2, 15], [7, 10], [19, 10], [24, 15]], boneSh, 0.55, 0.18);
  b.line(3, 14, 11, 11, boneMid, 2, 0.72);
  b.line(15, 11, 23, 14, boneMid, 2, 0.72);
  // Left skull (tilted)
  b.ellipse(8, 10, 4.0, 3.6, boneMid, 0.78, 0.2);
  b.ellipse(7.5, 9, 2.5, 2.0, boneHi, 0.88, 0.12);
  b.pxRgb(6, 10, socketCol, 0.2);
  b.pxRgb(9, 10, socketCol, 0.2);
  // Right skull
  b.ellipse(18, 10.5, 3.8, 3.4, boneMid, 0.78, 0.2);
  b.ellipse(17.5, 9.5, 2.2, 1.8, boneHi, 0.86, 0.12);
  b.pxRgb(16, 11, socketCol, 0.2);
  b.pxRgb(19, 11, socketCol, 0.2);
  // Top hero skull crowning pile
  b.ellipse(13, 6.2, 4.3, 3.8, boneHi, 0.86, 0.22);
  b.rect(10, 9, 6, 3, boneMid, 0.8);
  b.rect(10, 6, 2, 2, socketCol, 0.15);
  b.rect(14, 6, 2, 2, socketCol, 0.15);
  // Faint haunting cyan pinhole glow in upper skull eye socket
  b.pxRgb(11, 6, soulWisp, 0.9, soulWisp, 165);
  b.pxRgb(14, 6, soulWisp, 0.9, soulWisp, 165);
  b.pxRgb(12, 10, socketCol, 0.25);
  b.pxRgb(14, 10, socketCol, 0.25);
  b.addOutline([14, 10, 18]);
  b.bakeRegionNormals(3.3, false);

  // 4. Hanging Gothic Iron Lanterns (3 animated sway/flicker frames, 16x28)
  for (let f = 0; f < 3; f++) {
    b.alloc(`prop:lantern_${f}`, 16, 28, 0.5, 0.0);
    const sway = f === 0 ? -1 : f === 2 ? 1 : 0;
    const cx = 8 + sway;
    // Ceiling mounting ring & chain links
    b.rect(7, 0, 2, 3, ironHi, 0.88);
    b.line(8, 2, cx, 10, ironMid, 1.5, 0.84);
    // Pointed gothic lantern hood
    b.polygon([[cx, 8], [cx + 5, 13], [cx - 5, 13]], ironHi, 0.9, 0.14);
    b.rect(cx - 5, 12, 10, 2, ironDark, 0.86);
    // Glowing amber-gold glass chamber
    const pulse = f === 1 ? 1.0 : 0.88;
    const glassMid = scaleRgb(flameOrg, pulse);
    const glassCore = scaleRgb(flameYel, pulse);
    b.rect(cx - 3, 14, 7, 9, flameRed, 0.78, 0, flameRed, 220);
    b.rect(cx - 2, 15, 5, 7, glassMid, 0.86, 0, glassMid, 245);
    b.ellipse(cx, 18.5, 1.6, 2.4, glassCore, 0.96, 0.04, glassCore, 255);
    // Forged iron cage bars framing the glass
    b.rect(cx - 4, 14, 1, 9, ironDark, 0.92);
    b.rect(cx + 4, 14, 1, 9, ironDark, 0.92);
    b.rect(cx, 14, 1, 9, ironDark, 0.9);
    // Tapered finial base
    b.rect(cx - 4, 23, 9, 2, ironHi, 0.9);
    b.polygon([[cx - 2, 25], [cx + 3, 25], [cx, 27]], ironMid, 0.85, 0.1);
    b.addOutline([12, 10, 18]);
    b.bakeRegionNormals(3.1, false);
  }

  // 5. Overhanging Lush Dungeon Moss Cap (24x10) — organic dark-emerald tufts (NO bright repeating dots!)
  b.alloc('prop:moss_cap', 24, 10, 0.5, 0.0);
  const mossDeep = hexRgb('#112e1d');
  const mossMid = hexRgb('#1f5432');
  const mossHi = hexRgb('#377a47');
  for (let x = 0; x < 24; x++) {
    const wave = Math.sin(x * 0.62) * 1.8 + Math.cos(x * 1.35) * 1.2;
    const len = Math.max(2, Math.min(8, Math.round(3.8 + wave + hash2(x, 1, 711) * 2.2)));
    for (let y = 0; y < len; y++) {
      const g = hash2(x, y, 719);
      const col = y === 0 ? mossHi : y < len - 1 ? mossMid : mossDeep;
      b.pxRgb(x, y, scaleRgb(col, 0.86 + g * 0.22), 0.78 - y * 0.06);
    }
  }
  b.bakeRegionNormals(2.4, false);

  // 6. Ornate Fluted Gothic Pillar (24x48) — carved capital, gilded rings & cylindrical normals!
  b.alloc('prop:pillar_ornate', 24, 48, 0.5, 1.0);
  const colDark = hexRgb('#2a3044');
  const colMid = hexRgb('#535d78');
  const colHi = hexRgb('#8795b8');
  // Carved capital (y=0..8) & stepped plinth base (y=40..47)
  b.rect(1, 0, 22, 4, colHi, 0.92, 1);
  b.rect(3, 4, 18, 4, colMid, 0.88, 1);
  b.rect(4, 8, 16, 2, goldMid, 0.95);
  b.rect(4, 38, 16, 2, goldMid, 0.95);
  b.rect(3, 40, 18, 4, colMid, 0.88, 1);
  b.rect(1, 44, 22, 4, colDark, 0.92, 1);
  b.bakeRegionNormals(3.2, false);
  // Fluted cylindrical shaft (y=10..37) with genuine cylindrical normals!
  for (let y = 10; y < 38; y++) {
    const isBand = y === 23 || y === 24;
    for (let x = 5; x < 19; x++) {
      const u = ((x - 5) / 13) * 2 - 1;
      const flute = Math.sin((x - 5) * 1.7) * 0.16;
      const nx = Math.max(-0.92, Math.min(0.92, u * 0.86 + flute));
      const nz = Math.sqrt(Math.max(0.08, 1 - nx * nx));
      const g = hash2(x, y, 823);
      const shade = 0.62 + nz * 0.44 + (g - 0.5) * 0.08;
      const base = isBand ? goldMid : flute > 0.06 ? colHi : colMid;
      b.pxRgb(x, y, scaleRgb(base, shade), 0.78);
      b.setNormalDirect(x, y, nx, isBand ? -0.15 : 0, nz);
    }
  }
  // Subtle gothic rune etched in center band
  b.pxRgb(11, 23, hexRgb('#52e8ff'), 0.95, hexRgb('#52e8ff'), 160);
  b.pxRgb(12, 24, hexRgb('#52e8ff'), 0.95, hexRgb('#52e8ff'), 160);

  // 7. Forged Iron Dungeon Chain & Hook (14x34)
  b.alloc('prop:chain_hook', 14, 34, 0.5, 0.0);
  // 4 forged iron chain links
  for (let link = 0; link < 4; link++) {
    const ly = link * 5 + 1;
    if (link % 2 === 0) {
      b.rect(5, ly, 4, 5, ironMid, 0.85);
      b.pxRgb(5, ly, ironHi, 0.94);
      b.pxRgb(6, ly, ironHi, 0.94);
      b.rect(6, ly + 1, 2, 3, ironDark, 0.35);
    } else {
      b.rect(6, ly, 2, 5, ironHi, 0.94);
      b.pxRgb(7, ly + 3, ironDark, 0.72);
    }
  }
  // Swivel collar + curved barbed dungeon hook
  b.rect(5, 20, 4, 3, ironHi, 0.92);
  b.line(7, 23, 7, 28, ironMid, 2.5, 0.9);
  b.line(7, 28, 10, 31, ironHi, 2.2, 0.94);
  b.line(10, 31, 11, 27, hexRgb('#cfd9eb'), 1.8, 0.96);
  b.pxRgb(11, 26, hexRgb('#c72a3c'), 0.98); // dried crimson glint on hook barb
  b.addOutline([12, 10, 18]);
  b.bakeRegionNormals(3.4, false);

  // ===========================================================================
  // Biome-Distinct Architectural Props + Shop Stall, Merchant & Recycling Tube
  // ===========================================================================
  paintBiomeAndShopProps(b);
}

function paintBiomeAndShopProps(b: PixelAtlasBuilder): void {
  const ironVoid = hexRgb('#151926');
  const ironDark = hexRgb('#2a2e3d');
  const ironMid = hexRgb('#525a70');
  const ironHi = hexRgb('#8d99b8');
  const ironSpec = hexRgb('#c6d2eb');
  const goldDark = hexRgb('#7d5518');
  const goldMid = hexRgb('#d49e32');
  const goldHi = hexRgb('#ffe885');
  const woodDark = hexRgb('#382215');
  const woodMid = hexRgb('#694128');
  const woodHi = hexRgb('#9c6640');
  const crimsonDark = hexRgb('#5e101d');
  const crimson = hexRgb('#a81c30');
  const crimsonHi = hexRgb('#e6354c');
  const cyanGlow = hexRgb('#4ee8ff');
  const emeraldGlow = hexRgb('#4dff88');
  const acidGlow = hexRgb('#8cff38');
  const amberGlow = hexRgb('#ffa834');
  const flameCore = hexRgb('#fff4a8');

  // 1. Prisoners' Quarters Hanging Glass Specimen/Weapon Jars (42x46, ceiling-hung!)
  b.alloc('prop:prison_jars', 42, 46, 0.5, 0.0);
  // Horizontal iron ceiling crossbar
  b.rect(2, 1, 38, 3, ironMid, 0.9, 1);
  b.line(3, 1, 38, 1, ironHi, 1, 0.96);
  const jars: ReadonlyArray<{ cx: number; topY: number; w: number; h: number; liquid: RGB; em: RGB }> = [
    { cx: 9, topY: 11, w: 10, h: 16, liquid: hexRgb('#2299b8'), em: cyanGlow },
    { cx: 21, topY: 17, w: 12, h: 20, liquid: hexRgb('#2d9e58'), em: emeraldGlow },
    { cx: 33, topY: 9, w: 10, h: 17, liquid: hexRgb('#a8263b'), em: hexRgb('#ff4f66') },
  ];
  for (const jar of jars) {
    // Iron suspension chain
    for (let cy = 4; cy < jar.topY; cy += 2) {
      b.pxRgb(jar.cx, cy, ironHi, 0.9);
      b.pxRgb(jar.cx + (cy % 4 === 0 ? 1 : -1), cy + 1, ironDark, 0.72);
    }
    const hw = Math.floor(jar.w / 2);
    // Forged metal lid & neck
    b.rect(jar.cx - hw + 2, jar.topY, jar.w - 4, 3, ironHi, 0.94, 1);
    // Glass cylinder body
    const bodyY = jar.topY + 3;
    const bodyH = jar.h - 3;
    for (let y = 0; y < bodyH; y++) {
      for (let dx = -hw; dx <= hw; dx++) {
        const edge = Math.abs(dx) === hw || y === bodyH - 1;
        const inLiquid = y >= Math.floor(bodyH * 0.34);
        if (edge) {
          b.pxRgb(jar.cx + dx, bodyY + y, hexRgb('#799cb8'), 0.85);
        } else if (inLiquid) {
          const isBubble = (dx === -1 && y === bodyH - 5) || (dx === 1 && y === bodyH - 8);
          const col = isBubble ? [240, 255, 255] as const : mixRgb(jar.liquid, jar.em, y < bodyH * 0.5 ? 0.55 : 0.25);
          b.pxRgb(jar.cx + dx, bodyY + y, col, 0.82, jar.em, isBubble ? 245 : 165);
        } else {
          b.px(jar.cx + dx, bodyY + y, 42, 62, 86, 175, 0.65);
        }
      }
    }
    // Crisp specular glass highlight stripe down left side
    b.line(jar.cx - hw + 2, bodyY + 2, jar.cx - hw + 2, bodyY + bodyH - 3, [230, 248, 255], 1, 0.96, [210, 245, 255], 130);
    // Iron base ring
    b.rect(jar.cx - hw + 1, bodyY + bodyH - 1, jar.w - 1, 2, ironDark, 0.88);
  }
  b.addOutline([10, 10, 18]);
  b.bakeRegionNormals(3.1, false);

  // 2. Recessed Barred Prison Cell Window (36x48)
  b.alloc('prop:iron_cell_bars', 36, 48, 0.5, 1.0);
  const stDark = hexRgb('#1f2636');
  const stMid = hexRgb('#3a455e');
  const stHi = hexRgb('#627296');
  const moonHaze = hexRgb('#446b94');
  // Outer gothic stone frame & sill
  b.rect(2, 16, 32, 30, stMid, 0.8, 2);
  b.ellipse(18, 17, 16, 15, stMid, 0.84, 0.14);
  b.rect(0, 44, 36, 4, stHi, 0.92, 1);
  // Dark arched window recess + pale cool moonlight glow in upper panes
  for (let y = 6; y < 44; y++) {
    for (let x = 7; x <= 28; x++) {
      const dx = (x - 17.5) / 10.5;
      const dy = (y - 17.5) / 11.5;
      const inArch = y >= 17 || dx * dx + dy * dy <= 1.0;
      if (!inArch) continue;
      const moonMask = Math.max(0, 1 - (y - 6) / 30) * (1 - Math.abs((x - 15) / 16));
      if (moonMask > 0.28) {
        const col = mixRgb(ironVoid, moonHaze, moonMask * 0.72);
        b.pxRgb(x, y, col, 0.18, moonHaze, clampByte(moonMask * 115));
      } else {
        b.pxRgb(x, y, hexRgb('#0c101c'), 0.08);
      }
    }
  }
  // Vertical forged iron bars + cross-transom with rivets
  for (const bx of [10, 15, 20, 25]) {
    b.rect(bx, 6, 2, 38, ironDark, 0.9);
    b.line(bx, 7, bx, 43, ironHi, 1, 0.96);
  }
  b.rect(7, 22, 22, 2, ironMid, 0.94);
  b.rect(7, 34, 22, 2, ironMid, 0.94);
  for (const bx of [10, 15, 20, 25]) {
    b.pxRgb(bx, 22, ironSpec, 0.98);
    b.pxRgb(bx, 34, ironSpec, 0.98);
  }
  b.addOutline([10, 10, 18]);
  b.bakeRegionNormals(3.2, false);

  // 3. Promenade Gnarled Dead Tree Silhouette (56x74)
  b.alloc('prop:dead_tree', 56, 74, 0.5, 1.0);
  const barkVoid = hexRgb('#18131c');
  const barkDark = hexRgb('#2e252b');
  const barkMid = hexRgb('#4c3d42');
  const barkHi = hexRgb('#756168');
  const mossDrape = hexRgb('#2a5c3d');
  const mossTip = hexRgb('#49945b');
  // Gnarled roots & curving trunk
  b.polygon([[14, 73], [22, 62], [35, 62], [44, 73], [36, 73], [29, 66], [21, 73]], barkDark, 0.75, 0.2);
  b.polygon([[22, 66], [21, 46], [24, 29], [32, 30], [34, 48], [35, 66]], barkMid, 0.82, 0.2);
  b.line(23, 64, 25, 31, barkHi, 2, 0.92);
  b.line(31, 63, 30, 36, barkVoid, 1.5, 0.45);
  // Crooked asymmetric branches fanning upward
  b.line(24, 34, 11, 21, barkMid, 4.2, 0.85);
  b.line(11, 21, 4, 14, barkDark, 2.5, 0.8);
  b.line(13, 22, 14, 9, barkHi, 2.2, 0.86);
  b.line(28, 30, 26, 12, barkMid, 3.8, 0.86);
  b.line(26, 12, 20, 3, barkHi, 2.0, 0.88);
  b.line(27, 15, 34, 5, barkDark, 2.2, 0.82);
  b.line(32, 35, 45, 22, barkMid, 4.0, 0.86);
  b.line(45, 22, 53, 15, barkHi, 2.2, 0.88);
  b.line(42, 25, 47, 31, barkDark, 2.0, 0.78);
  // Eerie hanging twilight moss wisps draped from limbs
  for (const [mx, my, ml] of [[8, 19, 10], [15, 16, 12], [23, 11, 9], [41, 25, 13], [49, 19, 9]] as const) {
    for (let dy = 0; dy < ml; dy++) {
      const sway = Math.round(Math.sin(dy * 0.55) * 1.0);
      b.pxRgb(mx + sway, my + dy, dy < 3 ? mossTip : mossDrape, 0.78 - dy * 0.03);
      if (dy < ml - 3) b.pxRgb(mx + sway + 1, my + dy, mossDrape, 0.7);
    }
  }
  b.addOutline([10, 9, 16]);
  b.bakeRegionNormals(3.1, false);

  // 4. Promenade / Ramparts Hanging Gibbet Cage (28x52, ceiling-hung!)
  b.alloc('prop:gibbet_cage', 28, 52, 0.5, 0.0);
  // Heavy rusted hanging chain
  for (let y = 0; y < 14; y += 3) {
    b.rect(13, y, 2, 3, y % 6 === 0 ? ironHi : ironMid, 0.88);
  }
  // Conical top iron suspension ring & ribs
  b.polygon([[14, 13], [23, 21], [5, 21]], ironMid, 0.86, 0.14);
  b.rect(5, 20, 18, 3, ironHi, 0.94, 1);
  b.rect(5, 33, 18, 2, ironMid, 0.9);
  b.rect(6, 46, 16, 3, ironHi, 0.92, 1);
  // Vertical rusted cage ribs
  for (const bx of [6, 10, 14, 18, 21]) {
    b.rect(bx, 22, 2, 24, bx === 6 || bx === 21 ? ironHi : ironMid, 0.86);
  }
  // Weathered skull & drooping crimson rag inside gibbet
  b.polygon([[11, 35], [17, 36], [19, 49], [14, 47], [11, 51]], crimsonDark, 0.76, 0.12);
  b.line(12, 36, 13, 48, crimson, 1.2, 0.82);
  b.ellipse(14, 41, 3.6, 3.4, hexRgb('#cfc5b0'), 0.86, 0.16);
  b.pxRgb(13, 41, ironVoid, 0.18);
  b.pxRgb(16, 41, ironVoid, 0.18);
  b.addOutline([10, 9, 16]);
  b.bakeRegionNormals(3.3, false);

  // 5. Toxic Sewers Acid Outflow Grate (38x38)
  b.alloc('prop:sewer_grate', 38, 38, 0.5, 0.5);
  const bronzeDark = hexRgb('#2a3629');
  const bronzeMid = hexRgb('#4e6649');
  const bronzeHi = hexRgb('#7ca173');
  b.ellipse(19, 18, 17, 17, bronzeDark, 0.82, 0.18);
  b.ellipse(19, 18, 15.5, 15.5, bronzeMid, 0.88, 0.14);
  b.ellipse(19, 18, 11.5, 11.5, hexRgb('#0a120b'), 0.12, 0.04);
  // Rivets around pipe flange
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.ellipse(19 + Math.cos(a) * 13.5, 18 + Math.sin(a) * 13.5, 1.3, 1.3, bronzeHi, 0.96, 0.04);
  }
  // Crossed iron culvert grate bars
  for (const offset of [-6, 0, 6]) {
    b.rect(18 + offset, 7, 2, 22, ironMid, 0.86);
    b.rect(8, 17 + offset, 22, 2, ironDark, 0.82);
  }
  // Glowing toxic emerald slime waterfall dripping out bottom lip!
  b.rect(13, 25, 12, 4, hexRgb('#49b81d'), 0.85, 0, acidGlow, 210);
  b.line(15, 27, 15, 36, acidGlow, 2.2, 0.92, acidGlow, 245);
  b.line(20, 26, 20, 34, hexRgb('#5be028'), 2.0, 0.9, acidGlow, 225);
  b.line(23, 27, 23, 37, acidGlow, 1.6, 0.92, acidGlow, 240);
  b.addOutline([8, 14, 10]);
  b.bakeRegionNormals(3.3, false);

  // 6. Toxic Sewers Riveted Pipe & Crimson Wheel Valve (34x36)
  b.alloc('prop:pipe_valve', 34, 36, 0.5, 0.5);
  const copperDark = hexRgb('#3d2c24');
  const copperMid = hexRgb('#7a533b');
  const copperHi = hexRgb('#ba865c');
  // Horizontal cylindrical conduit pipe + flanged vertical joint
  for (let y = 12; y <= 23; y++) {
    const v = (y - 17.5) / 5.5;
    const nz = Math.sqrt(Math.max(0.15, 1 - v * v * 0.8));
    const shade = 0.58 + nz * 0.48 + (v < 0 ? 0.14 : -0.1);
    for (let x = 1; x <= 32; x++) {
      b.pxRgb(x, y, scaleRgb(copperMid, shade), 0.72 + nz * 0.24);
      b.setNormalDirect(x, y, 0, v * 0.85, nz);
    }
  }
  // Bolted pipe flanges
  for (const fx of [3, 28]) {
    b.rect(fx, 10, 4, 16, copperHi, 0.94, 1);
    b.pxRgb(fx + 1, 12, ironSpec, 0.98);
    b.pxRgb(fx + 1, 23, ironSpec, 0.98);
  }
  // Valve stem + bright crimson spoked wheel valve
  b.rect(15, 6, 4, 9, ironMid, 0.88);
  b.ellipse(17, 17, 8.5, 8.5, crimsonDark, 0.92, 0.08);
  b.ellipse(17, 17, 7.2, 7.2, crimson, 0.95, 0.08);
  b.ellipse(17, 17, 4.5, 4.5, copperDark, 0.4, 0.05);
  b.line(10, 17, 24, 17, crimsonHi, 2, 0.96);
  b.line(17, 10, 17, 24, crimsonHi, 2, 0.96);
  b.ellipse(17, 17, 2.2, 2.2, goldHi, 0.98, 0.04);
  // Subtle acid drip beneath pipe
  b.ellipse(11, 27, 1.8, 3.2, acidGlow, 0.9, 0.1, acidGlow, 235);
  b.addOutline([10, 10, 14]);
  b.bakeRegionNormals(3.2, false);

  // 7. Ramparts Animated Tattered Wind Banner (3 frames, 26x44)
  for (let f = 0; f < 3; f++) {
    b.alloc(`prop:wind_banner_${f}`, 26, 44, 0.5, 0.0);
    // Forged iron wall bracket + pike pole
    b.rect(2, 2, 3, 40, ironMid, 0.9, 1);
    b.line(2, 2, 2, 41, ironHi, 1, 0.96);
    b.rect(2, 4, 21, 3, goldMid, 0.94, 1);
    b.pxRgb(23, 5, goldHi, 0.98);
    // Whipping crimson heraldic tapestry with torn forked tails
    const phase = f * 2.1;
    for (let y = 7; y < 42; y++) {
      const wave = Math.round(Math.sin(y * 0.24 + phase) * (1.2 + y * 0.07));
      const taper = y > 28 ? (y - 28) * 0.42 : 0;
      for (let x = 6; x <= 20; x++) {
        const cx = 13;
        if (y > 30 && Math.abs(x - cx) < (y - 30) * 0.45) continue; // forked wind notch
        if (Math.abs(x - cx) > 7.5 - taper * 0.35) continue;
        const fold = Math.sin((x + wave) * 0.72 + phase) * 0.5 + 0.5;
        const isGoldBorder = x === 6 || x === 20 || (y >= 15 && y <= 18 && Math.abs(x - cx) <= 3);
        const col = isGoldBorder ? (fold > 0.45 ? goldHi : goldMid) : mixRgb(crimsonDark, crimsonHi, 0.28 + fold * 0.62);
        b.pxRgb(x + wave, y, col, 0.58 + fold * 0.36);
      }
    }
    b.addOutline([12, 8, 16]);
    b.bakeRegionNormals(2.9, false);
  }
  b.alias('prop:wind_banner', 'prop:wind_banner_0');

  // 8. Clock Tower Stained-Glass Rose Window (56x56)
  b.alloc('prop:clock_rose_window', 56, 56, 0.5, 0.5);
  const cxR = 27.5;
  const cyR = 27.5;
  for (let y = 0; y < 56; y++) {
    for (let x = 0; x < 56; x++) {
      const dx = x - cxR;
      const dy = y - cyR;
      const r = Math.hypot(dx, dy);
      if (r > 26.5) continue;
      const ang = Math.atan2(dy, dx);
      const spoke = Math.abs(Math.sin(ang * 4));
      const petal = Math.abs(Math.cos(ang * 8));
      if (r > 23.0) {
        // Carved outer gothic stone ring
        const shade = 0.8 + ((x + y) % 3 === 0 ? 0.14 : -0.05);
        b.pxRgb(x, y, scaleRgb(hexRgb('#4f3d4f'), shade), 0.9);
      } else if (r > 21.5 || Math.abs(r - 13.5) < 1.3 || r < 5.5 || spoke < 0.12) {
        // Dark lead tracery mullions & brass ring
        const isBrass = Math.abs(r - 13.5) < 0.8 || (r >= 4.2 && r < 5.5);
        b.pxRgb(x, y, isBrass ? goldMid : ironVoid, isBrass ? 0.94 : 0.72);
      } else {
        // Luminous emissive stained-glass petals (amber + cyan + royal amethyst!)
        const sector = ((Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 8)) & 3);
        const glassBase: RGB =
          r < 13.5
            ? mixRgb(amberGlow, flameCore, 0.35 + petal * 0.4)
            : sector === 0 || sector === 2
            ? mixRgb(hexRgb('#2085a8'), cyanGlow, 0.45 + petal * 0.45)
            : mixRgb(hexRgb('#73248c'), hexRgb('#e05cff'), 0.4 + petal * 0.45);
        const emA = clampByte(175 + petal * 75);
        b.pxRgb(x, y, glassBase, 0.65, glassBase, emA);
      }
    }
  }
  b.ellipse(cxR, cyR, 4.2, 4.2, flameCore, 0.96, 0.04, amberGlow, 245);
  b.bakeRegionNormals(2.6, false);

  // 9. Clock Tower Swinging Brass Pendulum (28x72, top-pivoted!)
  b.alloc('prop:clock_pendulum', 28, 72, 0.5, 0.0);
  // Top axle mount
  b.ellipse(14, 4, 4.2, 4.2, goldMid, 0.94, 0.06);
  b.ellipse(14, 4, 1.8, 1.8, ironVoid, 0.5, 0.05);
  // Fluted brass rod
  b.rect(12, 6, 4, 42, goldDark, 0.85);
  b.rect(13, 6, 2, 42, goldHi, 0.95);
  // Decorative filigree collar above bob
  b.polygon([[8, 43], [20, 43], [16, 48], [12, 48]], goldMid, 0.92, 0.12);
  // Heavy sculpted brass sun-disc pendulum bob
  b.ellipse(14, 57, 11.5, 11.5, goldDark, 0.86, 0.16);
  b.ellipse(14, 57, 9.8, 9.8, goldMid, 0.92, 0.14);
  b.ellipse(12.5, 55, 6.2, 6.2, goldHi, 0.96, 0.08);
  // Glowing cyan chrono-rune jewel inset in center of bob
  b.ellipse(14, 57, 3.0, 3.0, cyanGlow, 0.98, 0.04, cyanGlow, 235);
  b.pxRgb(13, 56, [255, 255, 255], 1.0, [255, 255, 255], 255);
  // Bottom finial spike
  b.polygon([[12, 68], [16, 68], [14, 71]], goldHi, 0.94, 0.08);
  b.addOutline([14, 10, 18]);
  b.bakeRegionNormals(3.4, false);

  // 10. Clock Tower Interlocking Brass Wall Gears (`wall_gear`, `wall_gear_sm`)
  const paintGear = (key: string, size: number, teeth: number): void => {
    b.alloc(key, size, size, 0.5, 0.5);
    const c = (size - 1) * 0.5;
    const outerR = size * 0.48;
    const rimR = size * 0.37;
    const innerR = size * 0.25;
    const hubR = size * 0.14;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c;
        const dy = y - c;
        const r = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const toothWave = Math.cos(ang * teeth);
        const onTooth = r <= outerR && r >= rimR - 1 && toothWave > 0.25;
        const onRim = r <= rimR && r >= innerR;
        const onSpoke = r < innerR && r >= hubR && Math.abs(Math.sin(ang * 2)) < 0.28;
        const onHub = r < hubR && r >= hubR * 0.42;
        if (!onTooth && !onRim && !onSpoke && !onHub) continue;
        const shade = 0.78 + Math.max(0, (-dx * 0.45 - dy * 0.55) / outerR) * 0.35;
        const isHi = Math.abs(r - rimR) < 1.2 || onHub;
        const base = isHi ? goldHi : onSpoke ? goldDark : goldMid;
        b.pxRgb(x, y, scaleRgb(base, shade), isHi ? 0.96 : 0.86);
      }
    }
    b.addOutline([14, 10, 16]);
    b.bakeRegionNormals(3.4, false);
  };
  paintGear('prop:wall_gear', 40, 10);
  b.alias('prop:wall_gear_lg', 'prop:wall_gear');
  paintGear('prop:wall_gear_sm', 26, 8);

  // 11. High Peak Castle Lancet Stained-Glass Window (36x72)
  b.alloc('prop:castle_stained_glass', 36, 72, 0.5, 1.0);
  const marbleDark = hexRgb('#4c474a');
  const marbleMid = hexRgb('#877e78');
  const marbleHi = hexRgb('#c2b8ad');
  // Pointed gothic marble lancet outer frame
  for (let y = 2; y < 72; y++) {
    const halfW = y < 22 ? Math.max(2, Math.round(Math.sqrt(Math.max(0, (y - 2) / 20)) * 16.5)) : 16.5;
    for (let dx = -Math.ceil(halfW); dx <= Math.ceil(halfW); dx++) {
      const x = 18 + dx;
      const distEdge = halfW - Math.abs(dx);
      if (distEdge <= 3.2 || y >= 68) {
        const col = y >= 68 ? marbleHi : distEdge < 1.5 ? marbleDark : marbleMid;
        b.pxRgb(x, y, col, 0.88);
      } else {
        // Stained-glass royal diamond mosaic + golden crest in upper lancet!
        const isMullion = Math.abs(dx) <= 1 || y === 24 || y === 46;
        if (isMullion) {
          b.pxRgb(x, y, ironVoid, 0.72);
        } else {
          const diamond = ((Math.abs(dx) + y) % 8 === 0 || (Math.abs(dx) - y + 96) % 8 === 0);
          let glass: RGB = y < 24 ? goldHi : y < 46 ? crimsonHi : hexRgb('#3874c9');
          if (y >= 26 && y <= 40 && Math.abs(dx) <= 5) glass = goldHi; // heraldic gold shield emblem
          if (diamond) glass = scaleRgb(glass, 0.72);
          b.pxRgb(x, y, glass, 0.68, glass, diamond ? 130 : 210);
        }
      }
    }
  }
  b.addOutline([16, 14, 20]);
  b.bakeRegionNormals(3.1, false);

  // 12. High Peak Castle Royal Five-Candle Candelabra (28x52)
  b.alloc('prop:royal_candelabra', 28, 52, 0.5, 1.0);
  // Ornate clawed pedestal base & fluted golden column
  b.polygon([[5, 51], [10, 45], [18, 45], [23, 51]], goldDark, 0.86, 0.16);
  b.rect(12, 18, 4, 28, goldMid, 0.9);
  b.line(13, 18, 13, 46, goldHi, 1, 0.96);
  // Scrolled ornate golden candelabra arms
  b.line(4, 21, 13, 27, goldMid, 2.2, 0.9);
  b.line(24, 21, 15, 27, goldMid, 2.2, 0.9);
  b.line(8, 17, 13, 22, goldHi, 2.0, 0.92);
  b.line(20, 17, 15, 22, goldHi, 2.0, 0.92);
  // 5 ivory candles + blazing golden emissive flames
  const candles: ReadonlyArray<readonly [number, number]> = [
    [4, 15],
    [9, 11],
    [14, 9],
    [19, 11],
    [24, 15],
  ];
  for (const [cx, cy] of candles) {
    b.rect(cx - 2, cy + 5, 5, 2, goldHi, 0.94); // drip saucer
    b.rect(cx - 1, cy, 3, 6, hexRgb('#efe7d3'), 0.9); // wax candle
    b.ellipse(cx, cy - 3, 2.0, 3.0, amberGlow, 0.92, 0.08, amberGlow, 245);
    b.ellipse(cx, cy - 2.5, 1.0, 1.7, flameCore, 1.0, 0.02, flameCore, 255);
  }
  b.addOutline([14, 10, 16]);
  b.bakeRegionNormals(3.2, false);

  // 13. In-Biome Merchant Shop Stall (76x56)
  b.alloc('prop:shop_stall', 76, 56, 0.5, 1.0);
  // Back vertical timber support posts
  b.rect(6, 14, 4, 41, woodMid, 0.84, 1);
  b.rect(66, 14, 4, 41, woodMid, 0.84, 1);
  // Weathered oak wooden sales counter (y=36..55)
  b.rect(4, 36, 68, 4, woodHi, 0.92, 1);
  b.rect(6, 40, 64, 15, woodMid, 0.82, 2);
  for (let px = 14; px < 66; px += 10) {
    b.line(px, 41, px, 54, woodDark, 1, 0.48);
  }
  // Draped emerald/gold merchant table runner + iron corner braces
  b.polygon([[26, 39], [50, 39], [48, 51], [38, 54], [28, 51]], hexRgb('#1f594d'), 0.88, 0.12);
  b.line(27, 40, 49, 40, goldHi, 1.5, 0.95);
  b.ellipse(38, 46, 3.2, 3.2, goldMid, 0.94, 0.06, goldHi, 120);
  // Counter wares: glowing cyan potion bottle, emerald elixir, leather coin sack & sword rack
  b.rect(12, 29, 5, 7, cyanGlow, 0.92, 0, cyanGlow, 215);
  b.rect(13, 27, 3, 2, woodHi, 0.9);
  b.ellipse(22, 33, 3.5, 3.2, hexRgb('#9e7445'), 0.88, 0.12); // coin pouch
  b.pxRgb(22, 30, goldHi, 0.96);
  b.rect(56, 30, 5, 6, emeraldGlow, 0.92, 0, emeraldGlow, 215);
  b.rect(57, 28, 3, 2, woodHi, 0.9);
  // Hanging warm merchant lantern beneath right awning
  b.line(62, 16, 62, 21, ironMid, 1.5, 0.88);
  b.rect(59, 21, 6, 7, amberGlow, 0.92, 0, amberGlow, 250);
  b.rect(60, 22, 4, 5, flameCore, 0.98, 0, flameCore, 255);
  b.rect(58, 20, 8, 2, ironDark, 0.94);
  b.rect(58, 28, 8, 2, ironDark, 0.94);
  // Sloped red-and-gold striped scalloped canvas canopy roof (y=4..18)
  for (let y = 4; y <= 17; y++) {
    const t = (y - 4) / 13;
    const xL = Math.round(8 - t * 6);
    const xR = Math.round(67 + t * 6);
    for (let x = xL; x <= xR; x++) {
      if (y >= 15 && Math.sin(x * 0.65) < -0.35) continue; // scalloped fabric hem
      const stripe = Math.floor((x - 2) / 7) % 2 === 0;
      const base = stripe ? (y < 9 ? crimsonHi : crimson) : (y < 9 ? hexRgb('#e8d2a6') : hexRgb('#b59769'));
      const shade = y >= 14 ? 0.72 : 1.04 - t * 0.16;
      b.pxRgb(x, y, scaleRgb(base, shade), 0.88 - t * 0.08);
    }
  }
  b.rect(8, 3, 60, 2, goldMid, 0.95);
  b.addOutline([12, 9, 16]);
  b.bakeRegionNormals(3.1, false);

  // 14. Hooded Goblin Shop Merchant NPC (32x40)
  b.alloc('prop:npc_merchant', 32, 40, 0.5, 1.0);
  const cloakDark = hexRgb('#1a2b3d');
  const cloakMid = hexRgb('#2b4a66');
  const cloakHi = hexRgb('#497699');
  // Merchant cloak & layered golden shoulder mantle
  b.polygon([[7, 39], [10, 17], [22, 17], [26, 39]], cloakDark, 0.8, 0.18);
  b.polygon([[10, 18], [21, 18], [23, 36], [11, 36]], cloakMid, 0.86, 0.16);
  b.line(10, 19, 22, 19, goldHi, 2, 0.95);
  b.line(16, 20, 16, 37, goldMid, 1.5, 0.92);
  // Deep pointed hood + glowing mischievous golden eyes!
  b.polygon([[15, 4], [24, 10], [22, 19], [9, 19], [8, 12]], cloakHi, 0.9, 0.18);
  b.polygon([[11, 10], [21, 10], [20, 17], [12, 17]], ironVoid, 0.62, 0.08);
  b.rect(14, 13, 2, 2, goldHi, 0.98, 0, amberGlow, 255);
  b.rect(18, 13, 2, 2, goldHi, 0.98, 0, amberGlow, 255);
  // Heavy coin purse at belt + gleaming gold goblet held out
  b.ellipse(10, 28, 3.6, 3.8, woodHi, 0.9, 0.1);
  b.line(20, 23, 26, 20, cloakHi, 2.8, 0.88);
  b.ellipse(27, 17, 3.0, 3.4, goldHi, 0.96, 0.06, goldHi, 215);
  b.rect(26, 20, 2, 3, goldMid, 0.94);
  b.addOutline([10, 9, 18]);
  b.bakeRegionNormals(3.2, false);

  // 15. Iconic Glowing Glass Recycling Tube (32x48)
  b.alloc('prop:recycling_tube', 32, 48, 0.5, 1.0);
  // Heavy riveted brass & iron base pedestal
  b.rect(4, 41, 24, 6, ironMid, 0.88, 2);
  b.rect(6, 37, 20, 5, goldMid, 0.92, 1);
  b.pxRgb(9, 39, goldHi, 0.98);
  b.pxRgb(22, 39, goldHi, 0.98);
  // Ornate brass top cap & pressure dome
  b.rect(6, 7, 20, 5, goldMid, 0.92, 1);
  b.ellipse(16, 7, 8, 4, ironHi, 0.9, 0.12);
  b.rect(14, 1, 4, 4, goldHi, 0.96);
  // Cylindrical glowing cyan glass chamber (y=12..37)
  for (let y = 12; y < 37; y++) {
    for (let x = 8; x <= 23; x++) {
      const u = (x - 15.5) / 7.5;
      const isRim = x === 8 || x === 23;
      if (isRim) {
        b.pxRgb(x, y, hexRgb('#88c8de'), 0.9);
      } else {
        const coreGlow = Math.max(0, 1 - Math.abs(u) * 1.15);
        const col = mixRgb(hexRgb('#12364d'), cyanGlow, 0.25 + coreGlow * 0.45);
        b.px(x, y, col[0], col[1], col[2], 215, 0.72 + coreGlow * 0.2, cyanGlow[0], cyanGlow[1], cyanGlow[2], clampByte(65 + coreGlow * 120));
      }
    }
  }
  // Crisp glass reflection streak + shimmering suspended motes inside tube
  b.line(10, 14, 10, 35, [225, 250, 255], 1, 0.96, [220, 250, 255], 175);
  b.ellipse(16, 24, 3.0, 5.0, cyanGlow, 0.92, 0.08, cyanGlow, 235);
  b.pxRgb(16, 22, [255, 255, 255], 1.0, [255, 255, 255], 255);
  b.pxRgb(13, 18, flameCore, 0.96, cyanGlow, 220);
  b.pxRgb(19, 30, flameCore, 0.96, cyanGlow, 220);
  // Side brass support struts
  b.rect(6, 12, 2, 25, ironDark, 0.92);
  b.rect(24, 12, 2, 25, ironDark, 0.92);
  b.addOutline([10, 12, 20]);
  b.bakeRegionNormals(3.3, false);
}

// =============================================================================
// Prisoner (Hero) — Multi-Frame Hand-Crafted Pixel Art + Homunculus Flame Head
// =============================================================================

function paintHeroPose(
  b: PixelAtlasBuilder,
  key: string,
  pose:
    | 'idle'
    | 'run'
    | 'jump'
    | 'fall'
    | 'wall'
    | 'roll'
    | 'dive'
    | 'attack'
    | 'parry'
    | 'heal'
    | 'hurt'
    | 'dead',
  frame: number
): void {
  const W = 32;
  const H = 38;
  b.alloc(key, W, H, 0.5, 1.0);

  const tunicDark = hexRgb('#121a2b');
  const tunic = hexRgb('#1e2c45');
  const tunicHi = hexRgb('#374f78');
  const armorPlate = hexRgb('#4c6082');
  const armorRim = hexRgb('#87a1cc');
  const cloakDark = hexRgb('#1b0d1f');
  const cloak = hexRgb('#311636');
  const leatherDark = hexRgb('#362015');
  const leather = hexRgb('#5c3926');
  const leatherHi = hexRgb('#8f5e3e');
  const scarfDark = hexRgb('#7d0f20');
  const scarfRed = hexRgb('#c91d32');
  const scarfHi = hexRgb('#ff3b52');
  const gold = hexRgb('#e6b84c');
  const steel = hexRgb('#ccd8ed');
  const steelHi = hexRgb('#f2f7ff');
  const cyanCollar = hexRgb('#4de8ff');
  const greenFlask = hexRgb('#4aff9e');

  if (pose === 'roll') {
    const cy = 26;
    const rot = frame * 2.1;
    // Dynamic somersault tuck with swirling crimson scarf & armor flash
    b.ellipse(16, cy, 9.6, 8.4, cloakDark, 0.68, 0.26);
    b.ellipse(16, cy, 7.6, 6.8, tunic, 0.78, 0.22);
    b.polygon(
      [
        [16 + Math.cos(rot) * 9, cy + Math.sin(rot) * 7],
        [16 + Math.cos(rot + 1.1) * 7, cy + Math.sin(rot + 1.1) * 6],
        [16 + Math.cos(rot + 2.2) * 5, cy + Math.sin(rot + 2.2) * 5],
      ],
      scarfRed,
      0.88,
      0.14
    );
    b.ellipse(16 - Math.cos(rot) * 4.5, cy - Math.sin(rot) * 2.5, 3.6, 3.2, armorRim, 0.92, 0.1);
    b.ellipse(
      16 + Math.cos(rot + 1.5) * 5.2,
      cy + Math.sin(rot + 1.5) * 3.4,
      2.6,
      2.6,
      cyanCollar,
      0.96,
      0.04,
      cyanCollar,
      245
    );
    b.addOutline([12, 9, 20]);
    b.bakeRegionNormals(3.5, false);
    return;
  }

  if (pose === 'dead') {
    b.polygon([[4, 35], [10, 29], [23, 30], [28, 35]], cloakDark, 0.58, 0.18);
    b.ellipse(15, 33, 10.5, 4.2, tunic, 0.72, 0.22);
    b.polygon([[8, 31], [16, 29], [18, 34], [10, 35]], scarfRed, 0.84, 0.14);
    b.ellipse(22, 31, 3.2, 2.4, cyanCollar, 0.88, 0.05, cyanCollar, 150);
    b.addOutline([12, 9, 20]);
    b.bakeRegionNormals(3.0, false);
    return;
  }

  // Dynamic gothic combat kinematics per pose
  const bob =
    pose === 'idle'
      ? frame % 2 === 0
        ? 0
        : 1
      : pose === 'run'
      ? frame % 2 === 0
        ? -1
        : 1
      : 0;
  const lean =
    pose === 'run' ? 2 : pose === 'attack' ? 3 : pose === 'hurt' ? -2 : pose === 'parry' ? 1 : 0;
  const torsoX = 16 + lean;
  const torsoY = 20 + bob;

  // 1. Billowing tattered back cloak (asymmetric jagged hem, distinct per pose!)
  const cloakFlare = pose === 'run' ? 4 + (frame % 2) : pose === 'jump' || pose === 'fall' ? 5 : pose === 'attack' ? 3 : 1;
  b.polygon(
    [
      [torsoX - 3, torsoY - 5],
      [torsoX - 7 - cloakFlare, torsoY + 3],
      [torsoX - 9 - cloakFlare, torsoY + 12],
      [torsoX - 5 - Math.floor(cloakFlare * 0.5), torsoY + 9],
      [torsoX - 4 - cloakFlare, torsoY + 14],
      [torsoX + 1, torsoY + 9],
    ],
    cloakDark,
    0.58,
    0.16
  );
  b.polygon(
    [
      [torsoX - 2, torsoY - 4],
      [torsoX - 6 - Math.floor(cloakFlare * 0.7), torsoY + 4],
      [torsoX - 6 - Math.floor(cloakFlare * 0.6), torsoY + 11],
      [torsoX - 1, torsoY + 7],
    ],
    cloak,
    0.66,
    0.14
  );

  // 2. Articulated legs + wrapped shin greaves & boots
  if (pose === 'run') {
    const phase = (frame / 6) * Math.PI * 2;
    const lx1 = torsoX + Math.sin(phase) * 7.5;
    const ly1 = 35 - Math.max(0, Math.cos(phase) * 4.5);
    const lx2 = torsoX - Math.sin(phase) * 7.5;
    const ly2 = 35 - Math.max(0, -Math.cos(phase) * 4.5);
    b.line(torsoX - 1, torsoY + 6, lx2, ly2, leatherDark, 3.2, 0.68);
    b.pxRgb(lx2, ly2, armorRim, 0.76);
    b.line(torsoX + 1, torsoY + 6, lx1, ly1, leatherHi, 3.2, 0.8);
    b.pxRgb(lx1 + 1, ly1, armorRim, 0.86);
  } else if (pose === 'jump') {
    b.line(torsoX - 2, torsoY + 5, torsoX - 6, torsoY + 12, leatherDark, 3, 0.68);
    b.line(torsoX + 2, torsoY + 5, torsoX + 6, torsoY + 10, leatherHi, 3.2, 0.82);
  } else if (pose === 'fall') {
    b.line(torsoX - 2, torsoY + 5, torsoX - 5, torsoY + 14, leatherDark, 3, 0.68);
    b.line(torsoX + 2, torsoY + 5, torsoX + 4, torsoY + 15, leatherHi, 3.2, 0.8);
  } else if (pose === 'dive') {
    b.line(torsoX - 2, torsoY + 5, torsoX - 4, 36, leatherHi, 3, 0.86);
    b.line(torsoX + 2, torsoY + 5, torsoX + 4, 36, steelHi, 3.2, 0.94, cyanCollar, 200);
    // Downward plunge energy streak
    b.line(torsoX, torsoY + 8, torsoX, 37, cyanCollar, 1.5, 0.96, cyanCollar, 240);
  } else if (pose === 'wall') {
    b.line(torsoX - 1, torsoY + 5, torsoX + 4, torsoY + 11, leatherHi, 3, 0.8);
    b.line(torsoX - 2, torsoY + 6, torsoX + 3, torsoY + 16, leather, 3, 0.72);
  } else {
    const stance = pose === 'attack' ? 5.5 : 3.5;
    b.line(torsoX - 2, torsoY + 6, torsoX - stance - 1, 36, leatherDark, 3.2, 0.7);
    b.rect(Math.round(torsoX - stance - 2), 34, 4, 3, armorPlate, 0.8);
    b.line(torsoX + 2, torsoY + 6, torsoX + stance + 1, 36, leatherHi, 3.2, 0.8);
    b.rect(Math.round(torsoX + stance), 34, 4, 3, armorRim, 0.86);
  }

  // 3. Sculpted gothic tapered chest cuirass, diagonal leather bandolier & belt
  b.polygon(
    [
      [torsoX - 6, torsoY - 5],
      [torsoX + 6, torsoY - 5],
      [torsoX + 4, torsoY + 6],
      [torsoX - 4, torsoY + 6],
    ],
    tunicDark,
    0.74,
    0.22
  );
  b.polygon(
    [
      [torsoX - 4, torsoY - 4],
      [torsoX + 5, torsoY - 4],
      [torsoX + 3, torsoY + 4],
      [torsoX - 3, torsoY + 4],
    ],
    tunic,
    0.82,
    0.18
  );
  b.polygon(
    [
      [torsoX - 2, torsoY - 4],
      [torsoX + 4, torsoY - 4],
      [torsoX + 2, torsoY + 2],
      [torsoX - 1, torsoY + 2],
    ],
    tunicHi,
    0.88,
    0.12
  );
  // Diagonal chest leather strap + brass buckle
  b.line(torsoX - 4, torsoY - 4, torsoX + 3, torsoY + 4, leatherHi, 1.8, 0.9);
  b.rect(torsoX - 4, torsoY + 3, 9, 2, leather, 0.9);
  b.rect(torsoX, torsoY + 3, 2, 2, gold, 0.96);

  // 4. Sculpted beveled shoulder pauldron (catches torchlight!)
  b.polygon(
    [
      [torsoX - 6, torsoY - 6],
      [torsoX - 1, torsoY - 7],
      [torsoX - 2, torsoY - 1],
      [torsoX - 7, torsoY - 2],
    ],
    armorPlate,
    0.9,
    0.16
  );
  b.line(torsoX - 6, torsoY - 6, torsoX - 1, torsoY - 7, armorRim, 1, 0.96);

  // 5. Iconic layered crimson scarf collar + fluttering trailing tail
  b.polygon(
    [
      [torsoX - 5, torsoY - 7],
      [torsoX - 11 - Math.min(3, cloakFlare), torsoY - 4 + (frame % 2)],
      [torsoX - 9 - Math.min(3, cloakFlare), torsoY - 1 + (frame % 2)],
      [torsoX - 4, torsoY - 4],
    ],
    scarfDark,
    0.82,
    0.12
  );
  b.line(
    torsoX - 5,
    torsoY - 6,
    torsoX - 10 - Math.min(3, cloakFlare),
    torsoY - 3 + (frame % 2),
    scarfHi,
    1.2,
    0.9
  );
  b.polygon(
    [
      [torsoX - 5, torsoY - 7],
      [torsoX + 5, torsoY - 7],
      [torsoX + 6, torsoY - 4],
      [torsoX - 5, torsoY - 4],
    ],
    scarfRed,
    0.9,
    0.14
  );
  b.line(torsoX - 4, torsoY - 7, torsoX + 4, torsoY - 7, scarfHi, 1.2, 0.95);

  // 6. Glowing cyan homunculus neck collar ring (flame head draws dynamically above!)
  b.rect(torsoX - 2, torsoY - 9, 5, 2, cyanCollar, 0.96, 0, cyanCollar, 235);

  // 7. Dynamic arms & held combat props
  if (pose === 'attack') {
    const swingAng = frame === 0 ? -0.55 : frame === 1 ? 0.08 : 0.45;
    const ax = torsoX + 8;
    const ay = torsoY - 2 + Math.round(swingAng * 8);
    b.line(torsoX + 2, torsoY - 3, ax, ay, leatherHi, 3, 0.88);
    b.pxRgb(ax - 1, ay, armorRim, 0.92); // gauntlet cuff
    // Gleaming curved steel sword with glowing leading edge
    b.line(ax, ay, ax + 7, ay - 7 + frame * 6, steel, 2.4, 0.95, hexRgb('#d6ecff'), 110);
    b.line(ax + 1, ay - 1, ax + 7, ay - 7 + frame * 6, steelHi, 1, 0.98, hexRgb('#e0f4ff'), 160);
    b.pxRgb(ax, ay, gold, 0.96);
  } else if (pose === 'parry') {
    b.line(torsoX + 2, torsoY - 2, torsoX + 7, torsoY - 1, leatherHi, 3, 0.88);
    // Ornate beveled gold-rimmed tower buckler
    b.polygon(
      [
        [torsoX + 6, torsoY - 8],
        [torsoX + 11, torsoY - 6],
        [torsoX + 11, torsoY + 5],
        [torsoX + 7, torsoY + 8],
        [torsoX + 6, torsoY + 4],
      ],
      gold,
      0.95,
      0.14,
      hexRgb('#ffe885'),
      165
    );
    b.rect(torsoX + 7, torsoY - 4, 3, 8, armorPlate, 0.9);
  } else if (pose === 'heal') {
    b.line(torsoX + 2, torsoY - 3, torsoX + 4, torsoY - 10, leatherHi, 2.5, 0.88);
    b.ellipse(torsoX + 4, torsoY - 14, 3.2, 4.0, greenFlask, 0.96, 0.06, greenFlask, 255);
    b.pxRgb(torsoX + 3, torsoY - 15, steelHi, 1.0, steelHi, 255);
  } else if (pose === 'wall') {
    b.line(torsoX + 1, torsoY - 3, torsoX + 6, torsoY - 7, leatherHi, 3, 0.88);
    b.pxRgb(torsoX + 6, torsoY - 7, armorRim, 0.94);
  } else {
    const armSwing = pose === 'run' ? Math.cos((frame / 6) * Math.PI * 2) * 4.5 : 0;
    b.line(torsoX + 1, torsoY - 2, torsoX + 4 + armSwing, torsoY + 4, leatherHi, 2.6, 0.86);
    b.pxRgb(torsoX + 4 + armSwing, torsoY + 4, armorRim, 0.9);
    // Sheathed sword scabbard angled behind hip
    b.line(torsoX - 3, torsoY + 2, torsoX - 9, torsoY + 7, armorPlate, 2, 0.84);
    b.pxRgb(torsoX - 3, torsoY + 2, gold, 0.94);
  }

  b.addOutline([12, 9, 20]);
  b.bakeRegionNormals(3.6, false);
}

function paintHomunculusHeadFrames(b: PixelAtlasBuilder): void {
  // Authentic Dead Cells Beheaded Homunculus Head (ref_01 & ref_16):
  // Compact smoky dark-charcoal/mossy-emerald shadow cloud with a PIERCING
  // bright golden-yellow 4-point star eye — ZERO giant cyan lightbulb!
  const smokeVoid = hexRgb('#0b1114');
  const smokeCharcoal = hexRgb('#121f1c');
  const smokeMoss = hexRgb('#1e362c');
  const smokeMossHi = hexRgb('#2e5240');
  const eyeAmber = hexRgb('#ff9624');
  const eyeGold = hexRgb('#ffe047');
  const eyeCore: RGB = [255, 253, 224];

  for (let f = 0; f < 4; f++) {
    b.alloc(`hero:head_flame_${f}`, 14, 16, 0.5, 0.85);
    const phase = (f / 4) * Math.PI * 2;
    const sway = Math.sin(phase) * 1.1;
    const wisp = Math.cos(phase) * 1.2;

    // Trailing wispy shadow smoke tail drifting slightly up-left behind head
    b.ellipse(4.4 + sway * 0.6, 5.2 + wisp * 0.4, 2.3, 2.0, smokeVoid, 0.45, 0.14);
    b.ellipse(5.8 + sway * 0.5, 3.6 + wisp * 0.3, 1.8, 1.9, smokeCharcoal, 0.5, 0.12);
    b.pxRgb(Math.round(3 + sway * 0.7), Math.round(3 + (f & 1)), smokeVoid, 0.35);
    b.pxRgb(Math.round(5 + wisp * 0.5), 2, smokeCharcoal, 0.4);

    // Compact dark smoky charcoal-moss head core sitting cleanly on the crimson collar
    b.ellipse(7.3, 9.4, 3.7, 4.1, smokeVoid, 0.62, 0.12);
    b.ellipse(7.4 + sway * 0.25, 8.8, 3.1, 3.5, smokeCharcoal, 0.72, 0.14, smokeVoid, 25);
    b.ellipse(7.8 + sway * 0.2, 8.6, 2.2, 2.5, smokeMoss, 0.8, 0.12, smokeMoss, 45);
    b.ellipse(8.2, 8.2, 1.3, 1.5, smokeMossHi, 0.84, 0.1, smokeMossHi, 68);

    // Subtle organic top tuft
    b.pxRgb(Math.round(7 + sway * 0.6), 4, smokeCharcoal, 0.65);
    b.pxRgb(Math.round(8 + sway * 0.4), 5, smokeMoss, 0.72);

    // Piercing Golden-Yellow 4-Point Star Eye (facing right, emissive!)
    const ex = 9;
    const ey = 9;
    // Soft warm amber outer tips of the 4-point star
    b.pxRgb(ex, ey - 3, eyeAmber, 0.95, eyeAmber, 190);
    b.pxRgb(ex, ey + 3, eyeAmber, 0.95, eyeAmber, 180);
    b.pxRgb(ex - 2, ey, eyeAmber, 0.95, eyeAmber, 185);
    b.pxRgb(ex + 2, ey, eyeAmber, 0.95, eyeAmber, 210);
    // Crisp bright golden star arms
    b.pxRgb(ex, ey - 2, eyeGold, 1.0, eyeGold, 245);
    b.pxRgb(ex, ey - 1, eyeGold, 1.0, eyeGold, 255);
    b.pxRgb(ex, ey + 1, eyeGold, 1.0, eyeGold, 255);
    b.pxRgb(ex, ey + 2, eyeGold, 1.0, eyeGold, 240);
    b.pxRgb(ex - 1, ey, eyeGold, 1.0, eyeGold, 255);
    b.pxRgb(ex + 1, ey, eyeGold, 1.0, eyeGold, 255);
    // Incandescent pure white-cream star center
    b.pxRgb(ex, ey, eyeCore, 1.0, eyeCore, 255);

    b.bakeRegionNormals(1.8, false);
  }
}

// =============================================================================
// 18 Distinct Enemy Archetypes (2 Frames Each)
// =============================================================================

interface EnemyVisualSpec {
  id: string;
  w: number;
  h: number;
  body: RGB;
  accent: RGB;
  armor: RGB;
  eyeGlow: RGB;
  style:
    | 'zombie'
    | 'archer'
    | 'grenader'
    | 'shield'
    | 'mage'
    | 'runner'
    | 'bat'
    | 'worm'
    | 'protector'
    | 'scorpio'
    | 'knight'
    | 'ninja'
    | 'pirate'
    | 'lancer';
}

const ENEMY_VISUALS: EnemyVisualSpec[] = [
  { id: 'Zombie', w: 26, h: 30, body: hexRgb('#526e4c'), accent: hexRgb('#3d2f2b'), armor: hexRgb('#738f68'), eyeGlow: hexRgb('#b8ff4d'), style: 'zombie' },
  { id: 'Archer', w: 26, h: 32, body: hexRgb('#404963'), accent: hexRgb('#875b3d'), armor: hexRgb('#c7c2b0'), eyeGlow: hexRgb('#ff4f4f'), style: 'archer' },
  { id: 'Grenader', w: 28, h: 32, body: hexRgb('#7a2936'), accent: hexRgb('#403d4d'), armor: hexRgb('#b83b4a'), eyeGlow: hexRgb('#ff9b3d'), style: 'grenader' },
  { id: 'Shield', w: 30, h: 32, body: hexRgb('#495066'), accent: hexRgb('#808ca8'), armor: hexRgb('#c9d4eb'), eyeGlow: hexRgb('#ffd452'), style: 'shield' },
  { id: 'Mage360', w: 26, h: 34, body: hexRgb('#4d2b6e'), accent: hexRgb('#8e44c9'), armor: hexRgb('#cfa8ff'), eyeGlow: hexRgb('#52f2ff'), style: 'mage' },
  { id: 'Runner', w: 26, h: 30, body: hexRgb('#382b3b'), accent: hexRgb('#bd2d3b'), armor: hexRgb('#69506b'), eyeGlow: hexRgb('#ff4040'), style: 'runner' },
  { id: 'BatKamikaze', w: 24, h: 20, body: hexRgb('#3d6e35'), accent: hexRgb('#65b842'), armor: hexRgb('#9dff57'), eyeGlow: hexRgb('#c4ff4d'), style: 'bat' },
  { id: 'BatDasher', w: 26, h: 20, body: hexRgb('#6e2348'), accent: hexRgb('#b53369'), armor: hexRgb('#e86495'), eyeGlow: hexRgb('#ffe052'), style: 'bat' },
  { id: 'Worm', w: 30, h: 24, body: hexRgb('#5c7034'), accent: hexRgb('#91b842'), armor: hexRgb('#424f25'), eyeGlow: hexRgb('#a8ff3d'), style: 'worm' },
  { id: 'Protector', w: 26, h: 34, body: hexRgb('#594c38'), accent: hexRgb('#cfa04a'), armor: hexRgb('#48a3b8'), eyeGlow: hexRgb('#52f2ff'), style: 'protector' },
  { id: 'Scorpio', w: 32, h: 26, body: hexRgb('#5c334a'), accent: hexRgb('#8f4a6b'), armor: hexRgb('#361d2b'), eyeGlow: hexRgb('#8cff3d'), style: 'scorpio' },
  { id: 'Comboter', w: 32, h: 36, body: hexRgb('#35394f'), accent: hexRgb('#8a2b36'), armor: hexRgb('#8f9cb8'), eyeGlow: hexRgb('#ff6242'), style: 'knight' },
  { id: 'Ninja', w: 26, h: 32, body: hexRgb('#1f3845'), accent: hexRgb('#c42b3b'), armor: hexRgb('#4a7082'), eyeGlow: hexRgb('#ff4f5e'), style: 'ninja' },
  { id: 'LeapingDuelyst', w: 28, h: 34, body: hexRgb('#4a2033'), accent: hexRgb('#d4374a'), armor: hexRgb('#a6b4cc'), eyeGlow: hexRgb('#ffcf4d'), style: 'ninja' },
  { id: 'ClusterGrenader', w: 32, h: 34, body: hexRgb('#474c5c'), accent: hexRgb('#b5462a'), armor: hexRgb('#828ca3'), eyeGlow: hexRgb('#ff9233'), style: 'grenader' },
  { id: 'PirateChief', w: 36, h: 40, body: hexRgb('#3b3242'), accent: hexRgb('#ad2d3b'), armor: hexRgb('#d9a438'), eyeGlow: hexRgb('#ffd452'), style: 'pirate' },
  { id: 'CastleKnight', w: 38, h: 44, body: hexRgb('#c7bfb4'), accent: hexRgb('#b82838'), armor: hexRgb('#f0c85a'), eyeGlow: hexRgb('#62e1ff'), style: 'knight' },
  { id: 'Lancer', w: 34, h: 36, body: hexRgb('#68748f'), accent: hexRgb('#2e62b5'), armor: hexRgb('#d4def2'), eyeGlow: hexRgb('#73d4ff'), style: 'lancer' },
];

function paintEnemyFrame(b: PixelAtlasBuilder, spec: EnemyVisualSpec, frame: number): void {
  const { w, h, body, accent, armor, eyeGlow, style } = spec;
  const cx = Math.floor(w * 0.5);
  const atk = frame === 1;
  const lunge = atk ? 3 : 0;

  if (style === 'bat') {
    const wingY = atk ? 4 : 13;
    b.line(cx - 2, 10, 2, wingY, body, 3, 0.72);
    b.line(cx + 2, 10, w - 3, wingY, body, 3, 0.72);
    b.ellipse(cx, 11, 5.5, 5.0, accent, 0.84, 0.16, spec.id === 'BatKamikaze' ? eyeGlow : undefined, spec.id === 'BatKamikaze' ? 165 : 0);
    b.pxRgb(cx + 2, 10, eyeGlow, 0.96, eyeGlow, 255);
    b.pxRgb(cx + 4, 10, eyeGlow, 0.96, eyeGlow, 255);
  } else if (style === 'worm') {
    for (let seg = 0; seg < 4; seg++) {
      const sx = 6 + seg * 6 + (atk && seg === 3 ? 2 : 0);
      const sy = h - 7 - Math.sin(seg * 1.1 + frame) * 2.5;
      b.ellipse(sx, sy, 4.5, 4.2, seg % 2 === 0 ? body : accent, 0.82, 0.18);
    }
    b.ellipse(w - 6, h - 10, 3.6, 3.6, eyeGlow, 0.92, 0.08, eyeGlow, 230);
  } else if (style === 'scorpio') {
    b.ellipse(cx, h - 8, 9, 5, body, 0.82, 0.18);
    b.ellipse(cx + 2, h - 10, 7, 3.5, accent, 0.88, 0.12);
    // Curved tail with glowing venom stinger
    b.line(cx - 6, h - 9, cx - 10, h - 18, armor, 3, 0.8);
    b.line(cx - 10, h - 18, cx - 2 + lunge, h - 22, accent, 2.5, 0.88);
    b.ellipse(cx + lunge, h - 22, 2.4, 2.4, eyeGlow, 0.96, 0.04, eyeGlow, 255);
    // Legs & claws
    for (let i = -1; i <= 1; i++) b.line(cx + i * 4, h - 5, cx + i * 5, h - 1, armor, 1.5, 0.7);
    b.pxRgb(cx + 7, h - 10, eyeGlow, 0.95, eyeGlow, 255);
  } else if (style === 'mage') {
    // Levitating hooded inquisitor
    const fy = atk ? -2 : 0;
    b.ellipse(cx, h - 13 + fy, 6.5, 11, body, 0.78, 0.22);
    b.ellipse(cx, 9 + fy, 5.2, 5.5, accent, 0.88, 0.12);
    b.pxRgb(cx + 2, 9 + fy, eyeGlow, 0.96, eyeGlow, 255);
    // Floating glowing rune orb / staff
    b.line(cx + 6, 8 + fy, cx + 6, h - 5 + fy, armor, 2, 0.84);
    b.ellipse(cx + 6 + lunge, 7 + fy, 3.4, 3.4, eyeGlow, 0.96, 0.04, eyeGlow, 255);
  } else if (style === 'shield') {
    b.line(cx - 3, h - 10, cx - 4, h - 1, body, 3, 0.72);
    b.line(cx + 2, h - 10, cx + 3, h - 1, body, 3, 0.72);
    b.ellipse(cx - 2, h - 16, 6.5, 8.5, body, 0.8, 0.2);
    b.ellipse(cx - 1, 8, 5, 5, armor, 0.88, 0.12);
    b.pxRgb(cx + 1, 8, eyeGlow, 0.95, eyeGlow, 255);
    // Massive front iron tower shield!
    b.rect(cx + 4 + lunge, 7, 7, 22, armor, 0.95, 2);
    b.rect(cx + 6 + lunge, 14, 3, 8, accent, 0.98);
  } else {
    // Humanoid fighters: zombie, archer, grenader, runner, protector, knight, ninja, pirate, lancer
    const headY = Math.max(7, Math.floor(h * 0.24));
    const torsoY = Math.floor(h * 0.56);
    const torsoRx = Math.max(5.5, w * 0.22);
    const torsoRy = Math.max(6.5, h * 0.23);

    // Legs
    b.line(cx - 3, torsoY + torsoRy - 2, cx - 5 - (atk ? 2 : 0), h - 1, accent, 3, 0.72);
    b.line(cx + 3, torsoY + torsoRy - 2, cx + 5 + lunge, h - 1, body, 3, 0.78);
    // Torso & pauldrons
    b.ellipse(cx + lunge * 0.4, torsoY, torsoRx, torsoRy, body, 0.78, 0.22);
    b.ellipse(cx + lunge * 0.4, torsoY - 2, torsoRx * 0.85, torsoRy * 0.55, armor, 0.88, 0.14);
    // Head / helmet / hat
    b.ellipse(cx + lunge * 0.6, headY, Math.max(4.5, w * 0.17), Math.max(4.5, h * 0.15), style === 'zombie' ? body : armor, 0.88, 0.12);
    if (style === 'pirate') {
      // Tricorn pirate hat
      b.rect(cx - 8 + lunge, headY - 6, 17, 4, hexRgb('#261d2b'), 0.92, 1);
      b.rect(cx - 4 + lunge, headY - 9, 9, 4, accent, 0.94);
    } else if (style === 'knight') {
      // Royal horned / plumed helm
      b.line(cx - 2, headY - 4, cx - 5, headY - 10, accent, 2.5, 0.9);
      b.line(cx + 2, headY - 4, cx + 5, headY - 10, accent, 2.5, 0.9);
    }
    // Glowing eye(s)
    b.pxRgb(cx + 2 + lunge * 0.6, headY, eyeGlow, 0.96, eyeGlow, 255);
    b.pxRgb(cx + 3 + lunge * 0.6, headY, eyeGlow, 0.96, eyeGlow, 255);

    // Signature weapon / silhouette prop
    if (style === 'archer') {
      b.line(cx + 6 + lunge, headY, cx + 8 + lunge, torsoY + 6, accent, 2, 0.9);
      b.line(cx + 2, torsoY, cx + 11 + lunge, torsoY, eyeGlow, 1.5, 0.95, eyeGlow, 210);
    } else if (style === 'grenader') {
      b.ellipse(cx + 7 + lunge, torsoY - (atk ? 5 : 1), 3.6, 3.6, hexRgb('#2a2d3b'), 0.92, 0.08);
      b.pxRgb(cx + 8 + lunge, torsoY - (atk ? 9 : 5), eyeGlow, 0.98, eyeGlow, 255);
    } else if (style === 'protector') {
      b.rect(cx + 5, 4, 4, h - 8, accent, 0.9, 1);
      b.ellipse(cx + 7, 7, 3.6, 4.2, eyeGlow, 0.95, 0.05, eyeGlow, 245);
    } else if (style === 'lancer') {
      b.line(cx - 4, torsoY, w - 1, torsoY - (atk ? 1 : 4), armor, 2.5, 0.94, eyeGlow, 140);
    } else if (style === 'knight' || style === 'pirate') {
      const bx = atk ? w - 2 : cx + 8;
      const by = atk ? torsoY + 2 : 4;
      b.line(cx + 4, torsoY - 2, bx, by, hexRgb('#d8e2f5'), 3, 0.94, eyeGlow, atk ? 170 : 60);
    } else if (style === 'ninja' || style === 'runner') {
      b.line(cx + 3, torsoY, w - 2, torsoY + (atk ? 2 : -5), hexRgb('#dce8ff'), 2, 0.94, eyeGlow, 160);
      // Trailing headband
      b.line(cx - 2, headY, cx - 9, headY + (atk ? 1 : 3), accent, 2, 0.85);
    } else {
      // Zombie clawed reach
      b.line(cx + 3, torsoY - 2, cx + 10 + lunge, torsoY - (atk ? 4 : 1), armor, 2.5, 0.88);
    }
  }

  b.addOutline();
  b.bakeRegionNormals(3.4, false);
}

// =============================================================================
// 3 Monumental Multi-Phase Bosses (2 Frames Each)
// =============================================================================

function paintBosses(b: PixelAtlasBuilder): void {
  // 1. Behemoth — The Iron Concierge (64x74) — Hulking organic dark-forged iron juggernaut!
  for (let f = 0; f < 2; f++) {
    b.alloc(`boss:Behemoth_${f}`, 64, 74, 0.5, 1.0);
    const atk = f === 1;
    const ironVoid = hexRgb('#12151f');
    const ironDark = hexRgb('#212636');
    const iron = hexRgb('#3a4259');
    const ironHi = hexRgb('#6e7b9e');
    const ironSpec = hexRgb('#a8b7d9');
    const clothDark = hexRgb('#3d121d');
    const cloth = hexRgb('#6b1d2e');
    const molten = hexRgb('#ff4614');
    const moltenOrg = hexRgb('#ff8824');
    const coreYel = hexRgb('#ffe066');

    // Hanging rusted prison chains sweeping behind hunched back
    b.line(13, 28, 6, 56 + (atk ? -3 : 2), ironHi, 2.6, 0.82);
    b.line(16, 31, 11, 60 + (atk ? -2 : 1), iron, 2.2, 0.78);
    // Heavy sculpted armored greaves & spiked sabatons (grounded solidly at y=73)
    b.polygon([[15, 48], [26, 48], [25, 72], [13, 72]], ironDark, 0.78, 0.2);
    b.polygon([[17, 52], [24, 52], [23, 61], [16, 61]], ironHi, 0.88, 0.14);
    b.line(16, 54, 24, 54, ironSpec, 1, 0.94);
    const rxOff = atk ? 3 : 0;
    b.polygon([[36 + rxOff, 48], [47 + rxOff, 48], [49 + rxOff, 72], [37 + rxOff, 72]], iron, 0.82, 0.2);
    b.polygon([[38 + rxOff, 52], [45 + rxOff, 52], [46 + rxOff, 61], [38 + rxOff, 61]], ironHi, 0.9, 0.14);
    b.line(38 + rxOff, 54, 46 + rxOff, 54, ironSpec, 1, 0.95);
    // Tattered crimson warden tabard between legs
    b.polygon([[25, 45], [38, 45], [40, 63], [35, 68], [32, 61], [28, 69], [23, 62]], clothDark, 0.72, 0.16);
    b.polygon([[27, 46], [36, 46], [36, 60], [31, 57], [27, 63]], cloth, 0.8, 0.12);
    // Hunched sculpted broad-shouldered iron cuirass (tapered gothic silhouette)
    b.polygon(
      [
        [11, 20],
        [52, 20],
        [46, 46],
        [18, 46],
      ],
      ironVoid,
      0.8,
      0.22
    );
    b.polygon(
      [
        [15, 22],
        [48, 22],
        [43, 43],
        [20, 43],
      ],
      iron,
      0.86,
      0.18
    );
    // Iron girdle belt with spiked buckle
    b.polygon([[18, 42], [45, 42], [44, 47], [19, 47]], ironHi, 0.92, 0.12);
    b.rect(29, 41, 6, 6, ironSpec, 0.96, 1);
    // Massive asymmetrical horned jagged shoulder pauldrons
    b.polygon([[4, 18], [21, 14], [24, 30], [9, 32]], iron, 0.9, 0.22);
    b.line(6, 18, 20, 14, ironSpec, 1.4, 0.96);
    b.polygon([[11, 16], [4, 7], [16, 14]], ironHi, 0.94, 0.14);
    b.polygon([[42, 14], [59, 18], [55, 32], [40, 30]], ironHi, 0.92, 0.22);
    b.line(43, 14, 57, 18, ironSpec, 1.4, 0.96);
    b.polygon([[52, 16], [60, 7], [48, 14]], ironSpec, 0.96, 0.14);
    // Incandescent molten furnace ribcage grate glowing inside chest!
    b.polygon([[22, 25], [41, 25], [38, 40], [25, 40]], ironVoid, 0.42, 0.08);
    b.line(23, 27, 40, 27, molten, 2.8, 0.65, molten, 245);
    b.line(24, 32, 39, 32, moltenOrg, 2.4, 0.68, moltenOrg, 245);
    b.line(26, 37, 37, 37, molten, 2.0, 0.65, molten, 230);
    b.ellipse(31.5, 31.5, 3.6, 4.4, coreYel, 0.95, 0.08, coreYel, 255);
    // Brutal horned warden executioner helm tucked forward
    b.polygon([[24, 9], [41, 9], [39, 22], [26, 22]], ironHi, 0.92, 0.18);
    b.polygon([[27, 11], [38, 11], [37, 20], [28, 20]], ironVoid, 0.75, 0.1);
    b.polygon([[25, 11], [17, 2], [28, 8]], ironSpec, 0.96, 0.14);
    b.polygon([[40, 11], [48, 2], [37, 8]], ironSpec, 0.96, 0.14);
    // Piercing fiery amber-white visor slit
    b.rect(28, 14, 10, 2, moltenOrg, 0.98, 0, molten, 255);
    b.rect(30, 14, 6, 2, coreYel, 1.0, 0, coreYel, 255);
    // Colossal chained molten crusher gauntlet arm (windup vs devastating slam!)
    const gx = atk ? 55 : 51;
    const gy = atk ? 32 : 47;
    b.line(47, 25, gx, gy, iron, 7.5, 0.88);
    b.polygon(
      [
        [gx - 7, gy - 7],
        [gx + 7, gy - 6],
        [gx + 6, gy + 7],
        [gx - 6, gy + 7],
      ],
      ironDark,
      0.94,
      0.18
    );
    b.line(gx - 6, gy - 6, gx + 6, gy - 6, ironSpec, 1.5, 0.98);
    b.rect(gx - 4, gy - 2, 8, 4, molten, 0.96, 0, moltenOrg, 245);
    b.pxRgb(gx, gy, coreYel, 1.0, coreYel, 255);
    b.addOutline([10, 8, 16]);
    b.bakeRegionNormals(3.7, false);
  }
  b.alias('boss:Behemoth', 'boss:Behemoth_0');
  b.alias('Behemoth', 'boss:Behemoth_0');

  // 2. TimeKeeper — The Chrono Warden (52x58) — Agile nocturnal clockwork assassin!
  for (let f = 0; f < 2; f++) {
    b.alloc(`boss:TimeKeeper_${f}`, 52, 58, 0.5, 1.0);
    const atk = f === 1;
    const cloakVoid = hexRgb('#0e1326');
    const cloakDark = hexRgb('#182142');
    const cloak = hexRgb('#2a3b70');
    const cloakHi = hexRgb('#4962a8');
    const sashDark = hexRgb('#731225');
    const sashRed = hexRgb('#c4213e');
    const sashHi = hexRgb('#ff4766');
    const gold = hexRgb('#d9a73e');
    const goldHi = hexRgb('#ffe885');
    const chrono = hexRgb('#42f2e0');
    const chronoCore = hexRgb('#d9fffc');

    // Ornate spinning filigree brass astronomical clock halo behind shoulders
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2 + f * 0.25;
      const hx = Math.round(26 + Math.cos(ang) * 15);
      const hy = Math.round(18 + Math.sin(ang) * 15);
      const isCardinal = i % 6 === 0;
      b.pxRgb(hx, hy, isCardinal ? goldHi : gold, 0.86, isCardinal ? chrono : gold, isCardinal ? 190 : 105);
      if (isCardinal) {
        b.line(
          Math.round(26 + Math.cos(ang) * 11),
          Math.round(18 + Math.sin(ang) * 11),
          hx,
          hy,
          goldHi,
          1,
          0.9,
          gold,
          130
        );
      }
    }
    // Sweeping tattered nocturnal cloak tails flowing behind
    b.polygon(
      [
        [20, 19],
        [10, 35],
        [5, 51],
        [13, 47],
        [15, 55],
        [25, 42],
        [33, 52],
        [37, 42],
        [32, 20],
      ],
      cloakVoid,
      0.66,
      0.18
    );
    b.polygon([[21, 21], [13, 37], [14, 48], [24, 38], [31, 45], [31, 21]], cloakDark, 0.74, 0.16);
    // Agile shinobi boots planted in swift lunge stance
    b.line(23, 37, 16, 56, cloakDark, 3.8, 0.8);
    b.line(29, 37, 36 + (atk ? 4 : 0), 56, cloak, 3.8, 0.84);
    b.pxRgb(36 + (atk ? 4 : 0), 55, goldHi, 0.92);
    // Sculpted layered midnight cuirass + gilded shoulder mantle
    b.polygon([[19, 21], [33, 21], [31, 36], [21, 36]], cloak, 0.84, 0.18);
    b.polygon([[21, 22], [31, 22], [29, 32], [23, 32]], cloakHi, 0.9, 0.14);
    b.line(18, 21, 34, 21, goldHi, 1.5, 0.95);
    // Flowing crimson silk waist sash & billowing ribbon tails
    b.polygon([[19, 33], [33, 33], [32, 37], [20, 37]], sashRed, 0.92, 0.1);
    b.line(20, 34, 32, 34, sashHi, 1, 0.95);
    b.polygon([[20, 36], [10, 48 + (atk ? -3 : 2)], [14, 52], [23, 38]], sashDark, 0.84, 0.12);
    b.line(20, 36, 12, 49 + (atk ? -3 : 2), sashHi, 1.2, 0.9);
    // Pointed shadowed assassin cowl + piercing glowing teal chrono-eyes
    b.polygon([[25, 6], [33, 12], [32, 22], [20, 22], [19, 13]], cloak, 0.9, 0.18);
    b.polygon([[20, 12], [14, 16], [19, 19]], cloakDark, 0.82, 0.12);
    b.line(25, 6, 32, 12, cloakHi, 1.2, 0.94);
    b.polygon([[23, 12], [31, 12], [30, 19], [24, 19]], cloakVoid, 0.7, 0.08);
    b.rect(25, 14, 2, 2, chrono, 0.98, 0, chrono, 255);
    b.rect(29, 14, 2, 2, chrono, 0.98, 0, chrono, 255);
    b.pxRgb(26, 14, chronoCore, 1.0, chronoCore, 255);
    b.pxRgb(30, 14, chronoCore, 1.0, chronoCore, 255);
    // Twin sweeping curved glowing chronoblades!
    if (atk) {
      b.line(31, 26, 42, 24, chrono, 3, 0.96, chrono, 225);
      b.line(42, 24, 50, 18, chronoCore, 2.2, 0.98, chrono, 255);
      b.line(20, 27, 10, 22, chrono, 3, 0.96, chrono, 220);
      b.line(10, 22, 2, 16, chronoCore, 2.2, 0.98, chrono, 250);
    } else {
      b.line(31, 26, 43, 18, chrono, 3, 0.96, chrono, 225);
      b.line(43, 18, 49, 8, chronoCore, 2, 0.98, chrono, 255);
      b.line(20, 28, 10, 35, chrono, 3, 0.96, chrono, 215);
      b.line(10, 35, 3, 44, chronoCore, 2, 0.98, chrono, 245);
    }
    b.pxRgb(31, 26, goldHi, 0.96);
    b.pxRgb(20, 28, goldHi, 0.96);
    b.addOutline([10, 8, 18]);
    b.bakeRegionNormals(3.5, false);
  }
  b.alias('boss:TimeKeeper', 'boss:TimeKeeper_0');
  b.alias('TimeKeeper', 'boss:TimeKeeper_0');

  // 3. KingsHand — The Sovereign Hand (76x84) — Towering regal dark-steel executioner!
  for (let f = 0; f < 2; f++) {
    b.alloc(`boss:KingsHand_${f}`, 76, 84, 0.5, 1.0);
    const atk = f === 1;
    const plateVoid = hexRgb('#111829');
    const plateDark = hexRgb('#1d2a45');
    const plate = hexRgb('#344c78');
    const plateHi = hexRgb('#648bc7');
    const plateSpec = hexRgb('#b0cff7');
    const goldDark = hexRgb('#8c631c');
    const gold = hexRgb('#d9aa3f');
    const goldHi = hexRgb('#ffe88a');
    const capeVoid = hexRgb('#470a15');
    const capeDark = hexRgb('#751324');
    const cape = hexRgb('#b01e36');
    const cyan = hexRgb('#4ed8ff');
    const cyanCore = hexRgb('#e0fbff');

    // Grand sweeping tattered royal crimson cape behind armor
    b.polygon(
      [
        [18, 21],
        [44, 21],
        [40, 74],
        [33, 81],
        [27, 75],
        [20, 82],
        [14, 75],
        [8, 80],
        [11, 52],
      ],
      capeVoid,
      0.62,
      0.16
    );
    b.polygon([[20, 24], [38, 24], [34, 72], [26, 70], [18, 76], [14, 54]], capeDark, 0.7, 0.14);
    b.polygon([[22, 26], [34, 26], [30, 62], [21, 65]], cape, 0.76, 0.12);
    // Heavy articulated fluted armored greaves (planted solidly at y=83)
    b.polygon([[24, 53], [36, 53], [35, 82], [22, 82]], plateDark, 0.84, 0.2);
    b.polygon([[26, 56], [33, 56], [32, 76], [25, 76]], plate, 0.88, 0.14);
    b.polygon([[41, 53], [53, 53], [55, 82], [42, 82]], plate, 0.86, 0.2);
    b.polygon([[43, 56], [50, 56], [51, 76], [44, 76]], plateHi, 0.92, 0.14);
    // Gilded knee cops
    b.polygon([[24, 61], [35, 61], [33, 66], [26, 66]], gold, 0.95, 0.1);
    b.polygon([[42, 61], [53, 61], [51, 66], [44, 66]], goldHi, 0.96, 0.1);
    // Layered armored battle-tassets & sculpted gothic breastplate
    b.polygon([[21, 44], [55, 44], [52, 57], [24, 57]], plateVoid, 0.84, 0.18);
    b.line(23, 48, 53, 48, goldDark, 1.5, 0.9);
    b.line(24, 53, 52, 53, gold, 1.5, 0.92);
    b.polygon([[20, 21], [56, 21], [51, 45], [25, 45]], plate, 0.88, 0.22);
    b.polygon([[25, 24], [51, 24], [47, 41], [29, 41]], plateHi, 0.92, 0.16);
    // Vertical gilded chest spine & beveled filigree
    b.polygon([[36, 22], [41, 22], [40, 44], [37, 44]], gold, 0.95, 0.12);
    b.line(38, 23, 38, 43, goldHi, 1, 0.98);
    // Towering spiked royal dark-steel pauldrons with crisp gold trim
    b.polygon([[10, 17], [27, 15], [28, 32], [12, 30]], plateDark, 0.92, 0.22);
    b.line(11, 17, 26, 15, goldHi, 2, 0.97);
    b.polygon([[16, 17], [9, 8], [21, 16]], plateSpec, 0.96, 0.14);
    b.polygon([[49, 15], [66, 17], [64, 30], [48, 32]], plate, 0.94, 0.22);
    b.line(50, 15, 65, 17, goldHi, 2, 0.97);
    b.polygon([[60, 17], [67, 8], [55, 16]], plateSpec, 0.96, 0.14);
    // Crowned Sovereign Iron Executioner Helm
    b.polygon([[30, 8], [47, 8], [45, 22], [32, 22]], plateHi, 0.94, 0.18);
    b.polygon([[33, 10], [44, 10], [43, 20], [34, 20]], plateVoid, 0.8, 0.1);
    // Five-point serrated golden royal crown
    b.rect(30, 5, 17, 3, gold, 0.96);
    b.polygon([[30, 5], [31, 0], [34, 5]], goldHi, 0.98, 0.1);
    b.polygon([[36, 5], [38.5, 0], [41, 5]], goldHi, 0.98, 0.1);
    b.polygon([[43, 5], [46, 0], [47, 5]], goldHi, 0.98, 0.1);
    // Piercing cold-cyan visor slit (surgical emissive glow!)
    b.rect(34, 13, 10, 2, cyan, 0.98, 0, cyan, 250);
    b.rect(36, 13, 6, 2, cyanCore, 1.0, 0, cyanCore, 255);
    // Iconic Colossal Symmetrical Twin-Bladed Lance!
    if (atk) {
      b.line(3, 38, 74, 34, plateSpec, 3.6, 0.94);
      b.polygon([[54, 35], [75, 34], [58, 39], [56, 31]], cyan, 0.96, 0.1, cyan, 235);
      b.line(58, 35, 74, 34, cyanCore, 1.5, 1.0, cyanCore, 255);
      b.polygon([[20, 37], [2, 38], [16, 34], [18, 41]], cyan, 0.94, 0.1, cyan, 205);
    } else {
      b.line(16, 70, 67, 7, plateSpec, 3.6, 0.94);
      b.polygon([[52, 24], [69, 4], [61, 21], [54, 16]], cyan, 0.96, 0.1, cyan, 235);
      b.line(56, 20, 68, 6, cyanCore, 1.5, 1.0, cyanCore, 255);
      b.polygon([[25, 59], [11, 75], [22, 68], [18, 61]], cyan, 0.94, 0.1, cyan, 205);
    }
    b.addOutline([10, 8, 16]);
    b.bakeRegionNormals(3.7, false);
  }
  b.alias('boss:KingsHand', 'boss:KingsHand_0');
  b.alias('KingsHand', 'boss:KingsHand_0');
}

// =============================================================================
// Pickups, Turrets, Projectiles, Weapons/Skills Icons, VFX & Pixel Font
// =============================================================================

function paintPickupsTurretsProjectiles(b: PixelAtlasBuilder): void {
  const gold = hexRgb('#ffd447');
  const goldHi = hexRgb('#fff7b2');
  const cyan = hexRgb('#4ee8ff');
  const red = hexRgb('#ff4252');
  const violet = hexRgb('#b85cff');
  const green = hexRgb('#4dff88');
  const steel = hexRgb('#d0dcf0');

  // Pickups (16x16)
  b.alloc('pickup:gold', 12, 12, 0.5, 0.5);
  b.ellipse(6, 6, 4.2, 4.5, gold, 0.9, 0.1, gold, 180);
  b.ellipse(5, 5, 1.8, 2.0, goldHi, 0.98, 0.02, goldHi, 220);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('pickup:cell', 14, 16, 0.5, 0.5);
  b.ellipse(7, 8, 5.0, 6.0, hexRgb('#1f9ec9'), 0.85, 0.15, cyan, 235);
  b.ellipse(7, 7, 3.0, 3.6, cyan, 0.95, 0.05, cyan, 255);
  b.pxRgb(6, 6, [255, 255, 255], 1.0, [255, 255, 255], 255);
  b.bakeRegionNormals(2.4, false);

  b.alloc('pickup:food', 16, 14, 0.5, 0.5);
  b.ellipse(9, 7, 5.5, 4.5, hexRgb('#c76b30'), 0.86, 0.14);
  b.line(2, 7, 6, 7, hexRgb('#f0e8d5'), 2.5, 0.9);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  const paintScroll = (key: string, c1: RGB, c2: RGB): void => {
    b.alloc(key, 16, 18, 0.5, 0.5);
    b.rect(4, 3, 8, 12, hexRgb('#f0dfb8'), 0.88, 1, c1, 140);
    b.rect(2, 2, 12, 3, c1, 0.94, 0, c1, 240);
    b.rect(2, 13, 12, 3, c2, 0.94, 0, c2, 240);
    b.rect(6, 7, 4, 4, c1, 0.95, 0, c1, 255);
    b.addOutline();
    b.bakeRegionNormals(2.8, false);
  };
  paintScroll('pickup:scroll_brutality', red, red);
  paintScroll('pickup:scroll_tactics', violet, violet);
  paintScroll('pickup:scroll_survival', green, green);
  paintScroll('pickup:scroll_dual', gold, violet);

  b.alloc('pickup:flask', 14, 18, 0.5, 0.5);
  b.rect(5, 2, 4, 4, hexRgb('#b8956a'), 0.88);
  b.ellipse(7, 11, 5, 5.5, green, 0.9, 0.1, green, 245);
  b.addOutline();
  b.bakeRegionNormals(2.8, false);

  b.alloc('pickup:blueprint', 16, 16, 0.5, 0.5);
  b.rect(2, 3, 12, 10, hexRgb('#20579e'), 0.86, 1, cyan, 190);
  b.line(4, 6, 12, 6, cyan, 1, 0.95, cyan, 255);
  b.line(4, 9, 10, 9, cyan, 1, 0.95, cyan, 255);
  b.addOutline();
  b.bakeRegionNormals(2.8, false);

  // Gear pedestal drop icons (18x18)
  b.alloc('pickup:gear_sword', 18, 18, 0.5, 0.5);
  b.line(4, 14, 14, 4, steel, 3, 0.94, cyan, 120);
  b.line(4, 10, 8, 14, gold, 2.5, 0.96);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('pickup:gear_bow', 18, 18, 0.5, 0.5);
  b.line(5, 3, 13, 9, hexRgb('#a86e42'), 2.5, 0.9);
  b.line(13, 9, 5, 15, hexRgb('#a86e42'), 2.5, 0.9);
  b.line(5, 4, 5, 14, hexRgb('#e0e6f0'), 1, 0.85);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('pickup:gear_shield', 18, 18, 0.5, 0.5);
  b.ellipse(9, 9, 6, 7, hexRgb('#5c6f94'), 0.9, 0.1);
  b.rect(8, 3, 2, 12, gold, 0.96);
  b.addOutline();
  b.bakeRegionNormals(3.2, false);

  b.alloc('pickup:gear_skill', 18, 18, 0.5, 0.5);
  b.ellipse(9, 9, 6, 6, violet, 0.9, 0.1, violet, 210);
  b.ellipse(9, 9, 2.5, 2.5, goldHi, 0.98, 0.02, goldHi, 255);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  // Turrets & Deployables (24x24 / 24x40)
  b.alloc('turret:sinew', 22, 22, 0.5, 1.0);
  b.rect(5, 15, 12, 7, hexRgb('#4c5469'), 0.84, 1);
  b.ellipse(11, 10, 7, 7, steel, 0.94, 0.06, red, 130);
  b.ellipse(11, 10, 2.5, 2.5, red, 0.98, 0.02, red, 240);
  b.addOutline();
  b.bakeRegionNormals(3.2, false);

  b.alloc('turret:heavy', 26, 22, 0.5, 1.0);
  b.rect(5, 14, 16, 8, hexRgb('#695036'), 0.84, 1);
  b.rect(4, 7, 19, 6, gold, 0.92, 1);
  b.rect(20, 8, 4, 4, hexRgb('#ff8c38'), 0.96, 0, hexRgb('#ff8c38'), 230);
  b.addOutline();
  b.bakeRegionNormals(3.2, false);

  b.alloc('turret:wolfTrap', 22, 10, 0.5, 1.0);
  b.rect(2, 6, 18, 4, hexRgb('#5e6880'), 0.88, 1);
  for (let x = 4; x <= 18; x += 4) b.pxRgb(x, 4, steel, 0.96);
  b.pxRgb(11, 6, red, 0.98, red, 220);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  b.alloc('turret:bossBanner', 22, 42, 0.5, 1.0);
  b.rect(10, 2, 2, 40, gold, 0.92);
  b.rect(4, 6, 14, 22, hexRgb('#a81f32'), 0.84, 1, red, 180);
  b.ellipse(11, 16, 4, 5, goldHi, 0.95, 0.05, goldHi, 255);
  b.addOutline();
  b.bakeRegionNormals(3.0, false);

  // Projectiles
  const projDefs: Array<[string, number, number, RGB, RGB]> = [
    ['proj:arrow', 14, 6, hexRgb('#c7975c'), hexRgb('#e8f2ff')],
    ['proj:knife', 12, 6, steel, red],
    ['proj:fireball', 14, 14, hexRgb('#ff621c'), hexRgb('#fff08a')],
    ['proj:iceArrow', 16, 6, hexRgb('#52d4ff'), hexRgb('#e0faff')],
    ['proj:lightning', 18, 8, hexRgb('#66e8ff'), [255, 255, 255]],
    ['proj:enemyBolt', 14, 8, hexRgb('#ff3d5c'), hexRgb('#ffd4a3')],
    ['proj:grenade', 12, 12, hexRgb('#383e4f'), hexRgb('#ff9b3d')],
    ['proj:cluster', 14, 14, hexRgb('#593a40'), hexRgb('#ff5733')],
    ['proj:shuriken', 12, 12, cyan, [255, 255, 255]],
    ['proj:shockwave', 22, 16, hexRgb('#ff7b38'), hexRgb('#ffe885')],
    ['proj:fallingSword', 10, 24, cyan, goldHi],
    ['proj:hook', 14, 10, gold, cyan],
    ['proj:laserBeam', 24, 8, hexRgb('#ff2e63'), hexRgb('#ffc7d9')],
    ['proj:acidSpit', 12, 12, hexRgb('#57e82a'), hexRgb('#c8ff75')],
  ];
  for (const [key, w, h, c1, c2] of projDefs) {
    b.alloc(key, w, h, 0.5, 0.5);
    if (key === 'proj:fallingSword') {
      b.rect(4, 2, 2, 18, c1, 0.94, 0, c1, 240);
      b.rect(2, 5, 6, 2, c2, 0.96, 0, c2, 240);
    } else if (w > h * 1.4) {
      b.rect(1, Math.floor(h / 2) - 1, w - 2, 3, c1, 0.88, 0, c1, 220);
      b.rect(w - 5, Math.floor(h / 2) - 2, 4, 4, c2, 0.96, 0, c2, 255);
    } else {
      b.ellipse(w / 2, h / 2, w * 0.4, h * 0.4, c1, 0.88, 0.12, c1, 240);
      b.ellipse(w / 2, h / 2, w * 0.2, h * 0.2, c2, 0.96, 0.04, c2, 255);
    }
    b.bakeRegionNormals(2.4, false);
  }

  // Register weapon & skill sprite keys (16x16 icons) so every catalog spriteKey resolves cleanly!
  for (let i = 0; i < WEAPON_ICON_IDS.length; i++) {
    const id = WEAPON_ICON_IDS[i];
    const key = `weapon:${id}`;
    const isShield = id.includes('Shield');
    const isBow = id.includes('Bow') || id === 'ThrowingKnife' || id === 'Fireball';
    b.alloc(key, 16, 16, 0.5, 0.5);
    const hueCol: RGB = isShield
      ? hexRgb('#52c97a')
      : isBow
      ? hexRgb('#b062ff')
      : hexRgb('#ff5766');
    if (isShield) {
      b.ellipse(8, 8, 5.5, 6.5, hueCol, 0.9, 0.1);
      b.rect(7, 3, 2, 10, goldHi, 0.96);
    } else if (isBow) {
      b.line(4, 3, 12, 8, hueCol, 2.5, 0.9);
      b.line(12, 8, 4, 13, hueCol, 2.5, 0.9);
      b.pxRgb(12, 8, goldHi, 0.96, goldHi, 220);
    } else {
      b.line(3, 13, 13, 3, steel, 2.5, 0.94, hueCol, 160);
      b.line(3, 9, 7, 13, gold, 2, 0.96);
    }
    b.addOutline();
    b.bakeRegionNormals(2.8, false);
    b.alias(id, key);
  }

  for (let i = 0; i < SKILL_ICON_IDS.length; i++) {
    const id = SKILL_ICON_IDS[i];
    const key = `skill:${id}`;
    b.alloc(key, 16, 16, 0.5, 0.5);
    const col: RGB = id.includes('Grenade')
      ? hexRgb('#ff6b38')
      : id.includes('Turret') || id === 'SinewSlicer' || id === 'WaveOfDenial' || id === 'Phaser'
      ? hexRgb('#a85cff')
      : hexRgb('#42e38d');
    b.ellipse(8, 8, 5.5, 5.5, col, 0.9, 0.1, col, 210);
    b.ellipse(8, 8, 2.2, 2.2, [255, 255, 255], 0.98, 0.02, col, 255);
    b.addOutline();
    b.bakeRegionNormals(2.8, false);
    b.alias(id, key);
  }
}

function paintVfxAndPixelFont(b: PixelAtlasBuilder): void {
  // 4x4 Solid White Pixel (for colored quads, scarf chain, beams, bars)
  b.alloc('vfx:white_px', 4, 4, 0.5, 0.5);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      b.px(x, y, 255, 255, 255, 255, 0.5);
      b.setNormalDirect(x, y, 0, 0, 1);
    }
  }

  // Sweeping Crescent Weapon Slash Arcs (3 frames + heavy cleave) — tinted dynamically by vertex color!
  const paintSlash = (key: string, w: number, h: number, thickness: number, arcStart: number, arcEnd: number): void => {
    b.alloc(key, w, h, 0.25, 0.5);
    const cx = w * 0.24;
    const cy = h * 0.52;
    const rx = w * 0.72;
    const ry = h * 0.46;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const dist = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        if (ang < arcStart || ang > arcEnd) continue;
        const angNorm = (ang - arcStart) / (arcEnd - arcStart);
        const taper = Math.sin(angNorm * Math.PI); // thin tips, wide leading belly
        const outerR = 1.0;
        const innerR = Math.max(0.15, outerR - thickness * taper);
        if (dist <= outerR && dist >= innerR) {
          const edgeFrac = (dist - innerR) / Math.max(0.01, outerR - innerR);
          const alpha = clampByte((0.35 + 0.65 * Math.pow(edgeFrac, 0.7)) * taper * 255);
          const core = edgeFrac > 0.72 ? 255 : clampByte(190 + edgeFrac * 65);
          b.px(x, y, core, core, 255, alpha, 0.9, core, core, 255, alpha);
          b.setNormalDirect(x, y, 0, 0, 1);
        }
      }
    }
  };
  paintSlash('vfx:slash_0', 48, 36, 0.44, -1.25, 1.15);
  paintSlash('vfx:slash_1', 48, 36, 0.38, -1.05, 1.35);
  paintSlash('vfx:slash_2', 52, 40, 0.52, -1.4, 1.25);
  paintSlash('vfx:slash_heavy', 64, 44, 0.56, -1.5, 1.4);

  // Iconic Golden `!` Enemy Attack Telegraph Glyph (16x22) — crisp separated shaft & diamond dot!
  b.alloc('vfx:telegraph', 16, 22, 0.5, 1.0);
  const goldCore = hexRgb('#fffbe0');
  const goldMid = hexRgb('#ffcf38');
  const goldOut = hexRgb('#ff7a1a');
  // Tapered upper exclamation shaft (strictly y=2..12, clean gap y=13..15 before dot!)
  b.polygon([[5, 2], [11, 2], [9, 12], [7, 12]], goldOut, 0.92, 0, goldOut, 230);
  b.rect(6, 3, 4, 8, goldMid, 0.96, 0, goldMid, 255);
  b.rect(7, 4, 2, 6, goldCore, 1.0, 0, goldCore, 255);
  // Separated diamond dot (y=16..20)
  b.rect(6, 16, 4, 4, goldMid, 0.96, 0, goldMid, 255);
  b.rect(7, 17, 2, 2, goldCore, 1.0, 0, goldCore, 255);
  b.addOutline([20, 8, 10]);
  b.bakeRegionNormals(2.0, false);

  // Concentric Golden Parry Starburst Ring (48x48)
  b.alloc('vfx:parry_ring', 48, 48, 0.5, 0.5);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dx = x - 23.5;
      const dy = y - 23.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const star = Math.abs(Math.cos(ang * 4));
      const ring = Math.exp(-Math.pow((r - 18) / 2.2, 2));
      const flare = r < 22 ? Math.pow(star, 8) * (1 - r / 22) : 0;
      const intensity = Math.min(1, ring + flare * 0.9);
      if (intensity > 0.08) {
        const a = clampByte(intensity * 255);
        b.px(x, y, 255, 240, 150, a, 0.9, 255, 220, 100, a);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // Concierge Crimson Aura Ring (64x64)
  b.alloc('vfx:aura_ring', 64, 64, 0.5, 0.5);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const dx = x - 31.5;
      const dy = y - 31.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const jag = Math.sin(ang * 12) * 1.6;
      const d = Math.abs(r - (27 + jag));
      if (d < 4.5) {
        const k = 1 - d / 4.5;
        const a = clampByte(k * 235);
        b.px(x, y, 255, clampByte(70 + k * 140), clampByte(35 + k * 45), a, 0.9, 255, clampByte(55 + k * 110), 25, a);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // Hexagonal Cyan Shield Dome (48x48) — airy thin rim with delicate translucent interior
  b.alloc('vfx:shield_dome', 48, 48, 0.5, 0.5);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dx = x - 23.5;
      const dy = y - 23.5;
      const r = Math.hypot(dx, dy);
      if (r <= 22.5 && r >= 19.6) {
        const k = Math.exp(-Math.pow((r - 21.1) / 1.15, 2));
        const grid = ((x + y) % 6 === 0 || (x - y + 64) % 6 === 0) ? 1.15 : 0.9;
        const a = clampByte(Math.min(1, k * grid) * 195);
        if (a > 12) {
          b.px(x, y, 130, 244, 255, a, 0.9, 105, 238, 255, a);
          b.setNormalDirect(x, y, 0, 0, 1);
        }
      } else if (r < 19.6) {
        const grid = ((x + y) % 9 === 0) ? 20 : 6;
        b.px(x, y, 90, 225, 255, grid, 0.7, 70, 210, 255, grid);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // Crisp VFX Particle Sprites (spark, ember, drop, cog)
  b.alloc('vfx:spark', 8, 8, 0.5, 0.5);
  b.line(1, 4, 6, 4, [255, 255, 255], 1, 0.95, [255, 255, 255], 255);
  b.line(4, 1, 4, 6, [255, 255, 255], 1, 0.95, [255, 255, 255], 255);
  b.ellipse(4, 4, 1.6, 1.6, [255, 255, 255], 1.0, 0, [255, 255, 255], 255);

  b.alloc('vfx:ember', 6, 6, 0.5, 0.5);
  b.ellipse(3, 3, 2.2, 2.2, [255, 240, 200], 0.95, 0.05, [255, 230, 180], 255);

  b.alloc('vfx:drop', 6, 10, 0.5, 0.5);
  b.line(3, 1, 3, 8, [220, 245, 255], 2, 0.9, [200, 240, 255], 180);

  b.alloc('vfx:cog', 12, 12, 0.5, 0.5);
  const brass = hexRgb('#e0b145');
  b.ellipse(6, 6, 4.2, 4.2, brass, 0.9, 0.1, brass, 110);
  b.ellipse(6, 6, 1.6, 1.6, hexRgb('#1a141c'), 0.2, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.pxRgb(Math.round(6 + Math.cos(a) * 5), Math.round(6 + Math.sin(a) * 5), brass, 0.95);
  }
  b.bakeRegionNormals(2.6, false);

  // Explosive Skill VFX Sprites: Fireball Burst, Ice Burst, Shockwave Ring
  // 1. Fireball Burst (48x48) — multi-layered jagged fiery explosion with incandescent core
  b.alloc('vfx:fireball_burst', 48, 48, 0.5, 0.5);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dx = x - 23.5;
      const dy = y - 23.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const tongues =
        Math.sin(ang * 7 + 0.4) * 2.8 +
        Math.cos(ang * 13 - 0.8) * 1.6 +
        (hash2(x, y, 911) - 0.5) * 1.8;
      const maxR = 20.5 + tongues;
      if (r <= maxR) {
        const frac = r / Math.max(1, maxR);
        let cr: number;
        let cg: number;
        let cb: number;
        let alpha: number;
        if (frac < 0.28) {
          cr = 255;
          cg = 250;
          cb = 210;
          alpha = 255;
        } else if (frac < 0.58) {
          const t = (frac - 0.28) / 0.3;
          cr = 255;
          cg = clampByte(225 - t * 110);
          cb = clampByte(115 - t * 90);
          alpha = 245;
        } else {
          const t = (frac - 0.58) / 0.42;
          cr = clampByte(245 - t * 75);
          cg = clampByte(95 - t * 70);
          cb = clampByte(28 - t * 14);
          alpha = clampByte((1 - t * 0.82) * 235);
        }
        b.px(x, y, cr, cg, cb, alpha, 0.9, cr, cg, cb, alpha);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // 2. Ice Burst (48x48) — sharp 8-pointed crystalline glacial starburst + frost halo
  b.alloc('vfx:ice_burst', 48, 48, 0.5, 0.5);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dx = x - 23.5;
      const dy = y - 23.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const majorSpike = Math.pow(Math.abs(Math.cos(ang * 4)), 5);
      const minorSpike = Math.pow(Math.abs(Math.cos(ang * 4 + Math.PI * 0.25)), 7);
      const starR = 11.5 + majorSpike * 11.5 + minorSpike * 6.5;
      const frostRing = Math.exp(-Math.pow((r - 17.5) / 1.8, 2));
      if (r <= starR || frostRing > 0.25) {
        const core = r < 6.5 ? 1.0 : Math.max(0, 1 - r / Math.max(1, starR));
        const k = Math.min(1, Math.max(core, frostRing * 0.85));
        const cr = clampByte(120 + k * 135);
        const cg = clampByte(225 + k * 30);
        const cb = 255;
        const alpha = clampByte(Math.min(1, 0.25 + k * 0.85) * 245);
        b.px(x, y, cr, cg, cb, alpha, 0.92, cr, cg, cb, alpha);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // 3. Shockwave Ring (56x56) — ULTRA-CLEAN RAZOR-THIN 2-3px glowing energy ring (ZERO thick donut!)
  b.alloc('vfx:shockwave_ring', 56, 56, 0.5, 0.5);
  for (let y = 0; y < 56; y++) {
    for (let x = 0; x < 56; x++) {
      const dx = x - 27.5;
      const dy = y - 27.5;
      const r = Math.hypot(dx, dy);
      if (r < 20.5 || r > 27.2) continue;
      const core = Math.exp(-Math.pow((r - 24.6) / 1.05, 2));
      const halo = Math.exp(-Math.pow((r - 24.4) / 2.1, 2)) * 0.28;
      const intensity = Math.min(1, core + halo);
      if (intensity > 0.08) {
        const cr = clampByte(205 + core * 50);
        const cg = clampByte(235 + core * 20);
        const cb = 255;
        const alpha = clampByte(intensity * 230);
        b.px(x, y, cr, cg, cb, alpha, 0.94, cr, cg, cb, alpha);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // 4. Orbiting Stun Stars Halo (24x12) — Dead Cells dual 4-point golden stun stars (ref_05 & ref_12)
  b.alloc('vfx:stun_stars', 24, 12, 0.5, 0.5);
  const stunDark: RGB = [16, 12, 22];
  const stunGold: RGB = [255, 222, 68];
  const stunWhite: RGB = [255, 253, 228];
  // Delicate tilted orbital ring connecting the two stars
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const ox = Math.round(12 + Math.cos(a) * 8.5);
    const oy = Math.round(6 + Math.sin(a) * 3.1);
    b.px(ox, oy, 255, 224, 120, 130, 0.85, 255, 210, 90, 110);
  }
  const paintStunStar = (sx: number, sy: number): void => {
    // 1px dark outline behind star arms for crisp readability on bright VFX
    b.pxRgb(sx, sy - 3, stunDark, 0.9);
    b.pxRgb(sx, sy + 3, stunDark, 0.9);
    b.pxRgb(sx - 3, sy, stunDark, 0.9);
    b.pxRgb(sx + 3, sy, stunDark, 0.9);
    b.pxRgb(sx - 1, sy - 1, stunDark, 0.9);
    b.pxRgb(sx + 1, sy - 1, stunDark, 0.9);
    b.pxRgb(sx - 1, sy + 1, stunDark, 0.9);
    b.pxRgb(sx + 1, sy + 1, stunDark, 0.9);
    // Golden 4-point arms
    b.pxRgb(sx, sy - 2, stunGold, 1.0, stunGold, 245);
    b.pxRgb(sx, sy - 1, stunGold, 1.0, stunGold, 255);
    b.pxRgb(sx, sy + 1, stunGold, 1.0, stunGold, 255);
    b.pxRgb(sx, sy + 2, stunGold, 1.0, stunGold, 245);
    b.pxRgb(sx - 2, sy, stunGold, 1.0, stunGold, 245);
    b.pxRgb(sx - 1, sy, stunGold, 1.0, stunGold, 255);
    b.pxRgb(sx + 1, sy, stunGold, 1.0, stunGold, 255);
    b.pxRgb(sx + 2, sy, stunGold, 1.0, stunGold, 245);
    b.pxRgb(sx, sy, stunWhite, 1.0, stunWhite, 255);
  };
  paintStunStar(5, 5);
  paintStunStar(18, 7);
  b.bakeRegionNormals(1.5, false);

  // ===========================================================================
  // Painterly Weapon Slash Smears, Shield Guard, Parry Burst, Splinters, Gibs,
  // Floor Decals, 4-Frame Spinning Coins, Curse Skull & Unparriable `!!`
  // ===========================================================================

  const paintPainterlyArc = (
    key: string,
    w: number,
    h: number,
    thickness: number,
    arcStart: number,
    arcEnd: number,
    coreRgb: RGB,
    midRgb: RGB,
    rimRgb: RGB,
    seed: number
  ): void => {
    b.alloc(key, w, h, 0.24, 0.5);
    const cx = w * 0.22;
    const cy = h * 0.5;
    const rx = w * 0.74;
    const ry = h * 0.46;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const dist = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        if (ang < arcStart || ang > arcEnd) continue;
        const angNorm = (ang - arcStart) / (arcEnd - arcStart);
        // Asymmetric Dead Cells smear curve: razor lead tip, fat painterly belly, feathered tail!
        const leadBias = Math.pow(Math.sin(angNorm * Math.PI), 0.72) * (0.65 + 0.45 * angNorm);
        const featherNoise = (hash2(Math.floor(angNorm * 28), Math.floor(dist * 14), seed) - 0.5) * 0.14;
        const outerR = 1.0;
        const innerR = Math.max(0.12, outerR - thickness * leadBias + featherNoise);
        if (dist <= outerR && dist >= innerR) {
          const edgeFrac = (dist - innerR) / Math.max(0.01, outerR - innerR);
          // Jagged painterly trailing streaks on inner tail
          const streakCut = edgeFrac < 0.32 && hash2(x, Math.floor(angNorm * 36), seed + 7) > edgeFrac * 3.1;
          if (streakCut) continue;
          const col =
            edgeFrac > 0.76
              ? coreRgb
              : edgeFrac > 0.36
              ? mixRgb(midRgb, coreRgb, (edgeFrac - 0.36) / 0.4)
              : mixRgb(rimRgb, midRgb, edgeFrac / 0.36);
          const alpha = clampByte(Math.min(1, (0.35 + 0.65 * Math.pow(edgeFrac, 0.55)) * Math.min(1, leadBias * 1.45)) * 255);
          b.px(x, y, col[0], col[1], col[2], alpha, 0.95, col[0], col[1], col[2], alpha);
          b.setNormalDirect(x, y, 0, 0, 1);
        }
      }
    }
  };

  // 1. Blade Smears (3 combo arcs)
  paintPainterlyArc('vfx:slash_blade_0', 56, 42, 0.46, -1.25, 1.12, [255, 255, 255], hexRgb('#8ceeff'), hexRgb('#2a88d4'), 11);
  paintPainterlyArc('vfx:slash_blade_1', 56, 42, 0.42, -1.05, 1.32, [255, 255, 255], hexRgb('#a8f4ff'), hexRgb('#3b9ce8'), 22);
  paintPainterlyArc('vfx:slash_blade_2', 60, 46, 0.54, -1.38, 1.28, hexRgb('#fff8c4'), hexRgb('#ffd454'), hexRgb('#ff5e2b'), 33);

  // 2. Heavy Overhead Cleave Smears (2 massive frames)
  paintPainterlyArc('vfx:slash_heavy_0', 68, 56, 0.60, -1.48, 1.38, hexRgb('#fffbe0'), hexRgb('#ffb838'), hexRgb('#e03428'), 44);
  paintPainterlyArc('vfx:slash_heavy_1', 68, 56, 0.54, -1.22, 1.48, [255, 255, 255], hexRgb('#ffe070'), hexRgb('#ff621c'), 55);

  // 3. Piercing Lance / Rapier Thrust Streaks (2 frames, 72x20)
  for (let f = 0; f < 2; f++) {
    b.alloc(`vfx:slash_thrust_${f}`, 72, 20, 0.14, 0.5);
    const cy = 9.5;
    const tipX = f === 0 ? 69 : 66;
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 72; x++) {
        const dy = Math.abs(y - cy);
        const t = x / tipX;
        if (x > tipX) continue;
        const halfH = t < 0.72 ? 1.5 + t * (f === 0 ? 5.2 : 6.4) : Math.max(0.5, (1 - (t - 0.72) / 0.28) * 6.0);
        const shockRing = Math.abs(x - (f === 0 ? 22 : 30)) <= 1.8 && dy < 8.5 && dy > 2.2;
        if (dy <= halfH || shockRing) {
          const core = dy < halfH * 0.38 && t > 0.25;
          const col = core ? ([255, 255, 255] as const) : dy < halfH * 0.72 ? hexRgb('#8cf2ff') : hexRgb('#3694e8');
          const alpha = shockRing
            ? clampByte((1 - dy / 8.5) * 210)
            : clampByte(Math.min(1, (0.28 + t * 0.78) * (1 - (dy / Math.max(0.5, halfH)) * 0.55)) * 255);
          b.px(x, y, col[0], col[1], col[2], alpha, 0.95, col[0], col[1], col[2], alpha);
          b.setNormalDirect(x, y, 0, 0, 1);
        }
      }
    }
  }

  // 4. Twin Dagger X-Cross Slashes (2 frames, 52x44)
  for (let f = 0; f < 2; f++) {
    b.alloc(`vfx:slash_twin_${f}`, 52, 44, 0.28, 0.5);
    const c1 = f === 0 ? hexRgb('#8cf5ff') : hexRgb('#ffe875');
    const c2 = f === 0 ? hexRgb('#ff4266') : hexRgb('#ff6238');
    // Intersecting razor arcs forming dramatic X-cross
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const bend = Math.sin(t * Math.PI) * 7.5;
      const xA = 4 + t * 44;
      const yA = 6 + t * 32 - bend;
      const xB = 6 + t * 42;
      const yB = 37 - t * 30 - bend * 0.75;
      const wA = Math.max(1.2, Math.sin(t * Math.PI) * 5.2);
      b.line(xA, yA, xA + 1, yA, c2, wA + 2, 0.92, c2, 220);
      b.line(xA, yA, xA + 1, yA, c1, wA * 0.65, 0.96, c1, 250);
      b.line(xB, yB, xB + 1, yB, c2, wA + 1.5, 0.92, c2, 210);
      b.line(xB, yB, xB + 1, yB, [255, 255, 255], wA * 0.45, 0.98, [255, 255, 255], 255);
    }
    // Hot intersection diamond glint
    b.ellipse(26, 20, 4.2, 4.2, [255, 255, 255], 1.0, 0.0, [255, 255, 255], 255);
  }

  // 5. Electric / Valmont Whip Lash Arcs (2 frames, 68x32)
  for (let f = 0; f < 2; f++) {
    b.alloc(`vfx:slash_whip_${f}`, 68, 32, 0.12, 0.5);
    const whipOuter = hexRgb('#9d4dff');
    const whipMid = hexRgb('#4eeeff');
    let prevX = 2;
    let prevY = 16;
    for (let seg = 1; seg <= 16; seg++) {
      const t = seg / 16;
      const nx = 2 + t * 63;
      const amp = (4 + t * 8.5) * (f === 0 ? 1 : -1);
      const jag = (hash2(seg, f, 731) - 0.5) * 4.5;
      const ny = 16 + Math.sin(t * Math.PI * 2.2 + f * 1.4) * amp + jag;
      const thick = 3.2 - t * 1.5;
      b.line(prevX, prevY, nx, ny, whipOuter, thick + 2.2, 0.9, whipOuter, 210);
      b.line(prevX, prevY, nx, ny, whipMid, thick, 0.95, whipMid, 245);
      b.line(prevX, prevY, nx, ny, [255, 255, 255], Math.max(1, thick * 0.45), 1.0, [255, 255, 255], 255);
      if (seg % 4 === 0 && seg < 15) {
        b.line(nx, ny, nx + 5, ny + (seg % 8 === 0 ? -7 : 7), whipMid, 1, 0.94, whipMid, 210);
      }
      prevX = nx;
      prevY = ny;
    }
    // Crackling whip tip starburst
    b.ellipse(prevX, prevY, 4.0, 4.0, [255, 255, 255], 1.0, 0, whipMid, 255);
  }

  // 6. Held Metallic Buckler / Tower Shield Guard Flash (22x34)
  b.alloc('vfx:shield_guard', 22, 34, 0.45, 0.5);
  const shSteel = hexRgb('#5c7299');
  const shHi = hexRgb('#b8d0f2');
  const shGold = hexRgb('#f0be4a');
  const shWard = hexRgb('#6cf2ff');
  b.polygon([[3, 5], [14, 2], [18, 10], [18, 24], [13, 32], [3, 28], [5, 17]], shSteel, 0.86, 0.18);
  b.polygon([[5, 7], [13, 5], [15, 12], [15, 22], [12, 28], [6, 25]], shHi, 0.92, 0.14);
  b.line(13, 3, 18, 10, shGold, 2.2, 0.96, shGold, 150);
  b.line(18, 10, 18, 24, shGold, 2.2, 0.96, shGold, 165);
  b.line(18, 24, 13, 31, shGold, 2.2, 0.96, shGold, 150);
  // Kinetic ward shimmer along leading shield face
  b.line(19, 6, 21, 17, shWard, 2, 0.98, shWard, 240);
  b.line(21, 17, 19, 28, shWard, 2, 0.98, shWard, 240);
  b.addOutline([12, 14, 24]);
  b.bakeRegionNormals(3.3, false);

  // 7. Explosive Golden Parry Burst Starburst (60x60)
  b.alloc('vfx:parry_burst', 60, 60, 0.5, 0.5);
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < 60; x++) {
      const dx = x - 29.5;
      const dy = y - 29.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const cross4 = Math.pow(Math.abs(Math.cos(ang * 2)), 14) * Math.max(0, 1 - r / 29);
      const diag4 = Math.pow(Math.abs(Math.cos(ang * 2 + Math.PI * 0.5)), 18) * Math.max(0, 1 - r / 21) * 0.72;
      const outerRing = Math.exp(-Math.pow((r - 22.5) / 2.2, 2)) * 0.92;
      const innerRing = Math.exp(-Math.pow((r - 12.0) / 1.8, 2)) * 0.65;
      const core = r < 7.5 ? 1 - r / 7.5 : 0;
      const intensity = Math.min(1, core * 1.2 + cross4 * 1.15 + diag4 + outerRing + innerRing);
      if (intensity > 0.08) {
        const cr = 255;
        const cg = clampByte(205 + intensity * 50);
        const cb = clampByte(75 + intensity * 180);
        const alpha = clampByte(intensity * 255);
        b.px(x, y, cr, cg, cb, alpha, 0.95, cr, cg, cb, alpha);
        b.setNormalDirect(x, y, 0, 0, 1);
      }
    }
  }

  // 8. Tumbling Wooden Door Splinters (3 variants)
  const spDark = hexRgb('#422616');
  const spMid = hexRgb('#7d4b2a');
  const spHi = hexRgb('#ba7d4c');
  b.alloc('vfx:wood_splinter_0', 8, 4, 0.5, 0.5);
  b.polygon([[0, 2], [2, 0], [7, 1], [6, 3], [1, 3]], spMid, 0.85, 0.14);
  b.line(1, 1, 6, 1, spHi, 1, 0.94);
  b.bakeRegionNormals(3.0, false);

  b.alloc('vfx:wood_splinter_1', 10, 4, 0.5, 0.5);
  b.polygon([[0, 1], [4, 0], [9, 2], [6, 3], [1, 3]], spMid, 0.86, 0.14);
  b.line(2, 1, 8, 2, spHi, 1, 0.95);
  b.pxRgb(0, 1, spDark, 0.6);
  b.bakeRegionNormals(3.0, false);

  b.alloc('vfx:wood_splinter_2', 6, 5, 0.5, 0.5);
  b.polygon([[0, 3], [2, 0], [5, 1], [4, 4], [1, 4]], spDark, 0.84, 0.16);
  b.line(2, 1, 4, 2, spHi, 1, 0.94);
  b.bakeRegionNormals(3.0, false);

  // 9. Meaty / Bone / Armor Enemy Death Gibs (3 variants)
  b.alloc('vfx:gib_0', 6, 5, 0.5, 0.5);
  b.ellipse(3, 2.5, 2.4, 2.0, hexRgb('#8c1828'), 0.85, 0.15);
  b.pxRgb(2, 1, hexRgb('#e03a4f'), 0.96);
  b.addOutline([18, 6, 12]);
  b.bakeRegionNormals(3.0, false);

  b.alloc('vfx:gib_1', 7, 6, 0.5, 0.5);
  b.line(1, 4, 5, 1, hexRgb('#ded4bf'), 2.2, 0.92);
  b.pxRgb(1, 4, hexRgb('#a81a2c'), 0.88);
  b.addOutline([18, 12, 16]);
  b.bakeRegionNormals(3.0, false);

  b.alloc('vfx:gib_2', 5, 5, 0.5, 0.5);
  b.polygon([[0, 2], [2, 0], [4, 2], [3, 4], [1, 4]], hexRgb('#5c6782'), 0.9, 0.14);
  b.pxRgb(2, 1, hexRgb('#b8c7e6'), 0.98);
  b.bakeRegionNormals(3.2, false);

  // 10. Ascending Cyan-Violet Soul Wisp (12x16)
  b.alloc('vfx:soul_wisp', 12, 16, 0.5, 0.65);
  const wispHalo = hexRgb('#6f52ff');
  const wispCyan = hexRgb('#4eeeff');
  b.polygon([[6, 1], [9, 6], [9, 10], [6, 14], [3, 10], [3, 6]], wispHalo, 0.78, 0.18, wispHalo, 190);
  b.ellipse(6, 9, 3.0, 3.6, wispCyan, 0.92, 0.08, wispCyan, 245);
  b.ellipse(6, 8.5, 1.5, 2.0, [255, 255, 255], 1.0, 0.0, [255, 255, 255], 255);

  // 11. Persistent Ground Decals (3 Blood Spatters, Scorch Mark, Frost Rime)
  const paintBloodDecal = (key: string, w: number, h: number, seed: number): void => {
    b.alloc(key, w, h, 0.5, 0.5);
    const bDark = hexRgb('#590915');
    const bMid = hexRgb('#9e1326');
    const bHi = hexRgb('#cf233a');
    const cx = (w - 1) * 0.5;
    const cy = (h - 1) * 0.5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x - cx) / (w * 0.46);
        const ny = (y - cy) / (h * 0.42);
        const d = Math.hypot(nx, ny);
        const n = hash2(x, y, seed);
        if (d < 0.82 + (n - 0.5) * 0.42) {
          const col = d < 0.45 ? bDark : n > 0.75 ? bHi : bMid;
          const a = d < 0.65 ? 230 : clampByte((1.15 - d) * 210);
          b.px(x, y, col[0], col[1], col[2], a, 0.45);
          b.setNormalDirect(x, y, 0, -0.25, 0.97);
        }
      }
    }
  };
  paintBloodDecal('vfx:decal_blood_0', 22, 8, 601);
  paintBloodDecal('vfx:decal_blood_1', 28, 9, 607);
  paintBloodDecal('vfx:decal_blood_2', 18, 7, 613);

  b.alloc('vfx:decal_scorch', 28, 10, 0.5, 0.5);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 28; x++) {
      const d = Math.hypot((x - 13.5) / 12.8, (y - 4.5) / 4.2);
      const n = hash2(x, y, 631);
      if (d < 0.9 + (n - 0.5) * 0.35) {
        const isEmber = d < 0.38 && n > 0.83;
        if (isEmber) {
          b.px(x, y, 255, 118, 36, 235, 0.6, 255, 96, 24, 210);
        } else {
          const v = clampByte(14 + (1 - Math.min(1, d)) * 18);
          b.px(x, y, v, v - 2, v + 2, clampByte((1.1 - d * 0.85) * 225), 0.35);
        }
        b.setNormalDirect(x, y, 0, -0.2, 0.98);
      }
    }
  }

  b.alloc('vfx:decal_frost', 26, 10, 0.5, 0.5);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 26; x++) {
      const d = Math.hypot((x - 12.5) / 11.8, (y - 4.5) / 4.2);
      const spike = Math.abs(Math.sin(Math.atan2(y - 4.5, x - 12.5) * 5)) * 0.25;
      const n = hash2(x, y, 647);
      if (d < 0.78 + spike + (n - 0.5) * 0.22) {
        const core = d < 0.45 || n > 0.78;
        const col = core ? hexRgb('#d8f8ff') : hexRgb('#5cd4ff');
        const a = clampByte((1.15 - d * 0.8) * 215);
        b.px(x, y, col[0], col[1], col[2], a, 0.72, col[0], col[1], col[2], clampByte(a * 0.55));
        b.setNormalDirect(x, y, 0, -0.3, 0.95);
      }
    }
  }

  // 12. 4-Frame Spinning Metallic Gold Coin (`vfx:coin_0..3`, 10x10)
  const coinWidths = [3.6, 2.3, 0.9, 2.3] as const;
  for (let f = 0; f < 4; f++) {
    b.alloc(`vfx:coin_${f}`, 10, 10, 0.5, 0.5);
    const rx = coinWidths[f];
    const cDark = hexRgb('#9e6814');
    const cMid = hexRgb('#f2be35');
    const cHi = hexRgb('#fff7a8');
    b.ellipse(4.5, 4.5, rx + 0.5, 3.8, cDark, 0.85, 0.14);
    b.ellipse(4.5, 4.5, rx, 3.3, cMid, 0.92, 0.1, cMid, 165);
    if (f === 2) {
      b.line(4.5, 1.5, 4.5, 7.5, cHi, 1.2, 1.0, cHi, 255);
    } else {
      b.ellipse(4.5 - (f === 3 ? -0.6 : 0.6), 3.6, Math.max(0.7, rx * 0.45), 1.4, cHi, 0.98, 0.04, cHi, 235);
    }
    b.addOutline([20, 14, 12]);
    b.bakeRegionNormals(3.0, false);
  }

  // 13. World-Space Floating Curse Skull Above Hero's Head (18x20)
  b.alloc('vfx:curse_skull_world', 18, 20, 0.5, 0.5);
  const csDark = hexRgb('#695278');
  const csBone = hexRgb('#d8cae6');
  const csHi = hexRgb('#fff7ff');
  const csEye = hexRgb('#ff1f4f');
  const csEyeCore = hexRgb('#ff9cb5');
  // Eerie dark crimson-violet aura behind cranium
  b.ellipse(8.5, 9, 8.2, 8.8, hexRgb('#4d0d2e'), 0.4, 0.1, hexRgb('#a81648'), 120);
  // Sculpted gothic cranium & cheekbones
  b.ellipse(8.5, 7.5, 6.2, 5.6, csBone, 0.88, 0.16);
  b.ellipse(8.0, 5.6, 4.2, 2.8, csHi, 0.94, 0.08);
  b.rect(4, 10, 10, 4, csDark, 0.84);
  b.rect(5, 14, 8, 4, csBone, 0.86);
  // Jagged teeth notches
  b.pxRgb(7, 15, hexRgb('#1a0818'), 0.2);
  b.pxRgb(10, 15, hexRgb('#1a0818'), 0.2);
  b.pxRgb(7, 17, hexRgb('#1a0818'), 0.2);
  b.pxRgb(10, 17, hexRgb('#1a0818'), 0.2);
  // Forehead crack + nasal cavity
  b.line(11, 3, 9, 6, csDark, 1, 0.45);
  b.pxRgb(8, 12, hexRgb('#1a0818'), 0.18);
  b.pxRgb(9, 12, hexRgb('#1a0818'), 0.18);
  // Burning crimson-magenta hollow eye sockets!
  b.rect(4, 8, 3, 3, csEye, 0.98, 0, csEye, 255);
  b.rect(11, 8, 3, 3, csEye, 0.98, 0, csEye, 255);
  b.pxRgb(5, 9, csEyeCore, 1.0, csEyeCore, 255);
  b.pxRgb(12, 9, csEyeCore, 1.0, csEyeCore, 255);
  b.addOutline([26, 4, 20]);
  b.bakeRegionNormals(2.6, false);

  // 14. Crimson Unparriable Danger Telegraph `!!` (22x24)
  b.alloc('vfx:telegraph_danger', 22, 24, 0.5, 1.0);
  const dOuter = hexRgb('#d9142c');
  const dMid = hexRgb('#ff4624');
  const dCore = hexRgb('#fff2b2');
  // Jagged crimson danger glow behind twin exclamation marks
  b.line(7, 2, 7, 21, dOuter, 6, 0.88, dOuter, 215);
  b.line(14, 2, 14, 21, dOuter, 6, 0.88, dOuter, 215);
  for (const bx of [6, 13]) {
    b.rect(bx, 3, 3, 11, dMid, 0.96, 0, dMid, 255);
    b.rect(bx + 1, 4, 1, 9, dCore, 1.0, 0, dCore, 255);
    b.rect(bx, 16, 3, 4, dMid, 0.96, 0, dMid, 255);
    b.rect(bx + 1, 17, 1, 2, dCore, 1.0, 0, dCore, 255);
  }
  b.addOutline([28, 6, 12]);
  b.bakeRegionNormals(2.0, false);

  // Crisp 5x7 Pixel Bitmap Font Glyphs for floating world combat numbers & CRIT/PARRY popups!
  const FONT_GLYPHS: Record<string, string[]> = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  };

  for (const [ch, rows] of Object.entries(FONT_GLYPHS)) {
    b.alloc(`font:${ch}`, 7, 9, 0.5, 0.5);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 5; x++) {
        if (rows[y][x] === '1') {
          b.px(x + 1, y + 1, 255, 255, 255, 255, 0.95, 255, 255, 255, 210);
          b.setNormalDirect(x + 1, y + 1, 0, 0, 1);
        }
      }
    }
    b.addOutline([12, 10, 18], 0.5);
  }
}

// =============================================================================
// Public Atlas Key Inventory (Zero DOM dependency — safe for Node / Gate A!)
// =============================================================================

let cachedKeys: string[] | null = null;

export function getAtlasKeys(): string[] {
  if (cachedKeys) return cachedKeys;
  const keys: string[] = [];

  for (const t of TILESET_THEMES) {
    keys.push(
      `tile:${t}:solid_top`,
      `tile:${t}:solid_top_0`,
      `tile:${t}:solid_top_1`,
      `tile:${t}:solid_top_2`,
      `tile:${t}:solid_top_3`,
      `tile:${t}:corner_tl`,
      `tile:${t}:corner_tr`,
      `tile:${t}:corner_bl`,
      `tile:${t}:corner_br`,
      `tile:${t}:edge_left`,
      `tile:${t}:edge_right`,
      `tile:${t}:solid_ceil_0`,
      `tile:${t}:solid_ceil_1`,
      `tile:${t}:plat_left`,
      `tile:${t}:plat_mid`,
      `tile:${t}:plat_right`,
      `tile:${t}:solid_mid`,
      `tile:${t}:solid_deep`,
      `tile:${t}:solid_var`,
      `tile:${t}:oneway`,
      `tile:${t}:bg_wall`,
      `tile:${t}:bg_arch`,
      `tile:${t}:bg_pillar`,
      `tile:${t}:cracked_floor`,
      `tile:${t}:secret_wall`,
      `tile:${t}:exit_gate`
    );
  }

  keys.push(
    'tile:ladder',
    'tile:chain',
    'tile:spikes',
    'tile:acid_0',
    'tile:acid_1',
    'tile:water_0',
    'tile:water_1',
    'prop:brazier_0',
    'prop:brazier_1',
    'prop:brazier_2',
    'prop:torch_0',
    'prop:torch_1',
    'prop:torch_2',
    'prop:banner_0',
    'prop:banner_1',
    'prop:cage',
    'prop:skeleton',
    'prop:door_wood',
    'prop:door_wood_open',
    'prop:door_gold',
    'prop:door_exit',
    'prop:door_boss',
    'prop:chest_closed',
    'prop:chest_open',
    'prop:chest_cursed_closed',
    'prop:chest_cursed_open',
    'prop:chest_boss_closed',
    'prop:chest_boss_open',
    'prop:teleporter_idle',
    'prop:teleporter_active',
    'prop:fountain_full',
    'prop:fountain_empty',
    'prop:scroll_altar',
    'prop:challenge_rift',
    'prop:npc_collector',
    'prop:npc_guillain',
    'prop:npc_forge',
    'prop:crate',
    'prop:barrel',
    'prop:skull_pile',
    'prop:lantern_0',
    'prop:lantern_1',
    'prop:lantern_2',
    'prop:moss_cap',
    'prop:pillar_ornate',
    'prop:chain_hook',
    'prop:gothic_arch',
    'prop:prison_jars',
    'prop:iron_cell_bars',
    'prop:dead_tree',
    'prop:gibbet_cage',
    'prop:sewer_grate',
    'prop:pipe_valve',
    'prop:wind_banner',
    'prop:wind_banner_0',
    'prop:wind_banner_1',
    'prop:wind_banner_2',
    'prop:clock_rose_window',
    'prop:clock_pendulum',
    'prop:wall_gear',
    'prop:wall_gear_lg',
    'prop:wall_gear_sm',
    'prop:castle_stained_glass',
    'prop:royal_candelabra',
    'prop:shop_stall',
    'prop:npc_merchant',
    'prop:recycling_tube',
    'hero:idle_0',
    'hero:idle_1',
    'hero:idle_2',
    'hero:idle_3',
    'hero:run_0',
    'hero:run_1',
    'hero:run_2',
    'hero:run_3',
    'hero:run_4',
    'hero:run_5',
    'hero:jump',
    'hero:fall',
    'hero:wall_slide',
    'hero:roll_0',
    'hero:roll_1',
    'hero:roll_2',
    'hero:roll_3',
    'hero:dive_slam',
    'hero:attack_0',
    'hero:attack_1',
    'hero:attack_2',
    'hero:parry',
    'hero:heal',
    'hero:hurt',
    'hero:dead',
    'hero:head_flame_0',
    'hero:head_flame_1',
    'hero:head_flame_2',
    'hero:head_flame_3'
  );

  for (const id of ENEMY_ARCHETYPE_IDS) {
    keys.push(
      `enemy:${id}`,
      `enemy:${id}_0`,
      `enemy:${id}_1`,
      `enemy:${id}_walk0`,
      `enemy:${id}_walk1`,
      `enemy:${id}_windup`,
      `enemy:${id}_attack`,
      id
    );
  }
  for (const id of BOSS_ARCHETYPE_IDS) {
    keys.push(
      `boss:${id}`,
      `boss:${id}_0`,
      `boss:${id}_1`,
      `boss:${id}_idle0`,
      `boss:${id}_idle1`,
      `boss:${id}_walk`,
      `boss:${id}_windup`,
      `boss:${id}_attack`,
      id
    );
  }
  keys.push(
    'boss:Behemoth_slam',
    'boss:Behemoth_dash',
    'boss:Behemoth_roar',
    'boss:TimeKeeper_slash',
    'boss:TimeKeeper_dash',
    'boss:TimeKeeper_throw',
    'boss:KingsHand_cleave',
    'boss:KingsHand_charge',
    'boss:KingsHand_slam'
  );

  keys.push(
    'pickup:gold',
    'pickup:cell',
    'pickup:food',
    'pickup:scroll_brutality',
    'pickup:scroll_tactics',
    'pickup:scroll_survival',
    'pickup:scroll_dual',
    'pickup:flask',
    'pickup:blueprint',
    'pickup:gear_sword',
    'pickup:gear_bow',
    'pickup:gear_shield',
    'pickup:gear_skill',
    'turret:sinew',
    'turret:heavy',
    'turret:wolfTrap',
    'turret:bossBanner',
    'proj:arrow',
    'proj:knife',
    'proj:fireball',
    'proj:iceArrow',
    'proj:lightning',
    'proj:enemyBolt',
    'proj:grenade',
    'proj:cluster',
    'proj:shuriken',
    'proj:shockwave',
    'proj:fallingSword',
    'proj:hook',
    'proj:laserBeam',
    'proj:acidSpit',
    'vfx:white_px',
    'vfx:slash_0',
    'vfx:slash_1',
    'vfx:slash_2',
    'vfx:slash_heavy',
    'vfx:slash_blade_0',
    'vfx:slash_blade_1',
    'vfx:slash_blade_2',
    'vfx:slash_heavy_0',
    'vfx:slash_heavy_1',
    'vfx:slash_thrust_0',
    'vfx:slash_thrust_1',
    'vfx:slash_twin_0',
    'vfx:slash_twin_1',
    'vfx:slash_whip_0',
    'vfx:slash_whip_1',
    'vfx:shield_guard',
    'vfx:parry_burst',
    'vfx:wood_splinter_0',
    'vfx:wood_splinter_1',
    'vfx:wood_splinter_2',
    'vfx:gib_0',
    'vfx:gib_1',
    'vfx:gib_2',
    'vfx:soul_wisp',
    'vfx:decal_blood_0',
    'vfx:decal_blood_1',
    'vfx:decal_blood_2',
    'vfx:decal_scorch',
    'vfx:decal_frost',
    'vfx:coin_0',
    'vfx:coin_1',
    'vfx:coin_2',
    'vfx:coin_3',
    'vfx:curse_skull_world',
    'vfx:telegraph',
    'vfx:telegraph_danger',
    'vfx:parry_ring',
    'vfx:aura_ring',
    'vfx:shield_dome',
    'vfx:spark',
    'vfx:ember',
    'vfx:drop',
    'vfx:cog',
    'vfx:fireball_burst',
    'vfx:ice_burst',
    'vfx:shockwave_ring',
    'vfx:stun_stars'
  );

  for (const id of WEAPON_ICON_IDS) keys.push(`weapon:${id}`, id);
  for (const id of SKILL_ICON_IDS) keys.push(`skill:${id}`, id);
  for (const ch of '0123456789+-!CRITPAY') keys.push(`font:${ch}`);

  cachedKeys = Array.from(new Set(keys));
  return cachedKeys;
}

// =============================================================================
// Smart Key Resolver & Atlas Builder Entrypoint
// =============================================================================

export function resolveSpriteRegion(
  regions: Record<string, SpriteRegion>,
  key: string,
  fallbackKey = 'vfx:white_px'
): SpriteRegion {
  const direct = regions[key];
  if (direct) return direct;
  // Normalize common alternate naming conventions (e.g. enemy_Zombie -> enemy:Zombie)
  const colonKey = key.replace('_', ':');
  if (regions[colonKey]) return regions[colonKey];
  if (regions[`enemy:${key}`]) return regions[`enemy:${key}`];
  if (regions[`boss:${key}`]) return regions[`boss:${key}`];
  if (regions[`weapon:${key}`]) return regions[`weapon:${key}`];
  if (regions[`skill:${key}`]) return regions[`skill:${key}`];
  return regions[fallbackKey] ?? Object.values(regions)[0];
}

function pixelsToCanvas(pixels: Uint8Array, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imgData = ctx.createImageData(w, h);
  imgData.data.set(pixels);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// =============================================================================
// AAA Baked Original Krunked Pixel-Art RLE Decoder & Normal-Map Stamper
// =============================================================================

function decodeBase64Bytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) {
    const buf = B.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(0);
}

interface DecodedBakedSprite {
  w: number;
  h: number;
  indices: Uint8Array;
  palR: Uint8Array;
  palG: Uint8Array;
  palB: Uint8Array;
  emVal: Uint8Array;
}

function decodeBakedSprite(sp: BakedPixelSprite, opaqueBackdrop = false): DecodedBakedSprite {
  const total = sp.w * sp.h;
  const raw = decodeBase64Bytes(sp.rle);
  const indices = new Uint8Array(total);
  let di = 0;
  let si = 0;
  while (si < raw.length && di < total) {
    const byte = raw[si++];
    if ((byte & 0x80) !== 0) {
      const run = byte & 0x7f;
      const val = si < raw.length ? raw[si++] : 0;
      const end = Math.min(total, di + run);
      while (di < end) indices[di++] = val;
    } else {
      indices[di++] = byte;
    }
  }

  const palCount = Math.floor(sp.pal.length / 6);
  const offset = opaqueBackdrop ? 0 : 1;
  const palR = new Uint8Array(palCount + offset);
  const palG = new Uint8Array(palCount + offset);
  const palB = new Uint8Array(palCount + offset);
  const emVal = new Uint8Array(palCount + offset);

  for (let i = 0; i < palCount; i++) {
    const off = i * 6;
    const n = parseInt(sp.pal.slice(off, off + 6), 16);
    palR[i + offset] = (n >> 16) & 255;
    palG[i + offset] = (n >> 8) & 255;
    palB[i + offset] = n & 255;
  }
  for (let i = 0; i < sp.em.length; i++) {
    const [pIdx, strength] = sp.em[i];
    if (pIdx >= 0 && pIdx < emVal.length) {
      emVal[pIdx] = clampByte(strength);
    }
  }

  return { w: sp.w, h: sp.h, indices, palR, palG, palB, emVal };
}

interface StampBakedOpts {
  shiftX?: number;
  shiftY?: number;
  topSwayX?: number;
  topSwayCutoffFrac?: number;
  rotate180?: boolean;
  tintMul?: readonly [number, number, number];
  desaturate?: number;
  emScale?: number;
  normalStrength?: number;
  pivotX?: number;
  pivotY?: number;
  /** Re-hue cyan portal/glow pixels into ominous crimson (for Boss Gates!) */
  crimsonPortalSwap?: boolean;
  /** Desaturate emerald healing water into dry stone basin (for used Healing Fountain!) */
  emptyBasin?: boolean;
  /** Carve glowing open chest cavity + raised golden treasure rim */
  openChestGlow?: RGB;
  /** Extra pinpoint emissive boost for sprites with dark warm eyes/cores (e.g. Behemoth, Sinew, Cursed Chest, Guillain) */
  warmCoreBoost?: 'fire' | 'red_eye' | 'magic_violet' | 'cyan_rune';
  /** Add subtle combat gleam or buckler/flask overlay on baked hero pose */
  heroAccent?: 'attack0' | 'attack1' | 'attack2' | 'parry' | 'heal' | 'dive' | 'hurt';
}

function stampBakedSprite(
  b: PixelAtlasBuilder,
  key: string,
  sp: BakedPixelSprite,
  opts: StampBakedOpts = {}
): void {
  const dec = decodeBakedSprite(sp, false);
  const { w, h, indices, palR, palG, palB, emVal } = dec;
  const shiftX = opts.shiftX ?? 0;
  const shiftY = opts.shiftY ?? 0;
  const topSwayX = opts.topSwayX ?? 0;
  const swayCutY = Math.floor(h * (opts.topSwayCutoffFrac ?? 0.45));
  const rot180 = opts.rotate180 === true;
  const tint = opts.tintMul;
  const desat = opts.desaturate ?? 0;
  const emScale = opts.emScale ?? 1.0;

  b.alloc(key, w, h, opts.pivotX ?? sp.px, opts.pivotY ?? sp.py);

  // Precompute 4-step interior distance field so baked pixel art gets genuine rounded 3D normal silhouettes!
  const dist = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dist[i] = indices[i] > 0 ? 1 : 0;
  }
  for (let pass = 1; pass <= 4; pass++) {
    const next = new Uint8Array(dist);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        if (
          dist[i] >= pass &&
          dist[i - 1] >= pass &&
          dist[i + 1] >= pass &&
          dist[i - w] >= pass &&
          dist[i + w] >= pass
        ) {
          next[i] = pass + 1;
        }
      }
    }
    dist.set(next);
  }

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    const rowSway = y < swayCutY ? topSwayX : 0;
    for (let x = 0; x < w; x++) {
      const pidx = indices[rowOff + x];
      if (pidx === 0) continue;

      const rx = rot180 ? w - 1 - x : x;
      const ry = rot180 ? h - 1 - y : y;
      const dx = rx + shiftX + rowSway;
      const dy = ry + shiftY;
      if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue;

      let r = palR[pidx];
      let g = palG[pidx];
      let bl = palB[pidx];
      let em = clampByte(emVal[pidx] * emScale);

      if (opts.crimsonPortalSwap && bl > 110 && g > 95 && r < bl + 15) {
        const lum = Math.max(g, bl);
        r = clampByte(Math.min(255, lum * 1.15));
        g = clampByte(lum * 0.22);
        bl = clampByte(lum * 0.25);
        em = Math.max(em, clampByte(lum * 0.95));
      }

      if (opts.emptyBasin && g > r * 1.15 && g > 75) {
        const grey = clampByte(0.28 * r + 0.52 * g + 0.2 * bl);
        r = clampByte(grey * 0.52);
        g = clampByte(grey * 0.54);
        bl = clampByte(grey * 0.66);
        em = 0;
      }

      if (opts.warmCoreBoost === 'fire') {
        if (r > 118 && r > g * 1.25 && r > bl * 1.45 && y < h * 0.72) {
          em = Math.max(em, clampByte(150 + (r - 115) * 1.1));
        }
      } else if (opts.warmCoreBoost === 'red_eye') {
        if (r > 120 && r > g * 1.35 && r > bl * 1.35) {
          em = Math.max(em, 235);
        }
      } else if (opts.warmCoreBoost === 'magic_violet') {
        if ((r > 105 && bl > 110 && g < 95) || (r > 145 && g < 85 && bl > 85)) {
          em = Math.max(em, 225);
        }
      } else if (opts.warmCoreBoost === 'cyan_rune') {
        if (bl > 115 && g > 105 && r < 140) {
          em = Math.max(em, 225);
        }
      }

      if (tint) {
        r = clampByte(r * tint[0]);
        g = clampByte(g * tint[1]);
        bl = clampByte(bl * tint[2]);
      }

      if (desat > 0) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * bl;
        r = clampByte(r + (gray - r) * desat);
        g = clampByte(g + (gray - g) * desat);
        bl = clampByte(bl + (gray - bl) * desat);
      }

      const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
      const dome = Math.min(1, dist[rowOff + x] / 5.0);
      const height = 0.24 + lum * 0.42 + dome * 0.34;

      if (em > 0) {
        b.px(dx, dy, r, g, bl, 255, Math.min(1, height + 0.1), r, g, bl, em);
      } else {
        b.px(dx, dy, r, g, bl, 255, height);
      }
    }
  }

  // Open chest interior treasure glow
  if (opts.openChestGlow) {
    const cg = opts.openChestGlow;
    const bandY = Math.floor(h * 0.42);
    const bandH = Math.max(4, Math.floor(h * 0.16));
    const padX = Math.floor(w * 0.18);
    b.rect(padX, bandY - 2, w - padX * 2, bandH + 2, hexRgb('#120c1c'), 0.25);
    b.rect(padX + 2, bandY, w - (padX + 2) * 2, bandH - 1, cg, 0.94, 0, cg, 245);
  }

  // Crisp combat action accents for baked Hero poses
  if (opts.heroAccent === 'attack0' || opts.heroAccent === 'attack1' || opts.heroAccent === 'attack2') {
    const glow = opts.heroAccent === 'attack2' ? hexRgb('#ffe875') : hexRgb('#7af4ff');
    const yOff = opts.heroAccent === 'attack0' ? -2 : opts.heroAccent === 'attack1' ? 2 : 0;
    b.line(Math.floor(w * 0.55), Math.floor(h * 0.35) + yOff, w - 2, Math.floor(h * 0.52) + yOff, glow, 1.5, 0.96, glow, 235);
  } else if (opts.heroAccent === 'parry') {
    const gold = hexRgb('#ffd866');
    const goldHi = hexRgb('#fff8cc');
    b.polygon(
      [
        [w - 8, Math.floor(h * 0.36)],
        [w - 2, Math.floor(h * 0.42)],
        [w - 2, Math.floor(h * 0.68)],
        [w - 7, Math.floor(h * 0.74)],
        [w - 9, Math.floor(h * 0.64)],
      ],
      gold,
      0.95,
      0.12,
      goldHi,
      215
    );
  } else if (opts.heroAccent === 'heal') {
    const emerald = hexRgb('#4dff99');
    b.ellipse(w * 0.72, h * 0.52, 3.2, 4.2, emerald, 0.96, 0.05, emerald, 250);
  } else if (opts.heroAccent === 'dive') {
    const cyan = hexRgb('#52f2ff');
    b.line(w * 0.5, h * 0.52, w * 0.5, h - 1, cyan, 2, 0.96, cyan, 240);
  }

  b.bakeRegionNormals(opts.normalStrength ?? 2.6, false);
}

function overlayBakedBuiltinArt(b: PixelAtlasBuilder): void {
  const S = BUILTIN_BAKED_SPRITES;

  // 1. Monumental Gothic Archway (85x96)
  if (S['prop:gothic_arch']) {
    stampBakedSprite(b, 'prop:gothic_arch', S['prop:gothic_arch'], { normalStrength: 2.8 });
  }

  // 2. Hero TRUE Multi-Frame Headless Poses (18 direct baked frames + derived smooth transitions!)
  //    Live animated `hero:head_flame_0..3` attaches cleanly using `BUILTIN_HERO_HEAD_ANCHORS`!
  for (let i = 0; i < 6; i++) {
    const src = S[`hero:run_${i}`] ?? S['hero:run_0'];
    if (src) {
      stampBakedSprite(b, `hero:run_${i}`, src, { emScale: 1.15, normalStrength: 2.7 });
    }
  }
  const hIdle0 = S['hero:idle_0'];
  const hIdle1 = S['hero:idle_1'] ?? hIdle0;
  if (hIdle0) {
    stampBakedSprite(b, 'hero:idle_0', hIdle0, { emScale: 1.15, normalStrength: 2.7 });
    stampBakedSprite(b, 'hero:idle_1', hIdle1, { emScale: 1.18, normalStrength: 2.7 });
    stampBakedSprite(b, 'hero:idle_2', hIdle1, { shiftY: 1, emScale: 1.12, normalStrength: 2.7 });
    stampBakedSprite(b, 'hero:idle_3', hIdle0, { topSwayX: 1, topSwayCutoffFrac: 0.35, emScale: 1.15, normalStrength: 2.7 });
    stampBakedSprite(b, 'hero:hurt', hIdle0, { shiftX: -2, tintMul: [1.26, 0.82, 0.82], emScale: 1.1 });
  }
  const directHeroKeys: ReadonlyArray<readonly [string, string, StampBakedOpts]> = [
    ['hero:attack_0', 'hero:attack_0', { emScale: 1.2, normalStrength: 2.8 }],
    ['hero:attack_1', 'hero:attack_1', { emScale: 1.2, normalStrength: 2.8 }],
    ['hero:attack_2', 'hero:attack_2', { emScale: 1.25, normalStrength: 2.8 }],
    ['hero:parry', 'hero:parry', { emScale: 1.2, normalStrength: 2.8 }],
    ['hero:dive_slam', 'hero:dive_slam', { emScale: 1.25, normalStrength: 2.8 }],
    ['hero:heal', 'hero:heal', { emScale: 1.35, normalStrength: 2.7 }],
    ['hero:jump', 'hero:jump', { emScale: 1.15, normalStrength: 2.7 }],
    ['hero:fall', 'hero:fall', { emScale: 1.15, normalStrength: 2.7 }],
    ['hero:roll_0', 'hero:roll_0', { emScale: 1.2, normalStrength: 2.8 }],
    ['hero:roll_1', 'hero:roll_1', { emScale: 1.2, normalStrength: 2.8 }],
  ];
  for (const [dstKey, srcKey, opts] of directHeroKeys) {
    if (S[srcKey]) stampBakedSprite(b, dstKey, S[srcKey], opts);
  }
  if (S['hero:roll_0']) {
    stampBakedSprite(b, 'hero:roll_2', S['hero:roll_0'], { rotate180: true, emScale: 1.25, normalStrength: 2.8 });
  }
  if (S['hero:roll_1']) {
    stampBakedSprite(b, 'hero:roll_3', S['hero:roll_1'], { shiftX: 1, emScale: 1.18, normalStrength: 2.8 });
  } else if (S['hero:roll_0']) {
    stampBakedSprite(b, 'hero:roll_3', S['hero:roll_0'], { emScale: 1.15, normalStrength: 2.8 });
  }
  if (S['hero:jump']) {
    stampBakedSprite(b, 'hero:wall_slide', S['hero:jump'], { shiftX: 1, emScale: 1.15, normalStrength: 2.7 });
  }

  // 3. Dungeon Props, Doors, Chests, Teleporters, Fountain & Passage NPCs
  if (S['prop:brazier_0']) {
    stampBakedSprite(b, 'prop:brazier_0', S['prop:brazier_0'], { topSwayX: -1, topSwayCutoffFrac: 0.48, emScale: 1.05 });
    stampBakedSprite(b, 'prop:brazier_1', S['prop:brazier_0'], { topSwayX: 0, topSwayCutoffFrac: 0.48, emScale: 1.22 });
    stampBakedSprite(b, 'prop:brazier_2', S['prop:brazier_0'], { topSwayX: 1, topSwayCutoffFrac: 0.48, emScale: 1.12 });
  }
  if (S['prop:teleporter_active']) {
    stampBakedSprite(b, 'prop:teleporter_active', S['prop:teleporter_active'], { emScale: 1.2 });
    stampBakedSprite(b, 'prop:teleporter_idle', S['prop:teleporter_active'], {
      tintMul: [0.68, 0.72, 0.84],
      desaturate: 0.35,
      emScale: 0.32,
    });
  }
  if (S['prop:chest_closed']) {
    stampBakedSprite(b, 'prop:chest_closed', S['prop:chest_closed'], { emScale: 1.1 });
    stampBakedSprite(b, 'prop:chest_open', S['prop:chest_closed'], {
      openChestGlow: hexRgb('#ffe880'),
      emScale: 1.2,
    });
    stampBakedSprite(b, 'prop:chest_boss_closed', S['prop:chest_closed'], {
      tintMul: [1.18, 0.88, 0.80],
      emScale: 1.25,
    });
    stampBakedSprite(b, 'prop:chest_boss_open', S['prop:chest_closed'], {
      tintMul: [1.18, 0.88, 0.80],
      openChestGlow: hexRgb('#ffdc6b'),
      emScale: 1.3,
    });
  }
  if (S['prop:chest_cursed_closed']) {
    stampBakedSprite(b, 'prop:chest_cursed_closed', S['prop:chest_cursed_closed'], {
      warmCoreBoost: 'magic_violet',
      emScale: 1.25,
    });
    stampBakedSprite(b, 'prop:chest_cursed_open', S['prop:chest_cursed_closed'], {
      warmCoreBoost: 'magic_violet',
      openChestGlow: hexRgb('#ff4488'),
      emScale: 1.3,
    });
  }
  if (S['prop:fountain_full']) {
    stampBakedSprite(b, 'prop:fountain_full', S['prop:fountain_full'], { emScale: 1.18 });
    stampBakedSprite(b, 'prop:fountain_empty', S['prop:fountain_full'], {
      emptyBasin: true,
      tintMul: [0.76, 0.78, 0.84],
      emScale: 0,
    });
  }
  if (S['prop:door_exit']) {
    stampBakedSprite(b, 'prop:door_exit', S['prop:door_exit'], { emScale: 1.2 });
    stampBakedSprite(b, 'prop:door_boss', S['prop:door_exit'], {
      crimsonPortalSwap: true,
      tintMul: [1.06, 0.88, 0.90],
      emScale: 1.25,
    });
  }
  if (S['prop:door_wood']) {
    stampBakedSprite(b, 'prop:door_wood', S['prop:door_wood'], { normalStrength: 2.8 });
    stampBakedSprite(b, 'prop:door_gold', S['prop:door_wood'], {
      tintMul: [1.45, 1.18, 0.62],
      warmCoreBoost: 'fire',
      emScale: 1.0,
    });
  }
  if (S['prop:npc_collector']) {
    stampBakedSprite(b, 'prop:npc_collector', S['prop:npc_collector'], { emScale: 1.18 });
  }
  if (S['prop:npc_guillain']) {
    stampBakedSprite(b, 'prop:npc_guillain', S['prop:npc_guillain'], {
      warmCoreBoost: 'cyan_rune',
      emScale: 1.2,
    });
  }
  if (S['prop:npc_forge']) {
    stampBakedSprite(b, 'prop:npc_forge', S['prop:npc_forge'], {
      warmCoreBoost: 'fire',
      emScale: 1.2,
    });
  }
  if (S['turret:sinew']) {
    stampBakedSprite(b, 'turret:sinew', S['turret:sinew'], {
      warmCoreBoost: 'red_eye',
      emScale: 1.25,
    });
    stampBakedSprite(b, 'turret:heavy', S['turret:sinew'], {
      tintMul: [1.26, 1.04, 0.70],
      warmCoreBoost: 'fire',
      emScale: 1.2,
    });
  }

  // 4. ALL 18 Enemy Archetypes — 100% Distinct Multi-Pose Silhouettes (ZERO Palette Clones!)
  const enemyWarmMap: Partial<Record<string, StampBakedOpts['warmCoreBoost']>> = {
    Zombie: 'fire',
    Runner: 'red_eye',
    Archer: 'fire',
    Mage360: 'cyan_rune',
    Grenader: 'fire',
    ClusterGrenader: 'fire',
    CastleKnight: 'fire',
    Comboter: 'fire',
    PirateChief: 'fire',
    LeapingDuelyst: 'cyan_rune',
    BatKamikaze: 'fire',
    BatDasher: 'red_eye',
    Protector: 'cyan_rune',
  };

  for (const id of ENEMY_ARCHETYPE_IDS) {
    const warm = enemyWarmMap[id];
    const spWalk0 = S[`enemy:${id}_walk0`];
    const spWalk1 = S[`enemy:${id}_walk1`];
    const spWindup = S[`enemy:${id}_windup`];
    const spAttack = S[`enemy:${id}_attack`];
    if (!spWalk0) continue;

    stampBakedSprite(b, `enemy:${id}_walk0`, spWalk0, { warmCoreBoost: warm, emScale: 1.12 });
    if (spWalk1) {
      stampBakedSprite(b, `enemy:${id}_walk1`, spWalk1, { warmCoreBoost: warm, emScale: 1.12 });
    } else {
      // Secondary 3-frame archetypes: crisp stride shift for walk1
      stampBakedSprite(b, `enemy:${id}_walk1`, spWalk0, {
        shiftX: 1,
        shiftY: id.startsWith('Bat') ? -2 : -1,
        topSwayX: 1,
        topSwayCutoffFrac: 0.55,
        warmCoreBoost: warm,
        emScale: 1.15,
      });
    }
    if (spWindup) {
      stampBakedSprite(b, `enemy:${id}_windup`, spWindup, { warmCoreBoost: warm, emScale: 1.28 });
    } else {
      b.regions[`enemy:${id}_windup`] = { ...b.regions[`enemy:${id}_walk0`], key: `enemy:${id}_windup` };
    }
    if (spAttack) {
      stampBakedSprite(b, `enemy:${id}_attack`, spAttack, { warmCoreBoost: warm, emScale: 1.32 });
    } else {
      b.regions[`enemy:${id}_attack`] = { ...b.regions[`enemy:${id}_walk1`], key: `enemy:${id}_attack` };
    }

    // Legacy key compatibility (`enemy:<id>`, `enemy:<id>_0`, `enemy:<id>_1`, `<id>`)
    b.regions[`enemy:${id}_0`] = { ...b.regions[`enemy:${id}_walk0`], key: `enemy:${id}_0` };
    b.regions[`enemy:${id}_1`] = { ...b.regions[`enemy:${id}_attack`], key: `enemy:${id}_1` };
    b.regions[`enemy:${id}`] = { ...b.regions[`enemy:${id}_walk0`], key: `enemy:${id}` };
    b.regions[id] = { ...b.regions[`enemy:${id}_walk0`], key: id };
  }

  // 5. ALL 3 Monumental Multi-Phase Bosses — 4 TRUE Combat Poses Each + Action Aliases!
  // 5A. Behemoth (Iron Concierge)
  if (S['boss:Behemoth_idle0']) {
    stampBakedSprite(b, 'boss:Behemoth_idle0', S['boss:Behemoth_idle0'], { warmCoreBoost: 'fire', normalStrength: 2.9, emScale: 1.25 });
    stampBakedSprite(b, 'boss:Behemoth_idle1', S['boss:Behemoth_idle1'] ?? S['boss:Behemoth_idle0'], { warmCoreBoost: 'fire', normalStrength: 2.9, emScale: 1.25 });
    stampBakedSprite(b, 'boss:Behemoth_windup', S['boss:Behemoth_windup'] ?? S['boss:Behemoth_idle0'], { warmCoreBoost: 'fire', normalStrength: 2.9, emScale: 1.38 });
    stampBakedSprite(b, 'boss:Behemoth_attack', S['boss:Behemoth_attack'] ?? S['boss:Behemoth_idle0'], { warmCoreBoost: 'fire', normalStrength: 2.9, emScale: 1.42 });
    stampBakedSprite(b, 'boss:Behemoth_dash', S['boss:Behemoth_idle1'] ?? S['boss:Behemoth_idle0'], { shiftX: 2, warmCoreBoost: 'fire', normalStrength: 2.9, emScale: 1.35 });
    stampBakedSprite(b, 'boss:Behemoth_roar', S['boss:Behemoth_windup'] ?? S['boss:Behemoth_idle0'], { warmCoreBoost: 'fire', tintMul: [1.10, 0.96, 0.90], normalStrength: 2.9, emScale: 1.5 });
    b.regions['boss:Behemoth_walk'] = { ...b.regions['boss:Behemoth_idle1'], key: 'boss:Behemoth_walk' };
    b.regions['boss:Behemoth_slam'] = { ...b.regions['boss:Behemoth_attack'], key: 'boss:Behemoth_slam' };
    b.regions['boss:Behemoth_0'] = { ...b.regions['boss:Behemoth_idle0'], key: 'boss:Behemoth_0' };
    b.regions['boss:Behemoth_1'] = { ...b.regions['boss:Behemoth_attack'], key: 'boss:Behemoth_1' };
    b.regions['boss:Behemoth'] = { ...b.regions['boss:Behemoth_idle0'], key: 'boss:Behemoth' };
    b.regions['Behemoth'] = { ...b.regions['boss:Behemoth_idle0'], key: 'Behemoth' };
  }

  // 5B. TimeKeeper (Chrono Warden)
  if (S['boss:TimeKeeper_idle0']) {
    stampBakedSprite(b, 'boss:TimeKeeper_idle0', S['boss:TimeKeeper_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.2 });
    stampBakedSprite(b, 'boss:TimeKeeper_idle1', S['boss:TimeKeeper_idle1'] ?? S['boss:TimeKeeper_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.22 });
    stampBakedSprite(b, 'boss:TimeKeeper_windup', S['boss:TimeKeeper_windup'] ?? S['boss:TimeKeeper_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.35 });
    stampBakedSprite(b, 'boss:TimeKeeper_attack', S['boss:TimeKeeper_attack'] ?? S['boss:TimeKeeper_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.4 });
    b.regions['boss:TimeKeeper_walk'] = { ...b.regions['boss:TimeKeeper_idle1'], key: 'boss:TimeKeeper_walk' };
    b.regions['boss:TimeKeeper_dash'] = { ...b.regions['boss:TimeKeeper_idle1'], key: 'boss:TimeKeeper_dash' };
    b.regions['boss:TimeKeeper_slash'] = { ...b.regions['boss:TimeKeeper_attack'], key: 'boss:TimeKeeper_slash' };
    b.regions['boss:TimeKeeper_throw'] = { ...b.regions['boss:TimeKeeper_windup'], key: 'boss:TimeKeeper_throw' };
    b.regions['boss:TimeKeeper_0'] = { ...b.regions['boss:TimeKeeper_idle0'], key: 'boss:TimeKeeper_0' };
    b.regions['boss:TimeKeeper_1'] = { ...b.regions['boss:TimeKeeper_attack'], key: 'boss:TimeKeeper_1' };
    b.regions['boss:TimeKeeper'] = { ...b.regions['boss:TimeKeeper_idle0'], key: 'boss:TimeKeeper' };
    b.regions['TimeKeeper'] = { ...b.regions['boss:TimeKeeper_idle0'], key: 'TimeKeeper' };
  }

  // 5C. KingsHand (Sovereign Hand)
  if (S['boss:KingsHand_idle0']) {
    stampBakedSprite(b, 'boss:KingsHand_idle0', S['boss:KingsHand_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.2 });
    stampBakedSprite(b, 'boss:KingsHand_idle1', S['boss:KingsHand_idle0'], { shiftY: 1, topSwayX: 1, topSwayCutoffFrac: 0.45, warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.24 });
    stampBakedSprite(b, 'boss:KingsHand_windup', S['boss:KingsHand_windup'] ?? S['boss:KingsHand_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.32 });
    stampBakedSprite(b, 'boss:KingsHand_cleave', S['boss:KingsHand_cleave'] ?? S['boss:KingsHand_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.38 });
    stampBakedSprite(b, 'boss:KingsHand_charge', S['boss:KingsHand_charge'] ?? S['boss:KingsHand_idle0'], { warmCoreBoost: 'cyan_rune', normalStrength: 2.9, emScale: 1.30 });
    b.regions['boss:KingsHand_walk'] = { ...b.regions['boss:KingsHand_charge'], key: 'boss:KingsHand_walk' };
    b.regions['boss:KingsHand_attack'] = { ...b.regions['boss:KingsHand_cleave'], key: 'boss:KingsHand_attack' };
    b.regions['boss:KingsHand_slam'] = { ...b.regions['boss:KingsHand_windup'], key: 'boss:KingsHand_slam' };
    b.regions['boss:KingsHand_0'] = { ...b.regions['boss:KingsHand_idle0'], key: 'boss:KingsHand_0' };
    b.regions['boss:KingsHand_1'] = { ...b.regions['boss:KingsHand_cleave'], key: 'boss:KingsHand_1' };
    b.regions['boss:KingsHand'] = { ...b.regions['boss:KingsHand_idle0'], key: 'boss:KingsHand' };
    b.regions['KingsHand'] = { ...b.regions['boss:KingsHand_idle0'], key: 'KingsHand' };
  }
}

let cachedBuiltinTitleUrl: string | null | undefined;

export function getBuiltinTitleBackdropDataUrl(): string | null {
  if (cachedBuiltinTitleUrl !== undefined) return cachedBuiltinTitleUrl;
  if (typeof document === 'undefined' || !BUILTIN_TITLE_BACKDROP) {
    cachedBuiltinTitleUrl = null;
    return null;
  }
  const dec = decodeBakedSprite(BUILTIN_TITLE_BACKDROP, true);
  const canvas = document.createElement('canvas');
  canvas.width = dec.w;
  canvas.height = dec.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cachedBuiltinTitleUrl = null;
    return null;
  }
  const img = ctx.createImageData(dec.w, dec.h);
  const d = img.data;
  for (let i = 0; i < dec.w * dec.h; i++) {
    const p = dec.indices[i];
    const o = i * 4;
    d[o] = dec.palR[p];
    d[o + 1] = dec.palG[p];
    d[o + 2] = dec.palB[p];
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cachedBuiltinTitleUrl = canvas.toDataURL('image/png');
  return cachedBuiltinTitleUrl;
}

export function buildProceduralAtlas(): ProceduralAtlasData {
  const b = new PixelAtlasBuilder();

  // 1. All 10 Biome 12-Tile Autotile Sets (Top Variants, Chamfered Corners, Wall Edges, Ceilings, Catwalks)
  for (let ti = 0; ti < TILESET_THEMES.length; ti++) {
    const theme = TILESET_THEMES[ti];
    const pal = TILESET_PALETTES[theme];
    const seed = 101 + ti * 73;

    // 4 varied weathered top floor slabs + legacy solid_top alias
    for (let v = 0; v < 4; v++) {
      b.alloc(`tile:${theme}:solid_top_${v}`, 24, 24, 0, 0);
      paintBrickTile(b, pal, seed + 1 + v * 11, 'top', v);
    }
    b.alias(`tile:${theme}:solid_top`, `tile:${theme}:solid_top_0`);

    // 4 chamfered organic stone outer corners
    b.alloc(`tile:${theme}:corner_tl`, 24, 24, 0, 0);
    paintCornerTile(b, pal, seed + 21, 'tl');
    b.alloc(`tile:${theme}:corner_tr`, 24, 24, 0, 0);
    paintCornerTile(b, pal, seed + 22, 'tr');
    b.alloc(`tile:${theme}:corner_bl`, 24, 24, 0, 0);
    paintCornerTile(b, pal, seed + 23, 'bl');
    b.alloc(`tile:${theme}:corner_br`, 24, 24, 0, 0);
    paintCornerTile(b, pal, seed + 24, 'br');

    // 2 chiseled vertical wall edges
    b.alloc(`tile:${theme}:edge_left`, 24, 24, 0, 0);
    paintWallEdgeTile(b, pal, seed + 31, 'left');
    b.alloc(`tile:${theme}:edge_right`, 24, 24, 0, 0);
    paintWallEdgeTile(b, pal, seed + 32, 'right');

    // 2 overhanging ceiling lips
    b.alloc(`tile:${theme}:solid_ceil_0`, 24, 24, 0, 0);
    paintCeilingTile(b, pal, seed + 41, 0);
    b.alloc(`tile:${theme}:solid_ceil_1`, 24, 24, 0, 0);
    paintCeilingTile(b, pal, seed + 42, 1);

    // 3 one-way catwalk planks (left endcap, mid, right endcap) + legacy oneway alias
    b.alloc(`tile:${theme}:plat_left`, 24, 24, 0, 0);
    paintOneWayTile(b, pal, 'left');
    b.alloc(`tile:${theme}:plat_mid`, 24, 24, 0, 0);
    paintOneWayTile(b, pal, 'mid');
    b.alloc(`tile:${theme}:plat_right`, 24, 24, 0, 0);
    paintOneWayTile(b, pal, 'right');
    b.alias(`tile:${theme}:oneway`, `tile:${theme}:plat_mid`);

    // Interior solid, background masonry, cracked floor & secret walls
    b.alloc(`tile:${theme}:solid_mid`, 24, 24, 0, 0);
    paintBrickTile(b, pal, seed + 2, 'mid');

    b.alloc(`tile:${theme}:solid_deep`, 24, 24, 0, 0);
    paintBrickTile(b, pal, seed + 3, 'deep');

    b.alloc(`tile:${theme}:solid_var`, 24, 24, 0, 0);
    paintBrickTile(b, pal, seed + 4, 'var');

    b.alloc(`tile:${theme}:bg_wall`, 24, 24, 0, 0);
    paintBgWallTile(b, pal, seed + 5, 'wall');

    b.alloc(`tile:${theme}:bg_arch`, 24, 24, 0, 0);
    paintBgWallTile(b, pal, seed + 6, 'arch');

    b.alloc(`tile:${theme}:bg_pillar`, 24, 24, 0, 0);
    paintBgWallTile(b, pal, seed + 7, 'pillar');

    b.alloc(`tile:${theme}:cracked_floor`, 24, 24, 0, 0);
    paintCrackedOrSecretTile(b, pal, seed + 8, false);

    b.alloc(`tile:${theme}:secret_wall`, 24, 24, 0, 0);
    paintCrackedOrSecretTile(b, pal, seed + 9, true);

    b.alloc(`tile:${theme}:exit_gate`, 24, 24, 0, 0);
    paintBgWallTile(b, pal, seed + 10, 'arch');
  }

  // 2. Universal Tiles & Architectural/Biome/Shop Props / Doors / Chests / Shrines / NPCs
  paintUniversalTiles(b);
  paintPropsAndNpcs(b);

  // 3. Prisoner (Hero) Procedural Dead Pose + Live 4-Frame Homunculus Plasma Flame Head
  paintHeroPose(b, 'hero:dead', 'dead', 0);
  paintHomunculusHeadFrames(b);

  // 4. Pickups, Turrets (fallback/wolfTrap/bossBanner), Projectiles, Painterly VFX & Bitmap Font
  paintPickupsTurretsProjectiles(b);
  paintVfxAndPixelFont(b);

  // 5. AAA Original Krunked Built-In Multi-Frame Pixel-Art Sprites (Hero, 18 Enemies, 3 Bosses, Props, NPCs, Gothic Arch!)
  overlayBakedBuiltinArt(b);

  const keys = Object.keys(b.regions);
  return {
    width: b.width,
    height: b.height,
    albedoPixels: b.albedo,
    normalPixels: b.normal,
    emissivePixels: b.emissive,
    albedoCanvas: pixelsToCanvas(b.albedo, b.width, b.height),
    normalCanvas: pixelsToCanvas(b.normal, b.width, b.height),
    emissiveCanvas: pixelsToCanvas(b.emissive, b.width, b.height),
    regions: b.regions,
    keys,
  };
}
