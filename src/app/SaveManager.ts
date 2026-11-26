import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_CONTROLLER_SETTINGS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_RENDER_SETTINGS,
  MAX_BOSS_CELLS,
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  createDefaultMetaSnapshot,
  createDefaultSaveData,
  type ArtPackMode,
  type AudioSettings,
  type ControllerSettings,
  type GamepadGlyphStyle,
  type GamepadLayoutPreset,
  type KeyBindings,
  type LightingQuality,
  type MetaSnapshot,
  type RenderSettings,
  type SaveData,
  type TargetFps,
  type TouchControlsMode,
} from '../contracts';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asTargetFps(v: unknown, fallback: TargetFps): TargetFps {
  return v === 30 || v === 60 || v === 120 ? v : fallback;
}

function asLightingQuality(v: unknown, fallback: LightingQuality): LightingQuality {
  return v === 'low' || v === 'medium' || v === 'high' ? v : fallback;
}

function asArtPackMode(v: unknown, fallback: ArtPackMode): ArtPackMode {
  return v === 'builtin' || v === 'custom' ? v : fallback;
}

function asGamepadLayoutPreset(v: unknown, fallback: GamepadLayoutPreset): GamepadLayoutPreset {
  return v === 'standard' || v === 'classic' || v === 'nintendo' ? v : fallback;
}

function asGamepadGlyphStyle(v: unknown, fallback: GamepadGlyphStyle): GamepadGlyphStyle {
  return v === 'auto' || v === 'xbox' || v === 'playstation' || v === 'nintendo' ? v : fallback;
}

function asTouchControlsMode(v: unknown, fallback: TouchControlsMode): TouchControlsMode {
  return v === 'auto' || v === 'always' || v === 'off' ? v : fallback;
}

function sanitizeControllerSettings(raw: unknown): ControllerSettings {
  const def = DEFAULT_CONTROLLER_SETTINGS;
  if (!isRecord(raw)) return { ...def };
  return {
    deadzone: clampNum(raw.deadzone, 0.08, 0.5, def.deadzone),
    rumbleEnabled: asBool(raw.rumbleEnabled, def.rumbleEnabled),
    rumbleIntensity: clampNum(raw.rumbleIntensity, 0, 1, def.rumbleIntensity),
    layoutPreset: asGamepadLayoutPreset(raw.layoutPreset, def.layoutPreset),
    glyphStyle: asGamepadGlyphStyle(raw.glyphStyle, def.glyphStyle),
    autoPauseOnDisconnect: asBool(raw.autoPauseOnDisconnect, def.autoPauseOnDisconnect),
    touchMode: asTouchControlsMode(raw.touchMode, def.touchMode),
    touchOpacity: clampNum(raw.touchOpacity, 0.2, 0.85, def.touchOpacity),
    touchScale: clampNum(raw.touchScale, 0.75, 1.35, def.touchScale),
  };
}

function sanitizeMeta(raw: unknown): MetaSnapshot {
  const def = createDefaultMetaSnapshot();
  if (!isRecord(raw)) return def;

  const unlockedSet = new Set<string>(def.unlockedBlueprints);
  if (Array.isArray(raw.unlockedBlueprints)) {
    for (const item of raw.unlockedBlueprints) {
      if (typeof item === 'string' && item.trim().length > 0 && item.length <= 64) {
        unlockedSet.add(item);
      }
    }
  }

  const progress: Record<string, number> = {};
  if (isRecord(raw.blueprintProgress)) {
    for (const [k, val] of Object.entries(raw.blueprintProgress)) {
      if (k.length > 0 && k.length <= 64 && typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        progress[k] = Math.floor(val);
      }
    }
  }

  const rawRunes = isRecord(raw.runesUnlocked) ? raw.runesUnlocked : {};

  return {
    bossCellsUnlocked: clampInt(raw.bossCellsUnlocked, 0, MAX_BOSS_CELLS, def.bossCellsUnlocked),
    flaskTier: clampInt(raw.flaskTier, 1, 4, def.flaskTier),
    goldReserveTier: clampInt(raw.goldReserveTier, 0, 4, def.goldReserveTier),
    randomStarterUnlocked: asBool(raw.randomStarterUnlocked, def.randomStarterUnlocked),
    recycleUnlocked: asBool(raw.recycleUnlocked, def.recycleUnlocked),
    unlockedBlueprints: Array.from(unlockedSet),
    blueprintProgress: progress,
    runesUnlocked: {
      vine: asBool(rawRunes.vine, def.runesUnlocked.vine),
      teleport: asBool(rawRunes.teleport, def.runesUnlocked.teleport),
      ram: asBool(rawRunes.ram, def.runesUnlocked.ram),
      spider: asBool(rawRunes.spider, def.runesUnlocked.spider),
    },
    totalRuns: clampInt(raw.totalRuns, 0, 1_000_000, def.totalRuns),
    totalKills: clampInt(raw.totalKills, 0, 100_000_000, def.totalKills),
    bestClearTicks:
      typeof raw.bestClearTicks === 'number' && Number.isFinite(raw.bestClearTicks) && raw.bestClearTicks > 0
        ? Math.floor(raw.bestClearTicks)
        : null,
  };
}

