import { analyzeSpecFast } from '../core/analyzer';
import type { TrackAnalysis, TrackSpec } from '../core/types';

interface WorkerRequest {
  jobId: number;
  spec: TrackSpec;
}

interface WorkerResponse {
  jobId: number;
  analysis?: TrackAnalysis;
  error?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { jobId, spec } = event.data;
  try {
    const analysis = analyzeSpecFast(spec);
    workerScope.postMessage({ jobId, analysis });
  } catch (error) {
    workerScope.postMessage({ jobId, error: error instanceof Error ? error.message : String(error) });
  }
};
