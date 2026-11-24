import { clamp } from './rng';
import type {
  LibraryTrack,
  PlannedSegment,
  RundownItem,
  ScheduleResult,
  TrackSpec,
  TransitionPlan,
  VocalInterval,
} from './types';

export const MAX_FADE_NUDGE_SEC = 5;
const EXTRA_VOCAL_GUARD_SEC = 0.12;

export interface CatalogResolver {
  get(id: string): LibraryTrack | undefined;
}

export class MapCatalog implements CatalogResolver {
  constructor(private readonly map: Map<string, LibraryTrack>) {}
  get(id: string): LibraryTrack | undefined {
    return this.map.get(id);
  }
}

export function requireAnalyzed(track: LibraryTrack): LibraryTrack {
  if (!track.analysis) throw new Error(`曲目尚未分析: ${track.spec.id}`);
  return track;
}

function nearestBeat(time: number, anchor: number, period: number): { beat: number; errorMs: number } {
  const k = Math.round((time - anchor) / period);
  const beat = anchor + k * period;
  return { beat, errorMs: (time - beat) * 1000 };
}

/**
 * Plan one safe transition.
 *
 * Hard rule: overlap can only cover the instrumental intro of `to` and the
 * post-vocal tail of `from`. The scheduler uses conservative analysis bounds;
 * validateTransitionAgainstTruth() later proves zero vocal/vocal overlap.
 */
export function planTransition(from: LibraryTrack, to: LibraryTrack): TransitionPlan {
  const a = requireAnalyzed(from).analysis!;
  const b = requireAnalyzed(to).analysis!;
  const fromSpec = from.spec;
  const takeOut = fromSpec.nominalTakeOutSec;
  const safeOut = a.safeVocalOutSec + EXTRA_VOCAL_GUARD_SEC;
  const safeIn = b.safeVocalInSec - EXTRA_VOCAL_GUARD_SEC;
  const toFirstBeat = Math.max(0, b.beatOffsetSec);

  const outWindow = Math.max(0, takeOut - safeOut);
  const inWindow = Math.max(0, safeIn - toFirstBeat);
  const allowedOverlap = Math.max(0, Math.min(9, outWindow, inWindow));

  const zero = (reason: string): TransitionPlan => ({
    fromTrackId: fromSpec.id,
    toTrackId: to.spec.id,
    overlapSec: 0,
    fromCueSec: takeOut,
    toOffsetSec: 0,
    beatAlignErrorMs: null,
    beatAligned: false,
    vocalOverlapSec: 0,
    allowedOverlapSec: allowedOverlap,
    curve: 'equal-power',
    reason,
  });

  if (allowedOverlap < 0.9) {
    return zero('前奏或尾巴没有足够无人声节拍段，采用硬对接');
  }

  const period = a.beatPeriodSec;
  const minCue = safeOut;
  const maxCue = takeOut - 0.8;
  if (maxCue <= minCue) return zero('上一首安全尾巴不足，采用硬对接');

  const targetCue = clamp(fromSpec.fadeStartSec, minCue, maxCue);
  const kMin = Math.ceil((minCue - a.tailBeatOffsetSec) / period);
  const kMax = Math.floor((maxCue - a.tailBeatOffsetSec) / period);
  let best: { cue: number; overlap: number; score: number; error: number } | null = null;

  for (let k = kMin; k <= kMax; k++) {
    const cue = a.tailBeatOffsetSec + k * period;
    if (cue < minCue - 1e-6 || cue > maxCue + 1e-6) continue;
    const overlap = takeOut - cue;
    if (overlap < 0.8 || overlap > allowedOverlap + 1e-6) continue;
    const beat = nearestBeat(cue, a.tailBeatOffsetSec, period);
    // Prefer starting the crossfade at the analyzed fade point and a musical
    // 2.5-6 second overlap. Vocal safety is already enforced above.
    const musicalPenalty = Math.abs(overlap - 4) * 0.18;
    const score = Math.abs(cue - targetCue) * 1.4 + musicalPenalty + Math.abs(beat.errorMs) / 1000;
    if (!best || score < best.score) {
      best = { cue, overlap, score, error: Math.abs(beat.errorMs) };
    }
  }

  if (!best) return zero('未找到同时满足节拍和人声约束的叠播点');

  return {
    fromTrackId: fromSpec.id,
    toTrackId: to.spec.id,
    overlapSec: Math.round(best.overlap * 1000) / 1000,
    fromCueSec: Math.round(best.cue * 1000) / 1000,
    // Start the incoming deck exactly on its first detected beat. This skips
    // only sub-200 ms pre-beat detector padding, not the musical intro.
    toOffsetSec: Math.round(toFirstBeat * 1000) / 1000,
    beatAlignErrorMs: Math.round(best.error * 10) / 10,
    beatAligned: best.error <= 35,
    vocalOverlapSec: 0,
    allowedOverlapSec: Math.round(allowedOverlap * 1000) / 1000,
    curve: 'equal-power',
    reason: `上一首尾拍与下一首首拍对齐，叠播 ${best.overlap.toFixed(2)}s，人声区间不重叠`,
  };
}

