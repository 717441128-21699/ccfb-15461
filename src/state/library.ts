// 曲库服务：主线程合成 + Worker 池 DSP 分析、曲库状态、订阅式通知
import { analyzePCM } from '../audio/analyzer';
import { synthesize, synthesizePipsAsync, SYNTH_RATE } from '../audio/synth';
import type { PCM } from '../audio/dsp';
import type {
  AnalysisProgress,
  AnalysisResult,
  StyleId,
  Track,
  TrackKind,
} from '../shared/types';
import { runPipeline } from '../workers/pipeline';
import { cachePCM, clearTracks, getPCM, loadTracks, saveTracks } from './storage';

export const STYLES: StyleId[] = ['pop', 'rock', 'folk', 'electronic', 'classical'];
const STYLE_NAME: Record<StyleId, string> = {
  pop: '流行', rock: '摇滚', folk: '民谣', electronic: '电子', classical: '室内乐',
};
const KIND_NAME: Record<TrackKind, string> = {
  song: '歌曲', ad: '广告', bed: '垫乐', news: '新闻', pips: '报时',
};

export interface GenOptions {
  songs: number;
  ads: number;
  beds: number;
  news: number;
  /** 压测模式：曲目短、PCM 不回传不缓存 */
  bulk: boolean;
  /** 压测目标总数（用于进度文案），0 表示按上面四类计数 */
  totalTarget?: number;
}

type Listener = () => void;

export class LibraryService {
  tracks: Track[] = [];
  progress: AnalysisProgress = { done: 0, total: 0, failed: 0, elapsedMs: 0, etaMs: 0, current: '' };
  busy = false;
  /** 最近一次批量分析的计时汇总（ms） */
  lastRunMs = 0;
  pipsPCM: PCM | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async init(): Promise<void> {
    this.tracks = await loadTracks();
    this.emit();
  }

  get byId(): Map<string, Track> {
    return new Map(this.tracks.map((t) => [t.id, t]));
  }

  list(kind?: TrackKind): Track[] {
    return kind ? this.tracks.filter((t) => t.kind === kind) : this.tracks;
  }

  static title(kind: TrackKind, style: StyleId, n: number): string {
    return `${KIND_NAME[kind]}《${STYLE_NAME[style]}片段 ${String(n).padStart(4, '0')}》`;
  }

  /** 单条同步合成（主线程，用于按需重合成播放） */
  async regeneratePCM(track: Track): Promise<PCM> {
    const cached = getPCM(track.id);
    if (cached) return cached;
    if (!track.synth) throw new Error('缺少合成参数');
    const { pcm } = await synthesize({
      seed: track.synth.seed,
      style: track.style,
      kind: track.kind,
      durationSec: track.synth.requestedDurationSec,
      sampleRate: track.synth.sampleRate,
    });
    return pcm;
  }

  async ensurePips(): Promise<PCM> {
    if (!this.pipsPCM) this.pipsPCM = await synthesizePipsAsync(SYNTH_RATE);
    return this.pipsPCM;
  }

  /** 生成并分析一整套素材（主线程合成 + Worker 池 DSP 分析） */
  async generate(opts: GenOptions): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const specs: { kind: TrackKind; style: StyleId; dur: number }[] = [];
    const push = (kind: TrackKind, n: number): void => {
      for (let i = 0; i < n; i++) {
        const style: StyleId = kind === 'bed'
          ? STYLES[i % STYLES.length]
          : STYLES[Math.floor(Math.random() * STYLES.length)];
        const dur = opts.bulk
          ? 28 + Math.random() * 42
          : kind === 'ad' ? 28 + Math.random() * 12
            : kind === 'bed' ? 22 + Math.random() * 10
              : kind === 'news' ? 42 + Math.random() * 18
                : 60 + Math.random() * 60;
        specs.push({ kind, style, dur });
      }
    };
    push('song', opts.songs);
    push('ad', opts.ads);
    push('bed', opts.beds);
    push('news', opts.news);

    const t0 = performance.now();
    const trackById = new Map<string, Track>();
    const pipelineSpecs = specs.map((s, i) => {
      const seed = (Date.now() & 0xffffff) ^ (i * 2654435761);
      const id = `t${seed.toString(36)}-${i}`;
      const track: Track = {
        id,
        title: LibraryService.title(s.kind, s.style, i + 1),
        artist: s.kind === 'song' ? `${STYLE_NAME[s.style]}虚拟乐队` : '台制作部',
        kind: s.kind,
        style: s.style,
        duration: 0,
        sampleRate: SYNTH_RATE,
        channels: 2,
        synth: { seed, sampleRate: SYNTH_RATE, requestedDurationSec: s.dur },
        createdAt: Date.now(),
      };
      trackById.set(id, track);
      return { id, seed, style: s.style, kind: s.kind, durationSec: s.dur, sampleRate: SYNTH_RATE, returnPcm: !opts.bulk };
    });

