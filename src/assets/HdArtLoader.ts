// =============================================================================
// KRUNKED CELLS — HD-2D ASYNC WEBP ART LOADER (ZERO-DOM NODE SAFE)
// Decodes embedded WebP data URIs from hdCharactersData.ts, hdWorldData.ts,
// and hdBackdrops.ts into GPU WebGL2 textures (albedo + tangent normal +
// emissive) with graceful handling of empty stub arrays.
// =============================================================================

import type { HdAtlasPageData, HdRegionMeta } from './hdAtlasTypes';
import {
  HD_CHARACTER_PAGES,
  HD_CHARACTER_REGIONS,
  HD_HERO_HEAD_ANCHORS,
} from './hdCharactersData';
import { HD_WORLD_PAGES, HD_WORLD_REGIONS } from './hdWorldData';
import { HD_BACKDROP_DATA } from './hdBackdrops';

export interface HdGpuAtlasPage {
  readonly width: number;
  readonly height: number;
  readonly albedoTex: WebGLTexture;
  readonly normalTex: WebGLTexture;
  readonly emissiveTex: WebGLTexture;
}

export interface HdResolvedRegion {
  readonly pageIndex: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly w: number;      // Logical world width (480x270 space)
  readonly h: number;      // Logical world height (480x270 space)
  readonly px: number;     // Pixel width on atlas
  readonly py: number;     // Pixel height on atlas
  readonly pivotX: number;
  readonly pivotY: number;
}

export interface HdBackdropGpuPair {
  readonly farTex: WebGLTexture;
  readonly midTex: WebGLTexture;
}

export interface HdArtGpuBundle {
  readonly pages: readonly HdGpuAtlasPage[];
  readonly regions: Readonly<Record<string, HdResolvedRegion>>;
  readonly backdrops: Readonly<Record<string, HdBackdropGpuPair>>;
  readonly heroHeadAnchors: Readonly<Record<string, readonly [number, number]>>;
}

function decodeDataUriImage(dataUri: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined' || !dataUri) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUri;
  });
}

