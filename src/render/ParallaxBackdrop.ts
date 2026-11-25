// =============================================================================
// KRUNKED CELLS — BIOME PALETTES & PASS 1 PARALLAX BACKDROP CONTROLLER
// Exact SPEC.md oracle lighting hex palettes for all 10 biomes + Passage,
// plus optional Owned Custom Pack scroller texture binding.
// =============================================================================

import type { BiomeId, BiomeWeather } from '../contracts';
import type { TilesetTheme } from '../assets/ProceduralAtlas';

export type Vec3Tuple = readonly [number, number, number];

export interface BiomeVisualTheme {
  biomeId: BiomeId;
  tilesetTheme: TilesetTheme;
  scrollerKey: string;
  themeId: number;
  weather: BiomeWeather;
  ambientHex: string;
  fogHex: string;
  celShadowHex: string;
  waterHex: string;
  ambientRgb: Vec3Tuple;
  fogRgb: Vec3Tuple;
  celShadowRgb: Vec3Tuple;
  waterRgb: Vec3Tuple;
  skyTopRgb: Vec3Tuple;
  skyMidRgb: Vec3Tuple;
  skyBottomRgb: Vec3Tuple;
  accentRgb: Vec3Tuple;
  rimRgb: Vec3Tuple;
  gradeRgb: Vec3Tuple;
  fogDensity: number;
}

