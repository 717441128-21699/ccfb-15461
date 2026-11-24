// 分析 Worker 通信协议（能力自适应双路径）
import type { PCM } from '../audio/dsp';
import type { AnalysisGroundTruth, AnalysisResult, StyleId, TrackKind } from '../shared/types';

/** 主线程合成用的素材规格（标准路径直接发给 Worker 合成） */
export interface SynthJob {
  id: string;
  seed: number;
  style: StyleId;
  kind: TrackKind;
  durationSec: number;
  sampleRate: number;
}

/** 回退路径：已在主线程渲染好 PCM 的分析任务 */
export interface AnalysisJobMsg {
  id: string;
  pcm: PCM;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
  returnPcm: boolean;
}

export type WorkerRequest =
  | { kind: 'capability' }
  | { kind: 'batch'; batchId: number; jobs: SynthJob[]; returnPcm: boolean }
  | { kind: 'analyze'; batchId: number; jobs: AnalysisJobMsg[]; returnPcm: boolean };

export interface JobResult {
  id: string;
  result: AnalysisResult;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
  pcm?: PCM;
}

export type WorkerResponse =
  | { kind: 'capability'; hasOfflineAudio: boolean }
  | { kind: 'progress'; batchId: number; job: JobResult }
  | { kind: 'done'; batchId: number; ms: number }
  | { kind: 'error'; batchId?: number; message: string };