export interface TruthViolation {
  transitionIndex: number;
  overlapVocalSec: number;
  fromIntervals: Array<[number, number]>;
  toIntervals: Array<[number, number]>;
}

/** Maps ground-truth vocal intervals into overlap-relative time and intersects them. */
export function validateTransitionAgainstTruth(
  plan: TransitionPlan,
  from: TrackSpec,
  to: TrackSpec,
  transitionIndex = 0,
): TruthViolation | null {
  const o = plan.overlapSec;
  if (o <= 0.0001) return null;

  const fromRelative = from.vocal
    .map((v) => [v.startSec - plan.fromCueSec, v.endSec - plan.fromCueSec] as [number, number])
    .map(([s, e]) => [Math.max(0, s), Math.min(o, e)] as [number, number])
    .filter(([s, e]) => e > s);

  const toRelative = to.vocal
    .map((v) => [v.startSec - plan.toOffsetSec, v.endSec - plan.toOffsetSec] as [number, number])
    .map(([s, e]) => [Math.max(0, s), Math.min(o, e)] as [number, number])
    .filter(([s, e]) => e > s);

  let overlapVocalSec = 0;
  for (const a of fromRelative) {
    for (const b of toRelative) {
      overlapVocalSec += Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
    }
  }
  if (overlapVocalSec > 0.001) {
    return { transitionIndex, overlapVocalSec, fromIntervals: fromRelative, toIntervals: toRelative };
  }
  return null;
}

interface ResolvedItem {
  item: RundownItem;
  track: LibraryTrack;
  transitionIn: TransitionPlan | null;
  baseDurationSec: number;
}

export interface ComputeScheduleOptions {
  targetEpochMs: number;
  items: RundownItem[];
  catalog: CatalogResolver;
  nudgeSec?: number;
  buildEpochMs?: number;
}

export function computeSchedule(options: ComputeScheduleOptions): ScheduleResult {
  const nudge = options.nudgeSec ?? 0;
  const buildEpochMs = options.buildEpochMs ?? Date.now();
  const resolved: ResolvedItem[] = [];
  const transitions: TransitionPlan[] = [];
  const warnings: string[] = [];
  const adjustments: string[] = [];

  for (const item of options.items) {
    const track = options.catalog.get(item.trackId);
    if (!track?.analysis) {
      warnings.push(`素材 ${item.trackId} 未分析，已跳过`);
      continue;
    }
    let transitionIn: TransitionPlan | null = null;
    if (resolved.length > 0) {
      transitionIn = planTransition(resolved[resolved.length - 1].track, track);
      transitions.push(transitionIn);
    }
    const offset = transitionIn?.toOffsetSec ?? 0;
    const baseDuration = track.spec.nominalTakeOutSec - offset;
    if (baseDuration <= 0.5) {
      warnings.push(`素材 ${track.spec.title} 有效时长过短，已跳过`);
      continue;
    }
    resolved.push({ item, track, transitionIn, baseDurationSec: baseDuration });
  }

  const timeSignalTrack = options.catalog.get('time-signal');
  const timeSignalDuration = timeSignalTrack?.spec.durationSec ?? 5.9;
  const timeSignal: PlannedSegment = {
    itemId: 'time-signal',
    trackId: 'time-signal',
    title: timeSignalTrack?.spec.title ?? '整点报时',
    kind: 'timesignal',
    startEpochMs: options.targetEpochMs,
    endEpochMs: options.targetEpochMs + timeSignalDuration * 1000,
    sourceOffsetSec: 0,
    takeOutSec: timeSignalDuration,
    fadeNudgeSec: 0,
    autoSelected: false,
  };

  const segments: PlannedSegment[] = new Array(resolved.length);
  let nextStartEpochMs = options.targetEpochMs;

  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    const transitionToNext = i < resolved.length - 1 ? transitions[i] : null;
    const overlapToNext = transitionToNext?.overlapSec ?? 0;
    const endEpochMs = nextStartEpochMs + overlapToNext * 1000;
    const isLast = i === resolved.length - 1;
    const fadeNudgeSec = isLast ? nudge : 0;
    const durationSec = r.baseDurationSec + fadeNudgeSec;
    const startEpochMs = endEpochMs - durationSec * 1000;
    const takeOutSec = (r.transitionIn?.toOffsetSec ?? 0) + durationSec;

    if (isLast && Math.abs(fadeNudgeSec) > 0.01) {
      adjustments.push(
        fadeNudgeSec < 0
          ? `最后一首淡出提前 ${Math.abs(fadeNudgeSec).toFixed(2)}s，追回超时`
          : `最后一首淡出延后 ${fadeNudgeSec.toFixed(2)}s，填满剩余时间`,
      );
    }

    segments[i] = {
      itemId: r.item.id,
      trackId: r.track.spec.id,
      title: r.track.spec.title,
      kind: r.track.spec.kind,
      startEpochMs,
      endEpochMs,
      sourceOffsetSec: r.transitionIn?.toOffsetSec ?? 0,
      takeOutSec,
      fadeNudgeSec,
      autoSelected: !!r.item.autoSelected,
      breaking: r.item.breaking,
    };
    nextStartEpochMs = startEpochMs;
  }

  const firstStart = segments[0]?.startEpochMs ?? options.targetEpochMs;
  const programDurationSec = (options.targetEpochMs - firstStart) / 1000;

  if (nudge !== 0 && Math.abs(nudge) > MAX_FADE_NUDGE_SEC + 1e-6) {
    warnings.push(`所需淡出修正 ${nudge.toFixed(2)}s 超过 ±${MAX_FADE_NUDGE_SEC}s 设计范围`);
  }

  return {
    targetEpochMs: options.targetEpochMs,
    buildEpochMs,
    startEpochMs: firstStart,
    segments,
    transitions,
    timeSignal,
    programDurationSec,
    exactEndErrorMs: segments.length ? segments[segments.length - 1].endEpochMs - options.targetEpochMs : 0,
    adjustments,
    warnings,
  };
}

