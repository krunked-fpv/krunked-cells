import type {
  AudioEngineAPI,
  AudioSettings,
  BiomeId,
  CustomPackAssetResolver,
  SimEvent,
  UiClickKind,
} from '../contracts';
import { DEFAULT_AUDIO_SETTINGS, VIEWPORT_W } from '../contracts';
import { SynthMusic } from './SynthMusic';
import { SynthSfx } from './SynthSfx';

const CELL_SCALE_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28] as const;
const CELL_COMBO_WINDOW_SEC = 1.25;

const CORE_CUSTOM_SFX_KEYS: readonly string[] = [
  'attackSwing',
  'sword',
  'broadsword',
  'dagger',
  'mace',
  'spear',
  'rapier',
  'whip',
  'bow',
  'iceBow',
  'knife',
  'fireball',
  'shield',
  'hitImpact',
  'hitBlade',
  'hitBlood',
  'hitFire',
  'hitHammer',
  'hitPoison',
  'critImpact',
  'parryStart',
  'parrySuccess',
  'parryFail',
  'shieldBlock',
  'dodgeRoll',
  'diveSlamImpact',
  'doorSmash',
  'enemyDeath',
  'bossPhaseShift',
  'bossEngage',
  'bossVictory',
  'cellCollect',
  'goldCollect',
  'scrollPickup',
  'itemPickup',
  'curseTriggered',
  'curseCleared',
  'flaskDrink',
  'flaskEmpty',
  'playerDamaged',
  'playerDeath',
  'rallyRecovered',
  'statusProc',
  'footstep',
  'jump',
  'airJump',
  'land',
  'teleport',
  'skillCast',
  'grenadeExplode',
  'grenadeFire',
  'grenadeIce',
  'turretDeploy',
  'waveOfDenial',
  'perfectKillStreak',
  'perfectDodge',
  'fallStun',
  'freezeShatter',
  'bleedBurst',
  'lightningArc',
  'shopReroll',
  'select',
  'confirm',
  'cancel',
  'error',
  'ui_start',
  'ui_unlock',
];

const BLEED_WEAPONS = new Set(['Bleeder', 'ThrowingKnife', 'BleedShield', 'KnifeDance']);
const HEAVY_WEAPONS = new Set(['StunMace', 'BroadSword']);
const FIRE_WEAPONS = new Set(['Fireball', 'FireGrenade']);

function isBossBiome(biomeId: BiomeId | null): boolean {
  return biomeId === 'Bridge' || biomeId === 'TopClockTower' || biomeId === 'Throne';
}

function isBlockedCustomSfxPath(eventType: string, relPath: string): boolean {
  const lower = relPath.toLowerCase();
  // Runtime guard: cellSpawn must NEVER blast the elite spawn fanfare
  if (eventType === 'cellSpawn' && lower.includes('jingle_elite_pop')) {
    return true;
  }
  // Runtime guard: enemyTelegraph must NEVER play the slow lore room ping
  if (eventType === 'enemyTelegraph' && lower.includes('lore_room_ping')) {
    return true;
  }
  return false;
}

function classifyHitImpactColor(color: string): 'fire' | 'poison' | 'blood' | null {
  const c = color.trim().toLowerCase();
  if (c === '#f97316' || c === '#ff6b1a' || c === '#ea580c' || c === '#fb923c' || c === '#ff7a2e') {
    return 'fire';
  }
  if (c === '#22c55e' || c === '#4ade80' || c === '#84cc16' || c === '#16a34a' || c === '#10b981') {
    return 'poison';
  }
  if (c === '#dc2626' || c === '#b91c1c' || c === '#991b1b' || c === '#e11d48') {
    return 'blood';
  }
  return null;
}

function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * Procedural impulse response generator for a cathedral / subterranean cavern acoustic space.
 */
function createCavernReverbBuffer(ctx: AudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * 2.2); // 2.2s reverb tail
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const earlyDelays = [0.012, 0.027, 0.043, 0.068, 0.095, 0.124];
  const earlyGains = [0.7, 0.55, 0.42, 0.35, 0.28, 0.2];

  for (let ch = 0; ch < 2; ch++) {
    const data = ch === 0 ? left : right;
    const sign = ch === 0 ? 1 : -1;
    const decay = 3.2;

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const noise = Math.random() * 2 - 1;
      const env = Math.exp(-decay * t);
      const damp = Math.exp(-1.5 * t);
      data[i] = noise * env * damp * 0.35;
    }

    for (let j = 0; j < earlyDelays.length; j++) {
      const delaySec = earlyDelays[j] + ch * 0.003 * sign;
      const sample = Math.floor(delaySec * sampleRate);
      if (sample < length) {
        data[sample] += earlyGains[j] * 0.5;
        if (sample + 1 < length) {
          data[sample + 1] -= earlyGains[j] * 0.25;
        }
      }
    }
  }

  return buffer;
}

