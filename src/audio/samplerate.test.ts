// 验证 11025 合成采样率下的完整分析链路（重采样 + 帧特征 + 各检测器不报错且合理）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_RATE, resample, mixDown, computeFrames,
  detectVocalEntry, detectFadeStart, estimateBpm, type PCM,
} from './dsp.ts';

test('11025 采样率 PCM 可正常重采样到分析率并完成全链路', () => {
  const sr = 11025;
  const dur = 30;
  const n = dur * sr;
  // 带 2Hz 节拍 + 中频人声段（8s 后）的信号
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const beat = Math.sin(t * 2 * Math.PI * 2) > 0 ? 1 : 0.3;
    const vocal = t >= 8 ? Math.sin(t * 2 * Math.PI * 900) * 0.3 : 0;
    ch[i] = 0.2 * beat + vocal;
  }
  const pcm: PCM = { channelData: [ch], sampleRate: sr };
  const mono = mixDown(pcm);
  assert.equal(mono.length, n);
  const low = resample(mono, sr, ANALYSIS_RATE);
  // 时长保持
  assert.ok(Math.abs(low.length / ANALYSIS_RATE - dur) < 0.1);
  const frames = computeFrames(low, ANALYSIS_RATE);
  assert.ok(frames.length > 100);
  // 各检测器不抛错且返回有限值
  const vocal = detectVocalEntry(frames);
  const fade = detectFadeStart(frames, dur);
  const { bpm } = estimateBpm(frames);
  assert.ok(Number.isFinite(vocal) && vocal >= 0);
  assert.ok(Number.isFinite(fade) && fade >= 0);
  assert.ok(Number.isFinite(bpm) && bpm > 40 && bpm < 200);
});

test('采样率变化不影响节拍周期估计（同一节拍信号不同输入率）', () => {
  const beatSec = 0.5; // 120bpm
  const mk = (sr: number) => {
    const n = 16 * sr;
    const sig = new Float32Array(n);
    const period = Math.round(beatSec * sr);
    for (let p = 0; p * period < n; p++) {
      for (let k = 0; k < sr * 0.02 && p * period + k < n; k++) sig[p * period + k] = 0.8;
    }
    return sig;
  };
  const bpms: number[] = [];
  for (const sr of [11025, 22050]) {
    const low = resample(mk(sr), sr, ANALYSIS_RATE);
    const frames = computeFrames(low, ANALYSIS_RATE);
    bpms.push(estimateBpm(frames).bpm);
  }
  // 两种输入率得到的 BPM 都应接近 120，且彼此一致
  for (const b of bpms) assert.ok(Math.abs(b - 120) / 120 < 0.05, `bpm=${b}`);
  assert.ok(Math.abs(bpms[0] - bpms[1]) / 120 < 0.03);
});