export function sequenceDurationSec(items: RundownItem[], catalog: CatalogResolver, nudgeSec = 0): number {
  const schedule = computeSchedule({
    // A far-future arbitrary target keeps date calls irrelevant; computeSchedule only uses differences.
    targetEpochMs: 10_000_000_000_000,
    items,
    catalog,
    nudgeSec,
  });
  return schedule.programDurationSec;
}

export interface AutoFitOptions {
  targetEpochMs: number;
  nowEpochMs: number;
  items: RundownItem[];
  catalog: CatalogResolver;
  candidates: LibraryTrack[];
  startLeadMs?: number;
  maxNudgeSec?: number;
  createId?: () => string;
}

export interface AutoFitResult {
  items: RundownItem[];
  schedule: ScheduleResult;
  requiredNudgeSec: number;
  removedAutoIds: string[];
  insertedIds: string[];
}

/**
 * Backward clock fit. It first removes only disposable auto items if a breaking
 * bulletin made the queue too long, then chooses songs/fillers for the remaining
 * seconds and uses the final fade point for sub-5-second exactness.
 */
export function autoFitRundown(options: AutoFitOptions): AutoFitResult {
  const maxNudge = options.maxNudgeSec ?? MAX_FADE_NUDGE_SEC;
  const startLeadMs = options.startLeadMs ?? 800;
  const plannedStart = options.nowEpochMs + startLeadMs;
  const availableSec = Math.max(5, (options.targetEpochMs - plannedStart) / 1000);
  const createId = options.createId ?? defaultIdFactory();
  const removedAutoIds: string[] = [];
  const insertedIds: string[] = [];

  let items = [...options.items];

  // If breaking news made the chain too long, remove disposable auto selections
  // from the tail until the fixed/manual chain can fit inside the nudge range.
  let baseDuration = sequenceDurationSec(items, options.catalog);
  while (baseDuration > availableSec + maxNudge + 0.25) {
    let removed = false;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].autoSelected) {
        removedAutoIds.push(items[i].id);
        items.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) break;
    baseDuration = sequenceDurationSec(items, options.catalog);
  }

  // Append material according to remaining time.
  for (let guard = 0; guard < 80; guard++) {
    baseDuration = sequenceDurationSec(items, options.catalog);
    let residual = availableSec - baseDuration;
    if (Math.abs(residual) <= maxNudge) break;
    if (residual < -maxNudge) break;

    const lastItem = items[items.length - 1];
    const lastTrack = lastItem ? options.catalog.get(lastItem.trackId) : undefined;
    const candidate = chooseCandidate({
      residualSec: residual,
      lastTrack,
      candidates: options.candidates,
      catalog: options.catalog,
      maxNudgeSec: maxNudge,
    });
    if (!candidate) break;

    const item: RundownItem = {
      id: createId(),
      trackId: candidate.spec.id,
      autoSelected: true,
      note: residual > 120 ? '按剩余时长选歌' : '按剩余时长选垫乐/广告',
    };
    items.push(item);
    insertedIds.push(item.id);
  }

  baseDuration = sequenceDurationSec(items, options.catalog);
  let nudge = clamp(availableSec - baseDuration, -maxNudge, maxNudge);

  // If final track cannot accept positive nudge to its file end, bias one more
  // short filler or use negative nudge. Generated songs have ample tail.
  const lastTrack = items.length ? options.catalog.get(items[items.length - 1].trackId) : undefined;
  if (lastTrack?.analysis && nudge > 0) {
    const maxPositive = lastTrack.spec.durationSec - 0.08 - lastTrack.spec.nominalTakeOutSec;
    if (nudge > maxPositive) nudge = clamp(nudge, -maxNudge, Math.max(0, maxPositive));
  }

  const schedule = computeSchedule({
    targetEpochMs: options.targetEpochMs,
    items,
    catalog: options.catalog,
    nudgeSec: nudge,
    buildEpochMs: options.nowEpochMs,
  });

  return { items, schedule, requiredNudgeSec: availableSec - baseDuration, removedAutoIds, insertedIds };
}

