// =============================================================================
// KRUNKED CELLS — 4-PASS WEBGL2 NORMAL-MAPPED PIXEL-ART RENDERER
// Pass 1: Multi-Layer Parallax Backdrop (480x270 NEAREST)
// Pass 2: G-Buffer MRT (Albedo + Normal w/ flipX n.x invert + Emissive)
// Pass 3: 64-Light Normal-Mapped Cel Lighting + Bright-Pass Extract
// Pass 3.5: Translucent & Additive VFX, Slashes, Scarf, Weather, Popups
// Pass 4: Volumetric Fog + Separable Bloom Blur + Crisp Nearest Composite
// Includes clean Canvas2D fallback if WebGL2 context is unavailable.
// =============================================================================

import {
  MAX_ACTIVE_LIGHTS,
  TILE_SIZE,
  TileKind,
  VIEWPORT_H,
  VIEWPORT_W,
  type BiomeId,
  type CustomPackAssetResolver,
  type CustomPackStatus,
  type EnemyState,
  type PlayerState,
  type RenderSettings,
  type RendererAPI,
  type SimEvent,
  type SimState,
} from '../contracts';
import {
  buildProceduralAtlas,
  resolveSpriteRegion,
  type ProceduralAtlasData,
  type SpriteRegion,
} from '../assets/ProceduralAtlas';
import {
  CustomPackLoader,
  type LibGdxRegion,
  type LoadedCustomAtlas,
} from '../assets/CustomPackLoader';
import {
  BLUR_FRAG,
  COMPOSITE_FRAG,
  FOG_FRAG,
  FULLSCREEN_VERT,
  GBUFFER_FRAG,
  GBUFFER_VERT,
  LIGHTING_FRAG,
  PARALLAX_FRAG,
  VFX_FRAG,
  VFX_VERT,
  compileProgram,
} from './Shaders';
import {
  ParallaxBackdropPass,
  getBiomeVisualTheme,
  type BiomeVisualTheme,
} from './ParallaxBackdrop';
import { AtmosphereParticles } from './AtmosphereParticles';

const MAX_QUADS = 4096;
const FLOATS_PER_VERT = 12; // pos(2), uv(2), color(4), params(4)
const VERTS_PER_QUAD = 4;
const FLOATS_PER_QUAD = FLOATS_PER_VERT * VERTS_PER_QUAD;
const BLOOM_W = VIEWPORT_W >> 1; // 240
const BLOOM_H = VIEWPORT_H >> 1; // 135

// Pre-allocated FBO clear buffers (ZERO per-frame array allocations!)
const CLEAR_ZERO = new Float32Array([0, 0, 0, 0]);
const CLEAR_NORMAL = new Float32Array([0.5, 0.5, 1.0, 0]);

interface CustomGpuAtlasPage {
  diffuseTex: WebGLTexture;
  normalTex: WebGLTexture;
  width: number;
  height: number;
}

interface BiomeAtlasCache {
  backWalls: LibGdxRegion[];
  floorStamps: LibGdxRegion[];
  groundCaps: LibGdxRegion[];
  ceilingCaps: LibGdxRegion[];
  oneWays: LibGdxRegion[];
  chains: LibGdxRegion[];
  arches: LibGdxRegion[];
  banners: LibGdxRegion[];
  exitDoors: LibGdxRegion[];
  floorJunk: LibGdxRegion[];
  wallJunk: LibGdxRegion[];
  // Common-atlas prop direct lookups (cached once on load — zero per-frame Map lookups!)
  ladder: LibGdxRegion | null;
  brasero: LibGdxRegion | null;
  torch: LibGdxRegion | null;
  chestBasicClosed: LibGdxRegion | null;
  chestBasicOpen: LibGdxRegion | null;
  chestTwClosed: LibGdxRegion | null;
  chestTwOpen: LibGdxRegion | null;
  woodDoorMeta: LibGdxRegion | null;
  normalDoorSide: LibGdxRegion | null;
  goldDoor: LibGdxRegion | null;
  timeDoor: LibGdxRegion | null;
  collectorDoor: LibGdxRegion | null;
  prisonBossDoor: LibGdxRegion | null;
  collectorBack: LibGdxRegion | null;
  foundry: LibGdxRegion | null;
  teleportAltar: LibGdxRegion | null;
  flagMetaObject: LibGdxRegion | null;
}

interface CustomGpuAtlas {
  loaded: LoadedCustomAtlas;
  pages: CustomGpuAtlasPage[];
  cache: BiomeAtlasCache;
}

const BIOME_CUSTOM_ATLAS_MAP: Record<BiomeId, string> = {
  PrisonStart: 'prison',
  PrisonCourtyard: 'prisonCourtyard',
  Sewer: 'sewer',
  PrisonRoof: 'prisonRoof',
  Bridge: 'bridge',
  StiltVillage: 'stiltVillage',
  ClockTower: 'clockTower',
  TopClockTower: 'clockRoom',
  Castle: 'castle',
  Throne: 'throne',
  Passage: 'prison',
};

const ENEMY_CUSTOM_ATLAS: Record<string, string> = {
  Zombie: 'zombie',
  Runner: 'zombie',
  Archer: 'deadArcher',
  Grenader: 'grenadier',
  Shield: 'zombieShield',
  Mage360: 'mago360',
  Protector: 'mago360',
  Comboter: 'comboter',
  Ninja: 'ninja',
  LeapingDuelyst: 'leapingDuelyst',
  ClusterGrenader: 'grenadierCluster',
  PirateChief: 'pirate',
  Lancer: 'lancer',
  CastleKnight: 'knight',
  Worm: 'zombieWorm',
  BatKamikaze: 'zombieFly',
  BatDasher: 'zombieFly',
};

const RE_BACK_WALL = /^backWall(_?\d+)?$/;
const RE_FLOOR_STAMP = /^floorStamp_\d+$/;
const RE_ALT_FLOOR_STAMP = /^(stoneWall|floorStampLeft|floorStampRight)_\d+$/;
const RE_GROUND_CAP = /^ground_\d+$/;
const RE_CEILING_CAP = /^ceiling_\d+$/;
const RE_ARCH_REGION =
  /^(archeSmall(_\d+)?|archeParallax_\d+|bridgeArch|alcovePillar|alcove_\d+|alcoveBench|columnTile3_\d+)$/;

function buildBiomeAtlasCache(loaded: LoadedCustomAtlas): BiomeAtlasCache {
  const backWalls: LibGdxRegion[] = [];
  const floorStamps: LibGdxRegion[] = [];
  const altFloorStamps: LibGdxRegion[] = [];
  const groundCaps: LibGdxRegion[] = [];
  const ceilingCaps: LibGdxRegion[] = [];
  const oneWays: LibGdxRegion[] = [];
  const chains: LibGdxRegion[] = [];
  const arches: LibGdxRegion[] = [];
  const banners: LibGdxRegion[] = [];
  const exitDoors: LibGdxRegion[] = [];
  const floorJunk: LibGdxRegion[] = [];
  const wallJunk: LibGdxRegion[] = [];

  const seen = new Set<LibGdxRegion>();
  for (const reg of loaded.atlas.regions.values()) {
    if (seen.has(reg)) continue;
    seen.add(reg);
    const name = reg.name;

    if (RE_BACK_WALL.test(name) && reg.w === 24 && reg.h === 24) {
      backWalls.push(reg);
    } else if (RE_FLOOR_STAMP.test(name) && reg.w === 24 && reg.h === 24) {
      floorStamps.push(reg);
    } else if (RE_ALT_FLOOR_STAMP.test(name) && reg.w === 24 && reg.h === 24) {
      altFloorStamps.push(reg);
    } else if (RE_GROUND_CAP.test(name) && reg.w === 24 && reg.h > 0 && reg.h <= 8) {
      groundCaps.push(reg);
    } else if (RE_CEILING_CAP.test(name) && reg.w === 24 && reg.h > 0 && reg.h <= 8) {
      ceilingCaps.push(reg);
    }

    if (name === 'ladderPlatform' || name === 'unstablePlatform_0' || name === 'bridgeTile') {
      oneWays.push(reg);
    }
    if (name === 'chain_0' || name === 'chainTile') {
      chains.push(reg);
    }
    if (RE_ARCH_REGION.test(name) && reg.w <= 220 && reg.h <= 260) {
      arches.push(reg);
    }
    if (name === 'bannerBig' || name === 'bannerRoomTiled') {
      banners.push(reg);
    }
    if (name === 'exitDoor' || name === 'bigDoor_0' || name === 'bigDoor') {
      exitDoors.push(reg);
    }
    if (
      (name.startsWith('floorJunk/') || name.startsWith('alchemyFloorJunk/')) &&
      reg.w >= 6 &&
      reg.h >= 6 &&
      reg.w <= 64 &&
      reg.h <= 64
    ) {
      floorJunk.push(reg);
    }
    if (
      (name.startsWith('wallJunk/') || name.startsWith('alchemyWallJunk/')) &&
      reg.w >= 6 &&
      reg.h >= 6 &&
      reg.w <= 64 &&
      reg.h <= 64
    ) {
      wallJunk.push(reg);
    }
  }

  const byName = (a: LibGdxRegion, b: LibGdxRegion): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

  backWalls.sort(byName);
  floorStamps.sort(byName);
  altFloorStamps.sort(byName);
  groundCaps.sort(byName);
  ceilingCaps.sort(byName);
  arches.sort(byName);
  banners.sort(byName);
  floorJunk.sort(byName);
  wallJunk.sort(byName);

  // Prefer 24px-wide platforms first (ladderPlatform / unstablePlatform_0), then bridgeTile
  oneWays.sort((a, b) => a.w - b.w || byName(a, b));
  chains.sort((a, b) => (a.name === 'chain_0' ? -1 : b.name === 'chain_0' ? 1 : byName(a, b)));
  exitDoors.sort((a, b) =>
    a.name === 'exitDoor' ? -1 : b.name === 'exitDoor' ? 1 : byName(a, b)
  );

  // Bridge & Throne atlases use stoneWall / floorStampLeft/Right / backWalls as 24x24 solid stonework
  if (floorStamps.length === 0 && altFloorStamps.length > 0) {
    for (let i = 0; i < altFloorStamps.length; i++) floorStamps.push(altFloorStamps[i]);
  }
  if (floorStamps.length < 2 && backWalls.length > 0) {
    for (let i = 0; i < backWalls.length; i++) floorStamps.push(backWalls[i]);
  }

  const regs = loaded.atlas.regions;
  return {
    backWalls,
    floorStamps,
    groundCaps,
    ceilingCaps,
    oneWays,
    chains,
    arches,
    banners,
    exitDoors,
    floorJunk,
    wallJunk,
    ladder: regs.get('ladder') ?? null,
    brasero: regs.get('brasero') ?? null,
    torch: regs.get('torch') ?? null,
    chestBasicClosed: regs.get('chestBasicClosed') ?? null,
    chestBasicOpen: regs.get('chestBasicOpen') ?? null,
    chestTwClosed: regs.get('chestTwClosed') ?? null,
    chestTwOpen: regs.get('chestTwOpen') ?? null,
    woodDoorMeta: regs.get('woodDoorMeta') ?? null,
    normalDoorSide: regs.get('normalDoorSide') ?? null,
    goldDoor: regs.get('goldDoor') ?? null,
    timeDoor: regs.get('timeDoor') ?? null,
    collectorDoor: regs.get('collectorDoor') ?? null,
    prisonBossDoor: regs.get('prisonBossDoor') ?? null,
    collectorBack: regs.get('collectorBack') ?? null,
    foundry: regs.get('foundry') ?? null,
    teleportAltar: regs.get('teleportAltar') ?? null,
    flagMetaObject: regs.get('flagMetaObject') ?? null,
  };
}

function pickScrollerLayerPaths(
  themeKey: string,
  paths: readonly string[]
): { far: string | null; mid: string | null } {
  const findFirst = (names: readonly string[], exclude?: string | null): string | null => {
    for (let n = 0; n < names.length; n++) {
      const target = names[n];
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        if (exclude && p === exclude) continue;
        const base = (p.split('/').pop() ?? p).toLowerCase();
        if (base === target) return p;
      }
    }
    return null;
  };

  let far: string | null = null;
  let mid: string | null = null;

  if (themeKey === 'prison') {
    far = findFirst([
      'prisonstartscrollera.png',
      'prisonscrollera.png',
      'prisonhubscrollera.png',
      'archesmallbg_0.png',
    ]);
    mid = findFirst(
      ['archesmallbg_0.png', 'archesmallfg_0.png', 'prisonscrollera.png', 'prisonstartscrollerb.png'],
      far
    );
  } else if (themeKey === 'courtyard') {
    far = findFirst(['archesmallbg_0.png']);
    mid = findFirst(['archesmallfg_0.png'], far);
  } else if (themeKey === 'sewers') {
    far = findFirst(['archesmallbg_0.png', 'archesmallbg_1.png']);
    mid = findFirst(['archesmallfg_0.png', 'archesmallfg_1.png'], far);
  } else if (themeKey === 'cliff') {
    far = findFirst(['scrollerbg_0.png']);
    mid = findFirst(['scrollerlayer1_0.png', 'scrollerlayer2_0.png'], far);
  } else if (themeKey === 'castle') {
    far = findFirst(['wallwindowscroller.png', 'archesmallbg_0.png']);
    mid = findFirst(['archesmallfg_0.png', 'archesmallbg_0.png'], far);
  }

  if (!far && paths.length > 0) {
    far = paths.find((p) => !p.toLowerCase().includes('fog')) ?? paths[0];
  }
  if (!mid && paths.length > 1) {
    mid = paths.find((p) => p !== far && !p.toLowerCase().includes('fog')) ?? null;
  }
  return { far, mid };
}

