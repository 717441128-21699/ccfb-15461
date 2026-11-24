// 虚拟播出时钟：以 performance.now 为时间基，映射到虚拟播出时间（air time）
// 标准时间模拟：wallNow() 返回 Date.now 加可配置 NTP 偏移（模拟校时后的标准时间）

export class VirtualClock {
  private baseWall = 0;
  private baseAir = 0;
  private rate = 1;
  private running = false;

  start(airStartMs: number, rate = 1): void {
    this.baseWall = performance.now();
    this.baseAir = airStartMs;
    this.rate = rate;
    this.running = true;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 当前虚拟播出时间（ms epoch） */
  now(): number {
    if (!this.running) return this.baseAir;
    return this.baseAir + (performance.now() - this.baseWall) * this.rate;
  }

  /** 虚拟时间 -> 预计墙钟时刻（performance.now 域） */
  airToWall(airMs: number): number {
    return this.baseWall + (airMs - this.baseAir) / this.rate;
  }

  /** 墙钟 performance.now -> 虚拟时间 */
  wallToAir(wallMs: number): number {
    return this.baseAir + (wallMs - this.baseWall) * this.rate;
  }
}

let ntpOffsetMs = 0;

/** 模拟经 NTP 校时后的标准时间 */
export function setNtpOffset(ms: number): void {
  ntpOffsetMs = ms;
}

export function standardNow(): number {
  return Date.now() + ntpOffsetMs;
}
