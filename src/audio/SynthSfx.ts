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
      case 'explosion':
        return `explosion_${event.element}`;
      case 'flaskEmpty':
        return `flaskEmpty_${event.reason}`;
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
        const w = event.weaponId;
        if (w === 'CloseCombatBow' || w === 'FastBow' || w === 'FrostBow') {
          // Crisp bowstring twang + arrow release zip
          const twang = ctx.createOscillator();
          twang.type = 'triangle';
          twang.frequency.setValueAtTime((w === 'FrostBow' ? 680 : 520) * jitter, t);
          twang.frequency.exponentialRampToValueAtTime(210 * jitter, t + 0.09);
          const twangGain = ctx.createGain();
          twangGain.gain.setValueAtTime(0.28, t);
          twangGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
          twang.connect(twangGain);
          twangGain.connect(out);
          twang.start(t);
          twang.stop(t + 0.12);

          const zip = ctx.createBufferSource();
          zip.buffer = getNoiseBuffer(ctx);
          const zipF = ctx.createBiquadFilter();
          zipF.type = 'highpass';
          zipF.frequency.setValueAtTime(w === 'FrostBow' ? 3600 : 2400, t);
          const zipG = ctx.createGain();
          zipG.gain.setValueAtTime(0.18, t);
          zipG.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
          zip.connect(zipF);
          zipF.connect(zipG);
          zipG.connect(out);
          zip.start(t);
          zip.stop(t + 0.08);
          break;
        }
        if (w === 'Whip') {
          // Electric whip crack + zap
          const zap = ctx.createBufferSource();
          zap.buffer = getNoiseBuffer(ctx);
          const zf = ctx.createBiquadFilter();
          zf.type = 'highpass';
          zf.frequency.setValueAtTime(3400, t);
          const zg = ctx.createGain();
          zg.gain.setValueAtTime(0.32, t);
          zg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
          zap.connect(zf);
          zf.connect(zg);
          zg.connect(out);
          zap.start(t);
          zap.stop(t + 0.1);

          const crack = ctx.createOscillator();
          crack.type = 'sawtooth';
          crack.frequency.setValueAtTime(1600 * jitter, t);
          crack.frequency.exponentialRampToValueAtTime(320 * jitter, t + 0.08);
          const cg = ctx.createGain();
          cg.gain.setValueAtTime(0.22, t);
          cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
          crack.connect(cg);
          cg.connect(out);
          crack.start(t);
          crack.stop(t + 0.1);
          break;
        }
        if (w === 'Fireball') {
          // Warm flame launch whoosh
          const whoosh = ctx.createBufferSource();
          whoosh.buffer = getNoiseBuffer(ctx);
          const wf = ctx.createBiquadFilter();
          wf.type = 'bandpass';
          wf.Q.value = 2.0;
          wf.frequency.setValueAtTime(1400 * jitter, t);
          wf.frequency.exponentialRampToValueAtTime(360 * jitter, t + 0.14);
          const wg = ctx.createGain();
          wg.gain.setValueAtTime(0.34, t);
          wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          whoosh.connect(wf);
          wf.connect(wg);
          wg.connect(out);
          whoosh.start(t);
          whoosh.stop(t + 0.17);
          break;
        }

        // Metallic blade whoosh scaled for heavy / light / standard weapons
        const isHeavy = w === 'BroadSword' || w === 'StunMace';
        const isFast =
          w === 'DualDaggers' || w === 'BackStabber' || w === 'QuickSword' || w === 'Rapier' || w === 'ThrowingKnife';
        const dur = isHeavy ? 0.22 : isFast ? 0.1 : 0.14;
        const startFilter = isHeavy ? 1300 : isFast ? 3400 : 2600;
        const endFilter = isHeavy ? 280 : isFast ? 1200 : 700;

        const noise = ctx.createBufferSource();
        noise.buffer = getNoiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = isHeavy ? 2.2 : 3.5;
        filter.frequency.setValueAtTime(startFilter * jitter, t);
        filter.frequency.exponentialRampToValueAtTime(endFilter * jitter, t + dur);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(isHeavy ? 0.36 : 0.28, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);

        // Blade slice tone
        const slice = ctx.createOscillator();
        slice.type = isHeavy ? 'triangle' : 'sawtooth';
        slice.frequency.setValueAtTime((isHeavy ? 240 : isFast ? 620 : 440) * jitter, t);
        slice.frequency.exponentialRampToValueAtTime((isHeavy ? 85 : isFast ? 280 : 180) * jitter, t + dur * 0.85);
        const sliceGain = ctx.createGain();
        sliceGain.gain.setValueAtTime(isHeavy ? 0.24 : 0.15, t);
        sliceGain.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        slice.connect(sliceGain);
        sliceGain.connect(out);

        noise.start(t);
        noise.stop(t + dur + 0.04);
        slice.start(t);
        slice.stop(t + dur);
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

      case 'parryStart': {
        // Crisp metallic shield-raise shing + air flick
        const ping = ctx.createOscillator();
        ping.type = 'triangle';
        ping.frequency.setValueAtTime(580 * jitter, t);
        ping.frequency.exponentialRampToValueAtTime(1320 * jitter, t + 0.065);
        const pingGain = ctx.createGain();
        pingGain.gain.setValueAtTime(0.24, t);
        pingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);

        const flick = ctx.createBufferSource();
        flick.buffer = getNoiseBuffer(ctx);
        const flickFilter = ctx.createBiquadFilter();
        flickFilter.type = 'bandpass';
        flickFilter.Q.value = 7.0;
        flickFilter.frequency.setValueAtTime(2800 * jitter, t);
        const flickGain = ctx.createGain();
        flickGain.gain.setValueAtTime(0.22, t);
        flickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

        ping.connect(pingGain);
        pingGain.connect(out);
        flick.connect(flickFilter);
        flickFilter.connect(flickGain);
        flickGain.connect(out);

        ping.start(t);
        ping.stop(t + 0.09);
        flick.start(t);
        flick.stop(t + 0.07);
        break;
      }

      case 'shieldBlock': {
        // Heavy iron guard impact thump + bright silver-steel ring
        const thump = ctx.createOscillator();
        thump.type = 'triangle';
        thump.frequency.setValueAtTime(240 * jitter, t);
        thump.frequency.exponentialRampToValueAtTime(75, t + 0.13);
        const thumpGain = ctx.createGain();
        thumpGain.gain.setValueAtTime(0.45, t);
        thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);

        const ring1 = ctx.createOscillator();
        const ring2 = ctx.createOscillator();
        ring1.type = 'sine';
        ring2.type = 'sine';
        ring1.frequency.setValueAtTime(980 * jitter, t);
        ring2.frequency.setValueAtTime(1480 * jitter, t);
        const ringGain = ctx.createGain();
        ringGain.gain.setValueAtTime(0.22, t);
        ringGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

        const crunch = ctx.createBufferSource();
        crunch.buffer = getNoiseBuffer(ctx);
        const crunchFilter = ctx.createBiquadFilter();
        crunchFilter.type = 'bandpass';
        crunchFilter.Q.value = 3.0;
        crunchFilter.frequency.setValueAtTime(1650 * jitter, t);
        const crunchGain = ctx.createGain();
        crunchGain.gain.setValueAtTime(0.32, t);
        crunchGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

        thump.connect(thumpGain);
        thumpGain.connect(out);
        ring1.connect(ringGain);
        ring2.connect(ringGain);
        ringGain.connect(out);
        crunch.connect(crunchFilter);
        crunchFilter.connect(crunchGain);
        crunchGain.connect(out);

        thump.start(t);
        thump.stop(t + 0.16);
        ring1.start(t);
        ring2.start(t);
        ring1.stop(t + 0.22);
        ring2.stop(t + 0.22);
        crunch.start(t);
        crunch.stop(t + 0.1);
        break;
      }

      case 'explosion': {
        // Punchy layered explosion tailored by element (fire / ice / cluster / physical)
        const el = event.element;
        const sub = ctx.createOscillator();
        sub.type = el === 'ice' ? 'triangle' : 'sine';
        sub.frequency.setValueAtTime((el === 'ice' ? 160 : el === 'cluster' ? 145 : 130) * jitter, t);
        sub.frequency.exponentialRampToValueAtTime(el === 'ice' ? 44 : 28, t + (el === 'ice' ? 0.26 : 0.42));
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(el === 'ice' ? 0.5 : 0.68, t);
        subGain.gain.exponentialRampToValueAtTime(0.0001, t + (el === 'ice' ? 0.28 : 0.45));
        sub.connect(subGain);
        subGain.connect(out);
        sub.start(t);
        sub.stop(t + 0.48);

        const blast = ctx.createBufferSource();
        blast.buffer = getNoiseBuffer(ctx);
        const blastFilter = ctx.createBiquadFilter();
        blastFilter.type = el === 'ice' ? 'highpass' : 'lowpass';
        blastFilter.frequency.setValueAtTime(el === 'ice' ? 2800 : 2600, t);
        if (el !== 'ice') {
          blastFilter.frequency.exponentialRampToValueAtTime(160, t + 0.36);
        }
        const blastGain = ctx.createGain();
        blastGain.gain.setValueAtTime(el === 'ice' ? 0.38 : 0.58, t);
        blastGain.gain.exponentialRampToValueAtTime(0.0001, t + (el === 'ice' ? 0.26 : 0.4));
        blast.connect(blastFilter);
        blastFilter.connect(blastGain);
        blastGain.connect(out);
        blast.start(t);
        blast.stop(t + 0.42);

        if (el === 'ice') {
          // Crystalline shatter chimes
          const shards = [2200, 3136, 4186];
          shards.forEach((freq, idx) => {
            const sOsc = ctx.createOscillator();
            sOsc.type = 'sine';
            sOsc.frequency.setValueAtTime(freq * jitter, t + idx * 0.018);
            sOsc.frequency.exponentialRampToValueAtTime(freq * 0.72 * jitter, t + 0.24);
            const sGain = ctx.createGain();
            sGain.gain.setValueAtTime(0.0, t);
            sGain.gain.setValueAtTime(0.24, t + idx * 0.018);
            sGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26 + idx * 0.02);
            sOsc.connect(sGain);
            sGain.connect(out);
            sOsc.start(t + idx * 0.018);
            sOsc.stop(t + 0.3);
          });
        } else if (el === 'fire') {
          // Flame sizzle & crackle layer
          const sizzle = ctx.createBufferSource();
          sizzle.buffer = getNoiseBuffer(ctx);
          const sFilter = ctx.createBiquadFilter();
          sFilter.type = 'bandpass';
          sFilter.Q.value = 2.4;
          sFilter.frequency.setValueAtTime(3200 * jitter, t);
          sFilter.frequency.exponentialRampToValueAtTime(900, t + 0.38);
          const sGain = ctx.createGain();
          sGain.gain.setValueAtTime(0.32, t);
          sGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
          sizzle.connect(sFilter);
          sFilter.connect(sGain);
          sGain.connect(out);
          sizzle.start(t);
          sizzle.stop(t + 0.44);
        } else {
          // Gritty mid crunch transient for physical & cluster blasts
          const crunchOsc = ctx.createOscillator();
          crunchOsc.type = 'sawtooth';
          crunchOsc.frequency.setValueAtTime(215 * jitter, t);
          crunchOsc.frequency.exponentialRampToValueAtTime(48, t + 0.18);
          const crunchGain = ctx.createGain();
          crunchGain.gain.setValueAtTime(0.35, t);
          crunchGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
          crunchOsc.connect(crunchGain);
          crunchGain.connect(out);
          crunchOsc.start(t);
          crunchOsc.stop(t + 0.22);
        }
        break;
      }

      case 'flaskEmpty': {
        if (event.reason === 'fullHp') {
          // Gentle double glass chime indicating HP is already full
          const chime = ctx.createOscillator();
          chime.type = 'sine';
          chime.frequency.setValueAtTime(820 * jitter, t);
          chime.frequency.setValueAtTime(980 * jitter, t + 0.04);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.18, t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
          chime.connect(g);
          g.connect(out);
          chime.start(t);
          chime.stop(t + 0.12);
        } else {
          // Hollow glass clink + dry empty buzz
          const clink = ctx.createOscillator();
          clink.type = 'triangle';
          clink.frequency.setValueAtTime(680 * jitter, t);
          clink.frequency.exponentialRampToValueAtTime(420, t + 0.045);
          const clinkG = ctx.createGain();
          clinkG.gain.setValueAtTime(0.22, t);
          clinkG.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
          clink.connect(clinkG);
          clinkG.connect(out);
          clink.start(t);
          clink.stop(t + 0.06);

          const buzz = ctx.createOscillator();
          buzz.type = 'sawtooth';
          buzz.frequency.setValueAtTime(155 * jitter, t + 0.02);
          buzz.frequency.linearRampToValueAtTime(115, t + 0.13);
          const buzzG = ctx.createGain();
          buzzG.gain.setValueAtTime(0.0, t);
          buzzG.gain.setValueAtTime(0.18, t + 0.02);
          buzzG.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
          buzz.connect(buzzG);
          buzzG.connect(out);
          buzz.start(t + 0.02);
          buzz.stop(t + 0.15);
        }
        break;
      }

      case 'skillCast': {
        const sid = event.skillId;
        if (sid === 'SinewSlicer' || sid === 'HeavyTurret' || sid === 'WolfTrap') {
          // Mechanical deploy clank + crisp clockwork clicks
          const clank = ctx.createOscillator();
          clank.type = 'triangle';
          clank.frequency.setValueAtTime(320 * jitter, t);
          clank.frequency.exponentialRampToValueAtTime(125, t + 0.11);
          const clankG = ctx.createGain();
          clankG.gain.setValueAtTime(0.38, t);
          clankG.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
          clank.connect(clankG);
          clankG.connect(out);
          clank.start(t);
          clank.stop(t + 0.13);

          [1400, 1880].forEach((freq, idx) => {
            const click = ctx.createOscillator();
            click.type = 'square';
            click.frequency.setValueAtTime(freq * jitter, t + 0.03 + idx * 0.045);
            const cg = ctx.createGain();
            cg.gain.setValueAtTime(0.0, t);
            cg.gain.setValueAtTime(0.14, t + 0.03 + idx * 0.045);
            cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.065 + idx * 0.045);
            click.connect(cg);
            cg.connect(out);
            click.start(t + 0.03 + idx * 0.045);
            click.stop(t + 0.075 + idx * 0.045);
          });
        } else if (sid === 'WaveOfDenial') {
          // Explosive pneumatic kinetic wind shockwave
          const wind = ctx.createBufferSource();
          wind.buffer = getNoiseBuffer(ctx);
          const wf = ctx.createBiquadFilter();
          wf.type = 'bandpass';
          wf.Q.value = 1.8;
          wf.frequency.setValueAtTime(360, t);
          wf.frequency.exponentialRampToValueAtTime(2800 * jitter, t + 0.08);
          wf.frequency.exponentialRampToValueAtTime(380, t + 0.26);
          const wg = ctx.createGain();
          wg.gain.setValueAtTime(0.55, t);
          wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
          wind.connect(wf);
          wf.connect(wg);
          wg.connect(out);
          wind.start(t);
          wind.stop(t + 0.3);

          const push = ctx.createOscillator();
          push.type = 'sine';
          push.frequency.setValueAtTime(260 * jitter, t);
          push.frequency.exponentialRampToValueAtTime(62, t + 0.22);
          const pg = ctx.createGain();
          pg.gain.setValueAtTime(0.42, t);
          pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
          push.connect(pg);
          pg.connect(out);
          push.start(t);
          push.stop(t + 0.25);
        } else if (sid === 'CorruptedPower') {
          // Dark violet power surge chord + electric crackle
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          osc1.type = 'sawtooth';
          osc2.type = 'sawtooth';
          osc1.frequency.setValueAtTime(140 * jitter, t);
          osc1.frequency.exponentialRampToValueAtTime(420 * jitter, t + 0.28);
          osc2.frequency.setValueAtTime(211 * jitter, t);
          osc2.frequency.exponentialRampToValueAtTime(632 * jitter, t + 0.28);
          const flt = ctx.createBiquadFilter();
          flt.type = 'lowpass';
          flt.frequency.setValueAtTime(500, t);
          flt.frequency.exponentialRampToValueAtTime(3200, t + 0.22);
          const cg = ctx.createGain();
          cg.gain.setValueAtTime(0.32, t);
          cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
          osc1.connect(flt);
          osc2.connect(flt);
          flt.connect(cg);
          cg.connect(out);
          osc1.start(t);
          osc2.start(t);
          osc1.stop(t + 0.38);
          osc2.stop(t + 0.38);
        } else if (sid === 'KnifeDance') {
          // Rapid radial steel knife fan zip
          [0, 0.03, 0.06].forEach((off, idx) => {
            const kOsc = ctx.createOscillator();
            kOsc.type = 'sawtooth';
            kOsc.frequency.setValueAtTime((2400 + idx * 350) * jitter, t + off);
            kOsc.frequency.exponentialRampToValueAtTime(980 * jitter, t + off + 0.065);
            const kg = ctx.createGain();
            kg.gain.setValueAtTime(0.0, t);
            kg.gain.setValueAtTime(0.18, t + off);
            kg.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.075);
            kOsc.connect(kg);
            kg.connect(out);
            kOsc.start(t + off);
            kOsc.stop(t + off + 0.08);
          });
        } else if (sid === 'Phaser') {
          // Sharp electric blink zap
          const zOsc = ctx.createOscillator();
          zOsc.type = 'sawtooth';
          zOsc.frequency.setValueAtTime(300 * jitter, t);
          zOsc.frequency.exponentialRampToValueAtTime(1650 * jitter, t + 0.09);
          const zg = ctx.createGain();
          zg.gain.setValueAtTime(0.24, t);
          zg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
          zOsc.connect(zg);
          zg.connect(out);
          zOsc.start(t);
          zOsc.stop(t + 0.13);
        } else if (sid === 'Tonic') {
          // Refreshing emerald healing shimmer
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((freq, idx) => {
            const o = ctx.createOscillator();
            o.type = 'sine';
            o.frequency.setValueAtTime(freq * jitter, t + idx * 0.035);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0, t);
            g.gain.setValueAtTime(0.22, t + idx * 0.035);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36 + idx * 0.04);
            o.connect(g);
            g.connect(out);
            o.start(t + idx * 0.035);
            o.stop(t + 0.44);
          });
        } else {
          // Grenade pin & throw whoosh
          const toss = ctx.createBufferSource();
          toss.buffer = getNoiseBuffer(ctx);
          const tf = ctx.createBiquadFilter();
          tf.type = 'bandpass';
          tf.Q.value = 2.5;
          tf.frequency.setValueAtTime(1100 * jitter, t);
          tf.frequency.exponentialRampToValueAtTime(320 * jitter, t + 0.12);
          const tg = ctx.createGain();
          tg.gain.setValueAtTime(0.32, t);
          tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
          toss.connect(tf);
          tf.connect(tg);
          tg.connect(out);
          toss.start(t);
          toss.stop(t + 0.15);

          const pin = ctx.createOscillator();
          pin.type = 'triangle';
          pin.frequency.setValueAtTime(1900 * jitter, t);
          pin.frequency.exponentialRampToValueAtTime(1200 * jitter, t + 0.045);
          const pg = ctx.createGain();
          pg.gain.setValueAtTime(0.18, t);
          pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
          pin.connect(pg);
          pg.connect(out);
          pin.start(t);
          pin.stop(t + 0.06);
        }
        break;
      }

      default:
        break;
    }
  }
}
