// =============================================================================
// KRUNKED CELLS — OWNED CUSTOM PACK LOADER & LIBGDX ATLAS / TRACKS PARSER
// Supports Vite dev middleware (/__custom_pack__/status), interactive folder
// picker (showDirectoryPicker + <input webkitdirectory>), IndexedDB persistence
// (krunked_cells_custom_pack_v1), paired diffuse + *_n.png normal maps, and
// *_tracks.json 2D bone offsets (headBone, weaponBone0, etc.).
// =============================================================================

import type {
  AssetManifest,
  AssetManifestEntry,
  CustomPackAssetResolver,
  CustomPackStatus,
} from '../contracts';

export const CUSTOM_PACK_DB_NAME = 'krunked_cells_custom_pack_v1' as const;
const CUSTOM_PACK_STORE = 'files' as const;
const DEV_PACK_PREFIX = '/__custom_pack__';

// -----------------------------------------------------------------------------
// libGDX .atlas & *_tracks.json Data Structures
// -----------------------------------------------------------------------------

export interface LibGdxRegion {
  name: string;
  pageName: string;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  origW: number;
  origH: number;
  offsetX: number;
  offsetY: number;
  rotate: 0 | 90 | 180 | 270;
  index: number;
}

export interface LibGdxPage {
  fileName: string;
  width: number;
  height: number;
  format: string;
  filter: [string, string];
  repeat: string;
}

export interface ParsedLibGdxAtlas {
  pages: LibGdxPage[];
  regions: Map<string, LibGdxRegion>;
  animations: Map<string, LibGdxRegion[]>;
}

export interface BoneOffset {
  x: number;
  y: number;
  rot?: number;
}

/** Map of animation/frame key -> boneName (e.g. 'headBone', 'weaponBone0') -> 2D offset. */
export interface ParsedTracksData {
  byAnimFrame: Map<string, Record<string, BoneOffset>>;
  defaultBones: Record<string, BoneOffset>;
}

export interface CustomAtlasPageTextures {
  diffuse: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  normal: ImageBitmap | HTMLImageElement | null;
  width: number;
  height: number;
}

export interface LoadedCustomAtlas {
  name: string;
  atlas: ParsedLibGdxAtlas;
  pages: CustomAtlasPageTextures[];
  tracks: ParsedTracksData | null;
}

// -----------------------------------------------------------------------------
// Pure Parsers (Zero DOM Dependency — testable in Node/Vitest)
// -----------------------------------------------------------------------------

function parsePair(val: string): [number, number] {
  const parts = val.split(',');
  return [
    parseInt((parts[0] ?? '0').trim(), 10) || 0,
    parseInt((parts[1] ?? '0').trim(), 10) || 0,
  ];
}

function parseRotate(val: string): 0 | 90 | 180 | 270 {
  const clean = val.trim().toLowerCase();
  if (clean === 'true' || clean === '90') return 90;
  if (clean === '180') return 180;
  if (clean === '270') return 270;
  return 0;
}

/**
 * Parses a libGDX `.atlas` file supporting multiple pages, `xy`, `size`,
 * `orig`, `offset`, `rotate`, and `index`.
 */