async function decodeScrollerBlob(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fall through to HTMLImageElement
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Pre-allocated scratch buffer for hex color parsing (zero GC!)
const hexScratch = new Float32Array(3);

function parseHexToScratch(hex: string, dr = 1, dg = 1, db = 1): void {
  if (!hex) {
    hexScratch[0] = dr;
    hexScratch[1] = dg;
    hexScratch[2] = db;
    return;
  }
  const clean = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  const n = parseInt(clean, 16);
  if (Number.isNaN(n)) {
    hexScratch[0] = dr;
    hexScratch[1] = dg;
    hexScratch[2] = db;
    return;
  }
  hexScratch[0] = ((n >> 16) & 255) / 255;
  hexScratch[1] = ((n >> 8) & 255) / 255;
  hexScratch[2] = (n & 255) / 255;
}

function tileHash(tx: number, ty: number): number {
  let n = Math.imul(tx, 374761393) ^ Math.imul(ty, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

export class WebGL2Renderer implements RendererAPI {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private backend: 'webgl2' | 'canvas2d-fallback' = 'webgl2';

  private settings: RenderSettings = {
    targetFps: 120,
    snapToSimRate: false,
    lightingQuality: 'high',
    bloomEnabled: true,
    screenShakeScale: 1.0,
    artPackMode: 'builtin',
  };

  private atlas!: ProceduralAtlasData;
  private particles = new AtmosphereParticles();

  // Viewport metrics for aspect-preserving crisp upscaling
  private canvasW = VIEWPORT_W * 2;
  private canvasH = VIEWPORT_H * 2;
  private vpX = 0;
  private vpY = 0;
  private vpW = VIEWPORT_W * 2;
  private vpH = VIEWPORT_H * 2;

  // Frame telemetry
  private drawCalls = 0;
  private activeLights = 0;

  // Custom Pack Integration
  private customPackStatus: CustomPackStatus = {
    available: false,
    source: 'none',
    atlasCount: 0,
    audioCount: 0,
    loadedAtlases: [],
  };
  private customPackLoader: CustomPackLoader | null = null;
  private customGpuAtlases = new Map<string, CustomGpuAtlas>();
  private customLoadInFlight = new Set<string>();
  private customScrollersLoaded = new Set<string>();
  private lastActiveBiomeId: BiomeId = 'PrisonStart';

  // GPU Atlas Textures
  private texAlbedo: WebGLTexture | null = null;
  private texNormal: WebGLTexture | null = null;
  private texEmissive: WebGLTexture | null = null;
  private texFlatNormal: WebGLTexture | null = null;
  private texBlackEmissive: WebGLTexture | null = null;

  // Programs
  private progParallax: WebGLProgram | null = null;
  private progGBuffer: WebGLProgram | null = null;
  private progLighting: WebGLProgram | null = null;
  private progVfx: WebGLProgram | null = null;
  private progFog: WebGLProgram | null = null;
  private progBlur: WebGLProgram | null = null;
  private progComposite: WebGLProgram | null = null;

  private backdropPass: ParallaxBackdropPass | null = null;

  // Geometry
  private emptyVao: WebGLVertexArrayObject | null = null;
  private batchVao: WebGLVertexArrayObject | null = null;
  private batchVbo: WebGLBuffer | null = null;
  private batchIbo: WebGLBuffer | null = null;
  private readonly vertexData = new Float32Array(MAX_QUADS * FLOATS_PER_QUAD);
  private quadCount = 0;
  private activeBatchProgram: WebGLProgram | null = null;
  private boundAlbedo: WebGLTexture | null = null;
  private boundNormal: WebGLTexture | null = null;
  private boundEmissive: WebGLTexture | null = null;

  // FBOs & Render Target Textures
  private fboBackdrop: WebGLFramebuffer | null = null;
  private rtBackdrop: WebGLTexture | null = null;

  private fboGBuffer: WebGLFramebuffer | null = null;
  private rtGAlbedo: WebGLTexture | null = null;
  private rtGNormal: WebGLTexture | null = null;
  private rtGEmissive: WebGLTexture | null = null;

  private fboLit: WebGLFramebuffer | null = null;
  private rtLit: WebGLTexture | null = null;
  private rtBloomSrc: WebGLTexture | null = null;

  private fboBloomA: WebGLFramebuffer | null = null;
  private rtBloomA: WebGLTexture | null = null;
  private fboBloomB: WebGLFramebuffer | null = null;
  private rtBloomB: WebGLTexture | null = null;

  // Cached Uniform Locations
  private uGBufRes: WebGLUniformLocation | null = null;
  private uGBufAlb: WebGLUniformLocation | null = null;
  private uGBufNrm: WebGLUniformLocation | null = null;
  private uGBufEms: WebGLUniformLocation | null = null;

  private uLightBackdrop: WebGLUniformLocation | null = null;
  private uLightAlbedo: WebGLUniformLocation | null = null;
  private uLightNormal: WebGLUniformLocation | null = null;
  private uLightEmissive: WebGLUniformLocation | null = null;
  private uLightRes: WebGLUniformLocation | null = null;
  private uLightAmbient: WebGLUniformLocation | null = null;
  private uLightCelShadow: WebGLUniformLocation | null = null;
  private uLightFog: WebGLUniformLocation | null = null;
  private uLightRim: WebGLUniformLocation | null = null;
  private uLightCount: WebGLUniformLocation | null = null;
  private uLightPosRad: WebGLUniformLocation | null = null;
  private uLightColInt: WebGLUniformLocation | null = null;

  private uVfxRes: WebGLUniformLocation | null = null;
  private uVfxAlb: WebGLUniformLocation | null = null;
  private uVfxEms: WebGLUniformLocation | null = null;

  private uFogRes: WebGLUniformLocation | null = null;
  private uFogCam: WebGLUniformLocation | null = null;
  private uFogTime: WebGLUniformLocation | null = null;
  private uFogCol: WebGLUniformLocation | null = null;
  private uFogAcc: WebGLUniformLocation | null = null;
  private uFogDens: WebGLUniformLocation | null = null;

  private uBlurSrc: WebGLUniformLocation | null = null;
  private uBlurStep: WebGLUniformLocation | null = null;

  private uCompScene: WebGLUniformLocation | null = null;
  private uCompBloom: WebGLUniformLocation | null = null;
  private uCompBloomStr: WebGLUniformLocation | null = null;
  private uCompDmgFlash: WebGLUniformLocation | null = null;
  private uCompParryFlash: WebGLUniformLocation | null = null;
  private uCompGradeTint: WebGLUniformLocation | null = null;

  // Pre-allocated Light Uniform Buffers (ZERO per-frame allocs!)
  private readonly lightPosRadBuf = new Float32Array(MAX_ACTIVE_LIGHTS * 4);
  private readonly lightColIntBuf = new Float32Array(MAX_ACTIVE_LIGHTS * 4);
  private curLightCount = 0;
  private curMaxLights: number = MAX_ACTIVE_LIGHTS;
  private curCamX = 0;
  private curCamY = 0;
  private customHeadOx = 0;
  private customHeadOy = -28;

  // Bound callback closures created once in constructor (zero per-frame closures!)
  private readonly emitVfxQuadBound = (
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
    angleRad = 0
  ): void => {
    let reg = this.atlas.regions[spriteKey];
    if (!reg) {
      if (spriteKey === 'vfx:shockwave_ring') {
        reg = resolveSpriteRegion(this.atlas.regions, 'vfx:parry_ring');
      } else if (spriteKey === 'vfx:fireball_burst') {
        reg = resolveSpriteRegion(this.atlas.regions, 'vfx:ember');
      } else if (spriteKey === 'vfx:ice_burst') {
        reg = resolveSpriteRegion(this.atlas.regions, 'vfx:spark');
      } else {
        reg = resolveSpriteRegion(this.atlas.regions, spriteKey);
      }
    }
    if (angleRad !== 0) {
      this.pushRotatedQuad(
        reg,
        cx,
        cy,
        w,
        h,
        r,
        g,
        b,
        a,
        flipX,
        flashMix,
        emissiveBoost,
        1.0,
        angleRad
      );
    } else {
      this.pushQuad(
        reg,
        cx - w * 0.5,
        cy - h * 0.5,
        w,
        h,
        r,
        g,
        b,
        a,
        flipX,
        flashMix,
        emissiveBoost,
        1.0
      );
    }
  };

  private readonly emitDynamicLightBound = (
    worldX: number,
    worldY: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
    zHeight: number
  ): void => {
    this.addLight(worldX, worldY, radius, r, g, b, intensity, zHeight);
  };

  async init(canvas: HTMLCanvasElement, settings: RenderSettings): Promise<void> {
    this.canvas = canvas;
    this.settings = { ...settings };
    this.atlas = buildProceduralAtlas();

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      this.backend = 'canvas2d-fallback';
      this.ctx2d = canvas.getContext('2d');
      this.resize(canvas.clientWidth || VIEWPORT_W * 2, canvas.clientHeight || VIEWPORT_H * 2, 1);
      return;
    }

    this.backend = 'webgl2';
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.initTextures(gl);
    this.initPrograms(gl);
    this.initGeometry(gl);
    this.initFramebuffers(gl);

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.resize(
      canvas.clientWidth || canvas.width || VIEWPORT_W * 2,
      canvas.clientHeight || canvas.height || VIEWPORT_H * 2,
      dpr
    );
  }

  private initTextures(gl: WebGL2RenderingContext): void {
    const uploadNearestRgba = (pixels: Uint8Array, w: number, h: number): WebGLTexture => {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Failed to create atlas WebGLTexture');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    this.texAlbedo = uploadNearestRgba(this.atlas.albedoPixels, this.atlas.width, this.atlas.height);
    this.texNormal = uploadNearestRgba(this.atlas.normalPixels, this.atlas.width, this.atlas.height);
    this.texEmissive = uploadNearestRgba(
      this.atlas.emissivePixels,
      this.atlas.width,
      this.atlas.height
    );
    this.texFlatNormal = uploadNearestRgba(new Uint8Array([128, 128, 255, 255]), 1, 1);
    this.texBlackEmissive = uploadNearestRgba(new Uint8Array([0, 0, 0, 0]), 1, 1);
  }

  private initPrograms(gl: WebGL2RenderingContext): void {
    this.progParallax = compileProgram(gl, FULLSCREEN_VERT, PARALLAX_FRAG, 'ParallaxBackdrop');
    this.backdropPass = new ParallaxBackdropPass(gl, this.progParallax);

    this.progGBuffer = compileProgram(gl, GBUFFER_VERT, GBUFFER_FRAG, 'GBufferBatch');
    this.uGBufRes = gl.getUniformLocation(this.progGBuffer, 'u_resolution');
    this.uGBufAlb = gl.getUniformLocation(this.progGBuffer, 'u_albedoTex');
    this.uGBufNrm = gl.getUniformLocation(this.progGBuffer, 'u_normalTex');
    this.uGBufEms = gl.getUniformLocation(this.progGBuffer, 'u_emissiveTex');

    this.progLighting = compileProgram(gl, FULLSCREEN_VERT, LIGHTING_FRAG, 'CelLighting');
    this.uLightBackdrop = gl.getUniformLocation(this.progLighting, 'u_backdropTex');
    this.uLightAlbedo = gl.getUniformLocation(this.progLighting, 'u_albedoTex');
    this.uLightNormal = gl.getUniformLocation(this.progLighting, 'u_normalTex');
    this.uLightEmissive = gl.getUniformLocation(this.progLighting, 'u_emissiveTex');
    this.uLightRes = gl.getUniformLocation(this.progLighting, 'u_resolution');
    this.uLightAmbient = gl.getUniformLocation(this.progLighting, 'u_ambientColor');
    this.uLightCelShadow = gl.getUniformLocation(this.progLighting, 'u_celShadowColor');
    this.uLightFog = gl.getUniformLocation(this.progLighting, 'u_fogColor');
    this.uLightRim = gl.getUniformLocation(this.progLighting, 'u_rimColor');
    this.uLightCount = gl.getUniformLocation(this.progLighting, 'u_lightCount');
    this.uLightPosRad = gl.getUniformLocation(this.progLighting, 'u_lightPosRadius');
    this.uLightColInt = gl.getUniformLocation(this.progLighting, 'u_lightColorIntensity');

    this.progVfx = compileProgram(gl, VFX_VERT, VFX_FRAG, 'VfxOverlay');
    this.uVfxRes = gl.getUniformLocation(this.progVfx, 'u_resolution');
    this.uVfxAlb = gl.getUniformLocation(this.progVfx, 'u_albedoTex');
    this.uVfxEms = gl.getUniformLocation(this.progVfx, 'u_emissiveTex');

    this.progFog = compileProgram(gl, FULLSCREEN_VERT, FOG_FRAG, 'VolumetricFog');
    this.uFogRes = gl.getUniformLocation(this.progFog, 'u_resolution');
    this.uFogCam = gl.getUniformLocation(this.progFog, 'u_camera');
    this.uFogTime = gl.getUniformLocation(this.progFog, 'u_time');
    this.uFogCol = gl.getUniformLocation(this.progFog, 'u_fogColor');
    this.uFogAcc = gl.getUniformLocation(this.progFog, 'u_accentColor');
    this.uFogDens = gl.getUniformLocation(this.progFog, 'u_fogDensity');

    this.progBlur = compileProgram(gl, FULLSCREEN_VERT, BLUR_FRAG, 'BloomBlur');
    this.uBlurSrc = gl.getUniformLocation(this.progBlur, 'u_srcTex');
    this.uBlurStep = gl.getUniformLocation(this.progBlur, 'u_texelStep');

    this.progComposite = compileProgram(gl, FULLSCREEN_VERT, COMPOSITE_FRAG, 'FinalComposite');
    this.uCompScene = gl.getUniformLocation(this.progComposite, 'u_sceneTex');
    this.uCompBloom = gl.getUniformLocation(this.progComposite, 'u_bloomTex');
    this.uCompBloomStr = gl.getUniformLocation(this.progComposite, 'u_bloomStrength');
    this.uCompDmgFlash = gl.getUniformLocation(this.progComposite, 'u_damageFlash');
    this.uCompParryFlash = gl.getUniformLocation(this.progComposite, 'u_parryFlash');
    this.uCompGradeTint = gl.getUniformLocation(this.progComposite, 'u_gradeTint');
  }

  private initGeometry(gl: WebGL2RenderingContext): void {
    this.emptyVao = gl.createVertexArray();

    this.batchVao = gl.createVertexArray();
    this.batchVbo = gl.createBuffer();
    this.batchIbo = gl.createBuffer();

    gl.bindVertexArray(this.batchVao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.batchVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    const indices = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const vi = q * 4;
      const ii = q * 6;
      indices[ii] = vi;
      indices[ii + 1] = vi + 1;
      indices[ii + 2] = vi + 2;
      indices[ii + 3] = vi + 2;
      indices[ii + 4] = vi + 1;
      indices[ii + 5] = vi + 3;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.batchIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);

    gl.bindVertexArray(null);
  }

  private createRenderTargetTex(
    gl: WebGL2RenderingContext,
    w: number,
    h: number,
    filter: number
  ): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create render target texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private initFramebuffers(gl: WebGL2RenderingContext): void {
    // Pass 1: Backdrop 480x270 NEAREST
    this.fboBackdrop = gl.createFramebuffer();
    this.rtBackdrop = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBackdrop);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rtBackdrop, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Pass 2: G-Buffer MRT (Albedo, Normal, Emissive) 480x270 NEAREST
    this.fboGBuffer = gl.createFramebuffer();
    this.rtGAlbedo = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.NEAREST);
    this.rtGNormal = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.NEAREST);
    this.rtGEmissive = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboGBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rtGAlbedo, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.rtGNormal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.rtGEmissive, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    // Pass 3 + 3.5: Lit Scene (NEAREST) + Bloom Source (LINEAR for silky downsample!)
    this.fboLit = gl.createFramebuffer();
    this.rtLit = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.NEAREST);
    this.rtBloomSrc = this.createRenderTargetTex(gl, VIEWPORT_W, VIEWPORT_H, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboLit);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rtLit, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.rtBloomSrc, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    // Pass 4B: Bloom Ping-Pong A & B (240x135 LINEAR)
    this.fboBloomA = gl.createFramebuffer();
    this.rtBloomA = this.createRenderTargetTex(gl, BLOOM_W, BLOOM_H, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rtBloomA, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    this.fboBloomB = gl.createFramebuffer();
    this.rtBloomB = this.createRenderTargetTex(gl, BLOOM_W, BLOOM_H, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rtBloomB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number, dpr: number): void {
    const safeDpr = Math.max(1, Math.min(3, dpr || 1));
    const pw = Math.max(VIEWPORT_W, Math.round(Math.max(1, width) * safeDpr));
    const ph = Math.max(VIEWPORT_H, Math.round(Math.max(1, height) * safeDpr));
    this.canvasW = pw;
    this.canvasH = ph;
    if (this.canvas) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    // Crisp 16:9 aspect-preserving viewport centered inside the canvas
    const targetAspect = VIEWPORT_W / VIEWPORT_H;
    const canvasAspect = pw / ph;
    if (canvasAspect > targetAspect) {
      this.vpH = ph;
      this.vpW = Math.round(ph * targetAspect);
      this.vpX = Math.floor((pw - this.vpW) * 0.5);
      this.vpY = 0;
    } else {
      this.vpW = pw;
      this.vpH = Math.round(pw / targetAspect);
      this.vpX = 0;
      this.vpY = Math.floor((ph - this.vpH) * 0.5);
    }
  }

  updateSettings(settings: RenderSettings): void {
    this.settings = { ...settings };
    if (this.settings.artPackMode === 'custom' && this.customPackStatus.available) {
      this.prefetchCoreCustomAssets();
    }
  }

  setCustomPackAvailable(pack: CustomPackStatus, loader?: CustomPackAssetResolver): void {
    this.customPackStatus = { ...pack };
    if (loader instanceof CustomPackLoader) {
      this.customPackLoader = loader;
    }
    if (pack.available && this.settings.artPackMode === 'custom') {
      this.prefetchCoreCustomAssets();
    }
  }

  private ensureCustomAtlasLoaded(name: string): CustomGpuAtlas | null {
    const existing = this.customGpuAtlases.get(name);
    if (existing) return existing;
    const loader = this.customPackLoader;
    const gl = this.gl;
    if (!loader || !gl || this.customLoadInFlight.has(name)) return null;
    const manifest = loader.getManifest();
    if (!manifest || !manifest.atlases[name]) return null;

    this.customLoadInFlight.add(name);
    void loader.loadAtlas(name).then((loaded) => {
      this.customLoadInFlight.delete(name);
      if (!loaded || !this.gl) return;
      const pages: CustomGpuAtlasPage[] = [];
      for (const p of loaded.pages) {
        const dTex = this.uploadImageTexture(this.gl, p.diffuse);
        const nTex = p.normal ? this.uploadImageTexture(this.gl, p.normal) : this.texFlatNormal!;
        pages.push({ diffuseTex: dTex, normalTex: nTex, width: p.width, height: p.height });
      }
      const cache = buildBiomeAtlasCache(loaded);
      this.customGpuAtlases.set(name, { loaded, pages, cache });
    });
    return null;
  }

  private getBiomeCustomAtlas(biomeId: BiomeId): CustomGpuAtlas | null {
    const atlasName = BIOME_CUSTOM_ATLAS_MAP[biomeId] ?? 'prison';
    const primary = this.ensureCustomAtlasLoaded(atlasName);
    if (primary) return primary;
    if (biomeId === 'TopClockTower') {
      return this.ensureCustomAtlasLoaded('clockTower');
    }
    return null;
  }

  private prefetchCoreCustomAssets(biomeId: BiomeId = this.lastActiveBiomeId): void {
    const loader = this.customPackLoader;
    const gl = this.gl;
    if (!loader || !gl) return;
    const manifest = loader.getManifest();
    if (!manifest) return;

    // Immediately prefetch current biome atlas (+ clockTower fallback for TopClockTower)
    this.ensureCustomAtlasLoaded(BIOME_CUSTOM_ATLAS_MAP[biomeId] ?? 'prison');
    if (biomeId === 'TopClockTower') {
      this.ensureCustomAtlasLoaded('clockTower');
    }

    const coreAtlases = [
      'common',
      'beheaded',
      'fxWeapon',
      'fxCommon',
      'behemoth',
      'timeKeeper',
      'HotK',
      'collector',
      'blacksmith',
      'knight',
      'zombie',
      'deadArcher',
      'grenadier',
      'zombieShield',
      'mago360',
      'comboter',
      'ninja',
      'leapingDuelyst',
      'grenadierCluster',
      'pirate',
      'lancer',
      'zombieWorm',
      'zombieFly',
    ];
    for (const name of coreAtlases) {
      this.ensureCustomAtlasLoaded(name);
    }

    // Load 2-layer far + mid Custom Pack parallax scrollers directly via loader.fetchBlob!
    for (const scrollerKey of Object.keys(manifest.scrollers)) {
      if (this.customScrollersLoaded.has(scrollerKey)) continue;
      const paths = manifest.scrollers[scrollerKey];
      if (!paths || paths.length === 0) continue;
      this.customScrollersLoaded.add(scrollerKey);

      const { far, mid } = pickScrollerLayerPaths(scrollerKey, paths);
      if (far) {
        void loader.fetchBlob(far).then(async (blob) => {
          if (!blob || !this.gl || !this.backdropPass) return;
          const img = await decodeScrollerBlob(blob);
          if (img && this.gl && this.backdropPass) {
            this.backdropPass.uploadScrollerLayer(this.gl, scrollerKey, 'far', img);
          }
        });
      }
      if (mid) {
        void loader.fetchBlob(mid).then(async (blob) => {
          if (!blob || !this.gl || !this.backdropPass) return;
          const img = await decodeScrollerBlob(blob);
          if (img && this.gl && this.backdropPass) {
            this.backdropPass.uploadScrollerLayer(this.gl, scrollerKey, 'mid', img);
          }
        });
      }
    }
  }

  private uploadImageTexture(
    gl: WebGL2RenderingContext,
    img: ImageBitmap | HTMLImageElement | HTMLCanvasElement
  ): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create custom pack texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  ingestEvents(events: readonly SimEvent[], state: SimState): void {
    this.particles.ingestEvents(events, state);
  }

  getDrawCallCount(): number {
    return this.drawCalls;
  }

  getActiveLightCount(): number {
    return this.activeLights;
  }

  getBackendName(): 'webgl2' | 'canvas2d-fallback' {
    return this.backend;
  }

  // ---------------------------------------------------------------------------
  // Zero-Allocation Batch Primitives
  // ---------------------------------------------------------------------------

  private beginBatch(
    program: WebGLProgram,
    albedoTex: WebGLTexture,
    normalTex: WebGLTexture,
    emissiveTex: WebGLTexture
  ): void {
    this.activeBatchProgram = program;
    this.boundAlbedo = albedoTex;
    this.boundNormal = normalTex;
    this.boundEmissive = emissiveTex;
    this.quadCount = 0;
  }

  private ensureTextures(
    albedoTex: WebGLTexture,
    normalTex: WebGLTexture,
    emissiveTex: WebGLTexture
  ): void {
    if (
      this.boundAlbedo !== albedoTex ||
      this.boundNormal !== normalTex ||
      this.boundEmissive !== emissiveTex
    ) {
      this.flushBatch();
      this.boundAlbedo = albedoTex;
      this.boundNormal = normalTex;
      this.boundEmissive = emissiveTex;
    }
  }

  private flushBatch(): void {
    const gl = this.gl;
    if (!gl || this.quadCount === 0 || !this.activeBatchProgram) return;

    gl.useProgram(this.activeBatchProgram);
    gl.bindVertexArray(this.batchVao);

    if (this.activeBatchProgram === this.progGBuffer) {
      gl.uniform2f(this.uGBufRes, VIEWPORT_W, VIEWPORT_H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.boundAlbedo);
      gl.uniform1i(this.uGBufAlb, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boundNormal);
      gl.uniform1i(this.uGBufNrm, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.boundEmissive);
      gl.uniform1i(this.uGBufEms, 2);
    } else {
      gl.uniform2f(this.uVfxRes, VIEWPORT_W, VIEWPORT_H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.boundAlbedo);
      gl.uniform1i(this.uVfxAlb, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boundEmissive);
      gl.uniform1i(this.uVfxEms, 1);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.batchVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertexData, 0, this.quadCount * FLOATS_PER_QUAD);
    gl.drawElements(gl.TRIANGLES, this.quadCount * 6, gl.UNSIGNED_SHORT, 0);

    this.drawCalls++;
    this.quadCount = 0;
  }

  private pushRawQuad(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
    flipX: number,
    flashMix: number,
    emissiveBoost: number,
    normalStrength: number
  ): void {
    if (this.quadCount >= MAX_QUADS) this.flushBatch();
    const o = this.quadCount * FLOATS_PER_QUAD;
    const buf = this.vertexData;

    const ua = flipX < 0 ? u1 : u0;
    const ub = flipX < 0 ? u0 : u1;

    // Top-left
    buf[o] = x0; buf[o + 1] = y0; buf[o + 2] = ua; buf[o + 3] = v0;
    buf[o + 4] = r; buf[o + 5] = g; buf[o + 6] = b; buf[o + 7] = a;
    buf[o + 8] = flipX; buf[o + 9] = flashMix; buf[o + 10] = emissiveBoost; buf[o + 11] = normalStrength;

    // Top-right
    buf[o + 12] = x1; buf[o + 13] = y0; buf[o + 14] = ub; buf[o + 15] = v0;
    buf[o + 16] = r; buf[o + 17] = g; buf[o + 18] = b; buf[o + 19] = a;
    buf[o + 20] = flipX; buf[o + 21] = flashMix; buf[o + 22] = emissiveBoost; buf[o + 23] = normalStrength;

    // Bottom-left
    buf[o + 24] = x0; buf[o + 25] = y1; buf[o + 26] = ua; buf[o + 27] = v1;
    buf[o + 28] = r; buf[o + 29] = g; buf[o + 30] = b; buf[o + 31] = a;
    buf[o + 32] = flipX; buf[o + 33] = flashMix; buf[o + 34] = emissiveBoost; buf[o + 35] = normalStrength;

    // Bottom-right
    buf[o + 36] = x1; buf[o + 37] = y1; buf[o + 38] = ub; buf[o + 39] = v1;
    buf[o + 40] = r; buf[o + 41] = g; buf[o + 42] = b; buf[o + 43] = a;
    buf[o + 44] = flipX; buf[o + 45] = flashMix; buf[o + 46] = emissiveBoost; buf[o + 47] = normalStrength;

    this.quadCount++;
  }

  private pushQuad(
    reg: SpriteRegion,
    x: number,
    y: number,
    w: number,
    h: number,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
    flipX = 1,
    flashMix = 0,
    emissiveBoost = 0,
    normalStrength = 1.0
  ): void {
    this.ensureTextures(this.texAlbedo!, this.texNormal!, this.texEmissive!);
    this.pushRawQuad(
      x,
      y,
      x + w,
      y + h,
      reg.u0,
      reg.v0,
      reg.u1,
      reg.v1,
      r,
      g,
      b,
      a,
      flipX,
      flashMix,
      emissiveBoost,
      normalStrength
    );
  }

  private pushRotatedQuad(
    reg: SpriteRegion,
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
    normalStrength: number,
    angleRad: number
  ): void {
    this.ensureTextures(this.texAlbedo!, this.texNormal!, this.texEmissive!);
    if (this.quadCount >= MAX_QUADS) this.flushBatch();
    const o = this.quadCount * FLOATS_PER_QUAD;
    const buf = this.vertexData;

    const hw = w * 0.5;
    const hh = h * 0.5;
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);

    const tlx = cx + (-hw * c - -hh * s);
    const tly = cy + (-hw * s + -hh * c);
    const trx = cx + (hw * c - -hh * s);
    const try_ = cy + (hw * s + -hh * c);
    const blx = cx + (-hw * c - hh * s);
    const bly = cy + (-hw * s + hh * c);
    const brx = cx + (hw * c - hh * s);
    const bry = cy + (hw * s + hh * c);

    const ua = flipX < 0 ? reg.u1 : reg.u0;
    const ub = flipX < 0 ? reg.u0 : reg.u1;

    buf[o] = tlx; buf[o + 1] = tly; buf[o + 2] = ua; buf[o + 3] = reg.v0;
    buf[o + 4] = r; buf[o + 5] = g; buf[o + 6] = b; buf[o + 7] = a;
    buf[o + 8] = flipX; buf[o + 9] = flashMix; buf[o + 10] = emissiveBoost; buf[o + 11] = normalStrength;

    buf[o + 12] = trx; buf[o + 13] = try_; buf[o + 14] = ub; buf[o + 15] = reg.v0;
    buf[o + 16] = r; buf[o + 17] = g; buf[o + 18] = b; buf[o + 19] = a;
    buf[o + 20] = flipX; buf[o + 21] = flashMix; buf[o + 22] = emissiveBoost; buf[o + 23] = normalStrength;

    buf[o + 24] = blx; buf[o + 25] = bly; buf[o + 26] = ua; buf[o + 27] = reg.v1;
    buf[o + 28] = r; buf[o + 29] = g; buf[o + 30] = b; buf[o + 31] = a;
    buf[o + 32] = flipX; buf[o + 33] = flashMix; buf[o + 34] = emissiveBoost; buf[o + 35] = normalStrength;

    buf[o + 36] = brx; buf[o + 37] = bry; buf[o + 38] = ub; buf[o + 39] = reg.v1;
    buf[o + 40] = r; buf[o + 41] = g; buf[o + 42] = b; buf[o + 43] = a;
    buf[o + 44] = flipX; buf[o + 45] = flashMix; buf[o + 46] = emissiveBoost; buf[o + 47] = normalStrength;

    this.quadCount++;
  }

  private pushCustomRegion(
    gpuAtlas: CustomGpuAtlas,
    reg: LibGdxRegion,
    x: number,
    y: number,
    w: number,
    h: number,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
    flipX = 1,
    flashMix = 0,
    emissiveBoost = 0,
    normalStrength = 1.0
  ): void {
    const page = gpuAtlas.pages[reg.pageIndex];
    if (!page) return;
    this.ensureTextures(page.diffuseTex, page.normalTex, this.texBlackEmissive!);
    const u0 = reg.x / page.width;
    const v0 = reg.y / page.height;
    const u1 = (reg.x + reg.w) / page.width;
    const v1 = (reg.y + reg.h) / page.height;
    this.pushRawQuad(
      x,
      y,
      x + w,
      y + h,
      u0,
      v0,
      u1,
      v1,
      r,
      g,
      b,
      a,
      flipX,
      flashMix,
      emissiveBoost,
      normalStrength
    );
  }

  private pushCustomRegionSliceX(
    gpuAtlas: CustomGpuAtlas,
    reg: LibGdxRegion,
    fracX0: number,
    fracX1: number,
    x: number,
    y: number,
    w: number,
    h: number,
    normalStrength = 1.0
  ): void {
    const page = gpuAtlas.pages[reg.pageIndex];
    if (!page) return;
    this.ensureTextures(page.diffuseTex, page.normalTex, this.texBlackEmissive!);
    const u0 = (reg.x + reg.w * fracX0) / page.width;
    const v0 = reg.y / page.height;
    const u1 = (reg.x + reg.w * fracX1) / page.width;
    const v1 = (reg.y + reg.h) / page.height;
    this.pushRawQuad(x, y, x + w, y + h, u0, v0, u1, v1, 1, 1, 1, 1, 1, 0, 0, normalStrength);
  }

  private drawSpriteKey(
    key: string,
    anchorX: number,
    anchorY: number,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
    flipX = 1,
    flashMix = 0,
    emissiveBoost = 0,
    normalStrength = 1.0,
    scale = 1.0
  ): void {
    const reg = resolveSpriteRegion(this.atlas.regions, key);
    const w = reg.w * scale;
    const h = reg.h * scale;
    const x = Math.round(anchorX - w * reg.pivotX);
    const y = Math.round(anchorY - h * reg.pivotY);
    this.pushQuad(reg, x, y, w, h, r, g, b, a, flipX, flashMix, emissiveBoost, normalStrength);
  }

  /** Attempts to draw from a loaded Owned Custom Pack atlas, returning true on hit. */
  private tryDrawCustomPackSprite(
    atlasName: string,
    animCandidates: string | readonly string[],
    frameIdx: number,
    anchorX: number,
    anchorY: number,
    flipX: number,
    flashMix: number,
    scaleOverride = 0.72
  ): boolean {
    this.customHeadOx = 0;
    this.customHeadOy = -26;
    if (this.settings.artPackMode !== 'custom' || !this.customPackStatus.available) {
      return false;
    }
    const gpuAtlas = this.ensureCustomAtlasLoaded(atlasName);
    if (!gpuAtlas) {
      return false;
    }

    const candidates = typeof animCandidates === 'string' ? [animCandidates] : animCandidates;
    let matchedName = '';
    let frames: ReturnType<typeof gpuAtlas.loaded.atlas.animations.get> = undefined;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const f = gpuAtlas.loaded.atlas.animations.get(c) ?? gpuAtlas.loaded.atlas.animations.get(c.toLowerCase());
      if (f && f.length > 0) {
        frames = f;
        matchedName = c;
        break;
      }
    }
    // Last-resort fallback: first available animation in the atlas (never draw blank!)
    if (!frames || frames.length === 0) {
      const first = gpuAtlas.loaded.atlas.animations.entries().next();
      if (!first.done) {
        matchedName = first.value[0];
        frames = first.value[1];
      }
    }
    if (!frames || frames.length === 0) return false;

    const fIdx = Math.abs(frameIdx) % frames.length;
    const region = frames[fIdx];
    const page = gpuAtlas.pages[region.pageIndex];
    if (!page) {
      return false;
    }

    this.ensureTextures(page.diffuseTex, page.normalTex, this.texBlackEmissive!);

    const u0 = region.x / page.width;
    const v0 = region.y / page.height;
    const u1 = (region.x + region.w) / page.width;
    const v1 = (region.y + region.h) / page.height;

    const scale = scaleOverride;
    const dw = region.w * scale;
    const dh = region.h * scale;

    // Ground the trimmed sprite cleanly on anchorY (feet) and center horizontally on origW!
    const origW = region.origW > 0 ? region.origW : region.w;
    const origH = region.origH > 0 ? region.origH : region.h;
    const centerOffX = (region.offsetX + region.w * 0.5 - origW * 0.5) * scale * flipX;
    const x0 = Math.round(anchorX + centerOffX - dw * 0.5);
    const y0 = Math.round(anchorY - dh);

    this.pushRawQuad(x0, y0, x0 + dw, y0 + dh, u0, v0, u1, v1, 1, 1, 1, 1, flipX, flashMix, 0, 1.0);

    // Bone track lookup (`headBone` in Dead Cells beheaded_tracks.json)
    const frameKey = `${matchedName}_${fIdx}`;
    const bones =
      gpuAtlas.loaded.tracks?.byAnimFrame.get(frameKey) ??
      gpuAtlas.loaded.tracks?.defaultBones ??
      null;
    const headBone = bones?.headBone;
    if (headBone) {
      const bx = (headBone.x - origW * 0.5) * scale * flipX;
      // Dead Cells tracks.json y is measured down from top of origH; snug flame directly onto neck collar
      const footRow = region.offsetY + region.h;
      const by = (headBone.y - footRow) * scale + 6;
      this.customHeadOx = Math.max(-14, Math.min(14, bx));
      this.customHeadOy = Math.max(-36, Math.min(-10, by));
    } else {
      this.customHeadOx = flipX * 1;
      this.customHeadOy = -Math.max(18, Math.min(30, dh * 0.80));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Dynamic Light Gathering (up to 64 active lights, zero allocations)
  // ---------------------------------------------------------------------------

  private addLight(
    worldX: number,
    worldY: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
    zHeight = 28
  ): void {
    if (this.curLightCount >= this.curMaxLights) return;
    const sx = worldX - this.curCamX;
    const sy = worldY - this.curCamY;
    if (sx < -radius || sx > VIEWPORT_W + radius || sy < -radius || sy > VIEWPORT_H + radius) {
      return;
    }
    const idx = this.curLightCount * 4;
    this.lightPosRadBuf[idx] = sx;
    this.lightPosRadBuf[idx + 1] = sy;
    this.lightPosRadBuf[idx + 2] = radius;
    this.lightPosRadBuf[idx + 3] = zHeight;

    this.lightColIntBuf[idx] = r;
    this.lightColIntBuf[idx + 1] = g;
    this.lightColIntBuf[idx + 2] = b;
    this.lightColIntBuf[idx + 3] = intensity;
    this.curLightCount++;
  }

  private gatherLights(
    state: SimState,
    interpAlpha: number,
    elapsedSec: number,
    heroX: number,
    heroY: number
  ): void {
    this.curLightCount = 0;
    this.curMaxLights =
      this.settings.lightingQuality === 'low'
        ? 20
        : this.settings.lightingQuality === 'medium'
        ? 40
        : MAX_ACTIVE_LIGHTS;

    // 1. Prisoner Homunculus Flame Light (balanced dual-tone cyan + warm amber — zero white blowout!)
    const heroFlick = 1.0 + Math.sin(elapsedSec * 12.5) * 0.08 + Math.sin(elapsedSec * 23.0) * 0.04;
    this.addLight(
      heroX + state.player.facing * 2,
      heroY - 24,
      132 * heroFlick,
      0.56,
      0.86,
      1.0,
      0.92 * heroFlick,
      36
    );
    this.addLight(heroX, heroY - 22, 58, 1.0, 0.54, 0.22, 0.48 * heroFlick, 24);

    // 1b. Active Hero Parry / Shield Block / CorruptedPower / Shield Dome Lights
    const p = state.player;
    if (p.parryWindowTicks > 0) {
      this.addLight(heroX + p.facing * 8, heroY - 16, 92, 1.0, 0.90, 0.36, 1.45, 28);
    } else if (p.shieldBlocking) {
      this.addLight(heroX + p.facing * 10, heroY - 16, 68, 0.42, 0.84, 1.0, 0.88, 26);
    }
    for (let s = 0; s < p.statusEffects.length; s++) {
      const sk = p.statusEffects[s].kind;
      if (sk === 'corrupted') {
        const pulse = 0.88 + 0.16 * Math.sin(elapsedSec * 14);
        this.addLight(heroX, heroY - 16, 112 * pulse, 0.88, 0.24, 1.0, 1.25 * pulse, 28);
      } else if (sk === 'shield') {
        const pulse = 0.92 + 0.10 * Math.sin(elapsedSec * 9);
        this.addLight(heroX, heroY - 16, 98 * pulse, 0.24, 1.0, 0.76, 1.05 * pulse, 28);
      }
    }

    // 2. Transient Combat Lights (slashes, crits, parries, dive-slam, heals)
    this.particles.emitTransientLights(this.emitDynamicLightBound);

    // 3. World Light Sources (braziers, wall torches, portals, scrolls, acid, boss energy)
    const worldLights = state.lights;
    for (let i = 0; i < worldLights.length; i++) {
      const l = worldLights[i];
      if (l.kind === 'homunculus') continue; // Rendered smoothly above at interpolated hero head
      const flick =
        l.flickerAmp > 0
          ? 1.0 +
            Math.sin(elapsedSec * l.flickerSpeed + l.id * 1.93) * l.flickerAmp +
            Math.sin(elapsedSec * l.flickerSpeed * 2.13 + l.id * 0.71) * (l.flickerAmp * 0.4)
          : 1.0;
      this.addLight(
        l.x,
        l.y,
        l.radius * (0.94 + 0.06 * flick),
        l.color[0],
        l.color[1],
        l.color[2],
        l.intensity * flick,
        l.kind === 'torch' || l.kind === 'brazier' ? 30 : 26
      );
    }

    // 4. Dynamic Entity Lights (Teleporters, Bosses, Pickups, Projectiles, Burning Enemies)
    for (let i = 0; i < state.teleporters.length; i++) {
      const tp = state.teleporters[i];
      const pulse = 0.85 + 0.15 * Math.sin(elapsedSec * 4.5 + tp.uid);
      this.addLight(
        tp.pos.x,
        tp.pos.y - 22,
        tp.activated ? 96 : 64,
        tp.activated ? 0.32 : 0.58,
        tp.activated ? 0.92 : 0.38,
        1.0,
        (tp.activated ? 1.35 : 0.8) * pulse,
        28
      );
    }

    for (let i = 0; i < state.chests.length; i++) {
      const ch = state.chests[i];
      if (ch.kind === 'cursed') {
        this.addLight(ch.pos.x, ch.pos.y - 12, 82, 0.95, 0.18, 0.52, ch.opened ? 0.4 : 1.25, 24);
      } else if (!ch.opened) {
        this.addLight(ch.pos.x, ch.pos.y - 10, 62, 1.0, 0.82, 0.32, 0.85, 22);
      }
    }

    for (let i = 0; i < state.pickups.length; i++) {
      const pk = state.pickups[i];
      if (pk.collected) continue;
      const px = pk.prevPos.x + (pk.pos.x - pk.prevPos.x) * interpAlpha;
      const py = pk.prevPos.y + (pk.pos.y - pk.prevPos.y) * interpAlpha;
      if (pk.kind === 'scroll' || pk.kind === 'dualScroll') {
        const ch = pk.scrollChoices?.[0];
        const r = ch === 'brutality' ? 1.0 : ch === 'tactics' ? 0.72 : ch === 'survival' ? 0.25 : 1.0;
        const g = ch === 'brutality' ? 0.28 : ch === 'tactics' ? 0.34 : ch === 'survival' ? 1.0 : 0.85;
        const b = ch === 'brutality' ? 0.32 : ch === 'tactics' ? 1.0 : ch === 'survival' ? 0.52 : 0.4;
        this.addLight(px, py - 8, 72, r, g, b, 1.15, 24);
      } else if (pk.kind === 'cell') {
        this.addLight(px, py - 4, 42, 0.28, 0.9, 1.0, 0.85, 18);
      }
    }

    for (let i = 0; i < state.enemies.length; i++) {
      const en = state.enemies[i];
      if (en.state === 'dead') continue;
      const ex = en.prevPos.x + (en.pos.x - en.prevPos.x) * interpAlpha;
      const ey = en.prevPos.y + (en.pos.y - en.prevPos.y) * interpAlpha;
      if (en.isBoss) {
        const isBehemoth = en.bossId === 'Behemoth';
        const isTK = en.bossId === 'TimeKeeper';
        const r = isBehemoth ? 1.0 : isTK ? 0.32 : 0.42;
        const g = isBehemoth ? 0.34 : isTK ? 0.96 : 0.82;
        const b = isBehemoth ? 0.16 : isTK ? 0.88 : 1.0;
        this.addLight(ex, ey - en.height * 0.5, en.bossAuraTicks > 0 ? 155 : 115, r, g, b, 1.5, 36);
      } else if (en.isElite) {
        this.addLight(ex, ey - en.height * 0.5, 68, 0.98, 0.72, 0.22, 1.0, 26);
      } else if (en.statusEffects.length > 0) {
        const st = en.statusEffects[0].kind;
        if (st === 'burn') this.addLight(ex, ey - 14, 58, 1.0, 0.48, 0.14, 1.0, 22);
        else if (st === 'poison') this.addLight(ex, ey - 14, 54, 0.45, 1.0, 0.22, 0.9, 22);
        else if (st === 'electrify') this.addLight(ex, ey - 14, 62, 0.42, 0.9, 1.0, 1.1, 22);
      }
    }

    for (let i = 0; i < state.projectiles.length; i++) {
      const pr = state.projectiles[i];
      const px = pr.prevPos.x + (pr.pos.x - pr.prevPos.x) * interpAlpha;
      const py = pr.prevPos.y + (pr.pos.y - pr.prevPos.y) * interpAlpha;
      parseHexToScratch(pr.color, 1.0, 0.75, 0.35);
      this.addLight(px, py, 54, hexScratch[0], hexScratch[1], hexScratch[2], 1.1, 20);
    }

    this.activeLights = this.curLightCount;
  }

  // ---------------------------------------------------------------------------
  // Pass 2: G-Buffer World Geometry, Props, Enemies, Bosses, Prisoner
  // ---------------------------------------------------------------------------

  private renderGBufferScene(
    state: SimState,
    theme: BiomeVisualTheme,
    interpAlpha: number,
    elapsedSec: number,
    camX: number,
    camY: number,
    heroX: number,
    heroY: number
  ): void {
    const grid = state.tileGrid;
    const tTheme = theme.tilesetTheme;
    const animFrame2 = Math.floor(elapsedSec * 4.0) & 1;
    const flameFrame3 = Math.floor(elapsedSec * 9.0) % 3;

    const useCustomWorld =
      this.settings.artPackMode === 'custom' && this.customPackStatus.available;
    const biomeAtlas = useCustomWorld ? this.getBiomeCustomAtlas(state.activeBiomeId) : null;
    const commonAtlas = useCustomWorld ? this.ensureCustomAtlasLoaded('common') : null;
    const bCache = biomeAtlas ? biomeAtlas.cache : null;
    const cCache = commonAtlas ? commonAtlas.cache : null;

    const minTx = Math.max(0, Math.floor(camX / TILE_SIZE) - 1);
    const maxTx = Math.min(grid.width - 1, Math.ceil((camX + VIEWPORT_W) / TILE_SIZE) + 1);
    const minTy = Math.max(0, Math.floor(camY / TILE_SIZE) - 1);
    const maxTy = Math.min(grid.height - 1, Math.ceil((camY + VIEWPORT_H) / TILE_SIZE) + 1);

    const regBgWall = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:bg_wall`);
    const regBgArch = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:bg_arch`);
    const regBgPillar = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:bg_pillar`);
    const regSolidTop = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:solid_top`);
    const regSolidMid = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:solid_mid`);
    const regSolidDeep = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:solid_deep`);
    const regSolidVar = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:solid_var`);
    const regOneWay = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:oneway`);
    const regCracked = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:cracked_floor`);
    const regSecret = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:secret_wall`);
    const regExitGate = resolveSpriteRegion(this.atlas.regions, `tile:${tTheme}:exit_gate`);
    const regLadder = resolveSpriteRegion(this.atlas.regions, 'tile:ladder');
    const regChain = resolveSpriteRegion(this.atlas.regions, 'tile:chain');
    const regSpikes = resolveSpriteRegion(this.atlas.regions, 'tile:spikes');
    const regAcid = resolveSpriteRegion(this.atlas.regions, `tile:acid_${animFrame2}`);
    const regWater = resolveSpriteRegion(this.atlas.regions, `tile:water_${animFrame2}`);

    // 1. Background Masonry, Pillars, Arches (negative normalStrength => recessed bg lighting!)
    const useCustomBg = Boolean(biomeAtlas && bCache && bCache.backWalls.length > 0);
    for (let ty = minTy; ty <= maxTy; ty++) {
      const sy = Math.round(ty * TILE_SIZE - camY);
      const rowOff = ty * grid.width;
      for (let tx = minTx; tx <= maxTx; tx++) {
        const bg = grid.bgTiles[rowOff + tx];
        if (bg === 0) continue;
        const sx = Math.round(tx * TILE_SIZE - camX);
        if (useCustomBg) {
          const bwList = bCache!.backWalls;
          const reg = bwList[tileHash(tx, ty) % bwList.length];
          this.pushCustomRegion(
            biomeAtlas!,
            reg,
            sx,
            sy,
            TILE_SIZE,
            TILE_SIZE,
            1,
            1,
            1,
            1,
            1,
            0,
            0,
            -1.0
          );
        } else {
          const modX = tx % 6;
          const reg =
            modX === 0 ? regBgPillar : modX === 3 && ty % 3 === 1 ? regBgArch : regBgWall;
          this.pushQuad(reg, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, -1.0);
        }
      }
    }

    // 2. Passage Workshop Backdrops (Collector Alcove & Blacksmith Foundry in Custom Pack Mode!)
    if (state.activeBiomeId === 'Passage' && commonAtlas && cCache) {
      for (let i = 0; i < state.shrines.length; i++) {
        const sh = state.shrines[i];
        const sx = sh.pos.x - camX;
        const sy = sh.pos.y - camY;
        if (sx < -160 || sx > VIEWPORT_W + 160 || sy < -160 || sy > VIEWPORT_H + 160) continue;
        if (sh.kind === 'collector' && cCache.collectorBack) {
          const reg = cCache.collectorBack;
          const dw = Math.round(reg.w * 0.36);
          const dh = Math.round(reg.h * 0.36);
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            0.04,
            -0.85
          );
        } else if (sh.kind === 'forge' && cCache.foundry) {
          const reg = cCache.foundry;
          const dw = Math.round(reg.w * 0.36);
          const dh = Math.round(reg.h * 0.36);
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            0.06,
            -0.85
          );
        }
      }
    }

    // 2B. Deterministic Architectural Room Dressings (Custom Pack Arches/Banners/WallJunk OR Enhanced Built-In Props!)
    if (biomeAtlas && bCache) {
      const archList = bCache.arches;
      const bannerList = bCache.banners;
      const wallJunkList = bCache.wallJunk;
      for (let i = 0; i < state.rooms.length; i++) {
        const rm = state.rooms[i];
        const rx0 = rm.tx * TILE_SIZE - camX;
        const rx1 = (rm.tx + rm.tw) * TILE_SIZE - camX;
        const ry0 = rm.ty * TILE_SIZE - camY;
        const ry1 = (rm.ty + rm.th) * TILE_SIZE - camY;
        if (rx1 < -96 || rx0 > VIEWPORT_W + 96 || ry1 < -96 || ry0 > VIEWPORT_H + 96) continue;

        const floorTy = rm.type === 'passage' ? rm.ty + rm.th - 2 : rm.ty + rm.th - 1;
        const floorScreenY = Math.round(floorTy * TILE_SIZE - camY);
        const roomInnerH = Math.max(48, (floorTy - rm.ty - 1) * TILE_SIZE);

        // Mounted gothic arches / pillars inside corridors & halls
        if (archList.length > 0 && rm.tw >= 10 && rm.type !== 'passage') {
          const count = rm.tw >= 18 ? 2 : 1;
          for (let k = 0; k < count; k++) {
            const frac = count === 1 ? 0.5 : k === 0 ? 0.28 : 0.72;
            const atx = rm.tx + Math.floor(rm.tw * frac);
            const h = tileHash(atx, rm.ty + k * 7);
            const reg = archList[h % archList.length];
            const scale = Math.min(0.88, (roomInnerH * 0.94) / Math.max(1, reg.h));
            const dw = Math.round(reg.w * scale);
            const dh = Math.round(reg.h * scale);
            const ax = Math.round(atx * TILE_SIZE - dw * 0.5 - camX);
            const ay = floorScreenY - dh;
            this.pushCustomRegion(biomeAtlas, reg, ax, ay, dw, dh, 1, 1, 1, 1, 1, 0, 0, -0.92);
          }
        }

        // Hanging Dead Cells banners
        if (rm.tw >= 8) {
          const h = tileHash(rm.tx + 3, rm.ty + 1);
          const btx = rm.tx + Math.floor(rm.tw * 0.35);
          const bty = rm.ty + 1;
          if (
            btx >= 0 &&
            bty >= 0 &&
            btx < grid.width &&
            bty < grid.height &&
            grid.bgTiles[bty * grid.width + btx] !== 0
          ) {
            if (bannerList.length > 0) {
              const reg = bannerList[h % bannerList.length];
              const targetW = reg.w > 48 ? 34 : reg.w;
              const scale = targetW / Math.max(1, reg.w);
              const dw = Math.round(reg.w * scale);
              const dh = Math.min(roomInnerH - 12, Math.round(reg.h * scale));
              const bx = Math.round(btx * TILE_SIZE - camX);
              const by = Math.round(bty * TILE_SIZE - camY);
              this.pushCustomRegion(biomeAtlas, reg, bx, by, dw, dh, 1, 1, 1, 1, 1, 0, 0, -0.88);
            } else if (commonAtlas && cCache?.flagMetaObject && (rm.id & 1) === 0) {
              const reg = cCache.flagMetaObject;
              const dw = 28;
              const dh = Math.min(roomInnerH - 14, Math.round(dw * (reg.h / reg.w)));
              const bx = Math.round(btx * TILE_SIZE - camX);
              const by = Math.round(bty * TILE_SIZE - camY);
              this.pushCustomRegion(commonAtlas, reg, bx, by, dw, dh, 1, 1, 1, 1, 1, 0, 0, -0.88);
            }
          }
        }

        // Deterministic interior wallJunk props mounted cleanly against backWalls
        if (wallJunkList.length > 0 && rm.tw >= 10) {
          const slots = rm.tw >= 16 ? 3 : 2;
          for (let s = 0; s < slots; s++) {
            const wtx = rm.tx + 3 + Math.floor(((rm.tw - 6) * (s + 0.5)) / slots);
            const wty = floorTy - 2 - (tileHash(wtx, rm.id + s) & 1);
            if (wtx < 1 || wty < 1 || wtx >= grid.width - 1 || wty >= grid.height - 1) continue;
            const idx = wty * grid.width + wtx;
            if (grid.bgTiles[idx] === 0 || grid.tiles[idx] !== TileKind.EMPTY) continue;
            const h = tileHash(wtx * 3 + s, wty);
            const reg = wallJunkList[h % wallJunkList.length];
            const scale = reg.w > 48 || reg.h > 48 ? 0.72 : 0.85;
            const dw = Math.round(reg.w * scale);
            const dh = Math.round(reg.h * scale);
            const wx = Math.round(wtx * TILE_SIZE + 12 - dw * 0.5 - camX);
            const wy = Math.round(wty * TILE_SIZE + 12 - dh * 0.5 - camY);
            const flip = (h & 1) === 0 ? 1 : -1;
            this.pushCustomRegion(biomeAtlas, reg, wx, wy, dw, dh, 1, 1, 1, 1, flip, 0, 0, -0.9);
          }
        }
      }
    } else {
      // Built-In Mode: lush gothic room dressings (banners, hanging cages, ornate pillars, lanterns, floor crates/barrels/skulls!)
      const regBanner = resolveSpriteRegion(this.atlas.regions, `prop:banner_${animFrame2}`);
      const regCage = resolveSpriteRegion(this.atlas.regions, 'prop:cage');
      const hasPillar = Boolean(this.atlas.regions['prop:pillar_ornate']);
      const hasLantern = Boolean(this.atlas.regions[`prop:lantern_${flameFrame3}`]);
      const hasChainHook = Boolean(this.atlas.regions['prop:chain_hook']);
      const hasCrate = Boolean(this.atlas.regions['prop:crate']);
      const hasBarrel = Boolean(this.atlas.regions['prop:barrel']);
      const hasSkullPile = Boolean(this.atlas.regions['prop:skull_pile']);

      for (let i = 0; i < state.rooms.length; i++) {
        const rm = state.rooms[i];
        const rx0 = rm.tx * TILE_SIZE - camX;
        const rx1 = (rm.tx + rm.tw) * TILE_SIZE - camX;
        const ry0 = rm.ty * TILE_SIZE - camY;
        const ry1 = (rm.ty + rm.th) * TILE_SIZE - camY;
        if (rx1 < -48 || rx0 > VIEWPORT_W + 48 || ry1 < -48 || ry0 > VIEWPORT_H + 48) continue;

        const floorTy = rm.type === 'passage' ? rm.ty + rm.th - 2 : rm.ty + rm.th - 1;
        const floorScreenY = Math.round(floorTy * TILE_SIZE - camY);

        if (rm.tw >= 8) {
          const bx = Math.round((rm.tx + Math.floor(rm.tw * 0.35)) * TILE_SIZE - camX);
          const by = Math.round((rm.ty + 1) * TILE_SIZE - camY);
          this.pushQuad(regBanner, bx, by, regBanner.w, regBanner.h, 1, 1, 1, 1, 1, 0, 0, -0.9);
        }
        if (rm.tw >= 12 && (rm.id & 1) === 0) {
          const cx = Math.round((rm.tx + Math.floor(rm.tw * 0.68)) * TILE_SIZE - camX);
          const cy = Math.round((rm.ty + 1) * TILE_SIZE - camY);
          this.pushQuad(regCage, cx, cy, regCage.w, regCage.h, 1, 1, 1, 1, 1, 0, 0, -0.85);
        }

        // Ornate architectural pillars framing room interiors
        if (hasPillar && rm.tw >= 12) {
          const pLeftX = Math.round((rm.tx + 2) * TILE_SIZE + 12 - camX);
          const pRightX = Math.round((rm.tx + rm.tw - 3) * TILE_SIZE + 12 - camX);
          this.drawSpriteKey('prop:pillar_ornate', pLeftX, floorScreenY, 1, 1, 1, 1, 1, 0, 0, -0.88);
          this.drawSpriteKey('prop:pillar_ornate', pRightX, floorScreenY, 1, 1, 1, 1, -1, 0, 0, -0.88);
        }

        // Hanging gothic lanterns or ceiling chains
        if (rm.tw >= 10) {
          const ltx = rm.tx + Math.floor(rm.tw * 0.52);
          const lx = Math.round(ltx * TILE_SIZE + 12 - camX);
          const ly = Math.round((rm.ty + 1) * TILE_SIZE - camY);
          if (hasLantern) {
            this.drawSpriteKey(
              `prop:lantern_${flameFrame3}`,
              lx,
              ly + 16,
              1,
              1,
              1,
              1,
              1,
              0,
              0.28,
              0.9
            );
          } else if (hasChainHook) {
            this.drawSpriteKey('prop:chain_hook', lx, ly + 18, 1, 1, 1, 1, 1, 0, 0, -0.85);
          } else if ((rm.id % 3) === 1 && rm.th >= 8) {
            this.pushQuad(regChain, lx - 12, ly, TILE_SIZE, TILE_SIZE, 0.82, 0.84, 0.9, 1, 1, 0, 0, -0.8);
          }
        }

        // Grounded floor clutter (crates, barrels, skull piles) standing cleanly on solid floor
        if (rm.tw >= 10 && rm.type !== 'bossArena' && rm.type !== 'passage') {
          const propSlots = rm.tw >= 16 ? 2 : 1;
          for (let s = 0; s < propSlots; s++) {
            const ptx = rm.tx + (s === 0 ? 3 : rm.tw - 4);
            if (ptx < 1 || ptx >= grid.width - 1 || floorTy < 2 || floorTy >= grid.height) continue;
            const belowKind = grid.tiles[floorTy * grid.width + ptx];
            const aboveKind = grid.tiles[(floorTy - 1) * grid.width + ptx];
            if (belowKind !== TileKind.SOLID || aboveKind !== TileKind.EMPTY) continue;
            const h = tileHash(ptx, floorTy + rm.id);
            const px = Math.round(ptx * TILE_SIZE + 12 - camX);
            let propKey: string | null = null;
            const pick = h % 3;
            if (pick === 0 && hasCrate) propKey = 'prop:crate';
            else if (pick === 1 && hasBarrel) propKey = 'prop:barrel';
            else if (pick === 2 && hasSkullPile) propKey = 'prop:skull_pile';
            else if (hasCrate) propKey = 'prop:crate';
            else if (hasBarrel) propKey = 'prop:barrel';
            else if (hasSkullPile) propKey = 'prop:skull_pile';
            else if (h % 5 === 0) propKey = 'prop:skeleton';
            if (propKey) {
              this.drawSpriteKey(
                propKey,
                px,
                floorScreenY,
                1,
                1,
                1,
                1,
                (h & 1) === 0 ? 1 : -1,
                0,
                0,
                0.92
              );
            }
          }
        }
      }
    }

    // 3. Physical Flickering Braziers & Wall Torches aligned with World Light Sources!
    for (let i = 0; i < state.lights.length; i++) {
      const l = state.lights[i];
      const sx = l.x - camX;
      const sy = l.y - camY;
      if (sx < -32 || sx > VIEWPORT_W + 32 || sy < -40 || sy > VIEWPORT_H + 40) continue;
      if (l.kind === 'brazier') {
        if (commonAtlas && cCache?.brasero) {
          const reg = cCache.brasero;
          const dw = Math.round(reg.w * 0.88);
          const dh = Math.round(reg.h * 0.88);
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy + 18 - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            0.12,
            1.0
          );
        } else {
          this.drawSpriteKey(`prop:brazier_${flameFrame3}`, sx, sy + 18, 1, 1, 1, 1, 1, 0, 0.10, 1.0);
        }
      } else if (l.kind === 'torch') {
        if (commonAtlas && cCache?.torch) {
          const reg = cCache.torch;
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - reg.w * 0.5),
            Math.round(sy + 10 - reg.h),
            reg.w,
            reg.h,
            1,
            1,
            1,
            1,
            1,
            0,
            0.12,
            1.0
          );
        } else {
          this.drawSpriteKey(`prop:torch_${flameFrame3}`, sx, sy + 8, 1, 1, 1, 1, 1, 0, 0.10, 1.0);
        }
      }
    }

    // 4. Foreground Auto-Tiled Solid Masonry, Ground/Ceiling Caps, FloorJunk, One-Ways, Ladders, Chains, Hazards
    const useCustomSolid = Boolean(biomeAtlas && bCache && bCache.floorStamps.length > 0);
    const hasCustomGround = Boolean(biomeAtlas && bCache && bCache.groundCaps.length > 0);
    const hasCustomCeiling = Boolean(biomeAtlas && bCache && bCache.ceilingCaps.length > 0);
    const hasCustomFloorJunk =
      state.activeBiomeId !== 'Passage' &&
      Boolean(biomeAtlas && bCache && bCache.floorJunk.length > 0);
    const hasCustomOneWay = Boolean(biomeAtlas && bCache && bCache.oneWays.length > 0);
    const hasCustomChain = Boolean(biomeAtlas && bCache && bCache.chains.length > 0);
    const hasCustomLadder = Boolean(commonAtlas && cCache?.ladder);
    const hasBuiltinMossCap =
      !useCustomSolid &&
      Boolean(this.atlas.regions['prop:moss_cap']) &&
      (state.activeBiomeId === 'PrisonStart' ||
        state.activeBiomeId === 'PrisonCourtyard' ||
        state.activeBiomeId === 'Sewer' ||
        state.activeBiomeId === 'StiltVillage' ||
        state.activeBiomeId === 'PrisonRoof');
    const regBuiltinMossCap = hasBuiltinMossCap ? this.atlas.regions['prop:moss_cap'] : null;

    for (let ty = minTy; ty <= maxTy; ty++) {
      const sy = Math.round(ty * TILE_SIZE - camY);
      const rowOff = ty * grid.width;
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = grid.tiles[rowOff + tx];
        if (tile === TileKind.EMPTY || tile === TileKind.BG_WALL) continue;
        const sx = Math.round(tx * TILE_SIZE - camX);

        if (tile === TileKind.SOLID) {
          const isSolid = (nx: number, ny: number): boolean => {
            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) return true;
            const k = grid.tiles[ny * grid.width + nx];
            return k === TileKind.SOLID || k === TileKind.SECRET_WALL || k === TileKind.CRACKED_FLOOR;
          };
          const sAbove = isSolid(tx, ty - 1);
          const sBelow = isSolid(tx, ty + 1);
          const sLeft = isSolid(tx - 1, ty);
          const sRight = isSolid(tx + 1, ty);
          const h = tileHash(tx, ty);

          if (useCustomSolid) {
            const fsList = bCache!.floorStamps;
            const stamp = fsList[h % fsList.length];
            if (sAbove && sBelow && sLeft && sRight) {
              // Deep dark silhouette bedrock inside buried interiors (stays in same GPU batch!)
              this.pushCustomRegion(
                biomeAtlas!,
                stamp,
                sx,
                sy,
                TILE_SIZE,
                TILE_SIZE,
                0.18,
                0.20,
                0.27,
                1,
                1,
                0,
                0,
                0.35
              );
            } else {
              // Exposed solid terrain: real Dead Cells floorStamp + real *_n.png normal map!
              this.pushCustomRegion(
                biomeAtlas!,
                stamp,
                sx,
                sy,
                TILE_SIZE,
                TILE_SIZE,
                1,
                1,
                1,
                1,
                1,
                0,
                0,
                1.0
              );
              if (!sAbove && hasCustomGround) {
                const gcList = bCache!.groundCaps;
                const cap = gcList[h % gcList.length];
                this.pushCustomRegion(
                  biomeAtlas!,
                  cap,
                  sx,
                  sy,
                  TILE_SIZE,
                  Math.min(6, cap.h),
                  1,
                  1,
                  1,
                  1,
                  1,
                  0,
                  0,
                  1.0
                );
              }
              if (!sBelow && hasCustomCeiling) {
                const ccList = bCache!.ceilingCaps;
                const cap = ccList[h % ccList.length];
                const ch = Math.min(6, cap.h);
                this.pushCustomRegion(
                  biomeAtlas!,
                  cap,
                  sx,
                  sy + TILE_SIZE - ch,
                  TILE_SIZE,
                  ch,
                  1,
                  1,
                  1,
                  1,
                  1,
                  0,
                  0,
                  1.0
                );
              }
              // Deterministic Dead Cells floorJunk props (skulls, rubble, crates, mushrooms) standing cleanly on exposed floors!
              if (
                !sAbove &&
                hasCustomFloorJunk &&
                ty > 0 &&
                grid.tiles[(ty - 1) * grid.width + tx] === TileKind.EMPTY &&
                (tx & 1) === 0 &&
                h % 7 === 0
              ) {
                const fjList = bCache!.floorJunk;
                const junk = fjList[(h >>> 4) % fjList.length];
                const scale = junk.w > 42 || junk.h > 42 ? 0.65 : 0.78;
                const jw = Math.round(junk.w * scale);
                const jh = Math.min(40, Math.round(junk.h * scale));
                const jx = Math.round(sx + TILE_SIZE * 0.5 - jw * 0.5);
                const jy = sy - jh;
                this.pushCustomRegion(
                  biomeAtlas!,
                  junk,
                  jx,
                  jy,
                  jw,
                  jh,
                  1,
                  1,
                  1,
                  1,
                  (h & 2) === 0 ? 1 : -1,
                  0,
                  0,
                  0.92
                );
              }
            }
          } else {
            let reg = regSolidDeep;
            if (!sAbove) {
              reg = regSolidTop;
            } else if (!sBelow || !sLeft || !sRight) {
              reg = h % 4 === 0 ? regSolidVar : regSolidMid;
            } else {
              reg = regSolidDeep;
            }
            this.pushQuad(reg, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, 1.0);
            if (regBuiltinMossCap && !sAbove && h % 3 === 0) {
              this.pushQuad(
                regBuiltinMossCap,
                sx,
                sy,
                TILE_SIZE,
                Math.min(10, regBuiltinMossCap.h),
                1,
                1,
                1,
                1,
                (h & 1) === 0 ? 1 : -1,
                0,
                0,
                1.0
              );
            } else if (regBuiltinMossCap && !sBelow && h % 5 === 0) {
              const mh = Math.min(8, regBuiltinMossCap.h);
              this.pushQuad(
                regBuiltinMossCap,
                sx,
                sy + TILE_SIZE - mh,
                TILE_SIZE,
                mh,
                0.85,
                0.92,
                0.88,
                1,
                (h & 1) === 0 ? 1 : -1,
                0,
                0,
                0.85
              );
            }
          }
        } else if (tile === TileKind.ONE_WAY) {
          if (hasCustomOneWay) {
            const ow = bCache!.oneWays[0];
            if (ow.w > 48) {
              const seg = tx % 6;
              this.pushCustomRegionSliceX(
                biomeAtlas!,
                ow,
                seg / 6,
                (seg + 1) / 6,
                sx,
                sy,
                TILE_SIZE,
                14,
                1.0
              );
            } else {
              this.pushCustomRegion(
                biomeAtlas!,
                ow,
                sx,
                sy,
                TILE_SIZE,
                Math.min(24, ow.h),
                1,
                1,
                1,
                1,
                1,
                0,
                0,
                1.0
              );
            }
          } else {
            this.pushQuad(regOneWay, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, 1.0);
          }
        } else if (tile === TileKind.LADDER) {
          if (hasCustomLadder) {
            const ld = cCache!.ladder!;
            const lw = Math.min(TILE_SIZE, ld.w);
            this.pushCustomRegion(
              commonAtlas!,
              ld,
              Math.round(sx + (TILE_SIZE - lw) * 0.5),
              sy,
              lw,
              TILE_SIZE,
              1,
              1,
              1,
              1,
              1,
              0,
              0,
              0.9
            );
          } else {
            this.pushQuad(regLadder, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, 0.9);
          }
        } else if (tile === TileKind.CHAIN) {
          if (hasCustomChain) {
            const ch = bCache!.chains[0];
            const cw = Math.min(TILE_SIZE, ch.w);
            this.pushCustomRegion(
              biomeAtlas!,
              ch,
              Math.round(sx + (TILE_SIZE - cw) * 0.5),
              sy,
              cw,
              TILE_SIZE,
              1,
              1,
              1,
              1,
              1,
              0,
              0,
              0.9
            );
          } else {
            this.pushQuad(regChain, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, 0.9);
          }
        } else if (tile === TileKind.SPIKES) {
          this.pushQuad(regSpikes, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0, 1.0);
        } else if (tile === TileKind.CRACKED_FLOOR) {
          if (useCustomSolid) {
            const stamp = bCache!.floorStamps[tileHash(tx, ty) % bCache!.floorStamps.length];
            this.pushCustomRegion(
              biomeAtlas!,
              stamp,
              sx,
              sy,
              TILE_SIZE,
              TILE_SIZE,
              0.88,
              0.94,
              1.1,
              1,
              1,
              0.08,
              0.16,
              1.0
            );
          } else {
            this.pushQuad(regCracked, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0.1, 1.0);
          }
        } else if (tile === TileKind.SECRET_WALL) {
          if (useCustomSolid) {
            const stamp = bCache!.floorStamps[tileHash(tx, ty) % bCache!.floorStamps.length];
            this.pushCustomRegion(
              biomeAtlas!,
              stamp,
              sx,
              sy,
              TILE_SIZE,
              TILE_SIZE,
              0.94,
              0.96,
              1.08,
              1,
              1,
              0.05,
              0.12,
              1.0
            );
          } else {
            this.pushQuad(regSecret, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0.08, 1.0);
          }
        } else if (tile === TileKind.EXIT_GATE) {
          if (!useCustomBg) {
            this.pushQuad(regExitGate, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0.1, 0.9);
          }
        } else if (tile === TileKind.ACID) {
          this.pushQuad(regAcid, sx, sy, TILE_SIZE, TILE_SIZE, 1, 1, 1, 1, 1, 0, 0.45, 0.6);
        } else if (tile === TileKind.WATER) {
          this.pushQuad(
            regWater,
            sx,
            sy,
            TILE_SIZE,
            TILE_SIZE,
            theme.waterRgb[0] * 1.1 + 0.25,
            theme.waterRgb[1] * 1.1 + 0.25,
            theme.waterRgb[2] * 1.1 + 0.25,
            1,
            1,
            0,
            0.12,
            0.5
          );
        }
      }
    }

    // 5. Doors, Teleporters, Chests, Shrines & Passage NPCs (all grounded cleanly to floor!)
    const isPassage = state.activeBiomeId === 'Passage';
    for (let i = 0; i < state.doors.length; i++) {
      const d = state.doors[i];
      if (d.broken) continue;
      const sx = d.pos.x - camX;
      // Passage doors store pos.y directly on floorY; regular biome doors store center pos.y
      const sy = (isPassage ? d.pos.y : d.pos.y + d.height * 0.5) - camY;
      if (sx < -96 || sx > VIEWPORT_W + 96 || sy < -96 || sy > VIEWPORT_H + 96) continue;

      if (useCustomWorld) {
        if ((d.kind === 'biomeExit' || d.kind === 'bossGate') && biomeAtlas && bCache && bCache.exitDoors.length > 0) {
          const reg = bCache.exitDoors[0];
          const targetW = d.kind === 'bossGate' ? 84 : 90;
          const targetH = Math.min(92, Math.round(targetW * (reg.h / Math.max(1, reg.w))));
          this.pushCustomRegion(
            biomeAtlas,
            reg,
            Math.round(sx - targetW * 0.5),
            Math.round(sy - targetH),
            targetW,
            targetH,
            1,
            1,
            1,
            1,
            1,
            0,
            d.kind === 'biomeExit' ? 0.12 : 0.04,
            1.0
          );
          continue;
        } else if (d.kind === 'bossGate' && commonAtlas && cCache?.prisonBossDoor) {
          const reg = cCache.prisonBossDoor;
          const dw = 54;
          const dh = Math.round(dw * (reg.h / Math.max(1, reg.w)));
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            0.06,
            1.0
          );
          continue;
        } else if (d.kind === 'timed' && commonAtlas && (cCache?.goldDoor || cCache?.timeDoor)) {
          const reg = cCache.goldDoor ?? cCache.timeDoor!;
          const dw = 46;
          const dh = Math.round(dw * (reg.h / Math.max(1, reg.w)));
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            d.opened ? 0.12 : 0.02,
            1.0
          );
          continue;
        } else if (d.kind === 'killStreak' && commonAtlas && (cCache?.collectorDoor || cCache?.goldDoor)) {
          const reg = cCache.collectorDoor ?? cCache.goldDoor!;
          const dw = 46;
          const dh = Math.round(dw * (reg.h / Math.max(1, reg.w)));
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - dw * 0.5),
            Math.round(sy - dh),
            dw,
            dh,
            1,
            1,
            1,
            1,
            1,
            0,
            d.opened ? 0.12 : 0.02,
            1.0
          );
          continue;
        } else if (d.kind === 'wood' && commonAtlas && cCache?.woodDoorMeta) {
          if (d.opened && cCache.normalDoorSide) {
            const reg = cCache.normalDoorSide;
            const dw = 6;
            const dh = 48;
            this.pushCustomRegion(
              commonAtlas,
              reg,
              Math.round(sx - dw * 0.5),
              Math.round(sy - dh),
              dw,
              dh,
              0.85,
              0.85,
              0.9,
              1,
              1,
              0,
              0,
              0.9
            );
          } else {
            const reg = cCache.woodDoorMeta;
            const dw = 50;
            const dh = Math.round(dw * (reg.h / Math.max(1, reg.w)));
            this.pushCustomRegion(
              commonAtlas,
              reg,
              Math.round(sx - dw * 0.5),
              Math.round(sy - dh),
              dw,
              dh,
              d.opened ? 0.65 : 1,
              d.opened ? 0.65 : 1,
              d.opened ? 0.72 : 1,
              1,
              1,
              0,
              0,
              1.0
            );
          }
          continue;
        }
      }

      let key = 'prop:door_wood';
      if (d.kind === 'biomeExit') key = 'prop:door_exit';
      else if (d.kind === 'bossGate') key = 'prop:door_boss';
      else if (d.kind === 'timed' || d.kind === 'killStreak') key = 'prop:door_gold';
      else if (d.opened) key = 'prop:door_wood_open';
      this.drawSpriteKey(key, sx, sy, 1, 1, 1, 1, 1, 0, d.kind === 'biomeExit' ? 0.14 : 0, 1.0);
    }

    for (let i = 0; i < state.teleporters.length; i++) {
      const tp = state.teleporters[i];
      const sx = tp.pos.x - camX;
      const sy = tp.pos.y + 12 - camY;
      if (sx < -64 || sx > VIEWPORT_W + 64 || sy < -64 || sy > VIEWPORT_H + 64) continue;
      if (commonAtlas && cCache?.teleportAltar) {
        const reg = cCache.teleportAltar;
        const dw = 58;
        const dh = Math.round(dw * (reg.h / Math.max(1, reg.w)));
        this.pushCustomRegion(
          commonAtlas,
          reg,
          Math.round(sx - dw * 0.5),
          Math.round(sy - dh),
          dw,
          dh,
          tp.activated ? 0.88 : 0.78,
          tp.activated ? 1.05 : 0.82,
          tp.activated ? 1.15 : 0.92,
          1,
          1,
          0,
          tp.activated ? 0.18 : 0.05,
          1.0
        );
        continue;
      }
      this.drawSpriteKey(
        tp.activated ? 'prop:teleporter_active' : 'prop:teleporter_idle',
        sx,
        sy,
        1,
        1,
        1,
        1,
        1,
        0,
        tp.activated ? 0.16 : 0.05,
        1.0
      );
    }

    for (let i = 0; i < state.chests.length; i++) {
      const ch = state.chests[i];
      const sx = ch.pos.x - camX;
      const sy = ch.pos.y + 12 - camY;
      if (sx < -48 || sx > VIEWPORT_W + 48 || sy < -48 || sy > VIEWPORT_H + 48) continue;
      if (commonAtlas && cCache) {
        const isSpecial = ch.kind === 'cursed' || ch.kind === 'boss';
        const reg = isSpecial
          ? ch.opened
            ? cCache.chestTwOpen
            : cCache.chestTwClosed
          : ch.opened
          ? cCache.chestBasicOpen
          : cCache.chestBasicClosed;
        if (reg) {
          const targetW = ch.opened ? 48 : 44;
          const targetH = Math.round(targetW * (reg.h / Math.max(1, reg.w)));
          this.pushCustomRegion(
            commonAtlas,
            reg,
            Math.round(sx - targetW * 0.5),
            Math.round(sy - targetH),
            targetW,
            targetH,
            ch.kind === 'cursed' ? 1.05 : 1,
            ch.kind === 'cursed' ? 0.85 : 1,
            ch.kind === 'cursed' ? 1.15 : 1,
            1,
            1,
            0,
            ch.kind === 'cursed' && !ch.opened ? 0.14 : 0.02,
            1.0
          );
          continue;
        }
      }
      const key =
        ch.kind === 'cursed'
          ? ch.opened
            ? 'prop:chest_cursed_open'
            : 'prop:chest_cursed_closed'
          : ch.kind === 'boss'
          ? ch.opened
            ? 'prop:chest_boss_open'
            : 'prop:chest_boss_closed'
          : ch.opened
          ? 'prop:chest_open'
          : 'prop:chest_closed';
      this.drawSpriteKey(key, sx, sy, 1, 1, 1, 1, 1, 0, ch.kind === 'cursed' ? 0.12 : 0, 1.0);
    }

    for (let i = 0; i < state.shrines.length; i++) {
      const sh = state.shrines[i];
      const sx = sh.pos.x - camX;
      const sy = sh.pos.y - camY;
      if (sx < -52 || sx > VIEWPORT_W + 52 || sy < -64 || sy > VIEWPORT_H + 64) continue;
      if (sh.kind === 'collector') {
        const ok = this.tryDrawCustomPackSprite('collector', ['npcCollectorIdle', 'npcCollectorIdlePotion'], Math.floor(elapsedSec * 10), sx, sy, -1, 0, 0.72);
        if (ok) continue;
      } else if (sh.kind === 'forge') {
        const ok = this.tryDrawCustomPackSprite('blacksmith', ['npcBlacksmithIdle'], Math.floor(elapsedSec * 10), sx, sy, -1, 0, 0.72);
        if (ok) continue;
      }
      let key = 'prop:scroll_altar';
      if (sh.kind === 'fountain') key = sh.used ? 'prop:fountain_empty' : 'prop:fountain_full';
      else if (sh.kind === 'collector') key = 'prop:npc_collector';
      else if (sh.kind === 'guillain') key = 'prop:npc_guillain';
      else if (sh.kind === 'forge') key = 'prop:npc_forge';
      else if (sh.kind === 'challengeRift') key = 'prop:challenge_rift';
      else if (sh.kind === 'loreSkeleton') key = 'prop:skeleton';
      this.drawSpriteKey(key, sx, sy, 1, 1, 1, 1, 1, 0, 0.06, 1.0);
    }

    // 6. Turrets & Deployables
    for (let i = 0; i < state.turrets.length; i++) {
      const tu = state.turrets[i];
      const sx = tu.pos.x - camX;
      const sy = tu.pos.y - camY;
      if (sx < -36 || sx > VIEWPORT_W + 36 || sy < -48 || sy > VIEWPORT_H + 48) continue;
      const key =
        tu.kind === 'heavy'
          ? 'turret:heavy'
          : tu.kind === 'wolfTrap'
          ? 'turret:wolfTrap'
          : tu.kind === 'bossBanner'
          ? 'turret:bossBanner'
          : 'turret:sinew';
      this.drawSpriteKey(key, sx, sy, 1, 1, 1, 1, tu.facing, 0, tu.kind === 'bossBanner' ? 0.25 : 0.06, 1.0);
    }

    // 7. Pickups (Smooth interpolation + gentle vertical bobbing + color-coded scroll glow)
    for (let i = 0; i < state.pickups.length; i++) {
      const pk = state.pickups[i];
      if (pk.collected) continue;
      const px = pk.prevPos.x + (pk.pos.x - pk.prevPos.x) * interpAlpha - camX;
      const py = pk.prevPos.y + (pk.pos.y - pk.prevPos.y) * interpAlpha - camY;
      if (px < -24 || px > VIEWPORT_W + 24 || py < -24 || py > VIEWPORT_H + 24) continue;
      const bob = Math.sin(elapsedSec * 4.5 + pk.bobPhase) * 2.2;
      let key = 'pickup:gold';
      if (pk.kind === 'cell') key = 'pickup:cell';
      else if (pk.kind === 'food') key = 'pickup:food';
      else if (pk.kind === 'flaskRefill') key = 'pickup:flask';
      else if (pk.kind === 'blueprint') key = 'pickup:blueprint';
      else if (pk.kind === 'dualScroll') key = 'pickup:scroll_dual';
      else if (pk.kind === 'scroll') {
        const st = pk.scrollChoices?.[0];
        key =
          st === 'tactics'
            ? 'pickup:scroll_tactics'
            : st === 'survival'
            ? 'pickup:scroll_survival'
            : 'pickup:scroll_brutality';
      } else if (pk.kind === 'gear') {
        const defId = pk.gear?.defId ?? '';
        key =
          pk.gear?.slotKind === 'skill'
            ? 'pickup:gear_skill'
            : defId.includes('Shield')
            ? 'pickup:gear_shield'
            : defId.includes('Bow')
            ? 'pickup:gear_bow'
            : 'pickup:gear_sword';
      }
      this.drawSpriteKey(key, px, py + 2 + bob, 1, 1, 1, 1, 1, 0, 0.18, 0.9);
    }

    // 8. Enemies & All 3 Multi-Phase Bosses (planted cleanly on feet = pos.y + height * 0.5!)
    for (let i = 0; i < state.enemies.length; i++) {
      const en = state.enemies[i];
      if (en.state === 'dead') continue;
      const ex = en.prevPos.x + (en.pos.x - en.prevPos.x) * interpAlpha - camX;
      const ey = en.prevPos.y + (en.pos.y - en.prevPos.y) * interpAlpha + en.height * 0.5 - camY;
      if (ex < -96 || ex > VIEWPORT_W + 96 || ey < -96 || ey > VIEWPORT_H + 96) continue;

      this.drawEnemyOrBoss(en, ex, ey, elapsedSec);
    }

    // 9. Prisoner (Hero) + Glowing Animated Homunculus Plasma Flame Head (heroY is feet!)
    this.drawHero(state.player, heroX - camX, heroY - camY, elapsedSec);
  }

  private drawEnemyOrBoss(en: EnemyState, sx: number, sy: number, elapsedSec: number): void {
    const isAttackPose =
      en.state === 'attack' || en.state === 'windup' || Math.floor(elapsedSec * 5 + en.uid) % 2 === 1;
    const frame = isAttackPose ? 1 : 0;
    const flash = en.hitFlashTicks > 0 ? Math.min(1, en.hitFlashTicks / 5) : 0;

    // Status visual tinting (Freeze cyan, Poison green, Burn orange, Bleed crimson, Elite gold)
    let r = 1.0;
    let g = 1.0;
    let b = 1.0;
    let emBoost = 0.0;

    if (en.isElite) {
      const pulse = 0.14 * (0.5 + 0.5 * Math.sin(elapsedSec * 8 + en.uid));
      r = 1.05;
      g = 0.92 + pulse;
      b = 0.72;
      emBoost = 0.10 + pulse;
    }

    for (let s = 0; s < en.statusEffects.length; s++) {
      const kind = en.statusEffects[s].kind;
      if (kind === 'freeze' || kind === 'frost') {
        r = 0.62; g = 0.92; b = 1.15; emBoost = Math.max(emBoost, 0.16);
      } else if (kind === 'poison') {
        r = 0.72; g = 1.1; b = 0.62;
      } else if (kind === 'burn') {
        r = 1.18; g = 0.72; b = 0.45; emBoost = Math.max(emBoost, 0.18);
      } else if (kind === 'stun') {
        r = 1.05; g = 0.95; b = 0.68;
      }
    }

    if (en.isBoss && en.bossId) {
      const isAtk = en.state === 'attack' || en.state === 'windup';
      const customAtlas =
        en.bossId === 'Behemoth'
          ? 'behemoth'
          : en.bossId === 'TimeKeeper'
          ? 'timeKeeper'
          : 'HotK';
      const anims =
        en.bossId === 'Behemoth'
          ? isAtk
            ? ['behemothAtkA', 'behemothAtkB', 'behemothWalkA']
            : Math.abs(en.vel.x) > 8
            ? ['behemothWalkA', 'walk', 'behemothWalkIdleA']
            : ['behemothWalkIdleA', 'behemothWalkA', 'walk']
          : en.bossId === 'TimeKeeper'
          ? isAtk
            ? ['atkA', 'dash', 'cast']
            : Math.abs(en.vel.x) > 10
            ? ['dash', 'idle']
            : ['idle', 'atkA']
          : isAtk
          ? ['atkA', 'atkB', 'atkC', 'castBomb']
          : ['atkAIdle', 'atkCIdle', 'atkA'];

      const drawnCustom = this.tryDrawCustomPackSprite(
        customAtlas,
        anims,
        Math.floor(elapsedSec * 12),
        sx,
        sy,
        en.facing,
        flash,
        en.bossId === 'KingsHand' ? 0.64 : en.bossId === 'Behemoth' ? 0.66 : 0.72
      );
      if (!drawnCustom) {
        const key = `boss:${en.bossId}_${frame}`;
        const phasePulse = en.bossPhase >= 2 ? 0.08 : 0;
        this.drawSpriteKey(key, sx, sy, r, g, b, 1, en.facing, flash, emBoost + phasePulse, 1.0);
      }
      return;
    }

    // Owned Custom Pack enemy atlases (with seamless per-key fallback to Built-In Krunked Art!)
    const cAtlas = ENEMY_CUSTOM_ATLAS[en.defId];
    if (cAtlas) {
      const isAtk = en.state === 'attack' || en.state === 'windup';
      const isMoving = Math.abs(en.vel.x) > 8;
      const anims =
        cAtlas === 'knight'
          ? ['npcKnightTrainingRoom', 'npcKnightIdle']
          : isAtk
          ? ['atkA', 'atk', 'shoot', 'cast', 'bash', 'idle']
          : isMoving
          ? ['run', 'walk', 'idle']
          : ['idle', 'walk', 'run'];
      if (
        this.tryDrawCustomPackSprite(
          cAtlas,
          anims,
          Math.floor(elapsedSec * 12 + en.uid),
          sx,
          sy,
          en.facing,
          flash,
          en.isElite ? 0.74 : 0.66
        )
      ) {
        return;
      }
    }

    const key = `enemy:${en.defId}_${frame}`;
    const scale = en.isElite ? 1.12 : 1.0;
    this.drawSpriteKey(key, sx, sy, r, g, b, 1, en.facing, flash, emBoost, 1.0, scale);
  }

  private drawHero(p: PlayerState, sx: number, sy: number, elapsedSec: number): void {
    const flash = p.hitFlashTicks > 0 ? Math.min(1, p.hitFlashTicks / 5) : 0;
    const iframeBlink = p.iframeTicks > 0 && (Math.floor(elapsedSec * 28) & 1) === 1;
    const hr = iframeBlink ? 0.78 : 1.0;
    const hg = iframeBlink ? 0.96 : 1.0;
    const hb = iframeBlink ? 1.15 : 1.0;

    let animKey = 'hero:idle_0';
    let customAnims: string[] = ['idle'];
    let frame = Math.floor(elapsedSec * 12) % 46;

    switch (p.actionState) {
      case 'run':
        animKey = `hero:run_${Math.floor(elapsedSec * 14) % 6}`;
        customAnims = ['run', 'walk'];
        frame = Math.floor(elapsedSec * 18);
        break;
      case 'jump':
        animKey = 'hero:jump';
        customAnims = ['jumpUp', 'jumpTransition'];
        frame = Math.floor(elapsedSec * 14);
        break;
      case 'fall':
        animKey = 'hero:fall';
        customAnims = ['jumpDown', 'jumpTransition'];
        frame = Math.floor(elapsedSec * 14);
        break;
      case 'wallSlide':
      case 'mantle':
        animKey = 'hero:wall_slide';
        customAnims = ['wallRun', 'wallIdle', 'climbA'];
        frame = Math.floor(elapsedSec * 14);
        break;
      case 'roll':
        animKey = `hero:roll_${Math.floor(elapsedSec * 18) % 3}`;
        customAnims = ['rolling', 'rollStart', 'rollEnd'];
        frame = Math.floor(elapsedSec * 24);
        break;
      case 'diveSlam':
        animKey = 'hero:dive_slam';
        customAnims = ['jumpDown', 'rolling'];
        frame = Math.floor(elapsedSec * 18);
        break;
      case 'attack': {
        const step = p.comboStep % 3;
        animKey = `hero:attack_${step}`;
        customAnims = step === 0 ? ['atkA', 'atkB'] : step === 1 ? ['atkB', 'atkA'] : ['atkC', 'atkA'];
        frame = Math.floor(elapsedSec * 22);
        break;
      }
      case 'parry':
      case 'parrySuccess':
        animKey = 'hero:parry';
        customAnims = ['idleFight', 'atkB', 'idle'];
        frame = Math.floor(elapsedSec * 16);
        break;
      case 'heal':
        animKey = 'hero:heal';
        customAnims = ['drink', 'idle'];
        frame = Math.floor(elapsedSec * 16);
        break;
      case 'hurt':
        animKey = 'hero:hurt';
        customAnims = ['idleInjured', 'idle'];
        frame = Math.floor(elapsedSec * 14);
        break;
      case 'dead':
        animKey = 'hero:dead';
        customAnims = ['idleKnee', 'idleInjured'];
        frame = Math.floor(elapsedSec * 10);
        break;
      default:
        animKey = `hero:idle_${Math.floor(elapsedSec * 5) % 4}`;
        customAnims = ['idle', 'idleFight'];
        frame = Math.floor(elapsedSec * 14);
        break;
    }

    const drawnCustom = this.tryDrawCustomPackSprite('beheaded', customAnims, frame, sx, sy, p.facing, flash, 0.76);
    let headOx = p.facing * 2;
    let headOy = p.actionState === 'roll' ? -14 : p.actionState === 'dead' ? -6 : -25;

    if (drawnCustom) {
      headOx = this.customHeadOx;
      headOy = this.customHeadOy;
    } else {
      this.drawSpriteKey(animKey, sx, sy, hr, hg, hb, 1, p.facing, flash, iframeBlink ? 0.15 : 0, 1.0);
    }

    // Layered Glowing Cyan-Amber Homunculus Plasma Head (crisp Dead Cells silhouette!)
    if (p.actionState !== 'dead') {
      const flameFrame = Math.floor(elapsedSec * 14) % 4;
      const bob = Math.sin(elapsedSec * 12) * 0.9;
      this.drawSpriteKey(
        `hero:head_flame_${flameFrame}`,
        sx + headOx,
        sy + headOy + bob,
        1,
        1,
        1,
        1,
        p.facing,
        flash * 0.3,
        0.35,
        0.4
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 3.5: Translucent & Emissive FX Overlay (Slashes, Telegraphs, Auras,
  //           Projectiles, Hazards, Scarf, SimParticles, Weather, Popups)
  // ---------------------------------------------------------------------------

  private renderVfxOverlay(
    state: SimState,
    theme: BiomeVisualTheme,
    interpAlpha: number,
    elapsedSec: number,
    camX: number,
    camY: number,
    heroX: number,
    heroY: number
  ): void {
    // 0. Animated Emissive Flames atop Custom Pack Braziers & Wall Torches!
    const useCustomWorld =
      this.settings.artPackMode === 'custom' && this.customPackStatus.available;
    const commonAtlas = useCustomWorld ? this.customGpuAtlases.get('common') ?? null : null;
    if (commonAtlas && (commonAtlas.cache.brasero || commonAtlas.cache.torch)) {
      for (let i = 0; i < state.lights.length; i++) {
        const l = state.lights[i];
        if (l.kind !== 'brazier' && l.kind !== 'torch') continue;
        const sx = l.x - camX;
        const sy = l.y - camY;
        if (sx < -32 || sx > VIEWPORT_W + 32 || sy < -40 || sy > VIEWPORT_H + 40) continue;
        const flick = 0.84 + 0.16 * Math.sin(elapsedSec * 17.0 + l.id * 2.3);
        const sway = Math.sin(elapsedSec * 11.5 + l.id * 1.7) * 1.3;
        const fy = l.kind === 'brazier' ? sy - 12 : sy - 10;
        const baseSz = l.kind === 'brazier' ? 14 : 9;
        // Warm outer fire halo
        this.emitVfxQuadBound(
          'vfx:ember',
          sx + sway * 0.6,
          fy,
          baseSz * 1.35 * flick,
          baseSz * 1.65 * flick,
          l.color[0] * 0.5 + 0.5,
          l.color[1] * 0.5 + 0.25,
          l.color[2] * 0.4 + 0.08,
          0.72,
          1,
          0.1,
          1.35
        );
        // Bright dancing flame core
        this.emitVfxQuadBound(
          'vfx:spark',
          sx + sway,
          fy - 2,
          baseSz * 0.85 * flick,
          baseSz * 1.15 * flick,
          1.0,
          0.92,
          0.48,
          0.92,
          1,
          0.45,
          1.45
        );
      }
    }

    // 1. Roll Ghost Afterimage, Parry Golden Glow, Shield Block Arc, CorruptedPower Aura & Shield Dome
    const p = state.player;
    const hsx = heroX - camX;
    const hsy = heroY - camY;
    if (p.actionState === 'roll' || p.speedBuffTicks > 0) {
      const ghostX = heroX - p.vel.x * 0.035 - camX;
      const ghostY = heroY - p.vel.y * 0.02 - camY;
      this.drawSpriteKey(
        p.actionState === 'roll' ? 'hero:roll_1' : 'hero:run_2',
        ghostX,
        ghostY,
        0.35,
        0.92,
        1.0,
        0.34,
        p.facing,
        0,
        0.85,
        1.0
      );
    }

    // Active status visual overlays: CorruptedPower pulsing crimson-violet aura & Shield emerald-cyan dome
    for (let s = 0; s < p.statusEffects.length; s++) {
      const sk = p.statusEffects[s].kind;
      if (sk === 'corrupted') {
        const pulse = 1.0 + Math.sin(elapsedSec * 16.0) * 0.09;
        this.emitVfxQuadBound(
          'vfx:aura_ring',
          hsx,
          hsy - 16,
          50 * pulse,
          50 * pulse,
          0.86,
          0.22,
          1.0,
          0.76,
          1,
          0.15,
          1.4,
          elapsedSec * 4.4
        );
        this.emitVfxQuadBound(
          'vfx:aura_ring',
          hsx,
          hsy - 16,
          36 * (2.0 - pulse),
          36 * (2.0 - pulse),
          1.0,
          0.24,
          0.38,
          0.62,
          1,
          0.1,
          1.3,
          -elapsedSec * 6.2
        );
      } else if (sk === 'shield') {
        const pulse = 1.0 + Math.sin(elapsedSec * 10.0) * 0.05;
        this.emitVfxQuadBound(
          'vfx:shield_dome',
          hsx,
          hsy - 15,
          42 * pulse,
          44 * pulse,
          0.24,
          1.0,
          0.76,
          0.64,
          1,
          0.12,
          1.22
        );
        this.emitVfxQuadBound(
          'vfx:parry_ring',
          hsx,
          hsy - 15,
          36 * pulse,
          38 * pulse,
          0.58,
          1.0,
          0.92,
          0.42,
          1,
          0.2,
          1.3
        );
      }
    }

    // Unmistakable bright-gold active parry window glow!
    if (p.parryWindowTicks > 0) {
      const pop = 1.0 + Math.sin(elapsedSec * 36.0) * 0.08;
      this.emitVfxQuadBound(
        'vfx:parry_ring',
        hsx + p.facing * 8,
        hsy - 15,
        40 * pop,
        40 * pop,
        1.0,
        0.94,
        0.40,
        0.92,
        1,
        0.45,
        1.5
      );
      this.emitVfxQuadBound(
        'vfx:shield_dome',
        hsx + p.facing * 10,
        hsy - 15,
        28 * pop,
        36 * pop,
        1.0,
        0.92,
        0.38,
        0.86,
        p.facing,
        0.35,
        1.45
      );
    } else if (p.shieldBlocking) {
      // Crisp raised blue-gold directional guard arc in front of the Prisoner!
      const pulse = 1.0 + Math.sin(elapsedSec * 14.0) * 0.04;
      this.emitVfxQuadBound(
        'vfx:shield_dome',
        hsx + p.facing * 12,
        hsy - 15,
        15 * pulse,
        32 * pulse,
        0.36,
        0.82,
        1.0,
        0.78,
        p.facing,
        0.15,
        1.25
      );
      this.emitVfxQuadBound(
        'vfx:shield_dome',
        hsx + p.facing * 14,
        hsy - 15,
        9 * pulse,
        26 * pulse,
        1.0,
        0.88,
        0.36,
        0.82,
        p.facing,
        0.25,
        1.35
      );
    }

    // 2. Dynamic Hazards (Burning Oil, Toxic Cloud, Shockwaves)
    for (let i = 0; i < state.hazards.length; i++) {
      const hz = state.hazards[i];
      const hx = hz.rect.x + hz.rect.w * 0.5 - camX;
      const hy = hz.rect.y + hz.rect.h * 0.5 - camY;
      if (hx < -80 || hx > VIEWPORT_W + 80 || hy < -64 || hy > VIEWPORT_H + 64) continue;
      if (hz.kind === 'burningOil') {
        const flick = 0.75 + 0.25 * Math.sin(elapsedSec * 18 + hz.uid);
        this.emitVfxQuadBound(
          'vfx:ember',
          hx,
          hy,
          hz.rect.w,
          Math.max(10, hz.rect.h),
          1.0,
          0.46,
          0.14,
          0.65 * flick,
          1,
          0,
          1.25
        );
      } else if (hz.kind === 'toxicCloud') {
        this.emitVfxQuadBound(
          'vfx:ember',
          hx,
          hy,
          hz.rect.w,
          hz.rect.h,
          0.42,
          0.98,
          0.24,
          0.38,
          1,
          0,
          0.9
        );
      } else if (hz.kind === 'shockwaveZone') {
        this.emitVfxQuadBound(
          'vfx:aura_ring',
          hx,
          hy,
          hz.rect.w,
          Math.max(16, hz.rect.h),
          1.0,
          0.62,
          0.22,
          0.78,
          1,
          0.2,
          1.35
        );
      }
    }

    // 3. Enemy Golden `!` Telegraphs, Concierge Crimson Aura Rings, Shield Domes & World HP Bars
    for (let i = 0; i < state.enemies.length; i++) {
      const en = state.enemies[i];
      if (en.state === 'dead') continue;
      const ex = en.prevPos.x + (en.pos.x - en.prevPos.x) * interpAlpha - camX;
      const ey = en.prevPos.y + (en.pos.y - en.prevPos.y) * interpAlpha + en.height * 0.5 - camY;
      if (ex < -96 || ex > VIEWPORT_W + 96 || ey < -96 || ey > VIEWPORT_H + 96) continue;

      // Grounded contact shadow under grounded enemies & bosses
      if (en.grounded) {
        this.emitVfxQuadBound(
          'vfx:ember',
          ex,
          ey - 1,
          Math.max(14, en.width * 1.15),
          5,
          0.02,
          0.02,
          0.06,
          0.52,
          1,
          0,
          0
        );
      }

      // Concierge Lacerating Aura Ring!
      if (en.bossAuraTicks > 0) {
        const pulse = 1.0 + Math.sin(elapsedSec * 20) * 0.08;
        this.emitVfxQuadBound(
          'vfx:aura_ring',
          ex,
          ey - en.height * 0.45,
          120 * pulse,
          120 * pulse,
          1.0,
          0.28,
          0.18,
          0.86,
          1,
          0.1,
          1.4,
          elapsedSec * 3.5
        );
      }

      // Shield Dome (Concierge Shield / Protector Shield Aura)
      if (en.bossShieldTicks > 0 || en.protectedByUid !== null) {
        const rad = Math.max(en.width, en.height) * 1.45;
        this.emitVfxQuadBound(
          'vfx:shield_dome',
          ex,
          ey - en.height * 0.5,
          rad,
          rad,
          0.36,
          0.95,
          1.0,
          0.72,
          1,
          0,
          1.15
        );
      }

      // Iconic Golden `!` Enemy Attack Telegraph Glyph!
      if (en.state === 'windup' || en.telegraphTicks > 0) {
        const pop = 1.0 + Math.sin(elapsedSec * 28) * 0.16;
        this.emitVfxQuadBound(
          'vfx:telegraph',
          ex,
          ey - en.height - 14,
          16 * pop,
          22 * pop,
          1.0,
          0.92,
          0.35,
          1.0,
          1,
          0.2,
          1.45
        );
      }

      // Compact crisp pixel world HP bar above damaged non-boss enemies
      if (!en.isBoss && en.hp < en.maxHp && en.hp > 0) {
        const barW = Math.max(18, Math.min(34, en.width + 6));
        const hpFrac = Math.max(0, Math.min(1, en.hp / Math.max(1, en.maxHp)));
        const by = ey - en.height - 6;
        this.emitVfxQuadBound('vfx:white_px', ex, by, barW + 2, 4, 0.05, 0.05, 0.1, 0.85, 1, 0, 0);
        this.emitVfxQuadBound(
          'vfx:white_px',
          ex - barW * 0.5 * (1 - hpFrac),
          by,
          barW * hpFrac,
          2,
          en.isElite ? 1.0 : 0.92,
          en.isElite ? 0.78 : 0.2,
          en.isElite ? 0.22 : 0.28,
          0.95,
          1,
          0,
          0.3
        );
      }
    }

    // 4. Projectiles (Rotated along velocity vector with luminous emissive glow!)
    for (let i = 0; i < state.projectiles.length; i++) {
      const pr = state.projectiles[i];
      const px = pr.prevPos.x + (pr.pos.x - pr.prevPos.x) * interpAlpha - camX;
      const py = pr.prevPos.y + (pr.pos.y - pr.prevPos.y) * interpAlpha - camY;
      if (px < -40 || px > VIEWPORT_W + 40 || py < -40 || py > VIEWPORT_H + 40) continue;
      const key = `proj:${pr.kind}`;
      const reg = resolveSpriteRegion(this.atlas.regions, key, 'vfx:ember');
      const ang =
        pr.kind === 'shuriken'
          ? elapsedSec * 22
          : pr.kind === 'fallingSword'
          ? 0
          : Math.atan2(pr.vel.y, pr.vel.x);
      parseHexToScratch(pr.color, 1, 1, 1);
      const scale = pr.isCrit ? 1.25 : 1.0;
      this.emitVfxQuadBound(
        key,
        px,
        py,
        reg.w * scale,
        reg.h * scale,
        hexScratch[0] * 0.55 + 0.45,
        hexScratch[1] * 0.55 + 0.45,
        hexScratch[2] * 0.55 + 0.45,
        1.0,
        1,
        pr.isCrit ? 0.35 : 0,
        1.25,
        ang
      );
    }

    // 5. Simulation Particles (`state.particlesSim`)
    for (let i = 0; i < state.particlesSim.length; i++) {
      const pt = state.particlesSim[i];
      const px = pt.pos.x - camX;
      const py = pt.pos.y - camY;
      if (px < -24 || px > VIEWPORT_W + 24 || py < -24 || py > VIEWPORT_H + 24) continue;
      parseHexToScratch(pt.color, 1, 1, 1);
      const key =
        pt.kind === 'ring'
          ? 'vfx:parry_ring'
          : pt.kind === 'slash'
          ? 'vfx:slash_0'
          : pt.kind === 'spark'
          ? 'vfx:spark'
          : 'vfx:ember';
      const sz = Math.max(2, pt.size);
      this.emitVfxQuadBound(
        key,
        px,
        py,
        sz,
        sz,
        hexScratch[0],
        hexScratch[1],
        hexScratch[2],
        pt.alpha,
        1,
        0,
        pt.emissive ? 1.25 : 0.15,
        pt.angle ?? 0
      );
    }

    // 6. AtmosphereParticles (Scarf, Homunculus Flame Trail, Weapon Slashes, Rings, Weather, Popups!)
    this.particles.renderOverlay(camX, camY, theme.weather, elapsedSec, this.emitVfxQuadBound);
  }

  // ---------------------------------------------------------------------------
  // Master Per-Frame 4-Pass Compositor
  // ---------------------------------------------------------------------------

  render(state: SimState, interpAlpha: number, elapsedSec: number): void {
    const a = interpAlpha < 0 ? 0 : interpAlpha > 1 ? 1 : interpAlpha;
    const theme = getBiomeVisualTheme(state.activeBiomeId);

    // Lazy-prefetch Custom Pack biome atlas whenever active biome changes!
    if (state.activeBiomeId !== this.lastActiveBiomeId) {
      this.lastActiveBiomeId = state.activeBiomeId;
      if (this.settings.artPackMode === 'custom' && this.customPackStatus.available) {
        this.getBiomeCustomAtlas(state.activeBiomeId);
      }
    }

    const shakeScale = this.settings.screenShakeScale;
    const camX =
      state.camera.prevX +
      (state.camera.x - state.camera.prevX) * a +
      state.camera.shakeX * shakeScale;
    const camY =
      state.camera.prevY +
      (state.camera.y - state.camera.prevY) * a +
      state.camera.shakeY * shakeScale;
    this.curCamX = camX;
    this.curCamY = camY;

    const heroX = state.player.prevPos.x + (state.player.pos.x - state.player.prevPos.x) * a;
    const heroCenterY = state.player.prevPos.y + (state.player.pos.y - state.player.prevPos.y) * a;
    // SimState stores player.pos as AABB center; renderer sprite/VFX anchors use grounded feet Y!
    const heroY = heroCenterY + state.player.height * 0.5;

    this.particles.step(state, theme.weather, elapsedSec, heroX, heroY, camX, camY);

    if (this.backend === 'canvas2d-fallback' || !this.gl) {
      this.renderCanvas2DFallback(state, theme, a, elapsedSec, camX, camY, heroX, heroY);
      return;
    }

    const gl = this.gl;
    this.drawCalls = 0;

    // -------------------------------------------------------------------------
    // PASS 1: Parallax Backdrop (480x270 NEAREST)
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBackdrop);
    gl.viewport(0, 0, VIEWPORT_W, VIEWPORT_H);
    this.backdropPass!.render(
      gl,
      this.emptyVao!,
      VIEWPORT_W,
      VIEWPORT_H,
      camX,
      camY,
      elapsedSec,
      theme,
      this.settings.artPackMode === 'custom' && this.customPackStatus.available
    );
    this.drawCalls++;

    // -------------------------------------------------------------------------
    // PASS 2: G-Buffer MRT (Albedo + Tangent Normal + Emissive)
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboGBuffer);
    gl.viewport(0, 0, VIEWPORT_W, VIEWPORT_H);
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR_ZERO);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR_NORMAL);
    gl.clearBufferfv(gl.COLOR, 2, CLEAR_ZERO);

    this.beginBatch(this.progGBuffer!, this.texAlbedo!, this.texNormal!, this.texEmissive!);
    this.renderGBufferScene(state, theme, a, elapsedSec, camX, camY, heroX, heroY);
    this.flushBatch();

    // -------------------------------------------------------------------------
    // PASS 3: 64-Light Normal-Mapped Cel Lighting -> Lit Scene + Bloom Extract
    // -------------------------------------------------------------------------
    this.gatherLights(state, a, elapsedSec, heroX, heroY);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboLit);
    gl.viewport(0, 0, VIEWPORT_W, VIEWPORT_H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progLighting);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rtBackdrop);
    gl.uniform1i(this.uLightBackdrop, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rtGAlbedo);
    gl.uniform1i(this.uLightAlbedo, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rtGNormal);
    gl.uniform1i(this.uLightNormal, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.rtGEmissive);
    gl.uniform1i(this.uLightEmissive, 3);

    gl.uniform2f(this.uLightRes, VIEWPORT_W, VIEWPORT_H);
    gl.uniform3f(this.uLightAmbient, theme.ambientRgb[0], theme.ambientRgb[1], theme.ambientRgb[2]);
    gl.uniform3f(
      this.uLightCelShadow,
      theme.celShadowRgb[0],
      theme.celShadowRgb[1],
      theme.celShadowRgb[2]
    );
    gl.uniform3f(this.uLightFog, theme.fogRgb[0], theme.fogRgb[1], theme.fogRgb[2]);
    gl.uniform3f(this.uLightRim, theme.rimRgb[0], theme.rimRgb[1], theme.rimRgb[2]);
    gl.uniform1i(this.uLightCount, this.curLightCount);
    gl.uniform4fv(this.uLightPosRad, this.lightPosRadBuf);
    gl.uniform4fv(this.uLightColInt, this.lightColIntBuf);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;

    // -------------------------------------------------------------------------
    // PASS 3.5: Translucent & Emissive VFX Overlay onto Lit + Bloom FBOs
    // -------------------------------------------------------------------------
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    this.beginBatch(this.progVfx!, this.texAlbedo!, this.texNormal!, this.texEmissive!);
    this.renderVfxOverlay(state, theme, a, elapsedSec, camX, camY, heroX, heroY);
    this.flushBatch();

    // -------------------------------------------------------------------------
    // PASS 4A: Drifting Ground Mist / Volumetric Fog (smokeShader)
    // -------------------------------------------------------------------------
    if (this.settings.lightingQuality !== 'low') {
      gl.useProgram(this.progFog);
      gl.bindVertexArray(this.emptyVao);
      gl.uniform2f(this.uFogRes, VIEWPORT_W, VIEWPORT_H);
      gl.uniform2f(this.uFogCam, camX, camY);
      gl.uniform1f(this.uFogTime, elapsedSec);
      gl.uniform3f(this.uFogCol, theme.fogRgb[0], theme.fogRgb[1], theme.fogRgb[2]);
      gl.uniform3f(this.uFogAcc, theme.accentRgb[0], theme.accentRgb[1], theme.accentRgb[2]);
      gl.uniform1f(this.uFogDens, theme.fogDensity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.drawCalls++;
    }

    // -------------------------------------------------------------------------
    // PASS 4B: Separable Kawase/Gaussian Bloom Blur (240x135 Ping-Pong)
    // -------------------------------------------------------------------------
    const doBloom = this.settings.bloomEnabled;
    if (doBloom) {
      gl.disable(gl.BLEND);
      gl.useProgram(this.progBlur);
      gl.bindVertexArray(this.emptyVao);
      gl.viewport(0, 0, BLOOM_W, BLOOM_H);

      // Horizontal blur: rtBloomSrc -> fboBloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rtBloomSrc);
      gl.uniform1i(this.uBlurSrc, 0);
      gl.uniform2f(this.uBlurStep, 1.35 / BLOOM_W, 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.drawCalls++;

      // Vertical blur: rtBloomA -> fboBloomB
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomB);
      gl.bindTexture(gl.TEXTURE_2D, this.rtBloomA);
      gl.uniform2f(this.uBlurStep, 0.0, 1.35 / BLOOM_H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.drawCalls++;

      // Second wider blur pass on high lighting quality for luminous torch halos!
      if (this.settings.lightingQuality === 'high') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomA);
        gl.bindTexture(gl.TEXTURE_2D, this.rtBloomB);
        gl.uniform2f(this.uBlurStep, 2.2 / BLOOM_W, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.drawCalls++;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomB);
        gl.bindTexture(gl.TEXTURE_2D, this.rtBloomA);
        gl.uniform2f(this.uBlurStep, 0.0, 2.2 / BLOOM_H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.drawCalls++;
      }
    }

    // -------------------------------------------------------------------------
    // PASS 4C: Crisp gl.NEAREST Upscale + Additive Bloom + Vignette + Flashes
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.canvasW, this.canvasH);
    gl.clearColor(0.02, 0.025, 0.055, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.viewport(this.vpX, this.vpY, this.vpW, this.vpH);
    gl.useProgram(this.progComposite);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rtLit);
    gl.uniform1i(this.uCompScene, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, doBloom ? this.rtBloomB : this.texBlackEmissive);
    gl.uniform1i(this.uCompBloom, 1);

    const bloomStr = !doBloom
      ? 0.0
      : this.settings.lightingQuality === 'high'
      ? 0.88
      : this.settings.lightingQuality === 'medium'
      ? 0.68
      : 0.48;
    gl.uniform1f(this.uCompBloomStr, bloomStr);
    gl.uniform1f(this.uCompDmgFlash, state.damageFlashAlpha);
    gl.uniform1f(this.uCompParryFlash, state.parryFlashAlpha);
    gl.uniform3f(this.uCompGradeTint, theme.gradeRgb[0], theme.gradeRgb[1], theme.gradeRgb[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;
  }

  // ---------------------------------------------------------------------------
  // Clean Canvas2D Fallback (ONLY if WebGL2 context unavailable — ZERO radialGradient!)
  // ---------------------------------------------------------------------------

  private renderCanvas2DFallback(
    state: SimState,
    theme: BiomeVisualTheme,
    interpAlpha: number,
    elapsedSec: number,
    camX: number,
    camY: number,
    heroX: number,
    heroY: number
  ): void {
    const ctx = this.ctx2d;
    const sheet = this.atlas.albedoCanvas;
    if (!ctx || !sheet) return;

    this.drawCalls = 1;
    this.activeLights = Math.min(state.lights.length + 1, MAX_ACTIVE_LIGHTS);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = theme.fogHex;
    ctx.fillRect(0, 0, this.canvasW, this.canvasH);

    ctx.translate(this.vpX, this.vpY);
    ctx.scale(this.vpW / VIEWPORT_W, this.vpH / VIEWPORT_H);

    const drawReg = (key: string, dx: number, dy: number, flipX = 1): void => {
      const reg = resolveSpriteRegion(this.atlas.regions, key);
      const x = Math.round(dx - reg.w * reg.pivotX);
      const y = Math.round(dy - reg.h * reg.pivotY);
      if (flipX < 0) {
        ctx.save();
        ctx.translate(x + reg.w, y);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, reg.x, reg.y, reg.w, reg.h, 0, 0, reg.w, reg.h);
        ctx.restore();
      } else {
        ctx.drawImage(sheet, reg.x, reg.y, reg.w, reg.h, x, y, reg.w, reg.h);
      }
    };

    const grid = state.tileGrid;
    const tTheme = theme.tilesetTheme;
    const minTx = Math.max(0, Math.floor(camX / TILE_SIZE) - 1);
    const maxTx = Math.min(grid.width - 1, Math.ceil((camX + VIEWPORT_W) / TILE_SIZE) + 1);
    const minTy = Math.max(0, Math.floor(camY / TILE_SIZE) - 1);
    const maxTy = Math.min(grid.height - 1, Math.ceil((camY + VIEWPORT_H) / TILE_SIZE) + 1);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = grid.tiles[ty * grid.width + tx];
        if (tile === TileKind.EMPTY) continue;
        const sx = Math.round(tx * TILE_SIZE - camX);
        const sy = Math.round(ty * TILE_SIZE - camY);
        if (tile === TileKind.SOLID) drawReg(`tile:${tTheme}:solid_mid`, sx, sy);
        else if (tile === TileKind.ONE_WAY) drawReg(`tile:${tTheme}:oneway`, sx, sy);
        else if (tile === TileKind.SPIKES) drawReg('tile:spikes', sx + 12, sy + 24);
      }
    }

    for (let i = 0; i < state.enemies.length; i++) {
      const en = state.enemies[i];
      if (en.state === 'dead') continue;
      const ex = en.prevPos.x + (en.pos.x - en.prevPos.x) * interpAlpha - camX;
      const ey = en.prevPos.y + (en.pos.y - en.prevPos.y) * interpAlpha - camY;
      drawReg(en.isBoss && en.bossId ? `boss:${en.bossId}_0` : `enemy:${en.defId}_0`, ex, ey, en.facing);
      if (en.state === 'windup' || en.telegraphTicks > 0) {
        drawReg('vfx:telegraph', ex, ey - en.height - 10);
      }
    }

    const flameF = Math.floor(elapsedSec * 12) % 4;
    drawReg('hero:idle_0', heroX - camX, heroY - camY, state.player.facing);
    drawReg(`hero:head_flame_${flameF}`, heroX - camX, heroY - camY - 26, state.player.facing);
    ctx.restore();
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;

    this.backdropPass?.dispose(gl);
    const progs = [
      this.progParallax,
      this.progGBuffer,
      this.progLighting,
      this.progVfx,
      this.progFog,
      this.progBlur,
      this.progComposite,
    ];
    for (const p of progs) if (p) gl.deleteProgram(p);

    const texs = [
      this.texAlbedo,
      this.texNormal,
      this.texEmissive,
      this.texFlatNormal,
      this.texBlackEmissive,
      this.rtBackdrop,
      this.rtGAlbedo,
      this.rtGNormal,
      this.rtGEmissive,
      this.rtLit,
      this.rtBloomSrc,
      this.rtBloomA,
      this.rtBloomB,
    ];
    for (const t of texs) if (t) gl.deleteTexture(t);

    for (const ca of this.customGpuAtlases.values()) {
      for (const p of ca.pages) {
        gl.deleteTexture(p.diffuseTex);
        if (p.normalTex !== this.texFlatNormal) gl.deleteTexture(p.normalTex);
      }
    }
    this.customGpuAtlases.clear();

    const fbos = [
      this.fboBackdrop,
      this.fboGBuffer,
      this.fboLit,
      this.fboBloomA,
      this.fboBloomB,
    ];
    for (const f of fbos) if (f) gl.deleteFramebuffer(f);

    if (this.batchVbo) gl.deleteBuffer(this.batchVbo);
    if (this.batchIbo) gl.deleteBuffer(this.batchIbo);
    if (this.batchVao) gl.deleteVertexArray(this.batchVao);
    if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);

    this.gl = null;
  }
}
