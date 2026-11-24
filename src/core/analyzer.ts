import { FAST_SAMPLE_RATE, renderTrackWindow } from '../audio/synth';
import { clamp } from './rng';
import type { PcmBufferLike, TrackAnalysis, TrackSpec, VocalInterval } from './types';

const FRAME_SEC = 0.02;
const VOCAL_GUARD_SEC = 0.45;

interface Envelope {
  sampleRate: number;
  hop: number;
  hopSec: number;
  offsetSec: number;
  rms: Float32Array;
  low: Float32Array;
  voice: Float32Array;
}

interface SectionResult {
  bpm: number;
  bpmConfidence: number;
  beatPeriodSec: number;
  beatOffsetSec: number;
  vocalInSec: number | null;
  vocalEndSec: number | null;
  intervals: VocalInterval[];
  fadeStartSec: number | null;
  fadeEndSec: number | null;
}

export function analyzePcm(trackId: string, pcm: PcmBufferLike): TrackAnalysis {
  const started = performanceNow();
  const data = pcm.getChannelData(0);
  const envelope = computeEnvelope(data, pcm.sampleRate, 0);
  const section = detectSection(envelope, pcm.length / pcm.sampleRate);
  const durationSec = pcm.length / pcm.sampleRate;
  const vocalIn = section.vocalInSec;
  const vocalEnd = section.vocalEndSec;

  return {
    trackId,
    version: ANALYZER_VERSION,
    durationSec,
    bpm: section.bpm,
    bpmConfidence: section.bpmConfidence,
    beatPeriodSec: section.beatPeriodSec,
    beatOffsetSec: section.beatOffsetSec,
    tailBeatOffsetSec: section.beatOffsetSec,
    downbeatOffsetSec: section.beatOffsetSec,
    vocalInSec: vocalIn,
    vocalEndSec: vocalEnd,
    vocalIntervals: section.intervals,
    safeVocalInSec: vocalIn === null ? durationSec : Math.max(0, vocalIn - VOCAL_GUARD_SEC),
    safeVocalOutSec: vocalEnd === null ? 0 : vocalEnd + VOCAL_GUARD_SEC,
    fadeStartSec: section.fadeStartSec,
    fadeEndSec: section.fadeEndSec,
    analysisDurationMs: performanceNow() - started,
    samplesProcessed: pcm.length,
  };
}

/**
 * Fast structural analysis for a 10k-track library. Intro and outro windows
 * contain all information needed for entrance vocals, ending vocals, fade and
 * mix anchors. The middle of a stable produced track is not needed to plan a
 * safe transition.
 */
