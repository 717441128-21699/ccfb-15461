import type { ClockStatus } from './types';

interface TimeResponse {
  now: number;
}

/**
 * Standard time with optional Cristian-method server sync. When the static app
 * is served without /api/time, it falls back to the local system clock and says
 * so explicitly in the UI rather than pretending it is NTP-synchronized.
 */
export class StandardClock {
  private offsetMs = 0;
  private rttMs: number | null = null;
  private synchronized = false;
  private source: ClockStatus['source'] = 'system';
  private audioOutputLatencyMs = 0;

  now(): number {
    return Date.now() + this.offsetMs;
  }

  performanceEpochNow(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  }

  setAudioLatency(latencySec: number): void {
    this.audioOutputLatencyMs = Math.max(0, latencySec) * 1000;
  }

  async syncWithServer(endpoint = '/api/time'): Promise<ClockStatus> {
    const samples: Array<{ offset: number; rtt: number }> = [];
    for (let i = 0; i < 3; i++) {
      try {
        const t0 = performance.now();
        const response = await fetch(`${endpoint}?t=${t0.toFixed(3)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const t2 = performance.now();
        const body = (await response.json()) as TimeResponse;
        const serverNow = Number(body.now);
        if (!Number.isFinite(serverNow)) throw new Error('bad time payload');
        const rtt = t2 - t0;
        const localMid = Date.now() - rtt / 2;
        samples.push({ offset: serverNow - localMid, rtt });
      } catch {
        // Try next sample; eventually fall back to system clock.
      }
    }
    if (samples.length) {
      samples.sort((a, b) => a.rtt - b.rtt);
      const best = samples[0];
      this.offsetMs = best.offset;
      this.rttMs = best.rtt;
      this.synchronized = true;
      this.source = 'server';
    } else {
      this.offsetMs = 0;
      this.rttMs = null;
      this.synchronized = false;
      this.source = 'system';
    }
    return this.status();
  }

  status(): ClockStatus {
    return {
      standardEpochMs: this.now(),
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      synchronized: this.synchronized,
      source: this.source,
      audioOutputLatencyMs: this.audioOutputLatencyMs,
    };
  }
}

export function epochToAudioTime(
  ctx: AudioContext,
  epochMs: number,
  clock: StandardClock,
  compensateOutputLatency = true,
): number {
  // Sample both clocks as close together as possible. Audio currentTime is the
  // Web Audio rendering clock; performance.timeOrigin + now is monotonic and
  // receives the optional server offset from StandardClock.
  const ctxNow = ctx.currentTime;
  const epochNow = clock.performanceEpochNow();
  let when = ctxNow + (epochMs - epochNow) / 1000;

  if (compensateOutputLatency) {
    const latency = (ctx.outputLatency || ctx.baseLatency || 0) + 0.008;
    clock.setAudioLatency(ctx.outputLatency || 0);
    when -= latency;
  }
  return Math.max(ctxNow + 0.001, when);
}
