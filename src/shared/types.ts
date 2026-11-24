// 全系统共享类型定义

/** 素材类型 */
export type TrackKind = 'song' | 'ad' | 'bed' | 'news' | 'pips';

/** 曲风（合成素材的几种风格） */
export type StyleId = 'pop' | 'rock' | 'folk' | 'electronic' | 'classical';

/** 曲库素材元数据 */
export interface Track {
  id: string;
  title: string;
  artist: string;
  kind: TrackKind;
  style: StyleId;
  /** 时长（秒） */
  duration: number;
  sampleRate: number;
  channels: 1 | 2;
  /** 生成时写入的真实结构标记，用于核验分析准确率 */
  groundTruth?: AnalysisGroundTruth;
  /** 合成参数（用于按需确定性重合成播放） */
  synth?: {
    seed: number;
    sampleRate: number;
    requestedDurationSec: number;
  };
  /** 分析结果 */
  analysis?: AnalysisResult;
  /** 分析耗时（毫秒） */
  analysisMs?: number;
  createdAt: number;
}

/** 合成时已知的真实结构 */
export interface AnalysisGroundTruth {
  /** 人声进入位置（秒） */
  vocalEntry: number;
  /** 淡出起点（秒） */
  fadeStart: number;
  /** 节拍位置（秒） */
  beats: number[];
  /** BPM */
  bpm: number;
}

/** 曲库分析结果 */
export interface AnalysisResult {
  /** 前奏结束 / 人声进入点（秒） */
  vocalEntry: number;
  /** 结尾淡出起点（秒） */
  fadeStart: number;
  /** 检测到的节拍时刻（秒） */
  beats: number[];
  bpm: number;
  /** 前奏可叠入区间长度（秒）：0 ~ vocalEntry */
  introLength: number;
  /** 结尾可叠出区间长度（秒）：fadeStart ~ duration */
  outroLength: number;
  /** 平均能量，用于垫乐挑选 */
  loudness: number;
  /** 与真实标记的误差（演示核验用，无 groundTruth 时为 undefined） */
  errors?: AnalysisErrors;
}

export interface AnalysisErrors {
  vocalEntryErrMs: number;
  fadeStartErrMs: number;
  bpmErrPct: number;
}

/** 播出单条目类型 */
export type ItemType = 'song' | 'ad' | 'bed' | 'news' | 'pips' | 'gap';

/** 编排后的播出条目 */
export interface ScheduleItem {
  uid: string;
  type: ItemType;
  trackId?: string;
  title: string;
  /** 计划开始时间（虚拟时钟，毫秒 epoch） */
  startAt: number;
  /** 计划结束时间（毫秒 epoch） */
  endAt: number;
  /** 与上一条目的叠接时长（秒），0 表示硬切 */
  overlapIn: number;
  /** 与下一条目的叠接时长（秒） */
  overlapOut: number;
  /** 本条淡出被调整的秒数（正值=延后淡出，负值=提前） */
  fadeAdjustSec: number;
  /** 垫乐循环次数（bed 类型） */
  loopCount?: number;
  note?: string;
}

/** 整点块 */
export interface HourBlock {
  /** 整点时间（毫秒 epoch，整分整秒） */
  hourAt: number;
  /** 倒排填充的节目条目（不含报时本身） */
  items: ScheduleItem[];
  /** 报时条目 */
  pips: ScheduleItem;
  /** 倒排后剩余无法消化的空隙（秒） */
  residualGapSec: number;
}

/** 播出日志事件 */
export interface LogEvent {
  id: string;
  /** 事件时间（真实墙钟 ms） */
  wallTime: number;
  /** 事件时间（虚拟播出时钟 ms） */
  airTime: number;
  level: 'info' | 'warn' | 'error' | 'timing';
  kind: string;
  message: string;
  detail?: Record<string, number | string | boolean>;
}

/** 播放状态 */
export type PlayState = 'idle' | 'running' | 'paused' | 'interrupted';

/** 分析进度 */
export interface AnalysisProgress {
  done: number;
  total: number;
  failed: number;
  elapsedMs: number;
  etaMs: number;
  current: string;
}

/** 报时对齐核验结果 */
export interface PipsTimingReport {
  /** 报时第一声计划时间（虚拟时钟 ms） */
  scheduledAt: number;
  /** 整点（虚拟时钟 ms） */
  targetHourAt: number;
  /** 计划偏差 ms */
  plannedOffsetMs: number;
  /** 实际发声偏差 ms（onended/回调测量） */
  measuredOffsetMs?: number;
}