export function parseLibGdxAtlas(text: string): ParsedLibGdxAtlas {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const pages: LibGdxPage[] = [];
  const regions = new Map<string, LibGdxRegion>();
  const animations = new Map<string, LibGdxRegion[]>();

  let currentPage: LibGdxPage | null = null;
  let currentPageIndex = -1;
  let currentRegion: LibGdxRegion | null = null;

  const commitRegion = (): void => {
    if (!currentRegion) return;
    const rawName = currentRegion.name;
    let baseName = rawName;
    let frameNum = currentRegion.index;

    // Dead Cells BATL->libGDX exports store frame indices either in `index:` or as `animName_00` / `dir/animName00`
    if (frameNum < 0) {
      const mUnderscore = /^(.*)_(\d+)$/.exec(rawName);
      if (mUnderscore) {
        baseName = mUnderscore[1];
        frameNum = parseInt(mUnderscore[2], 10);
      } else {
        const mDigits = /^(.*?)(\d{2,})$/.exec(rawName);
        if (mDigits && mDigits[1].length > 0) {
          baseName = mDigits[1];
          frameNum = parseInt(mDigits[2], 10);
        }
      }
    }
    currentRegion.index = frameNum;

    const key = frameNum >= 0 ? `${baseName}_${frameNum}` : rawName;
    regions.set(rawName, currentRegion);
    regions.set(key, currentRegion);
    if (!regions.has(baseName)) {
      regions.set(baseName, currentRegion);
    }

    const pushAnim = (animKey: string): void => {
      if (!animKey) return;
      let list = animations.get(animKey);
      if (!list) {
        list = [];
        animations.set(animKey, list);
      }
      list.push(currentRegion!);
    };

    pushAnim(baseName);
    const lowerBase = baseName.toLowerCase();
    if (lowerBase !== baseName) pushAnim(lowerBase);

    // Also register suffix after last '/' (e.g. `deadArcher/idle` -> `idle`, `assassin/run` -> `run`)
    const slashIdx = baseName.lastIndexOf('/');
    if (slashIdx >= 0 && slashIdx < baseName.length - 1) {
      const shortName = baseName.slice(slashIdx + 1);
      pushAnim(shortName);
      const lowerShort = shortName.toLowerCase();
      if (lowerShort !== shortName) pushAnim(lowerShort);
    }

    currentRegion = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      commitRegion();
      currentPage = null;
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    const isIndented = raw.startsWith(' ') || raw.startsWith('\t');

    if (currentPage === null) {
      // First non-empty line in a block is the page image filename
      currentPage = {
        fileName: trimmed,
        width: 1024,
        height: 1024,
        format: 'RGBA8888',
        filter: ['Nearest', 'Nearest'],
        repeat: 'none',
      };
      pages.push(currentPage);
      currentPageIndex = pages.length - 1;
      continue;
    }

    if (!isIndented && colonIdx === -1) {
      // New region header
      commitRegion();
      currentRegion = {
        name: trimmed,
        pageName: currentPage.fileName,
        pageIndex: currentPageIndex,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        origW: 0,
        origH: 0,
        offsetX: 0,
        offsetY: 0,
        rotate: 0,
        index: -1,
      };
      continue;
    }

    if (colonIdx !== -1) {
      const prop = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (currentRegion === null) {
        // Page header metadata
        if (prop === 'size') {
          const [w, h] = parsePair(val);
          currentPage.width = w || 1024;
          currentPage.height = h || 1024;
        } else if (prop === 'format') {
          currentPage.format = val;
        } else if (prop === 'filter') {
          const parts = val.split(',');
          currentPage.filter = [
            (parts[0] ?? 'Nearest').trim(),
            (parts[1] ?? 'Nearest').trim(),
          ];
        } else if (prop === 'repeat') {
          currentPage.repeat = val;
        }
      } else {
        // Region properties
        if (prop === 'xy') {
          const [x, y] = parsePair(val);
          currentRegion.x = x;
          currentRegion.y = y;
        } else if (prop === 'size') {
          const [w, h] = parsePair(val);
          currentRegion.w = w;
          currentRegion.h = h;
          if (currentRegion.origW === 0) currentRegion.origW = w;
          if (currentRegion.origH === 0) currentRegion.origH = h;
        } else if (prop === 'orig') {
          const [ow, oh] = parsePair(val);
          currentRegion.origW = ow;
          currentRegion.origH = oh;
        } else if (prop === 'offset') {
          const [ox, oy] = parsePair(val);
          currentRegion.offsetX = ox;
          currentRegion.offsetY = oy;
        } else if (prop === 'rotate') {
          currentRegion.rotate = parseRotate(val);
        } else if (prop === 'index') {
          currentRegion.index = parseInt(val, 10);
          if (Number.isNaN(currentRegion.index)) currentRegion.index = -1;
        }
      }
    }
  }

  commitRegion();

  for (const list of animations.values()) {
    list.sort((a, b) => a.index - b.index);
  }

  return { pages, regions, animations };
}

