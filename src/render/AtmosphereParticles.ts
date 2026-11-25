// =============================================================================
// KRUNKED CELLS — ATMOSPHERE WEATHER, SPLIT VERLET SCARF, GROUND DECALS & VFX
// 100% pre-allocated TypedArray pools: ZERO per-frame array/object allocations.
// Strictly visual-only state — never mutates SimState.
// =============================================================================

import {
  TILE_SIZE,
  TileKind,
  VIEWPORT_H,
  VIEWPORT_W,
  type BiomeId,
  type BiomeWeather,
  type SimEvent,
  type SimState,
  type TileGrid,
} from '../contracts';

// Callback signature injected by WebGL2Renderer to batch quads with zero allocs
export type EmitVfxQuadFn = (
  spriteKey: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
  flipX: number,
  flashMix: number,
  emissiveBoost: number,
  angleRad?: number
) => void;

export type EmitDynamicLightFn = (
  worldX: number,
  worldY: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  intensity: number,
  zHeight: number
) => void;

/**
 * Optional Custom Pack fxWeapon slash hook injected by WebGL2Renderer.
 * Returns true if a custom pack slash sprite was drawn, false to use Built-In art.
 */
export type EmitCustomSlashFn = (
  style: number,
  step: number,
  progress01: number,
  sx: number,
  sy: number,
  facing: number,
  scale: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  isCrit: boolean
) => boolean;

/**
 * Optional Custom Pack fxCommon debris hook (wood splinters / gibs).
 * Returns true if rendered from fxCommon, false to use Built-In sprite.
 */
export type EmitCustomDebrisFn = (
  kind: number,
  variant: number,
  sx: number,
  sy: number,
  size: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  angleRad: number
) => boolean;

const MAX_WEATHER = 160;
const MAX_BURST = 512;
const MAX_SLASHES = 24;
const MAX_RINGS = 32;
const MAX_BEAMS = 12;
const MAX_LIGHTNING_SEGS = 96;
const MAX_FLAME = 48;
const MAX_DECALS = 128;
const MAX_TRANSIENT_LIGHTS = 24;

// Split Verlet Crimson Scarf (Primary 11 nodes + Forked Secondary 8 nodes)
const SCARF_A_NODES = 11;
const SCARF_B_NODES = 8;
const SCARF_FORK_IDX = 2;

export const BURST_KIND_SPARK = 0;
export const BURST_KIND_SPLINTER = 1;
export const BURST_KIND_BLOOD = 2;
export const BURST_KIND_DUST = 3;
export const BURST_KIND_SPLASH = 4;
export const BURST_KIND_WOOD = 5;
export const BURST_KIND_GIB = 6;
export const BURST_KIND_SOUL = 7;
export const BURST_KIND_CELL_COMET = 8;

// Weapon slash visual archetypes
export const SLASH_STYLE_BLADE = 0;
export const SLASH_STYLE_HEAVY = 1;
export const SLASH_STYLE_THRUST = 2;
export const SLASH_STYLE_TWIN = 3;
export const SLASH_STYLE_WHIP = 4;
export const SLASH_STYLE_FIRE = 5;
export const SLASH_STYLE_ICE = 6;
export const SLASH_STYLE_RANGED = 7;

// Ring visual kinds:
// 0 = parry_ring, 1 = aura_ring, 2 = shield_dome, 3 = shockwave_ring,
// 4 = fireball_burst, 5 = ice_burst, 6 = parry_burst
const RING_KIND_PARRY = 0;
const RING_KIND_AURA = 1;
const RING_KIND_SHIELD = 2;
const RING_KIND_SHOCKWAVE = 3;
const RING_KIND_FIRE_BURST = 4;
const RING_KIND_ICE_BURST = 5;
const RING_KIND_PARRY_BURST = 6;

// Persistent ground decal kinds
const DECAL_KIND_BLOOD = 0;
const DECAL_KIND_SCORCH = 1;
const DECAL_KIND_FROST = 2;

// Pre-allocated RGB scratch buffer for zero-alloc hex parsing
const rgbScratch = new Float32Array(3);

function parseHexIntoScratch(hex: string | undefined, dr: number, dg: number, db: number): void {
  if (!hex) {
    rgbScratch[0] = dr;
    rgbScratch[1] = dg;
    rgbScratch[2] = db;
    return;
  }
  const clean = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  const n = parseInt(clean, 16);
  if (Number.isNaN(n)) {
    rgbScratch[0] = dr;
    rgbScratch[1] = dg;
    rgbScratch[2] = db;
    return;
  }
  rgbScratch[0] = ((n >> 16) & 255) / 255;
  rgbScratch[1] = ((n >> 8) & 255) / 255;
  rgbScratch[2] = (n & 255) / 255;
}

function classifyWeaponSlashStyle(weaponId: string): number {
  switch (weaponId) {
    case 'BroadSword':
    case 'StunMace':
      return SLASH_STYLE_HEAVY;
    case 'ImpaleSpear':
    case 'Rapier':
      return SLASH_STYLE_THRUST;
    case 'DualDaggers':
    case 'BackStabber':
      return SLASH_STYLE_TWIN;
    case 'Whip':
      return SLASH_STYLE_WHIP;
    case 'Fireball':
      return SLASH_STYLE_FIRE;
    case 'FrostBow':
      return SLASH_STYLE_ICE;
    case 'CloseCombatBow':
    case 'FastBow':
    case 'ThrowingKnife':
      return SLASH_STYLE_RANGED;
    default:
      return SLASH_STYLE_BLADE;
  }
}

export class AtmosphereParticles {
  private rngState = 0x9e3779b9;
  private lastWeather: BiomeWeather = 'none';
  private lastElapsed = 0;
  private lastBiomeId: BiomeId | '' = '';
  private lastRunSeed = -1;

  // Ambient weather pool (screen-relative wrapped around camera)
  private readonly wx = new Float32Array(MAX_WEATHER);
  private readonly wy = new Float32Array(MAX_WEATHER);
  private readonly wvx = new Float32Array(MAX_WEATHER);
  private readonly wvy = new Float32Array(MAX_WEATHER);
  private readonly wSize = new Float32Array(MAX_WEATHER);
  private readonly wPhase = new Float32Array(MAX_WEATHER);

  // Burst VFX particles (world space, supporting tile-bouncing splinters/gibs & soul wisps)
  private readonly bx = new Float32Array(MAX_BURST);
  private readonly by = new Float32Array(MAX_BURST);
  private readonly bvx = new Float32Array(MAX_BURST);
  private readonly bvy = new Float32Array(MAX_BURST);
  private readonly bLife = new Float32Array(MAX_BURST);
  private readonly bMaxLife = new Float32Array(MAX_BURST);
  private readonly bSize = new Float32Array(MAX_BURST);
  private readonly bGrav = new Float32Array(MAX_BURST);
  private readonly br = new Float32Array(MAX_BURST);
  private readonly bg = new Float32Array(MAX_BURST);
  private readonly bb = new Float32Array(MAX_BURST);
  private readonly bAngle = new Float32Array(MAX_BURST);
  private readonly bAngVel = new Float32Array(MAX_BURST);
  private readonly bRestitution = new Float32Array(MAX_BURST);
  private readonly bKind = new Uint8Array(MAX_BURST);
  private readonly bVariant = new Uint8Array(MAX_BURST);
  private readonly bFlags = new Uint8Array(MAX_BURST); // bit 0: collides, bit 1: stamp blood on hit, bit 2: settled
  private burstCursor = 0;

  // Sweeping painterly weapon slash smears
  private readonly sx = new Float32Array(MAX_SLASHES);
  private readonly sy = new Float32Array(MAX_SLASHES);
  private readonly sFacing = new Float32Array(MAX_SLASHES);
  private readonly sLife = new Float32Array(MAX_SLASHES);
  private readonly sMaxLife = new Float32Array(MAX_SLASHES);
  private readonly sScale = new Float32Array(MAX_SLASHES);
  private readonly sStep = new Uint8Array(MAX_SLASHES);
  private readonly sStyle = new Uint8Array(MAX_SLASHES);
  private readonly sCrit = new Uint8Array(MAX_SLASHES);
  private readonly sr = new Float32Array(MAX_SLASHES);
  private readonly sg = new Float32Array(MAX_SLASHES);
  private readonly sb = new Float32Array(MAX_SLASHES);
  private slashCursor = 0;
  private lastSlashIdx = -1;

  // Expanding shockwave / parry / explosion / boss-phase rings
  private readonly rx = new Float32Array(MAX_RINGS);
  private readonly ry = new Float32Array(MAX_RINGS);
  private readonly rLife = new Float32Array(MAX_RINGS);
  private readonly rMaxLife = new Float32Array(MAX_RINGS);
  private readonly rStartRad = new Float32Array(MAX_RINGS);
  private readonly rEndRad = new Float32Array(MAX_RINGS);
  private readonly rr = new Float32Array(MAX_RINGS);
  private readonly rg = new Float32Array(MAX_RINGS);
  private readonly rb = new Float32Array(MAX_RINGS);
  private readonly rKind = new Uint8Array(MAX_RINGS);
  private ringCursor = 0;

  // Vertical lightning bolts / directional guard flares (world space)
  private readonly mx = new Float32Array(MAX_BEAMS);
  private readonly my = new Float32Array(MAX_BEAMS);
  private readonly mw = new Float32Array(MAX_BEAMS);
  private readonly mh = new Float32Array(MAX_BEAMS);
  private readonly mLife = new Float32Array(MAX_BEAMS);
  private readonly mMaxLife = new Float32Array(MAX_BEAMS);
  private readonly mr = new Float32Array(MAX_BEAMS);
  private readonly mg = new Float32Array(MAX_BEAMS);
  private readonly mb = new Float32Array(MAX_BEAMS);
  private readonly mAngle = new Float32Array(MAX_BEAMS);
  private readonly mKind = new Uint8Array(MAX_BEAMS); // 0=vertical lightning bolt, 1=curved shield flare
  private beamCursor = 0;

  // Branching chain-lightning arc segments (Electric Whip / chain procs)
  private readonly lnX0 = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnY0 = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnX1 = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnY1 = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnLife = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnMaxLife = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnThick = new Float32Array(MAX_LIGHTNING_SEGS);
  private readonly lnBranch = new Uint8Array(MAX_LIGHTNING_SEGS);
  private lightningCursor = 0;

  // Homunculus plasma flame trail (world space)
  private readonly fx = new Float32Array(MAX_FLAME);
  private readonly fy = new Float32Array(MAX_FLAME);
  private readonly fvx = new Float32Array(MAX_FLAME);
  private readonly fvy = new Float32Array(MAX_FLAME);
  private readonly fLife = new Float32Array(MAX_FLAME);
  private readonly fMaxLife = new Float32Array(MAX_FLAME);
  private readonly fCyan = new Uint8Array(MAX_FLAME);
  private flameCursor = 0;
  private flameSpawnAccum = 0;

