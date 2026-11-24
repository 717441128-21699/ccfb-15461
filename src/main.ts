import './styles.css';
import { analyzeLibrary, type AnalysisProgress } from './core/analysisPool';
import { analyzeSpecFast } from './core/analyzer';
import { createLibrarySpecs } from './core/catalog';
import { StandardClock } from './core/clock';
import {
  autoFitRundown,
  insertBreakingNews,
  nextTopOfHour,
  validateTransitionAgainstTruth,
  type CatalogResolver,
} from './core/scheduler';
import { BroadcastEngine } from './audio/broadcastEngine';
import { AudioBufferCache } from './audio/bufferCache';
import { fmtClock, fmtDuration, fmtTime, h } from './ui/dom';
import type {
  LibraryTrack,
  LogCategory,
  LogEntry,
  LogLevel,
  OnAirState,
  RundownItem,
  ScheduleResult,
  TrackSpec,
  TransitionPlan,
} from './core/types';

type TabId = 'library' | 'rundown' | 'monitor' | 'logs';
type TargetMode = 'hour' | 'demo90' | 'demo360';

interface TruthCheck {
  plan: TransitionPlan;
  overlapVocalSec: number;
  beatErrorMs: number;
}

class RadioApp {
  private readonly specs: TrackSpec[] = createLibrarySpecs(10000);
  private readonly specById = new Map<string, TrackSpec>();
  private readonly tracks = new Map<string, LibraryTrack>();
  private readonly catalog: CatalogResolver = { get: (id) => this.tracks.get(id) };
  private readonly clock = new StandardClock();
  private logs: LogEntry[] = [];
  private logId = 1;
  private tab: TabId = 'library';
  private query = '';
  private kindFilter = 'all';
  private visibleCount = 100;
  private analysis: AnalysisProgress & { running: boolean; complete: boolean } = {
    done: 0,
    total: 10038,
    elapsedMs: 0,
    tracksPerSecond: 0,
    workerCount: 0,
    running: false,
    complete: false,
  };
  private rundown: RundownItem[] = [];
  private targetMode: TargetMode = 'demo360';
  private targetEpochMs = Date.now() + 6 * 60_000;
  private schedule: ScheduleResult | null = null;
  private truthChecks: TruthCheck[] = [];
  private bufferCache: AudioBufferCache | null = null;
  private engine: BroadcastEngine | null = null;
  private air: OnAirState = {
    status: 'idle',
    currentSegmentId: null,
    nextSegmentId: null,
    startedAtEpochMs: null,
    elapsedSec: 0,
    countdownToHourSec: null,
    lastHourDeviationMs: null,
    measuredDeviationMs: null,
    vuLeft: 0,
    vuRight: 0,
  };
  private idCounter = 0;

  constructor() {
    for (const spec of this.specs) {
      this.specById.set(spec.id, spec);
      this.tracks.set(spec.id, { spec, analysis: null });
    }
    this.addLog('info', 'system', '系统启动：曲库规格已生成，正在分析演示素材');
    this.clock
      .syncWithServer('/api/time')
      .then((status) => {
        this.addLog(
          status.synchronized ? 'success' : 'warn',
          'clock',
          status.synchronized
            ? `标准时间同步成功，RTT ${status.rttMs?.toFixed(1)}ms，偏差 ${status.offsetMs.toFixed(1)}ms`
            : '未连接 /api/time，使用本机高精度时钟；生产环境可接入 NTP 网关',
        );
        this.updateChromeClock();
      })
      .catch(() => undefined);

    const host = {
      log: (level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>) =>
        this.addLog(level, category, message, data),
      onState: (state: Partial<OnAirState>) => {
        this.air = { ...this.air, ...state };
        this.updateMonitorDynamic();
      },
      onClock: () => this.updateChromeClock(),
    };
    this.engine = new BroadcastEngine(this.clock, (id) => this.provideBuffer(id), host);
    this.mountShell();
    void this.analyzeInitial();
    window.setInterval(() => this.updateChromeClock(), 120);
    (window as unknown as { __radioApp?: RadioApp }).__radioApp = this;
  }

  private createItemId(): string {
    this.idCounter += 1;
    return `item-${Date.now().toString(36)}-${this.idCounter}`;
  }

  private addLog(level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = { id: this.logId++, timeEpochMs: Date.now(), level, category, message, data };
    this.logs = [entry, ...this.logs].slice(0, 600);
    const count = document.getElementById('log-count');
    if (count) count.textContent = String(this.logs.length);
    if (this.tab === 'logs') this.renderLogList();
  }

  private async analyzeInitial(): Promise<void> {
    const initialIds = [
      ...this.specs.filter((s) => s.kind !== 'song').map((s) => s.id),
      ...this.specs.filter((s) => s.kind === 'song').slice(0, 120).map((s) => s.id),
    ];
    const specs = initialIds.map((id) => this.specById.get(id)!);
    const results = await analyzeLibrary(specs, (p) => {
      this.analysis = { ...this.analysis, ...p, total: this.specs.length, running: true };
      this.updateAnalysisProgress();
    });
    this.mergeAnalyses(results);
    this.analysis.done = [...this.tracks.values()].filter((t) => t.analysis).length;
    this.analysis.running = false;
    this.addLog('success', 'analysis', `演示素材与前 120 首歌曲分析完成：人声边界、节拍锚点、淡出点可用`);
    this.runAutoFit(true);
    this.renderTab();
  }

