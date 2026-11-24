// 播出单编排视图
import { buildHour } from '../state/schedule';
import { appState } from '../state/app';
import { library } from '../state/library';
import { $, el, fmtOffset } from './dom';
import type { ScheduleItem } from '../shared/types';

function renderSchedule(): void {
  const built = appState.built;
  const summary = $('#sch-summary');
  const timeline = $('#timeline');
  const tbody = $('#sch-table tbody');
  summary.innerHTML = '';
  timeline.innerHTML = '';
  tbody.innerHTML = '';
  if (!built) return;

  const total = built.block.items.length;
  const collisions = built.collisions.length;
  const cards: [string, string, string?][] = [
    ['编排条目', String(total)],
    ['总叠接时长', `${built.totalOverlapSec.toFixed(1)} s`],
    ['垫乐填充', `${built.bedsUsed.length} 处`],
    ['人声碰撞', collisions === 0 ? '0（合格）' : String(collisions), collisions === 0 ? 'ok' : 'bad'],
    ['倒排残差', `${built.block.residualGapSec.toFixed(2)} s`, built.block.residualGapSec < 0.05 ? 'ok' : 'warn-text'],
    ['报时锚点', new Date(built.block.hourAt).toLocaleTimeString()],
  ];
  for (const [label, value, cls] of cards) {
    summary.appendChild(el('div', `<label>${label}</label><strong class="${cls ?? ''}">${value}</strong>`, 'stat'));
  }

  const hourAt = built.block.hourAt;
  const startAt = hourAt - appState.hourLengthSec * 1000;
  const span = hourAt - startAt;
  const all = [...built.block.items, built.block.pips];
  for (const it of all) {
    const w = ((it.endAt - it.startAt) / span) * 100;
    const seg = el('div', it.type === 'pips' ? '报时' : String(Math.round(w)), `tl-seg tl-${it.type}`);
    seg.style.width = `${Math.max(0.6, w)}%`;
    seg.title = `${it.title}　${fmtOffset(it.startAt, hourAt)} → ${fmtOffset(it.endAt, hourAt)}`;
    timeline.appendChild(seg);
  }

  all.forEach((it: ScheduleItem, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="tag ${it.type}">${it.type}</span></td>
      <td>${it.title}</td>
      <td>${fmtOffset(it.startAt, hourAt)}</td>
      <td>${fmtOffset(it.endAt, hourAt)}</td>
      <td>${it.overlapIn.toFixed(2)}</td>
      <td>${it.overlapOut.toFixed(2)}</td>
      <td class="${it.fadeAdjustSec ? 'warn-text' : ''}">${it.fadeAdjustSec.toFixed(2)}</td>
      <td>${it.loopCount ?? '—'}</td>
      <td class="hint">${it.note ?? (it.overlapOut > 0 ? '节拍对齐叠接' : '')}</td>`;
    tbody.appendChild(tr);
  });
  $('#sch-hint').textContent = collisions === 0
    ? '核验通过：所有叠接均落在「上一首淡出段 × 下一首前奏」内，人声零碰撞'
    : `发现 ${collisions} 处人声碰撞！`;
}

export function initScheduleView(): void {
  $('#btn-build').addEventListener('click', () => {
    try {
      appState.hourLengthSec = Number(($('#hour-length') as HTMLSelectElement).value);
      const adEvery = Number(($('#ad-every') as HTMLInputElement).value) || 4;
      // 虚拟整点：取下一个整分钟作为锚点，保证演示可复现
      const now = Date.now();
      const hourAt = Math.ceil(now / 60000) * 60000 + 30000;
      appState.hourAtMs = hourAt;
      appState.startAtMs = hourAt - appState.hourLengthSec * 1000;
      appState.built = buildHour(hourAt, { hourLengthSec: appState.hourLengthSec, adEvery });
      appState.interrupts = 0;
      appState.underruns = 0;
      renderSchedule();
      $('#mon-hint').textContent = '编排完成，可到「播出监视」开播';
    } catch (err) {
      window.alert((err as Error).message);
    }
  });
  library.subscribe(() => {
    if (appState.built) renderSchedule();
  });
  // 暴露给 monitor 视图重排后刷新
  (window as unknown as { __renderSchedule: () => void }).__renderSchedule = renderSchedule;
  renderSchedule();
}
