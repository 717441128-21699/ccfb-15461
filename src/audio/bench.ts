// 分析吞吐基准：测量 analyzePCM 纯 DSP 耗时（不依赖 Web Audio，可在 Node/CI 跑）
import { performance } from 'node:perf_hooks';
import {
  computeFrames, mixDown, resample, ANALYSIS_RATE, estimateBpm,
  buildBeatGrid, detectVocalEntry, detectFadeStart, meanLoudness, type PCM,
} from './dsp.ts';

// 确定性伪 PCM，模拟一首短素材（压测素材 28-70s）
function fakePCM(durationSec: number, sr = 11025): PCM {
  const n = durationSec * sr;
  const ch = new Float32Array(n);
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const beat = Math.sin((i / sr) * 2 * Math.PI * 2);
    ch[i] = beat * 0.4 + rnd() * 0.3;
  }
  return { channelData: [ch], sampleRate: sr };
}

function analyzeOnly(pcm: PCM): void {
  const mono = mixDown(pcm);
  const low = resample(mono, pcm.sampleRate, ANALYSIS_RATE);
  const frames = computeFrames(low, ANALYSIS_RATE);
  const { periodFrames } = estimateBpm(frames);
  buildBeatGrid(frames, periodFrames);
  detectVocalEntry(frames);
  detectFadeStart(frames, mono.length / pcm.sampleRate);
  meanLoudness(frames);
}

const N = 200;
const pcm = fakePCM(50);
analyzeOnly(pcm); // 预热
const t0 = performance.now();
for (let i = 0; i < N; i++) analyzeOnly(pcm);
const perTrack = (performance.now() - t0) / N;
console.log(`纯 DSP 单条分析平均 ${perTrack.toFixed(2)} ms（${N} 条）`);
for (const cores of [4, 8]) {
  console.log(`${cores} Worker 并行，1 万条纯分析理想耗时 ${(perTrack * 10000 / cores / 1000).toFixed(0)} 秒（${(perTrack * 10000 / cores / 60000).toFixed(1)} 分钟）`);
}
