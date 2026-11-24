// 播出单编排核心（纯函数，无 DOM 依赖）
// 规则：
//  1) 叠接只发生在上一首淡出段（无人声）与下一首前奏（人声进入前）之间；
//  2) 叠接时长对齐上一首节拍网格，并受 min(outroA, introB) 钳制 -> 人声零碰撞；
//  3) 整点倒排：按剩余时长挑歌，最后一首淡出可 ±6s 调整，残量用垫乐循环填充；
//  4) 任何条目都不得越过整点报时起点。
import type { ScheduleItem } from '../shared/types';

/** 编排所需的素材最小信息集 */
export interface Schedulable {
  id: string;
  title: string;
  kind: string;
  duration: number;
  vocalEntry: number;
  fadeStart: number;
  bpm: number;
}

export interface PlanWindowOptions {
  startAt: number; // 窗口起点（虚拟 ms）
  endAt: number; // 窗口终点（虚拟 ms），报时第一声必须落在这里
  songs: Schedulable[];
  ads: Schedulable[];
  beds: Schedulable[];
  news?: Schedulable[]; // 固定新闻位（按顺序插到歌曲流中）
  newsEvery?: number; // 每 N 首歌插一条新闻（可选）
  adEvery?: number; // 每 N 首歌插一条广告，默认 4
  rng: () => number;
}

export interface PlanResult {
  items: ScheduleItem[];
  residualGapSec: number;
  totalOverlapSec: number;
  fadeAdjustments: { id: string; sec: number }[];
  bedsUsed: string[];
}

const MAX_OVERLAP_SEC = 8;
const MIN_OVERLAP_SEC = 0.5;
const MAX_FADE_ADJUST = 6;

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 计算 a 结尾与 b 前奏的叠接时长（秒）。
 * 起点对齐 a 的节拍网格，钳制在 a 的淡出段与 b 的前奏长度内，保证两曲人声区间不相交。
 */
export function planOverlap(a: Schedulable, b: Schedulable): number {
  const outroA = Math.max(0, a.duration - a.fadeStart);
  // 垫乐无人声，前奏长度不构成约束
  const introB = b.kind === 'bed' ? Number.POSITIVE_INFINITY : Math.max(0, b.vocalEntry);
  const cap = Math.min(outroA, introB, MAX_OVERLAP_SEC);
  if (cap < MIN_OVERLAP_SEC) return 0;
  const beatA = 60 / a.bpm;
  // 候选：a 尾部整拍数对应的叠接长度
  const maxBeats = Math.floor(cap / beatA);
  if (maxBeats < 1) return 0;
  // 取不超过 cap 的最大整拍叠接，同时尽量贴近 b 的拍长相位
  let best = 0;
  for (let n = maxBeats; n >= 1; n--) {
    const cand = n * beatA;
    const phaseErr = Math.abs(cand - Math.round(cand / (60 / b.bpm)) * (60 / b.bpm));
    if (cand <= cap && phaseErr <= beatA * 0.35) {
      best = cand;
      break;
    }
  }
  if (best === 0) best = maxBeats * beatA; // 相位不理想也保证整拍
  return best >= MIN_OVERLAP_SEC ? +best.toFixed(3) : 0;
}

interface SeqEntry {
  track: Schedulable;
  type: ScheduleItem['type'];
  overlapIn: number;
  loopCount?: number;
  /** 垫乐/截断条目的实际占用时长（覆盖 track.duration） */
  effectiveDuration?: number;
}

function effectiveDur(e: SeqEntry): number {
  return e.effectiveDuration ?? e.track.duration;
}

function chainSpan(seq: SeqEntry[]): number {
  let span = 0;
  for (const e of seq) span += effectiveDur(e) - e.overlapIn;
  return span;
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/** 把带叠接关系的序列反向铺到时间轴上，最后一条收在 endAt */
function layBackward(seq: SeqEntry[], startAt: number, endAt: number): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  let cursor = endAt;
  for (let i = seq.length - 1; i >= 0; i--) {
    const e = seq[i];
    const dur = effectiveDur(e);
    const end = cursor;
    const start = end - dur * 1000;
    items.unshift({
      uid: uid('it'),
      type: e.type,
      trackId: e.track.id,
      title: e.track.title,
      startAt: Math.round(start),
      endAt: Math.round(end),
      overlapIn: i === 0 ? 0 : seq[i].overlapIn,
      overlapOut: i < seq.length - 1 ? seq[i + 1].overlapIn : 0,
      fadeAdjustSec: 0,
      loopCount: e.loopCount,
    });
    cursor = start + e.overlapIn * 1000;
  }
  // 整体平移到窗口起点（倒排残差统一在调用方处理，这里只做归一化保险）
  if (items.length > 0) {
    const shift = startAt - items[0].startAt;
    if (Math.abs(shift) > 0.5) {
      for (const it of items) {
        it.startAt += shift;
        it.endAt += shift;
      }
    }
  }
  return items;
}