function uploadGpuTexture(
  gl: WebGL2RenderingContext,
  img: HTMLImageElement,
  filter: number,
  wrapS: number,
  wrapT: number
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('WebGL2 failed to allocate HD-2D texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  return tex;
}

interface DecodedPageResult {
  readonly p: HdAtlasPageData;
  readonly albImg: HTMLImageElement;
  readonly nrmImg: HTMLImageElement;
  readonly emsImg: HTMLImageElement;
}

async function decodePageList(
  rawPages: readonly HdAtlasPageData[]
): Promise<(DecodedPageResult | null)[]> {
  return Promise.all(
    rawPages.map(async (p) => {
      const [albImg, nrmImg, emsImg] = await Promise.all([
        decodeDataUriImage(p.albedo),
        decodeDataUriImage(p.normal),
        decodeDataUriImage(p.emissive),
      ]);
      if (!albImg || !nrmImg || !emsImg) return null;
      return { p, albImg, nrmImg, emsImg };
    })
  );
}

/**
 * Asynchronously decodes & uploads all built-in HD-2D WebP character/world
 * atlas pages and 11 biome parallax backdrop pairs into WebGL2 textures.
 * Gracefully handles empty stub modules & safe no-op in Node.
 */
export async function loadHdArtGpuBundle(
  gl: WebGL2RenderingContext
): Promise<HdArtGpuBundle | null> {
  if (typeof Image === 'undefined') return null;

  // 1. Decode character pages, world pages, and all biome backdrops in parallel
  const bgKeys = Object.keys(HD_BACKDROP_DATA);
  const bgPromises = bgKeys.map(async (key) => {
    const pair = HD_BACKDROP_DATA[key];
    if (!pair) return null;
    const [farImg, midImg] = await Promise.all([
      decodeDataUriImage(pair.far),
      decodeDataUriImage(pair.mid),
    ]);
    if (!farImg || !midImg) return null;
    return { key, farImg, midImg };
  });

  const [decodedCharPages, decodedWorldPages, decodedBgs] = await Promise.all([
    decodePageList(HD_CHARACTER_PAGES),
    decodePageList(HD_WORLD_PAGES),
    Promise.all(bgPromises),
  ]);

  if (gl.isContextLost()) return null;

  const pages: HdGpuAtlasPage[] = [];
  const charIndexMap: number[] = [];
  for (let i = 0; i < decodedCharPages.length; i++) {
    const dp = decodedCharPages[i];
    if (!dp) {
      charIndexMap.push(-1);
      continue;
    }
    const albedoTex = uploadGpuTexture(gl, dp.albImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    const normalTex = uploadGpuTexture(gl, dp.nrmImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    const emissiveTex = uploadGpuTexture(gl, dp.emsImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    charIndexMap.push(pages.length);
    pages.push({
      width: dp.p.w,
      height: dp.p.h,
      albedoTex,
      normalTex,
      emissiveTex,
    });
  }

  const worldIndexMap: number[] = [];
  for (let i = 0; i < decodedWorldPages.length; i++) {
    const dp = decodedWorldPages[i];
    if (!dp) {
      worldIndexMap.push(-1);
      continue;
    }
    const albedoTex = uploadGpuTexture(gl, dp.albImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    const normalTex = uploadGpuTexture(gl, dp.nrmImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    const emissiveTex = uploadGpuTexture(gl, dp.emsImg, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    worldIndexMap.push(pages.length);
    pages.push({
      width: dp.p.w,
      height: dp.p.h,
      albedoTex,
      normalTex,
      emissiveTex,
    });
  }

  const regions: Record<string, HdResolvedRegion> = {};
  const registerRegions = (
    srcRegions: Readonly<Record<string, HdRegionMeta>>,
    indexMap: readonly number[]
  ): void => {
    for (const key of Object.keys(srcRegions)) {
      const r: HdRegionMeta = srcRegions[key];
      const mergedPageIdx = indexMap[r.p] ?? -1;
      if (mergedPageIdx < 0) continue;
      const pg = pages[mergedPageIdx];
      if (!pg) continue;
      regions[key] = {
        pageIndex: mergedPageIdx,
        u0: r.x / pg.width,
        v0: r.y / pg.height,
        u1: (r.x + r.w) / pg.width,
        v1: (r.y + r.h) / pg.height,
        w: r.ww,
        h: r.wh,
        px: r.w,
        py: r.h,
        pivotX: r.px,
        pivotY: r.py,
      };
    }
  };

  // Register world regions first, then character regions (characters take priority if any overlap)
  registerRegions(HD_WORLD_REGIONS, worldIndexMap);
  registerRegions(HD_CHARACTER_REGIONS, charIndexMap);

  const backdrops: Record<string, HdBackdropGpuPair> = {};
  for (const bg of decodedBgs) {
    if (!bg) continue;
    const farTex = uploadGpuTexture(gl, bg.farImg, gl.NEAREST, gl.REPEAT, gl.CLAMP_TO_EDGE);
    const midTex = uploadGpuTexture(gl, bg.midImg, gl.NEAREST, gl.REPEAT, gl.CLAMP_TO_EDGE);
    backdrops[bg.key] = { farTex, midTex };
  }

  return {
    pages,
    regions,
    backdrops,
    heroHeadAnchors: HD_HERO_HEAD_ANCHORS,
  };
}

export function disposeHdArtGpuBundle(
  gl: WebGL2RenderingContext,
  bundle: HdArtGpuBundle | null
): void {
  if (!bundle) return;
  for (const pg of bundle.pages) {
    gl.deleteTexture(pg.albedoTex);
    gl.deleteTexture(pg.normalTex);
    gl.deleteTexture(pg.emissiveTex);
  }
  for (const bg of Object.values(bundle.backdrops)) {
    gl.deleteTexture(bg.farTex);
    gl.deleteTexture(bg.midTex);
  }
}
