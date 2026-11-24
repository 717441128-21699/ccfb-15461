// 播出日志服务：环形缓冲 + 订阅 + CSV 导出
import type { LogEvent } from '../shared/types';

const MAX_EVENTS = 2000;

class LogService {
  private events: LogEvent[] = [];
  private listeners = new Set<() => void>();
  private counter = 0;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(ev: Omit<LogEvent, 'id' | 'wallTime' | 'airTime'>, airTime: number): void {
    this.counter++;
    const full: LogEvent = {
      ...ev,
      id: `log-${this.counter}`,
      wallTime: Date.now(),
      airTime: Math.round(airTime),
    };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const fn of this.listeners) fn();
  }

  all(): LogEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    for (const fn of this.listeners) fn();
  }

  toCSV(): string {
    const head = 'id,wallTime,airTime,level,kind,message,detail';
    const rows = this.events.map((e) => [
      e.id,
      new Date(e.wallTime).toISOString(),
      new Date(e.airTime).toISOString(),
      e.level,
      e.kind,
      `"${e.message.replace(/"/g, '""')}"`,
      e.detail ? `"${JSON.stringify(e.detail).replace(/"/g, '""')}"` : '',
    ].join(','));
    return [head, ...rows].join('\n');
  }
}

export const logs = new LogService();
