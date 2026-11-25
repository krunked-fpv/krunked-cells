import type {
  AudioEngineAPI,
  AudioSettings,
  BiomeId,
  CustomPackAssetResolver,
  SimEvent,
} from '../contracts';
import { DEFAULT_AUDIO_SETTINGS, VIEWPORT_W } from '../contracts';
import { SynthMusic } from './SynthMusic';
import { SynthSfx } from './SynthSfx';

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
 * - Master, Music, SFX GainNodes + Mute control
 * - Stereo panning scaled by distance from listenerX (VIEWPORT_W)
 * - Procedural cathedral/cavern ConvolverNode reverb send
 * - Anti-spam polish: micro-cooldown (25ms), polyphony cap (4 voices), pitch jitter (0.94..1.06)
 * - Original procedural baroque-dark-synth biome soundtrack & tactile SimEvent SFX
 * - Dual-Mode Owned Custom Pack Streaming with sample-accurate intro -> loop scheduling
 *   and automatic fallback to built-in synthesis.
 */
export class AudioEngine implements AudioEngineAPI {
  private ctx: AudioContext | null = null;
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };

  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private convolverNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private reverbSendGain: GainNode | null = null;

  private synthMusic = new SynthMusic();
  private synthSfx = new SynthSfx();

  private currentBiome: BiomeId | null = null;
  private isBoss = false;

  // Custom pack streaming state
  private customPackResolver: CustomPackAssetResolver | null = null;
  private customPackActive = false;
  private customSfxCache = new Map<string, AudioBuffer>();
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
    if (this.currentBiome !== null) {
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
    this.customPackResolver = resolver;
    this.customPackActive = active && resolver !== null;

    if (wasActive !== this.customPackActive && this.currentBiome !== null) {
      this.setBiomeMusic(this.currentBiome, this.isBoss);
    }
  }

  public setBiomeMusic(biomeId: BiomeId, isBoss: boolean): void {
    this.currentBiome = biomeId;
    this.isBoss = isBoss;

    this.ensureContext();
    if (!this.ctx || !this.musicGain) return;

    // Check if custom pack provides audio music for this track
    if (this.customPackActive && this.customPackResolver) {
      const scheduledCustom = this.tryPlayCustomMusic(biomeId, isBoss);
      if (scheduledCustom) {
        this.synthMusic.stop();
        return;
      }
    }

    // Stop custom music sources if active and fallback to procedural synth music
    this.stopCustomMusic();
    this.synthMusic.setBiomeMusic(this.ctx, this.musicGain, biomeId, isBoss);
  }

  public ingestEvents(events: readonly SimEvent[], listenerX: number, listenerY: number): void {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain) return;

    for (const event of events) {
      // Auto-transition music on biome transition
      if (event.type === 'biomeTransition') {
        this.setBiomeMusic(event.to, false);
      }

      const x = 'x' in event ? (event as { x: number }).x : listenerX;
      const y = 'y' in event ? (event as { y: number }).y : listenerY;

      const dx = x - listenerX;
      const halfW = VIEWPORT_W * 0.5;
      const pan = Math.max(-1, Math.min(1, dx / halfW));
      const dist = Math.hypot(dx, y - listenerY);
      const distVol = Math.max(0.25, Math.min(1.0, 1.0 - (dist / (VIEWPORT_W * 1.5)) * 0.75));

      // Attempt custom pack SFX playback if active
      if (this.customPackActive && this.customPackResolver) {
        const playedCustom = this.tryPlayCustomSfx(event, pan, distVol);
        if (playedCustom) continue;
      }

      // Default built-in procedural synthesis
      const reverbTarget = this.reverbSendGain ?? this.sfxGain;
      this.synthSfx.playEvent(this.ctx, event, pan, distVol, this.sfxGain, reverbTarget);
    }
  }

  public playUiClick(kind: 'select' | 'confirm' | 'cancel' | 'error' = 'select'): void {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain) return;
    this.synthSfx.playUiClick(this.ctx, kind, this.sfxGain);
  }

  public dispose(): void {
    this.synthMusic.dispose();
    this.synthSfx.reset();
    this.stopCustomMusic();
    this.customSfxCache.clear();
    this.customActiveVoices.clear();
    this.customSfxCooldowns.clear();

    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
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

      // SFX bus
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.setValueAtTime(this.settings.sfxVolume, t);
      this.sfxGain.connect(this.masterGain);

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

  // --- Dual-Mode Custom Pack Streaming ---

  private tryPlayCustomMusic(biomeId: BiomeId, isBoss: boolean): boolean {
    if (!this.ctx || !this.musicGain || !this.customPackResolver) return false;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioMusic) return false;

    // Resolve matching candidate music track
    const candidateKeys = isBoss
      ? ['boss', 'Bridge', 'TopClockTower', 'Throne', biomeId]
      : [biomeId, biomeId.toLowerCase(), 'default'];

    let musicEntry: { intro?: string; loop: string } | null = null;
    for (const key of candidateKeys) {
      if (manifest.audioMusic[key]) {
        musicEntry = manifest.audioMusic[key];
        break;
      }
    }

    if (!musicEntry || !musicEntry.loop) return false;

    // Asynchronously load and schedule sample-accurate custom music
    this.streamCustomMusicTrack(musicEntry);
    return true;
  }

  private async streamCustomMusicTrack(entry: { intro?: string; loop: string }): Promise<void> {
    if (!this.ctx || !this.musicGain || !this.customPackResolver) return;

    try {
      let introBuffer: AudioBuffer | null = null;
      if (entry.intro) {
        const introBlob = await this.customPackResolver.fetchBlob(entry.intro);
        if (introBlob) {
          const introArray = await introBlob.arrayBuffer();
          introBuffer = await this.ctx.decodeAudioData(introArray);
        }
      }

      const loopBlob = await this.customPackResolver.fetchBlob(entry.loop);
      if (!loopBlob) return;
      const loopArray = await loopBlob.arrayBuffer();
      const loopBuffer = await this.ctx.decodeAudioData(loopArray);

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
      if (this.currentBiome !== null && this.ctx && this.musicGain) {
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

  private tryPlayCustomSfx(event: SimEvent, pan: number, distVol: number): boolean {
    if (!this.ctx || !this.sfxGain || !this.customPackResolver) return false;
    const manifest = this.customPackResolver.getManifest();
    if (!manifest?.audioSfx) return false;

    // Match logical Custom Pack SFX keys cleanly for every weapon, skill, shield & explosion
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
      case 'parryStart':
        candidateKeys = ['parryStart'];
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
      default:
        break;
    }

    let relPath: string | null = null;
    let sfxKey: string = event.type;
    for (const key of candidateKeys) {
      if (manifest.audioSfx[key]) {
        relPath = manifest.audioSfx[key];
        sfxKey = key;
        break;
      }
    }

    if (!relPath) return false;

    // Check anti-spam micro-cooldown (25ms) and polyphony cap (4 voices)
    const now = this.ctx.currentTime * 1000;
    const lastTime = this.customSfxCooldowns.get(sfxKey) ?? 0;
    if (now - lastTime < 25) return true; // throttled
    this.customSfxCooldowns.set(sfxKey, now);

    const cachedBuffer = this.customSfxCache.get(relPath);
    if (cachedBuffer) {
      this.playCustomBuffer(cachedBuffer, sfxKey, pan, distVol);
      return true;
    }

    // Lazy load and cache in background
    this.loadAndCacheCustomSfx(relPath);
    return false; // Play procedural fallback while decoding
  }

  private async loadAndCacheCustomSfx(relPath: string): Promise<void> {
    if (!this.ctx || !this.customPackResolver || this.customSfxCache.has(relPath)) return;
    try {
      const blob = await this.customPackResolver.fetchBlob(relPath);
      if (blob) {
        const arrayBuf = await blob.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        this.customSfxCache.set(relPath, audioBuf);
      }
    } catch {
      // ignore
    }
  }

  private playCustomBuffer(
    buffer: AudioBuffer,
    key: string,
    pan: number,
    distVol: number
  ): void {
    if (!this.ctx || !this.sfxGain) return;

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

    // +/- 6% pitch jitter (0.94 .. 1.06)
    source.playbackRate.value = 0.94 + Math.random() * 0.12;

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(distVol, this.ctx.currentTime);

    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, this.ctx.currentTime);
      source.connect(gainNode);
      gainNode.connect(panner);
      panner.connect(this.sfxGain);
    } else {
      source.connect(gainNode);
      gainNode.connect(this.sfxGain);
    }

    if (this.reverbSendGain) {
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
