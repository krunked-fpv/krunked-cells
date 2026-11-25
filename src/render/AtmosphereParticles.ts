// =============================================================================
// KRUNKED CELLS — ATMOSPHERE WEATHER, HERO SCARF/HOMUNCULUS TRAIL & COMBAT VFX
// 100% pre-allocated typed-array pools: ZERO per-frame array/object allocations.
// =============================================================================

import {
  TILE_SIZE,
  TileKind,
  VIEWPORT_H,
  VIEWPORT_W,
  type BiomeWeather,
  type SimEvent,
  type SimState,
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

const MAX_WEATHER = 160;
const MAX_BURST = 384;
const MAX_SLASHES = 24;
const MAX_RINGS = 32;
const MAX_BEAMS = 12;
const MAX_FLAME = 40;
const MAX_POPUPS = 24;
const MAX_TRANSIENT_LIGHTS = 24;
const SCARF_NODES = 6;

const BURST_KIND_SPARK = 0;
const BURST_KIND_SPLINTER = 1;
const BURST_KIND_BLOOD = 2;
const BURST_KIND_DUST = 3;
const BURST_KIND_SPLASH = 4;

// Ring visual kinds:
// 0 = parry_ring, 1 = aura_ring, 2 = shield_dome, 3 = shockwave_ring,
// 4 = fireball_burst (core flash), 5 = ice_burst (core flash)
const RING_KIND_PARRY = 0;
const RING_KIND_AURA = 1;
const RING_KIND_SHIELD = 2;
const RING_KIND_SHOCKWAVE = 3;
const RING_KIND_FIRE_BURST = 4;
const RING_KIND_ICE_BURST = 5;

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

export class AtmosphereParticles {
  private rngState = 0x9e3779b9;
  private lastWeather: BiomeWeather = 'none';
  private lastElapsed = 0;

  // Ambient weather pool (screen-relative wrapped around camera)
  private readonly wx = new Float32Array(MAX_WEATHER);
  private readonly wy = new Float32Array(MAX_WEATHER);
  private readonly wvx = new Float32Array(MAX_WEATHER);
  private readonly wvy = new Float32Array(MAX_WEATHER);
  private readonly wSize = new Float32Array(MAX_WEATHER);
  private readonly wPhase = new Float32Array(MAX_WEATHER);

  // Burst VFX particles (world space)
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
  private readonly bKind = new Uint8Array(MAX_BURST);
  private burstCursor = 0;

  // Sweeping weapon slash arcs
  private readonly sx = new Float32Array(MAX_SLASHES);
  private readonly sy = new Float32Array(MAX_SLASHES);
  private readonly sFacing = new Float32Array(MAX_SLASHES);
  private readonly sLife = new Float32Array(MAX_SLASHES);
  private readonly sMaxLife = new Float32Array(MAX_SLASHES);
  private readonly sScale = new Float32Array(MAX_SLASHES);
  private readonly sStep = new Uint8Array(MAX_SLASHES);
  private readonly sr = new Float32Array(MAX_SLASHES);
  private readonly sg = new Float32Array(MAX_SLASHES);
  private readonly sb = new Float32Array(MAX_SLASHES);
  private slashCursor = 0;

  // Expanding shockwave / parry / boss-phase rings
  private readonly rx = new Float32Array(MAX_RINGS);
  private readonly ry = new Float32Array(MAX_RINGS);
  private readonly rLife = new Float32Array(MAX_RINGS);
  private readonly rMaxLife = new Float32Array(MAX_RINGS);
  private readonly rStartRad = new Float32Array(MAX_RINGS);
  private readonly rEndRad = new Float32Array(MAX_RINGS);
  private readonly rr = new Float32Array(MAX_RINGS);
  private readonly rg = new Float32Array(MAX_RINGS);
  private readonly rb = new Float32Array(MAX_RINGS);
  private readonly rKind = new Uint8Array(MAX_RINGS); // 0=parry, 1=aura, 2=shield, 3=shockwave, 4=fireBurst, 5=iceBurst
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

  // Fluttering crimson hero scarf chain (world space)
  readonly scarfX = new Float32Array(SCARF_NODES);
  readonly scarfY = new Float32Array(SCARF_NODES);
  private scarfInit = false;

  // Floating pixel damage / CRIT / PARRY popups
  private readonly px = new Float32Array(MAX_POPUPS);
  private readonly py = new Float32Array(MAX_POPUPS);
  private readonly pvy = new Float32Array(MAX_POPUPS);
  private readonly pLife = new Float32Array(MAX_POPUPS);
  private readonly pMaxLife = new Float32Array(MAX_POPUPS);
  private readonly pr = new Float32Array(MAX_POPUPS);
  private readonly pg = new Float32Array(MAX_POPUPS);
  private readonly pb = new Float32Array(MAX_POPUPS);
  private readonly pScale = new Float32Array(MAX_POPUPS);
  private readonly pText: string[] = new Array<string>(MAX_POPUPS).fill('');
  private popupCursor = 0;

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

  resetScarf(x: number, y: number): void {
    for (let i = 0; i < SCARF_NODES; i++) {
      this.scarfX[i] = x - i * 3;
      this.scarfY[i] = y;
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
    kind: number
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
    this.bKind[i] = kind;
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

  private spawnPopup(
    x: number,
    y: number,
    text: string,
    r: number,
    g: number,
    b: number,
    scale = 1.0
  ): void {
    const i = this.popupCursor;
    this.popupCursor = (i + 1) % MAX_POPUPS;
    this.px[i] = x;
    this.py[i] = y;
    this.pvy[i] = -36 - this.nextRand() * 14;
    this.pLife[i] = 0.65;
    this.pMaxLife[i] = 0.65;
    this.pr[i] = r;
    this.pg[i] = g;
    this.pb[i] = b;
    this.pScale[i] = scale;
    this.pText[i] = text;
  }

  ingestEvents(events: readonly SimEvent[], _state: SimState): void {
    for (let eIdx = 0; eIdx < events.length; eIdx++) {
      const ev = events[eIdx];
      switch (ev.type) {
        case 'attackSwing': {
          parseHexIntoScratch(ev.color, 0.55, 0.92, 1.0);
          const i = this.slashCursor;
          this.slashCursor = (i + 1) % MAX_SLASHES;
          this.sx[i] = ev.x;
          this.sy[i] = ev.y;
          this.sFacing[i] = ev.facing;
          this.sLife[i] = 0.14;
          this.sMaxLife[i] = 0.14;
          this.sScale[i] = ev.weaponId === 'BroadSword' || ev.weaponId === 'StunMace' ? 1.38 : 1.05;
          this.sStep[i] = ev.weaponId === 'BroadSword' ? 3 : ev.stepIndex % 3;
          this.sr[i] = rgbScratch[0];
          this.sg[i] = rgbScratch[1];
          this.sb[i] = rgbScratch[2];
          this.spawnLight(
            ev.x + ev.facing * 18,
            ev.y - 4,
            88,
            0.14,
            rgbScratch[0],
            rgbScratch[1],
            rgbScratch[2],
            1.45
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
          if (ev.damage > 0) {
            this.spawnPopup(ev.x, ev.y - 14, `${Math.round(ev.damage)}`, 1.0, 0.96, 0.85, 0.9);
          }
          this.spawnLight(ev.x, ev.y, 72, 0.12, 1.0, 0.84, 0.55, 1.3);
          break;
        }
        case 'critImpact': {
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
              0.88,
              0.28,
              BURST_KIND_SPARK
            );
          }
          this.spawnRing(ev.x, ev.y, 0.22, 10, 44, 1.0, 0.88, 0.3, 0);
          this.spawnPopup(ev.x, ev.y - 18, `${Math.round(ev.damage)}!`, 1.0, 0.88, 0.22, 1.25);
          this.spawnLight(ev.x, ev.y, 128, 0.22, 1.0, 0.86, 0.32, 2.2);
          break;
        }
        case 'parrySuccess': {
          this.spawnRing(ev.x, ev.y, 0.34, 14, 72, 1.0, 0.9, 0.38, 0);
          for (let k = 0; k < 18; k++) {
            const ang = (k / 18) * Math.PI * 2;
            const spd = 95 + this.nextRand() * 90;
            this.spawnBurst(
              ev.x,
              ev.y,
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
          this.spawnPopup(ev.x, ev.y - 22, 'PARRY!', 1.0, 0.92, 0.38, 1.15);
          this.spawnLight(ev.x, ev.y, 150, 0.32, 1.0, 0.9, 0.4, 2.5);
          break;
        }
        case 'parryStart': {
          // Crisp golden curved shield flare + warm golden transient point light!
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
          // Bright silver-cyan impact ring + 14 metallic sparks + flash light!
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
          // HUGE multi-layered fiery / icy / cluster blast!
          const isFire = ev.element === 'fire';
          const isIce = ev.element === 'ice';
          const lr = isFire ? 1.0 : isIce ? 0.40 : 1.0;
          const lg = isFire ? 0.42 : isIce ? 0.925 : 0.824;
          const lb = isFire ? 0.17 : isIce ? 1.0 : 0.341;
          const rad = Math.max(36, ev.radius);

          // Core white-gold / arctic flash
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
          // Primary expanding shockwave ring
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
          // Secondary inner energy halo
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

          // 24 glowing embers / ice shards / explosive sparks!
          for (let k = 0; k < 24; k++) {
            const ang = (k / 24) * Math.PI * 2 + (this.nextRand() - 0.5) * 0.26;
            const spd = 60 + this.nextRand() * Math.max(135, rad * 2.3);
            const warmMix = this.nextRand();
            const pr = isFire
              ? 1.0
              : isIce
              ? 0.42 + warmMix * 0.56
              : 1.0;
            const pg = isFire
              ? 0.28 + warmMix * 0.62
              : isIce
              ? 0.88 + warmMix * 0.12
              : 0.62 + warmMix * 0.34;
            const pb = isFire
              ? 0.10 + warmMix * 0.22
              : isIce
              ? 1.0
              : 0.22 + warmMix * 0.36;
            const kind =
              isIce && (k & 1) === 0
                ? BURST_KIND_SPLINTER
                : (k % 3 === 0 ? BURST_KIND_SPLINTER : BURST_KIND_SPARK);
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

          // Intense dynamic point light (#ff6b2b fire, #66ecff ice, #ffd257 physical/cluster)
          this.spawnLight(
            ev.x,
            ev.y,
            Math.max(120, ev.radius * 2.4),
            0.38,
            lr,
            lg,
            lb,
            2.0
          );
          break;
        }
        case 'skillCast': {
          const sx = ev.x;
          const sy = ev.y - 12;
          switch (ev.skillId) {
            case 'Phaser': {
              // Cyan vertical lightning bolt + electric afterimage burst!
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
              // Twin expanding cyan wind shockwaves + horizontal gale streaks!
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
              // Dramatic purple lightning crown + crimson-violet aura shockwave!
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
              // Crimson ring flare + 14 outward spinning crimson razor sparks!
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
              // Emerald healing spiral + protective emerald-cyan ring!
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
              // Mechanical brass spark puff + deployment ring!
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
              // Grenade throws (InfantryGrenade / FireGrenade / IceGrenade / ClusterGrenade)
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
          this.spawnRing(ev.x, ev.y - 4, 0.30, 14, Math.max(58, ev.radius * 1.4), 0.45, 0.9, 1.0, 2);
          for (let k = 0; k < 16; k++) {
            const dir = k % 2 === 0 ? 1 : -1;
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 16,
              ev.y - 2,
              dir * (45 + this.nextRand() * 130),
              -70 - this.nextRand() * 120,
              0.35 + this.nextRand() * 0.25,
              4 + this.nextRand() * 3,
              390,
              0.72,
              0.78,
              0.9,
              BURST_KIND_SPLINTER
            );
          }
          this.spawnLight(ev.x, ev.y - 6, 130, 0.26, 0.45, 0.92, 1.0, 2.1);
          break;
        }
        case 'doorSmash': {
          // Vivid flying wooden door splinters!
          for (let k = 0; k < 18; k++) {
            this.spawnBurst(
              ev.x + (this.nextRand() - 0.5) * 10,
              ev.y - 10 - this.nextRand() * 28,
              (this.nextRand() - 0.5) * 210,
              -60 - this.nextRand() * 130,
              0.45 + this.nextRand() * 0.35,
              4 + this.nextRand() * 4,
              420,
              0.68,
              0.44,
              0.24,
              BURST_KIND_SPLINTER
            );
          }
          this.spawnLight(ev.x, ev.y - 16, 86, 0.16, 1.0, 0.78, 0.42, 1.4);
          break;
        }
        case 'enemyTelegraph': {
          this.spawnRing(ev.x, ev.y - 28, 0.18, 4, 22, 1.0, 0.86, 0.22, 0);
          this.spawnLight(ev.x, ev.y - 26, 62, 0.2, 1.0, 0.8, 0.2, 1.25);
          break;
        }
        case 'enemyDeath': {
          const count = ev.isBoss ? 36 : ev.isElite ? 22 : 12;
          for (let k = 0; k < count; k++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 40 + this.nextRand() * (ev.isBoss ? 190 : 110);
            this.spawnBurst(
              ev.x,
              ev.y - 12,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd - 35,
              0.38 + this.nextRand() * 0.35,
              ev.isBoss ? 5.5 : 3.5,
              280,
              ev.isBoss ? 1.0 : 0.85,
              ev.isBoss ? 0.52 : 0.18,
              ev.isBoss ? 0.22 : 0.26,
              BURST_KIND_BLOOD
            );
          }
          if (ev.isBoss) {
            this.spawnRing(ev.x, ev.y - 24, 0.55, 16, 140, 1.0, 0.72, 0.25, 1);
            this.spawnLight(ev.x, ev.y - 24, 200, 0.6, 1.0, 0.75, 0.35, 2.8);
          }
          break;
        }
        case 'bossPhaseShift': {
          this.spawnRing(ev.x, ev.y - 24, 0.5, 14, 125, 1.0, 0.32, 0.22, 1);
          this.spawnLight(ev.x, ev.y - 24, 190, 0.55, 1.0, 0.38, 0.25, 2.6);
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
          this.spawnPopup(ev.x, ev.y - 26, `+${Math.round(ev.healed)}`, 0.32, 1.0, 0.6, 1.05);
          this.spawnLight(ev.x, ev.y - 16, 115, 0.36, 0.3, 1.0, 0.6, 1.8);
          break;
        }
        case 'scrollPickup': {
          const r = ev.stat === 'brutality' ? 1.0 : ev.stat === 'tactics' ? 0.75 : 0.28;
          const g = ev.stat === 'brutality' ? 0.28 : ev.stat === 'tactics' ? 0.36 : 1.0;
          const b = ev.stat === 'brutality' ? 0.32 : ev.stat === 'tactics' ? 1.0 : 0.52;
          this.spawnRing(ev.x, ev.y - 14, 0.42, 8, 68, r, g, b, 2);
          this.spawnLight(ev.x, ev.y - 14, 130, 0.4, r, g, b, 2.0);
          break;
        }
        case 'curseTriggered': {
          this.spawnRing(ev.x, ev.y - 14, 0.45, 10, 76, 0.85, 0.16, 1.0, 1);
          this.spawnLight(ev.x, ev.y - 14, 145, 0.45, 0.85, 0.16, 1.0, 2.2);
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
          if (ev.amount > 0) {
            this.spawnPopup(ev.x, ev.y - 26, `-${Math.round(ev.amount)}`, 1.0, 0.25, 0.3, 1.1);
          }
          this.spawnLight(ev.x, ev.y - 12, 95, 0.22, 1.0, 0.2, 0.25, 1.8);
          break;
        }
        case 'cellCollect': {
          this.spawnLight(ev.x, ev.y - 12, 65, 0.18, 0.3, 0.92, 1.0, 1.4);
          break;
        }
        case 'teleport': {
          this.spawnRing(ev.toX, ev.toY - 14, 0.38, 6, 54, 0.32, 0.95, 1.0, 2);
          this.spawnLight(ev.toX, ev.toY - 14, 130, 0.36, 0.32, 0.95, 1.0, 2.0);
          break;
        }
        default:
          break;
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
    camY: number
  ): void {
    let dt = elapsedSec - this.lastElapsed;
    this.lastElapsed = elapsedSec;
    if (dt <= 0 || dt > 0.1) dt = 1 / 60;

    if (weather !== this.lastWeather) {
      this.initWeather(weather);
    }

    // 1. Update Hero Fluttering Crimson Scarf Verlet Chain
    const anchorX = heroX - state.player.facing * 2;
    const anchorY = heroY - 22;
    if (!this.scarfInit || Math.hypot(this.scarfX[0] - anchorX, this.scarfY[0] - anchorY) > 64) {
      this.resetScarf(anchorX, anchorY);
    }
    this.scarfX[0] = anchorX;
    this.scarfY[0] = anchorY;
    const segLen = 3.2;
    const windX = -state.player.facing * 28 - state.player.vel.x * 0.22;
    for (let i = 1; i < SCARF_NODES; i++) {
      const flutter = Math.sin(elapsedSec * 14.0 - i * 0.9) * 14.0;
      this.scarfX[i] += windX * dt;
      this.scarfY[i] += (22.0 + flutter) * dt;
      const dx = this.scarfX[i] - this.scarfX[i - 1];
      const dy = this.scarfY[i] - this.scarfY[i - 1];
      const dist = Math.hypot(dx, dy) || 0.001;
      if (dist > segLen) {
        const pull = segLen / dist;
        this.scarfX[i] = this.scarfX[i - 1] + dx * pull;
        this.scarfY[i] = this.scarfY[i - 1] + dy * pull;
      }
    }

    // 2. Spawn & step Homunculus Plasma Flame Trail
    this.flameSpawnAccum += dt;
    while (this.flameSpawnAccum >= 0.028) {
      this.flameSpawnAccum -= 0.028;
      const i = this.flameCursor;
      this.flameCursor = (i + 1) % MAX_FLAME;
      this.fx[i] = heroX + (this.nextRand() - 0.5) * 5;
      this.fy[i] = heroY - 29 + (this.nextRand() - 0.5) * 3;
      this.fvx[i] = -state.player.vel.x * 0.15 + (this.nextRand() - 0.5) * 16;
      this.fvy[i] = -24 - this.nextRand() * 24;
      this.fLife[i] = 0.28 + this.nextRand() * 0.22;
      this.fMaxLife[i] = this.fLife[i];
      this.fCyan[i] = this.nextRand() > 0.42 ? 1 : 0;
    }
    for (let i = 0; i < MAX_FLAME; i++) {
      if (this.fLife[i] <= 0) continue;
      this.fLife[i] -= dt;
      this.fx[i] += this.fvx[i] * dt;
      this.fy[i] += this.fvy[i] * dt;
    }

    // 3. Step Ambient Biome Weather + Rain Puddle Splashes
    const grid = state.tileGrid;
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
            // Spawn crisp pixel splash ring on tile impact!
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

    // 4. Step Bursts, Slashes, Rings, Popups, Transient Lights
    for (let i = 0; i < MAX_BURST; i++) {
      if (this.bLife[i] <= 0) continue;
      this.bLife[i] -= dt;
      this.bvy[i] += this.bGrav[i] * dt;
      this.bx[i] += this.bvx[i] * dt;
      this.by[i] += this.bvy[i] * dt;
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
    for (let i = 0; i < MAX_POPUPS; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      this.py[i] += this.pvy[i] * dt;
      this.pvy[i] *= 0.94;
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

  renderOverlay(
    camX: number,
    camY: number,
    weather: BiomeWeather,
    elapsedSec: number,
    emitQuad: EmitVfxQuadFn
  ): void {
    // 1. Fluttering Multi-Segment Crimson Scarf
    if (this.scarfInit) {
      for (let i = SCARF_NODES - 1; i >= 1; i--) {
        const x0 = this.scarfX[i - 1] - camX;
        const y0 = this.scarfY[i - 1] - camY;
        const x1 = this.scarfX[i] - camX;
        const y1 = this.scarfY[i] - camY;
        const mx = (x0 + x1) * 0.5;
        const my = (y0 + y1) * 0.5;
        const len = Math.max(3.2, Math.hypot(x1 - x0, y1 - y0) + 1.2);
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const thick = 3.6 - i * 0.36;
        const shade = 1.0 - i * 0.08;
        emitQuad(
          'vfx:white_px',
          mx,
          my,
          len,
          thick,
          0.86 * shade,
          0.14 * shade,
          0.22 * shade,
          0.96,
          1,
          0,
          0.12,
          ang
        );
      }
    }

    // 2. Homunculus Cyan-Amber Flame Wisps
    for (let i = 0; i < MAX_FLAME; i++) {
      const life = this.fLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.fMaxLife[i]);
      const sx = this.fx[i] - camX;
      const sy = this.fy[i] - camY;
      const sz = 2.5 + t * 3.8;
      if (this.fCyan[i] === 1) {
        emitQuad('vfx:ember', sx, sy, sz, sz, 0.25, 0.92, 1.0, t * 0.85, 1, 0, 1.1);
      } else {
        emitQuad('vfx:ember', sx, sy, sz, sz, 1.0, 0.62, 0.18, t * 0.9, 1, 0, 1.2);
      }
    }

    // 3. Sweeping Luminous Weapon Slash Arcs!
    for (let i = 0; i < MAX_SLASHES; i++) {
      const life = this.sLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.sMaxLife[i]);
      const step = this.sStep[i];
      const key =
        step === 3
          ? 'vfx:slash_heavy'
          : step === 2
          ? 'vfx:slash_2'
          : step === 1
          ? 'vfx:slash_1'
          : 'vfx:slash_0';
      const baseW = step === 3 ? 64 : step === 2 ? 52 : 48;
      const baseH = step === 3 ? 44 : step === 2 ? 40 : 36;
      const scale = this.sScale[i] * (0.9 + (1 - t) * 0.22);
      const sx = this.sx[i] + this.sFacing[i] * 14 - camX;
      const sy = this.sy[i] - 12 - camY;
      emitQuad(
        key,
        sx,
        sy,
        baseW * scale,
        baseH * scale,
        this.sr[i],
        this.sg[i],
        this.sb[i],
        Math.min(1, t * 1.4),
        this.sFacing[i],
        t > 0.65 ? 0.55 : 0.15,
        1.4
      );
    }

    // 4. Radial Shockwave / Parry / Explosion / Boss-Phase Rings
    for (let i = 0; i < MAX_RINGS; i++) {
      const life = this.rLife[i];
      if (life <= 0) continue;
      const frac = 1.0 - life / Math.max(0.01, this.rMaxLife[i]);
      const rad = this.rStartRad[i] + (this.rEndRad[i] - this.rStartRad[i]) * frac;
      const rk = this.rKind[i];
      const key =
        rk === RING_KIND_PARRY
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
      const flashMix = rk === RING_KIND_FIRE_BURST || rk === RING_KIND_ICE_BURST ? (1.0 - frac) * 0.65 : 0;
      emitQuad(
        key,
        this.rx[i] - camX,
        this.ry[i] - camY,
        rad * 2,
        rad * 2,
        this.rr[i],
        this.rg[i],
        this.rb[i],
        (1.0 - frac) * 0.95,
        1,
        flashMix,
        1.45
      );
    }

    // 4.5. Vertical Lightning Bolts & Curved Golden Parry Flares
    for (let i = 0; i < MAX_BEAMS; i++) {
      const life = this.mLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.mMaxLife[i]);
      const bx = this.mx[i] - camX;
      const by = this.my[i] - camY;
      if (this.mKind[i] === 0) {
        // Vertical lightning bolt (outer glow + blazing white core)
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
        // Curved golden shield parry flare
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

    // 5. Burst Sparks, Splinters, Blood, Dust, Splashes
    for (let i = 0; i < MAX_BURST; i++) {
      const life = this.bLife[i];
      if (life <= 0) continue;
      const t = life / Math.max(0.01, this.bMaxLife[i]);
      const sx = this.bx[i] - camX;
      const sy = this.by[i] - camY;
      if (sx < -24 || sx > VIEWPORT_W + 24 || sy < -24 || sy > VIEWPORT_H + 24) continue;
      const kind = this.bKind[i];
      const sz = this.bSize[i] * (0.4 + 0.6 * t);
      if (kind === BURST_KIND_SPLINTER) {
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
          0.1,
          elapsedSec * 9.0 + i
        );
      } else if (kind === BURST_KIND_SPARK) {
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
        // dust + subtle drifting torches motes
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

    // 7. Combat popups are rendered at crisp native DPI by HudOverlay.ts
    // (avoiding duplicate overlapping text numbers).
  }

  getActiveParticleCount(): number {
    let n = this.lastWeather === 'none' ? 0 : 80;
    for (let i = 0; i < MAX_BURST; i++) if (this.bLife[i] > 0) n++;
    for (let i = 0; i < MAX_FLAME; i++) if (this.fLife[i] > 0) n++;
    return n;
  }
}
