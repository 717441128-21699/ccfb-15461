import type { PcmBufferLike, TrackSpec } from '../core/types';

export const FAST_SAMPLE_RATE = 3200;
export const PLAYBACK_SAMPLE_RATE = 22050;

class FloatPcmBuffer implements PcmBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels = 1;
  private data: Float32Array;

  constructor(sampleRate: number, data: Float32Array) {
    this.sampleRate = sampleRate;
    this.length = data.length;
    this.data = data;
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

/**
 * Deterministic procedural synth. The same function can render a complete
 * playback buffer or a small absolute-time window used by the fast analyzer.
 *
 * All audio is ordinary PCM that Web Audio plays through AudioBufferSourceNode;
 * the browser graph itself is assembled in broadcastEngine.ts.
 */
export function renderTrackWindow(
  spec: TrackSpec,
  sampleRate: number,
  windowStartSec = 0,
  windowDurationSec: number = spec.durationSec,
): Float32Array {
  const length = Math.max(1, Math.floor(windowDurationSec * sampleRate));
  const out = new Float32Array(length);
  if (spec.style === 'timesignal') {
    renderTimeSignal(spec, sampleRate, windowStartSec, out);
    return out;
  }

  const beatPeriod = 60 / spec.bpm;
  const seedPhase = (spec.seed % 997) / 997;
  const isElectronic = spec.style === 'electronic';
  const isRock = spec.style === 'rock';
  const isBallad = spec.style === 'ballad';
  const isFolk = spec.style === 'folk';
  const isAd = spec.kind === 'ad';
  const isNews = spec.kind === 'news';

  for (let i = 0; i < length; i++) {
    const t = windowStartSec + i / sampleRate;
    if (t < 0 || t >= spec.durationSec) continue;

    let sample = 0;
    const beatFloat = (t - spec.firstBeatSec) / beatPeriod;
    const beatIndex = Math.floor(beatFloat);
    const beatPhase = beatFloat - beatIndex;
    const inBeatGrid = beatFloat >= 0;
    const barBeat = ((beatIndex % 4) + 4) % 4;

    // Master arrangement envelope and the detectable outro fade.
    let master = 0.9;
    if (t < 0.03) master *= t / 0.03;
    if (t > spec.fadeStartSec && spec.fadeEndSec > spec.fadeStartSec) {
      const p = Math.min(1, (t - spec.fadeStartSec) / (spec.fadeEndSec - spec.fadeStartSec));
      master *= 1 - p * p * (3 - 2 * p);
    }
    if (t > spec.durationSec - 0.015) master *= Math.max(0, (spec.durationSec - t) / 0.015);

    // Kick and snare/hat patterns give the beat tracker clear onsets.
    if (inBeatGrid) {
      const kickPattern = isElectronic || isRock ? true : barBeat === 0 || barBeat === 2;
      if (kickPattern) {
        const kEnv = Math.exp(-beatPhase * (isElectronic ? 22 : 30));
        sample += 0.72 * spec.energy * kEnv * Math.sin(2 * Math.PI * (72 + 38 * Math.exp(-beatPhase * 18)) * beatPhase * beatPeriod);
      }
      if ((barBeat === 1 || barBeat === 3) && !isBallad) {
        const snareEnv = Math.exp(-beatPhase * 24);
        sample += 0.28 * spec.energy * snareEnv * (hashNoise(beatIndex, i) * 2 - 1);
        sample += 0.12 * snareEnv * Math.sin(2 * Math.PI * 190 * t);
      }
      if (!isBallad && beatPhase >= 0.5) {
        const hatPhase = beatPhase - 0.5;
        const hatEnv = Math.exp(-hatPhase * 55);
        sample += 0.08 * spec.energy * hatEnv * (hashNoise(beatIndex * 2 + 1, i) * 2 - 1);
      }
    }

    // Bass line.
    if (inBeatGrid) {
      const scale = [0, 3, 5, 7, 10];
      const bar = Math.floor(beatIndex / 4);
      const rootMidi = 40 + scale[(bar + Math.floor(seedPhase * 5)) % scale.length];
      const bassFreq = midiToFreq(rootMidi);
      const bassEnv = Math.exp(-beatPhase * (isBallad ? 4.5 : 8));
      sample += (isRock ? 0.3 : 0.22) * spec.energy * bassEnv * triangle(2 * Math.PI * bassFreq * t);
    }

    // Sparse chord/pad bed. Triangle is cheap and survives 8 kHz analysis.
    if (beatFloat >= 0) {
      const barLength = 4 * beatPeriod;
      const chordIndex = Math.floor((t - spec.firstBeatSec) / barLength);
      const chordRoot = [57, 60, 62, 55][((chordIndex % 4) + 4) % 4] + (isBallad ? -12 : 0);
      const chordGate = isAd || isNews ? 1 : 0.45 + 0.2 * Math.sin(Math.PI * beatPhase);
      const pad =
        triangle(2 * Math.PI * midiToFreq(chordRoot) * t) +
        0.7 * triangle(2 * Math.PI * midiToFreq(chordRoot + 4) * t) +
        0.5 * triangle(2 * Math.PI * midiToFreq(chordRoot + 7) * t);
      sample += (isFolk ? 0.055 : 0.04) * chordGate * pad;
    }

    // Lead vocal / spoken voice surrogate: harmonic source + syllable AM.
    if (spec.vocalInSec !== null && spec.vocalEndSec !== null && t >= spec.vocalInSec && t <= spec.vocalEndSec) {
      const phrase = Math.floor((t - spec.vocalInSec) / 2.0);
      const phraseGap = phrase % 7 === 6 ? 0.62 : 1;
      const syllable = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * (isAd ? 5.2 : 4.1) * t + seedPhase * 6), 1.45);
      const noteSlot = Math.floor((t - spec.vocalInSec) / 0.38);
      const melody = [0, 2, 4, 7, 9, 7, 4, 2];
      const midi = (isBallad ? 62 : 67) + melody[(noteSlot + Math.floor(seedPhase * 8)) % melody.length];
      const f0 = midiToFreq(midi);
      const vibrato = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t);
      const phase = 2 * Math.PI * f0 * vibrato * t;
      const voice = Math.sin(phase) + 0.5 * Math.sin(2 * phase);
      const voiceLevel = (isAd || isNews ? 0.46 : 0.36) * phraseGap * (0.35 + 0.65 * syllable);
      sample += voiceLevel * voice;
    }

    out[i] = Math.tanh(sample * master * 0.82);
  }

  return out;
}

