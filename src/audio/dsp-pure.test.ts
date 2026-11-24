// DSP 纯函数测试（不依赖 Web Audio）：用合成已知信号验证帧特征/检测逻辑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_RATE, computeFrames, resample, mixDown, estimateBpm,
  buildBeatGrid, detectVocalEntry, detectFadeStart, HOP_SEC,
  type PCM,
} from './dsp.ts';

/** 生成带精确节拍脉冲的信号：每 beatSec 一个短脉冲 */
function pulseTrack(durationSec: number, beatSec: number, sr = ANALYSIS_RATE): Float32Array {
  const n = Math.floor(durationSec * sr);
  const sig = new Float32Array(n);
  const period = Math.round(beatSec * sr);
  const pulseLen = Math.round(0.02 * sr);
  for (let p = 0; p * period < n; p++) {
    for (let k = 0; k < pulseLen && p * period + k < n; k++) {
      sig[p * period + k] = 0.8 * (1 - k / pulseLen);
    }
  }
  return sig;
}

test('重采样保持时长近似', () => {
  const sr = 22050;
  const sig = new Float32Array(sr * 2).fill(0.1);
  const out = resample(sig, sr, ANALYSIS_RATE);
  const expected = 2 * ANALYSIS_RATE;
  assert.ok(Math.abs(out.length - expected) < ANALYSIS_RATE * 0.02);
});

test('mixDown 双声道求平均', () => {
  const pcm: PCM = {
    channelData: [new Float32Array([0.4, 0.8]), new Float32Array([0.2, 0.0])],
    sampleRate: 8000,
  };
  const mono = mixDown(pcm);
  assert.ok(Math.abs(mono[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(mono[1] - 0.4) < 1e-6);
});

test('节拍跟踪：120BPM 脉冲信号 BPM 误差 <3%', () => {
  const beatSec = 60 / 120;
  const sig = pulseTrack(20, beatSec);
  const frames = computeFrames(sig, ANALYSIS_RATE);
  const { bpm } = estimateBpm(frames);
  assert.ok(Math.abs(bpm - 120) / 120 < 0.03, `bpm=${bpm}`);
});

test('节拍网格：相邻节拍间隔接近真实拍长', () => {
  const beatSec = 60 / 100;
  const sig = pulseTrack(16, beatSec);
  const frames = computeFrames(sig, ANALYSIS_RATE);
  const { periodFrames } = estimateBpm(frames);
  const beats = buildBeatGrid(frames, periodFrames);
  assert.ok(beats.length > 5);
  const gaps = [];
  for (let i = 1; i < Math.min(8, beats.length); i++) gaps.push(beats[i] - beats[i - 1]);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(Math.abs(meanGap - beatSec) < 0.05, `meanGap=${meanGap} beat=${beatSec}`);
});

test('人声检测：前半静音段 + 后半持续中频能量，应检出切换点', () => {
  const dur = 40;
  const frames = Math.floor(dur / HOP_SEC);
  // 构造帧级"信号"更直接：用一段静音后接稳定能量
  const fakeFrames = [];
  const entrySec = 5; // 位于曲首 30% 搜索窗内，与合成素材结构一致
  for (let i = 0; i < frames; i++) {
    const t = i * HOP_SEC;
    // 人声段稳定高共振峰能量
    const inVocal = t >= entrySec;
    fakeFrames.push({
      t,
      rms: inVocal ? 0.15 : 0.05,
      zcr: 0.1,
      flux: inVocal && Math.abs(t - entrySec) < HOP_SEC ? 5 : 0.5,
      voiced: inVocal ? 0.4 : 0.1,
      mid: inVocal ? 0.25 : 0.01,
      centroid: 1000,
      am: 0,
    });
  }
  const entry = detectVocalEntry(fakeFrames);
  // 滚动窗平滑会带来约一个窗长（0.6s）的检测延迟/提前，属预期
  assert.ok(entry >= entrySec - 0.6 && entry <= entrySec + 1.0, `entry=${entry}`);
});

test('淡出检测：平台后接线性衰减，应定位衰减起点', () => {
  const frames = [];
  const total = 400;
  const fadeAtFrame = 320;
  for (let i = 0; i < total; i++) {
    let rms = 0.2;
    if (i >= fadeAtFrame) {
      const k = (i - fadeAtFrame) / (total - fadeAtFrame);
      rms = 0.2 * (1 - k) + 0.001;
    }
    frames.push({ t: i * HOP_SEC, rms, zcr: 0.1, flux: 0.5, voiced: 0.2, mid: 0.1, centroid: 1000, am: 0 });
  }
  const durSec = total * HOP_SEC;
  const fade = detectFadeStart(frames, durSec);
  const expected = fadeAtFrame * HOP_SEC;
  assert.ok(Math.abs(fade - expected) < 0.8, `fade=${fade} expected=${expected}`);
});
