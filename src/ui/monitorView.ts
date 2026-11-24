// 播出监视视图：引擎装配、开播/停止、临时插播重排、报时对齐核验
import { PlaybackEngine, type EngineItem, type MonitorState } from '../audio/engine';
import { library } from '../state/library';
import { appState } from '../state/app';
import { replanAfterInterrupt } from '../state/schedule';
import { logs } from '../state/logs';
import { $, fmtClock, fmtOffset } from './dom';
import type { HourBlock, ScheduleItem } from '../shared/types';
import type { PCM } from '../audio/dsp';

let engine: PlaybackEngine | null = null;
let monState: MonitorState | null = null;

async function materialize(block: HourBlock): Promise<EngineItem[]> {
  const pipsPCM = await library.ensurePips();
  const items: EngineItem[] = [];
  for (const it of block.items) {
    if (!it.trackId) continue;
    const track = library.byId.get(it.trackId);
    if (!track) continue;
    const pcm: PCM = await library.regeneratePCM(track);
    items.push({
      uid: it.uid,
      trackId: track.id,
      type: it.type,
      title: it.title,
      pcm,
      startAtAir: it.startAt,
      endAtAir: it.endAt,
      fadeAdjustSec: it.fadeAdjustSec,
      naturalFadeStart: track.analysis?.fadeStart ?? track.duration - 4,
      isBed: it.type === 'bed',
    });
  }
  items.push({
    uid: block.pips.uid,
    type: 'pips',
    title: block.pips.title,
    pcm: pipsPCM,
    startAtAir: block.pips.startAt,
    endAtAir: block.pips.endAt,
    fadeAdjustSec: 0,
    naturalFadeStart: 0,
    isBed: false,
  });
  return items;
}

function renderMonTable(): void {
  const built = appState.built;
  const tbody = $('#mon-table tbody');
  tbody.innerHTML = '';
  if (!built) return;
  const all = [...built.block.items, built.block.pips];
  const now = engine?.virtualNow ?? 0;
  all.forEach((it: ScheduleItem) => {
    const status = now > 0 && now >= it.endAt ? 'done' : now > 0 && now >= it.startAt ? 'live' : 'queued';
    const text = status === 'live' ? '播出中' : status === 'done' ? '已结束' : '待播';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot ${status}"></span>${text}</td>
      <td><span class="tag ${it.type}">${it.type}</span></td>
      <td>${it.title}</td>
      <td>${fmtOffset(it.startAt, built.block.hourAt)}</td>
      <td>${fmtOffset(it.endAt, built.block.hourAt)}</td>
      <td>${it.overlapIn > 0 ? `叠入 ${it.overlapIn.toFixed(2)}s` : '—'}</td>`;
    tbody.appendChild(tr);
  });
}

export function initMonitorView(): void {
  engine = new PlaybackEngine({
    onLog: (ev) => {
      logs.add(ev, engine?.virtualNow ?? Date.now());
      if (ev.kind === 'engine.underrun') {
        appState.underruns++;
        $('#mon-underrun').textContent = `${appState.underruns} 次`;
      }
    },
    onItemStart: () => renderMonTable(),
    onItemEnd: () => renderMonTable(),
    onPips: (report) => {
      const m = report.measuredOffsetMs ?? 0;
      const elM = $('#mon-measured');
      elM.textContent = `${m} ms`;
      elM.className = Math.abs(m) <= 100 ? 'ok' : 'bad';
    },
    onState: (s) => {
      monState = s;
      $('#mon-current').textContent = s.currentTitle;
      $('#mon-next').textContent = s.nextTitle;
      $('#meter-bar').style.width = `${Math.min(100, s.level * 130)}%`;
      if (s.pipsInMs > 0) {
        $('#mon-pips-in').textContent = `${(s.pipsInMs / 1000).toFixed(2)} s`;
      }
    },
  });

  $('#btn-play').addEventListener('click', () => {
    void (async () => {
      if (!appState.built) {
        window.alert('请先在「播出单编排」生成播出单');
        return;
      }
      const block = appState.built.block;
      const collisionText = $('#mon-collision');
      collisionText.textContent = appState.built.collisions.length === 0
        ? '0 处（合格）' : `${appState.built.collisions.length} 处`;
      collisionText.className = appState.built.collisions.length === 0 ? 'ok' : 'bad';
      $('#mon-count').textContent = String(block.items.length + 1);
      $('#mon-planned').textContent = '0 ms（编排即锚定）';
      $('#mon-planned').className = 'ok';
      const engineItems = await materialize(block);
      await engine!.loadSchedule(engineItems, appState.startAtMs, appState.hourAtMs);
      logs.add({ level: 'info', kind: 'air.start', message: '开播' }, appState.startAtMs);
      $('#mon-hint').textContent = '播出中…';
      renderMonTable();
    })();
  });

  $('#btn-stop').addEventListener('click', () => {
    engine?.stop();
    $('#mon-hint').textContent = '已停止';
  });

  $('#btn-interrupt').addEventListener('click', () => {
    if (!appState.built || !engine?.isRunning) {
      window.alert('请先开播后再插播');
      return;
    }
    const now = engine.virtualNow;
    const { block, collisions } = replanAfterInterrupt(
      appState.built.block, now, appState.hourLengthSec,
    );
    appState.built = { ...appState.built, block, collisions };
    appState.interrupts++;
    void materialize(block).then((items) => {
      const upcoming = items.filter((it) => it.endAtAir > now);
      engine!.replaceUpcoming(upcoming);
      logs.add({
        level: 'warn',
        kind: 'news.interrupt',
        message: `临时插播新闻，后续 ${upcoming.length} 条自动重排（第 ${appState.interrupts} 次）`,
        detail: { atAir: fmtClock(now), count: upcoming.length },
      }, now);
      $('#mon-hint').textContent = `已插播 ${appState.interrupts} 次，后续单子已重排，报时锚点不变`;
      (window as unknown as { __renderSchedule?: () => void }).__renderSchedule?.();
      renderMonTable();
    });
  });

  // 周期刷新监视表与倒计时
  window.setInterval(() => {
    if (engine?.isRunning) {
      renderMonTable();
      const s = monState;
      if (s) {
        const remain = appState.hourAtMs - engine.virtualNow;
        $('#mon-pips-in').textContent = remain > 0 ? `${(remain / 1000).toFixed(2)} s` : '已报时';
      }
    }
  }, 500);
}
