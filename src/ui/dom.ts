// 小型 DOM 工具
export function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
}

export function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 相对整点的秒偏移，负数表示整点前 */
export function fmtOffset(ms: number, hourAt: number): string {
  const rel = (ms - hourAt) / 1000;
  const sign = rel < 0 ? '-' : '+';
  return `${sign}${Math.abs(rel).toFixed(2)}s`;
}

export function el(tag: string, html: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

export function download(filename: string, content: string, mime = 'text/csv'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
