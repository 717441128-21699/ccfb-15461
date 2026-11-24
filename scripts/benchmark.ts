import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createLibrarySpecs } from '../src/core/catalog';
import type { TrackAnalysis, TrackSpec } from '../src/core/types';

const requestedSongs = Number(process.argv[2] ?? 10000);
const all = createLibrarySpecs(requestedSongs);
const specs = requestedSongs === 10000
  ? all
  : [...all.filter((s) => s.kind !== 'song'), ...all.filter((s) => s.kind === 'song').slice(0, requestedSongs)];

const workerCount = Math.max(1, Math.min(8, availableParallelism() - 1, specs.length));
const chunkCount = workerCount * 3;
const chunkSize = Math.ceil(specs.length / chunkCount);
const chunks: TrackSpec[][] = [];
for (let i = 0; i < specs.length; i += chunkSize) chunks.push(specs.slice(i, i + chunkSize));

const started = performance.now();
let completedChunks = 0;
const analyses: TrackAnalysis[] = [];

await Promise.all(chunks.map((chunk, chunkId) => new Promise<void>((resolve, reject) => {
  const worker = new Worker(new URL('./benchmark-worker.ts', import.meta.url));
  worker.on('message', (message: { chunkId: number; analyses: TrackAnalysis[] }) => {
    analyses.push(...message.analyses);
    completedChunks++;
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`chunk ${completedChunks}/${chunks.length} · ${message.analyses.length} tracks · ${elapsed}s`);
    worker.terminate();
    resolve();
  });
  worker.on('error', reject);
  worker.postMessage({ chunkId, specs: chunk });
})));

const elapsedMs = performance.now() - started;
const analysisById = new Map(analyses.map((a) => [a.trackId, a]));
const songTracks = specs.filter((s) => s.kind === 'song');
const vocalInErrors = songTracks.map((s) => (analysisById.get(s.id)?.vocalInSec ?? NaN) - (s.vocalInSec ?? NaN)).filter(Number.isFinite);
const vocalOutErrors = songTracks.map((s) => (analysisById.get(s.id)?.vocalEndSec ?? NaN) - (s.vocalEndSec ?? NaN)).filter(Number.isFinite);
const bpmErrors = songTracks.map((s) => Math.abs(analysisById.get(s.id)!.bpm - s.bpm));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const summary = {
  tracks: specs.length,
  workerCount,
  elapsedSec: +(elapsedMs / 1000).toFixed(2),
  budgetSec: 600,
  passed: elapsedMs < 600_000,
  throughputPerSec: +(specs.length / (elapsedMs / 1000)).toFixed(1),
  vocalInLateP95: +percentile(vocalInErrors.filter((e) => e > 0), 0.95).toFixed(3),
  vocalInAbsP95: +percentile(vocalInErrors.map(Math.abs), 0.95).toFixed(3),
  vocalOutEarlyP95: +percentile(vocalOutErrors.filter((e) => e < 0).map(Math.abs), 0.95).toFixed(3),
  safeBoundaryViolations: songTracks.filter((s) => {
    const a = analysisById.get(s.id)!;
    // Safe incoming bound must not be later than truth; safe outgoing must not be earlier.
    return a.safeVocalInSec > (s.vocalInSec ?? Infinity) + 0.001 || a.safeVocalOutSec < (s.vocalEndSec ?? -Infinity) - 0.001;
  }).length,
  bpmErrorP95: +percentile(bpmErrors, 0.95).toFixed(2),
};
console.log(summary);
if (!summary.passed || summary.safeBoundaryViolations > 0) process.exitCode = 1;
