// 曲库分析视图
import { library } from '../state/library';
import { $, el, fmtSec } from './dom';

export function initLibraryView(): void {
  const tbody = $('#lib-table tbody');
  const summary = $('#lib-summary');
  const stats = $('#lib-stats');
  const wrap = $('#progress-wrap');
  const bar = $('#progress-bar');
  const meta = $('#progress-meta');

  function render(): void {
    const tracks = library.tracks;
    summary.textContent = tracks.length
      ? `曲库共 ${tracks.length} 条（PCM 缓存策略：演示素材内存缓存，压测素材按需重合成）`
      : '尚未载入曲库';
    const analyzed = tracks.filter((t) => t.analysis);
    // 人声进入/淡出指标只对有前奏结构的歌曲有意义；广告/新闻 groundTruth 为 0，不纳入统计
    const songErr = tracks
      .filter((t) => t.kind === 'song' && t.analysis?.errors)
      .map((t) => t.analysis!.errors!);
    const avgVocal = songErr.length ? Math.round(songErr.reduce((a, e) => a + e.vocalEntryErrMs, 0) / songErr.length) : 0;
    const avgFade = songErr.length ? Math.round(songErr.reduce((a, e) => a + e.fadeStartErrMs, 0) / songErr.length) : 0;
    const allErr = analyzed.flatMap((t) => (t.analysis?.errors ? [t.analysis.errors] : []));
    const avgBpm = allErr.length ? (allErr.reduce((a, e) => a + e.bpmErrPct, 0) / allErr.length).toFixed(2) : '0';
    const byKind = (k: string) => tracks.filter((t) => t.kind === k).length;
    stats.innerHTML = '';
    const cards: [string, string][] = [
      ['素材总数', String(tracks.length)],
      ['已分析', String(analyzed.length)],
      ['歌曲 / 广告 / 垫乐 / 新闻', `${byKind('song')} / ${byKind('ad')} / ${byKind('bed')} / ${byKind('news')}`],
      ['人声进入平均误差', `${avgVocal} ms`],
      ['淡出起点平均误差', `${avgFade} ms`],
      ['BPM 平均误差', `${avgBpm} %`],
      ['上次批量耗时', library.lastRunMs ? `${(library.lastRunMs / 1000).toFixed(2)} s` : '—'],
    ];
    for (const [label, value] of cards) stats.appendChild(el('div', `<label>${label}</label><strong>${value}</strong>`, 'stat'));

    const p = library.progress;
    if (library.busy) {
      wrap.hidden = false;
      bar.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
      meta.textContent = `${p.done}/${p.total}　失败 ${p.failed}　已用 ${(p.elapsedMs / 1000).toFixed(1)}s　预计剩余 ${(p.etaMs / 1000).toFixed(1)}s　当前：${p.current}`;
    } else if (p.done > 0) {
      wrap.hidden = false;
      bar.style.width = '100%';
      meta.textContent = `完成 ${p.done}/${p.total}，总耗时 ${(p.elapsedMs / 1000).toFixed(2)}s（失败 ${p.failed}）`;
    } else {
      wrap.hidden = true;
    }

    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    tracks.slice(0, 500).forEach((t, i) => {
      const a = t.analysis;
      const e = a?.errors;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${t.title}</td>
        <td><span class="tag ${t.kind}">${t.kind}</span></td>
        <td>${t.style}</td>
        <td>${fmtSec(t.duration)}</td>
        <td>${a ? a.bpm.toFixed(1) : '—'}</td>
        <td>${a ? a.vocalEntry.toFixed(2) + 's' : '—'}</td>
        <td>${a ? a.fadeStart.toFixed(2) + 's' : '—'}</td>
        <td>${a ? `${a.introLength.toFixed(1)} / ${a.outroLength.toFixed(1)}s` : '—'}</td>
        <td class="${e && e.vocalEntryErrMs <= 150 ? 'ok' : 'bad'}">${e ? e.vocalEntryErrMs + ' ms' : '—'}</td>
        <td class="${e && e.fadeStartErrMs <= 250 ? 'ok' : 'bad'}">${e ? e.fadeStartErrMs + ' ms' : '—'}</td>
        <td class="${e && e.bpmErrPct <= 3 ? 'ok' : 'bad'}">${e ? e.bpmErrPct + ' %' : '—'}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    if (tracks.length > 500) {
      tbody.appendChild(el('tr', `<td colspan="12" class="hint">仅显示前 500 条，共 ${tracks.length} 条（统计口径为全量）</td>`));
    }
  }

  library.subscribe(render);
  render();

  $('#btn-gen-demo').addEventListener('click', () => {
    void library.generate({ songs: 24, ads: 5, beds: 4, news: 3, bulk: false });
  });
  // E2E 测试入口：小规模曲库，缩短自动化验证耗时
  window.addEventListener('e2e-gen', ((ev: Event) => {
    const d = (ev as CustomEvent<{ songs: number; ads: number; beds: number; news: number; bulk?: boolean }>).detail;
    void library.generate({ songs: d.songs, ads: d.ads, beds: d.beds, news: d.news, bulk: !!d.bulk });
  }) as EventListener);
  $('#btn-gen-bulk').addEventListener('click', () => {
    if (!window.confirm('将合成并分析 10,000 条短素材（不缓存 PCM），预计数分钟。继续？')) return;
    void library.generate({ songs: 9000, ads: 600, beds: 250, news: 150, bulk: true, totalTarget: 10000 });
  });
  $('#btn-reanalyze').addEventListener('click', () => {
    void library.reanalyzeAll().then((r) => {
      if (r.count === 0) window.alert('曲库为空或正在运行');
    });
  });
  $('#btn-reset').addEventListener('click', () => {
    if (window.confirm('确定清空全部曲库元数据？')) void library.reset();
  });
}
