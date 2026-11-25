import type { SimEvent } from '../contracts';

/**
 * Shared pre-allocated noise buffer for procedural transient and whoosh generation.
 */
let sharedNoiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!sharedNoiseBuffer || sharedNoiseBuffer.sampleRate !== ctx.sampleRate) {
    const bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
    sharedNoiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = sharedNoiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }
  return sharedNoiseBuffer;
}

interface ActiveVoice {
  stop(): void;
}

/**
 * Tactical procedural Web Audio sound effects synthesizer for Krunked Cells.
 * Implements anti-spam micro-cooldowns (25ms), polyphony limiting (max 4 voices per key),
 * +/-6% pitch jitter (0.94..1.06), and distinct tactile acoustic signatures for every SimEvent.
 */
export class SynthSfx {
  private lastTriggerTimes = new Map<string, number>();
  private activeVoices = new Map<string, Set<ActiveVoice>>();

  public reset(): void {
    this.lastTriggerTimes.clear();
    for (const voiceSet of this.activeVoices.values()) {
      for (const v of voiceSet) {
        try {
          v.stop();
        } catch {
          // ignore
        }
      }
    }
    this.activeVoices.clear();
  }

  /**
   * Evaluates micro-cooldown and polyphony before triggering an SFX key.
   */
  private checkCooldownAndPolyphony(key: string, now: number): boolean {
    const lastTime = this.lastTriggerTimes.get(key) ?? 0;
    if (now - lastTime < 25) {
      // Micro-cooldown of 25ms active
      return false;
    }
    this.lastTriggerTimes.set(key, now);

    let voiceSet = this.activeVoices.get(key);
    if (!voiceSet) {
      voiceSet = new Set<ActiveVoice>();
      this.activeVoices.set(key, voiceSet);
    }

    // Polyphony cap: max 4 voices per key
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

    return true;
  }

  private registerVoice(key: string, voice: ActiveVoice): void {
    let voiceSet = this.activeVoices.get(key);
    if (!voiceSet) {
      voiceSet = new Set<ActiveVoice>();
      this.activeVoices.set(key, voiceSet);
    }
    voiceSet.add(voice);
  }

  private removeVoice(key: string, voice: ActiveVoice): void {
    const voiceSet = this.activeVoices.get(key);
    if (voiceSet) {
      voiceSet.delete(voice);
    }
  }

