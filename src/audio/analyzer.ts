// 曲库分析入口：把 PCM 交给纯函数 DSP，产出 AnalysisResult 并核验 ground truth
import {
  ANALYSIS_RATE,
  buildBeatGrid,
  computeFrames,
  detectFadeStart,
  detectVocalEntry,
  estimateBpm,
  meanLoudness,
  mixDown,
  resample,
  type PCM,
} from './dsp.ts';
import type { AnalysisGroundTruth, AnalysisResult } from '../shared/types';

export function analyzePCM(pcm: PCM, groundTruth?: AnalysisGroundTruth): AnalysisResult {
  const mono = mixDown(pcm);
  const low = resample(mono, pcm.sampleRate, ANALYSIS_RATE);
  const frames = computeFrames(low, ANALYSIS_RATE);
  const { bpm, periodFrames } = estimateBpm(frames);
  const beats = buildBeatGrid(frames, periodFrames);
  const durationSec = mono.length / pcm.sampleRate;
  const vocalEntry = detectVocalEntry(frames);
  const fadeStart = detectFadeStart(frames, durationSec);
  const result: AnalysisResult = {
    vocalEntry,
    fadeStart,
    beats,
    bpm,
    introLength: vocalEntry,
    outroLength: Math.max(0, durationSec - fadeStart),
    loudness: meanLoudness(frames),
  };
  if (groundTruth) {
    result.errors = {
      vocalEntryErrMs: Math.round(Math.abs(vocalEntry - groundTruth.vocalEntry) * 1000),
      fadeStartErrMs: Math.round(Math.abs(fadeStart - groundTruth.fadeStart) * 1000),
      bpmErrPct: +((Math.abs(bpm - groundTruth.bpm) / groundTruth.bpm) * 100).toFixed(2),
    };
  }
  return result;
}
