// 编排器性质测试：人声零碰撞、节拍对齐、倒排锚点、淡出调整边界
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOverlap, planWindow, verifyNoVocalCollision, type Schedulable } from './scheduler.ts';
import type { TrackKind } from '../shared/types.ts';

let idSeq = 0;
function makeTrack(kind: TrackKind, duration: number, bpm: number, vocal: number, fade: number): Schedulable {
  idSeq++;
  return {
    id: `${kind}-${idSeq}`,
    title: `${kind}-${idSeq}`,
    kind,
    duration,
    bpm,
    vocalEntry: vocal,
    fadeStart: fade,
  };
}

const rng = (() => {
  let a = 1234567;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
})();

function librarySet() {
  const songs: Schedulable[] = [];
  for (let i = 0; i < 40; i++) {
    const bpm = 80 + (i % 5) * 12;
    // 曲目时长随测试窗口缩短，保证一个窗口能容纳多条
    const dur = 42 + (i % 7) * 6;
    songs.push(makeTrack('song', dur, bpm, 6 + (i % 4), dur - (8 + (i % 3) * 2)));
  }
  const ads = Array.from({ length: 8 }, () => makeTrack('ad', 20, 100, 0.5, 19));
  const beds = [makeTrack('bed', 24, 96, 2, 21), makeTrack('bed', 30, 88, 2, 27)];
  const news = Array.from({ length: 4 }, () => makeTrack('news', 30, 90, 0.5, 29));
  return { songs, ads, beds, news };
}

test('叠接时长不超过上一首淡出段与下一首前奏，且对齐整拍', () => {
  const a = makeTrack('song', 180, 120, 10, 168); // 尾段 12s，拍长 0.5s
  const b = makeTrack('song', 200, 100, 9, 185); // 前奏 9s，拍长 0.6s
  const ov = planOverlap(a, b);
  assert.ok(ov > 0, '应产生叠接');
  assert.ok(ov <= 12, '不得越过 a 的淡出段');
  assert.ok(ov <= 9, '不得越过 b 的人声进入点');
  const beatA = 60 / a.bpm;
  assert.ok(Math.abs(ov / beatA - Math.round(ov / beatA)) < 1e-9, '必须是 a 的整拍数');
});

test('前奏极短时不叠接（硬切）', () => {
  const a = makeTrack('song', 180, 120, 10, 168);
  const b = makeTrack('ad', 30, 120, 0.2, 29); // 前奏 0.2s < 最小叠接
  assert.equal(planOverlap(a, b), 0);
});

test('整窗倒排：最后一条恰好收在 endAt，报时锚点零偏差', () => {
  const lib = librarySet();
  const start = 0;
  const end = 300_000; // 300s 窗口（ms）
  const res = planWindow({ startAt: start, endAt: end, ...lib, rng });
  assert.ok(res.items.length > 3, `300s 窗口应容纳多条，实际 ${res.items.length}`);
  const last = res.items[res.items.length - 1];
  assert.equal(last.endAt, end, '最后一条结束时间必须等于报时起点');
  // 时间单调
  for (let i = 1; i < res.items.length; i++) {
    assert.ok(res.items[i].startAt >= res.items[i - 1].startAt);
  }
  // 无人声碰撞
  const lookup = new Map([...lib.songs, ...lib.ads, ...lib.beds, ...lib.news].map((t) => [t.id, t]));
  const bad = verifyNoVocalCollision(res.items, lookup);
  assert.equal(bad.length, 0, `人声碰撞: ${JSON.stringify(bad)}`);
  assert.equal(res.residualGapSec, 0, `残差应为 0，实际 ${res.residualGapSec}`);
});

test('叠接处人声区间严格不相交（不变量直接验证）', () => {
  const lib = librarySet();
  const res = planWindow({ startAt: 0, endAt: 600_000, ...lib, rng });
  const lookup = new Map([...lib.songs, ...lib.ads, ...lib.beds, ...lib.news].map((t) => [t.id, t]));
  for (let i = 0; i < res.items.length - 1; i++) {
    const a = res.items[i];
    const b = res.items[i + 1];
    const ta = lookup.get(a.trackId!)!;
    const tb = lookup.get(b.trackId!)!;
    if (ta.kind === 'bed' || tb.kind === 'bed') continue; // 垫乐无人声
    // b 的人声开始时刻必须不早于 a 的淡出开始时刻
    const bVocalAbs = b.startAt + tb.vocalEntry * 1000;
    const aFadeAbs = a.startAt + ta.fadeStart * 1000;
    assert.ok(bVocalAbs >= aFadeAbs - 1,
      `碰撞：bVocal=${bVocalAbs} aFade=${aFadeAbs} gap=${bVocalAbs - aFadeAbs}ms titles=${ta.title}/${tb.title} types=${ta.kind}/${tb.kind}`);
  }
});

test('残量处理：小残量用淡出调整（±6s 内），大残量用垫乐', () => {
  const lib = librarySet();
  // 取一个不容易被歌曲整除的窗口长度
  const res = planWindow({ startAt: 0, endAt: 423_000, ...lib, rng });
  for (const adj of res.fadeAdjustments) {
    assert.ok(Math.abs(adj.sec) <= 6.001, `淡出调整越界: ${adj.sec}`);
  }
  if (res.residualGapSec > 6) {
    assert.ok(res.bedsUsed.length > 0, '大残量必须由垫乐填充');
  }
  assert.ok(res.residualGapSec < 0.05, `残差应收敛到亚秒级，实际 ${res.residualGapSec}`);
});

test('窗口短于任何单曲：提前淡出截断且不越界', () => {
  const songs = [makeTrack('song', 180, 100, 10, 168)];
  const res = planWindow({
    startAt: 0, endAt: 60_000, // 60s 窗口
    songs, ads: [], beds: [], news: [], rng,
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].endAt, 60_000);
  assert.ok(res.fadeAdjustments[0].sec < 0, '应提前淡出');
  assert.equal(res.items[0].endAt - res.items[0].startAt, 60_000, '条目精确占满窗口');
});

test('插播重排：锚点不变且无人声碰撞（planWindow 等价重排）', () => {
  const lib = librarySet();
  const hourAt = 900_000;
  const first = planWindow({ startAt: hourAt - 300_000, endAt: hourAt, ...lib, rng });
  // 锚点取中间某条的结束时刻（排除最后一条，保证重排窗口非零）
  const midIdx = Math.min(first.items.length - 2, Math.max(0, Math.floor(first.items.length / 2)));
  const nowMs = first.items[midIdx].endAt;
  assert.ok(nowMs < hourAt, '锚点必须早于整点');
  const keep = first.items.filter((it) => it.endAt <= nowMs);
  const second = planWindow({ startAt: nowMs, endAt: hourAt, ...lib, rng });
  const merged = [...keep, ...second.items];
  const lookup = new Map([...lib.songs, ...lib.ads, ...lib.beds, ...lib.news].map((t) => [t.id, t]));
  assert.equal(verifyNoVocalCollision(merged, lookup).length, 0);
  assert.equal(merged[merged.length - 1].endAt, hourAt, '重排后报时锚点保持不变');
});