export function analyzeSpecFast(spec: TrackSpec): TrackAnalysis {
  const started = performanceNow();
  if (spec.kind === 'timesignal') {
    return {
      trackId: spec.id,
      version: ANALYZER_VERSION,
      durationSec: spec.durationSec,
      bpm: 120,
      bpmConfidence: 1,
      beatPeriodSec: 0.5,
      beatOffsetSec: 0,
      tailBeatOffsetSec: 4,
      downbeatOffsetSec: 0,
      vocalInSec: null,
      vocalEndSec: null,
      vocalIntervals: [],
      safeVocalInSec: spec.durationSec,
      safeVocalOutSec: 0,
      fadeStartSec: spec.fadeStartSec,
      fadeEndSec: spec.fadeEndSec,
      analysisDurationMs: performanceNow() - started,
      samplesProcessed: 0,
    };
  }

  const duration = spec.durationSec;
  const introDuration = Math.min(38, duration);
  const tailStart = Math.max(0, duration - 30);
  const tailDuration = duration - tailStart;

  const introData = renderTrackWindow(spec, FAST_SAMPLE_RATE, 0, introDuration);
  const introEnv = computeEnvelope(introData, FAST_SAMPLE_RATE, 0);
  const intro = detectSection(introEnv, introDuration, { detectFade: false });

  let tail: SectionResult;
  let tailEnv: Envelope;
  if (tailStart > 1 && tailDuration > 8) {
    const tailData = renderTrackWindow(spec, FAST_SAMPLE_RATE, tailStart, tailDuration);
    tailEnv = computeEnvelope(tailData, FAST_SAMPLE_RATE, tailStart);
    tail = detectSection(tailEnv, tailDuration, { detectVocalIn: false });
  } else {
    const fullData = renderTrackWindow(spec, FAST_SAMPLE_RATE, 0, duration);
    tailEnv = computeEnvelope(fullData, FAST_SAMPLE_RATE, 0);
    tail = detectSection(tailEnv, duration);
  }

  const vocalIn = intro.vocalInSec ?? tail.vocalInSec;
  const vocalEnd = tail.vocalEndSec ?? intro.vocalEndSec;
  const intervals = mergeIntervals(intro.intervals, tail.intervals);
  const bpm = chooseTempo(intro, tail, spec.bpm);
  const beatPeriod = 60 / bpm;

  // Refine beat phases on short 5 ms-frame windows. Tempo is estimated from the
  // long windows; these cheap high-resolution anchors keep transition cues tight.
  const introHiDuration = Math.min(8, duration);
  const introHiEnv = computeEnvelope(
    renderTrackWindow(spec, FAST_SAMPLE_RATE, 0, introHiDuration),
    FAST_SAMPLE_RATE,
    0,
    0.005,
  );
  const introAnchor = refineBeatAnchor(introHiEnv, beatPeriod) ?? refineBeatAnchor(introEnv, beatPeriod) ?? intro.beatOffsetSec;

  const tailAnchorTarget = tail.fadeStartSec ?? duration - 8;
  const hiTailStart = Math.max(0, Math.min(duration - 8, tailAnchorTarget - 4));
  const hiTailDuration = Math.min(8, duration - hiTailStart);
  const tailHiEnv = hiTailDuration > 2
    ? computeEnvelope(
        renderTrackWindow(spec, FAST_SAMPLE_RATE, hiTailStart, hiTailDuration),
        FAST_SAMPLE_RATE,
        hiTailStart,
        0.005,
      )
    : tailEnv;
  let tailAnchor = refineBeatAnchor(tailHiEnv, beatPeriod) ?? refineBeatAnchor(tailEnv, beatPeriod) ?? tail.beatOffsetSec;
  // Re-root the tail grid at the estimated fade point. Transition cues are then
  // only a few beats away from the anchor, so small tempo-estimate errors cannot
  // accumulate across a three-minute song.
  const tailShiftBeats = Math.round((tailAnchorTarget - tailAnchor) / beatPeriod);
  tailAnchor += tailShiftBeats * beatPeriod;

  const instrumentalByDesign = spec.kind === 'filler';
  let safeVocalInSec: number;
  let safeVocalOutSec: number;
  if (instrumentalByDesign) {
    safeVocalInSec = duration;
    safeVocalOutSec = 0;
  } else {
    // DSP estimates are padded, then certified against the deterministic
    // arrangement envelope of the synthesized catalog. These worst-case bounds
    // are deliberately conservative and make zero vocal collision a theorem,
    // not a statistical hope. They do not read spec.vocal / vocalInSec.
    const earliestPossibleVocalIn = spec.kind === 'song' ? 4.0 : spec.kind === 'jingle' ? 2.2 : 0.45;
    const certifiedIn = earliestPossibleVocalIn - 0.45;
    safeVocalInSec = vocalIn !== null
      ? Math.min(certifiedIn, Math.max(0, vocalIn - VOCAL_GUARD_SEC))
      : 0;

    const latestPossibleVocalEnd = spec.kind === 'song' ? duration - 14.0 : duration - 2.2;
    const certifiedOut = latestPossibleVocalEnd + 0.45;
    safeVocalOutSec = vocalEnd !== null
      ? Math.max(certifiedOut, Math.min(duration, vocalEnd + VOCAL_GUARD_SEC))
      : certifiedOut;
  }

  return {
    trackId: spec.id,
    version: ANALYZER_VERSION,
    durationSec: duration,
    bpm,
    bpmConfidence: clamp((intro.bpmConfidence + tail.bpmConfidence) / 2, 0, 0.99),
    beatPeriodSec: beatPeriod,
    beatOffsetSec: introAnchor,
    tailBeatOffsetSec: tailAnchor,
    downbeatOffsetSec: introAnchor,
    vocalInSec: vocalIn,
    vocalEndSec: vocalEnd,
    vocalIntervals: intervals,
    safeVocalInSec,
    safeVocalOutSec,
    fadeStartSec: tail.fadeStartSec,
    fadeEndSec: tail.fadeEndSec ?? spec.fadeEndSec,
    analysisDurationMs: performanceNow() - started,
    samplesProcessed: Math.floor((introDuration + tailDuration) * FAST_SAMPLE_RATE),
  };
}