  /**
   * Plays procedural SFX for a specific SimEvent.
   */
  public playEvent(
    ctx: AudioContext,
    event: SimEvent,
    pan: number,
    distanceVol: number,
    sfxNode: AudioNode,
    reverbNode: AudioNode
  ): void {
    if (ctx.state === 'suspended') return;

    const now = ctx.currentTime * 1000;
    const key = this.getEventKey(event);

    if (!this.checkCooldownAndPolyphony(key, now)) {
      return;
    }

    // Pitch jitter: +/- 6% (0.94 .. 1.06)
    const jitter = 0.94 + Math.random() * 0.12;

    // Create voice root with stereo panner and volume attenuation
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(distanceVol, ctx.currentTime);

    let panner: StereoPannerNode | null = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, ctx.currentTime);
      voiceGain.connect(panner);
      panner.connect(sfxNode);
    } else {
      voiceGain.connect(sfxNode);
    }

    // Subtle reverb send
    const reverbSend = ctx.createGain();
    reverbSend.gain.setValueAtTime(0.2, ctx.currentTime);
    voiceGain.connect(reverbSend);
    reverbSend.connect(reverbNode);

    const activeVoice: ActiveVoice = {
      stop: () => {
        try {
          voiceGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.02);
          const fadeTimer = setTimeout(() => {
            voiceGain.disconnect();
            panner?.disconnect();
            reverbSend.disconnect();
          }, 30);
          if (typeof fadeTimer === 'object' && fadeTimer && 'unref' in fadeTimer) {
            (fadeTimer as { unref(): void }).unref();
          }
        } catch {
          // ignore
        }
      },
    };

    this.registerVoice(key, activeVoice);

    // Dispatch event to appropriate procedural synth routine
    try {
      this.synthesizeEvent(ctx, event, voiceGain, jitter);
    } catch {
      // Audio node scheduling guard
    }

    // Auto cleanup voice after maximum duration
    const cleanupTimer = setTimeout(() => {
      this.removeVoice(key, activeVoice);
    }, 2500);
    if (typeof cleanupTimer === 'object' && cleanupTimer && 'unref' in cleanupTimer) {
      (cleanupTimer as { unref(): void }).unref();
    }
  }

  /**
   * Plays clean non-spatialized UI clicks.
   */
  public playUiClick(
    ctx: AudioContext,
    kind: 'select' | 'confirm' | 'cancel' | 'error' = 'select',
    sfxNode: AudioNode
  ): void {
    if (ctx.state === 'suspended') return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(sfxNode);

    switch (kind) {
      case 'select': {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1400, t);
        osc.frequency.exponentialRampToValueAtTime(900, t + 0.03);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
        osc.start(t);
        osc.stop(t + 0.04);
        break;
      }
      case 'confirm': {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, t);
        osc.frequency.setValueAtTime(990, t + 0.04);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.setValueAtTime(0.18, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.start(t);
        osc.stop(t + 0.13);
        break;
      }
      case 'cancel': {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, t);
        osc.frequency.exponentialRampToValueAtTime(310, t + 0.07);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
        osc.start(t);
        osc.stop(t + 0.09);
        break;
      }
      case 'error': {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.linearRampToValueAtTime(140, t + 0.12);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        osc.start(t);
        osc.stop(t + 0.15);
        break;
      }
    }
  }

  private getEventKey(event: SimEvent): string {
    switch (event.type) {
      case 'attackSwing':
        return `attack_${event.weaponId}`;
      case 'skillCast':
        return `skill_${event.skillId}`;
      case 'footstep':
        return `footstep_${event.surface}`;
      case 'statusProc':
        return `status_${event.status}`;
      default:
        return event.type;
    }
  }

  private synthesizeEvent(
    ctx: AudioContext,
    event: SimEvent,
    out: AudioNode,
    jitter: number
  ): void {
    const t = ctx.currentTime;

    switch (event.type) {
      case 'attackSwing': {
        // Metallic blade whoosh: filtered noise pitch glide + triangle metallic swoosh
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 3.5;
        filter.frequency.setValueAtTime(2600 * jitter, t);
        filter.frequency.exponentialRampToValueAtTime(700 * jitter, t + 0.14);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.28, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

        // Blade slice tone
        const slice = ctx.createOscillator();
        slice.type = 'sawtooth';
        slice.frequency.setValueAtTime(440 * jitter, t);
        slice.frequency.exponentialRampToValueAtTime(180 * jitter, t + 0.12);
        const sliceGain = ctx.createGain();
        sliceGain.gain.setValueAtTime(0.15, t);
        sliceGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        slice.connect(sliceGain);
        sliceGain.connect(out);

        noise.start(t);
        noise.stop(t + 0.18);
        slice.start(t);
        slice.stop(t + 0.14);
        break;
      }

      case 'hitImpact': {
        // Crunchy impact: pitch drop saw + distorted noise transient + sub impact
        const isBreach = event.breach;
        const osc = ctx.createOscillator();
        osc.type = isBreach ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime((isBreach ? 180 : 260) * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + (isBreach ? 0.22 : 0.14));

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.4, t);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, t + (isBreach ? 0.24 : 0.15));

        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.setValueAtTime(isBreach ? 2200 : 3400, t);
        noiseFilter.frequency.exponentialRampToValueAtTime(300, t + 0.08);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.35, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

        osc.connect(oscGain);
        oscGain.connect(out);
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(out);

        osc.start(t);
        osc.stop(t + (isBreach ? 0.25 : 0.16));
        noise.start(t);
        noise.stop(t + 0.1);
        break;
      }

      case 'critImpact': {
        // Bright electric harmonic chime: crystalline dual sine bell + sharp electric transient
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sine';
        osc2.type = 'triangle';
        osc1.frequency.setValueAtTime(2093 * jitter, t); // C7
        osc2.frequency.setValueAtTime(3136 * jitter, t); // G7
        osc1.frequency.exponentialRampToValueAtTime(1760 * jitter, t + 0.35);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.45, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);

        // Electric bite
        const zap = ctx.createBufferSource();
        zap.buffer = getNoiseBuffer(ctx);
        const zapFilter = ctx.createBiquadFilter();
        zapFilter.type = 'highpass';
        zapFilter.frequency.setValueAtTime(4000, t);
        const zapGain = ctx.createGain();
        zapGain.gain.setValueAtTime(0.3, t);
        zapGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(out);

        zap.connect(zapFilter);
        zapFilter.connect(zapGain);
        zapGain.connect(out);

        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 0.42);
        osc2.stop(t + 0.42);
        zap.start(t);
        zap.stop(t + 0.06);
        break;
      }

      case 'parrySuccess': {
        // Resonant golden metallic clang + shimmer!
        // 1. Dual high-Q resonant ringing filters
        const oscClang1 = ctx.createOscillator();
        const oscClang2 = ctx.createOscillator();
        oscClang1.type = 'triangle';
        oscClang2.type = 'sine';
        oscClang1.frequency.setValueAtTime(1174 * jitter, t); // D6
        oscClang2.frequency.setValueAtTime(2793 * jitter, t); // F7

        const clangGain = ctx.createGain();
        clangGain.gain.setValueAtTime(0.5, t);
        clangGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);

        // 2. Golden triad shimmer
        const chords = [1318, 1661, 1975]; // E6, G#6, B6
        chords.forEach((freq, idx) => {
          const chordOsc = ctx.createOscillator();
          chordOsc.type = 'sine';
          chordOsc.frequency.setValueAtTime(freq * jitter, t + idx * 0.02);
          const chordGain = ctx.createGain();
          chordGain.gain.setValueAtTime(0.0, t);
          chordGain.gain.setValueAtTime(0.25, t + idx * 0.02);
          chordGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 + idx * 0.05);

          chordOsc.connect(chordGain);
          chordGain.connect(out);
          chordOsc.start(t + idx * 0.02);
          chordOsc.stop(t + 0.6);
        });

        // 3. Metallic impact burst
        const impact = ctx.createBufferSource();
        impact.buffer = getNoiseBuffer(ctx);
        const impactFilter = ctx.createBiquadFilter();
        impactFilter.type = 'bandpass';
        impactFilter.Q.value = 12;
        impactFilter.frequency.setValueAtTime(3200 * jitter, t);
        const impactGain = ctx.createGain();
        impactGain.gain.setValueAtTime(0.4, t);
        impactGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

        oscClang1.connect(clangGain);
        oscClang2.connect(clangGain);
        clangGain.connect(out);

        impact.connect(impactFilter);
        impactFilter.connect(impactGain);
        impactGain.connect(out);

        oscClang1.start(t);
        oscClang2.start(t);
        oscClang1.stop(t + 0.65);
        oscClang2.stop(t + 0.65);
        impact.start(t);
        impact.stop(t + 0.13);
        break;
      }

      case 'parryFail': {
        // Dull wooden clunk / hollow thud
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(140 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(55, t + 0.14);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.16);
        break;
      }

      case 'dodgeRoll': {
        // Cloth swoosh: soft low-pass noise sweep
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 2.0;
        filter.frequency.setValueAtTime(650 * jitter, t);
        filter.frequency.exponentialRampToValueAtTime(220 * jitter, t + 0.22);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.28, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        noise.start(t);
        noise.stop(t + 0.26);
        break;
      }

      case 'diveSlamImpact': {
        // Sub-bass thunderous slam: heavy pitch drop 140Hz -> 32Hz sine + explosive crunch
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(145 * jitter, t);
        sub.frequency.exponentialRampToValueAtTime(32, t + 0.38);

        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.65, t);
        subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);

        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, t);
        filter.frequency.exponentialRampToValueAtTime(160, t + 0.28);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.55, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

        sub.connect(subGain);
        subGain.connect(out);
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(out);

        sub.start(t);
        sub.stop(t + 0.45);
        noise.start(t);
        noise.stop(t + 0.32);
        break;
      }

      case 'doorSmash': {
        // Wood splinter crunch: multi-tap noise bursts + splintering thud
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 3.0;
        filter.frequency.setValueAtTime(1200 * jitter, t);
        filter.frequency.exponentialRampToValueAtTime(350 * jitter, t + 0.2);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.48, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

        // Body thud
        const thud = ctx.createOscillator();
        thud.type = 'triangle';
        thud.frequency.setValueAtTime(180 * jitter, t);
        thud.frequency.exponentialRampToValueAtTime(50, t + 0.16);
        const thudGain = ctx.createGain();
        thudGain.gain.setValueAtTime(0.4, t);
        thudGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);
        thud.connect(thudGain);
        thudGain.connect(out);

        noise.start(t);
        noise.stop(t + 0.24);
        thud.start(t);
        thud.stop(t + 0.2);
        break;
      }

      case 'enemyTelegraph': {
        // Sharp crisp '!' alert ping: high bright sine/triangle ping ~1760Hz
        const ping = ctx.createOscillator();
        ping.type = 'triangle';
        ping.frequency.setValueAtTime(1760 * jitter, t);
        ping.frequency.exponentialRampToValueAtTime(1580 * jitter, t + 0.08);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);

        ping.connect(gain);
        gain.connect(out);

        ping.start(t);
        ping.stop(t + 0.09);
        break;
      }

      case 'enemyDeath': {
        // Crunchy dissolution / disintegrate burst + downward thud
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.28);
        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.35, t);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.25);
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.3, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

        osc.connect(oscGain);
        oscGain.connect(out);
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(out);

        osc.start(t);
        osc.stop(t + 0.32);
        noise.start(t);
        noise.stop(t + 0.28);
        break;
      }

      case 'bossPhaseShift': {
        // Deep horn/roar: detuned dual sawtooth brass chord + heavy sub-bass roar
        const rootFreq = 82.4 * jitter; // E2
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc2.type = 'sawtooth';
        osc1.frequency.setValueAtTime(rootFreq, t);
        osc2.frequency.setValueAtTime(rootFreq * 1.505, t); // B2 with detune

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 5.0;
        filter.frequency.setValueAtTime(120, t);
        filter.frequency.exponentialRampToValueAtTime(1600, t + 0.4);
        filter.frequency.exponentialRampToValueAtTime(280, t + 1.2);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.01, t);
        gain.gain.linearRampToValueAtTime(0.6, t + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 1.35);
        osc2.stop(t + 1.35);
        break;
      }

      case 'cellSpawn': {
        // Glassy pop / gentle crystalline bubble
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1100 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(1750 * jitter, t + 0.06);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.09);
        break;
      }

      case 'cellCollect': {
        // Crystalline chime: ascending high pure harmonics / sparkle chime
        const freqs = [1760, 2200, 2640];
        freqs.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq * jitter, t + idx * 0.035);
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0, t);
          gain.gain.setValueAtTime(0.22, t + idx * 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28 + idx * 0.04);

          osc.connect(gain);
          gain.connect(out);
          osc.start(t + idx * 0.035);
          osc.stop(t + 0.35);
        });
        break;
      }

      case 'goldCollect': {
        // Coin clink: dual high resonant sine clinks
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(2489 * jitter, t);
        osc2.frequency.setValueAtTime(3322 * jitter, t + 0.015);

        const gain1 = ctx.createGain();
        gain1.gain.setValueAtTime(0.25, t);
        gain1.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

        const gain2 = ctx.createGain();
        gain2.gain.setValueAtTime(0.0, t);
        gain2.gain.setValueAtTime(0.22, t + 0.015);
        gain2.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

        osc1.connect(gain1);
        osc2.connect(gain2);
        gain1.connect(out);
        gain2.connect(out);

        osc1.start(t);
        osc2.start(t + 0.015);
        osc1.stop(t + 0.08);
        osc2.stop(t + 0.1);
        break;
      }

      case 'scrollPickup': {
        // Heroic harmonic chord: sweeping major/lydian power chord
        const chordNotes = [440, 554.37, 659.25, 880, 1108.73]; // A major
        chordNotes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = idx % 2 === 0 ? 'triangle' : 'sine';
          osc.frequency.setValueAtTime(freq * jitter, t + idx * 0.04);
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0, t);
          gain.gain.setValueAtTime(0.25, t + idx * 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8 + idx * 0.05);

          osc.connect(gain);
          gain.connect(out);
          osc.start(t + idx * 0.04);
          osc.stop(t + 0.9);
        });
        break;
      }

      case 'itemPickup': {
        // Snappy satisfying pickup chime
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880 * jitter, t);
        osc.frequency.setValueAtTime(1320 * jitter, t + 0.05);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.28, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.22);
        break;
      }

      case 'curseTriggered': {
        // Ominous tolling bell: low resonant inharmonic bell ~110Hz
        const partials = [110, 276, 442, 630];
        partials.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq * jitter, t);
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.35 / (idx + 1), t);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);

          osc.connect(gain);
          gain.connect(out);
          osc.start(t);
          osc.stop(t + 1.9);
        });
        break;
      }

      case 'curseCleared': {
        // Purifying chord: bright major arpeggio / choral shimmer
        const notes = [587.33, 739.99, 880, 1174.66]; // D major
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq * jitter, t + idx * 0.035);
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0, t);
          gain.gain.setValueAtTime(0.24, t + idx * 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);

          osc.connect(gain);
          gain.connect(out);
          osc.start(t + idx * 0.035);
          osc.stop(t + 0.75);
        });
        break;
      }

      case 'flaskDrink': {
        // Liquid glug + heal shimmer: bubbling formant filter modulation
        const glugs = [440, 520, 600];
        glugs.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq * jitter, t + idx * 0.08);
          osc.frequency.exponentialRampToValueAtTime(freq * 1.35 * jitter, t + idx * 0.08 + 0.05);

          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0, t);
          gain.gain.setValueAtTime(0.25, t + idx * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + idx * 0.08 + 0.065);

          osc.connect(gain);
          gain.connect(out);
          osc.start(t + idx * 0.08);
          osc.stop(t + idx * 0.08 + 0.075);
        });

        // Uplifting heal shimmer
        const shimmer = ctx.createOscillator();
        shimmer.type = 'triangle';
        shimmer.frequency.setValueAtTime(880 * jitter, t + 0.25);
        shimmer.frequency.exponentialRampToValueAtTime(1760 * jitter, t + 0.65);
        const shimmerGain = ctx.createGain();
        shimmerGain.gain.setValueAtTime(0.0, t);
        shimmerGain.gain.setValueAtTime(0.25, t + 0.25);
        shimmerGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);

        shimmer.connect(shimmerGain);
        shimmerGain.connect(out);
        shimmer.start(t + 0.25);
        shimmer.stop(t + 0.8);
        break;
      }

      case 'biomeTransition': {
        // Deep whoosh / dimensional portal swell
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(140, t);
        filter.frequency.exponentialRampToValueAtTime(2200, t + 0.5);
        filter.frequency.exponentialRampToValueAtTime(100, t + 1.2);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.05, t);
        gain.gain.linearRampToValueAtTime(0.45, t + 0.5);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        noise.start(t);
        noise.stop(t + 1.35);
        break;
      }

      case 'playerDamaged': {
        // Visceral impact grunt / sharp warning slice
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(190 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(60, t + 0.16);

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.45, t);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1200, t);
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.4, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

        osc.connect(oscGain);
        oscGain.connect(out);
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(out);

        osc.start(t);
        osc.stop(t + 0.2);
        noise.start(t);
        noise.stop(t + 0.12);
        break;
      }

      case 'playerDeath': {
        // Dramatic slow downward pitch death knell + low bass reverberation
        const knell = ctx.createOscillator();
        knell.type = 'sawtooth';
        knell.frequency.setValueAtTime(130 * jitter, t);
        knell.frequency.exponentialRampToValueAtTime(28, t + 1.4);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.55, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

        knell.connect(gain);
        gain.connect(out);

        knell.start(t);
        knell.stop(t + 1.7);
        break;
      }

      case 'rallyRecovered': {
        // Sweet rising recovery blip
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(660 * jitter, t + 0.08);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.22, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.14);
        break;
      }

      case 'statusProc': {
        // Status proc effects based on kind
        const status = event.status;
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();

        if (status === 'freeze' || status === 'frost') {
          filter.type = 'highpass';
          filter.frequency.setValueAtTime(3200, t);
        } else if (status === 'poison' || status === 'acid' as any) {
          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(900, t);
        } else if (status === 'burn') {
          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(1400, t);
        } else {
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(1600, t);
        }

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.24, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        noise.start(t);
        noise.stop(t + 0.15);
        break;
      }

      case 'footstep': {
        // Subtle texture tap: stone/wood/water filtered impulses
        const surface = event.surface;
        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';

        if (surface === 'wood') {
          filter.frequency.setValueAtTime(380 * jitter, t);
          filter.Q.value = 4.0;
        } else if (surface === 'water') {
          filter.frequency.setValueAtTime(850 * jitter, t);
          filter.Q.value = 2.0;
        } else {
          // stone
          filter.frequency.setValueAtTime(1800 * jitter, t);
          filter.Q.value = 1.5;
        }

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        noise.start(t);
        noise.stop(t + 0.05);
        break;
      }

      case 'jump': {
        // Light airy upward chirp
        const isAirJump = event.isAirJump;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime((isAirJump ? 380 : 220) * jitter, t);
        osc.frequency.exponentialRampToValueAtTime((isAirJump ? 760 : 440) * jitter, t + 0.08);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(isAirJump ? 0.22 : 0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.1);
        break;
      }

      case 'land': {
        // Soft grounded thud, velocity scaled
        const speed = Math.min(600, Math.max(100, event.impactSpeed ?? 200));
        const vol = 0.1 + (speed / 600) * 0.25;

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(130 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.1);
        break;
      }

      case 'teleport': {
        // Phase shift / high-speed spatial sweep
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(1400 * jitter, t + 0.1);
        osc.frequency.exponentialRampToValueAtTime(400 * jitter, t + 0.2);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.24);
        break;
      }

      case 'skillCast': {
        // Tactical / magical activation burst
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(880 * jitter, t + 0.12);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);

        osc.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.16);
        break;
      }

      default:
        break;
    }
  }
}
