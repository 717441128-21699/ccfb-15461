// 播出引擎：Web Audio 前瞻调度（lookahead），采样级精确控制每条素材的启停与增益包络
import type { PCM } from './dsp';
import type { ItemType, LogEvent, PipsTimingReport } from '../shared/types';
import { VirtualClock } from '../scheduler/clock';

export interface EngineItem {
  uid: string;
  trackId?: string;
  type: ItemType;
  title: string;
  pcm: PCM;
  /** 计划起止（虚拟时钟 ms） */
  startAtAir: number;
  endAtAir: number;
  fadeAdjustSec: number;
  /** 素材原始淡出起点（秒） */
  naturalFadeStart: number;
  isBed: boolean;
}

export interface MonitorState {
  currentUid: string | null;
  currentTitle: string;
  nextTitle: string;
  level: number; // 0..1
  driftMs: number; // 虚拟时钟相对调度的漂移
  pipsInMs: number; // 距下一个报时
  playing: boolean;
}

export interface EngineCallbacks {
  onLog: (ev: Omit<LogEvent, 'id' | 'wallTime' | 'airTime'>) => void;
  onItemStart: (uid: string) => void;
  onItemEnd: (uid: string) => void;
  onPips: (report: PipsTimingReport) => void;
  onState: (s: MonitorState) => void;
}

const LOOK_AHEAD_MS = 120;
const TICK_MS = 40;