/**
 * Main Web Audio Sound & Music Engine for Krunked Cells.
 * Implements AudioEngineAPI:
 * - Autoplay-safe initialization with zero-latency unlock()
 * - Headless Node safety: gracefully no-ops without error in non-browser runtimes
 * - Master, Music, SFX GainNodes + Parry transient ducking bus + Mute control
 * - Stereo panning scaled by distance from listenerX (VIEWPORT_W)
 * - Procedural cathedral/cavern ConvolverNode reverb send
 * - Anti-spam polish: micro-cooldown (25ms), polyphony cap (4 voices), pitch jitter (0.94..1.06)
 * - Ascending pentatonic/major Cell Pickup Combo Scale in both Custom Pack & Built-In modes
 * - Original procedural baroque-dark-synth biome + title soundtracks & tactile SimEvent SFX
 * - Dual-Mode Owned Custom Pack Streaming with eager core SFX preloading, sample-accurate
 *   intro -> loop scheduling, proper per-boss theme precedence, and automatic synth fallback.
 */
export class AudioEngine implements AudioEngineAPI {
  private ctx: AudioContext | null = null;
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };

  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private nonParrySfxGain: GainNode | null = null;
  private convolverNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private reverbSendGain: GainNode | null = null;

  private synthMusic = new SynthMusic();
  private synthSfx = new SynthSfx();

  private currentBiome: BiomeId | null = null;
  private isBoss = false;
  private isTitleMusic = false;
  private musicRequestToken = 0;
  private lastAttackWeaponId: string | null = null;

  // Ascending-pitch Cell Pickup Combo state (Custom Pack mode)
  private cellComboCount = 0;
  private lastCellCollectTime = -999;

  // Built-in atmospheric Title Screen music scheduler
  private titleSynthGain: GainNode | null = null;
  private titleSynthTimer: number | null = null;
  private titleSynthStep = 0;
  private titleSynthNextTime = 0;
  private titleSynthActive = false;

  // Custom pack streaming state
  private customPackResolver: CustomPackAssetResolver | null = null;
  private customPackActive = false;
  private customSfxCache = new Map<string, AudioBuffer>();
  private loadingCustomSfxPaths = new Set<string>();
  private preloadedCustomSfx = false;
  private customMusicGain: GainNode | null = null;
  private customMusicIntroSource: AudioBufferSourceNode | null = null;
  private customMusicLoopSource: AudioBufferSourceNode | null = null;
  private customSfxCooldowns = new Map<string, number>();
  private customActiveVoices = new Map<string, Set<AudioBufferSourceNode>>();

  public init(settings: AudioSettings = DEFAULT_AUDIO_SETTINGS): void {
    this.settings = { ...settings };
    this.ensureContext();
  }

  public async unlock(): Promise<void> {
    this.ensureContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Autoplay unlock retry guard
      }
    }
    if (this.customPackActive && !this.preloadedCustomSfx) {
      this.preloadCoreCustomSfx();
    }
    if (this.isTitleMusic) {
      this.setTitleMusic();
    } else if (this.currentBiome !== null) {
      this.setBiomeMusic(this.currentBiome, this.isBoss);
    }
  }

  public updateSettings(settings: AudioSettings): void {
    this.settings = { ...settings };
    if (!this.ctx || !this.masterGain || !this.musicGain || !this.sfxGain) return;

    const t = this.ctx.currentTime;
    if (this.settings.muted) {
      this.masterGain.gain.setTargetAtTime(0, t, 0.03);
    } else {
      this.masterGain.gain.setTargetAtTime(this.settings.masterVolume, t, 0.03);
    }
    this.musicGain.gain.setTargetAtTime(this.settings.musicVolume, t, 0.03);
    this.sfxGain.gain.setTargetAtTime(this.settings.sfxVolume, t, 0.03);
  }

  public setCustomPackResolver(resolver: CustomPackAssetResolver | null, active: boolean): void {
    const wasActive = this.customPackActive;
    const resolverChanged = this.customPackResolver !== resolver;
    this.customPackResolver = resolver;
    this.customPackActive = active && resolver !== null;

    if (resolverChanged) {
      this.preloadedCustomSfx = false;
      this.loadingCustomSfxPaths.clear();
    }

    if (this.customPackActive) {
      this.ensureContext();
      this.preloadCoreCustomSfx();
    }

    if (wasActive !== this.customPackActive) {
      if (this.isTitleMusic) {
        this.setTitleMusic();
      } else if (this.currentBiome !== null) {
        this.setBiomeMusic(this.currentBiome, this.isBoss);
      }
    }
  }

  public setTitleMusic(): void {
    this.isTitleMusic = true;
    this.currentBiome = null;
    this.isBoss = false;

    this.ensureContext();
    if (!this.ctx || !this.musicGain) return;

    if (this.customPackActive && this.customPackResolver) {
      const scheduledCustom = this.tryPlayCustomMusicKey(['title', 'Prologue', 'ambient', 'PrisonStart']);
      if (scheduledCustom) {
        this.synthMusic.stop();
        this.stopBuiltinTitleMusic();
        return;
      }
    }

    this.musicRequestToken++;
    this.stopCustomMusic();
    this.synthMusic.stop();
    this.startBuiltinTitleMusic();
  }

  public setBiomeMusic(biomeId: BiomeId, isBoss: boolean): void {
    this.isTitleMusic = false;
    this.currentBiome = biomeId;
    this.isBoss = isBoss;

    this.ensureContext();
    if (!this.ctx || !this.musicGain) return;

    this.stopBuiltinTitleMusic();

    // Check if custom pack provides audio music for this track
    if (this.customPackActive && this.customPackResolver) {
      const scheduledCustom = this.tryPlayCustomMusic(biomeId, isBoss);
      if (scheduledCustom) {
        this.synthMusic.stop();
        return;
      }
    }

    // Stop custom music sources if active and fallback to procedural synth music
    this.musicRequestToken++;
    this.stopCustomMusic();
    this.synthMusic.setBiomeMusic(this.ctx, this.musicGain, biomeId, isBoss);
  }

  public ingestEvents(events: readonly SimEvent[], listenerX: number, listenerY: number): void {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain) return;

    for (const event of events) {
      if (event.type === 'attackSwing') {
        this.lastAttackWeaponId = event.weaponId;
      } else if (event.type === 'biomeTransition') {
        this.setBiomeMusic(event.to, false);
      } else if (event.type === 'bossEngage') {
        if (this.currentBiome && isBossBiome(this.currentBiome) && !this.isBoss) {
          this.setBiomeMusic(this.currentBiome, true);
        }
      } else if (event.type === 'parrySuccess') {
        this.triggerParryDuck();
      }

      const [x, y] = this.resolveEventPosition(event, listenerX, listenerY);
      const dx = x - listenerX;
      const halfW = VIEWPORT_W * 0.5;
      const pan = Math.max(-1, Math.min(1, dx / halfW));
      const dist = Math.hypot(dx, y - listenerY);
      const distVol = Math.max(0.25, Math.min(1.0, 1.0 - (dist / (VIEWPORT_W * 1.5)) * 0.75));

      const sfxTarget =
        event.type === 'parrySuccess' ? this.sfxGain : (this.nonParrySfxGain ?? this.sfxGain);

      // Attempt custom pack SFX playback if active
      if (this.customPackActive && this.customPackResolver) {
        const playedCustom = this.tryPlayCustomSfx(event, pan, distVol, sfxTarget);
        if (playedCustom) continue;
      }

      // Default built-in procedural synthesis
      const reverbTarget = this.reverbSendGain ?? sfxTarget;
      this.synthSfx.playEvent(this.ctx, event, pan, distVol, sfxTarget, reverbTarget);
    }
  }

  public playUiClick(kind: UiClickKind = 'select'): void {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain) return;

    if (this.customPackActive && this.customPackResolver) {
      const playedCustom = this.tryPlayCustomUiClick(kind);
      if (playedCustom) return;
    }

    this.synthSfx.playUiClick(this.ctx, kind, this.sfxGain);
  }

  public dispose(): void {
    this.musicRequestToken++;
    this.synthMusic.dispose();
    this.synthSfx.reset();
    this.stopBuiltinTitleMusic();
    this.stopCustomMusic();
    this.customSfxCache.clear();
    this.loadingCustomSfxPaths.clear();
    this.preloadedCustomSfx = false;
    this.customActiveVoices.clear();
    this.customSfxCooldowns.clear();
    this.cellComboCount = 0;
    this.lastCellCollectTime = -999;
    this.lastAttackWeaponId = null;

    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.nonParrySfxGain = null;
    this.convolverNode = null;
    this.reverbGain = null;
    this.reverbSendGain = null;
  }

  // --- Internal Audio Graph Management ---

  private ensureContext(): void {
    if (this.ctx) return;

    const AudioContextClass =
      typeof window !== 'undefined'
        ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : null;

    if (!AudioContextClass) return;

    try {
      this.ctx = new AudioContextClass();
      const t = this.ctx.currentTime;

      // Master bus
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.settings.muted ? 0 : this.settings.masterVolume, t);
      this.masterGain.connect(this.ctx.destination);

      // Music bus
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(this.settings.musicVolume, t);
      this.musicGain.connect(this.masterGain);

      // SFX bus + duckable non-parry sub-bus so parrySuccess commands the room
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.setValueAtTime(this.settings.sfxVolume, t);
      this.sfxGain.connect(this.masterGain);

      this.nonParrySfxGain = this.ctx.createGain();
      this.nonParrySfxGain.gain.setValueAtTime(1.0, t);
      this.nonParrySfxGain.connect(this.sfxGain);

      // Procedural Cathedral/Cavern Reverb Send
      try {
        this.convolverNode = this.ctx.createConvolver();
        this.convolverNode.buffer = createCavernReverbBuffer(this.ctx);

        this.reverbGain = this.ctx.createGain();
        this.reverbGain.gain.setValueAtTime(0.25, t);
        this.convolverNode.connect(this.reverbGain);
        this.reverbGain.connect(this.masterGain);

        this.reverbSendGain = this.ctx.createGain();
        this.reverbSendGain.gain.setValueAtTime(0.2, t);
        this.reverbSendGain.connect(this.convolverNode);
      } catch {
        this.reverbSendGain = this.sfxGain;
      }
    } catch {
      this.ctx = null;
    }
  }

  private triggerParryDuck(): void {
    if (!this.ctx || this.ctx.state === 'suspended') return;
    const t = this.ctx.currentTime;

    if (this.nonParrySfxGain) {
      try {
        this.nonParrySfxGain.gain.cancelScheduledValues(t);
        this.nonParrySfxGain.gain.setValueAtTime(0.22, t);
        this.nonParrySfxGain.gain.setValueAtTime(0.22, t + 0.042);
        this.nonParrySfxGain.gain.linearRampToValueAtTime(1.0, t + 0.16);
      } catch {
        // ignore
      }
    }

    if (this.musicGain) {
      try {
        const baseVol = Math.max(0.0001, this.settings.musicVolume);
        const duckVol = Math.max(0.0001, baseVol * 0.34);
        this.musicGain.gain.cancelScheduledValues(t);
        this.musicGain.gain.setValueAtTime(duckVol, t);
        this.musicGain.gain.setValueAtTime(duckVol, t + 0.045);
        this.musicGain.gain.linearRampToValueAtTime(baseVol, t + 0.22);
      } catch {
        // ignore
      }
    }
  }

  private resolveEventPosition(
    event: SimEvent,
    listenerX: number,
    listenerY: number
  ): [number, number] {
    if ('x' in event && 'y' in event) {
      return [(event as { x: number }).x, (event as { y: number }).y];
    }
    if (event.type === 'teleport') {
      return [event.toX, event.toY];
    }
    if (event.type === 'lightningArc' && event.points.length > 0) {
      const mid = event.points[Math.floor(event.points.length / 2)] ?? event.points[0]!;
      return [mid.x, mid.y];
    }
    return [listenerX, listenerY];
  }

  private advanceCellComboRate(nowSec: number): number {
    if (nowSec - this.lastCellCollectTime <= CELL_COMBO_WINDOW_SEC) {
      this.cellComboCount = Math.min(CELL_SCALE_SEMITONES.length - 1, this.cellComboCount + 1);
    } else {
      this.cellComboCount = 0;
    }
    this.lastCellCollectTime = nowSec;
    const semitones = CELL_SCALE_SEMITONES[this.cellComboCount] ?? 0;
    return Math.pow(2, semitones / 12);
  }

  // --- Atmospheric Built-In Title Screen Synth ---

  private startBuiltinTitleMusic(): void {
    if (!this.ctx || !this.musicGain) return;
    if (this.ctx.state === 'suspended') return;
    if (this.titleSynthActive) return;

    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.linearRampToValueAtTime(0.85, ctx.currentTime + 1.4);
    bus.connect(this.musicGain);

    this.titleSynthGain = bus;
    this.titleSynthStep = 0;
    this.titleSynthNextTime = ctx.currentTime + 0.08;
    this.titleSynthActive = true;

    // Haunting brooding D-minor gothic prologue motif (32 steps @ 68 BPM)
    const arpNotes: (number | null)[] = [
      50, null, 57, null, 62, null, 65, null,
      64, null, 62, null, 57, null, null, null,
      46, null, 53, null, 58, null, 62, null,
      60, null, 57, null, 55, null, 52, null,
    ];
    const chords: Record<number, number[]> = {
      0: [38, 45, 50, 53], // Dm
      8: [43, 50, 55, 58], // Gm
      16: [46, 53, 58, 62], // Bbmaj
      24: [45, 52, 57, 61], // A (harmonic minor tension)
    };

    const stepDur = 60 / 68 / 2; // 8th notes (~0.44s)
    const intervalFn = typeof window !== 'undefined' ? window.setInterval : setInterval;
    this.titleSynthTimer = intervalFn(() => {
      if (!this.titleSynthActive || !this.ctx || this.ctx.state === 'suspended' || !this.titleSynthGain) {
        return;
      }
      while (this.titleSynthNextTime < this.ctx.currentTime + 0.16) {
        const t = this.titleSynthNextTime;
        const step = this.titleSynthStep;

        const note = arpNotes[step];
        if (note !== null && note !== undefined) {
          this.scheduleTitlePluck(this.ctx, this.titleSynthGain, midiToFreq(note), t, stepDur * 2.2);
        }

        const chord = chords[step];
        if (chord) {
          this.scheduleTitlePad(this.ctx, this.titleSynthGain, chord, t, stepDur * 8.2);
        }

        this.titleSynthNextTime += stepDur;
        this.titleSynthStep = (this.titleSynthStep + 1) % arpNotes.length;
      }
    }, 35) as unknown as number;
  }

  private scheduleTitlePluck(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    try {
      const osc = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      osc.type = 'triangle';
      harmonic.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);
      harmonic.frequency.setValueAtTime(freq * 2.002, time);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq * 4.2, time);
      filter.frequency.exponentialRampToValueAtTime(freq * 1.15, time + 0.32);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(0.16, time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

      osc.connect(filter);
      harmonic.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      if (this.reverbSendGain) {
        gain.connect(this.reverbSendGain);
      }

      osc.start(time);
      harmonic.start(time);
      osc.stop(time + duration + 0.05);
      harmonic.stop(time + duration + 0.05);
    } catch {
      // ignore
    }
  }

  private scheduleTitlePad(
    ctx: AudioContext,
    out: AudioNode,
    notes: number[],
    time: number,
    duration: number
  ): void {
    try {
      for (const note of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(midiToFreq(note), time);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(520, time);
        filter.Q.value = 1.2;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.045, time + 0.7);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc.start(time);
        osc.stop(time + duration + 0.08);
      }
    } catch {
      // ignore
    }
  }

  private stopBuiltinTitleMusic(): void {
    this.titleSynthActive = false;
    if (this.titleSynthTimer !== null) {
      clearInterval(this.titleSynthTimer);
      this.titleSynthTimer = null;
    }
    if (this.titleSynthGain) {
      const oldGain = this.titleSynthGain;
      this.titleSynthGain = null;
      if (this.ctx) {
        try {
          oldGain.gain.cancelScheduledValues(this.ctx.currentTime);
          oldGain.gain.setValueAtTime(Math.max(0.0001, oldGain.gain.value), this.ctx.currentTime);
          oldGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4);
          const cleanupTimer = setTimeout(() => {
            try {
              oldGain.disconnect();
            } catch {
              // ignore
            }
          }, 450);
          if (typeof cleanupTimer === 'object' && cleanupTimer && 'unref' in cleanupTimer) {
            (cleanupTimer as { unref(): void }).unref();
          }
        } catch {
          try {
            oldGain.disconnect();
          } catch {
            // ignore
          }
        }
      } else {
        try {
          oldGain.disconnect();
        } catch {
          // ignore
        }
      }
    }
  }

  // --- Dual-Mode Custom Pack Streaming ---

  private preloadCoreCustomSfx(): void {
    if (!this.ctx || !this.customPackResolver || !this.customPackActive) return;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioSfx) return;

    this.preloadedCustomSfx = true;
    const uniquePaths = new Set<string>();
    for (const key of CORE_CUSTOM_SFX_KEYS) {
      const relPath = manifest.audioSfx[key];
      if (!relPath) continue;
      if (isBlockedCustomSfxPath(key, relPath)) continue;
      if (this.customSfxCache.has(relPath) || this.loadingCustomSfxPaths.has(relPath)) continue;
      uniquePaths.add(relPath);
    }

    for (const relPath of uniquePaths) {
      void this.loadAndCacheCustomSfx(relPath);
    }
  }

  private tryPlayCustomMusic(biomeId: BiomeId, isBoss: boolean): boolean {
    // Check biomeId FIRST for bosses so TopClockTower plays assassin.ogg and Throne plays throne.ogg
    const candidateKeys = isBoss
      ? [biomeId, 'boss', 'Bridge', 'TopClockTower', 'Throne']
      : [biomeId, biomeId.toLowerCase(), 'default'];
    return this.tryPlayCustomMusicKey(candidateKeys);
  }

  private tryPlayCustomMusicKey(candidateKeys: readonly string[]): boolean {
    if (!this.ctx || !this.musicGain || !this.customPackResolver) return false;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioMusic) return false;

    let musicEntry: { intro?: string; loop: string } | null = null;
    for (const key of candidateKeys) {
      if (manifest.audioMusic[key]) {
        musicEntry = manifest.audioMusic[key];
        break;
      }
    }

    if (!musicEntry || !musicEntry.loop) return false;

    const token = ++this.musicRequestToken;
    void this.streamCustomMusicTrack(musicEntry, token);
    return true;
  }

  private async streamCustomMusicTrack(
    entry: { intro?: string; loop: string },
    token: number
  ): Promise<void> {
    if (!this.ctx || !this.musicGain || !this.customPackResolver) return;

    try {
      let introBuffer: AudioBuffer | null = null;
      if (entry.intro) {
        const introBlob = await this.customPackResolver.fetchBlob(entry.intro);
        if (token !== this.musicRequestToken || !this.ctx) return;
        if (introBlob) {
          const introArray = await introBlob.arrayBuffer();
          if (token !== this.musicRequestToken || !this.ctx) return;
          introBuffer = await this.ctx.decodeAudioData(introArray);
        }
      }

      const loopBlob = await this.customPackResolver.fetchBlob(entry.loop);
      if (token !== this.musicRequestToken || !this.ctx || !this.musicGain || !loopBlob) return;
      const loopArray = await loopBlob.arrayBuffer();
      if (token !== this.musicRequestToken || !this.ctx || !this.musicGain) return;
      const loopBuffer = await this.ctx.decodeAudioData(loopArray);
      if (token !== this.musicRequestToken || !this.ctx || !this.musicGain) return;

      // Fade out previous custom music
      this.stopCustomMusic();

      const startTime = this.ctx.currentTime + 0.05;
      const customMusicBus = this.ctx.createGain();
      customMusicBus.gain.setValueAtTime(0.001, this.ctx.currentTime);
      customMusicBus.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.8);
      customMusicBus.connect(this.musicGain);
      this.customMusicGain = customMusicBus;

      let loopStartTime = startTime;
      if (introBuffer) {
        const introSource = this.ctx.createBufferSource();
        introSource.buffer = introBuffer;
        introSource.connect(customMusicBus);
        introSource.start(startTime);
        this.customMusicIntroSource = introSource;
        loopStartTime = startTime + introBuffer.duration;
      }

      const loopSource = this.ctx.createBufferSource();
      loopSource.buffer = loopBuffer;
      loopSource.loop = true;
      loopSource.connect(customMusicBus);
      loopSource.start(loopStartTime);
      this.customMusicLoopSource = loopSource;
    } catch {
      // Decode or network failure: fallback to procedural music
      if (token !== this.musicRequestToken || !this.ctx || !this.musicGain) return;
      if (this.isTitleMusic) {
        this.startBuiltinTitleMusic();
      } else if (this.currentBiome !== null) {
        this.synthMusic.setBiomeMusic(this.ctx, this.musicGain, this.currentBiome, this.isBoss);
      }
    }
  }

  private stopCustomMusic(): void {
    if (this.customMusicGain && this.ctx) {
      try {
        this.customMusicGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.5);
      } catch {
        // ignore
      }
    }
    if (this.customMusicIntroSource) {
      try {
        this.customMusicIntroSource.stop();
        this.customMusicIntroSource.disconnect();
      } catch {
        // ignore
      }
      this.customMusicIntroSource = null;
    }
    if (this.customMusicLoopSource) {
      try {
        this.customMusicLoopSource.stop();
        this.customMusicLoopSource.disconnect();
      } catch {
        // ignore
      }
      this.customMusicLoopSource = null;
    }
  }

  private tryPlayCustomUiClick(kind: UiClickKind): boolean {
    if (!this.ctx || !this.sfxGain || !this.customPackResolver) return false;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioSfx) return false;

    let candidateKeys: string[];
    switch (kind) {
      case 'select':
        candidateKeys = ['select', 'ui_select'];
        break;
      case 'confirm':
        candidateKeys = ['confirm', 'ui_confirm'];
        break;
      case 'cancel':
        candidateKeys = ['cancel', 'ui_cancel'];
        break;
      case 'error':
        candidateKeys = ['error', 'ui_error'];
        break;
      case 'ui_start':
        candidateKeys = ['ui_start', 'confirm', 'ui_confirm'];
        break;
      case 'ui_unlock':
        candidateKeys = ['ui_unlock', 'confirm', 'ui_confirm'];
        break;
      default:
        candidateKeys = ['select', 'ui_select'];
        break;
    }

    let relPath: string | null = null;
    let sfxKey: string = kind;
    for (const key of candidateKeys) {
      if (manifest.audioSfx[key]) {
        relPath = manifest.audioSfx[key];
        sfxKey = key;
        break;
      }
    }
    if (!relPath) return false;

    const now = this.ctx.currentTime * 1000;
    const lastTime = this.customSfxCooldowns.get(`ui_${sfxKey}`) ?? 0;
    if (now - lastTime < 20) return true;
    this.customSfxCooldowns.set(`ui_${sfxKey}`, now);

    const cachedBuffer = this.customSfxCache.get(relPath);
    if (cachedBuffer) {
      this.playCustomBuffer(cachedBuffer, `ui_${sfxKey}`, 0, 0.85, this.sfxGain, 1.0, false);
      return true;
    }

    void this.loadAndCacheCustomSfx(relPath);
    return false;
  }

  private tryPlayCustomSfx(
    event: SimEvent,
    pan: number,
    distVol: number,
    destNode: AudioNode
  ): boolean {
    if (!this.ctx || !this.sfxGain || !this.customPackResolver) return false;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioSfx) return false;

    // Match logical Custom Pack SFX keys cleanly for every weapon, skill, shield, status & new event
    let candidateKeys: string[] = [event.type];
    switch (event.type) {
      case 'attackSwing': {
        const w = event.weaponId;
        if (w === 'BroadSword') candidateKeys = [w, 'broadsword', 'sword', 'attackSwing'];
        else if (w === 'StunMace') candidateKeys = [w, 'mace', 'broadsword', 'attackSwing'];
        else if (w === 'DualDaggers' || w === 'BackStabber' || w === 'QuickSword') {
          candidateKeys = [w, 'dagger', 'sword', 'attackSwing'];
        } else if (w === 'ImpaleSpear') candidateKeys = [w, 'spear', 'sword', 'attackSwing'];
        else if (w === 'Rapier') candidateKeys = [w, 'rapier', 'dagger', 'attackSwing'];
        else if (w === 'Whip') candidateKeys = [w, 'whip', 'attackSwing'];
        else if (w === 'FrostBow') candidateKeys = [w, 'iceBow', 'bow', 'attackSwing'];
        else if (w === 'CloseCombatBow' || w === 'FastBow') candidateKeys = [w, 'bow', 'attackSwing'];
        else if (w === 'ThrowingKnife') candidateKeys = [w, 'knife', 'dagger', 'attackSwing'];
        else if (w === 'Fireball') candidateKeys = [w, 'fireball', 'attackSwing'];
        else if (w.includes('Shield')) candidateKeys = [w, 'shield', 'attackSwing'];
        else candidateKeys = [w, 'sword', 'attackSwing'];
        break;
      }
      case 'hitImpact': {
        const w = event.weaponId ?? this.lastAttackWeaponId ?? '';
        const colorKind = classifyHitImpactColor(event.color);
        if (event.damageType === 'blood' || BLEED_WEAPONS.has(w) || colorKind === 'blood') {
          candidateKeys = ['hitBlood', 'hitBlade', 'hitImpact'];
        } else if (event.damageType === 'fire' || FIRE_WEAPONS.has(w) || colorKind === 'fire') {
          candidateKeys = ['hitFire', 'hitImpact'];
        } else if (event.damageType === 'poison' || colorKind === 'poison') {
          candidateKeys = ['hitPoison', 'hitImpact'];
        } else if (event.damageType === 'hammer' || event.breach || HEAVY_WEAPONS.has(w)) {
          candidateKeys = ['hitHammer', 'hitBlade', 'hitImpact'];
        } else {
          candidateKeys = ['hitBlade', 'hitImpact'];
        }
        break;
      }
      case 'statusProc': {
        if (event.status === 'bleed') candidateKeys = ['hitBlood', 'statusProc'];
        else if (event.status === 'burn') candidateKeys = ['hitFire', 'statusProc'];
        else if (event.status === 'poison') candidateKeys = ['hitPoison', 'statusProc'];
        else if (event.status === 'freeze' || event.status === 'frost') {
          candidateKeys = ['grenadeIce', 'statusProc'];
        } else if (event.status === 'electrify') {
          candidateKeys = ['lightningArc', 'whip', 'statusProc'];
        } else {
          candidateKeys = ['statusProc'];
        }
        break;
      }
      case 'enemyDeath':
        candidateKeys = event.isBoss ? ['bossVictory', 'enemyDeath'] : ['enemyDeath'];
        break;
      case 'parryStart':
        candidateKeys = ['parryStart', 'shield'];
        break;
      case 'shieldBlock':
        candidateKeys = ['shieldBlock', 'shield'];
        break;
      case 'explosion':
        if (event.element === 'fire') {
          candidateKeys = ['grenadeFire', 'grenadeExplode', 'explosion'];
        } else if (event.element === 'ice') {
          candidateKeys = ['grenadeIce', 'grenadeExplode', 'explosion'];
        } else {
          candidateKeys = ['grenadeExplode', 'explosion'];
        }
        break;
      case 'flaskEmpty':
        candidateKeys = ['flaskEmpty', 'error', 'ui_error'];
        break;
      case 'skillCast': {
        const sid = event.skillId;
        if (sid === 'SinewSlicer' || sid === 'HeavyTurret' || sid === 'WolfTrap') {
          candidateKeys = [sid, 'turretDeploy', 'skillCast'];
        } else if (sid === 'WaveOfDenial') {
          candidateKeys = [sid, 'waveOfDenial', 'skillCast'];
        } else if (sid === 'Phaser') {
          candidateKeys = [sid, 'teleport', 'skillCast'];
        } else if (sid === 'KnifeDance') {
          candidateKeys = [sid, 'knife', 'skillCast'];
        } else if (sid === 'Tonic') {
          candidateKeys = [sid, 'flaskDrink', 'skillCast'];
        } else if (sid === 'CorruptedPower') {
          candidateKeys = [sid, 'curseTriggered', 'skillCast'];
        } else {
          candidateKeys = [sid, 'skillCast'];
        }
        break;
      }
      case 'footstep':
        candidateKeys =
          event.surface === 'wood'
            ? ['footstepWood', 'footstep_wood', 'footstep']
            : event.surface === 'water'
              ? ['footstepWater', 'footstep_water', 'footstep']
              : ['footstep'];
        break;
      case 'jump':
        candidateKeys = event.isAirJump ? ['airJump', 'jump'] : ['jump'];
        break;
      case 'fallStun':
        candidateKeys = ['fallStun', 'land'];
        break;
      case 'freezeShatter':
        candidateKeys = ['freezeShatter', 'grenadeIce', 'critImpact'];
        break;
      case 'bleedBurst':
        candidateKeys = ['bleedBurst', 'hitBlood', 'statusProc'];
        break;
      case 'lightningArc':
        candidateKeys = ['lightningArc', 'whip', 'attackSwing'];
        break;
      case 'bossEngage':
        candidateKeys = ['bossEngage', 'bossPhaseShift'];
        break;
      case 'shopReroll':
        candidateKeys = ['shopReroll', 'goldCollect', 'confirm'];
        break;
      case 'perfectKillStreak':
        candidateKeys = ['perfectKillStreak', 'scrollPickup'];
        break;
      case 'perfectDodge':
        candidateKeys = ['perfectDodge', 'dodgeRoll'];
        break;
      default:
        break;
    }

    let relPath: string | null = null;
    let sfxKey: string = event.type;
    for (const key of candidateKeys) {
      const candidatePath = manifest.audioSfx[key];
      if (!candidatePath) continue;
      if (isBlockedCustomSfxPath(event.type, candidatePath)) continue;
      relPath = candidatePath;
      sfxKey = key;
      break;
    }

    if (!relPath) return false;

    // Check anti-spam micro-cooldown (25ms)
    const now = this.ctx.currentTime * 1000;
    const lastTime = this.customSfxCooldowns.get(sfxKey) ?? 0;
    if (now - lastTime < 25) return true; // throttled
    this.customSfxCooldowns.set(sfxKey, now);

    const cachedBuffer = this.customSfxCache.get(relPath);
    if (cachedBuffer) {
      let playbackRateOverride: number | undefined;
      let effectiveVol = distVol;
      if (event.type === 'cellCollect') {
        playbackRateOverride = this.advanceCellComboRate(this.ctx.currentTime);
      } else if (event.type === 'cellSpawn') {
        effectiveVol = distVol * 0.55;
        playbackRateOverride = 1.24 + Math.random() * 0.14;
      } else if (
        sfxKey === 'bossVictory' ||
        (event.type === 'enemyDeath' && event.isBoss) ||
        event.type === 'perfectKillStreak' ||
        event.type === 'bossEngage'
      ) {
        playbackRateOverride = 1.0;
      }
      this.playCustomBuffer(
        cachedBuffer,
        sfxKey,
        pan,
        effectiveVol,
        destNode,
        playbackRateOverride,
        true
      );
      return true;
    }

    // Lazy load and cache in background
    void this.loadAndCacheCustomSfx(relPath);
    return false; // Play procedural fallback while decoding
  }

  private async loadAndCacheCustomSfx(relPath: string): Promise<void> {
    if (
      !this.ctx ||
      !this.customPackResolver ||
      this.customSfxCache.has(relPath) ||
      this.loadingCustomSfxPaths.has(relPath)
    ) {
      return;
    }
    this.loadingCustomSfxPaths.add(relPath);
    try {
      const blob = await this.customPackResolver.fetchBlob(relPath);
      if (blob && this.ctx) {
        const arrayBuf = await blob.arrayBuffer();
        if (this.ctx) {
          const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
          this.customSfxCache.set(relPath, audioBuf);
        }
      }
    } catch {
      // ignore
    } finally {
      this.loadingCustomSfxPaths.delete(relPath);
    }
  }

  private playCustomBuffer(
    buffer: AudioBuffer,
    key: string,
    pan: number,
    distVol: number,
    destNode: AudioNode,
    playbackRateOverride?: number,
    sendReverb = true
  ): void {
    if (!this.ctx) return;

    let voiceSet = this.customActiveVoices.get(key);
    if (!voiceSet) {
      voiceSet = new Set<AudioBufferSourceNode>();
      this.customActiveVoices.set(key, voiceSet);
    }

    // Polyphony cap: max 4 voices
    if (voiceSet.size >= 4) {
      const oldest = voiceSet.values().next().value;
      if (oldest) {
        try {
          oldest.stop();
        } catch {
          // ignore
        }
        voiceSet.delete(oldest);
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Exact pitch when overridden (e.g. ascending cell combo scale / UI), else +/- 6% jitter
    source.playbackRate.value =
      playbackRateOverride !== undefined ? playbackRateOverride : 0.94 + Math.random() * 0.12;

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(distVol, this.ctx.currentTime);

    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, this.ctx.currentTime);
      source.connect(gainNode);
      gainNode.connect(panner);
      panner.connect(destNode);
    } else {
      source.connect(gainNode);
      gainNode.connect(destNode);
    }

    if (sendReverb && this.reverbSendGain) {
      gainNode.connect(this.reverbSendGain);
    }

    voiceSet.add(source);
    source.onended = () => {
      voiceSet?.delete(source);
      try {
        source.disconnect();
        gainNode.disconnect();
      } catch {
        // ignore
      }
    };

    source.start(this.ctx.currentTime);
  }
}