    const total = opts.totalTarget ?? pipelineSpecs.length;
    this.progress = { done: 0, total, failed: 0, elapsedMs: 0, etaMs: 0, current: '主线程合成 / Worker 分析…' };
    this.emit();

    // 标准环境 Worker 内含合成+分析，可用满核；受限环境回退主线程合成时 pipeline 内部自行限并发
    const workerCount = Math.min(navigator.hardwareConcurrency || 4, 8);
    const newTracks: Track[] = [];
    const persistQueue: Track[] = [];
    let failed = 0;

    const { done } = await runPipeline(pipelineSpecs, workerCount, {
      onDone: (o) => {
        const track = trackById.get(o.id);
        if (!track) return;
        track.duration = o.durationSec;
        track.groundTruth = o.groundTruth;
        track.analysis = o.result;
        track.analysisMs = 0;
        if (o.pcm) cachePCM(track.id, o.pcm);
        newTracks.push(track);
        persistQueue.push(track);
        if (persistQueue.length >= 50) {
          void saveTracks(persistQueue.splice(0, persistQueue.length));
        }
        const elapsed = performance.now() - t0;
        const doneCount = newTracks.length;
        this.progress = {
          done: doneCount,
          total,
          failed,
          elapsedMs: elapsed,
          etaMs: doneCount ? (elapsed / doneCount) * (total - doneCount) : 0,
          current: track.title,
        };
        this.emit();
      },
      onError: (id, message) => {
        failed++;
        console.error('素材处理失败:', id, message);
      },
    });
    void done;
    if (persistQueue.length) await saveTracks(persistQueue);
    this.tracks = [...this.tracks, ...newTracks];
    this.lastRunMs = performance.now() - t0;
    this.progress = {
      ...this.progress,
      done: newTracks.length,
      total,
      failed,
      elapsedMs: this.lastRunMs,
      etaMs: 0,
      current: '完成',
    };
    this.busy = false;
    this.emit();
  }

  /** 对已有曲库重新跑一遍分析（复用合成参数重合成后分析，走同一流水线） */
  async reanalyzeAll(): Promise<{ ms: number; count: number }> {
    if (this.busy || this.tracks.length === 0) return { ms: 0, count: 0 };
    this.busy = true;
    const t0 = performance.now();
    const source = this.tracks.filter((t) => t.synth && t.kind !== 'pips');
    const pipelineSpecs = source.map((t) => ({
      id: t.id,
      seed: t.synth!.seed,
      style: t.style,
      kind: t.kind,
      durationSec: t.synth!.requestedDurationSec,
      sampleRate: t.synth!.sampleRate,
      returnPcm: false,
    }));
    this.progress = { done: 0, total: pipelineSpecs.length, failed: 0, elapsedMs: 0, etaMs: 0, current: '重分析中…' };
    this.emit();
    const byId = this.byId;
    let done = 0;
    let failed = 0;
    const workerCount = Math.min(navigator.hardwareConcurrency || 4, 8);
    await runPipeline(pipelineSpecs, workerCount, {
      onDone: (o) => {
        const track = byId.get(o.id);
        if (track) {
          track.analysis = o.result;
          track.groundTruth = o.groundTruth;
          track.duration = o.durationSec;
        }
        done++;
        const elapsed = performance.now() - t0;
        this.progress = {
          done, total: pipelineSpecs.length, failed, elapsedMs: elapsed,
          etaMs: (elapsed / done) * (pipelineSpecs.length - done),
          current: track?.title ?? o.id,
        };
        this.emit();
      },
      onError: (id, message) => {
        failed++;
        console.error('重分析失败:', id, message);
      },
    });
    await saveTracks(this.tracks);
    const ms = performance.now() - t0;
    this.lastRunMs = ms;
    this.busy = false;
    this.emit();
    return { ms, count: done };
  }

  /** 主线程直接分析一段 PCM（用于外部导入等场景） */
  async analyzeInline(pcm: PCM, groundTruth?: Track['groundTruth']): Promise<AnalysisResult> {
    return analyzePCM(pcm, groundTruth);
  }

  async reset(): Promise<void> {
    this.tracks = [];
    await clearTracks();
    this.emit();
  }
}

export const library = new LibraryService();
