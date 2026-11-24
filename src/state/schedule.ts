// 播出单服务：曲库 -> 可编排素材 -> 整点倒排 -> 插播重排
import { planWindow, type Schedulable } from '../scheduler/scheduler';
import type {
  HourBlock,
  ScheduleItem,
  Track,
} from '../shared/types';
import { library } from './library';

function toSchedulable(t: Track): Schedulable {
  if (!t.analysis) throw new Error(`素材 ${t.title} 尚未分析`);
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    duration: t.duration,
    vocalEntry: t.analysis.vocalEntry,
    fadeStart: t.analysis.fadeStart,
    bpm: t.analysis.bpm,
  };
}

/** 可复现随机数 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BuildOptions {
  /** 宏小时长度（秒），演示用；真实场景为 3600 */
  hourLengthSec: number;
  adEvery?: number;
  seed?: number;
}

export interface BuiltHour {
  block: HourBlock;
  totalOverlapSec: number;
  bedsUsed: string[];
  collisions: { a: string; b: string; overlapMs: number }[];
}

const PIPS_DURATION_SEC = 3.2;

export function buildHour(hourAtMs: number, opts: BuildOptions): BuiltHour {
  const songs = library.list('song').map(toSchedulable);
  const ads = library.list('ad').map(toSchedulable);
  const beds = library.list('bed').map(toSchedulable);
  const news = library.list('news').map(toSchedulable);
  if (songs.length < 3) throw new Error('曲库不足：至少需要 3 首已分析歌曲');
  const rng = seededRng(opts.seed ?? (hourAtMs ^ 0x9e3779b9));

  // 宏小时：把窗口长度参数化
  const startAt = hourAtMs - opts.hourLengthSec * 1000;
  const res = planWindow({
    startAt,
    endAt: hourAtMs,
    songs,
    ads,
    beds,
    news,
    adEvery: opts.adEvery ?? 4,
    rng,
  });
  const pips: ScheduleItem = {
    uid: `pips-${hourAtMs}`,
    type: 'pips',
    title: '整点报时',
    startAt: hourAtMs,
    endAt: Math.round(hourAtMs + PIPS_DURATION_SEC * 1000),
    overlapIn: 0,
    overlapOut: 0,
    fadeAdjustSec: 0,
    note: '第一声=整点',
  };
  const block: HourBlock = { hourAt: hourAtMs, items: res.items, pips, residualGapSec: res.residualGapSec };
  const lookup = new Map([...songs, ...ads, ...beds, ...news].map((s) => [s.id, s]));
  const collisions = checkCollisions(block.items, lookup);
  return { block, totalOverlapSec: res.totalOverlapSec, bedsUsed: res.bedsUsed, collisions };
}

function checkCollisions(items: ScheduleItem[], lookup: Map<string, Schedulable>) {
  const bad: { a: string; b: string; overlapMs: number }[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const ta = a.trackId ? lookup.get(a.trackId) : undefined;
    const tb = b.trackId ? lookup.get(b.trackId) : undefined;
    if (!ta || !tb) continue;
    if (ta.kind === 'bed' || tb.kind === 'bed') continue;
    const aVocalStart = a.startAt + ta.vocalEntry * 1000;
    const aVocalEnd = a.startAt + ta.fadeStart * 1000;
    const bVocalStart = b.startAt + tb.vocalEntry * 1000;
    const bVocalEnd = b.startAt + Math.max(tb.vocalEntry + 0.5, tb.fadeStart) * 1000;
    const hit = Math.min(aVocalEnd, bVocalEnd) - Math.max(aVocalStart, bVocalStart);
    if (hit > 1) bad.push({ a: a.uid, b: b.uid, overlapMs: Math.round(hit) });
  }
  return bad;
}

/** 插播新闻：从 nowMs 起塞入新闻并重排其后的单子，终点仍钉在 hourAtMs */
export function replanAfterInterrupt(
  current: HourBlock,
  nowMs: number,
  _hourLengthSec: number,
  adEvery = 4,
): { block: HourBlock; collisions: { a: string; b: string; overlapMs: number }[] } {
  const songs = library.list('song').map(toSchedulable);
  const ads = library.list('ad').map(toSchedulable);
  const beds = library.list('bed').map(toSchedulable);
  const news = library.list('news').map(toSchedulable);
  const rng = seededRng((nowMs ^ 0x51ed270b) >>> 0);

  // 正在播出/已播出的条目原样保留
  const keep = current.items.filter((it) => it.endAt <= nowMs);
  const anchorEnd = keep.length ? keep[keep.length - 1].endAt : nowMs;

  const res = planWindow({
    startAt: anchorEnd,
    endAt: current.hourAt,
    songs,
    ads,
    beds,
    news,
    adEvery,
    rng,
  });
  const block: HourBlock = {
    hourAt: current.hourAt,
    items: [...keep, ...res.items],
    pips: current.pips,
    residualGapSec: res.residualGapSec,
  };
  const lookup = new Map([...songs, ...ads, ...beds, ...news].map((s) => [s.id, s]));
  return {
    block,
    collisions: checkCollisions(block.items, lookup),
  };
}

export { PIPS_DURATION_SEC };