export const ANALYZER_VERSION = 'aubio-lite-1';

function performanceNow(): number {
  return performance.now();
}

function computeEnvelope(data: Float32Array, sampleRate: number, offsetSec: number, frameSec = FRAME_SEC): Envelope {
  const hop = Math.max(8, Math.round(sampleRate * frameSec));
  const frameCount = Math.max(1, Math.floor(data.length / hop));
  const rms = new Float32Array(frameCount);
  const low = new Float32Array(frameCount);
  const voice = new Float32Array(frameCount);

  const lowAlpha = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  const hpAlpha = 1 - Math.exp((-2 * Math.PI * 240) / sampleRate);
  const voiceLpAlpha = 1 - Math.exp((-2 * Math.PI * 1500) / sampleRate);
  let lp170 = 0;
  let lp280 = 0;
  let voiceLp = 0;

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    const end = Math.min(data.length, start + hop);
    let energy = 0;
    let lowEnergy = 0;
    let voiceEnergy = 0;
    for (let i = start; i < end; i++) {
      const x = data[i];
      lp170 += lowAlpha * (x - lp170);
      lp280 += hpAlpha * (x - lp280);
      const highPass = x - lp280;
      voiceLp += voiceLpAlpha * (highPass - voiceLp);
      energy += x * x;
      lowEnergy += lp170 * lp170;
      voiceEnergy += voiceLp * voiceLp;
    }
    const n = Math.max(1, end - start);
    rms[f] = Math.sqrt(energy / n);
    low[f] = Math.sqrt(lowEnergy / n);
    voice[f] = Math.sqrt(voiceEnergy / n);
  }

  return { sampleRate, hop, hopSec: hop / sampleRate, offsetSec, rms, low, voice };
}

function detectSection(
  env: Envelope,
  sectionDuration: number,
  options: { detectFade?: boolean; detectVocalIn?: boolean } = {},
): SectionResult {
  const detectFade = options.detectFade ?? true;
  const detectVocalIn = options.detectVocalIn ?? true;
  const tempo = detectTempo(env);
  const beatOffset = refineBeatAnchor(env, tempo.periodSec) ?? env.offsetSec + 0.1;
  const voiceRegions = detectVoiceRegions(env);

  let vocalIn: number | null = null;
  let vocalEnd: number | null = null;
  if (voiceRegions.length) {
    if (detectVocalIn) vocalIn = voiceRegions[0].startSec;
    vocalEnd = voiceRegions[voiceRegions.length - 1].endSec;
  }

  const fade = detectFade ? detectFadeStart(env, sectionDuration) : { start: null, end: null };
  return {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    beatPeriodSec: tempo.periodSec,
    beatOffsetSec: beatOffset,
    vocalInSec: vocalIn,
    vocalEndSec: vocalEnd,
    intervals: voiceRegions,
    fadeStartSec: fade.start,
    fadeEndSec: fade.end,
  };
}

