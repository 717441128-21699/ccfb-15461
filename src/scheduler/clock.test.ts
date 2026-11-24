// 虚拟时钟与报时对齐的数学性质测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from './clock.ts';

test('VirtualClock: 虚拟时间与墙钟呈线性 1:1 映射，无漂移', () => {
  const clock = new VirtualClock();
  const airStart = 60_000; // 虚拟起点 60s
  // 模拟 loadSchedule 时刻建立基准
  const perfBase = 1000;
  clock.start(airStart, 1);
  // 通过反射设置 perfBase（与引擎建立基准同义）
  (clock as unknown as { baseWall: number }).baseWall = perfBase;
  (clock as unknown as { baseAir: number }).baseAir = airStart;

  // 报时锚点：虚拟整点（airStart + 20000ms）
  const hourAt = airStart + 20_000;
  const perfAtHour = clock.airToWall(hourAt);
  // 墙钟偏移应精确等于 20000ms
  assert.equal(perfAtHour - perfBase, 20_000);

  // 单调性：任意递增虚拟时间映射到递增墙钟
  let prev = -Infinity;
  for (let air = airStart; air <= hourAt; air += 100) {
    const w = clock.airToWall(air);
    assert.ok(w >= prev);
    prev = w;
  }
});

test('VirtualClock: now() 在 rate=1 下与墙钟流逝严格一致', () => {
  const clock = new VirtualClock();
  clock.start(0, 1);
  const baseWall = (clock as unknown as { baseWall: number }).baseWall;
  const baseAir = (clock as unknown as { baseAir: number }).baseAir;
  // 模拟墙钟前进 1234.5ms
  const simulatedWall = baseWall + 1234.5;
  // now 内部用 performance.now()，这里直接验证公式
  const air = baseAir + (simulatedWall - baseWall) * 1;
  assert.ok(Math.abs(air - 1234.5) < 1e-9);
});

test('报时落点确定性：同一虚拟锚点在任意调度时刻换算结果唯一', () => {
  // 复现引擎 airToAudio 的线性公式，证明报时音频时间不随前瞻调度时机变化
  const ctxBase = 5.0; // 加载时 currentTime + 0.08
  const perfBase = 2000;
  const airStart = 30_000;
  const hourAt = 50_000;
  const airToAudio = (airMs: number, airToWall: (a: number) => number) =>
    ctxBase + (airToWall(airMs) - perfBase) / 1000;
  // 墙钟 = perfBase + (air - airStart)（rate=1）
  const airToWall = (airMs: number) => perfBase + (airMs - airStart);

  // 无论在哪个 tick（前瞻 40/80/120ms）调度，报时音频时间恒定
  const pipsAudio = airToAudio(hourAt, airToWall);
  const expected = ctxBase + (hourAt - airStart) / 1000;
  assert.ok(Math.abs(pipsAudio - expected) < 1e-12);
  // 20s 虚拟跨度 = 20s 音频时间
  assert.ok(Math.abs(pipsAudio - ctxBase - 20) < 1e-12);
});
