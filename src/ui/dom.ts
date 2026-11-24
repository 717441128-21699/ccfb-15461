export type Child = Node | string | number | false | null | undefined;

export type ElementProps<T extends HTMLElement> = Partial<Omit<T, 'style'>> & {
  class?: string;
  dataset?: Record<string, string>;
  style?: string | Partial<CSSStyleDeclaration>;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      element.className = String(value);
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value as Record<string, string>)) {
        element.dataset[dataKey] = dataValue;
      }
    } else if (key === 'style') {
      if (typeof value === 'string') {
        element.setAttribute('style', value);
      } else {
        Object.assign(element.style, value);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key.includes('-') || !(key in element)) {
      element.setAttribute(key, String(value));
    } else {
      try {
        (element as unknown as Record<string, unknown>)[key] = value;
      } catch {
        element.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) appendChild(element, child);
  return element;
}

export function appendChild(element: HTMLElement, child: Child): void {
  if (child === false || child === null || child === undefined) return;
  element.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

export function clear(element: HTMLElement): void {
  element.replaceChildren();
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${fmtTime(epochMs)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--';
  const sign = sec < 0 ? '-' : '';
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const tenth = Math.floor((s * 10) % 10);
  return `${sign}${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}.${tenth}`;
}

export function pct(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
