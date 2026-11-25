import type { BiomeId } from '../contracts';

/**
 * MIDI note helper: converts MIDI note number to frequency in Hz.
 */
function m2f(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// Pre-defined MIDI pitches for easy musical composition
const C1 = 24, Cs1 = 25, D1 = 26, Eb1 = 27, E1 = 28, F1 = 29, Fs1 = 30, G1 = 31, Ab1 = 32, A1 = 33, Bb1 = 34, B1 = 35;
const C2 = 36, Cs2 = 37, D2 = 38, Eb2 = 39, E2 = 40, F2 = 41, Fs2 = 42, G2 = 43, Ab2 = 44, A2 = 45, Bb2 = 46, B2 = 47;
const C3 = 48, Cs3 = 49, D3 = 50, Eb3 = 51, E3 = 52, F3 = 53, Fs3 = 54, G3 = 55, Ab3 = 56, A3 = 57, Bb3 = 58, B3 = 59;
const C4 = 60, Cs4 = 61, D4 = 62, Eb4 = 63, E4 = 64, F4 = 65, Fs4 = 66, G4 = 67, Ab4 = 68, A4 = 69, Bb4 = 70, B4 = 71;
const C5 = 72, Cs5 = 73, D5 = 74, Eb5 = 75, E5 = 76, F5 = 77, Fs5 = 78, G5 = 79, Ab5 = 80, A5 = 81, Bb5 = 82, B5 = 83;
const C6 = 84, Cs6 = 85, D6 = 86, Eb6 = 87, E6 = 88, F6 = 89, Fs6 = 90, G6 = 91, Ab6 = 92, A6 = 93, Bb6 = 94, B6 = 95;

interface BiomeThemeData {
  id: string;
  bpm: number;
  steps: number; // e.g. 32 steps (2 bars)
  bass: (number | null)[];
  lead: (number | null)[];
  arpeggio?: (number | null)[];
  chords?: { step: number; notes: number[]; durationSteps: number }[];
  drums: {
    kicks?: number[];
    snares?: number[];
    hats?: number[];
    clockTicks?: number[];
    tribalPerc?: { step: number; pitch: number }[];
  };
  style: {
    leadType: 'spanishPluck' | 'harpsichord' | 'organ' | 'fluteHarmonic' | 'whistle';
    bassType: 'gothicBass' | 'bubbleBass' | 'deepPulse';
    padType: 'darkChoir' | 'warmCampfire' | 'cathedralOrgan' | 'none';
  };
}

/**
 * Curated procedural soundtracks with distinct musical personalities.
 */
const THEMES: Record<string, BiomeThemeData> = {
  // Title / Prisoner's Quarters: Brooding Spanish-baroque minor acoustic pluck + deep gothic bass pulse
  prison: {
    id: 'prison',
    bpm: 84,
    steps: 32,
    bass: [
      D2, null, D2, null,  D2, null, F2, null,
      G2, null, G2, null,  A2, null, Bb2, A2,
      D2, null, D2, null,  D2, null, F2, null,
      G2, null, Bb2, null, A2, null, G2, E2,
    ],
    lead: [
      D4, null, F4, A4,    D5, null, Cs5, D5,
      Bb4, null, A4, G4,   A4, null, null, null,
      D4, F4, A4, D5,      F5, E5, D5, Cs5,
      D5, Bb4, G4, E4,     F4, E4, D4, null,
    ],
    arpeggio: [
      null, A4, null, F4,  null, A4, null, F4,
      null, G4, null, E4,  null, A4, null, G4,
      null, A4, null, F4,  null, Bb4, null, A4,
      null, G4, null, E4,  null, F4, null, E4,
    ],
    chords: [
      { step: 0, notes: [D3, F3, A3, D4], durationSteps: 8 },
      { step: 8, notes: [G3, Bb3, D4, G4], durationSteps: 8 },
      { step: 16, notes: [D3, F3, A3, D4], durationSteps: 8 },
      { step: 24, notes: [A2, Cs3, E3, A3], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 8, 16, 24],
      snares: [4, 12, 20, 28],
      hats: [2, 6, 10, 14, 18, 22, 26, 30],
    },
    style: {
      leadType: 'spanishPluck',
      bassType: 'deepPulse',
      padType: 'darkChoir',
    },
  },

  // Promenade of the Condemned / Stilt Village: Windswept minor strings & tribal percussion
  promenade: {
    id: 'promenade',
    bpm: 104,
    steps: 32,
    bass: [
      E2, null, E2, null,  G2, null, E2, null,
      A2, null, A2, null,  B2, null, G2, Fs2,
      E2, null, E2, null,  G2, null, E2, null,
      C3, null, B2, null,  A2, null, G2, Fs2,
    ],
    lead: [
      E4, G4, B4, E5,      D5, B4, G4, A4,
      B4, null, G4, E4,    Fs4, G4, A4, B4,
      E5, null, D5, B4,    G4, A4, B4, D5,
      C5, B4, A4, G4,      Fs4, G4, E4, null,
    ],
    arpeggio: [
      B4, null, E5, null,  G5, null, E5, null,
      A4, null, D5, null,  Fs5, null, D5, null,
      B4, null, E5, null,  G5, null, E5, null,
      C5, null, E5, null,  B4, null, G4, null,
    ],
    chords: [
      { step: 0, notes: [E3, G3, B3, E4], durationSteps: 8 },
      { step: 8, notes: [A2, C3, E3, A3], durationSteps: 8 },
      { step: 16, notes: [E3, G3, B3, E4], durationSteps: 8 },
      { step: 24, notes: [C3, E3, G3, B3], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 6, 16, 22],
      snares: [8, 24],
      hats: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
      tribalPerc: [
        { step: 2, pitch: 240 },
        { step: 4, pitch: 180 },
        { step: 10, pitch: 260 },
        { step: 14, pitch: 190 },
        { step: 18, pitch: 240 },
        { step: 20, pitch: 180 },
        { step: 26, pitch: 270 },
        { step: 30, pitch: 200 },
      ],
    },
    style: {
      leadType: 'spanishPluck',
      bassType: 'gothicBass',
      padType: 'darkChoir',
    },
  },

  // Toxic Sewers: Dark bubbling bass ostinato & eerie harmonics
  sewer: {
    id: 'sewer',
    bpm: 76,
    steps: 32,
    bass: [
      C2, C3, Eb2, C3,     F2, C3, Eb2, C2,
      Fs2, C3, F2, C3,     Eb2, C3, C2, Eb2,
      C2, C3, Eb2, C3,     F2, C3, Fs2, C3,
      G2, C3, Fs2, C3,     F2, Eb2, D2, C2,
    ],
    lead: [
      null, null, C5, null, Eb5, null, null, null,
      Fs5, null, F5, null,  Eb5, D5, C5, null,
      null, null, G5, null, Fs5, null, null, null,
      F5, null, Eb5, null,  D5, C5, null, null,
    ],
    chords: [
      { step: 0, notes: [C3, Eb3, G3, Bb3], durationSteps: 8 },
      { step: 8, notes: [Fs2, C3, Eb3, A3], durationSteps: 8 },
      { step: 16, notes: [C3, Eb3, G3, Bb3], durationSteps: 8 },
      { step: 24, notes: [G2, B2, D3, F3], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 16],
      snares: [8, 24],
      hats: [4, 12, 20, 28],
    },
    style: {
      leadType: 'fluteHarmonic',
      bassType: 'bubbleBass',
      padType: 'darkChoir',
    },
  },

  // Ramparts: Nocturnal arpeggios & driving drums
  ramparts: {
    id: 'ramparts',
    bpm: 114,
    steps: 32,
    bass: [
      A2, null, A2, A2,    G2, null, G2, null,
      F2, null, F2, F2,    E2, null, G2, null,
      A2, null, A2, A2,    C3, null, C3, null,
      D3, null, D3, D3,    E3, null, E2, null,
    ],
    lead: [
      A4, C5, E5, A5,      G5, E5, D5, C5,
      D5, E5, F5, E5,      D5, C5, B4, G4,
      A4, C5, E5, A5,      B5, G5, E5, D5,
      F5, E5, D5, C5,      B4, C5, A4, null,
    ],
    arpeggio: [
      A4, E5, A5, E5,      G4, D5, G5, D5,
      F4, C5, F5, C5,      E4, B4, E5, B4,
      A4, E5, A5, E5,      C5, G5, C6, G5,
      D5, A5, D6, A5,      E5, B5, E6, B5,
    ],
    chords: [
      { step: 0, notes: [A2, C3, E3, A3], durationSteps: 8 },
      { step: 8, notes: [F2, A2, C3, F3], durationSteps: 8 },
      { step: 16, notes: [A2, C3, E3, A3], durationSteps: 8 },
      { step: 24, notes: [D3, F3, A3, D4], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 4, 8, 12, 16, 20, 24, 28],
      snares: [4, 12, 20, 28],
      hats: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
    },
    style: {
      leadType: 'spanishPluck',
      bassType: 'gothicBass',
      padType: 'darkChoir',
    },
  },

  // Clock Tower / Castle: Ticking harpsichord + dramatic gothic organ/brass chords
  clockTower: {
    id: 'clockTower',
    bpm: 128,
    steps: 32,
    bass: [
      D2, D2, D2, D2,      Bb1, Bb1, Bb1, Bb1,
      G1, G1, G1, G1,      A1, A1, Cs2, Cs2,
      D2, D2, D2, D2,      F2, F2, F2, F2,
      G2, G2, G2, G2,      A2, A2, A1, A1,
    ],
    lead: [
      D4, F4, A4, D5,      Bb4, D5, F5, D5,
      G4, Bb4, D5, G5,     Cs5, E5, G5, E5,
      D5, A4, F4, D4,      F5, C5, A4, F4,
      G5, D5, Bb4, G4,     A5, G5, F5, E5,
    ],
    arpeggio: [
      D5, F5, A5, D6,      Bb4, D5, F5, Bb5,
      G4, Bb4, D5, G5,     A4, Cs5, E5, A5,
      D5, F5, A5, D6,      F4, A4, C5, F5,
      G4, Bb4, D5, G5,     A4, Cs5, E5, A5,
    ],
    chords: [
      { step: 0, notes: [D3, F3, A3, D4], durationSteps: 8 },
      { step: 8, notes: [Bb2, D3, F3, Bb3], durationSteps: 8 },
      { step: 16, notes: [G2, Bb2, D3, G3], durationSteps: 8 },
      { step: 24, notes: [A2, Cs3, E3, A3], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 8, 16, 24],
      snares: [8, 24],
      clockTicks: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
    },
    style: {
      leadType: 'harpsichord',
      bassType: 'gothicBass',
      padType: 'cathedralOrgan',
    },
  },

  // Passage Safe Room: Warm calm campfire lute & soft pad
  passage: {
    id: 'passage',
    bpm: 72,
    steps: 32,
    bass: [
      D2, null, null, null, F2, null, null, null,
      G2, null, null, null, A2, null, null, null,
      Bb2, null, null, null, A2, null, null, null,
      G2, null, null, null, D2, null, null, null,
    ],
    lead: [
      D4, null, F4, null,   A4, null, D5, null,
      C5, null, A4, null,   F4, null, G4, null,
      A4, null, Bb4, null,  A4, null, G4, null,
      F4, null, E4, null,   D4, null, null, null,
    ],
    arpeggio: [
      null, F4, A4, null,   null, A4, D5, null,
      null, E4, G4, null,   null, D4, F4, null,
      null, F4, Bb4, null,  null, E4, A4, null,
      null, D4, G4, null,   null, Cs4, E4, null,
    ],
    chords: [
      { step: 0, notes: [D3, F3, A3, C4], durationSteps: 8 },
      { step: 8, notes: [G2, Bb2, D3, F3], durationSteps: 8 },
      { step: 16, notes: [Bb2, D3, F3, A3], durationSteps: 8 },
      { step: 24, notes: [A2, Cs3, E3, G3], durationSteps: 8 },
    ],
    drums: {
      hats: [0, 8, 16, 24],
    },
    style: {
      leadType: 'spanishPluck',
      bassType: 'deepPulse',
      padType: 'warmCampfire',
    },
  },

  // Boss Combat Theme: Urgent high-energy combat theme
  boss: {
    id: 'boss',
    bpm: 144,
    steps: 32,
    bass: [
      D2, D2, D2, D2,      D2, D2, F2, G2,
      Ab2, G2, F2, D2,     D2, D2, Cs2, C2,
      B1, B1, B1, B1,      B1, B1, D2, E2,
      F2, E2, D2, B1,      C2, Cs2, D2, Eb2,
    ],
    lead: [
      D4, D4, F4, G4,      Ab4, G4, F4, D4,
      F4, G4, Ab4, D5,     Cs5, D5, Cs5, A4,
      B4, B4, D5, E5,      F5, E5, D5, B4,
      D5, E5, F5, B5,      A5, B5, A5, F5,
    ],
    arpeggio: [
      D5, A5, D6, A5,      D5, A5, D6, A5,
      Ab5, D5, F5, D5,     Cs5, G4, A4, E4,
      B4, Fs5, B5, Fs5,    B4, Fs5, B5, Fs5,
      F5, B4, D5, B4,      A4, E4, F4, Cs4,
    ],
    chords: [
      { step: 0, notes: [D3, F3, Ab3, D4], durationSteps: 8 },
      { step: 8, notes: [D3, F3, A3, Cs4], durationSteps: 8 },
      { step: 16, notes: [B2, D3, F3, B3], durationSteps: 8 },
      { step: 24, notes: [A2, C3, Eb3, A3], durationSteps: 8 },
    ],
    drums: {
      kicks: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
      snares: [4, 12, 20, 28],
      hats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
    },
    style: {
      leadType: 'organ',
      bassType: 'gothicBass',
      padType: 'cathedralOrgan',
    },
  },
};

/**
 * Procedural Web Audio Baroque / Dark-Synth Biome Music Synthesizer.
 * Schedules authentic Spanish-baroque plucked lutes, harpsichords, bubbling basslines,
 * gothic organs, and atmospheric percussion via a sample-accurate lookahead clock.
 */
export class SynthMusic {
  private activeThemeKey: string | null = null;
  private currentGainNode: GainNode | null = null;
  private timerId: number | null = null;

  private currentStep = 0;
  private nextStepTime = 0;
  private isPlaying = false;

  public setBiomeMusic(
    ctx: AudioContext,
    musicBus: AudioNode,
    biomeId: BiomeId,
    isBoss: boolean
  ): void {
    if (ctx.state === 'suspended') return;

    let targetKey: string;
    if (isBoss || biomeId === 'Bridge' || biomeId === 'TopClockTower' || biomeId === 'Throne') {
      targetKey = 'boss';
    } else {
      switch (biomeId) {
        case 'PrisonStart':
          targetKey = 'prison';
          break;
        case 'PrisonCourtyard':
        case 'StiltVillage':
          targetKey = 'promenade';
          break;
        case 'Sewer':
          targetKey = 'sewer';
          break;
        case 'PrisonRoof':
          targetKey = 'ramparts';
          break;
        case 'ClockTower':
        case 'Castle':
          targetKey = 'clockTower';
          break;
        case 'Passage':
          targetKey = 'passage';
          break;
        default:
          targetKey = 'prison';
          break;
      }
    }

    if (this.activeThemeKey === targetKey && this.isPlaying) {
      return;
    }

    this.transitionToTheme(ctx, musicBus, targetKey);
  }

  private transitionToTheme(ctx: AudioContext, musicBus: AudioNode, themeKey: string): void {
    const theme = THEMES[themeKey] ?? THEMES.prison;

    // Crossfade: fade out previous theme gain if present
    if (this.currentGainNode) {
      const oldGain = this.currentGainNode;
      try {
        oldGain.gain.setValueAtTime(oldGain.gain.value, ctx.currentTime);
        oldGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.0);
        const cleanupTimer = setTimeout(() => {
          try {
            oldGain.disconnect();
          } catch {
            // ignore
          }
        }, 1200);
        if (typeof cleanupTimer === 'object' && cleanupTimer && 'unref' in cleanupTimer) {
          (cleanupTimer as { unref(): void }).unref();
        }
      } catch {
        // ignore
      }
    }

    // Create fresh sub-bus for new theme
    const newGain = ctx.createGain();
    newGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    newGain.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 1.0);
    newGain.connect(musicBus);

    this.currentGainNode = newGain;
    this.activeThemeKey = themeKey;
    this.currentStep = 0;
    this.nextStepTime = ctx.currentTime + 0.05;
    this.isPlaying = true;

    // Restart lookahead scheduler loop
    if (this.timerId !== null) {
      clearInterval(this.timerId);
    }
    const intervalFn = typeof window !== 'undefined' ? window.setInterval : setInterval;
    this.timerId = intervalFn(() => {
      this.schedulerTick(ctx, newGain, theme);
    }, 25) as unknown as number;
  }

  private schedulerTick(ctx: AudioContext, themeGain: GainNode, theme: BiomeThemeData): void {
    if (!this.isPlaying || ctx.state === 'suspended') return;

    const scheduleAheadSec = 0.12;
    const stepDuration = (60 / theme.bpm) / 4; // 16th note step

    while (this.nextStepTime < ctx.currentTime + scheduleAheadSec) {
      this.scheduleStep(ctx, themeGain, theme, this.currentStep, this.nextStepTime, stepDuration);
      this.nextStepTime += stepDuration;
      this.currentStep = (this.currentStep + 1) % theme.steps;
    }
  }

  private scheduleStep(
    ctx: AudioContext,
    out: AudioNode,
    theme: BiomeThemeData,
    step: number,
    time: number,
    stepDuration: number
  ): void {
    // 1. Bassline
    const bassNote = theme.bass[step];
    if (bassNote !== null && bassNote !== undefined) {
      const freq = m2f(bassNote);
      if (theme.style.bassType === 'bubbleBass') {
        this.synthBubbleBass(ctx, out, freq, time, stepDuration * 1.5);
      } else if (theme.style.bassType === 'deepPulse') {
        this.synthDeepPulse(ctx, out, freq, time, stepDuration * 2);
      } else {
        this.synthGothicBass(ctx, out, freq, time, stepDuration * 1.8);
      }
    }

    // 2. Melody Lead
    const leadNote = theme.lead[step];
    if (leadNote !== null && leadNote !== undefined) {
      const freq = m2f(leadNote);
      if (theme.style.leadType === 'spanishPluck') {
        this.synthSpanishPluck(ctx, out, freq, time, stepDuration * 2.5);
      } else if (theme.style.leadType === 'harpsichord') {
        this.synthHarpsichord(ctx, out, freq, time, stepDuration * 1.5);
      } else if (theme.style.leadType === 'organ') {
        this.synthOrgan(ctx, out, freq, time, stepDuration * 2.0);
      } else {
        this.synthFluteHarmonic(ctx, out, freq, time, stepDuration * 3.0);
      }
    }

    // 3. Arpeggios
    if (theme.arpeggio) {
      const arpNote = theme.arpeggio[step];
      if (arpNote !== null && arpNote !== undefined) {
        const freq = m2f(arpNote);
        this.synthSpanishPluck(ctx, out, freq, time, stepDuration * 1.2, 0.12);
      }
    }

    // 4. Pad / Chords on bar boundaries
    if (theme.chords) {
      for (const chord of theme.chords) {
        if (chord.step === step) {
          this.synthPadChord(ctx, out, chord.notes, time, chord.durationSteps * stepDuration, theme.style.padType);
        }
      }
    }

    // 5. Percussion
    if (theme.drums.kicks?.includes(step)) {
      this.synthKick(ctx, out, time);
    }
    if (theme.drums.snares?.includes(step)) {
      this.synthSnare(ctx, out, time);
    }
    if (theme.drums.hats?.includes(step)) {
      this.synthHiHat(ctx, out, time);
    }
    if (theme.drums.clockTicks?.includes(step)) {
      this.synthClockTick(ctx, out, time, step % 4 === 0);
    }
    if (theme.drums.tribalPerc) {
      for (const tp of theme.drums.tribalPerc) {
        if (tp.step === step) {
          this.synthTribalPerc(ctx, out, time, tp.pitch);
        }
      }
    }
  }

  // --- Instrument Sound Synthesizers ---

  /**
   * Spanish Baroque acoustic plucked lute / guitar with realistic bright pluck transient and wooden decay.
   */
  private synthSpanishPluck(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number,
    vol = 0.22
  ): void {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, time);
    osc2.frequency.setValueAtTime(freq * 1.002, time); // Subtle unison chorus

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 4.5, time);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.2, time + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(vol, time + 0.003); // Instant attack
    gain.gain.exponentialRampToValueAtTime(vol * 0.4, time + 0.08); // Initial pluck drop
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
  }

  /**
   * Bright, rhythmic antique Harpsichord with high harmonic brilliance.
   */
  private synthHarpsichord(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'square';
    osc2.type = 'sawtooth';
    osc1.frequency.setValueAtTime(freq, time);
    osc2.frequency.setValueAtTime(freq * 2.003, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.5;
    filter.frequency.setValueAtTime(2400, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.18, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
  }

  /**
   * Heavy gothic pipe organ / brass lead.
   */
  private synthOrgan(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const osc3 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'square';
    osc3.type = 'sawtooth';
    osc1.frequency.setValueAtTime(freq, time);
    osc2.frequency.setValueAtTime(freq * 2, time);
    osc3.frequency.setValueAtTime(freq * 1.5, time); // Perfect fifth overtone

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.2, time + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    osc3.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc1.start(time);
    osc2.start(time);
    osc3.start(time);
    osc1.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
    osc3.stop(time + duration + 0.05);
  }

  /**
   * Eerie high harmonic flute / glass chime.
   */
  private synthFluteHarmonic(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.14, time + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  /**
   * Deep, weighty gothic bass pulse.
   */
  private synthGothicBass(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const sub = ctx.createOscillator();
    const saw = ctx.createOscillator();
    sub.type = 'sine';
    saw.type = 'sawtooth';
    sub.frequency.setValueAtTime(freq * 0.5, time);
    saw.frequency.setValueAtTime(freq, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(260, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.32, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    sub.connect(gain);
    saw.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    sub.start(time);
    saw.start(time);
    sub.stop(time + duration + 0.05);
    saw.stop(time + duration + 0.05);
  }

  /**
   * Resonant bubbling toxic bass ostinato with high Q filter envelope.
   */
  private synthBubbleBass(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 6.5;
    filter.frequency.setValueAtTime(110, time);
    filter.frequency.exponentialRampToValueAtTime(750, time + 0.05);
    filter.frequency.exponentialRampToValueAtTime(100, time + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.3, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  /**
   * Warm subterranean sub-bass pulse.
   */
  private synthDeepPulse(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    time: number,
    duration: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 0.5, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.3, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  /**
   * Ambient chord pads (dark choir, warm campfire lute/pad, or cathedral organ).
   */
  private synthPadChord(
    ctx: AudioContext,
    out: AudioNode,
    notes: number[],
    time: number,
    duration: number,
    padType: 'darkChoir' | 'warmCampfire' | 'cathedralOrgan' | 'none'
  ): void {
    if (padType === 'none') return;

    notes.forEach((note) => {
      const freq = m2f(note);
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      if (padType === 'cathedralOrgan') {
        osc.type = 'sawtooth';
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(950, time);
        gain.gain.setValueAtTime(0.001, time);
        gain.gain.linearRampToValueAtTime(0.07, time + 0.1);
      } else if (padType === 'warmCampfire') {
        osc.type = 'triangle';
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(600, time);
        gain.gain.setValueAtTime(0.001, time);
        gain.gain.linearRampToValueAtTime(0.09, time + 0.35);
      } else {
        // darkChoir
        osc.type = 'sawtooth';
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(700, time);
        filter.Q.value = 1.8;
        gain.gain.setValueAtTime(0.001, time);
        gain.gain.linearRampToValueAtTime(0.06, time + 0.4);
      }

      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(out);

      osc.start(time);
      osc.stop(time + duration + 0.05);
    });
  }

  // --- Drum / Percussion Synthesizers ---

  private synthKick(ctx: AudioContext, out: AudioNode, time: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.08);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);

    osc.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + 0.11);
  }

  private synthSnare(ctx: AudioContext, out: AudioNode, time: number): void {
    // Noise snap
    const bufferSize = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    noise.start(time);
    noise.stop(time + 0.13);
  }

  private synthHiHat(ctx: AudioContext, out: AudioNode, time: number): void {
    const bufferSize = Math.floor(ctx.sampleRate * 0.035);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(9000, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    noise.start(time);
    noise.stop(time + 0.04);
  }

  private synthClockTick(ctx: AudioContext, out: AudioNode, time: number, isAccent: boolean): void {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isAccent ? 3200 : 2600, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(isAccent ? 0.16 : 0.09, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);

    osc.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + 0.025);
  }

  private synthTribalPerc(ctx: AudioContext, out: AudioNode, time: number, pitch: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, time);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.6, time + 0.06);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);

    osc.connect(gain);
    gain.connect(out);

    osc.start(time);
    osc.stop(time + 0.08);
  }

  public stop(): void {
    this.isPlaying = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.currentGainNode) {
      try {
        this.currentGainNode.disconnect();
      } catch {
        // ignore
      }
      this.currentGainNode = null;
    }
    this.activeThemeKey = null;
  }

  public dispose(): void {
    this.stop();
  }
}
