// 非 headless E2E：连接已运行的 Chrome（CDP_PORT）与 preview（TARGET_URL），不自行 spawn 浏览器
import { writeFileSync } from 'node:fs';

const CDP_PORT = process.env.CDP_PORT ?? 9501;
const URL = process.env.TARGET_URL ?? 'http://localhost:4400/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = URL.split('/')[2];
let target;
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = l.find((t) => t.type === 'page' && t.url.includes(HOST));
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) throw new Error('CDP 未就绪: 未找到 host=' + HOST + ' 的页面');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
const consoleLogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  if (m.method === 'Runtime.exceptionThrown') consoleLogs.push('EXC: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleLogs.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++mid; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const wait = async (expr, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return; await sleep(300); }
  throw new Error('等待超时: ' + label);
};
const report = {};
try {
  await rpc('Runtime.enable'); await rpc('Page.enable');
  // 仅当当前页不是目标应用时才导航
  const curUrl = await ev(`location.href`);
  if (!String(curUrl).includes(URL.split('/')[2])) {
    await rpc('Page.navigate', { url: URL });
  }
  await wait(`document.querySelectorAll('#lib-table thead th').length === 12`, 15000, '页面骨架');

  // 1. 生成小规模演示曲库（缩短环境服务存活窗口内的耗时；DSP 准确率由 selftest-only 单独验证）
  const t0 = Date.now();
  // 直接调用库服务生成 12 条小库，而非点 36 条按钮
  await ev(`(async () => {
    const svc = window.__libraryForTest ?? null;
    // 通过按钮事件间接调用不可传参，这里用自定义事件携带参数
    window.dispatchEvent(new CustomEvent('e2e-gen', { detail: { songs: 7, ads: 2, beds: 2, news: 1 } }));
  })()`);
  await wait(`document.querySelector('#progress-meta').innerText.includes('完成')`, 90000, '曲库分析');
  report.libMs = Date.now() - t0;
  report.libSummary = await ev(`document.querySelector('#lib-summary').innerText`);
  report.libStats = await ev(`Array.from(document.querySelectorAll('#lib-stats .stat')).map(s=>s.innerText.replace(/\\s+/g,' '))`);

  // 2. 编排（20s 宏小时，快速验证报时锚定；歌曲会按窗口截断播放，不影响报时落点正确性）
  await click('[data-tab="schedule"]');
  await ev(`(function(){const e=document.querySelector('#hour-length');e.value='20';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('#btn-build');
  await wait(`document.querySelector('#sch-table tbody tr') !== null`, 15000, '编排');
  report.schStats = await ev(`Array.from(document.querySelectorAll('#sch-summary .stat')).map(s=>s.innerText.replace(/\\s+/g,' '))`);
  report.collisionOk = await ev(`Array.from(document.querySelectorAll('#sch-summary .stat')).some(s=>s.innerText.includes('0（合格）'))`);

  // 3. 开播
  await click('[data-tab="monitor"]');
  await click('#btn-play');
  await wait(`document.querySelector('#mon-hint').innerText.includes('播出中')`, 15000, '开播');
  await sleep(2000);
  report.current = await ev(`document.querySelector('#mon-current').innerText`);

  // 4. 插播重排
  await click('#btn-interrupt');
  await sleep(1200);
  report.interruptHint = await ev(`document.querySelector('#mon-hint').innerText`);

  // 5. 等报时（20s 宏小时）
  await wait(`document.querySelector('#mon-measured').innerText !== '--'`, 40000, '报时');
  report.pipsMeasured = await ev(`document.querySelector('#mon-measured').innerText`);
  report.pipsClass = await ev(`document.querySelector('#mon-measured').className`);
  report.underruns = await ev(`document.querySelector('#mon-underrun').innerText`);

  // 6. 日志
  await click('[data-tab="logs"]');
  report.logCount = await ev(`document.querySelector('#log-count').innerText`);

  report.consoleErrors = consoleLogs;
  writeFileSync('e2e-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  report.fatal = e.message;
  report.consoleErrors = consoleLogs;
  writeFileSync('e2e-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.error('E2E FAIL:', e.message);
  console.error('console:', consoleLogs.join('\n'));
  process.exitCode = 1;
} finally {
  ws.close();
}
