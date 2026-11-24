// 浏览器内自测：合成素材 -> DSP 分析 -> 核对误差（替代 Node 无法运行的 Web Audio 用例）
import { synthesize } from '../audio/synth';
import { analyzePCM } from '../audio/analyzer';
import { $ } from './dom';
import type { StyleId, TrackKind } from '../shared/types';

const STYLES: StyleId[] = ['pop', 'rock', 'folk', 'electronic', 'classical'];

interface Row {
  caseName: string;
  vocalErrMs: number;
  fadeErrMs: number;
  bpmErrPct: number;
  beats: number;
  ok: boolean;
  detail: string;
}

export async function runSelfTest(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const style of STYLES) {
    const synth = await synthesize({ seed: style.length * 999 + 7, style, kind: 'song' as TrackKind, durationSec: 60 });
    const r = analyzePCM(synth.pcm, synth.groundTruth);
    const e = r.errors!;
    rows.push({
      caseName: `歌曲·${style}`,
      vocalErrMs: e.vocalEntryErrMs,
      fadeErrMs: e.fadeStartErrMs,
      bpmErrPct: e.bpmErrPct,
      beats: r.beats.length,
      ok: e.vocalEntryErrMs <= 200 && e.fadeStartErrMs <= 400 && e.bpmErrPct <= 3,
      detail: `真值 人声${synth.groundTruth.vocalEntry.toFixed(2)}s / 淡出${synth.groundTruth.fadeStart.toFixed(2)}s / ${synth.groundTruth.bpm.toFixed(1)}BPM`,
    });
  }
  const ad = await synthesize({ seed: 4242, style: 'pop', kind: 'ad', durationSec: 30 });
  const adR = analyzePCM(ad.pcm, ad.groundTruth);
  rows.push({
    caseName: '广告·无前奏',
    vocalErrMs: adR.errors!.vocalEntryErrMs,
    fadeErrMs: adR.errors!.fadeStartErrMs,
    bpmErrPct: adR.errors!.bpmErrPct,
    beats: adR.beats.length,
    ok: adR.vocalEntry < 1.5,
    detail: `检测人声进入 ${adR.vocalEntry.toFixed(2)}s（应 <1.5s）`,
  });
  return rows;
}

export function initSelfTest(): void {
  const btn = $('#btn-selftest');
  const out = $('#selftest-out');
  btn.addEventListener('click', () => {
    out.innerHTML = '<span class="hint">合成并分析中…（五种风格各 60s）</span>';
    void runSelfTest().then((rows) => {
      const allOk = rows.every((r) => r.ok);
      out.innerHTML = `
        <p><strong class="${allOk ? 'ok' : 'bad'}">${allOk ? '✔ 全部用例通过' : '✖ 有用例未达标'}</strong>
        （容差：人声 200ms / 淡出 400ms / BPM 3%）</p>
        <table><thead><tr><th>用例</th><th>人声误差</th><th>淡出误差</th><th>BPM 误差</th><th>节拍数</th><th>明细</th><th>结论</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${r.caseName}</td>
          <td class="${r.vocalErrMs <= 200 ? 'ok' : 'bad'}">${r.vocalErrMs} ms</td>
          <td class="${r.fadeErrMs <= 400 ? 'ok' : 'bad'}">${r.fadeErrMs} ms</td>
          <td class="${r.bpmErrPct <= 3 ? 'ok' : 'bad'}">${r.bpmErrPct} %</td>
          <td>${r.beats}</td>
          <td class="hint">${r.detail}</td>
          <td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '通过' : '失败'}</td>
        </tr>`).join('')}</tbody></table>`;
    });
  });
}
