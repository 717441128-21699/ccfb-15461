import { analyzeSpecFast } from './analyzer';
import type { TrackAnalysis, TrackSpec } from './types';

export interface AnalysisProgress {
  done: number;
  total: number;
  elapsedMs: number;
  tracksPerSecond: number;
  workerCount: number;
}

export async function analyzeLibrary(
  specs: TrackSpec[],
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<Map<string, TrackAnalysis>> {
  if (typeof Worker !== 'undefined') {
    try {
      return await analyzeWithWorkerPool(specs, onProgress);
    } catch (error) {
      console.warn('Worker pool unavailable, falling back to incremental main-thread analysis', error);
    }
  }
  return analyzeOnMainThread(specs, onProgress);
}

async function analyzeOnMainThread(
  specs: TrackSpec[],
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<Map<string, TrackAnalysis>> {
  const result = new Map<string, TrackAnalysis>();
  const started = performance.now();
  for (let i = 0; i < specs.length; i++) {
    result.set(specs[i].id, analyzeSpecFast(specs[i]));
    if (i % 25 === 0 || i === specs.length - 1) {
      const elapsedMs = performance.now() - started;
      onProgress?.({ done: i + 1, total: specs.length, elapsedMs, tracksPerSecond: ((i + 1) / elapsedMs) * 1000, workerCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return result;
}

function analyzeWithWorkerPool(
  specs: TrackSpec[],
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<Map<string, TrackAnalysis>> {
  return new Promise((resolve, reject) => {
    const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency ? navigator.hardwareConcurrency - 1 : 4, 8));
    const workers: Worker[] = [];
    const result = new Map<string, TrackAnalysis>();
    const started = performance.now();
    let nextIndex = 0;
    let done = 0;
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };

    const report = () => {
      const elapsedMs = performance.now() - started;
      onProgress?.({
        done,
        total: specs.length,
        elapsedMs,
        tracksPerSecond: elapsedMs > 0 ? (done / elapsedMs) * 1000 : 0,
        workerCount,
      });
    };

    for (let w = 0; w < workerCount; w++) {
      const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);

      const sendNext = () => {
        if (settled) return;
        if (nextIndex >= specs.length) {
          if (done === specs.length) finish();
          return;
        }
        const index = nextIndex++;
        const spec = specs[index];
        worker.postMessage({ jobId: index, spec });
      };

      worker.onmessage = (event: MessageEvent<{ jobId: number; analysis?: TrackAnalysis; error?: string }>) => {
        if (event.data.analysis) result.set(specs[event.data.jobId].id, event.data.analysis);
        done++;
        if (done % 100 === 0 || done === specs.length) report();
        if (event.data.error) {
          finish(new Error(event.data.error));
          return;
        }
        sendNext();
      };
      worker.onerror = (event) => finish(new Error(event.message));
      sendNext();
    }
    report();
  });
}
