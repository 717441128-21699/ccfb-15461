// 入口：标签页、顶栏时钟、各视图初始化
import './style.css';
import { $ } from './ui/dom';
import { initLibraryView } from './ui/libraryView';
import { initScheduleView } from './ui/scheduleView';
import { initMonitorView } from './ui/monitorView';
import { initLogView } from './ui/logView';
import { initSelfTest } from './ui/selfTest';
import { library } from './state/library';
import { standardNow } from './scheduler/clock';
import { appState } from './state/app';

function pad(n: number, l = 2): string {
  return String(n).padStart(l, '0');
}
function hms(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function startClocks(): void {
  const std = $('#std-clock');
  const air = $('#air-clock');
  window.setInterval(() => {
    std.textContent = hms(standardNow());
    air.textContent = appState.hourAtMs
      ? hms(Math.min(standardNow(), appState.hourAtMs + 10000))
      : '待开播';
  }, 100);
}

async function main(): Promise<void> {
  initTabs();
  startClocks();
  await library.init();
  initLibraryView();
  initScheduleView();
  initMonitorView();
  initLogView();
  initSelfTest();
}

void main();
