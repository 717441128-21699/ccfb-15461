// 应用级共享状态
import type { BuiltHour } from './schedule';

export const appState: {
  built: BuiltHour | null;
  /** 宏小时长度（秒） */
  hourLengthSec: number;
  /** 整点虚拟时间（ms epoch） */
  hourAtMs: number;
  /** 播出起点（ms epoch） */
  startAtMs: number;
  /** 已插播次数 */
  interrupts: number;
  underruns: number;
} = {
  built: null,
  hourLengthSec: 300,
  hourAtMs: 0,
  startAtMs: 0,
  interrupts: 0,
  underruns: 0,
};