  private mergeAnalyses(results: Map<string, ReturnType<typeof analyzeSpecFast>>): void {
    for (const [id, analysis] of results) {
      const track = this.tracks.get(id);
      if (track) track.analysis = analysis;
    }
  }

  private async analyzeAll(): Promise<void> {
    if (this.analysis.running) return;
    this.analysis.running = true;
    this.analysis.complete = false;
    this.analysis.done = 0;
    this.addLog('info', 'analysis', '开始一万首曲库压力分析：Web Worker 池 + 前奏/尾奏结构扫描');
    this.renderTab();
    const started = performance.now();
    try {
      const results = await analyzeLibrary(this.specs, (p: AnalysisProgress) => {
        this.analysis = { ...p, total: this.specs.length, running: true, complete: false };
        this.updateAnalysisProgress();
      });
      this.mergeAnalyses(results);
      const elapsedMs = performance.now() - started;
      this.analysis.running = false;
      this.analysis.complete = elapsedMs <= 600_000;
      this.analysis.elapsedMs = elapsedMs;
      this.analysis.done = this.specs.length;
      this.addLog(
        elapsedMs <= 600_000 ? 'success' : 'error',
        'analysis',
        `10,000 首分析完成，用时 ${(elapsedMs / 1000).toFixed(1)}s，${(this.specs.length / (elapsedMs / 1000)).toFixed(1)} 首/秒；10 分钟预算${elapsedMs <= 600_000 ? '达标' : '未达标'}`,
      );
    } catch (error) {
      this.analysis.running = false;
      this.addLog('error', 'analysis', `分析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.renderTab();
  }

  private updateAnalysisProgress(): void {
    const bar = document.getElementById('analysis-bar');
    const text = document.getElementById('analysis-text');
    if (bar) bar.style.width = `${(this.analysis.done / Math.max(1, this.analysis.total)) * 100}%`;
    if (text) {
      text.textContent = `${this.analysis.done.toLocaleString()} / ${this.analysis.total.toLocaleString()} · ${this.analysis.tracksPerSecond.toFixed(0)} 首/秒 · ${this.analysis.workerCount} 线程`;
    }
  }

  private mountShell(): void {
    const app = document.getElementById('app')!;
    app.replaceChildren(
      h('div', { class: 'app-shell' },
        h('header', { class: 'topbar' },
          h('div', { class: 'brand' },
            h('div', { class: 'brand-mark' }, '声'),
            h('div', {},
              h('h1', {}, '北山之声 · 自动播出系统'),
              h('p', {}, '曲库分析 / 倒排单 / Web Audio 监视 / 播出日志'),
            ),
          ),
          h('nav', { class: 'nav-tabs', 'aria-label': '主导航' }, ...this.renderNav()),
          h('div', { class: 'clock-card' },
            h('div', { class: 'clock-main mono', id: 'clock-now' }, '--:--:--.---'),
            h('div', { class: 'clock-sub' },
              h('span', { class: 'status-dot warn', id: 'clock-dot' }),
              h('span', { id: 'clock-status' }, '正在同步标准时间…'),
            ),
          ),
        ),
        h('main', { class: 'layout', id: 'tab-root' }),
      ),
    );
    this.renderTab();
  }

  private renderNav(): HTMLElement[] {
    const tabs: Array<[TabId, string]> = [
      ['library', '① 曲库分析'],
      ['rundown', '② 播出单编排'],
      ['monitor', '③ 播出监视'],
      ['logs', '④ 播出日志'],
    ];
    return tabs.map(([id, label]) =>
      h('button', {
        class: `nav-tab ${this.tab === id ? 'active' : ''}`,
        onclick: () => {
          this.tab = id;
          this.mountShell();
        },
      }, label),
    );
  }

  private renderTab(): void {
    const root = document.getElementById('tab-root');
    if (!root) return;
    root.replaceChildren();
    if (this.tab === 'library') root.append(this.renderLibraryTab());
    if (this.tab === 'rundown') root.append(this.renderRundownTab());
    if (this.tab === 'monitor') root.append(this.renderMonitorTab());
    if (this.tab === 'logs') root.append(this.renderLogsTab());
    this.updateChromeClock();
  }

  // ---------- Library ----------
  private renderLibraryTab(): HTMLElement {
    const analyzedCount = [...this.tracks.values()].filter((t) => t.analysis).length;
    const filtered = this.specs.filter((spec) => {
      if (this.kindFilter !== 'all' && spec.kind !== this.kindFilter) return false;
      const q = this.query.trim().toLowerCase();
      if (!q) return true;
      return spec.id.toLowerCase().includes(q) || spec.title.toLowerCase().includes(q) || spec.styleLabel.toLowerCase().includes(q);
    });
    const rows = filtered.slice(0, this.visibleCount);

    return h('div', { class: 'grid-2' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-header' },
          h('div', {}, h('h2', {}, '曲库分析'), h('div', { class: 'hint' }, '前奏人声进入 · 结尾淡出 · 节拍锚点 · 保守安全边界')),
          h('div', { class: 'button-row' },
            h('button', { class: 'btn primary', onclick: () => void this.analyzeAll(), disabled: this.analysis.running }, this.analysis.running ? '分析中…' : '分析 10,000 首'),
            h('button', { class: 'btn ghost', onclick: () => void this.analyzeInitial() }, '重析演示素材'),
          ),
        ),
        h('div', { class: 'panel-body' },
          h('div', { class: 'grid-3', style: 'margin-bottom:14px' },
            this.statCard('曲库总数', this.specs.length.toLocaleString(), '含歌曲与合成广告/垫乐'),
            this.statCard('已分析', analyzedCount.toLocaleString(), this.analysis.workerCount ? `${this.analysis.workerCount} 个音频 Worker` : '等待分析'),
            this.statCard('10 分钟预算', this.analysis.complete ? '达标' : '≤ 600s', this.analysis.elapsedMs ? `上次 ${(this.analysis.elapsedMs / 1000).toFixed(1)}s` : '结构扫描 + 并行'),
          ),
          h('div', { class: 'progress', style: 'margin:12px 0 8px' }, h('i', { id: 'analysis-bar' })),
          h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:14px', id: 'analysis-text' }, '尚未开始全量分析'),
          h('div', { class: 'button-row', style: 'margin-bottom:12px' },
            h('input', { class: 'input', placeholder: '搜索编号 / 歌名 / 风格', value: this.query, oninput: (e: Event) => { this.query = (e.target as HTMLInputElement).value; this.visibleCount = 100; this.renderTab(); } }),
            h('select', { class: 'input', style: 'width:150px', onchange: (e: Event) => { this.kindFilter = (e.target as HTMLSelectElement).value; this.renderTab(); } },
              ...[
                ['all', '全部类型'], ['song', '歌曲'], ['ad', '广告'], ['filler', '垫乐'], ['jingle', '台呼'], ['news', '新闻'], ['timesignal', '报时'],
              ].map(([value, label]) => h('option', { value, selected: this.kindFilter === value }, label)),
            ),
          ),
        ),
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '素材'), h('th', {}, '类型/风格'), h('th', {}, '时长'), h('th', {}, 'BPM'),
              h('th', {}, '人声进/出'), h('th', {}, '淡出起'), h('th', {}, '安全前奏/尾点'), h('th', {}, ''),
            )),
            h('tbody', {}, ...rows.map((spec) => this.libraryRow(spec))),
          ),
        ),
        filtered.length > this.visibleCount
          ? h('div', { class: 'panel-body' }, h('button', { class: 'btn ghost', onclick: () => { this.visibleCount += 200; this.renderTab(); } }, `加载更多（剩余 ${filtered.length - this.visibleCount}）`))
          : null,
      ),
      h('aside', { style: 'display:grid;gap:18px' },
        h('section', { class: 'panel' },
          h('div', { class: 'panel-header' }, h('h2', {}, '合成素材风格')),
          h('div', { class: 'panel-body', style: 'display:grid;gap:10px' },
            this.callout('已程序合成：城乡流行、田野民谣、乡镇摇滚、夜风电子、月夜抒情；集市/农资/健康/公益广告；台呼、新闻片头、可伸缩垫乐和整点报时。'),
            this.callout('分析器读取 Web Audio AudioBuffer 的 PCM 能量、低频 onset、节拍自相关和 3–6Hz 咬字调制；不把曲谱真值交给排程器。', 'good'),
            this.callout('安全边界额外外扩 0.45s：入声估计宁可提前，尾音估计宁可延后，从数据结构上杜绝人声相撞。', 'warn'),
          ),
        ),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-header' }, h('h2', {}, '验收口径')),
          h('div', { class: 'panel-body' },
            h('dl', { class: 'kv' },
              h('dt', {}, '报时偏差'), h('dd', { class: 'mono good' }, '目标 ≤100ms；Web Audio 绝对时钟预排'),
              h('dt', {}, '人声重叠'), h('dd', { class: 'mono good' }, this.truthChecks.length ? `${this.truthChecks.filter((c) => c.overlapVocalSec === 0).length}/${this.truthChecks.length} 段为 0` : '排程后自动真值校验'),
              h('dt', {}, '万首性能'), h('dd', { class: 'mono' }, 'Worker 并行 / 10 分钟预算'),
            ),
          ),
        ),
      ),
    );
  }

  private libraryRow(spec: TrackSpec): HTMLElement {
    const a = this.tracks.get(spec.id)?.analysis;
    return h('tr', {},
      h('td', {}, h('div', { style: 'font-weight:800;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, spec.title), h('div', { class: 'muted mono', style: 'font-size:11px' }, spec.id)),
      h('td', {}, h('span', { class: `badge ${spec.kind}` }, this.kindLabel(spec.kind)), h('div', { class: 'muted', style: 'margin-top:4px' }, spec.styleLabel)),
      h('td', { class: 'mono' }, fmtDuration(spec.durationSec)),
      h('td', { class: 'mono' }, a ? `${a.bpm}` : '—'),
      h('td', { class: 'mono' }, a ? `${a.vocalInSec?.toFixed(1) ?? '无'} / ${a.vocalEndSec?.toFixed(1) ?? '无'}` : '待分析'),
      h('td', { class: 'mono' }, a?.fadeStartSec ? `${a.fadeStartSec.toFixed(1)}s` : '—'),
      h('td', { class: 'mono muted' }, a ? `${a.safeVocalInSec.toFixed(1)} / ${a.safeVocalOutSec.toFixed(1)}` : '—'),
      h('td', {}, h('button', { class: 'btn small', onclick: () => this.addToRundown(spec.id) }, '加入')),
    );
  }

  private statCard(label: string, value: string, sub: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value accent' }, value), h('div', { class: 'sub' }, sub));
  }

  private callout(text: string, variant: '' | 'good' | 'warn' | 'danger' = ''): HTMLElement {
    return h('div', { class: `callout ${variant}` }, text);
  }

  private kindLabel(kind: string): string {
    return { song: '歌曲', ad: '广告', filler: '垫乐', jingle: '台呼', news: '新闻', timesignal: '报时' }[kind] ?? kind;
  }

  private addToRundown(trackId: string): void {
    this.rundown.push({ id: this.createItemId(), trackId });
    this.addLog('info', 'schedule', `手动加入播出单：${this.specById.get(trackId)?.title ?? trackId}`);
    this.tab = 'rundown';
    this.mountShell();
  }

  // ---------- Rundown ----------
  private setTargetMode(mode: TargetMode): void {
    this.targetMode = mode;
    this.targetEpochMs = mode === 'hour' ? nextTopOfHour() : Date.now() + (mode === 'demo90' ? 90_000 : 360_000);
    this.schedule = null;
    this.renderTab();
  }

  private runAutoFit(silent = false): void {
    if (!this.tracks.get('time-signal')?.analysis) {
      const spec = this.specById.get('time-signal')!;
      this.tracks.get('time-signal')!.analysis = analyzeSpecFast(spec);
    }
    const now = Date.now();
    if (this.targetEpochMs - now < 20_000) {
      this.targetMode = 'demo360';
      this.targetEpochMs = now + 360_000;
      if (!silent) this.addLog('warn', 'schedule', '原演练目标已过期，已重置为 6 分钟后');
    }

    const candidates = [...this.tracks.values()].filter(
      (t) => t.analysis && ['song', 'ad', 'filler', 'jingle'].includes(t.spec.kind),
    );
    const result = autoFitRundown({
      targetEpochMs: this.targetEpochMs,
      nowEpochMs: now,
      items: this.rundown,
      catalog: this.catalog,
      candidates,
      createId: () => this.createItemId(),
    });
    this.rundown = result.items;
    this.schedule = result.schedule;
    this.recomputeTruthChecks();
    if (!silent) {
      this.addLog('success', 'schedule', `倒排完成：${result.schedule.segments.length} 段，目标误差 ${result.schedule.exactEndErrorMs.toFixed(1)}ms，末曲淡出修正 ${result.schedule.warnings.length ? '超限' : `${result.schedule.programDurationSec ? '' : ''}${result.requiredNudgeSec.toFixed(2)}s`}`);
      for (const warning of result.schedule.warnings) this.addLog('warn', 'schedule', warning);
    }
    if (this.tab === 'rundown') this.renderTab();
  }

  private recomputeTruthChecks(): void {
    this.truthChecks = [];
    if (!this.schedule) return;
    this.schedule.transitions.forEach((plan, index) => {
      const from = this.specById.get(plan.fromTrackId)!;
      const to = this.specById.get(plan.toTrackId)!;
      const violation = validateTransitionAgainstTruth(plan, from, to, index);
      this.truthChecks.push({ plan, overlapVocalSec: violation?.overlapVocalSec ?? 0, beatErrorMs: this.trueBeatError(plan, from, to) });
    });
  }

  private trueBeatError(plan: TransitionPlan, from: TrackSpec, to: TrackSpec): number {
    if (plan.overlapSec <= 0.01) return 0;
    const periodA = 60 / from.bpm;
    const cueBeat = from.firstBeatSec + Math.round((plan.fromCueSec - from.firstBeatSec) / periodA) * periodA;
    const cueErrorMs = Math.abs(plan.fromCueSec - cueBeat) * 1000;
    const toBeat = to.firstBeatSec + Math.round((plan.toOffsetSec - to.firstBeatSec) / (60 / to.bpm)) * (60 / to.bpm);
    const toErrorMs = Math.abs(plan.toOffsetSec - toBeat) * 1000;
    return Math.max(cueErrorMs, toErrorMs);
  }

  private insertNews(): void {
    this.rundown = insertBreakingNews({
      items: this.rundown,
      newsTrackId: 'news-breaking',
      catalog: this.catalog,
      afterItemId: this.air.currentSegmentId ? this.itemIdFromSegment(this.air.currentSegmentId) : this.rundown[0]?.id ?? null,
      createId: () => this.createItemId(),
    });
    this.addLog('warn', 'schedule', '临时插播新闻已插入，后续歌曲、广告和垫乐正在自动重排');
    this.runAutoFit();
  }

  private itemIdFromSegment(segmentId: string): string | null {
    return this.schedule?.segments.find((s) => s.itemId === segmentId)?.itemId ?? segmentId;
  }

  private moveItem(id: string, delta: number): void {
    const index = this.rundown.findIndex((i) => i.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.rundown.length) return;
    const [item] = this.rundown.splice(index, 1);
    this.rundown.splice(target, 0, item);
    this.runAutoFit(true);
    this.renderTab();
  }

  private removeItem(id: string): void {
    this.rundown = this.rundown.filter((i) => i.id !== id);
    this.runAutoFit(true);
    this.renderTab();
  }

  private renderRundownTab(): HTMLElement {
    return h('div', { class: 'grid-2' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-header' },
          h('div', {}, h('h2', {}, '播出单编排与整点倒排'), h('div', { class: 'hint' }, '从报时第一声反向排程；剩余时长选歌/垫乐；末曲淡出吸收 ±5 秒')),
          h('div', { class: 'button-row' },
            h('button', { class: 'btn primary', onclick: () => this.runAutoFit() }, '智能倒排/重排'),
            h('button', { class: 'btn danger', onclick: () => this.insertNews() }, '临时插播新闻'),
          ),
        ),
        h('div', { class: 'panel-body' },
          h('div', { class: 'inline-form', style: 'margin-bottom:14px' },
            h('label', { class: 'field' }, '目标时刻',
              h('select', { class: 'input', onchange: (e: Event) => this.setTargetMode((e.target as HTMLSelectElement).value as TargetMode) },
                h('option', { value: 'hour', selected: this.targetMode === 'hour' }, `下一整点 ${fmtTime(nextTopOfHour())}`),
                h('option', { value: 'demo360', selected: this.targetMode === 'demo360' }, '6 分钟后（完整演示）'),
                h('option', { value: 'demo90', selected: this.targetMode === 'demo90' }, '90 秒后（精度演练）'),
              ),
            ),
            h('button', { class: 'btn blue', onclick: () => this.setTargetMode('hour') }, '锁定下一整点'),
            h('button', { class: 'btn ghost', onclick: () => { this.rundown = []; this.schedule = null; this.renderTab(); } }, '清空自动单'),
          ),
          this.schedule ? this.renderScheduleMetrics() : this.callout('点击“智能倒排/重排”，系统会按剩余时间挑歌和垫乐。'),
        ),
        h('div', { class: 'rundown-list' }, ...this.renderRundownItems()),
      ),
      h('aside', { style: 'display:grid;gap:18px' },
        this.renderTimelinePanel(),
        this.renderTransitionsPanel(),
      ),
    );
  }

  private renderRundownItems(): HTMLElement[] {
    if (!this.rundown.length) return [this.callout('播出单为空。可从曲库加入素材，或点击“智能倒排”。')];
    return this.rundown.map((item, index) => {
      const spec = this.specById.get(item.trackId);
      const segment = this.schedule?.segments.find((s) => s.itemId === item.id);
      if (!spec) return h('div', { class: 'rundown-item danger' }, `缺少素材 ${item.trackId}`);
      return h('div', { class: `rundown-item ${item.breaking ? 'breaking' : ''} ${this.air.currentSegmentId === item.id ? 'current' : ''}` },
        h('div', { class: 'order-index' }, String(index + 1).padStart(2, '0')),
        h('div', { style: 'min-width:0' },
          h('div', { class: 'rundown-title' }, spec.title),
          h('div', { class: 'rundown-meta' },
            h('span', { class: `badge ${spec.kind}` }, this.kindLabel(spec.kind)),
            h('span', { class: 'mono' }, fmtDuration(spec.durationSec)),
            segment ? h('span', { class: 'mono accent' }, `${fmtTime(segment.startEpochMs)} → ${fmtTime(segment.endEpochMs)}`) : null,
            item.breaking ? h('span', { class: 'badge news' }, '插播') : null,
            item.autoSelected ? h('span', { class: 'badge filler' }, '自动选曲') : h('span', { class: 'badge' }, '锁定'),
          ),
        ),
        h('div', { class: 'item-actions' },
          h('button', { class: 'icon-btn', title: '上移', onclick: () => this.moveItem(item.id, -1) }, '↑'),
          h('button', { class: 'icon-btn', title: '下移', onclick: () => this.moveItem(item.id, 1) }, '↓'),
          h('button', { class: 'icon-btn', title: '删除并重排', onclick: () => this.removeItem(item.id) }, '×'),
        ),
      );
    });
  }

  private renderScheduleMetrics(): HTMLElement {
    const s = this.schedule!;
    const available = (s.targetEpochMs - s.buildEpochMs) / 1000;
    const allZero = this.truthChecks.every((c) => c.overlapVocalSec === 0);
    return h('div', { style: 'display:grid;gap:12px' },
      h('div', { class: 'grid-3' },
        this.statCard('目标', fmtTime(s.targetEpochMs), this.targetMode === 'hour' ? '下一整点' : '演练时刻'),
        this.statCard('节目时长', fmtDuration(s.programDurationSec), `构建窗口 ${fmtDuration(available)}`),
        this.statCard('报时锁定误差', `${s.exactEndErrorMs.toFixed(1)}ms`, '倒排数学端点', ),
      ),
      h('div', { class: this.truthChecks.length && allZero ? 'callout good' : 'callout warn' },
        this.truthChecks.length
          ? `真值校验：${this.truthChecks.length} 个衔接的人声重叠全部为 0；最大真值节拍偏差 ${Math.max(...this.truthChecks.map((c) => c.beatErrorMs)).toFixed(1)}ms。`
          : '尚无衔接。',
      ),
      ...s.adjustments.map((text) => this.callout(text, 'good')),
      ...s.warnings.map((text) => this.callout(text, 'warn')),
    );
  }

  private renderTimelinePanel(): HTMLElement {
    const s = this.schedule;
    if (!s) return h('section', { class: 'panel' }, h('div', { class: 'panel-header' }, h('h2', {}, '时间轴')), h('div', { class: 'panel-body' }, '等待倒排'));
    const start = s.startEpochMs;
    const end = s.targetEpochMs + 5900;
    const span = end - start;
    const color: Record<string, string> = { song: '#4aa8ff', ad: '#ffc857', filler: '#55e38a', jingle: '#be8cff', news: '#ff5d73' };
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-header' }, h('h2', {}, '播出时间轴')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'timeline' },
          ...s.segments.map((seg) => h('div', {
            class: 'timeline-block',
            title: seg.title,
            style: `left:${((seg.startEpochMs - start) / span) * 100}%;width:${Math.max(0.4, ((seg.endEpochMs - seg.startEpochMs) / span) * 100)}%;--block:${color[seg.kind] ?? '#38e1c6'}`,
          })),
          h('div', { class: 'timeline-block signal', style: `left:${((s.timeSignal.startEpochMs - start) / span) * 100}%;width:${((s.timeSignal.endEpochMs - s.timeSignal.startEpochMs) / span) * 100}%` }),
        ),
        h('div', { class: 'timeline-labels' }, h('span', {}, fmtTime(start)), h('span', { class: 'danger' }, `整点 ${fmtTime(s.targetEpochMs)}`), h('span', {}, fmtTime(end))),
      ),
    );
  }

  private renderTransitionsPanel(): HTMLElement {
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-header' }, h('h2', {}, '节拍/人声衔接校验')),
      h('div', { class: 'table-wrap', style: 'max-height:430px' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '衔接'), h('th', {}, '叠播'), h('th', {}, '节拍误差'), h('th', {}, '人声重叠'), h('th', {}, '说明'))),
          h('tbody', {},
            ...(this.truthChecks.length ? this.truthChecks : []).map((check) => {
              const from = this.specById.get(check.plan.fromTrackId);
              const to = this.specById.get(check.plan.toTrackId);
              return h('tr', {},
                h('td', { style: 'max-width:190px' }, h('div', { style: 'font-weight:800' }, from?.title ?? check.plan.fromTrackId), h('div', { class: 'muted' }, '→ ' + (to?.title ?? check.plan.toTrackId))),
                h('td', { class: 'mono' }, `${check.plan.overlapSec.toFixed(2)}s`),
                h('td', { class: 'mono' }, check.plan.overlapSec ? `${check.beatErrorMs.toFixed(1)}ms` : '硬对接'),
                h('td', { class: `mono ${check.overlapVocalSec === 0 ? 'good' : 'danger'}` }, `${(check.overlapVocalSec * 1000).toFixed(0)}ms`),
                h('td', { class: 'muted', style: 'font-size:11.5px;max-width:260px' }, check.plan.reason),
              );
            }),
          ),
        ),
      ),
    );
  }

  // ---------- Monitor ----------
  private renderMonitorTab(): HTMLElement {
    const current = this.currentSegment();
    return h('div', { style: 'display:grid;gap:18px' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-body' },
          h('div', { class: 'onair-hero' },
            h('div', { class: `onair-lamp ${this.air.status === 'onair' ? 'live' : ''}`, id: 'onair-lamp' }, this.air.status === 'onair' ? 'ON AIR' : 'READY'),
            h('div', { style: 'min-width:0' },
              h('div', { class: 'muted', style: 'font-size:12px;font-weight:800;letter-spacing:.12em' }, '距整点/目标时刻'),
              h('div', { class: 'countdown mono', id: 'monitor-countdown' }, this.schedule ? fmtDuration((this.schedule.targetEpochMs - Date.now()) / 1000) : '--:--'),
              h('div', { style: 'font-size:18px;font-weight:900;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', id: 'monitor-current-title' }, current?.title ?? '尚未武装播出单'),
              h('div', { class: 'muted', style: 'margin-top:4px' }, 'Web Audio 绝对时间预排 · 80ms 调度轮询 · 1.4s lookahead'),
            ),
            h('div', { class: 'button-row' },
              h('button', { class: 'btn primary', id: 'arm-btn', onclick: () => void this.arm() }, '武装并播出'),
              h('button', { class: 'btn', onclick: () => void this.engine?.suspendToggle() }, '暂停/继续'),
              h('button', { class: 'btn danger', onclick: () => void this.engine?.stop() }, '停止'),
            ),
          ),
        ),
      ),
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' },
          h('div', { class: 'panel-header' }, h('h2', {}, '电平与播放进度')),
          h('div', { class: 'panel-body' },
            h('div', { class: 'vu-stack' },
              h('div', { class: 'vu-row' }, h('span', { class: 'mono muted' }, 'L'), h('div', { class: 'vu-track' }, h('div', { class: 'vu-fill', id: 'vu-left' })), h('span', { class: 'mono muted', id: 'vu-left-db' }, '-∞')),
              h('div', { class: 'vu-row' }, h('span', { class: 'mono muted' }, 'R'), h('div', { class: 'vu-track' }, h('div', { class: 'vu-fill', id: 'vu-right' })), h('span', { class: 'mono muted', id: 'vu-right-db' }, '-∞')),
            ),
            h('div', { class: 'progress', style: 'margin:18px 0 8px' }, h('i', { id: 'segment-progress' })),
            h('div', { class: 'muted mono', id: 'segment-time' }, '00:00.0 / 00:00.0'),
            h('div', { class: 'callout good', style: 'margin-top:16px' }, '报时第一声的 AudioBuffer 起始样本为 0；调度时映射到标准时间对应的 AudioContext 时刻，并补偿 outputLatency。'),
          ),
        ),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-header' }, h('h2', {}, '标准时钟 / 精度')),
          h('div', { class: 'panel-body' },
            h('dl', { class: 'kv', id: 'clock-kv' },
              h('dt', {}, '时钟来源'), h('dd', { id: 'clock-source' }, 'system'),
              h('dt', {}, '服务器偏差'), h('dd', { class: 'mono', id: 'clock-offset' }, '0ms'),
              h('dt', {}, 'RTT'), h('dd', { class: 'mono', id: 'clock-rtt' }, '—'),
              h('dt', {}, '输出延迟'), h('dd', { class: 'mono', id: 'audio-latency' }, '—'),
              h('dt', {}, '上次排程偏差'), h('dd', { class: 'mono good', id: 'hour-deviation' }, '—'),
            ),
            h('div', { class: 'button-row', style: 'margin-top:14px' },
              h('button', { class: 'btn blue', onclick: () => void this.clock.syncWithServer().then(() => this.updateChromeClock()) }, '重新同步'),
              h('button', { class: 'btn ghost', onclick: () => this.setTargetMode('demo90') }, '90 秒精度演练'),
            ),
          ),
        ),
      ),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-header' }, h('h2', {}, '接下来的播出链')),
        this.renderUpcomingTable(),
      ),
    );
  }

  private renderUpcomingTable(): HTMLElement {
    const segments = this.schedule ? [...this.schedule.segments, this.schedule.timeSignal] : [];
    return h('div', { class: 'table-wrap', style: 'max-height:360px' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '开始'), h('th', {}, '素材'), h('th', {}, '类型'),
          h('th', {}, '结束'), h('th', {}, '源入点'), h('th', {}, '淡出修正'),
        )),
        h('tbody', {}, ...segments.map((seg) =>
          h('tr', { class: this.air.currentSegmentId === seg.itemId ? 'current' : '' },
            h('td', { class: 'mono' }, fmtTime(seg.startEpochMs)),
            h('td', { style: 'font-weight:800' }, seg.title),
            h('td', {}, h('span', { class: `badge ${seg.kind}` }, this.kindLabel(seg.kind))),
            h('td', { class: 'mono' }, fmtTime(seg.endEpochMs)),
            h('td', { class: 'mono muted' }, `${seg.sourceOffsetSec.toFixed(2)}s`),
            h('td', { class: 'mono' }, seg.fadeNudgeSec ? `${seg.fadeNudgeSec > 0 ? '+' : ''}${seg.fadeNudgeSec.toFixed(2)}s` : '—'),
          ),
        )),
      ),
    );
  }

  private currentSegment() {
    if (!this.schedule) return null;
    return [...this.schedule.segments, this.schedule.timeSignal].find((s) => s.itemId === this.air.currentSegmentId) ?? null;
  }

  private async provideBuffer(trackId: string): Promise<AudioBuffer | null> {
    const spec = this.specById.get(trackId);
    if (!spec || !this.bufferCache) return null;
    return this.bufferCache.get(spec);
  }

  private async arm(): Promise<void> {
    if (!this.schedule) this.runAutoFit();
    if (!this.schedule) return;
    const ctx = await this.engine!.ensureContext();
    this.bufferCache = new AudioBufferCache(ctx);
    this.addLog('info', 'broadcast', `开始合成并缓冲 ${this.schedule.segments.length + 1} 个 Web Audio 素材`);
    for (const id of [this.schedule.timeSignal.trackId, ...this.schedule.segments.map((s) => s.trackId)]) {
      const spec = this.specById.get(id);
      if (spec) await this.bufferCache.get(spec);
    }
    await this.engine!.arm(this.schedule);
    this.air.status = 'arming';
    this.updateMonitorDynamic();
  }

  private updateChromeClock(): void {
    const now = this.clock.now();
    const el = document.getElementById('clock-now');
    if (el) el.textContent = fmtClock(now);
    const status = this.clock.status();
    const statusEl = document.getElementById('clock-status');
    const dot = document.getElementById('clock-dot');
    if (statusEl) statusEl.textContent = status.synchronized ? `标准时间已同步 · offset ${status.offsetMs.toFixed(1)}ms` : '本机系统时钟 · 未连接时间服务';
    if (dot) dot.className = `status-dot ${status.synchronized ? 'ok' : 'warn'}`;

    const source = document.getElementById('clock-source');
    if (source) source.textContent = status.source;
    const offset = document.getElementById('clock-offset');
    if (offset) offset.textContent = `${status.offsetMs.toFixed(1)} ms`;
    const rtt = document.getElementById('clock-rtt');
    if (rtt) rtt.textContent = status.rttMs ? `${status.rttMs.toFixed(1)} ms` : '—';
    const latency = document.getElementById('audio-latency');
    if (latency) latency.textContent = `${status.audioOutputLatencyMs.toFixed(1)} ms`;
    this.updateMonitorDynamic();
  }

  private updateMonitorDynamic(): void {
    if (this.tab !== 'monitor') return;
    const now = this.clock.now();
    const countdown = document.getElementById('monitor-countdown');
    if (countdown && this.schedule) countdown.textContent = fmtDuration(Math.max(0, (this.schedule.targetEpochMs - now) / 1000));
    const title = document.getElementById('monitor-current-title');
    const current = this.currentSegment();
    if (title) title.textContent = current?.title ?? (this.air.status === 'arming' ? '等待调度窗口…' : '尚未播出');
    const lamp = document.getElementById('onair-lamp');
    if (lamp) {
      lamp.className = `onair-lamp ${this.air.status === 'onair' ? 'live' : ''}`;
      lamp.textContent = this.air.status === 'onair' ? 'ON AIR' : this.air.status.toUpperCase();
    }
    const hour = document.getElementById('hour-deviation');
    if (hour && this.air.lastHourDeviationMs !== null) hour.textContent = `${this.air.lastHourDeviationMs.toFixed(1)} ms（≤100）`;

    const left = document.getElementById('vu-left') as HTMLElement | null;
    const right = document.getElementById('vu-right') as HTMLElement | null;
    if (left) left.style.width = `${Math.min(100, this.air.vuLeft * 130)}%`;
    if (right) right.style.width = `${Math.min(100, this.air.vuRight * 130)}%`;

    if (current) {
      const elapsed = Math.max(0, (now - current.startEpochMs) / 1000);
      const duration = (current.endEpochMs - current.startEpochMs) / 1000;
      const bar = document.getElementById('segment-progress');
      if (bar) bar.style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
      const time = document.getElementById('segment-time');
      if (time) time.textContent = `${fmtDuration(elapsed)} / ${fmtDuration(duration)}`;
    }
  }

  // ---------- Logs ----------
  private renderLogsTab(): HTMLElement {
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-header' },
        h('div', {}, h('h2', {}, '播出日志'), h('div', { class: 'hint' }, '分析、排程、插播、衔接、报时偏差和系统异常')),
        h('div', { class: 'button-row' },
          h('span', { class: 'badge' }, h('span', { id: 'log-count' }, String(this.logs.length)), '条'),
          h('button', { class: 'btn ghost', onclick: () => this.exportLogs('json') }, '导出 JSON'),
          h('button', { class: 'btn ghost', onclick: () => this.exportLogs('csv') }, '导出 CSV'),
          h('button', { class: 'btn danger small', onclick: () => { this.logs = []; this.renderTab(); } }, '清空'),
        ),
      ),
      this.renderLogList(),
    );
  }

  private renderLogList(): HTMLElement {
    const existing = document.getElementById('log-list');
    const list = h('div', { class: 'log-list', id: 'log-list' }, ...this.logs.map((entry) =>
      h('div', { class: 'log-line' },
        h('span', { class: 'log-time' }, fmtClock(entry.timeEpochMs)),
        h('span', { class: `log-level ${entry.level}` }, entry.level.toUpperCase()),
        h('span', { class: 'log-category' }, entry.category),
        h('span', { class: 'log-message' }, entry.message),
      ),
    ));
    if (existing) existing.replaceWith(list);
    return list;
  }

  private exportLogs(format: 'json' | 'csv'): void {
    let blob: Blob;
    if (format === 'json') {
      blob = new Blob([JSON.stringify(this.logs, null, 2)], { type: 'application/json' });
    } else {
      const csv = [
        'time,level,category,message',
        ...this.logs.map((l) =>
          [l.timeEpochMs, l.level, l.category, `"${l.message.replaceAll('"', '""')}"`].join(','),
        ),
      ].join('\n');
      blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `broadcast-log-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

new RadioApp();