/**
 * Defensive parser for Dead Cells / custom-pack `*_tracks.json` files
 * exposing 2D bone offsets such as `headBone` and `weaponBone0`.
 */
export function parseTracksJson(text: string): ParsedTracksData {
  const byAnimFrame = new Map<string, Record<string, BoneOffset>>();
  const defaultBones: Record<string, BoneOffset> = {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { byAnimFrame, defaultBones };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { byAnimFrame, defaultBones };
  }

  const root = parsed as Record<string, unknown>;

  const extractBone = (val: unknown): BoneOffset | null => {
    if (!val) return null;
    if (Array.isArray(val) && val.length >= 2) {
      const x = Number(val[0]);
      const y = Number(val[1]);
      const rot = val.length >= 3 ? Number(val[2]) : undefined;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y, rot: Number.isFinite(rot) ? rot : undefined };
      }
      return null;
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const x = Number(obj.x ?? obj.dx ?? 0);
      const y = Number(obj.y ?? obj.dy ?? 0);
      const rot = obj.rot !== undefined ? Number(obj.rot) : obj.r !== undefined ? Number(obj.r) : undefined;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y, rot: Number.isFinite(rot) ? rot : undefined };
      }
    }
    return null;
  };

  for (const [animKey, animVal] of Object.entries(root)) {
    if (!animVal || typeof animVal !== 'object') continue;

    // Case 1: { "idle_0": { "headBone": {x, y}, "weaponBone0": {x, y} } }
    if (!Array.isArray(animVal)) {
      const obj = animVal as Record<string, unknown>;
      const directBones: Record<string, BoneOffset> = {};
      let foundDirect = false;

      for (const [subKey, subVal] of Object.entries(obj)) {
        if (Array.isArray(subVal) && subVal.length >= 3 && typeof subVal[0] === 'number') {
          // Case 3 (Dead Cells retail `*_tracks.json`): flat 3-tuple array [x0, y0, rot0, x1, y1, rot1, ...]
          const frameCount = Math.floor(subVal.length / 3);
          for (let fi = 0; fi < frameCount; fi++) {
            const x = Number(subVal[fi * 3]);
            const y = Number(subVal[fi * 3 + 1]);
            const rot = Number(subVal[fi * 3 + 2]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const b: BoneOffset = { x, y, rot: Number.isFinite(rot) ? rot : undefined };
            const fk = `${animKey}_${fi}`;
            const frameMap = byAnimFrame.get(fk) ?? {};
            frameMap[subKey] = b;
            byAnimFrame.set(fk, frameMap);
            if (!defaultBones[subKey]) defaultBones[subKey] = b;
          }
        } else if (Array.isArray(subVal) && subVal.length > 0 && typeof subVal[0] === 'object') {
          // Case 2: { "idle": { "headBone": [ {x,y}, {x,y}, ... ] } }
          for (let fi = 0; fi < subVal.length; fi++) {
            const b = extractBone(subVal[fi]);
            if (!b) continue;
            const fk = `${animKey}_${fi}`;
            const frameMap = byAnimFrame.get(fk) ?? {};
            frameMap[subKey] = b;
            byAnimFrame.set(fk, frameMap);
            if (!defaultBones[subKey]) defaultBones[subKey] = b;
          }
        } else {
          const b = extractBone(subVal);
          if (b) {
            directBones[subKey] = b;
            foundDirect = true;
            if (!defaultBones[subKey]) defaultBones[subKey] = b;
          }
        }
      }
      if (foundDirect) {
        byAnimFrame.set(animKey, directBones);
      }
    }
  }

  return { byAnimFrame, defaultBones };
}

// -----------------------------------------------------------------------------
// IndexedDB Storage Helpers (krunked_cells_custom_pack_v1)
// -----------------------------------------------------------------------------

function openPackDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CUSTOM_PACK_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CUSTOM_PACK_STORE)) {
          db.createObjectStore(CUSTOM_PACK_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPutAll(files: Map<string, Blob>): Promise<void> {
  const db = await openPackDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CUSTOM_PACK_STORE, 'readwrite');
      const store = tx.objectStore(CUSTOM_PACK_STORE);
      store.clear();
      for (const [k, blob] of files.entries()) {
        store.put(blob, k);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function idbGetBlob(key: string): Promise<Blob | null> {
  const db = await openPackDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CUSTOM_PACK_STORE, 'readonly');
      const store = tx.objectStore(CUSTOM_PACK_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result instanceof Blob ? req.result : null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function idbGetAllKeys(): Promise<string[]> {
  const db = await openPackDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CUSTOM_PACK_STORE, 'readonly');
      const store = tx.objectStore(CUSTOM_PACK_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        db.close();
        resolve((req.result ?? []).map((k) => String(k)));
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

async function idbClear(): Promise<void> {
  const db = await openPackDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CUSTOM_PACK_STORE, 'readwrite');
      tx.objectStore(CUSTOM_PACK_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

// -----------------------------------------------------------------------------
// Synthetic Manifest Builder (if user selects raw folder without manifest.json)
// -----------------------------------------------------------------------------

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildSyntheticManifest(paths: string[]): AssetManifest {
  const atlases: AssetManifest['atlases'] = {};
  const scrollers: AssetManifest['scrollers'] = {};
  const gradients: AssetManifest['gradients'] = {};
  const audioSfx: AssetManifest['audioSfx'] = {};
  const audioMusic: AssetManifest['audioMusic'] = {};
  const entries: AssetManifestEntry[] = [];

  const lowerSet = new Map<string, string>();
  for (const raw of paths) {
    const p = normalizeRelPath(raw);
    lowerSet.set(p.toLowerCase(), p);
  }

  for (const p of lowerSet.values()) {
    const low = p.toLowerCase();
    const base = p.split('/').pop() ?? p;
    const stem = base.replace(/\.[^.]+$/, '');

    if (low.endsWith('.atlas')) {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      const pages: string[] = [];
      const normalPages: string[] = [];
      for (let i = 0; i < 8; i++) {
        const pg = lowerSet.get(`${dir}${stem}${i}.png`.toLowerCase());
        const npg = lowerSet.get(`${dir}${stem}${i}_n.png`.toLowerCase());
        if (pg) pages.push(pg);
        if (npg) normalPages.push(npg);
      }
      if (pages.length === 0) {
        const single = lowerSet.get(`${dir}${stem}.png`.toLowerCase());
        const singleN = lowerSet.get(`${dir}${stem}_n.png`.toLowerCase());
        if (single) pages.push(single);
        if (singleN) normalPages.push(singleN);
      }
      const tracksFile = lowerSet.get(`${dir}${stem}_tracks.json`.toLowerCase());
      const skinFile = lowerSet.get(`${dir}${stem}_default_s.png`.toLowerCase());
      atlases[stem] = {
        atlasFile: p,
        pages,
        normalPages,
        ...(tracksFile ? { tracksFile } : {}),
        ...(skinFile ? { skinFile } : {}),
      };
      entries.push({ key: stem, kind: 'atlas', relPath: p, sizeBytes: 1 });
    } else if (low.includes('scroller/') && (low.endsWith('.png') || low.endsWith('.jpg'))) {
      const segs = p.split('/');
      const scIdx = segs.findIndex((s) => s.toLowerCase() === 'scroller');
      const theme = segs[scIdx + 1] ?? 'default';
      if (!scrollers[theme]) scrollers[theme] = [];
      scrollers[theme].push(p);
      entries.push({ key: `${theme}/${stem}`, kind: 'scroller', relPath: p, sizeBytes: 1 });
    } else if (low.includes('gradient') && low.endsWith('.png')) {
      gradients[stem] = p;
      entries.push({ key: stem, kind: 'gradient', relPath: p, sizeBytes: 1 });
    } else if (low.endsWith('.wav')) {
      audioSfx[stem] = p;
      entries.push({ key: stem, kind: 'sfx', relPath: p, sizeBytes: 1 });
    } else if (low.endsWith('.ogg')) {
      const cleanName = stem.replace(/_(intro|loop)$/i, '');
      const existing = audioMusic[cleanName] ?? { loop: p };
      if (stem.toLowerCase().endsWith('_intro')) {
        existing.intro = p;
      } else {
        existing.loop = p;
      }
      audioMusic[cleanName] = existing;
      entries.push({ key: stem, kind: 'music', relPath: p, sizeBytes: 1 });
    }
  }

  return {
    version: 1,
    extractedAt: new Date().toISOString(),
    sourceSha256: 'user-folder-pack',
    atlases,
    scrollers,
    gradients,
    audioSfx,
    audioMusic,
    entries,
  };
}

// -----------------------------------------------------------------------------
// Image Decoding Helper
// -----------------------------------------------------------------------------

async function decodeImageBlob(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall through to HTMLImageElement
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// -----------------------------------------------------------------------------
// Directory Picker Types (File System Access API)
// -----------------------------------------------------------------------------

interface FileSystemHandleLike {
  kind: 'file' | 'directory';
  name: string;
}

interface FileSystemFileHandleLike extends FileSystemHandleLike {
  kind: 'file';
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandleLike extends FileSystemHandleLike {
  kind: 'directory';
  values(): AsyncIterable<FileSystemHandleLike>;
}

async function collectDirectoryFiles(
  dirHandle: FileSystemDirectoryHandleLike,
  prefix: string,
  out: Map<string, Blob>
): Promise<void> {
  for await (const entry of dirHandle.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandleLike).getFile();
      out.set(normalizeRelPath(rel), file);
    } else if (entry.kind === 'directory') {
      await collectDirectoryFiles(entry as FileSystemDirectoryHandleLike, rel, out);
    }
  }
}

function pickFolderViaInputFallback(): Promise<Map<string, Blob> | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';

    const cleanup = (): void => {
      input.remove();
    };

    input.onchange = () => {
      const files = input.files;
      if (!files || files.length === 0) {
        cleanup();
        resolve(null);
        return;
      }
      const map = new Map<string, Blob>();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rawRel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        const parts = normalizeRelPath(rawRel).split('/');
        // Strip top-level chosen folder name so paths align with manifest.json
        const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        map.set(rel, f);
      }
      cleanup();
      resolve(map);
    };

    input.oncancel = () => {
      cleanup();
      resolve(null);
    };

    document.body.appendChild(input);
    input.click();
  });
}

// -----------------------------------------------------------------------------
// Main CustomPackLoader Implementation
// -----------------------------------------------------------------------------

/**
 * Decodes Dead Cells skin-LUT-encoded character/boss atlases (`*_default_s.png`)
 * where pixel `(R, G, B <= 4, A > 0)` encodes normalized `(u = R/255, v = G/255)`
 * coordinates into the 2D skin palette LUT. Returns a crisp full-color canvas!
 */
function applySkinLutToImage(
  diffuse: ImageBitmap | HTMLImageElement,
  skinLut: ImageBitmap | HTMLImageElement
): HTMLCanvasElement | ImageBitmap | HTMLImageElement {
  if (typeof document === 'undefined') return diffuse;
  const dw = diffuse.width;
  const dh = diffuse.height;
  const lw = skinLut.width;
  const lh = skinLut.height;
  if (dw <= 0 || dh <= 0 || lw <= 0 || lh <= 0) return diffuse;

  const lutCanvas = document.createElement('canvas');
  lutCanvas.width = lw;
  lutCanvas.height = lh;
  const lCtx = lutCanvas.getContext('2d', { willReadFrequently: true });
  if (!lCtx) return diffuse;
  lCtx.drawImage(skinLut, 0, 0);
  const lutData = lCtx.getImageData(0, 0, lw, lh).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = dw;
  outCanvas.height = dh;
  const ctx = outCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return diffuse;
  ctx.drawImage(diffuse, 0, 0);
  const img = ctx.getImageData(0, 0, dw, dh);
  const px = img.data;

  const scaleX = lw / 256;
  const scaleY = lh / 256;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    const b = px[i + 2];
    if (b > 6) continue; // True-color pixel (not LUT-encoded)
    const r = px[i];
    const g = px[i + 1];
    const lx = Math.min(lw - 1, Math.floor(r * scaleX));
    const ly = Math.min(lh - 1, Math.floor(g * scaleY));
    const li = (ly * lw + lx) * 4;
    px[i] = lutData[li];
    px[i + 1] = lutData[li + 1];
    px[i + 2] = lutData[li + 2];
  }

  ctx.putImageData(img, 0, 0);
  return outCanvas;
}

export class CustomPackLoader implements CustomPackAssetResolver {
  private source: CustomPackStatus['source'] = 'none';
  private manifest: AssetManifest | null = null;
  private devBaseUrl = DEV_PACK_PREFIX;
  private memoryFiles = new Map<string, Blob>();
  private atlasCache = new Map<string, LoadedCustomAtlas | null>();
  private atlasPromises = new Map<string, Promise<LoadedCustomAtlas | null>>();
  private scrollerCache = new Map<string, ImageBitmap | HTMLImageElement | null>();

  getManifest(): AssetManifest | null {
    return this.manifest;
  }

  getStatus(): CustomPackStatus {
    const m = this.manifest;
    if (!m || this.source === 'none') {
      return {
        available: false,
        source: 'none',
        atlasCount: 0,
        audioCount: 0,
        loadedAtlases: [],
      };
    }
    const loadedAtlases: string[] = [];
    for (const [name, atlas] of this.atlasCache.entries()) {
      if (atlas) loadedAtlases.push(name);
    }
    return {
      available: true,
      source: this.source,
      atlasCount: Object.keys(m.atlases).length,
      audioCount: Object.keys(m.audioSfx).length + Object.keys(m.audioMusic).length,
      loadedAtlases,
    };
  }

  /**
   * Auto-detects Vite dev middleware (`/__custom_pack__/status`) first, then
   * falls back to previously cached IndexedDB pack (`krunked_cells_custom_pack_v1`).
   */
  async autoDetect(): Promise<CustomPackStatus> {
    const devOk = await this.detectDevServerPack();
    if (devOk) return this.getStatus();
    await this.restoreFromIndexedDb();
    return this.getStatus();
  }

  async detectDevServerPack(): Promise<boolean> {
    if (typeof fetch !== 'function') return false;
    try {
      const resp = await fetch(`${DEV_PACK_PREFIX}/status`, { cache: 'no-store' });
      if (!resp.ok) return false;
      const status = (await resp.json()) as { available?: boolean; manifestUrl?: string };
      if (!status || !status.available) return false;

      const manifestUrl = status.manifestUrl || `${DEV_PACK_PREFIX}/manifest.json`;
      const mResp = await fetch(manifestUrl, { cache: 'no-store' });
      if (!mResp.ok) return false;
      const manifest = (await mResp.json()) as AssetManifest;
      if (!manifest || typeof manifest !== 'object' || !manifest.atlases) return false;

      this.resetCaches();
      this.devBaseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/')) || DEV_PACK_PREFIX;
      this.manifest = manifest;
      this.source = 'devMiddleware';
      return true;
    } catch {
      return false;
    }
  }

  async restoreFromIndexedDb(): Promise<boolean> {
    try {
      const manifestBlob = await idbGetBlob('manifest.json');
      if (manifestBlob) {
        const text = await manifestBlob.text();
        const parsed = JSON.parse(text) as AssetManifest;
        if (parsed && parsed.atlases) {
          this.resetCaches();
          this.manifest = parsed;
          this.source = 'indexedDb';
          return true;
        }
      }
      const keys = await idbGetAllKeys();
      if (keys.length > 0) {
        this.resetCaches();
        this.manifest = buildSyntheticManifest(keys);
        this.source = 'indexedDb';
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Opens interactive folder picker (`showDirectoryPicker` with `<input webkitdirectory>`
   * fallback) and persists the imported pack into IndexedDB (`krunked_cells_custom_pack_v1`).
   */
  async pickCustomPackFolder(): Promise<CustomPackStatus> {
    let files: Map<string, Blob> | null = null;

    const win = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
    if (win && typeof win.showDirectoryPicker === 'function') {
      try {
        const picker = win.showDirectoryPicker as () => Promise<FileSystemDirectoryHandleLike>;
        const dirHandle = await picker();
        files = new Map<string, Blob>();
        await collectDirectoryFiles(dirHandle, '', files);
      } catch {
        // User cancelled or browser blocked showDirectoryPicker — return current status cleanly
        return this.getStatus();
      }
    } else {
      files = await pickFolderViaInputFallback();
    }

    if (!files || files.size === 0) {
      return this.getStatus();
    }

    let manifest: AssetManifest | null = null;
    const manifestBlob = files.get('manifest.json');
    if (manifestBlob) {
      try {
        manifest = JSON.parse(await manifestBlob.text()) as AssetManifest;
      } catch {
        manifest = null;
      }
    }
    if (!manifest) {
      manifest = buildSyntheticManifest(Array.from(files.keys()));
      files.set(
        'manifest.json',
        new Blob([JSON.stringify(manifest)], { type: 'application/json' })
      );
    }

    this.resetCaches();
    this.memoryFiles = files;
    this.manifest = manifest;
    this.source = 'folderPicker';

    // Persist asynchronously to IndexedDB for reload survival
    void idbPutAll(files);

    return this.getStatus();
  }

  async clearCachedPack(): Promise<void> {
    this.resetCaches();
    this.manifest = null;
    this.source = 'none';
    this.memoryFiles.clear();
    await idbClear();
  }

  // ---------------------------------------------------------------------------
  // CustomPackAssetResolver Interface
  // ---------------------------------------------------------------------------

  async fetchBlob(relPath: string): Promise<Blob | null> {
    const clean = normalizeRelPath(relPath);
    if (!clean) return null;

    if (this.source === 'folderPicker') {
      const mem = this.memoryFiles.get(clean);
      if (mem) return mem;
      // Case-insensitive fallback lookup
      const low = clean.toLowerCase();
      for (const [k, v] of this.memoryFiles.entries()) {
        if (k.toLowerCase() === low) return v;
      }
      return null;
    }

    if (this.source === 'indexedDb') {
      const cached = this.memoryFiles.get(clean);
      if (cached) return cached;
      const blob = await idbGetBlob(clean);
      if (blob) this.memoryFiles.set(clean, blob);
      return blob;
    }

    if (this.source === 'devMiddleware' && typeof fetch === 'function') {
      try {
        const resp = await fetch(`${this.devBaseUrl}/${clean}`);
        if (!resp.ok) return null;
        return await resp.blob();
      } catch {
        return null;
      }
    }

    return null;
  }

  async fetchText(relPath: string): Promise<string | null> {
    const blob = await this.fetchBlob(relPath);
    if (!blob) return null;
    return await blob.text();
  }

  // ---------------------------------------------------------------------------
  // Atlas, Normal Map, Tracks & Scroller Loaders (Per-Key Fallback Friendly)
  // ---------------------------------------------------------------------------

  getLoadedAtlas(name: string): LoadedCustomAtlas | null {
    return this.atlasCache.get(name) ?? null;
  }

  async loadAtlas(name: string): Promise<LoadedCustomAtlas | null> {
    if (this.atlasCache.has(name)) {
      return this.atlasCache.get(name) ?? null;
    }
    const pending = this.atlasPromises.get(name);
    if (pending) return pending;

    const task = this.loadAtlasInternal(name);
    this.atlasPromises.set(name, task);
    const result = await task;
    this.atlasPromises.delete(name);
    this.atlasCache.set(name, result);
    return result;
  }

  private async loadAtlasInternal(name: string): Promise<LoadedCustomAtlas | null> {
    const m = this.manifest;
    if (!m) return null;
    const entry = m.atlases[name];
    if (!entry) return null;

    const atlasText = await this.fetchText(entry.atlasFile);
    if (!atlasText) return null;
    const parsedAtlas = parseLibGdxAtlas(atlasText);
    const dir = entry.atlasFile.includes('/')
      ? entry.atlasFile.slice(0, entry.atlasFile.lastIndexOf('/') + 1)
      : '';

    let skinLut: ImageBitmap | HTMLImageElement | null = null;
    if (entry.skinFile) {
      const skinBlob = await this.fetchBlob(entry.skinFile);
      if (skinBlob) {
        skinLut = await decodeImageBlob(skinBlob);
      }
    }

    const pages: CustomAtlasPageTextures[] = [];
    for (let i = 0; i < parsedAtlas.pages.length; i++) {
      const pageMeta = parsedAtlas.pages[i];
      const diffusePath = entry.pages[i] ?? `${dir}${pageMeta.fileName}`;
      // Only fetch normal map if explicitly listed in manifest.normalPages (avoids HTTP 404s!)
      const expectedNormal = diffusePath.replace(/\.png$/i, '_n.png');
      const normalPath =
        entry.normalPages[i] ??
        entry.normalPages.find((np) => np.toLowerCase() === expectedNormal.toLowerCase()) ??
        null;

      const diffBlob = await this.fetchBlob(diffusePath);
      if (!diffBlob) continue;
      const rawDiffuse = await decodeImageBlob(diffBlob);
      if (!rawDiffuse) continue;
      const diffuse = skinLut ? applySkinLutToImage(rawDiffuse, skinLut) : rawDiffuse;

      let normal: ImageBitmap | HTMLImageElement | null = null;
      if (normalPath) {
        const normBlob = await this.fetchBlob(normalPath);
        if (normBlob) {
          normal = await decodeImageBlob(normBlob);
        }
      }

      pages.push({
        diffuse,
        normal,
        width: diffuse.width || pageMeta.width,
        height: diffuse.height || pageMeta.height,
      });
    }

    if (pages.length === 0) return null;

    let tracks: ParsedTracksData | null = null;
    if (entry.tracksFile) {
      const trackText = await this.fetchText(entry.tracksFile);
      if (trackText) {
        tracks = parseTracksJson(trackText);
      }
    }

    return {
      name,
      atlas: parsedAtlas,
      pages,
      tracks,
    };
  }

  /**
   * Resolves a region + bone tracks from a loaded custom atlas, returning null
   * if absent so the renderer cleanly falls back per-key to ProceduralAtlas.
   */
  resolveCustomRegion(
    atlasName: string,
    regionKey: string
  ): {
    atlas: LoadedCustomAtlas;
    region: LibGdxRegion;
    page: CustomAtlasPageTextures;
    bones: Record<string, BoneOffset> | null;
  } | null {
    const loaded = this.atlasCache.get(atlasName);
    if (!loaded) return null;
    const region = loaded.atlas.regions.get(regionKey);
    if (!region) return null;
    const page = loaded.pages[region.pageIndex];
    if (!page) return null;
    const bones =
      loaded.tracks?.byAnimFrame.get(regionKey) ??
      loaded.tracks?.byAnimFrame.get(region.name) ??
      loaded.tracks?.defaultBones ??
      null;
    return { atlas: loaded, region, page, bones };
  }

  async loadScrollerImage(themeKey: string): Promise<ImageBitmap | HTMLImageElement | null> {
    if (this.scrollerCache.has(themeKey)) {
      return this.scrollerCache.get(themeKey) ?? null;
    }
    const m = this.manifest;
    if (!m) return null;
    const list = m.scrollers[themeKey];
    if (!list || list.length === 0) {
      this.scrollerCache.set(themeKey, null);
      return null;
    }
    const blob = await this.fetchBlob(list[0]);
    if (!blob) {
      this.scrollerCache.set(themeKey, null);
      return null;
    }
    const img = await decodeImageBlob(blob);
    this.scrollerCache.set(themeKey, img);
    return img;
  }

  private resetCaches(): void {
    this.atlasCache.clear();
    this.atlasPromises.clear();
    this.scrollerCache.clear();
  }
}