function chooseCandidate(args: {
  residualSec: number;
  lastTrack: LibraryTrack | undefined;
  candidates: LibraryTrack[];
  catalog: CatalogResolver;
  maxNudgeSec: number;
}): LibraryTrack | null {
  const { residualSec, lastTrack, candidates, maxNudgeSec } = args;
  let best: { track: LibraryTrack; marginal: number; score: number } | null = null;

  for (const track of candidates) {
    if (!track.analysis) continue;
    if (track.spec.kind === 'timesignal' || track.spec.kind === 'news') continue;

    let transition: TransitionPlan | null = null;
    if (lastTrack) {
      transition = planTransition(lastTrack, track);
    }
    const offset = transition?.toOffsetSec ?? 0;
    const marginal = track.spec.nominalTakeOutSec - offset - (transition?.overlapSec ?? 0);
    if (marginal <= 1) continue;

    // Do not overshoot by more than the final nudge window; for large residual
    // require the candidate to leave positive work for a later pass.
    const afterResidual = residualSec - marginal;
    if (afterResidual < -maxNudgeSec) continue;
    if (residualSec > 170 && afterResidual < 8 && track.spec.kind !== 'song') continue;
    if (residualSec <= 170 && track.spec.kind === 'song' && marginal > residualSec + maxNudgeSec) continue;

    let score = Math.abs(afterResidual);
    if (residualSec > 150 && track.spec.kind === 'song') score *= 0.72;
    if (residualSec <= 75 && (track.spec.kind === 'filler' || track.spec.kind === 'jingle' || track.spec.kind === 'ad')) score *= 0.75;
    if (lastTrack && transition?.beatAligned) score -= 1.5;
    if (track.spec.kind === 'ad' && residualSec > 90) score += 8;

    if (!best || score < best.score) best = { track, marginal, score };
  }
  return best?.track ?? null;
}

export function insertBreakingNews(options: {
  items: RundownItem[];
  newsTrackId: string;
  catalog: CatalogResolver;
  afterItemId?: string | null;
  createId?: () => string;
}): RundownItem[] {
  const createId = options.createId ?? defaultIdFactory();
  const news: RundownItem = {
    id: createId(),
    trackId: options.newsTrackId,
    breaking: true,
    autoSelected: false,
    note: '临时插播',
  };
  const items = [...options.items];
  if (!options.afterItemId) {
    items.unshift(news);
    return items;
  }
  const index = items.findIndex((i) => i.id === options.afterItemId);
  if (index < 0) items.unshift(news);
  else items.splice(index + 1, 0, news);
  return items;
}

function defaultIdFactory(): () => string {
  let n = 0;
  return () => `rundown-${Date.now().toString(36)}-${(n++).toString(36)}`;
}

export function nextTopOfHour(now = new Date()): number {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

export function secondsUntil(epochMs: number, nowEpochMs: number): number {
  return (epochMs - nowEpochMs) / 1000;
}

export function vocalIntervalsOf(spec: TrackSpec): VocalInterval[] {
  return spec.vocal;
}