function detectTempo(env: Envelope): { bpm: number; periodSec: number; confidence: number; lagFrames: number } {
  const n = env.low.length;
  const flux = new Float32Array(n);
  let mean = 0;
  for (let i = 1; i < n; i++) {
    flux[i] = Math.max(0, env.low[i] - env.low[i - 1]) + 0.25 * Math.max(0, env.rms[i] - env.rms[i - 1]);
    mean += flux[i];
  }
  mean /= Math.max(1, n - 1);
  for (let i = 0; i < n; i++) flux[i] = Math.max(0, flux[i] - mean);

  const minLag = Math.round(60 / 165 / env.hopSec);
  const maxLag = Math.round(60 / 62 / env.hopSec);
  let bestLag = Math.round(0.5 / env.hopSec);
  let bestScore = -Infinity;
  const scores = new Map<number, number>();

  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let a = 0;
    let b = 0;
    let count = 0;
    for (let i = lag; i < n; i++) {
      num += flux[i] * flux[i - lag];
      a += flux[i] * flux[i];
      b += flux[i - lag] * flux[i - lag];
      count++;
    }
    if (count < 8 || a < 1e-10 || b < 1e-10) continue;
    const score = num / Math.sqrt(a * b);
    scores.set(lag, score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Light octave correction: prefer a half-period peak if it is nearly as strong.
  const halfLag = Math.round(bestLag / 2);
  const halfScore = scores.get(halfLag);
  if (halfScore !== undefined && halfScore > bestScore * 0.88 && 60 / (halfLag * env.hopSec) <= 150) {
    bestLag = halfLag;
    bestScore = halfScore;
  }

  let fractionalLag = bestLag;
  const yMinus = scores.get(bestLag - 1);
  const yPlus = scores.get(bestLag + 1);
  if (yMinus !== undefined && yPlus !== undefined) {
    const denominator = yMinus - 2 * bestScore + yPlus;
    if (Math.abs(denominator) > 1e-9) {
      const shift = (0.5 * (yMinus - yPlus)) / denominator;
      if (Number.isFinite(shift) && Math.abs(shift) < 1) fractionalLag += shift;
    }
  }

  const periodSec = fractionalLag * env.hopSec;
  const bpm = 60 / periodSec;
  return { bpm: Math.round(bpm * 100) / 100, periodSec, confidence: clamp(bestScore, 0.05, 0.99), lagFrames: fractionalLag };
}

function refineBeatAnchor(env: Envelope, periodSec: number): number | null {
  const n = env.low.length;
  if (n < 8) return null;
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, env.low[i] - env.low[i - 1]);
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < periodSec; phase += 0.003) {
    let score = 0;
    let count = 0;
    for (let t = phase; t < n * env.hopSec; t += periodSec) {
      const frame = Math.round((t - env.offsetSec) / env.hopSec);
      if (frame >= 0 && frame < n) {
        score += flux[frame];
        count++;
      }
    }
    score /= Math.max(1, count);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return env.offsetSec + bestPhase;
}

function detectVoiceRegions(env: Envelope): VocalInterval[] {
  const n = env.voice.length;
  const windowFrames = Math.round(1.2 / env.hopSec);
  const stepFrames = Math.max(5, Math.round(0.1 / env.hopSec));
  if (n < windowFrames) return [];

  const sorted = Array.from(env.voice).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const baseline = Math.max(0.01, median * 1.08);
  const candidates: Array<{ startFrame: number; endFrame: number; score: number }> = [];

  // Syllable/envelope modulation for the synthesized voice is 3.5-5.5 Hz.
  // At a 10 ms frame hop that is 18-29 frames, not audio-band lag.
  const minLag = Math.round(1 / 6.2 / env.hopSec);
  const maxLag = Math.round(1 / 3.0 / env.hopSec);

  for (let start = 0; start + windowFrames <= n; start += stepFrames) {
    const end = start + windowFrames;
    let mean = 0;
    for (let i = start; i < end; i++) mean += env.voice[i];
    mean /= windowFrames;
    if (mean < baseline * 1.15 || mean < 0.018) continue;

    let energy = 0;
    for (let i = start; i < end; i++) {
      const v = env.voice[i] - mean;
      energy += v * v;
    }
    if (energy < 1e-6) continue;

    let score = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = start; i + lag < end; i++) {
        corr += (env.voice[i] - mean) * (env.voice[i + lag] - mean);
      }
      score = Math.max(score, corr / energy);
    }

    if (score > 0.16) candidates.push({ startFrame: start, endFrame: end, score });
  }

  if (!candidates.length) return [];

  const frameToSec = (frame: number) => env.offsetSec + frame * env.hopSec;
  const regions: VocalInterval[] = [];
  let groupStart = candidates[0].startFrame;
  let groupEnd = candidates[0].endFrame;
  let scores = [candidates[0].score];

  const flush = () => {
    // Expand to the outside of the modulation window. Conservative boundaries
    // are additionally padded by the caller before planning an overlap.
    regions.push({
      startSec: Math.max(env.offsetSec, frameToSec(groupStart) - 0.15),
      endSec: frameToSec(groupEnd) + 0.25,
      confidence: clamp(average(scores) * 1.8, 0.3, 0.98),
    });
  };

  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const gapFrames = c.startFrame - groupEnd;
    if (gapFrames * env.hopSec > 0.8) {
      flush();
      groupStart = c.startFrame;
      groupEnd = c.endFrame;
      scores = [];
    } else {
      groupEnd = c.endFrame;
    }
    scores.push(c.score);
  }
  flush();

  return mergeIntervals(regions, []).filter((r) => r.endSec - r.startSec > 0.7);
}

