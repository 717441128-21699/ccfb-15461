// 分析 Worker：能力自适应
// - 标准环境（Worker 支持 OfflineAudioContext）：接收合成规格，Worker 内完成合成 + DSP 分析
// - 受限环境（Worker 无 OAC，如部分自动化浏览器）：接收已渲染 PCM，只做 DSP 分析
import { analyzePCM } from '../audio/analyzer.ts';
import { synthesize, SYNTH_RATE } from '../audio/synth.ts';
import type { PCM } from '../audio/dsp.ts';
import type { AnalysisGroundTruth, AnalysisResult, StyleId, TrackKind } from '../shared/types';

interface SynthSpecMsg {
  id: string;
  seed: number;
  style: StyleId;
  kind: TrackKind;
  durationSec: number;
  sampleRate: number;
}
interface PcmJobMsg {
  id: string;
  pcm: PCM;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
  returnPcm: boolean;
}
type Request =
  | { kind: 'capability' }
  | { kind: 'batch'; batchId: number; jobs: SynthSpecMsg[]; returnPcm: boolean }
  | { kind: 'analyze'; batchId: number; jobs: PcmJobMsg[]; returnPcm: boolean };

interface JobOut {
  id: string;
  result: AnalysisResult;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
  pcm?: PCM;
}
type Response =
  | { kind: 'capability'; hasOfflineAudio: boolean }
  | { kind: 'progress'; batchId: number; job: JobOut }
  | { kind: 'done'; batchId: number; ms: number }
  | { kind: 'error'; batchId?: number; message: string };

const post = (msg: Response): void => (self as unknown as Worker).postMessage(msg);

function hasOAC(): boolean {
  const g = globalThis as unknown as { OfflineAudioContext?: unknown; webkitOfflineAudioContext?: unknown };
  return !!(g.OfflineAudioContext || g.webkitOfflineAudioContext);
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data;
  if (req.kind === 'capability') {
    post({ kind: 'capability', hasOfflineAudio: hasOAC() });
    return;
  }
  if (req.kind !== 'batch' && req.kind !== 'analyze') return;
  const t0 = performance.now();
  try {
    for (const job of req.jobs) {
      let pcm: PCM;
      let groundTruth: AnalysisGroundTruth;
      let durationSec: number;

      if (req.kind === 'batch') {
        // 标准路径：Worker 内合成
        const spec = job as SynthSpecMsg;
        const synth = await synthesize({
          seed: spec.seed,
          style: spec.style,
          kind: spec.kind,
          durationSec: spec.durationSec,
          sampleRate: spec.sampleRate || SYNTH_RATE,
        });
        pcm = synth.pcm;
        groundTruth = synth.groundTruth;
        durationSec = synth.durationSec;
      } else {
        // 回退路径：PCM 已在主线程渲染
        const pj = job as PcmJobMsg;
        pcm = pj.pcm;
        groundTruth = pj.groundTruth;
        durationSec = pj.durationSec;
      }

      const result = analyzePCM(pcm, groundTruth);
      const out: JobOut = { id: job.id, result, groundTruth, durationSec };
      if (req.returnPcm) out.pcm = pcm;

      if (req.returnPcm && out.pcm) {
        const transfer = pcm.channelData.map((c) => c.buffer);
        (self as unknown as Worker).postMessage(
          { kind: 'progress', batchId: req.batchId, job: out } as Response,
          transfer as Transferable[],
        );
      } else {
        post({ kind: 'progress', batchId: req.batchId, job: out });
      }
    }
    post({ kind: 'done', batchId: req.batchId, ms: performance.now() - t0 });
  } catch (err) {
    post({ kind: 'error', batchId: req.batchId, message: (err as Error).message });
  }
};