function renderTimeSignal(spec: TrackSpec, sampleRate: number, startSec: number, out: Float32Array): void {
  const beeps = spec.beats ?? [0, 0.8, 1.6, 2.4, 3.2, 4.0];
  for (let i = 0; i < out.length; i++) {
    const t = startSec + i / sampleRate;
    let s = 0;
    for (let b = 0; b < beeps.length; b++) {
      const begin = beeps[b];
      const duration = b === beeps.length - 1 ? 1.15 : 0.22;
      if (t >= begin && t < begin + duration) {
        const local = t - begin;
        const attack = Math.min(1, local / 0.006);
        const release = Math.min(1, (duration - local) / 0.018);
        const env = Math.min(attack, Math.max(0, release));
        const freq = b === beeps.length - 1 ? 1175 : 880;
        s += 0.82 * env * Math.sin(2 * Math.PI * freq * t);
        s += 0.18 * env * Math.sin(2 * Math.PI * freq * 2 * t);
      }
    }
    out[i] = Math.tanh(s * 0.9);
  }
}

export function renderPcmBuffer(spec: TrackSpec, sampleRate = PLAYBACK_SAMPLE_RATE): PcmBufferLike {
  const data = renderTrackWindow(spec, sampleRate, 0, spec.durationSec);
  return new FloatPcmBuffer(sampleRate, data);
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function triangle(phase: number): number {
  const x = phase / (2 * Math.PI);
  const f = x - Math.floor(x);
  return 4 * Math.abs(f - 0.5) - 1;
}

function hashNoise(a: number, b: number): number {
  let h = Math.imul(a + 17, 374761393) ^ Math.imul(b + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