  // Split Verlet Crimson Hero Scarf (Primary 11 nodes + Forked Secondary 8 nodes)
  readonly scarfAX = new Float32Array(SCARF_A_NODES);
  readonly scarfAY = new Float32Array(SCARF_A_NODES);
  private readonly scarfAPrevX = new Float32Array(SCARF_A_NODES);
  private readonly scarfAPrevY = new Float32Array(SCARF_A_NODES);
  readonly scarfBX = new Float32Array(SCARF_B_NODES);
  readonly scarfBY = new Float32Array(SCARF_B_NODES);
  private readonly scarfBPrevX = new Float32Array(SCARF_B_NODES);
  private readonly scarfBPrevY = new Float32Array(SCARF_B_NODES);
  private scarfInit = false;
  private speedEmberAccum = 0;

  // 128-slot Persistent Ground Decal Ring Buffer (cleared automatically on biome change!)
  private readonly decalX = new Float32Array(MAX_DECALS);
  private readonly decalY = new Float32Array(MAX_DECALS);
  private readonly decalW = new Float32Array(MAX_DECALS);
  private readonly decalH = new Float32Array(MAX_DECALS);
  private readonly decalAlpha = new Float32Array(MAX_DECALS);
  private readonly decalKind = new Uint8Array(MAX_DECALS);
  private readonly decalVariant = new Uint8Array(MAX_DECALS);
  private readonly decalFlip = new Int8Array(MAX_DECALS);
  private decalCursor = 0;
  private decalCount = 0;

  // Transient dynamic point lights triggered by combat events
  private readonly lx = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly ly = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lRad = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lLife = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lMaxLife = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lr = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lg = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lb = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private readonly lIntensity = new Float32Array(MAX_TRANSIENT_LIGHTS);
  private lightCursor = 0;

  private nextRand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  clearDecals(): void {
    this.decalCount = 0;
    this.decalCursor = 0;
    this.decalAlpha.fill(0);
  }

  resetScarf(x: number, y: number, facing = 1): void {
    const dir = facing >= 0 ? -1 : 1;
    for (let i = 0; i < SCARF_A_NODES; i++) {
      const nx = x + dir * i * 2.5;
      const ny = y + i * 0.4;
      this.scarfAX[i] = nx;
      this.scarfAY[i] = ny;
      this.scarfAPrevX[i] = nx;
      this.scarfAPrevY[i] = ny;
    }
    const fx0 = this.scarfAX[SCARF_FORK_IDX];
    const fy0 = this.scarfAY[SCARF_FORK_IDX];
    for (let i = 0; i < SCARF_B_NODES; i++) {
      const nx = fx0 + dir * i * 2.2;
      const ny = fy0 + i * 0.9;
      this.scarfBX[i] = nx;
      this.scarfBY[i] = ny;
      this.scarfBPrevX[i] = nx;
      this.scarfBPrevY[i] = ny;
    }
    this.scarfInit = true;
  }

  private initWeather(weather: BiomeWeather): void {
    this.lastWeather = weather;
    for (let i = 0; i < MAX_WEATHER; i++) {
      this.wx[i] = this.nextRand() * VIEWPORT_W;
      this.wy[i] = this.nextRand() * VIEWPORT_H;
      this.wPhase[i] = this.nextRand() * Math.PI * 2;
      if (weather === 'rain') {
        this.wvx[i] = -68 - this.nextRand() * 32;
        this.wvy[i] = 275 + this.nextRand() * 95;
        this.wSize[i] = 0.7 + this.nextRand() * 0.5;
      } else if (weather === 'acidDrip') {
        this.wvx[i] = (this.nextRand() - 0.5) * 8;
        this.wvy[i] = 95 + this.nextRand() * 75;
        this.wSize[i] = 0.7 + this.nextRand() * 0.6;
      } else if (weather === 'wind') {
        this.wvx[i] = -140 - this.nextRand() * 110;
        this.wvy[i] = 12 + (this.nextRand() - 0.5) * 26;
        this.wSize[i] = 0.8 + this.nextRand() * 0.8;
      } else if (weather === 'cogs') {
        this.wvx[i] = -10 - this.nextRand() * 18;
        this.wvy[i] = 8 + this.nextRand() * 16;
        this.wSize[i] = 0.6 + this.nextRand() * 0.8;
      } else if (weather === 'embers') {
        this.wvx[i] = -14 + (this.nextRand() - 0.5) * 28;
        this.wvy[i] = -24 - this.nextRand() * 34;
        this.wSize[i] = 0.6 + this.nextRand() * 0.8;
      } else {
        // dust
        this.wvx[i] = -6 + (this.nextRand() - 0.5) * 14;
        this.wvy[i] = -8 + (this.nextRand() - 0.5) * 16;
        this.wSize[i] = 0.5 + this.nextRand() * 0.7;
      }
    }
  }

  private spawnBurst(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    grav: number,
    r: number,
    g: number,
    b: number,
    kind: number,
    variant = 0,
    angVel = 0,
    restitution = 0,
    flags = 0
  ): void {
    const i = this.burstCursor;
    this.burstCursor = (i + 1) % MAX_BURST;
    this.bx[i] = x;
    this.by[i] = y;
    this.bvx[i] = vx;
    this.bvy[i] = vy;
    this.bLife[i] = life;
    this.bMaxLife[i] = life;
    this.bSize[i] = size;
    this.bGrav[i] = grav;
    this.br[i] = r;
    this.bg[i] = g;
    this.bb[i] = b;
    this.bAngle[i] = this.nextRand() * Math.PI * 2;
    this.bAngVel[i] = angVel;
    this.bRestitution[i] = restitution;
    this.bKind[i] = kind;
    this.bVariant[i] = variant;
    this.bFlags[i] = flags;
  }

  private spawnRing(
    x: number,
    y: number,
    life: number,
    startRad: number,
    endRad: number,
    r: number,
    g: number,
    b: number,
    kind: number
  ): void {
    const i = this.ringCursor;
    this.ringCursor = (i + 1) % MAX_RINGS;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rLife[i] = life;
    this.rMaxLife[i] = life;
    this.rStartRad[i] = startRad;
    this.rEndRad[i] = endRad;
    this.rr[i] = r;
    this.rg[i] = g;
    this.rb[i] = b;
    this.rKind[i] = kind;
  }

  private spawnBeam(
    x: number,
    y: number,
    w: number,
    h: number,
    life: number,
    r: number,
    g: number,
    b: number,
    angle: number,
    kind: number
  ): void {
    const i = this.beamCursor;
    this.beamCursor = (i + 1) % MAX_BEAMS;
    this.mx[i] = x;
    this.my[i] = y;
    this.mw[i] = w;
    this.mh[i] = h;
    this.mLife[i] = life;
    this.mMaxLife[i] = life;
    this.mr[i] = r;
    this.mg[i] = g;
    this.mb[i] = b;
    this.mAngle[i] = angle;
    this.mKind[i] = kind;
  }

