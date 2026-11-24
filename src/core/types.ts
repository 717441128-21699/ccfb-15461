export type TrackKind =
  | 'song'
  | 'ad'
  | 'jingle'
  | 'news'
  | 'filler'
  | 'timesignal';

export type StyleId =
  | 'pop'
  | 'folk'
  | 'rock'
  | 'electronic'
  | 'ballad'
  | 'market-ad'
  | 'agri-ad'
  | 'health-ad'
  | 'psa'
  | 'news-bed'
  | 'jingle'
  | 'timesignal';

export interface VocalInterval {
  startSec: number;
  endSec: number;
  confidence: number;
}

/** Deterministic arrangement contract used by the synthesizer. */
export interface TrackSpec {
  id: string;
  title: string;
  kind: TrackKind;
  style: StyleId;
  styleLabel: string;
  seed: number;
  durationSec: number;
  bpm: number;
  firstBeatSec: number;
  /** Optional explicit beat list for short jingles; large library uses BPM grid. */
  beats?: number[];
  vocal: VocalInterval[];
  vocalInSec: number | null;
  vocalEndSec: number | null;
  fadeStartSec: number;
  fadeEndSec: number;
  nominalTakeOutSec: number;
  energy: number;
  tags: string[];
  synthesized: true;
}

export interface PcmBufferLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface TrackAnalysis {
  trackId: string;
  version: string;
  durationSec: number;
  bpm: number;
  bpmConfidence: number;
  beatPeriodSec: number;
  beatOffsetSec: number;
  /** High-confidence beat anchor inside the final analysis window. */
  tailBeatOffsetSec: number;
  downbeatOffsetSec: number;
  /** Conservative boundary: incoming overlap must end no later than this. */
  safeVocalInSec: number;
  /** Conservative boundary: outgoing overlap must start no earlier than this. */
  safeVocalOutSec: number;
  vocalInSec: number | null;
  vocalEndSec: number | null;
  vocalIntervals: VocalInterval[];
  fadeStartSec: number | null;
  fadeEndSec: number | null;
  analysisDurationMs: number;
  samplesProcessed: number;
}

export interface LibraryTrack {
  spec: TrackSpec;
  analysis: TrackAnalysis | null;
  analysisError?: string;
}

export interface TransitionPlan {
  fromTrackId: string;
  toTrackId: string;
  /** Output seconds during which both decks are audible. */
  overlapSec: number;
  /** Source position in the outgoing track at overlap start. */
  fromCueSec: number;
  /** Source position in incoming track at output segment start. */
  toOffsetSec: number;
  beatAlignErrorMs: number | null;
  beatAligned: boolean;
  /** Always zero by construction; validator proves it against vocal truth. */
  vocalOverlapSec: 0;
  allowedOverlapSec: number;
  curve: 'equal-power';
  reason: string;
}

export interface PlannedSegment {
  itemId: string;
  trackId: string;
  title: string;
  kind: TrackKind;
  startEpochMs: number;
  endEpochMs: number;
  sourceOffsetSec: number;
  takeOutSec: number;
  fadeNudgeSec: number;
  autoSelected: boolean;
  breaking?: boolean;
}

export interface ScheduleResult {
  targetEpochMs: number;
  buildEpochMs: number;
  startEpochMs: number;
  segments: PlannedSegment[];
  transitions: TransitionPlan[];
  timeSignal: PlannedSegment;
  programDurationSec: number;
  exactEndErrorMs: number;
  adjustments: string[];
  warnings: string[];
}

export interface RundownItem {
  id: string;
  trackId: string;
  autoSelected?: boolean;
  breaking?: boolean;
  note?: string;
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'onair';
export type LogCategory =
  | 'analysis'
  | 'schedule'
  | 'broadcast'
  | 'clock'
  | 'library'
  | 'system';

export interface LogEntry {
  id: number;
  timeEpochMs: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
}

export interface ClockStatus {
  standardEpochMs: number;
  offsetMs: number;
  rttMs: number | null;
  synchronized: boolean;
  source: 'server' | 'performance' | 'system';
  audioOutputLatencyMs: number;
}

export interface OnAirState {
  status: 'idle' | 'arming' | 'onair' | 'paused' | 'stopped' | 'error';
  currentSegmentId: string | null;
  nextSegmentId: string | null;
  startedAtEpochMs: number | null;
  elapsedSec: number;
  countdownToHourSec: number | null;
  lastHourDeviationMs: number | null;
  measuredDeviationMs: number | null;
  vuLeft: number;
  vuRight: number;
}