/** 构造歌曲/广告/新闻混合序列（不含垫乐） */
function buildSequence(opts: PlanWindowOptions): SeqEntry[] {
  const songs = shuffle(opts.songs, opts.rng);
  const ads = shuffle(opts.ads, opts.rng);
  const news = opts.news ? shuffle(opts.news, opts.rng) : [];
  const adEvery = opts.adEvery ?? 4;
  const seq: SeqEntry[] = [];
  let si = 0;
  let ai = 0;
  let ni = 0;
  let sinceAd = 0;
  const windowSec = (opts.endAt - opts.startAt) / 1000;

  const pushTrack = (t: Schedulable, type: SeqEntry['type']): void => {
    const overlapIn = seq.length === 0 ? 0 : planOverlap(seq[seq.length - 1].track, t);
    seq.push({ track: t, type, overlapIn });
  };

  while (si < songs.length) {
    pushTrack(songs[si++], 'song');
    sinceAd++;
    if (opts.newsEvery && ni < news.length && si % opts.newsEvery === 0) {
      pushTrack(news[ni++], 'news');
    } else if (sinceAd >= adEvery && ai < ads.length) {
      pushTrack(ads[ai++], 'ad');
      sinceAd = 0;
    }
    if (chainSpan(seq) >= windowSec * 0.985) break;
  }
  return seq;
}

/** 人声碰撞核验：返回发生碰撞的条目对（叠接设计正确时应为空） */
export function verifyNoVocalCollision(
  items: ScheduleItem[],
  lookup: Map<string, Schedulable> | ((id: string) => Schedulable | undefined),
): { a: string; b: string; overlapMs: number }[] {
  const get = (id: string): Schedulable | undefined =>
    typeof lookup === 'function' ? lookup(id) : lookup.get(id);
  const bad: { a: string; b: string; overlapMs: number }[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const ta = a.trackId ? get(a.trackId) : undefined;
    const tb = b.trackId ? get(b.trackId) : undefined;
    if (!ta || !tb) continue;
    // 垫乐无人声，不参与碰撞
    if (ta.kind === 'bed' || tb.kind === 'bed') continue;
    // a 的人声区间（绝对时间）
    const aVocalStart = a.startAt + ta.vocalEntry * 1000;
    const aVocalEnd = a.startAt + ta.fadeStart * 1000;
    // b 的人声区间
    const bVocalStart = b.startAt + tb.vocalEntry * 1000;
    const bVocalEnd = b.startAt + Math.max(tb.vocalEntry + 0.5, tb.fadeStart) * 1000;
    const hit = Math.min(aVocalEnd, bVocalEnd) - Math.max(aVocalStart, bVocalStart);
    if (hit > 1) bad.push({ a: a.uid, b: b.uid, overlapMs: Math.round(hit) });
  }
  return bad;
}

