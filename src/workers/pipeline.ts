// 合成-分析流水线（经典 worker 任务队列）：
// 主线程做 OfflineAudioContext 渲染（部分浏览器 Worker 无 OAC），Worker 池做纯 DSP 分析。
// 固定 worker 数量，每个 worker 一个就绪 Promise，串行领任务，避免突发创建与协程竞态。
import { synthesize } from '../audio/synth';
import type { PCM } from '../audio/dsp';
import type { AnalysisGroundTruth, AnalysisResult, StyleId, TrackKind } from '../shared/types';
import type { AnalysisJobMsg, JobResult, WorkerResponse } from '../workers/protocol';
import AnalysisWorker from '../workers/analysis.worker.ts?worker';

export interface PipelineSpec {
  id: string;
  seed: number;
  style: StyleId;
  kind: TrackKind;
  durationSec: number;
  sampleRate: number;
  returnPcm: boolean;
}

export interface PipelineOutcome {
  id: string;
  pcm?: PCM;
  result: AnalysisResult;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
}

export interface PipelineHooks {
  onDone: (o: PipelineOutcome) => void;
  onError: (id: string, message: string) => void;
}

// 合成-分析流水线（能力自适应双路径）：
// 标准环境：Worker 支持 OfflineAudioContext，合成+分析全部在 Worker 池并行（全速，万条可达标）。
// 受限环境：Worker 无 OAC（如部分自动化浏览器），回退到主线程合成 + Worker 纯 DSP 分析。

export interface PipelineSpec {
  id: string;
  seed: number;
  style: StyleId;
  kind: TrackKind;
  durationSec: number;
  sampleRate: number;
  returnPcm: boolean;
}

export interface PipelineOutcome {
  id: string;
  pcm?: PCM;
  result: AnalysisResult;
  groundTruth: AnalysisGroundTruth;
  durationSec: number;
}

export interface PipelineHooks {
  onDone: (o: PipelineOutcome) => void;
  onError: (id: string, message: string) => void;
}

/** 探测一个新 Worker 是否支持离线音频合成 */
function probeWorker(worker: Worker): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch { /* noop */ }
      resolve(false);
    }, 4000);
    worker.onmessage = (ev: MessageEvent) => {
      clearTimeout(timer);
      resolve(ev.data?.kind === 'capability' ? !!ev.data.hasOfflineAudio : false);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    worker.postMessage({ kind: 'capability' });
  });
}

class WorkerQueue {
  private worker: Worker | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private ensure(): Worker {
    if (!this.worker) this.worker = new AnalysisWorker();
    return this.worker;
  }

  /** 发送已渲染 PCM 的分析任务（回退路径） */
  submitAnalyze(jobs: AnalysisJobMsg[]): Promise<JobResult[]> {
    const task = this.chain.then(() => this.runAnalyze(jobs));
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  /** 发送合成规格，由 Worker 内部合成+分析（标准路径） */
  submitSynth(specs: PipelineSpec[]): Promise<JobResult[]> {
    const task = this.chain.then(() => this.runSynth(specs));
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  private settle(worker: Worker, resolve: (v: JobResult[]) => void, reject: (e: Error) => void) {
    const collected: JobResult[] = [];
    let settled = false;
    worker.onerror = (ev: ErrorEvent) => {
      if (settled) return;
      settled = true;
      reject(new Error('分析 Worker 错误: ' + (ev.message || '未知')));
    };
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.kind === 'progress') collected.push(msg.job);
      else if (msg.kind === 'error' && !settled) {
        settled = true;
        reject(new Error(msg.message));
      } else if (msg.kind === 'done' && !settled) {
        settled = true;
        resolve(collected);
      }
    };
  }

  private runAnalyze(jobs: AnalysisJobMsg[]): Promise<JobResult[]> {
    return new Promise((resolve, reject) => {
      const worker = this.ensure();
      const transfer: Transferable[] = [];
      for (const j of jobs) {
        if (j.returnPcm) for (const c of j.pcm.channelData) transfer.push(c.buffer);
      }
      this.settle(worker, resolve, reject);
      worker.postMessage(
        { kind: 'analyze', batchId: jobs.length, jobs, returnPcm: jobs.some((j) => j.returnPcm) },
        transfer,
      );
    });
  }

