// 播出日志视图
import { logs } from '../state/logs';
import { $, download, el, fmtClock } from './dom';

export function initLogView(): void {
  const tbody = $('#log-table tbody');
  const levelSel = $('#log-level') as HTMLSelectElement;

  function render(): void {
    const level = levelSel.value;
    const all = logs.all().filter((e) => !level || e.level === level);
    $('#log-count').textContent = `共 ${all.length} 条（缓冲上限 2000）`;
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of all.slice(-400).reverse()) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', fmtClock(e.wallTime)));
      tr.appendChild(el('td', fmtClock(e.airTime)));
      tr.appendChild(el('td', `<span class="lvl-${e.level}">${e.level}</span>`));
      tr.appendChild(el('td', e.kind));
      const detailHtml = e.detail ? ` <span class="hint">${JSON.stringify(e.detail)}</span>` : '';
      tr.appendChild(el('td', e.message + detailHtml));
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  logs.subscribe(render);
  levelSel.addEventListener('change', render);
  $('#btn-export-csv').addEventListener('click', () => {
    download(`broadcast-log-${Date.now()}.csv`, logs.toCSV());
  });
  $('#btn-clear-log').addEventListener('click', () => logs.clear());
  render();
}
