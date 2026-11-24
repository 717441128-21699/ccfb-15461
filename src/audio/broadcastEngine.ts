import { StandardClock, epochToAudioTime } from '../core/clock';
import type { ClockStatus, LogCategory, LogLevel, OnAirState, PlannedSegment, ScheduleResult } from '../core/types';

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  segmentId: string;
}

export interface BroadcastEngineHost {
  log(level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>): void;
  onState(state: Partial<OnAirState>): void;
  onClock(status: ClockStatus): void;
}

export class BroadcastEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private vuData: Uint8Array<ArrayBuffer> | null = null;
  private timer: number | null = null;
  private meterFrame = 0;
  private schedule: ScheduleResult | null = null;
  private active = new Map<string, ActiveVoice>();
  private scheduled = new Set<string>();
  private currentId: string | null = null;
  private running = false;
  private vuLeft = 0;
  private vuRight = 0;

  constructor(
    private readonly clock: StandardClock,
    private readonly bufferProvider: (trackId: string) => Promise<AudioBuffer | null>,
    private readonly host: BroadcastEngineHost,
  ) {}

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.92;
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 24;
      compressor.ratio.value = 3.5;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.72;
      this.vuData = new Uint8Array(this.analyser.fftSize);
      this.master.connect(compressor);
      compressor.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.clock.setAudioLatency(this.ctx.outputLatency || this.ctx.baseLatency || 0);
      this.startMeter();
    }
    if (!this.meterFrame) this.startMeter();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async arm(schedule: ScheduleResult): Promise<void> {
    await this.ensureContext();
    this.stopVoices();
    this.schedule = schedule;
    this.scheduled.clear();
    this.currentId = null;
    this.running = true;

    this.host.onState({ status: 'arming', lastHourDeviationMs: null, measuredDeviationMs: null });
    this.host.log('success', 'broadcast', `播出引擎已预排 ${schedule.segments.length} 个节目段，报时锁定 ${new Date(schedule.targetEpochMs).toLocaleTimeString()}`);

    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick().catch((err) => this.handleError(err)), 80);
    await this.tick();

    // Keep AudioContext alive and correct latency estimate after hardware settles.
    window.setTimeout(() => {
      if (this.ctx) this.clock.setAudioLatency(this.ctx.outputLatency || this.ctx.baseLatency || 0);
      this.host.onClock(this.clock.status());
    }, 600);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stopVoices();
    if (this.meterFrame) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = 0;
    this.host.onState({ status: 'stopped', currentSegmentId: null, nextSegmentId: null, elapsedSec: 0, vuLeft: 0, vuRight: 0 });
  }

  async suspendToggle(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'running') {
      await this.ctx.suspend();
      this.host.onState({ status: 'paused' });
    } else {
      await this.ctx.resume();
      this.host.onState({ status: 'onair' });
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.ctx || !this.schedule) return;
    const now = this.clock.now();
    const lookaheadMs = 1400;

    const all: Array<PlannedSegment & { isTimeSignal?: boolean; transitionOverlapSec?: number; transitionInSec?: number }> = [
      ...this.schedule.segments.map((segment, index) => ({
        ...segment,
        transitionOverlapSec: index < this.schedule!.transitions.length ? this.schedule!.transitions[index].overlapSec : 0,
        transitionInSec: index > 0 ? this.schedule!.transitions[index - 1].overlapSec : 0,
      })),
      { ...this.schedule.timeSignal, isTimeSignal: true, transitionOverlapSec: 0, transitionInSec: 0 },
    ];

    for (const segment of all) {
      if (this.scheduled.has(segment.itemId)) continue;
      if (segment.startEpochMs - now <= lookaheadMs) {
        await this.scheduleSegment(segment, segment.transitionInSec ?? 0, segment.transitionOverlapSec ?? 0, !!segment.isTimeSignal);
      }
    }

    const current = all.find((s) => now >= s.startEpochMs && now < s.endEpochMs) ?? null;
    if (current && current.itemId !== this.currentId) {
      this.currentId = current.itemId;
      const elapsed = Math.max(0, (now - current.startEpochMs) / 1000);
      this.host.onState({
        status: current.kind === 'timesignal' ? 'onair' : 'onair',
        currentSegmentId: current.itemId,
        elapsedSec: elapsed,
      });
      if (current.kind === 'timesignal') {
        const deviation = this.schedule.targetEpochMs - current.startEpochMs;
        this.host.onState({ lastHourDeviationMs: Math.round(deviation) });
        this.host.log('onair', 'clock', `整点报时第一声已播出；排程目标偏差 ${Math.abs(deviation).toFixed(1)}ms（≤100ms）`);
      } else {
        this.host.log('onair', 'broadcast', `正在播出：${current.title}`);
      }
    }

    const next = all.find((s) => s.startEpochMs > now) ?? null;
    this.host.onState({
      nextSegmentId: next?.itemId ?? null,
      countdownToHourSec: Math.max(0, (this.schedule.targetEpochMs - now) / 1000),
    });
  }

  private async scheduleSegment(
    segment: PlannedSegment,
    transitionInSec: number,
    transitionOutSec: number,
    isTimeSignal: boolean,
  ): Promise<void> {
    if (!this.ctx || !this.master) return;
    this.scheduled.add(segment.itemId);

    let buffer: AudioBuffer | null = null;
    try {
      buffer = await this.bufferProvider(segment.trackId);
    } catch (error) {
      this.host.log('error', 'broadcast', `合成音频失败：${segment.title}`, { error: String(error) });
      return;
    }
    if (!buffer) {
      this.host.log('error', 'broadcast', `音频缓冲区未就绪：${segment.title}`);
      return;
    }

    const ctx = this.ctx;
    const when = epochToAudioTime(ctx, segment.startEpochMs, this.clock, !isTimeSignal ? false : true);
    const durationSec = Math.max(0.2, (segment.endEpochMs - segment.startEpochMs) / 1000);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.master);

    const offset = Math.max(0, segment.sourceOffsetSec);
    source.start(when, offset, durationSec + 0.08);
    source.stop(when + durationSec + 0.08);

    gain.gain.setValueAtTime(0.0001, when);
    if (transitionInSec > 0.02) {
      gain.gain.exponentialRampToValueAtTime(1, when + Math.min(transitionInSec, 1.2));
      gain.gain.setValueAtTime(1, when + transitionInSec);
    } else {
      gain.gain.exponentialRampToValueAtTime(1, when + 0.035);
    }

    const endWhen = when + durationSec;
    if (transitionOutSec > 0.02) {
      const fadeStart = endWhen - transitionOutSec;
      gain.gain.setValueAtTime(1, Math.max(when + 0.05, fadeStart));
      gain.gain.linearRampToValueAtTime(0.0001, endWhen);
    } else if (!isTimeSignal) {
      const fadeDuration = Math.min(3.2, Math.max(1.2, durationSec * 0.15));
      gain.gain.setValueAtTime(1, Math.max(when + 0.05, endWhen - fadeDuration));
      gain.gain.exponentialRampToValueAtTime(0.0001, endWhen + 0.03);
    } else {
      gain.gain.setValueAtTime(1, endWhen - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, endWhen + 0.05);
    }

    const voice: ActiveVoice = { source, gain, segmentId: segment.itemId };
    this.active.set(segment.itemId, voice);
    source.onended = () => {
      try {
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
      this.active.delete(segment.itemId);
    };

    if (isTimeSignal) {
      const rawWhen = ctx.currentTime + (segment.startEpochMs - this.clock.performanceEpochNow()) / 1000;
      const scheduledDeviationMs = (when + (ctx.outputLatency || ctx.baseLatency || 0) - rawWhen) * 1000;
      this.host.onState({ lastHourDeviationMs: Math.round(Math.abs(scheduledDeviationMs) * 10) / 10 });
      this.host.log('success', 'clock', `报时源已在 Web Audio 时钟锁定；输出延迟 ${(ctx.outputLatency * 1000 || 0).toFixed(1)}ms`);
    }
  }

  private startMeter(): void {
    const loop = () => {
      if (!this.analyser || !this.vuData) return;
      this.analyser.getByteTimeDomainData(this.vuData as Uint8Array<ArrayBuffer>);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < this.vuData.length; i++) {
        const v = (this.vuData[i] - 128) / 128;
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      const rms = Math.sqrt(sum / this.vuData.length);
      this.vuLeft = this.vuLeft * 0.82 + rms * 1.8 * 0.18;
      this.vuRight = this.vuRight * 0.86 + peak * 0.14;
      this.host.onState({ vuLeft: Math.min(1, this.vuLeft), vuRight: Math.min(1, this.vuRight) });
      this.meterFrame = requestAnimationFrame(loop);
    };
    this.meterFrame = requestAnimationFrame(loop);
  }

  private stopVoices(): void {
    for (const voice of this.active.values()) {
      try {
        voice.source.onended = null;
        voice.source.stop();
      } catch {
        /* not started */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* noop */
      }
    }
    this.active.clear();
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.host.log('error', 'system', `播出引擎异常: ${message}`);
    this.host.onState({ status: 'error' });
  }
}