  private spawnLightningSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    life: number,
    thick: number,
    isBranch: number
  ): void {
    const i = this.lightningCursor;
    this.lightningCursor = (i + 1) % MAX_LIGHTNING_SEGS;
    this.lnX0[i] = x0;
    this.lnY0[i] = y0;
    this.lnX1[i] = x1;
    this.lnY1[i] = y1;
    this.lnLife[i] = life;
    this.lnMaxLife[i] = life;
    this.lnThick[i] = thick;
    this.lnBranch[i] = isBranch;
  }

  private spawnLight(
    x: number,
    y: number,
    rad: number,
    life: number,
    r: number,
    g: number,
    b: number,
    intensity: number
  ): void {
    const i = this.lightCursor;
    this.lightCursor = (i + 1) % MAX_TRANSIENT_LIGHTS;
    this.lx[i] = x;
    this.ly[i] = y;
    this.lRad[i] = rad;
    this.lLife[i] = life;
    this.lMaxLife[i] = life;
    this.lr[i] = r;
    this.lg[i] = g;
    this.lb[i] = b;
    this.lIntensity[i] = intensity;
  }

  private stampFloorDecal(
    grid: TileGrid,
    worldX: number,
    worldY: number,
    kind: number,
    scale = 1.0
  ): void {
    const tx = Math.floor(worldX / TILE_SIZE);
    const startTy = Math.floor(worldY / TILE_SIZE);
    if (tx < 0 || tx >= grid.width) return;

    // Scan downward up to 4 tiles to snap strictly onto an exposed solid/oneway floor top!
    let floorTy = -1;
    const minTy = Math.max(1, startTy);
    const maxTy = Math.min(grid.height - 1, startTy + 4);
    for (let ty = minTy; ty <= maxTy; ty++) {
      const tile = grid.tiles[ty * grid.width + tx];
      if (tile === TileKind.SOLID || tile === TileKind.ONE_WAY || tile === TileKind.CRACKED_FLOOR) {
        const above = grid.tiles[(ty - 1) * grid.width + tx];
        if (above !== TileKind.SOLID && above !== TileKind.CRACKED_FLOOR && above !== TileKind.SECRET_WALL) {
          floorTy = ty;
          break;
        }
      }
    }
    if (floorTy < 0) return;

    const i = this.decalCursor;
    this.decalCursor = (i + 1) % MAX_DECALS;
    if (this.decalCount < MAX_DECALS) this.decalCount++;

    const variant = kind === DECAL_KIND_BLOOD ? Math.floor(this.nextRand() * 3) : 0;
    const baseW =
      kind === DECAL_KIND_SCORCH
        ? 28
        : kind === DECAL_KIND_FROST
        ? 26
        : variant === 1
        ? 26
        : variant === 2
        ? 18
        : 22;
    const baseH = kind === DECAL_KIND_BLOOD ? 7 : 8;
    const jitterScale = (0.85 + this.nextRand() * 0.35) * scale;

    this.decalX[i] = worldX + (this.nextRand() - 0.5) * 6;
    this.decalY[i] = floorTy * TILE_SIZE + 2.5;
    this.decalW[i] = baseW * jitterScale;
    this.decalH[i] = baseH * Math.min(1.25, jitterScale);
    this.decalAlpha[i] = 0.92;
    this.decalKind[i] = kind;
    this.decalVariant[i] = variant;
    this.decalFlip[i] = this.nextRand() > 0.5 ? 1 : -1;
  }

  ingestEvents(events: readonly SimEvent[], state: SimState): void {
    const grid = state.tileGrid;
    for (let eIdx = 0; eIdx < events.length; eIdx++) {
      const ev = events[eIdx];
      switch (ev.type) {
        case 'biomeTransition': {
          this.clearDecals();
          this.scarfInit = false;
          break;
        }
        case 'attackSwing': {
          parseHexIntoScratch(ev.color, 0.55, 0.92, 1.0);
          const style = classifyWeaponSlashStyle(ev.weaponId);
          const i = this.slashCursor;
          this.slashCursor = (i + 1) % MAX_SLASHES;
          this.lastSlashIdx = i;
          this.sx[i] = ev.x;
          this.sy[i] = ev.y;
          this.sFacing[i] = ev.facing;
          const dur =
            style === SLASH_STYLE_HEAVY
              ? 0.19
              : style === SLASH_STYLE_WHIP
              ? 0.16
              : style === SLASH_STYLE_RANGED
              ? 0.10
              : 0.14;
          this.sLife[i] = dur;
          this.sMaxLife[i] = dur;
          this.sScale[i] =
            style === SLASH_STYLE_HEAVY
              ? 1.18
              : style === SLASH_STYLE_THRUST
              ? 1.08
              : style === SLASH_STYLE_WHIP
              ? 1.12
              : 1.02;
          this.sStep[i] = ev.stepIndex % 3;
          this.sStyle[i] = style;
          this.sCrit[i] = 0;

          if (style === SLASH_STYLE_FIRE) {
            this.sr[i] = 1.0;
            this.sg[i] = 0.56;
            this.sb[i] = 0.18;
          } else if (style === SLASH_STYLE_ICE) {
            this.sr[i] = 0.54;
            this.sg[i] = 0.94;
            this.sb[i] = 1.0;
          } else if (style === SLASH_STYLE_WHIP) {
            this.sr[i] = 0.58;
            this.sg[i] = 0.96;
            this.sb[i] = 1.0;
          } else {
            this.sr[i] = rgbScratch[0];
            this.sg[i] = rgbScratch[1];
            this.sb[i] = rgbScratch[2];
          }

          this.spawnLight(
            ev.x + ev.facing * 18,
            ev.y - 6,
            style === SLASH_STYLE_HEAVY ? 108 : 88,
            dur,
            this.sr[i],
            this.sg[i],
            this.sb[i],
            style === SLASH_STYLE_HEAVY ? 1.65 : 1.4
          );
          break;
        }
        case 'hitImpact': {
          parseHexIntoScratch(ev.color, 1.0, 0.82, 0.45);
          for (let k = 0; k < 8; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 45 + this.nextRand() * 115;
            this.spawnBurst(
              ev.x,
              ev.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 20,
              0.22 + this.nextRand() * 0.18,
              3 + this.nextRand() * 3,
              210,
              rgbScratch[0],
              rgbScratch[1],
              rgbScratch[2],
              BURST_KIND_SPARK
            );
          }
          // Subtle blood droplet burst + persistent floor spatter on melee/blood hits!
          const dir = ev.x >= state.player.pos.x ? 1 : -1;
          for (let k = 0; k < 4; k++) {
            this.spawnBurst(
              ev.x,
              ev.y,
              dir * (35 + this.nextRand() * 75) + (this.nextRand() - 0.5) * 35,
              -35 - this.nextRand() * 55,
              0.30 + this.nextRand() * 0.22,
              2.6 + this.nextRand() * 1.6,
              320,
              0.84,
              0.12,
              0.20,
              BURST_KIND_BLOOD
            );
          }
          if (ev.damageType === 'fire') {
            this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_SCORCH, 0.8);
          } else {
            this.stampFloorDecal(grid, ev.x + dir * 4, ev.y, DECAL_KIND_BLOOD, 0.82);
          }
          this.spawnLight(ev.x, ev.y, 72, 0.12, 1.0, 0.84, 0.55, 1.3);
          break;
        }
        case 'critImpact': {
          // Elevate active weapon slash smear to blistering crit gold + 1.24x scale!
          if (this.lastSlashIdx >= 0 && this.sLife[this.lastSlashIdx] > 0) {
            this.sCrit[this.lastSlashIdx] = 1;
            this.sScale[this.lastSlashIdx] = Math.min(1.55, this.sScale[this.lastSlashIdx] * 1.24);
            this.sr[this.lastSlashIdx] = 1.0;
            this.sg[this.lastSlashIdx] = 0.94;
            this.sb[this.lastSlashIdx] = 0.58;
          }
          for (let k = 0; k < 16; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 70 + this.nextRand() * 165;
            this.spawnBurst(
              ev.x,
              ev.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 25,
              0.28 + this.nextRand() * 0.24,
              4 + this.nextRand() * 4,
              180,
              1.0,
              0.92,
              0.36,
              BURST_KIND_SPARK
            );
          }
          this.spawnRing(ev.x, ev.y, 0.22, 10, 48, 1.0, 0.90, 0.34, RING_KIND_PARRY);
          this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_BLOOD, 1.15);
          this.spawnLight(ev.x, ev.y, 134, 0.22, 1.0, 0.88, 0.36, 2.3);
          break;
        }
        case 'bleedBurst': {
          for (let k = 0; k < 10; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 45 + this.nextRand() * 95;
            this.spawnBurst(
              ev.x,
              ev.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 30,
              0.32 + this.nextRand() * 0.2,
              3.2 + this.nextRand() * 2.0,
              300,
              0.92,
              0.12,
              0.22,
              BURST_KIND_BLOOD
            );
          }
          this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_BLOOD, 1.1);
          break;
        }
        case 'freezeShatter': {
          this.spawnRing(ev.x, ev.y, 0.26, 8, 42, 0.65, 0.96, 1.0, RING_KIND_ICE_BURST);
          for (let k = 0; k < 14; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 60 + this.nextRand() * 130;
            this.spawnBurst(
              ev.x,
              ev.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 35,
              0.35 + this.nextRand() * 0.22,
              3.5 + this.nextRand() * 2.5,
              280,
              0.68,
              0.95,
              1.0,
              BURST_KIND_SPLINTER,
              0,
              (this.nextRand() - 0.5) * 14
            );
          }
          this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_FROST, 1.15);
          this.spawnLight(ev.x, ev.y, 96, 0.24, 0.52, 0.94, 1.0, 1.7);
          break;
        }
        case 'statusProc': {
          if (ev.status === 'freeze' || ev.status === 'frost') {
            this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_FROST, 0.95);
          } else if (ev.status === 'burn') {
            this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_SCORCH, 0.85);
          } else if (ev.status === 'bleed') {
            this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_BLOOD, 0.78);
          }
          break;
        }
        case 'lightningArc': {
          const pts = ev.points;
          if (pts && pts.length >= 2) {
            for (let pIdx = 0; pIdx < pts.length - 1; pIdx++) {
              const ax = pts[pIdx].x;
              const ay = pts[pIdx].y;
              const bx = pts[pIdx + 1].x;
              const by = pts[pIdx + 1].y;
              const dx = bx - ax;
              const dy = by - ay;
              const dist = Math.hypot(dx, dy) || 1;
              const nx = -dy / dist;
              const ny = dx / dist;
              const segs = Math.max(3, Math.min(6, Math.round(dist / 22)));
              let prevX = ax;
              let prevY = ay;
              for (let s = 1; s <= segs; s++) {
                const t = s / segs;
                const jitter = s < segs ? (this.nextRand() - 0.5) * Math.min(18, dist * 0.24) : 0;
                const curX = ax + dx * t + nx * jitter;
                const curY = ay + dy * t + ny * jitter;
                this.spawnLightningSegment(prevX, prevY, curX, curY, 0.17, 2.8, 0);

                // Electric side-fork branch on interior joints!
                if (s > 1 && s < segs && this.nextRand() < 0.65) {
                  const side = this.nextRand() > 0.5 ? 1 : -1;
                  const bLen = 10 + this.nextRand() * 14;
                  const fX = curX + (dx / dist) * (bLen * 0.45) + nx * side * bLen;
                  const fY = curY + (dy / dist) * (bLen * 0.45) + ny * side * bLen;
                  this.spawnLightningSegment(curX, curY, fX, fY, 0.13, 1.5, 1);
                }
                prevX = curX;
                prevY = curY;
              }
              // Electric node sparks + cyan flash light on struck target
              for (let k = 0; k < 5; k++) {
                const ang = this.nextRand() * Math.PI * 2;
                const spd = 45 + this.nextRand() * 85;
                this.spawnBurst(
                  bx,
                  by,
                  Math.cos(ang) * spd,
                  Math.sin(ang) * spd,
                  0.18 + this.nextRand() * 0.12,
                  3.2,
                  60,
                  0.48,
                  0.96,
                  1.0,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(bx, by, 86, 0.18, 0.42, 0.94, 1.0, 1.85);
            }
          }
          break;
        }
        case 'parrySuccess': {
          // Explosive 4-point golden star parry_burst + concentric shockwave ring!
          this.spawnRing(ev.x, ev.y - 12, 0.30, 18, 76, 1.0, 0.94, 0.46, RING_KIND_PARRY_BURST);
          this.spawnRing(ev.x, ev.y - 12, 0.34, 14, 78, 1.0, 0.9, 0.38, RING_KIND_PARRY);
          for (let k = 0; k < 20; k++) {
            const ang = (k / 20) * Math.PI * 2;
            const spd = 95 + this.nextRand() * 95;
            this.spawnBurst(
              ev.x,
              ev.y - 12,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd,
              0.32,
              4.5,
              90,
              1.0,
              0.92,
              0.42,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(ev.x, ev.y - 12, 160, 0.34, 1.0, 0.92, 0.44, 2.6);
          break;
        }
        case 'parryStart': {
          const fx = ev.x + ev.facing * 12;
          const fy = ev.y - 12;
          this.spawnBeam(fx, fy, 16, 36, 0.16, 1.0, 0.9, 0.36, ev.facing > 0 ? 0 : Math.PI, 1);
          this.spawnRing(fx, fy, 0.18, 6, 26, 1.0, 0.9, 0.38, RING_KIND_PARRY);
          for (let k = 0; k < 7; k++) {
            const ang = (k / 6 - 0.5) * 1.4 + (ev.facing < 0 ? Math.PI : 0);
            const spd = 48 + this.nextRand() * 64;
            this.spawnBurst(
              fx,
              fy + (k - 3) * 3.5,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 10,
              0.18 + this.nextRand() * 0.12,
              3.2 + this.nextRand() * 1.8,
              90,
              1.0,
              0.92,
              0.42,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(fx, fy, 68, 0.22, 1.0, 0.86, 0.36, 1.1);
          break;
        }
        case 'shieldBlock': {
          const bx = ev.x;
          const by = ev.y - 12;
          this.spawnRing(bx, by, 0.26, 8, 44, 0.76, 0.95, 1.0, RING_KIND_SHIELD);
          this.spawnRing(bx, by, 0.20, 6, 30, 1.0, 0.98, 0.92, RING_KIND_PARRY);
          for (let k = 0; k < 14; k++) {
            const ang = (k / 14) * Math.PI * 2 + (this.nextRand() - 0.5) * 0.25;
            const spd = 72 + this.nextRand() * 115;
            this.spawnBurst(
              bx,
              by,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 18,
              0.24 + this.nextRand() * 0.18,
              3.5 + this.nextRand() * 2.5,
              200,
              0.78 + this.nextRand() * 0.22,
              0.94,
              1.0,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(bx, by, 84, 0.26, 0.78, 0.95, 1.0, 1.3);
          break;
        }
        case 'explosion': {
          const isFire = ev.element === 'fire';
          const isIce = ev.element === 'ice';
          const lr = isFire ? 1.0 : isIce ? 0.40 : 1.0;
          const lg = isFire ? 0.42 : isIce ? 0.925 : 0.824;
          const lb = isFire ? 0.17 : isIce ? 1.0 : 0.341;
          const rad = Math.max(36, ev.radius);

          this.spawnRing(
            ev.x,
            ev.y,
            0.20,
            8,
            Math.max(30, rad * 0.75),
            isIce ? 0.88 : 1.0,
            isIce ? 0.98 : 0.96,
            isIce ? 1.0 : 0.78,
            isIce ? RING_KIND_ICE_BURST : RING_KIND_FIRE_BURST
          );
          this.spawnRing(
            ev.x,
            ev.y,
            0.36,
            12,
            Math.max(58, rad * 1.38),
            lr,
            lg,
            lb,
            RING_KIND_SHOCKWAVE
          );
          this.spawnRing(
            ev.x,
            ev.y,
            0.28,
            10,
            Math.max(44, rad * 1.05),
            isFire ? 1.0 : isIce ? 0.72 : 1.0,
            isFire ? 0.76 : isIce ? 0.98 : 0.92,
            isFire ? 0.24 : isIce ? 1.0 : 0.56,
            RING_KIND_AURA
          );

          for (let k = 0; k < 24; k++) {
            const ang = (k / 24) * Math.PI * 2 + (this.nextRand() - 0.5) * 0.26;
            const spd = 60 + this.nextRand() * Math.max(135, rad * 2.3);
            const warmMix = this.nextRand();
            const pr = isFire ? 1.0 : isIce ? 0.42 + warmMix * 0.56 : 1.0;
            const pg = isFire ? 0.28 + warmMix * 0.62 : isIce ? 0.88 + warmMix * 0.12 : 0.62 + warmMix * 0.34;
            const pb = isFire ? 0.10 + warmMix * 0.22 : isIce ? 1.0 : 0.22 + warmMix * 0.36;
            const kind =
              isIce && (k & 1) === 0
                ? BURST_KIND_SPLINTER
                : k % 3 === 0
                ? BURST_KIND_SPLINTER
                : BURST_KIND_SPARK;
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 10,
              ev.y + (this.nextRand() - 0.5) * 10,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 30,
              0.30 + this.nextRand() * 0.28,
              3.8 + this.nextRand() * 3.8,
              isIce ? 165 : 220,
              pr,
              pg,
              pb,
              kind
            );
          }

          this.stampFloorDecal(grid, ev.x, ev.y, isIce ? DECAL_KIND_FROST : DECAL_KIND_SCORCH, 1.25);
          this.spawnLight(ev.x, ev.y, Math.max(120, ev.radius * 2.4), 0.38, lr, lg, lb, 2.0);
          break;
        }
        case 'skillCast': {
          const sx = ev.x;
          const sy = ev.y - 12;
          switch (ev.skillId) {
            case 'Phaser': {
              this.spawnBeam(sx, sy - 42, 16, 130, 0.24, 0.35, 0.96, 1.0, 0, 0);
              this.spawnRing(sx, sy, 0.28, 8, 56, 0.32, 0.95, 1.0, RING_KIND_SHOCKWAVE);
              for (let k = 0; k < 14; k++) {
                const ang = this.nextRand() * Math.PI * 2;
                const spd = 55 + this.nextRand() * 130;
                this.spawnBurst(
                  sx + (this.nextRand() - 0.5) * 12,
                  sy - this.nextRand() * 30,
                  Math.cos(ang) * spd,
                  Math.sin(ang) * spd - 20,
                  0.24 + this.nextRand() * 0.20,
                  3.6 + this.nextRand() * 2.4,
                  80,
                  0.38,
                  0.96,
                  1.0,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy - 10, 132, 0.30, 0.32, 0.95, 1.0, 2.0);
              break;
            }
            case 'WaveOfDenial': {
              this.spawnRing(sx, sy, 0.26, 12, 108, 0.42, 0.96, 1.0, RING_KIND_SHOCKWAVE);
              this.spawnRing(sx, sy, 0.36, 6, 86, 0.78, 0.98, 1.0, RING_KIND_SHIELD);
              for (let k = 0; k < 16; k++) {
                const dir = (k & 1) === 0 ? 1 : -1;
                const spd = 110 + this.nextRand() * 145;
                this.spawnBurst(
                  sx + dir * (4 + this.nextRand() * 12),
                  sy + (this.nextRand() - 0.5) * 26,
                  dir * spd,
                  (this.nextRand() - 0.5) * 42,
                  0.22 + this.nextRand() * 0.16,
                  4.0 + this.nextRand() * 2.5,
                  0,
                  0.52,
                  0.96,
                  1.0,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy, 145, 0.30, 0.42, 0.96, 1.0, 1.9);
              break;
            }
            case 'CorruptedPower': {
              this.spawnBeam(sx, sy - 36, 14, 96, 0.26, 0.78, 0.28, 1.0, 0, 0);
              this.spawnRing(sx, sy, 0.34, 10, 68, 0.86, 0.22, 1.0, RING_KIND_AURA);
              this.spawnRing(sx, sy, 0.24, 6, 44, 1.0, 0.24, 0.42, RING_KIND_SHOCKWAVE);
              for (let k = 0; k < 16; k++) {
                const spread = (k / 15 - 0.5) * 2.2;
                const spd = 65 + this.nextRand() * 110;
                this.spawnBurst(
                  sx + (k - 7.5) * 2.2,
                  sy - 8,
                  Math.sin(spread) * spd,
                  -Math.cos(spread) * spd - 35,
                  0.30 + this.nextRand() * 0.22,
                  3.8 + this.nextRand() * 2.6,
                  110,
                  (k & 1) === 0 ? 0.85 : 1.0,
                  0.24,
                  (k & 1) === 0 ? 1.0 : 0.42,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy - 8, 138, 0.36, 0.84, 0.24, 1.0, 2.1);
              break;
            }
            case 'KnifeDance': {
              this.spawnRing(sx, sy, 0.28, 10, 80, 1.0, 0.22, 0.34, RING_KIND_SHOCKWAVE);
              this.spawnRing(sx, sy, 0.20, 8, 52, 1.0, 0.65, 0.72, RING_KIND_PARRY);
              for (let k = 0; k < 14; k++) {
                const ang = (k / 14) * Math.PI * 2;
                const spd = 105 + this.nextRand() * 95;
                this.spawnBurst(
                  sx,
                  sy,
                  Math.cos(ang) * spd,
                  Math.sin(ang) * spd,
                  0.24 + this.nextRand() * 0.14,
                  4.2,
                  40,
                  1.0,
                  0.24,
                  0.36,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy, 120, 0.26, 1.0, 0.24, 0.36, 1.8);
              break;
            }
            case 'Tonic': {
              this.spawnRing(sx, sy, 0.38, 10, 62, 0.24, 1.0, 0.68, RING_KIND_SHIELD);
              for (let k = 0; k < 18; k++) {
                const ang = (k / 18) * Math.PI * 4;
                const rad = 6 + (k / 18) * 18;
                this.spawnBurst(
                  sx + Math.cos(ang) * rad,
                  sy + 10 - k * 1.4,
                  Math.cos(ang + 1.2) * 32,
                  -48 - this.nextRand() * 48,
                  0.42 + this.nextRand() * 0.22,
                  3.8 + this.nextRand() * 2.0,
                  -25,
                  0.24,
                  1.0,
                  0.66 + (k % 2) * 0.24,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy, 130, 0.40, 0.24, 1.0, 0.68, 1.9);
              break;
            }
            case 'SinewSlicer':
            case 'HeavyTurret':
            case 'WolfTrap': {
              this.spawnRing(sx, sy + 6, 0.22, 6, 36, 1.0, 0.78, 0.32, RING_KIND_PARRY);
              for (let k = 0; k < 12; k++) {
                const ang = this.nextRand() * Math.PI * 2;
                const spd = 42 + this.nextRand() * 88;
                this.spawnBurst(
                  sx,
                  sy + 6,
                  Math.cos(ang) * spd,
                  Math.sin(ang) * spd - 28,
                  0.24 + this.nextRand() * 0.16,
                  3.4 + this.nextRand() * 2.2,
                  220,
                  1.0,
                  0.78,
                  0.32,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy + 4, 92, 0.24, 1.0, 0.76, 0.32, 1.4);
              break;
            }
            default: {
              const isIceG = ev.skillId === 'IceGrenade';
              const isFireG = ev.skillId === 'FireGrenade';
              const gr = isIceG ? 0.42 : 1.0;
              const gg = isIceG ? 0.94 : isFireG ? 0.48 : 0.84;
              const gb = isIceG ? 1.0 : isFireG ? 0.18 : 0.36;
              for (let k = 0; k < 8; k++) {
                const ang = this.nextRand() * Math.PI * 2;
                const spd = 38 + this.nextRand() * 68;
                this.spawnBurst(
                  sx,
                  sy,
                  Math.cos(ang) * spd,
                  Math.sin(ang) * spd - 22,
                  0.18 + this.nextRand() * 0.14,
                  3.2,
                  120,
                  gr,
                  gg,
                  gb,
                  BURST_KIND_SPARK
                );
              }
              this.spawnLight(sx, sy, 76, 0.18, gr, gg, gb, 1.25);
              break;
            }
          }
          break;
        }
        case 'diveSlamImpact': {
          this.spawnRing(
            ev.x,
            ev.y - 4,
            0.30,
            14,
            Math.max(58, ev.radius * 1.4),
            0.45,
            0.9,
            1.0,
            RING_KIND_SHOCKWAVE
          );
          for (let k = 0; k < 16; k++) {
            const dir = k % 2 === 0 ? 1 : -1;
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 16,
              ev.y - 2,
              dir * (45 + this.nextRand() * 130),
              -70 - this.nextRand() * 120,
              0.38 + this.nextRand() * 0.28,
              4 + this.nextRand() * 3,
              390,
              0.72,
              0.78,
              0.9,
              BURST_KIND_SPLINTER,
              0,
              (this.nextRand() - 0.5) * 14,
              0.35,
              1
            );
          }
          this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_SCORCH, 0.95);
          this.spawnLight(ev.x, ev.y - 6, 130, 0.26, 0.45, 0.92, 1.0, 2.1);
          break;
        }
        case 'doorSmash': {
          // 14 tumbling tile-bouncing wooden door planks (`vfx:wood_splinter_0..2`) + 8 wood dust puffs!
          const dir = ev.x >= state.player.pos.x ? 1 : -1;
          for (let k = 0; k < 14; k++) {
            const kick = dir * (55 + this.nextRand() * 165) + (this.nextRand() - 0.5) * 80;
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 10,
              ev.y - 4 - this.nextRand() * 32,
              kick,
              -75 - this.nextRand() * 125,
              1.9 + this.nextRand() * 0.75,
              1.0 + this.nextRand() * 0.35,
              440,
              1.0,
              0.94,
              0.86,
              BURST_KIND_WOOD,
              k % 3,
              (this.nextRand() - 0.5) * 18,
              0.42,
              1 // collides with solid floors & bounces!
            );
          }
          for (let k = 0; k < 8; k++) {
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 14,
              ev.y - 8 - this.nextRand() * 24,
              dir * (25 + this.nextRand() * 65) + (this.nextRand() - 0.5) * 40,
              -20 - this.nextRand() * 45,
              0.38 + this.nextRand() * 0.24,
              4.2 + this.nextRand() * 2.8,
              95,
              0.78,
              0.62,
              0.44,
              BURST_KIND_DUST
            );
          }
          this.spawnLight(ev.x, ev.y - 16, 94, 0.18, 1.0, 0.80, 0.44, 1.5);
          break;
        }
        case 'enemyTelegraph': {
          if (ev.unparriable) {
            this.spawnRing(ev.x, ev.y - 26, 0.22, 6, 28, 1.0, 0.24, 0.22, RING_KIND_AURA);
            this.spawnLight(ev.x, ev.y - 26, 72, 0.24, 1.0, 0.26, 0.20, 1.45);
          } else {
            this.spawnRing(ev.x, ev.y - 28, 0.18, 4, 22, 1.0, 0.88, 0.26, RING_KIND_PARRY);
            this.spawnLight(ev.x, ev.y - 26, 62, 0.20, 1.0, 0.82, 0.24, 1.25);
          }
          break;
        }
        case 'enemyDeath': {
          const dir = ev.x >= state.player.pos.x ? 1 : -1;
          // 1. Directional tile-bouncing enemy gibs (`vfx:gib_0..2`) that stamp blood decals on first bounce!
          const gibCount = ev.isBoss ? 18 : ev.isElite ? 12 : 8;
          for (let k = 0; k < gibCount; k++) {
            const forward = dir * (45 + this.nextRand() * (ev.isBoss ? 170 : 120));
            const spread = (this.nextRand() - 0.35) * 90;
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 12,
              ev.y - 10 - this.nextRand() * 14,
              forward + spread,
              -85 - this.nextRand() * (ev.isBoss ? 155 : 115),
              1.6 + this.nextRand() * 0.9,
              ev.isBoss ? 1.35 : ev.isElite ? 1.15 : 1.0,
              460,
              1.0,
              0.96,
              0.96,
              BURST_KIND_GIB,
              k % 3,
              (this.nextRand() - 0.5) * 16,
              0.38,
              3 // bit 0: tile collide + bit 1: paint blood decal on first floor strike!
            );
          }
          // 2. Crimson blood spray droplets
          const bloodCount = ev.isBoss ? 22 : ev.isElite ? 14 : 10;
          for (let k = 0; k < bloodCount; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 40 + this.nextRand() * (ev.isBoss ? 180 : 105);
            this.spawnBurst(
              ev.x,
              ev.y - 12,
              Math.cos(ang) * spd + dir * 35,
              Math.sin(ang) * spd - 35,
              0.36 + this.nextRand() * 0.30,
              ev.isBoss ? 5.0 : 3.2,
              290,
              ev.isBoss ? 1.0 : 0.86,
              ev.isBoss ? 0.45 : 0.14,
              ev.isBoss ? 0.22 : 0.24,
              BURST_KIND_BLOOD
            );
          }
          // 3. Ascending curving cyan-violet soul wisps (`vfx:soul_wisp`)!
          const wispCount = ev.isBoss ? 8 : ev.isElite ? 5 : 4;
          for (let k = 0; k < wispCount; k++) {
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 18,
              ev.y - 8 - this.nextRand() * 14,
              (this.nextRand() - 0.5) * 26,
              -42 - this.nextRand() * 28,
              0.75 + this.nextRand() * 0.45,
              0.85 + this.nextRand() * 0.4,
              -12,
              0.42,
              0.92,
              1.0,
              BURST_KIND_SOUL,
              k & 1,
              this.nextRand() * Math.PI * 2 // used as sine phase for X sway!
            );
          }
          // Immediate corpse floor blood decal
          this.stampFloorDecal(grid, ev.x, ev.y, DECAL_KIND_BLOOD, ev.isBoss ? 1.55 : ev.isElite ? 1.25 : 1.0);
          if (ev.isBoss) {
            this.spawnRing(ev.x, ev.y - 24, 0.55, 16, 145, 1.0, 0.72, 0.25, RING_KIND_AURA);
            this.spawnLight(ev.x, ev.y - 24, 210, 0.6, 1.0, 0.75, 0.35, 2.8);
          }
          break;
        }
        case 'bossPhaseShift': {
          this.spawnRing(ev.x, ev.y - 24, 0.5, 14, 128, 1.0, 0.32, 0.22, RING_KIND_AURA);
          this.spawnLight(ev.x, ev.y - 24, 195, 0.55, 1.0, 0.38, 0.25, 2.6);
          break;
        }
        case 'flaskDrink': {
          for (let k = 0; k < 14; k++) {
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 16,
              ev.y - this.nextRand() * 24,
              (this.nextRand() - 0.5) * 35,
              -45 - this.nextRand() * 55,
              0.45 + this.nextRand() * 0.25,
              4,
              -30,
              0.28,
              1.0,
              0.58,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(ev.x, ev.y - 16, 115, 0.36, 0.3, 1.0, 0.6, 1.8);
          break;
        }
        case 'scrollPickup': {
          const r = ev.stat === 'brutality' ? 1.0 : ev.stat === 'tactics' ? 0.75 : 0.28;
          const g = ev.stat === 'brutality' ? 0.28 : ev.stat === 'tactics' ? 0.36 : 1.0;
          const b = ev.stat === 'brutality' ? 0.32 : ev.stat === 'tactics' ? 1.0 : 0.52;
          this.spawnRing(ev.x, ev.y - 14, 0.42, 8, 68, r, g, b, RING_KIND_SHIELD);
          this.spawnLight(ev.x, ev.y - 14, 130, 0.4, r, g, b, 2.0);
          break;
        }
        case 'curseTriggered': {
          this.spawnRing(ev.x, ev.y - 14, 0.45, 10, 78, 0.88, 0.12, 0.32, RING_KIND_AURA);
          this.spawnLight(ev.x, ev.y - 14, 145, 0.45, 0.92, 0.14, 0.38, 2.2);
          break;
        }
        case 'curseCleared': {
          this.spawnRing(ev.x, ev.y - 28, 0.42, 8, 72, 0.32, 1.0, 0.68, RING_KIND_PARRY_BURST);
          for (let k = 0; k < 16; k++) {
            const ang = (k / 16) * Math.PI * 2;
            const spd = 55 + this.nextRand() * 85;
            this.spawnBurst(
              ev.x,
              ev.y - 28,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 20,
              0.42 + this.nextRand() * 0.22,
              4.0,
              60,
              (k & 1) === 0 ? 0.32 : 1.0,
              (k & 1) === 0 ? 1.0 : 0.90,
              (k & 1) === 0 ? 0.68 : 0.36,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(ev.x, ev.y - 24, 150, 0.42, 0.36, 1.0, 0.72, 2.2);
          break;
        }
        case 'jump':
        case 'land':
        case 'dodgeRoll': {
          const cnt = ev.type === 'land' ? 6 : 4;
          for (let k = 0; k < cnt; k++) {
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 10,
              ev.y - 1,
              (this.nextRand() - 0.5) * 55,
              -12 - this.nextRand() * 30,
              0.24 + this.nextRand() * 0.16,
              3,
              60,
              0.72,
              0.74,
              0.82,
              BURST_KIND_DUST
            );
          }
          break;
        }
        case 'playerDamaged': {
          this.spawnLight(ev.x, ev.y - 12, 95, 0.22, 1.0, 0.2, 0.25, 1.8);
          break;
        }
        case 'cellCollect': {
          for (let k = 0; k < 6; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 35 + this.nextRand() * 55;
            this.spawnBurst(
              ev.x,
              ev.y - 14,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 12,
              0.22 + this.nextRand() * 0.14,
              3.2,
              30,
              0.28,
              0.94,
              1.0,
              BURST_KIND_SPARK
            );
          }
          this.spawnLight(ev.x, ev.y - 12, 72, 0.20, 0.28, 0.94, 1.0, 1.5);
          break;
        }
        case 'goldCollect': {
          for (let k = 0; k < 4; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 25 + this.nextRand() * 48;
            this.spawnBurst(
              ev.x,
              ev.y - 10,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 16,
              0.20 + this.nextRand() * 0.12,
              2.8,
              80,
              1.0,
              0.88,
              0.32,
              BURST_KIND_SPARK
            );
          }
          break;
        }
        case 'teleport': {
          this.spawnRing(ev.toX, ev.toY - 14, 0.38, 6, 54, 0.32, 0.95, 1.0, RING_KIND_SHIELD);
          this.spawnLight(ev.toX, ev.toY - 14, 130, 0.36, 0.32, 0.95, 1.0, 2.0);
          break;
        }
        case 'shopReroll': {
          this.spawnRing(ev.x, ev.y - 16, 0.34, 8, 56, 1.0, 0.84, 0.32, RING_KIND_PARRY);
          this.spawnLight(ev.x, ev.y - 16, 115, 0.34, 1.0, 0.84, 0.36, 1.8);
          break;
        }
        default:
          break;
      }
    }
  }

  private stepVerletRibbon(
    xs: Float32Array,
    ys: Float32Array,
    prevXs: Float32Array,
    prevYs: Float32Array,
    count: number,
    anchorX: number,
    anchorY: number,
    segLen: number,
    windX: number,
    gravY: number,
    turbAmp: number,
    phaseOff: number,
    elapsedSec: number,
    dt: number
  ): void {
    const dt2 = dt * dt;
    xs[0] = anchorX;
    ys[0] = anchorY;
    prevXs[0] = anchorX;
    prevYs[0] = anchorY;

    // 1. Verlet integration with velocity damping
    for (let i = 1; i < count; i++) {
      const cx = xs[i];
      const cy = ys[i];
      const vx = (cx - prevXs[i]) * 0.88;
      const vy = (cy - prevYs[i]) * 0.88;
      prevXs[i] = cx;
      prevYs[i] = cy;

      const wave = Math.sin(elapsedSec * 14.5 - i * 0.72 + phaseOff);
      const ax = windX + wave * turbAmp * 0.35;
      const ay = gravY + wave * turbAmp;
      xs[i] = cx + vx + ax * dt2;
      ys[i] = cy + vy + ay * dt2;
    }

    // 2. 3 distance-constraint relaxation iterations for organic whip tension
    for (let iter = 0; iter < 3; iter++) {
      xs[0] = anchorX;
      ys[0] = anchorY;
      for (let i = 1; i < count; i++) {
        const dx = xs[i] - xs[i - 1];
        const dy = ys[i] - ys[i - 1];
        const dist = Math.hypot(dx, dy) || 0.0001;
        const diff = (dist - segLen) / dist;
        if (i === 1) {
          xs[i] -= dx * diff;
          ys[i] -= dy * diff;
        } else {
          xs[i - 1] += dx * diff * 0.28;
          ys[i - 1] += dy * diff * 0.28;
          xs[i] -= dx * diff * 0.72;
          ys[i] -= dy * diff * 0.72;
        }
      }
    }
  }

  step(
    state: SimState,
    weather: BiomeWeather,
    elapsedSec: number,
    heroX: number,
    heroY: number,
    camX: number,
    camY: number,
    neckWorldX?: number,
    neckWorldY?: number
  ): void {
    let dt = elapsedSec - this.lastElapsed;
    this.lastElapsed = elapsedSec;
    if (dt <= 0 || dt > 0.1) dt = 1 / 60;

    // Automatically clear persistent decals & reset scarf on biome change or new run!
    if (state.activeBiomeId !== this.lastBiomeId || state.runSeed !== this.lastRunSeed) {
      this.lastBiomeId = state.activeBiomeId;
      this.lastRunSeed = state.runSeed;
      this.clearDecals();
      this.scarfInit = false;
    }

    if (weather !== this.lastWeather) {
      this.initWeather(weather);
    }

    const p = state.player;
    const grid = state.tileGrid;

    // 1. Update 2 Split Verlet Crimson Scarf Ribbons (11 nodes primary + 8 nodes forked secondary)
    const isRoll = p.actionState === 'roll';
    const isDive = p.actionState === 'diveSlam';
    const anchorX =
      neckWorldX !== undefined
        ? neckWorldX - p.facing * 2.0
        : isRoll
        ? heroX
        : heroX - p.facing * 2.2;
    const anchorY =
      neckWorldY !== undefined
        ? neckWorldY + 3.0
        : isRoll
        ? heroY - 12
        : isDive
        ? heroY - 22
        : heroY - 23;

    if (
      !this.scarfInit ||
      Math.hypot(this.scarfAX[0] - anchorX, this.scarfAY[0] - anchorY) > 64
    ) {
      this.resetScarf(anchorX, anchorY, p.facing);
    }

    const rollWhipX = isRoll ? Math.cos(elapsedSec * 24.0) * 140 : 0;
    const rollWhipY = isRoll ? Math.sin(elapsedSec * 24.0) * 110 : 0;
    const baseWindX =
      -p.facing * 95 - p.vel.x * 0.85 + rollWhipX + (p.speedBuffTicks > 0 ? -p.facing * 90 : 0);
    const baseGravY = isDive ? -290 : 72 + rollWhipY;

    this.stepVerletRibbon(
      this.scarfAX,
      this.scarfAY,
      this.scarfAPrevX,
      this.scarfAPrevY,
      SCARF_A_NODES,
      anchorX,
      anchorY,
      2.6,
      baseWindX,
      baseGravY,
      68,
      0.0,
      elapsedSec,
      dt
    );
    this.stepVerletRibbon(
      this.scarfBX,
      this.scarfBY,
      this.scarfBPrevX,
      this.scarfBPrevY,
      SCARF_B_NODES,
      this.scarfAX[SCARF_FORK_IDX],
      this.scarfAY[SCARF_FORK_IDX] + 1.0,
      2.4,
      baseWindX * 0.84,
      baseGravY + 34,
      82,
      1.75,
      elapsedSec,
      dt
    );

    // Speed-buff wind embers trailing off primary scarf tips (nodes 9-10)!
    if (p.speedBuffTicks > 0 && p.actionState !== 'dead') {
      this.speedEmberAccum += dt;
      if (this.speedEmberAccum >= 0.045) {
        this.speedEmberAccum = 0;
        const tipIdx = this.nextRand() > 0.5 ? SCARF_A_NODES - 1 : SCARF_A_NODES - 2;
        const isGold = this.nextRand() > 0.45;
        this.spawnBurst(
          this.scarfAX[tipIdx],
          this.scarfAY[tipIdx],
          -p.facing * (18 + this.nextRand() * 24),
          -8 + (this.nextRand() - 0.5) * 20,
          0.24 + this.nextRand() * 0.14,
          2.6,
          -15,
          isGold ? 1.0 : 0.36,
          isGold ? 0.88 : 0.94,
          isGold ? 0.36 : 1.0,
          BURST_KIND_SPARK
        );
      }
    }

    // 2. Spawn & step Homunculus Plasma Flame Trail (anchored at live neck socket!)
    const flameOriginX = neckWorldX ?? heroX;
    const flameOriginY = neckWorldY !== undefined ? neckWorldY - 4 : heroY - 29;
    this.flameSpawnAccum += dt;
    while (this.flameSpawnAccum >= 0.028) {
      this.flameSpawnAccum -= 0.028;
      if (p.actionState === 'dead') break;
      const i = this.flameCursor;
      this.flameCursor = (i + 1) % MAX_FLAME;
      this.fx[i] = flameOriginX + (this.nextRand() - 0.5) * 5;
      this.fy[i] = flameOriginY + (this.nextRand() - 0.5) * 3;
      this.fvx[i] = -p.vel.x * 0.16 + (this.nextRand() - 0.5) * 18;
      this.fvy[i] = -24 - this.nextRand() * 24;
      this.fLife[i] = 0.26 + this.nextRand() * 0.22;
      this.fMaxLife[i] = this.fLife[i];
      this.fCyan[i] = this.nextRand() > 0.42 ? 1 : 0;
    }
    for (let i = 0; i < MAX_FLAME; i++) {
      if (this.fLife[i] <= 0) continue;
      this.fLife[i] -= dt;
      this.fx[i] += this.fvx[i] * dt;
      this.fy[i] += this.fvy[i] * dt;
    }

    // 2B. Emit silky curved cyan comet tail sparks behind moving blue Cell pickups!
    for (let i = 0; i < state.pickups.length; i++) {
      const pk = state.pickups[i];
      if (pk.collected || pk.kind !== 'cell') continue;
      const speedSq = pk.vel.x * pk.vel.x + pk.vel.y * pk.vel.y;
      if (speedSq > 1600) {
        this.spawnBurst(
          pk.pos.x + (this.nextRand() - 0.5) * 2.5,
          pk.pos.y + (this.nextRand() - 0.5) * 2.5,
          -pk.vel.x * 0.08 + (this.nextRand() - 0.5) * 14,
          -pk.vel.y * 0.08 + (this.nextRand() - 0.5) * 14,
          0.22 + this.nextRand() * 0.12,
          3.4 + this.nextRand() * 1.4,
          0,
          0.22,
          0.94,
          1.0,
          BURST_KIND_CELL_COMET
        );
      }
    }

    // 3. Step Ambient Biome Weather + Rain Puddle Splashes
    for (let i = 0; i < MAX_WEATHER; i++) {
      this.wx[i] += this.wvx[i] * dt;
      this.wy[i] += this.wvy[i] * dt;

      if (weather === 'rain' || weather === 'acidDrip') {
        const worldX = camX + this.wx[i];
        const worldY = camY + this.wy[i];
        const tx = Math.floor(worldX / TILE_SIZE);
        const ty = Math.floor(worldY / TILE_SIZE);
        if (tx >= 0 && ty >= 0 && tx < grid.width && ty < grid.height) {
          const tile = grid.tiles[ty * grid.width + tx];
          if (tile === TileKind.SOLID || tile === TileKind.ONE_WAY) {
            this.spawnBurst(
              worldX,
              ty * TILE_SIZE - 1,
              (this.nextRand() - 0.5) * 36,
              -22 - this.nextRand() * 25,
              0.16,
              2.5,
              220,
              weather === 'acidDrip' ? 0.52 : 0.72,
              weather === 'acidDrip' ? 1.0 : 0.88,
              weather === 'acidDrip' ? 0.26 : 1.0,
              BURST_KIND_SPLASH
            );
            this.wy[i] = -4;
            this.wx[i] = this.nextRand() * (VIEWPORT_W + 60);
            continue;
          }
        }
      }

      if (this.wx[i] < -16) this.wx[i] += VIEWPORT_W + 32;
      else if (this.wx[i] > VIEWPORT_W + 16) this.wx[i] -= VIEWPORT_W + 32;
      if (this.wy[i] < -16) this.wy[i] += VIEWPORT_H + 32;
      else if (this.wy[i] > VIEWPORT_H + 16) this.wy[i] -= VIEWPORT_H + 32;
    }

    // 4. Step Bursts (including tile-colliding wood splinters, bouncing gibs & swaying soul wisps)
    for (let i = 0; i < MAX_BURST; i++) {
      if (this.bLife[i] <= 0) continue;
      this.bLife[i] -= dt;
      const flags = this.bFlags[i];

      if (this.bKind[i] === BURST_KIND_SOUL) {
        // Ascending soul wisps sway smoothly left/right as they rise
        this.bAngle[i] += dt * 7.2;
        this.bx[i] += (this.bvx[i] + Math.sin(this.bAngle[i]) * 22) * dt;
        this.by[i] += this.bvy[i] * dt;
        this.bvx[i] *= 0.96;
        continue;
      }

      if ((flags & 4) !== 0) {
        // Settled debris resting cleanly on floor until fade-out
        continue;
      }

      const prevX = this.bx[i];
      const prevY = this.by[i];
      this.bvy[i] += this.bGrav[i] * dt;
      let nx = prevX + this.bvx[i] * dt;
      let ny = prevY + this.bvy[i] * dt;
      this.bAngle[i] += this.bAngVel[i] * dt;

      if ((flags & 1) !== 0) {
        // Check solid tile bounce for wood splinters & enemy gibs!
        const ntx = Math.floor(nx / TILE_SIZE);
        const nty = Math.floor(ny / TILE_SIZE);
        if (ntx >= 0 && nty >= 0 && ntx < grid.width && nty < grid.height) {
          const tile = grid.tiles[nty * grid.width + ntx];
          const isFloorHit =
            tile === TileKind.SOLID ||
            tile === TileKind.CRACKED_FLOOR ||
            (tile === TileKind.ONE_WAY && this.bvy[i] > 0 && Math.floor(prevY / TILE_SIZE) < nty);
          if (isFloorHit) {
            if (this.bvy[i] > 0 && Math.floor(prevY / TILE_SIZE) < nty) {
              // Floor bounce!
              ny = nty * TILE_SIZE - 1.5;
              const rest = this.bRestitution[i] || 0.4;
              if (this.bvy[i] > 42) {
                this.bvy[i] = -this.bvy[i] * rest;
                this.bvx[i] *= 0.78;
                this.bAngVel[i] *= 0.62;
              } else {
                this.bvy[i] = 0;
                this.bvx[i] *= 0.55;
                this.bAngVel[i] = 0;
                if (Math.abs(this.bvx[i]) < 8) {
                  this.bFlags[i] = flags | 4; // settled on floor!
                }
              }
              // Gib first floor impact paints a persistent blood spatter decal!
              if ((flags & 2) !== 0) {
                this.bFlags[i] = this.bFlags[i] & ~2;
                this.stampFloorDecal(grid, nx, ny, DECAL_KIND_BLOOD, 0.72);
              }
            } else if (tile === TileKind.SOLID || tile === TileKind.CRACKED_FLOOR) {
              // Wall bounce
              nx = prevX;
              this.bvx[i] = -this.bvx[i] * 0.45;
              this.bAngVel[i] = -this.bAngVel[i] * 0.6;
            }
          }
        }
      }

      this.bx[i] = nx;
      this.by[i] = ny;
    }

    for (let i = 0; i < MAX_SLASHES; i++) {
      if (this.sLife[i] > 0) this.sLife[i] -= dt;
    }
    for (let i = 0; i < MAX_RINGS; i++) {
      if (this.rLife[i] > 0) this.rLife[i] -= dt;
    }
    for (let i = 0; i < MAX_BEAMS; i++) {
      if (this.mLife[i] > 0) this.mLife[i] -= dt;
    }
    for (let i = 0; i < MAX_LIGHTNING_SEGS; i++) {
      if (this.lnLife[i] > 0) this.lnLife[i] -= dt;
    }
    for (let i = 0; i < MAX_TRANSIENT_LIGHTS; i++) {
      if (this.lLife[i] > 0) this.lLife[i] -= dt;
    }
  }

  emitTransientLights(emitLight: EmitDynamicLightFn): void {
    for (let i = 0; i < MAX_TRANSIENT_LIGHTS; i++) {
      const life = this.lLife[i];
      if (life <= 0) continue;
      const frac = life / Math.max(0.01, this.lMaxLife[i]);
      emitLight(
        this.lx[i],
        this.ly[i],
        this.lRad[i] * (0.65 + 0.35 * frac),
        this.lr[i],
        this.lg[i],
        this.lb[i],
        this.lIntensity[i] * frac,
        28
      );
    }
  }

  /**
   * Renders persistent floor blood/scorch/frost decals inside Pass 2 (right after
   * tilemap geometry and before props/enemies/hero so characters walk over them!).
   */
  renderDecals(camX: number, camY: number, emitQuad: EmitVfxQuadFn): void {
    const count = this.decalCount;
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      const a = this.decalAlpha[i];
      if (a <= 0.01) continue;
      const sx = Math.round(this.decalX[i] - camX);
      const sy = Math.round(this.decalY[i] - camY);
      if (sx < -36 || sx > VIEWPORT_W + 36 || sy < -20 || sy > VIEWPORT_H + 20) continue;

      const kind = this.decalKind[i];
      let key: string;
      let emBoost = 0.0;
      if (kind === DECAL_KIND_SCORCH) {
        key = 'vfx:decal_scorch';
        emBoost = 0.08;
      } else if (kind === DECAL_KIND_FROST) {
        key = 'vfx:decal_frost';
        emBoost = 0.16;
      } else {
        const v = this.decalVariant[i];
        key = v === 1 ? 'vfx:decal_blood_1' : v === 2 ? 'vfx:decal_blood_2' : 'vfx:decal_blood_0';
      }
      emitQuad(
        key,
        sx,
        sy,
        this.decalW[i],
        this.decalH[i],
        1,
        1,
        1,
        a,
        this.decalFlip[i],
        0,
        emBoost
      );
    }
  }

  /**
   * Renders the 2 split Verlet crimson scarf ribbons strictly BEHIND the Hero
   * inside Pass 2 so the scarf trails organically and never paints over chest/face!
   */
  renderScarfBehindHero(camX: number, camY: number, emitQuad: EmitVfxQuadFn): void {
    if (!this.scarfInit) return;

    // 1. Secondary forked tail (drawn slightly darker behind primary tail)
    for (let i = SCARF_B_NODES - 1; i >= 1; i--) {
      const x0 = Math.round(this.scarfBX[i - 1] - camX);
      const y0 = Math.round(this.scarfBY[i - 1] - camY);
      const x1 = Math.round(this.scarfBX[i] - camX);
      const y1 = Math.round(this.scarfBY[i] - camY);
      const mx = Math.round((x0 + x1) * 0.5);
      const my = Math.round((y0 + y1) * 0.5);
      const len = Math.max(3.0, Math.hypot(x1 - x0, y1 - y0) + 1.2);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const t = i / (SCARF_B_NODES - 1);
      const thick = Math.max(1.2, 2.7 - t * 1.5);
      const r = 0.72 - t * 0.35;
      const g = 0.08 - t * 0.05;
      const b = 0.17 - t * 0.07;
      emitQuad('vfx:white_px', mx, my, len, thick, r, g, b, 1.0, 1, 0, 0.04, ang);
    }

    // 2. Primary hero crimson ribbon (11 nodes: vibrant #e01b36 -> #a8102b -> #5e0819 tip!)
    for (let i = SCARF_A_NODES - 1; i >= 1; i--) {
      const x0 = Math.round(this.scarfAX[i - 1] - camX);
      const y0 = Math.round(this.scarfAY[i - 1] - camY);
      const x1 = Math.round(this.scarfAX[i] - camX);
      const y1 = Math.round(this.scarfAY[i] - camY);
      const mx = Math.round((x0 + x1) * 0.5);
      const my = Math.round((y0 + y1) * 0.5);
      const len = Math.max(3.2, Math.hypot(x1 - x0, y1 - y0) + 1.3);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const t = i / (SCARF_A_NODES - 1);
      const thick = Math.max(1.4, 3.6 - t * 2.1);
      const r = 0.88 - t * 0.51;
      const g = 0.11 - t * 0.08;
      const b = 0.21 - t * 0.11;
      emitQuad('vfx:white_px', mx, my, len, thick, r, g, b, 1.0, 1, 0, 0.06, ang);
    }
  }

  /** Draws a tiny crisp 4x2 crimson collar wrap snugly over the Prisoner's neck socket. */
  renderScarfCollarWrap(camX: number, camY: number, emitQuad: EmitVfxQuadFn): void {
    if (!this.scarfInit) return;
    const cx = Math.round(this.scarfAX[0] - camX);
    const cy = Math.round(this.scarfAY[0] - camY);
    emitQuad('vfx:white_px', cx, cy, 4, 2, 0.88, 0.11, 0.21, 1.0, 1, 0, 0.06, 0);
  }

  renderOverlay(
    camX: number,
    camY: number,
    weather: BiomeWeather,
    elapsedSec: number,
    emitQuad: EmitVfxQuadFn,
    emitCustomSlash?: EmitCustomSlashFn,
    emitCustomDebris?: EmitCustomDebrisFn
  ): void {
    // 1. Homunculus Cyan-Amber Flame Wisps
    for (let i = 0; i < MAX_FLAME; i++) {
      const life = this.fLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.fMaxLife[i]);
      const sx = this.fx[i] - camX;
      const sy = this.fy[i] - camY;
      const sz = 2.5 + t * 3.8;
      if (this.fCyan[i] === 1) {
        emitQuad('vfx:ember', sx, sy, sz, sz, 0.25, 0.92, 1.0, t * 0.85, 1, 0, 1.15);
      } else {
        emitQuad('vfx:ember', sx, sy, sz, sz, 1.0, 0.62, 0.18, t * 0.9, 1, 0, 1.25);
      }
    }

    // 2. Painterly Weapon-Class Slash Smears (Custom Pack fxWeapon OR Built-In painterly smears!)
    for (let i = 0; i < MAX_SLASHES; i++) {
      const life = this.sLife[i];
      if (life <= 0) continue;
      const maxL = Math.max(0.01, this.sMaxLife[i]);
      const t = life / maxL; // 1 -> 0
      const progress01 = 1.0 - t;
      const style = this.sStyle[i];
      const step = this.sStep[i];
      const isCrit = this.sCrit[i] === 1;
      const facing = this.sFacing[i];
      const scale = this.sScale[i] * (0.92 + progress01 * 0.20);
      const sx = this.sx[i] + facing * (style === SLASH_STYLE_THRUST ? 22 : 14) - camX;
      const sy = this.sy[i] - 12 - camY;
      const alpha = Math.min(1, t * 1.45);

      if (
        emitCustomSlash &&
        style <= SLASH_STYLE_FIRE &&
        emitCustomSlash(
          style,
          step,
          progress01,
          sx,
          sy,
          facing,
          scale,
          this.sr[i],
          this.sg[i],
          this.sb[i],
          alpha,
          isCrit
        )
      ) {
        continue;
      }

      let key = 'vfx:slash_blade_0';
      let baseW = 56;
      let baseH = 42;
      if (style === SLASH_STYLE_HEAVY) {
        key = progress01 < 0.5 ? 'vfx:slash_heavy_0' : 'vfx:slash_heavy_1';
        baseW = 68;
        baseH = 56;
      } else if (style === SLASH_STYLE_THRUST) {
        key = (step & 1) === 0 ? 'vfx:slash_thrust_0' : 'vfx:slash_thrust_1';
        baseW = 72;
        baseH = 20;
      } else if (style === SLASH_STYLE_TWIN) {
        key = (step & 1) === 0 ? 'vfx:slash_twin_0' : 'vfx:slash_twin_1';
        baseW = 52;
        baseH = 44;
      } else if (style === SLASH_STYLE_WHIP) {
        key = progress01 < 0.5 ? 'vfx:slash_whip_0' : 'vfx:slash_whip_1';
        baseW = 68;
        baseH = 32;
      } else if (style === SLASH_STYLE_FIRE) {
        key = 'vfx:fireball_burst';
        baseW = 34;
        baseH = 34;
      } else if (style === SLASH_STYLE_ICE) {
        key = 'vfx:ice_burst';
        baseW = 34;
        baseH = 34;
      } else if (style === SLASH_STYLE_RANGED) {
        key = 'vfx:spark';
        baseW = 20;
        baseH = 14;
      } else {
        key = step === 2 ? 'vfx:slash_blade_2' : step === 1 ? 'vfx:slash_blade_1' : 'vfx:slash_blade_0';
        baseW = step === 2 ? 60 : 56;
        baseH = step === 2 ? 46 : 42;
      }

      emitQuad(
        key,
        sx,
        sy,
        baseW * scale,
        baseH * scale,
        this.sr[i],
        this.sg[i],
        this.sb[i],
        alpha,
        facing,
        isCrit ? 0.62 : t > 0.65 ? 0.42 : 0.12,
        isCrit ? 1.55 : 1.38
      );
    }

    // 3. Radial Shockwave / Parry Burst / Explosion / Boss-Phase Rings
    for (let i = 0; i < MAX_RINGS; i++) {
      const life = this.rLife[i];
      if (life <= 0) continue;
      const frac = 1.0 - life / Math.max(0.01, this.rMaxLife[i]);
      const rad = this.rStartRad[i] + (this.rEndRad[i] - this.rStartRad[i]) * frac;
      const rk = this.rKind[i];
      const key =
        rk === RING_KIND_PARRY_BURST
          ? 'vfx:parry_burst'
          : rk === RING_KIND_PARRY
          ? 'vfx:parry_ring'
          : rk === RING_KIND_AURA
          ? 'vfx:aura_ring'
          : rk === RING_KIND_SHIELD
          ? 'vfx:shield_dome'
          : rk === RING_KIND_SHOCKWAVE
          ? 'vfx:shockwave_ring'
          : rk === RING_KIND_FIRE_BURST
          ? 'vfx:fireball_burst'
          : 'vfx:ice_burst';
      const flashMix =
        rk === RING_KIND_FIRE_BURST || rk === RING_KIND_ICE_BURST || rk === RING_KIND_PARRY_BURST
          ? (1.0 - frac) * 0.65
          : 0;
      emitQuad(
        key,
        this.rx[i] - camX,
        this.ry[i] - camY,
        rad * 2,
        rad * 2,
        this.rr[i],
        this.rg[i],
        this.rb[i],
        (1.0 - frac) * 0.96,
        1,
        flashMix,
        1.48
      );
    }

    // 3.5. Branching Electric Cyan-White Chain-Lightning Arcs!
    for (let i = 0; i < MAX_LIGHTNING_SEGS; i++) {
      const life = this.lnLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.lnMaxLife[i]);
      const x0 = this.lnX0[i] - camX;
      const y0 = this.lnY0[i] - camY;
      const x1 = this.lnX1[i] - camX;
      const y1 = this.lnY1[i] - camY;
      const mx = (x0 + x1) * 0.5;
      const my = (y0 + y1) * 0.5;
      const len = Math.hypot(x1 - x0, y1 - y0) + 1.5;
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const thick = this.lnThick[i] * (0.55 + 0.55 * t);
      const isBranch = this.lnBranch[i] === 1;
      // Outer electric cyan halo
      emitQuad(
        'vfx:white_px',
        mx,
        my,
        len,
        thick * 2.2,
        0.26,
        0.90,
        1.0,
        t * (isBranch ? 0.55 : 0.78),
        1,
        0.25,
        1.48,
        ang
      );
      // Razor-sharp incandescent white core
      emitQuad(
        'vfx:white_px',
        mx,
        my,
        len,
        Math.max(1.0, thick * 0.72),
        0.94,
        0.99,
        1.0,
        t * (isBranch ? 0.8 : 1.0),
        1,
        0.7,
        1.55,
        ang
      );
    }

    // 4. Vertical Lightning Bolts & Curved Golden Parry Flares
    for (let i = 0; i < MAX_BEAMS; i++) {
      const life = this.mLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.mMaxLife[i]);
      const bx = this.mx[i] - camX;
      const by = this.my[i] - camY;
      if (this.mKind[i] === 0) {
        emitQuad(
          'vfx:ember',
          bx,
          by,
          this.mw[i] * (0.65 + t * 0.65),
          this.mh[i],
          this.mr[i],
          this.mg[i],
          this.mb[i],
          t * 0.82,
          1,
          0.25,
          1.45,
          this.mAngle[i]
        );
        emitQuad(
          'vfx:white_px',
          bx,
          by,
          Math.max(2, this.mw[i] * 0.24 * t),
          this.mh[i],
          1.0,
          0.98,
          1.0,
          t * 0.95,
          1,
          0.6,
          1.5,
          this.mAngle[i]
        );
      } else {
        const flip = this.mAngle[i] > 1.5 ? -1 : 1;
        emitQuad(
          'vfx:shield_dome',
          bx,
          by,
          this.mw[i] * (0.85 + (1.0 - t) * 0.45),
          this.mh[i],
          this.mr[i],
          this.mg[i],
          this.mb[i],
          t * 0.92,
          flip,
          0.45,
          1.45
        );
      }
    }

    // 5. Burst Sparks, Wood Planks, Enemy Gibs, Soul Wisps, Cell Comet Sparks, Blood, Dust, Splashes
    for (let i = 0; i < MAX_BURST; i++) {
      const life = this.bLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.bMaxLife[i]);
      const sx = this.bx[i] - camX;
      const sy = this.by[i] - camY;
      if (sx < -28 || sx > VIEWPORT_W + 28 || sy < -28 || sy > VIEWPORT_H + 28) continue;
      const kind = this.bKind[i];

      if (kind === BURST_KIND_WOOD) {
        const fade = Math.min(1, t * 3.0);
        const v = this.bVariant[i];
        if (
          emitCustomDebris &&
          emitCustomDebris(
            BURST_KIND_WOOD,
            v,
            sx,
            sy,
            this.bSize[i],
            this.br[i],
            this.bg[i],
            this.bb[i],
            fade,
            this.bAngle[i]
          )
        ) {
          continue;
        }
        const key =
          v === 1 ? 'vfx:wood_splinter_1' : v === 2 ? 'vfx:wood_splinter_2' : 'vfx:wood_splinter_0';
        const w = (v === 1 ? 10 : v === 2 ? 6 : 8) * this.bSize[i];
        const h = (v === 2 ? 5 : 4) * this.bSize[i];
        emitQuad(key, sx, sy, w, h, this.br[i], this.bg[i], this.bb[i], fade, 1, 0, 0.08, this.bAngle[i]);
      } else if (kind === BURST_KIND_GIB) {
        const fade = Math.min(1, t * 3.0);
        const v = this.bVariant[i];
        if (
          emitCustomDebris &&
          emitCustomDebris(
            BURST_KIND_GIB,
            v,
            sx,
            sy,
            this.bSize[i],
            this.br[i],
            this.bg[i],
            this.bb[i],
            fade,
            this.bAngle[i]
          )
        ) {
          continue;
        }
        const key = v === 1 ? 'vfx:gib_1' : v === 2 ? 'vfx:gib_2' : 'vfx:gib_0';
        const w = (v === 1 ? 7 : v === 2 ? 5 : 6) * this.bSize[i];
        const h = (v === 1 ? 6 : 5) * this.bSize[i];
        emitQuad(key, sx, sy, w, h, this.br[i], this.bg[i], this.bb[i], fade, 1, 0, 0.06, this.bAngle[i]);
      } else if (kind === BURST_KIND_SOUL) {
        const w = 10 * this.bSize[i] * (0.65 + 0.35 * t);
        const h = 14 * this.bSize[i] * (0.65 + 0.35 * t);
        const alpha = Math.min(1, t * 1.6) * 0.88;
        emitQuad('vfx:soul_wisp', sx, sy, w, h, this.br[i], this.bg[i], this.bb[i], alpha, 1, 0.15, 1.38);
      } else if (kind === BURST_KIND_CELL_COMET) {
        const sz = this.bSize[i] * (0.3 + 0.7 * t);
        emitQuad('vfx:ember', sx, sy, sz, sz, 0.22, 0.94, 1.0, t * 0.92, 1, 0.3, 1.42);
      } else if (kind === BURST_KIND_SPLINTER) {
        const sz = this.bSize[i] * (0.4 + 0.6 * t);
        emitQuad(
          'vfx:white_px',
          sx,
          sy,
          sz * 1.9,
          sz * 0.65,
          this.br[i],
          this.bg[i],
          this.bb[i],
          t,
          1,
          0,
          0.12,
          this.bAngle[i] + elapsedSec * 9.0
        );
      } else if (kind === BURST_KIND_SPARK) {
        const sz = this.bSize[i] * (0.4 + 0.6 * t);
        emitQuad(
          'vfx:spark',
          sx,
          sy,
          sz * 1.6,
          sz * 1.6,
          this.br[i],
          this.bg[i],
          this.bb[i],
          t,
          1,
          0.25,
          1.35
        );
      } else {
        const sz = this.bSize[i] * (0.4 + 0.6 * t);
        emitQuad(
          'vfx:ember',
          sx,
          sy,
          sz,
          sz,
          this.br[i],
          this.bg[i],
          this.bb[i],
          t * 0.88,
          1,
          0,
          kind === BURST_KIND_SPLASH ? 0.6 : 0.15
        );
      }
    }

    // 6. Ambient Biome Weather
    const count =
      weather === 'none'
        ? 0
        : weather === 'rain'
        ? 145
        : weather === 'embers' || weather === 'wind'
        ? 95
        : 65;
    for (let i = 0; i < count; i++) {
      const x = this.wx[i];
      const y = this.wy[i];
      const sz = this.wSize[i];
      const ph = this.wPhase[i];
      if (weather === 'rain') {
        emitQuad('vfx:white_px', x, y, 1.1, 8.0 * sz, 0.72, 0.86, 1.0, 0.42, 1, 0, 0.25, 0.25);
      } else if (weather === 'acidDrip') {
        emitQuad('vfx:drop', x, y, 3.2 * sz, 5.5 * sz, 0.55, 1.0, 0.25, 0.78, 1, 0, 1.1);
      } else if (weather === 'wind') {
        emitQuad('vfx:white_px', x, y, 10.0 * sz, 1.2, 1.0, 0.82, 0.55, 0.36, 1, 0, 0.45, -0.08);
      } else if (weather === 'cogs') {
        emitQuad(
          'vfx:cog',
          x,
          y,
          7.5 * sz,
          7.5 * sz,
          0.95,
          0.76,
          0.32,
          0.52,
          1,
          0,
          0.45,
          elapsedSec * (1.2 + (i % 3) * 0.4) + ph
        );
      } else if (weather === 'embers') {
        const flick = 0.55 + 0.45 * Math.sin(elapsedSec * 7.5 + ph);
        emitQuad('vfx:ember', x, y, 3.0 * sz, 3.0 * sz, 1.0, 0.44, 0.16, 0.82 * flick, 1, 0, 1.25);
      } else {
        const flick = 0.4 + 0.4 * Math.sin(elapsedSec * 2.8 + ph);
        const warm = i % 4 === 0;
        emitQuad(
          'vfx:ember',
          x,
          y,
          2.2 * sz,
          2.2 * sz,
          warm ? 1.0 : 0.78,
          warm ? 0.68 : 0.84,
          warm ? 0.32 : 1.0,
          flick * 0.58,
          1,
          0,
          warm ? 0.95 : 0.3
        );
      }
    }
  }

  getActiveParticleCount(): number {
    let n = this.lastWeather === 'none' ? 0 : 80;
    for (let i = 0; i < MAX_BURST; i++) if (this.bLife[i] > 0) n++;
    for (let i = 0; i < MAX_FLAME; i++) if (this.fLife[i] > 0) n++;
    return n + this.decalCount;
  }
}
