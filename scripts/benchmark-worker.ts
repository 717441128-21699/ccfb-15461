import { parentPort } from 'node:worker_threads';
import { analyzeSpecFast } from '../src/core/analyzer';
import type { TrackSpec } from '../src/core/types';

parentPort?.on('message', (message: { chunkId: number; specs: TrackSpec[] }) => {
  const analyses = message.specs.map((spec) => analyzeSpecFast(spec));
  parentPort?.postMessage({ chunkId: message.chunkId, analyses });
});