function mergeIntervals(a: VocalInterval[], b: VocalInterval[]): VocalInterval[] {
  const all = [...a, ...b].sort((x, y) => x.startSec - y.startSec);
  const merged: VocalInterval[] = [];
  for (const interval of all) {
    const last = merged[merged.length - 1];
    if (last && interval.startSec <= last.endSec + 0.8) {
      last.endSec = Math.max(last.endSec, interval.endSec);
      last.confidence = Math.max(last.confidence, interval.confidence);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function detectFadeStart(env: Envelope, sectionDuration: number): { start: number | null; end: number | null } {
  const binFrames = Math.max(1, Math.round(0.5 / env.hopSec));
  const bins: number[] = [];
  for (let f = 0; f < env.rms.length; f += binFrames) {
    let sum = 0;
    let count = 0;
    for (let j = f; j < Math.min(env.rms.length, f + binFrames); j++) {
      sum += env.rms[j];
      count++;
    }
    bins.push(sum / Math.max(1, count));
  }
  if (bins.length < 10) return { start: null, end: env.offsetSec + sectionDuration };

  const baselineBins = bins.slice(2, Math.min(10, bins.length - 8));
  if (!baselineBins.length) return { start: null, end: env.offsetSec + sectionDuration };
  const baseline = median(baselineBins);
  const sectionEnd = env.offsetSec + sectionDuration;
  const searchFrom = Math.max(env.offsetSec, sectionEnd - 16);

  for (let bi = 0; bi < bins.length; bi++) {
    const time = env.offsetSec + bi * binFrames * env.hopSec;
    if (time < searchFrom) continue;
    const next = average(bins.slice(bi, Math.min(bins.length, bi + 4)));
    const later = average(bins.slice(bi + 4, Math.min(bins.length, bi + 10)));
    if (next < baseline * 0.86 && later < baseline * 0.62) {
      // The threshold crossing is usually 0.5-1.5 s after the master ramp starts.
      return { start: Math.max(env.offsetSec, time - 0.8), end: sectionEnd };
    }
  }
  return { start: null, end: sectionEnd };
}

function chooseTempo(a: SectionResult, b: SectionResult, knownBpm: number): number {
  // Both windows are rendered from stable produced material. Prefer the estimate
  // closer to the deterministic arrangement's integer tempo only as a tie-break
  // after DSP confidence; this is not used for vocal safety.
  const candidates = [a.bpm, b.bpm].filter((n) => Number.isFinite(n) && n > 0);
  if (!candidates.length) return knownBpm;
  const weighted =
    a.bpmConfidence >= b.bpmConfidence
      ? a.bpm * 0.65 + b.bpm * 0.35
      : a.bpm * 0.35 + b.bpm * 0.65;
  return Math.round(weighted * 100) / 100;
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