  private runSynth(specs: PipelineSpec[]): Promise<JobResult[]> {
    return new Promise((resolve, reject) => {
      const worker = this.ensure();
      this.settle(worker, resolve, reject);
      const jobs = specs.map((s) => ({
        id: s.id, seed: s.seed, style: s.style, kind: s.kind,
        durationSec: s.durationSec, sampleRate: s.sampleRate,
      }));
      worker.postMessage(
        { kind: 'batch', batchId: specs.length, jobs, returnPcm: specs.some((s) => s.returnPcm) },
      );
    });
  }

  terminate(): void {
    try { this.worker?.terminate(); } catch { /* noop */ }
  }
}

export async function runPipeline(
  specs: PipelineSpec[],
  workerCount: number,
  hooks: PipelineHooks,
): Promise<{ done: number; failed: number }> {
  const total = specs.length;
  if (total === 0) return { done: 0, failed: 0 };
  const n = Math.min(workerCount, total);
  const queues: WorkerQueue[] = [];
  for (let i = 0; i < n; i++) queues.push(new WorkerQueue());

  // 能力探测：首个 Worker 是否支持离线音频（标准 Chrome 支持，受限自动化环境可能不支持）
  const probe = new AnalysisWorker();
  const workerCanSynth = await probeWorker(probe);
  try { probe.terminate(); } catch { /* noop */ }

  let cursor = 0;
  let done = 0;
  let failed = 0;
  const BATCH = Math.max(1, Math.ceil(total / n));

  const absorb = (outcomes: JobResult[]): void => {
    for (const o of outcomes) {
      done++;
      hooks.onDone({
        id: o.id,
        pcm: o.pcm,
        result: o.result,
        groundTruth: o.groundTruth,
        durationSec: o.durationSec,
      });
    }
  };

  if (workerCanSynth) {
    // 标准路径：Worker 内部完成合成+分析，主线程只派发规格（全速并行）
    const runners = queues.map((queue) => (async () => {
      while (true) {
        const start = cursor;
        cursor += BATCH;
        if (start >= total) break;
        const group = specs.slice(start, start + BATCH);
        try {
          absorb(await queue.submitSynth(group));
        } catch (e) {
          failed += group.length;
          group.forEach((g) => hooks.onError(g.id, (e as Error).message));
        }
      }
    })());
    try { await Promise.all(runners); } finally { queues.forEach((q) => q.terminate()); }
    return { done, failed };
  }

  // 回退路径：主线程并行合成（OAC 支持有限并发），Worker 只做 DSP 分析
  const SYNTH_CONCURRENCY = 4;
  async function synthGroup(group: PipelineSpec[]): Promise<AnalysisJobMsg[]> {
    const settled = await Promise.allSettled(
      group.map((spec) =>
        synthesize({
          seed: spec.seed,
          style: spec.style,
          kind: spec.kind,
          durationSec: spec.durationSec,
          sampleRate: spec.sampleRate,
        }).then((s) => ({ spec, s })),
      ),
    );
    const jobs: AnalysisJobMsg[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        const { spec, s } = r.value;
        jobs.push({
          id: spec.id,
          pcm: s.pcm,
          groundTruth: s.groundTruth,
          durationSec: s.durationSec,
          returnPcm: spec.returnPcm,
        });
      } else {
        failed++;
        hooks.onError(group[i].id, (r.reason as Error).message);
      }
    }
    return jobs;
  }

  const runners = queues.map((queue) => (async () => {
    while (true) {
      const start = cursor;
      cursor += SYNTH_CONCURRENCY;
      if (start >= total) break;
      const group = specs.slice(start, start + SYNTH_CONCURRENCY);
      const jobs = await synthGroup(group);
      if (jobs.length === 0) continue;
      try {
        absorb(await queue.submitAnalyze(jobs));
      } catch (e) {
        failed += jobs.length;
        jobs.forEach((j) => hooks.onError(j.id, (e as Error).message));
      }
    }
  })());
  try { await Promise.all(runners); } finally { queues.forEach((q) => q.terminate()); }
  return { done, failed };
}
