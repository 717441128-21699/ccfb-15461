// 素材合成器：用 OfflineAudioContext 合成五种风格的歌曲及广告/垫乐/新闻/报时
// 所有素材带确定性结构（前奏-人声-淡出、节拍网格），并输出 ground truth 供分析核验
import type { AnalysisGroundTruth, StyleId, TrackKind } from '../shared/types';
import type { PCM } from './dsp';

// 合成采样率：分析仅需 4kHz 带宽，播放由 Web Audio 自动重采样。
// 取 11025 可在保证音质的同时把 PCM 内存压到 22050 的一半，避免长素材离线渲染 OOM。
export const SYNTH_RATE = 11025;

/**
 * 跨环境 OfflineAudioContext 工厂：
 * 部分浏览器在 Worker 全局作用域不暴露裸 OfflineAudioContext 标识符，
 * 需通过 self/globalThis/window 逐层回退获取。
 */
function createOfflineContext(channels: number, length: number, sampleRate: number): OfflineAudioContext {
  const g = globalThis as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('当前环境不支持 OfflineAudioContext（Worker 与主线程均不可用）');
  return new Ctor(channels, length, sampleRate);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface StyleCfg {
  bpm: [number, number];
  roots: number[]; // 和弦进行根音 midi
  scale: number[]; // 音阶半音间隔
  leadWave: OscillatorType;
  bassWave: OscillatorType;
  drum: 'full' | 'soft' | 'electronic' | 'none';
  leadCutoff: number;
}

const STYLES: Record<StyleId, StyleCfg> = {
  pop: {
    bpm: [92, 118], roots: [57, 53, 48, 55], scale: [0, 2, 3, 5, 7, 10],
    leadWave: 'sawtooth', bassWave: 'triangle', drum: 'full', leadCutoff: 1600,
  },
  rock: {
    bpm: [104, 132], roots: [52, 57, 55, 60], scale: [0, 2, 3, 5, 7, 10],
    leadWave: 'square', bassWave: 'sawtooth', drum: 'full', leadCutoff: 2200,
  },
  folk: {
    bpm: [76, 100], roots: [55, 52, 57, 60], scale: [0, 2, 4, 7, 9],
    leadWave: 'triangle', bassWave: 'triangle', drum: 'soft', leadCutoff: 1400,
  },
  electronic: {
    bpm: [118, 140], roots: [50, 57, 53, 55], scale: [0, 2, 3, 5, 7, 10],
    leadWave: 'square', bassWave: 'sawtooth', drum: 'electronic', leadCutoff: 2600,
  },
  classical: {
    bpm: [72, 96], roots: [57, 60, 55, 53], scale: [0, 2, 4, 5, 7, 9, 11],
    leadWave: 'triangle', bassWave: 'triangle', drum: 'none', leadCutoff: 2000,
  },
};

function makeNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

interface Ctx {
  ctx: OfflineAudioContext;
  master: GainNode;
  noise: AudioBuffer;
  rng: () => number;
}

function kick(c: Ctx, t: number, vel: number): void {
  const { ctx, master } = c;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(0.9 * vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + 0.25);
}

function snare(c: Ctx, t: number, vel: number): void {
  const { ctx, master, noise } = c;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.5 * vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.2);
  const o = ctx.createOscillator();
  const og = ctx.createGain();
  o.type = 'triangle';
  o.frequency.value = 190;
  og.gain.setValueAtTime(0.35 * vel, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  o.connect(og).connect(master);
  o.start(t);
  o.stop(t + 0.15);
}

function hat(c: Ctx, t: number, vel: number, open = false): void {
  const { ctx, master, noise } = c;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7500;
  const g = ctx.createGain();
  const dur = open ? 0.14 : 0.045;
  g.gain.setValueAtTime(0.22 * vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(hp).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function tone(
  c: Ctx, t: number, dur: number, freq: number, wave: OscillatorType,
  peak: number, cutoff: number, attack: number, pan = 0,
): { end: GainNode } {
  const { ctx, master } = c;
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.value = freq;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + Math.max(attack, dur - 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  o.connect(f).connect(g).connect(p).connect(master);
  o.start(t);
  o.stop(t + dur + 0.03);
  return { end: g };
}

/** 主唱/主音（人声替身）：锯齿波 + 颤音 + 共振峰滤波，可选音节幅度调制 */
function leadVocal(c: Ctx, t: number, dur: number, freq: number, speech: boolean, accent = 1): void {
  const { ctx, master } = c;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = freq;
  const lfo = ctx.createOscillator();
  const lfoG = ctx.createGain();
  lfo.frequency.value = 5.5;
  lfoG.gain.value = freq * 0.012;
  lfo.connect(lfoG).connect(o.frequency);
  const formant = ctx.createBiquadFilter();
  formant.type = 'bandpass';
  formant.frequency.value = 1100;
  formant.Q.value = 1.1;
  const g = ctx.createGain();
  const peak = 0.32 * accent;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.06);
  g.gain.setValueAtTime(peak, t + Math.max(0.08, dur - 0.08));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (speech) {
    // 4.5-6.5Hz 幅度调制模拟吐字音节
    const am = ctx.createOscillator();
    const amG = ctx.createGain();
    am.frequency.value = 4.5 + c.rng() * 2;
    amG.gain.value = 0.18;
    am.connect(amG).connect(g.gain);
    am.start(t);
    am.stop(t + dur);
  }
  const p = ctx.createStereoPanner();
  p.pan.value = (c.rng() - 0.5) * 0.3;
  o.connect(formant).connect(g).connect(p).connect(master);
  o.start(t);
  lfo.start(t);
  o.stop(t + dur + 0.05);
  lfo.stop(t + dur + 0.05);
}

function drumPattern(c: Ctx, style: StyleCfg, barStart: number, beat: number, rng: () => number): void {
  const step = beat / 4;
  for (let s = 0; s < 16; s++) {
    const t = barStart + s * step;
    const v = 0.85 + rng() * 0.15;
    switch (style.drum) {
      case 'full':
        if (s % 4 === 0) kick(c, t, v);
        if (s === 4 || s === 12) snare(c, t, v);
        if (s % 2 === 0) hat(c, t, 0.8, s === 14);
        break;
      case 'electronic':
        if (s % 4 === 0) kick(c, t, v);
        if (s === 4 || s === 12) snare(c, t, v);
        hat(c, t, 0.7, false);
        break;
      case 'soft':
        if (s === 0 || s === 8) kick(c, t, 0.55);
        if (s === 4 || s === 12) snare(c, t, 0.4);
        if (s === 0 || s === 8) hat(c, t, 0.4);
        break;
      case 'none':
        if (s % 4 === 0) tone(c, t, 0.32, midi(72), 'triangle', 0.16, 3000, 0.01);
        break;
    }
  }
}

export interface SynthResult {
  pcm: PCM;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
}

export interface SynthOptions {
  seed: number;
  style: StyleId;
  kind: TrackKind;
  durationSec: number;
  sampleRate?: number;
}

/** 合成一首完整素材 */
export async function synthesize(opts: SynthOptions): Promise<SynthResult> {
  const sampleRate = opts.sampleRate ?? SYNTH_RATE;
  const cfg = STYLES[opts.style];
  const rng = mulberry32(opts.seed);
  const bpm = cfg.bpm[0] + rng() * (cfg.bpm[1] - cfg.bpm[0]);
  const beat = 60 / bpm;
  const bar = beat * 4;

  const introBars = opts.kind === 'ad' || opts.kind === 'news' ? 0 : 2 + Math.floor(rng() * 3);
  const outroBars = opts.kind === 'song' ? 2 : 1;
  const totalBars = Math.max(introBars + outroBars + 2, Math.round(opts.durationSec / bar));
  const duration = totalBars * bar;
  const vocalEntry = introBars * bar;
  const fadeStart = (totalBars - outroBars) * bar;

  const ctx = createOfflineContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  const c: Ctx = { ctx, master, noise: makeNoise(ctx, 1), rng };

  const speech = opts.kind === 'ad' || opts.kind === 'news';
  const beats: number[] = [];
  for (let b = 0; b <= totalBars * 4; b++) beats.push(+(b * beat).toFixed(4));

  for (let barIdx = 0; barIdx < totalBars; barIdx++) {
    const t0 = barIdx * bar;
    const root = cfg.roots[barIdx % cfg.roots.length];
    // 低音
    tone(c, t0, bar * 0.95, midi(root - 12), cfg.bassWave, 0.22, 420, 0.02);
    tone(c, t0 + 2 * beat, beat * 1.8, midi(root - 5), cfg.bassWave, 0.16, 380, 0.02);
    // 和声垫
    if (opts.kind !== 'ad') {
      for (const iv of [0, 7, 12]) {
        tone(c, t0, bar * 0.98, midi(root + iv), 'sawtooth', 0.05, 750, 0.35, (rng() - 0.5) * 0.5);
      }
    }
    // 鼓 / 拨弦
    drumPattern(c, cfg, t0, beat, rng);
    // 主唱（前奏结束后进，淡出段开始时停）
    const leadStart = Math.max(t0, vocalEntry);
    const leadEnd = Math.min(t0 + bar, fadeStart);
    if (leadEnd - leadStart > 0.1) {
      const notes = opts.kind === 'bed' ? 0 : 8;
      // 起唱重音：人声进入的第一个音符必定发声、力度更强、时值更长，
      // 模拟真实歌曲句首起唱，使结构边界可被 DSP 稳定检出
      if (opts.kind === 'song' && t0 <= vocalEntry && t0 + bar > vocalEntry) {
        const deg0 = cfg.scale[0];
        leadVocal(c, vocalEntry, beat * 0.9, midi(root + 12 + deg0), speech, 1.35);
      }
      for (let n = 0; n < notes; n++) {
        const nt = leadStart + n * (beat / 2);
        if (nt >= leadEnd) break;
        if (Math.abs(nt - vocalEntry) < beat * 0.25) continue; // 让位给起唱重音
        if (rng() < 0.18) continue; // 留白
        const deg = cfg.scale[Math.floor(rng() * cfg.scale.length)];
        const oct = rng() < 0.75 ? 12 : 24;
        leadVocal(c, nt, beat * 0.45, midi(root + oct + deg), speech);
      }
    }
  }

  // 淡出：歌曲/垫乐尾部线性淡出；广告/新闻只收 0.4s
  const fadeLen = opts.kind === 'song' ? duration - fadeStart : 0.4;
  const fadeFrom = duration - fadeLen;
  master.gain.setValueAtTime(1, Math.max(0, fadeFrom - 0.02));
  master.gain.linearRampToValueAtTime(0.0001, duration);
  // 垫乐两端做短淡入，循环拼接不爆音
  if (opts.kind === 'bed') {
    master.gain.setValueAtTime(0.0001, 0);
    master.gain.linearRampToValueAtTime(1, 0.08);
    master.gain.setValueAtTime(1, Math.max(0.09, fadeFrom - 0.02));
    master.gain.linearRampToValueAtTime(0.0001, duration);
  }

  const rendered = await ctx.startRendering();
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channelData.push(rendered.getChannelData(ch).slice());
  }
  const groundTruth: AnalysisGroundTruth = {
    vocalEntry: +vocalEntry.toFixed(3),
    fadeStart: +fadeFrom.toFixed(3),
    beats,
    bpm: +bpm.toFixed(2),
  };
  return { pcm: { channelData, sampleRate }, groundTruth, durationSec: duration };
}

/** 整点报时信号：第一声即整点标记（t=0），后随两声确认音 */
export async function synthesizePipsAsync(sampleRate = SYNTH_RATE): Promise<PCM> {
  const duration = 3.2;
  const ctx = createOfflineContext(1, Math.ceil(duration * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const beep = (t: number, freq: number, len: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.008);
    g.gain.setValueAtTime(0.9, t + len - 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.02);
  };
  beep(0, 1200, 0.8);
  beep(1.0, 1000, 0.12);
  beep(2.0, 1000, 0.12);
  const rendered = await ctx.startRendering();
  return {
    channelData: [rendered.getChannelData(0).slice()],
    sampleRate,
  };
}