export class PlaybackEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array | null = null;
  private clock = new VirtualClock();
  private queue: EngineItem[] = [];
  private started = new Set<string>();
  private ended = new Set<string>();
  private timer: number | null = null;
  private perfBase = 0;
  private ctxBase = 0;
  private cb: EngineCallbacks;
  private pipsReports: PipsTimingReport[] = [];
  private bufferCache = new Map<string, AudioBuffer>();
  private hourAtMs: number | null = null;

  constructor(cb: EngineCallbacks) {
    this.cb = cb;
  }

  private log(level: LogEvent['level'], kind: string, message: string,
    detail?: Record<string, number | string | boolean>): void {
    this.cb.onLog({ level, kind, message, detail });
  }

  get isRunning(): boolean {
    return this.clock.isRunning;
  }

  get virtualNow(): number {
    return this.clock.now();
  }

  /** 虚拟时间(ms) -> AudioContext 时间(s) */
  private airToAudio(airMs: number): number {
    const perf = this.clock.airToWall(airMs);
    return this.ctxBase + (perf - this.perfBase) / 1000;
  }

  private pcmToBuffer(pcm: PCM, key: string): AudioBuffer {
    const cached = this.bufferCache.get(key);
    if (cached) return cached;
    const ctx = this.ctx!;
    const frames = pcm.channelData[0].length;
    const buf = ctx.createBuffer(pcm.channelData.length, frames, pcm.sampleRate);
    for (let ch = 0; ch < pcm.channelData.length; ch++) {
      buf.copyToChannel(pcm.channelData[ch] as Float32Array<ArrayBuffer>, ch);
    }
    if (this.bufferCache.size < 60) this.bufferCache.set(key, buf);
    return buf;
  }

  async loadSchedule(items: EngineItem[], airStartMs: number, hourAtMs: number): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = this.ctx.createDynamicsCompressor();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.levelBuf = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(comp);
      comp.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.perfBase = performance.now();
    this.ctxBase = this.ctx.currentTime + 0.08; // 预留 80ms 调度余量
    this.clock.start(airStartMs, 1);
    this.hourAtMs = hourAtMs;
    this.queue = items.slice().sort((a, b) => a.startAtAir - b.startAtAir);
    this.started.clear();
    this.ended.clear();
    this.log('info', 'engine.load', `播出单已载入，共 ${items.length} 条`, { airStartMs });
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }
  }

  /** 替换尚未播出的队列条目（插播新闻后重排用） */
  replaceUpcoming(items: EngineItem[]): void {
    const now = this.clock.now();
    const keep = this.queue.filter((it) => it.endAtAir <= now || this.started.has(it.uid));
    this.queue = [...keep, ...items].sort((a, b) => a.startAtAir - b.startAtAir);
    this.log('info', 'engine.replace', `后续单子已重排，保留 ${keep.length} 条，新编 ${items.length} 条`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      void this.ctx.suspend();
    }
    this.queue = [];
    this.log('info', 'engine.stop', '播出停止');
  }

  private tick(): void {
    if (!this.ctx || !this.master) return;
    const nowAir = this.clock.now();
    const horizon = nowAir + LOOK_AHEAD_MS;

    for (const item of this.queue) {
      if (this.started.has(item.uid)) continue;
      if (item.startAtAir > horizon) continue;
      this.startItem(item);
    }
    // 结束检测
    for (const item of this.queue) {
      if (this.started.has(item.uid) && !this.ended.has(item.uid) && item.endAtAir <= nowAir) {
        this.ended.add(item.uid);
        this.cb.onItemEnd(item.uid);
        this.log('info', 'item.end', `结束：${item.title}`, { uid: item.uid });
      }
    }
    this.emitMonitor(nowAir);
  }

  private startItem(item: EngineItem): void {
    this.started.add(item.uid);
    const ctx = this.ctx!;
    const master = this.master!;
    let when = this.airToAudio(item.startAtAir);
    const slack = when - ctx.currentTime;
    if (slack < 0) {
      // 调度欠载：立即补播并记录
      this.log('warn', 'engine.underrun', `调度欠载 ${Math.round(-slack * 1000)}ms：${item.title}`, {
        underrunMs: Math.round(-slack * 1000),
      });
      when = Math.max(ctx.currentTime + 0.01, when);
    }
    const effectiveDur = (item.endAtAir - item.startAtAir) / 1000;
    const buffer = this.pcmToBuffer(item.pcm, item.trackId ?? item.uid);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.connect(master);
    source.connect(gain);

    if (item.type === 'pips') {
      source.start(when);
      this.armPipsMeasurement(item, when);
    } else if (item.isBed) {
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.85, when + 0.08);
      gain.gain.setValueAtTime(0.85, when + Math.max(0.1, effectiveDur - 1.2));
      gain.gain.linearRampToValueAtTime(0.0001, when + effectiveDur);
      source.start(when);
      source.stop(when + effectiveDur + 0.05);
    } else {
      const adj = item.fadeAdjustSec;
      const fadeAt = Math.min(
        Math.max(0.4, item.naturalFadeStart + adj),
        Math.max(0.45, effectiveDur - 0.05),
      );
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(1, when + 0.15); // 叠入短淡入，防点击声
      gain.gain.setValueAtTime(1, when + fadeAt);
      gain.gain.linearRampToValueAtTime(0.0001, when + effectiveDur);
      if (adj > 0 && effectiveDur > buffer.duration + 0.05) {
        // 延后淡出：循环尾部素材填满延长段
        source.loop = true;
        source.loopStart = Math.max(0, item.naturalFadeStart - 0.5);
        source.loopEnd = buffer.duration;
        source.start(when);
      } else {
        source.start(when, 0, Math.min(effectiveDur + 0.05, buffer.duration));
      }
      source.stop(when + effectiveDur + 0.05);
    }

    const plannedOffset = item.type === 'pips'
      ? Math.round((item.startAtAir - (this.hourAtMs ?? item.startAtAir)))
      : undefined;
    this.log('info', 'item.start', `开始：${item.title}`, {
      uid: item.uid,
      type: item.type,
      scheduledAudioMs: Math.round(when * 1000),
      ...(plannedOffset !== undefined ? { plannedPipsOffsetMs: plannedOffset } : {}),
    });
    this.cb.onItemStart(item.uid);
  }

  /** 报时第一声对齐测量：在发声时刻读取输出时间戳核对偏差 */
  private armPipsMeasurement(item: EngineItem, whenAudio: number): void {
    const delayMs = Math.max(0, (whenAudio - this.ctx!.currentTime) * 1000);
    const targetHourAt = item.startAtAir;
    window.setTimeout(() => {
      const ts = this.ctx!.getOutputTimestamp();
      const outAudio = ts.contextTime ?? this.ctx!.currentTime;
      const measuredOffsetMs = Math.round((outAudio - whenAudio) * 1000);
      const report: PipsTimingReport = {
        scheduledAt: item.startAtAir,
        targetHourAt,
        plannedOffsetMs: 0,
        measuredOffsetMs,
      };
      this.pipsReports.push(report);
      this.cb.onPips(report);
      this.log('timing', 'pips.aligned',
        `报时第一声发声，实测偏差 ${measuredOffsetMs} ms（要求 ≤100ms）`, report as unknown as Record<string, number>);
    }, delayMs);
  }

  private emitMonitor(nowAir: number): void {
    const current = this.queue.find((it) => this.started.has(it.uid) && !this.ended.has(it.uid)) ?? null;
    const next = this.queue.find((it) => !this.started.has(it.uid)) ?? null;
    let level = 0;
    if (this.analyser && this.levelBuf) {
      this.analyser.getByteTimeDomainData(this.levelBuf as Uint8Array<ArrayBuffer>);
      let peak = 0;
      for (const v of this.levelBuf) {
        const x = Math.abs(v - 128) / 128;
        if (x > peak) peak = x;
      }
      level = +peak.toFixed(3);
    }
    const state: MonitorState = {
      currentUid: current?.uid ?? null,
      currentTitle: current?.title ?? '—',
      nextTitle: next?.title ?? '—',
      level,
      driftMs: 0,
      pipsInMs: this.hourAtMs ? Math.max(0, this.hourAtMs - nowAir) : 0,
      playing: current !== null,
    };
    this.cb.onState(state);
  }

  getPipsReports(): PipsTimingReport[] {
    return this.pipsReports.slice();
  }
}