export function hexToVec3(hex: string): Vec3Tuple {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = parseInt(clean, 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function makeTheme(cfg: {
  biomeId: BiomeId;
  tilesetTheme: TilesetTheme;
  scrollerKey: string;
  themeId: number;
  weather: BiomeWeather;
  ambientHex: string;
  fogHex: string;
  celShadowHex: string;
  waterHex: string;
  skyTopHex: string;
  skyMidHex: string;
  skyBottomHex: string;
  accentHex: string;
  rimHex: string;
  gradeHex: string;
  fogDensity: number;
}): BiomeVisualTheme {
  return {
    biomeId: cfg.biomeId,
    tilesetTheme: cfg.tilesetTheme,
    scrollerKey: cfg.scrollerKey,
    themeId: cfg.themeId,
    weather: cfg.weather,
    ambientHex: cfg.ambientHex,
    fogHex: cfg.fogHex,
    celShadowHex: cfg.celShadowHex,
    waterHex: cfg.waterHex,
    ambientRgb: hexToVec3(cfg.ambientHex),
    fogRgb: hexToVec3(cfg.fogHex),
    celShadowRgb: hexToVec3(cfg.celShadowHex),
    waterRgb: hexToVec3(cfg.waterHex),
    skyTopRgb: hexToVec3(cfg.skyTopHex),
    skyMidRgb: hexToVec3(cfg.skyMidHex),
    skyBottomRgb: hexToVec3(cfg.skyBottomHex),
    accentRgb: hexToVec3(cfg.accentHex),
    rimRgb: hexToVec3(cfg.rimHex),
    gradeRgb: hexToVec3(cfg.gradeHex),
    fogDensity: cfg.fogDensity,
  };
}

export const BIOME_VISUAL_THEMES: Record<BiomeId, BiomeVisualTheme> = {
  PrisonStart: makeTheme({
    biomeId: 'PrisonStart',
    tilesetTheme: 'prison',
    scrollerKey: 'prison',
    themeId: 0,
    weather: 'dust',
    ambientHex: '#c5c1ee',
    fogHex: '#062654',
    celShadowHex: '#062654',
    waterHex: '#363169',
    skyTopHex: '#0b1026',
    skyMidHex: '#15254d',
    skyBottomHex: '#0c2d5c',
    accentHex: '#ff9b3d',
    rimHex: '#7da6ff',
    gradeHex: '#d8e4ff',
    fogDensity: 0.85,
  }),
  PrisonCourtyard: makeTheme({
    biomeId: 'PrisonCourtyard',
    tilesetTheme: 'promenade',
    scrollerKey: 'courtyard',
    themeId: 1,
    weather: 'rain',
    ambientHex: '#b6b6b6',
    fogHex: '#211727',
    celShadowHex: '#286d55',
    waterHex: '#ffd329',
    skyTopHex: '#12182b',
    skyMidHex: '#223342',
    skyBottomHex: '#284040',
    accentHex: '#ffcb57',
    rimHex: '#8ae0c2',
    gradeHex: '#dcf2ea',
    fogDensity: 0.95,
  }),
  Sewer: makeTheme({
    biomeId: 'Sewer',
    tilesetTheme: 'sewer',
    scrollerKey: 'sewers',
    themeId: 2,
    weather: 'acidDrip',
    ambientHex: '#f67d47',
    fogHex: '#15290a',
    celShadowHex: '#0d4b14',
    waterHex: '#458e06',
    skyTopHex: '#081409',
    skyMidHex: '#132e12',
    skyBottomHex: '#1e4a15',
    accentHex: '#84ff3d',
    rimHex: '#7ef252',
    gradeHex: '#dcffcf',
    fogDensity: 1.05,
  }),
  PrisonRoof: makeTheme({
    biomeId: 'PrisonRoof',
    tilesetTheme: 'ramparts',
    scrollerKey: 'cliff',
    themeId: 3,
    weather: 'wind',
    ambientHex: '#d4a18b',
    fogHex: '#0e1629',
    celShadowHex: '#4f2a10',
    waterHex: '#363169',
    skyTopHex: '#141936',
    skyMidHex: '#59333e',
    skyBottomHex: '#ba6b49',
    accentHex: '#ff9f52',
    rimHex: '#ffbe82',
    gradeHex: '#ffe6d4',
    fogDensity: 0.72,
  }),
  Bridge: makeTheme({
    biomeId: 'Bridge',
    tilesetTheme: 'bridge',
    scrollerKey: 'cliff',
    themeId: 4,
    weather: 'rain',
    ambientHex: '#383f9a',
    fogHex: '#16172f',
    celShadowHex: '#2960ba',
    waterHex: '#448bcc',
    skyTopHex: '#0a0f26',
    skyMidHex: '#1c2554',
    skyBottomHex: '#2a3d73',
    accentHex: '#ff5c38',
    rimHex: '#73b4ff',
    gradeHex: '#d4e2ff',
    fogDensity: 0.92,
  }),
  StiltVillage: makeTheme({
    biomeId: 'StiltVillage',
    tilesetTheme: 'stilt',
    scrollerKey: 'courtyard',
    themeId: 5,
    weather: 'rain',
    ambientHex: '#e5e5e5',
    fogHex: '#0e332c',
    celShadowHex: '#286d55',
    waterHex: '#451a1a',
    skyTopHex: '#0c1f24',
    skyMidHex: '#183d3b',
    skyBottomHex: '#244d47',
    accentHex: '#ffc154',
    rimHex: '#7ce8d0',
    gradeHex: '#dff7f0',
    fogDensity: 1.0,
  }),
  ClockTower: makeTheme({
    biomeId: 'ClockTower',
    tilesetTheme: 'clock',
    scrollerKey: 'cliff',
    themeId: 6,
    weather: 'cogs',
    ambientHex: '#ae3f57',
    fogHex: '#540715',
    celShadowHex: '#1c3dbd',
    waterHex: '#38a785',
    skyTopHex: '#1f0814',
    skyMidHex: '#4f1226',
    skyBottomHex: '#6b1c2d',
    accentHex: '#f5c156',
    rimHex: '#ff7092',
    gradeHex: '#ffe0e8',
    fogDensity: 0.85,
  }),
  TopClockTower: makeTheme({
    biomeId: 'TopClockTower',
    tilesetTheme: 'clock',
    scrollerKey: 'cliff',
    themeId: 6,
    weather: 'cogs',
    ambientHex: '#09718e',
    fogHex: '#002f40',
    celShadowHex: '#1cbdb6',
    waterHex: '#62e1ba',
    skyTopHex: '#031824',
    skyMidHex: '#0a3a4f',
    skyBottomHex: '#125969',
    accentHex: '#52f2e2',
    rimHex: '#8cfff4',
    gradeHex: '#d9fffc',
    fogDensity: 0.8,
  }),
  Castle: makeTheme({
    biomeId: 'Castle',
    tilesetTheme: 'castle',
    scrollerKey: 'courtyard',
    themeId: 7,
    weather: 'embers',
    ambientHex: '#fbd4a8',
    fogHex: '#1d619f',
    celShadowHex: '#e59a71',
    waterHex: '#75cef6',
    skyTopHex: '#1a3869',
    skyMidHex: '#3b6ca8',
    skyBottomHex: '#b87f69',
    accentHex: '#ffd269',
    rimHex: '#fff0c2',
    gradeHex: '#fff3e0',
    fogDensity: 0.65,
  }),
  Throne: makeTheme({
    biomeId: 'Throne',
    tilesetTheme: 'throne',
    scrollerKey: 'cliff',
    themeId: 8,
    weather: 'embers',
    ambientHex: '#3b96ec',
    fogHex: '#062654',
    celShadowHex: '#2960ba',
    waterHex: '#448bcc',
    skyTopHex: '#091836',
    skyMidHex: '#173e73',
    skyBottomHex: '#2c629c',
    accentHex: '#6ad2ff',
    rimHex: '#a8e4ff',
    gradeHex: '#e0f2ff',
    fogDensity: 0.78,
  }),
  Passage: makeTheme({
    biomeId: 'Passage',
    tilesetTheme: 'passage',
    scrollerKey: 'prison',
    themeId: 9,
    weather: 'dust',
    ambientHex: '#984264',
    fogHex: '#33151b',
    celShadowHex: '#0e0654',
    waterHex: '#363169',
    skyTopHex: '#170a14',
    skyMidHex: '#301424',
    skyBottomHex: '#471e2b',
    accentHex: '#ff9f43',
    rimHex: '#ff8cb8',
    gradeHex: '#ffe3ec',
    fogDensity: 0.8,
  }),
};

export function getBiomeVisualTheme(biomeId: BiomeId): BiomeVisualTheme {
  return BIOME_VISUAL_THEMES[biomeId] ?? BIOME_VISUAL_THEMES.PrisonStart;
}

// =============================================================================
// Pass 1 WebGL2 Parallax Backdrop Renderer
// =============================================================================

export class ParallaxBackdropPass {
  private readonly program: WebGLProgram;
  private readonly uResolution: WebGLUniformLocation | null;
  private readonly uCamera: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;
  private readonly uSkyTop: WebGLUniformLocation | null;
  private readonly uSkyMid: WebGLUniformLocation | null;
  private readonly uSkyBottom: WebGLUniformLocation | null;
  private readonly uFogColor: WebGLUniformLocation | null;
  private readonly uCelShadow: WebGLUniformLocation | null;
  private readonly uAccentColor: WebGLUniformLocation | null;
  private readonly uThemeId: WebGLUniformLocation | null;
  private readonly uHasScrollerTex: WebGLUniformLocation | null;
  private readonly uScrollerTex: WebGLUniformLocation | null;

  private readonly dummyTex: WebGLTexture;
  private readonly scrollerTextures = new Map<string, WebGLTexture>();

  constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.program = program;
    this.uResolution = gl.getUniformLocation(program, 'u_resolution');
    this.uCamera = gl.getUniformLocation(program, 'u_camera');
    this.uTime = gl.getUniformLocation(program, 'u_time');
    this.uSkyTop = gl.getUniformLocation(program, 'u_skyTop');
    this.uSkyMid = gl.getUniformLocation(program, 'u_skyMid');
    this.uSkyBottom = gl.getUniformLocation(program, 'u_skyBottom');
    this.uFogColor = gl.getUniformLocation(program, 'u_fogColor');
    this.uCelShadow = gl.getUniformLocation(program, 'u_celShadow');
    this.uAccentColor = gl.getUniformLocation(program, 'u_accentColor');
    this.uThemeId = gl.getUniformLocation(program, 'u_themeId');
    this.uHasScrollerTex = gl.getUniformLocation(program, 'u_hasScrollerTex');
    this.uScrollerTex = gl.getUniformLocation(program, 'u_scrollerTex');

    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create dummy scroller texture');
    this.dummyTex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  uploadScrollerImage(
    gl: WebGL2RenderingContext,
    themeKey: string,
    image: ImageBitmap | HTMLImageElement
  ): void {
    const existing = this.scrollerTextures.get(themeKey);
    if (existing) gl.deleteTexture(existing);
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.scrollerTextures.set(themeKey, tex);
  }

  render(
    gl: WebGL2RenderingContext,
    vao: WebGLVertexArrayObject,
    width: number,
    height: number,
    camX: number,
    camY: number,
    elapsedSec: number,
    theme: BiomeVisualTheme,
    useCustomScroller: boolean
  ): void {
    gl.useProgram(this.program);
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);

    gl.uniform2f(this.uResolution, width, height);
    gl.uniform2f(this.uCamera, camX, camY);
    gl.uniform1f(this.uTime, elapsedSec);
    gl.uniform3f(this.uSkyTop, theme.skyTopRgb[0], theme.skyTopRgb[1], theme.skyTopRgb[2]);
    gl.uniform3f(this.uSkyMid, theme.skyMidRgb[0], theme.skyMidRgb[1], theme.skyMidRgb[2]);
    gl.uniform3f(
      this.uSkyBottom,
      theme.skyBottomRgb[0],
      theme.skyBottomRgb[1],
      theme.skyBottomRgb[2]
    );
    gl.uniform3f(this.uFogColor, theme.fogRgb[0], theme.fogRgb[1], theme.fogRgb[2]);
    gl.uniform3f(
      this.uCelShadow,
      theme.celShadowRgb[0],
      theme.celShadowRgb[1],
      theme.celShadowRgb[2]
    );
    gl.uniform3f(this.uAccentColor, theme.accentRgb[0], theme.accentRgb[1], theme.accentRgb[2]);
    gl.uniform1i(this.uThemeId, theme.themeId);

    const scTex = useCustomScroller ? this.scrollerTextures.get(theme.scrollerKey) : undefined;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scTex ?? this.dummyTex);
    gl.uniform1i(this.uScrollerTex, 0);
    gl.uniform1f(this.uHasScrollerTex, scTex ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.dummyTex);
    for (const tex of this.scrollerTextures.values()) {
      gl.deleteTexture(tex);
    }
    this.scrollerTextures.clear();
  }
}