function sanitizeRenderSettings(raw: unknown): RenderSettings {
  const def = DEFAULT_RENDER_SETTINGS;
  if (!isRecord(raw)) return { ...def };
  return {
    targetFps: asTargetFps(raw.targetFps, def.targetFps),
    snapToSimRate: asBool(raw.snapToSimRate, def.snapToSimRate),
    lightingQuality: asLightingQuality(raw.lightingQuality, def.lightingQuality),
    bloomEnabled: asBool(raw.bloomEnabled, def.bloomEnabled),
    screenShakeScale: clampNum(raw.screenShakeScale, 0, 2, def.screenShakeScale),
    artPackMode: asArtPackMode(raw.artPackMode, def.artPackMode),
  };
}

function sanitizeAudioSettings(raw: unknown): AudioSettings {
  const def = DEFAULT_AUDIO_SETTINGS;
  if (!isRecord(raw)) return { ...def };
  return {
    masterVolume: clampNum(raw.masterVolume, 0, 1, def.masterVolume),
    musicVolume: clampNum(raw.musicVolume, 0, 1, def.musicVolume),
    sfxVolume: clampNum(raw.sfxVolume, 0, 1, def.sfxVolume),
    muted: asBool(raw.muted, def.muted),
  };
}

function sanitizeKeyBindings(raw: unknown): KeyBindings {
  const def = DEFAULT_KEY_BINDINGS;
  if (!isRecord(raw)) return { ...def };
  const result: KeyBindings = { ...def };
  for (const key of Object.keys(def) as (keyof KeyBindings)[]) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim().length > 0 && val.length <= 32) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Pure, deterministic parser and schema validator for persisted SaveData.
 * Recovers gracefully from malformed JSON, missing fields, out-of-range numbers,
 * or schema version mismatches.
 */
export function parseSaveData(rawText: string | null | undefined): SaveData {
  if (!rawText || typeof rawText !== 'string') {
    return createDefaultSaveData();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return createDefaultSaveData();
  }
  if (!isRecord(parsed)) {
    return createDefaultSaveData();
  }

  const meta = sanitizeMeta(parsed.meta);
  const selectedBossCells = clampInt(parsed.selectedBossCells, 0, meta.bossCellsUnlocked, 0);
  const lastSeed = clampInt(parsed.lastSeed, 1, 0x7fffffff, 133742);

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    meta,
    selectedBossCells,
    renderSettings: sanitizeRenderSettings(parsed.renderSettings),
    audioSettings: sanitizeAudioSettings(parsed.audioSettings),
    keyBindings: sanitizeKeyBindings(parsed.keyBindings),
    controllerSettings: sanitizeControllerSettings(parsed.controllerSettings),
    hasActiveRun: asBool(parsed.hasActiveRun, false),
    lastSeed,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SaveManager {
  private storage: StorageLike | null;
  private cached: SaveData;

  constructor(storage?: StorageLike | null) {
    if (storage !== undefined) {
      this.storage = storage;
    } else if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      try {
        this.storage = globalThis.localStorage;
      } catch {
        this.storage = null;
      }
    } else {
      this.storage = null;
    }
    this.cached = this.load();
  }

  load(): SaveData {
    if (!this.storage) {
      this.cached = createDefaultSaveData();
      return this.clone(this.cached);
    }
    try {
      const raw = this.storage.getItem(SAVE_KEY);
      this.cached = parseSaveData(raw);
    } catch {
      this.cached = createDefaultSaveData();
    }
    return this.clone(this.cached);
  }

  save(data: SaveData): SaveData {
    const validated = parseSaveData(JSON.stringify(data));
    this.cached = validated;
    if (this.storage) {
      try {
        this.storage.setItem(SAVE_KEY, JSON.stringify(validated));
      } catch {
        // Ignore quota / private-mode storage errors
      }
    }
    return this.clone(validated);
  }

  getSnapshot(): SaveData {
    return this.clone(this.cached);
  }

  reset(): SaveData {
    this.cached = createDefaultSaveData();
    if (this.storage) {
      try {
        this.storage.removeItem(SAVE_KEY);
      } catch {
        // Ignore storage removal errors
      }
    }
    return this.clone(this.cached);
  }

  private clone(data: SaveData): SaveData {
    return parseSaveData(JSON.stringify(data));
  }
}