/** 通用窗口倒排编排 */
export function planWindow(opts: PlanWindowOptions): PlanResult {
  const windowSec = (opts.endAt - opts.startAt) / 1000;
  const seq = buildSequence(opts);
  const fadeAdjustments: { id: string; sec: number }[] = [];
  const bedsUsed: string[] = [];
  let residualGapSec = Math.max(0, windowSec - chainSpan(seq));
  let totalOverlapSec = seq.reduce((a, e) => a + e.overlapIn, 0);

  // ---- 超量：从尾部删歌，直到装得下（至少保留一条，交由淡出截断） ----
  while (chainSpan(seq) > windowSec && seq.length > 1) {
    seq.pop();
    if (seq.length > 0) seq[seq.length - 1].overlapIn = 0; // 末尾条目不再叠接
  }
  residualGapSec = Math.max(0, windowSec - chainSpan(seq));

  // ---- 欠量：还能塞歌就继续塞 ----
  const usedIds = new Set(seq.map((e) => e.track.id));
  const extraSongs = shuffle(opts.songs.filter((s) => !usedIds.has(s.id)), opts.rng);
  for (const t of extraSongs) {
    const overlap = seq.length === 0 ? 0 : planOverlap(seq[seq.length - 1].track, t);
    const add = t.duration - overlap;
    if (chainSpan(seq) + add <= windowSec) {
      seq.push({ track: t, type: 'song', overlapIn: overlap });
      totalOverlapSec += overlap;
    }
  }

  // ---- 重新计算叠接总量并处理残量 ----
  totalOverlapSec = seq.reduce((a, e) => a + e.overlapIn, 0);
  let gap = windowSec - chainSpan(seq);

  if (gap < 0) {
    // 超量：逐条提前淡出并截断，直到链条收进窗口（提前量不受 6s 约束）
    while (gap < -0.001 && seq.length > 0) {
      const last = seq[seq.length - 1];
      const trim = gap; // 负：需要裁掉的秒数
      const newDur = Math.max(1, effectiveDur(last) + trim);
      const applied = newDur - effectiveDur(last);
      last.effectiveDuration = newDur;
      const prev = fadeAdjustments.find((f) => f.id === last.track.id);
      const delta = +applied.toFixed(3);
      if (prev) prev.sec = +(prev.sec + delta).toFixed(3);
      else fadeAdjustments.push({ id: last.track.id, sec: delta });
      gap = windowSec - chainSpan(seq);
      if (gap >= -0.001) break;
      // 这条已经压到 1s 仍超量：整条丢弃，继续处理前一条
      seq.pop();
      if (seq.length > 0) seq[seq.length - 1].overlapIn = 0;
      gap = windowSec - chainSpan(seq);
    }
  }

  if (gap > 0 && seq.length > 0) {
    if (gap <= MAX_FADE_ADJUST + 0.05) {
      // 残量小：延后最后一首淡出
      const last = seq[seq.length - 1];
      const adj = Math.min(gap, MAX_FADE_ADJUST);
      last.effectiveDuration = effectiveDur(last) + adj;
      fadeAdjustments.push({ id: last.track.id, sec: +adj.toFixed(3) });
      gap -= adj;
    } else if (opts.beds.length > 0) {
      // 残量大：垫乐循环填充，插在最后一条之前（与前后都可叠接）
      const bed = opts.beds[Math.floor(opts.rng() * opts.beds.length)];
      const last = seq.pop()!;
      const bedOverlapIn = seq.length === 0 ? 0 : planOverlap(seq[seq.length - 1].track, bed);
      const bedOverlapOut = planOverlap(bed, last.track);
      const bedNeed = gap + bedOverlapIn + bedOverlapOut;
      const loopCount = Math.max(1, Math.ceil(bedNeed / bed.duration));
      const bedDur = Math.max(0.5, bedNeed); // 精确占用需要的长度，末圈由播出端做收尾淡出
      const bedEntry: SeqEntry = {
        track: bed, type: 'bed', overlapIn: bedOverlapIn, loopCount, effectiveDuration: bedDur,
      };
      last.overlapIn = bedOverlapOut;
      seq.push(bedEntry, last);
      bedsUsed.push(bed.id);
      totalOverlapSec += bedOverlapIn + bedOverlapOut;
      gap = windowSec - chainSpan(seq);
    }
  }

  // ---- 最终收敛：任何剩余 |gap| ≤ 6s 都由末条淡出微调消化 ----
  if (seq.length > 0 && Math.abs(gap) <= MAX_FADE_ADJUST && Math.abs(gap) >= 0.001) {
    const last = seq[seq.length - 1];
    const adj = +gap.toFixed(3);
    last.effectiveDuration = Math.max(1, effectiveDur(last) + adj);
    const prev = fadeAdjustments.find((f) => f.id === last.track.id);
    if (prev) prev.sec = +(prev.sec + adj).toFixed(3);
    else fadeAdjustments.push({ id: last.track.id, sec: adj });
    gap = 0;
  }

  residualGapSec = Math.max(0, +gap.toFixed(3));
  const items = layBackward(seq, opts.startAt, opts.endAt);
  // 写回淡出调整量
  for (const adj of fadeAdjustments) {
    const target = items.filter((it) => it.trackId === adj.id).pop();
    if (target) target.fadeAdjustSec = adj.sec;
  }
  return { items, residualGapSec, totalOverlapSec, fadeAdjustments, bedsUsed };
}

/** 整点编排：窗口 = [hourAt-3600s, hourAt]，另附报时条目 */
export function planHour(
  hourAt: number,
  opts: Omit<PlanWindowOptions, 'startAt' | 'endAt'>,
  pipsDurationSec: number,
): PlanResult & { pips: ScheduleItem } {
  const res = planWindow({ ...opts, startAt: hourAt - 3600 * 1000, endAt: hourAt });
  const pips: ScheduleItem = {
    uid: uid('pips'),
    type: 'pips',
    title: '整点报时',
    startAt: hourAt,
    endAt: Math.round(hourAt + pipsDurationSec * 1000),
    overlapIn: 0,
    overlapOut: 0,
    fadeAdjustSec: 0,
    note: '第一声=整点',
  };
  return { ...res, pips };
}
