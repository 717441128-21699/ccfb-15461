import { PLAYBACK_SAMPLE_RATE, renderPcmBuffer } from './synth';
import type { TrackSpec } from '../core/types';

export class AudioBufferCache {
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();

  constructor(private readonly ctx: BaseAudioContext) {}

  has(trackId: string): boolean {
    return this.buffers.has(trackId);
  }

  async get(spec: TrackSpec): Promise<AudioBuffer> {
    const cached = this.buffers.get(spec.id);
    if (cached) return cached;
    const existing = this.pending.get(spec.id);
    if (existing) return existing;

    const task = new Promise<AudioBuffer>((resolve, reject) => {
      // Let the UI paint before the procedural render blocks briefly.
      setTimeout(() => {
        try {
          const pcm = renderPcmBuffer(spec, PLAYBACK_SAMPLE_RATE);
          const buffer = this.ctx.createBuffer(pcm.numberOfChannels, pcm.length, pcm.sampleRate);
          buffer.getChannelData(0).set(pcm.getChannelData(0));
          this.buffers.set(spec.id, buffer);
          this.pending.delete(spec.id);
          resolve(buffer);
        } catch (error) {
          this.pending.delete(spec.id);
          reject(error);
        }
      }, 0);
    });
    this.pending.set(spec.id, task);
    return task;
  }
}
