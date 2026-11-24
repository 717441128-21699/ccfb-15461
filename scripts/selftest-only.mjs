// 仅跑应用内 DSP 自测并输出结构化结果
import { writeFileSync } from 'node:fs';
const CDP_PORT = process.env.CDP_PORT ?? 9503;
const HOST = process.env.HOST ?? 'localhost:4402';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = l.find((t) => t.type === 'page' && t.url.includes(HOST))
      ?? l.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'))
      ?? l.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) throw new Error('无可用 page target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++mid; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => {
  const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const TARGET_URL = process.env.TARGET_URL ?? `http://${HOST}/`;
await rpc('Runtime.enable');
await rpc('Page.enable');
const curUrl = await ev(`location.href`);
if (!String(curUrl).includes(HOST) || String(curUrl).includes('chrome-error')) {
  await rpc('Page.navigate', { url: TARGET_URL });
  await sleep(2500);
}
const diag = await ev(`({url: location.href, hasBtn: !!document.querySelector('#btn-selftest')})`);
console.log('page diag:', JSON.stringify(diag));
await ev(`document.querySelector('#btn-selftest').click()`);
const t0 = Date.now();
let txt = '';
while (Date.now() - t0 < 60000) {
  await sleep(500);
  txt = (await ev(`document.querySelector('#selftest-out')?.innerText`)) ?? '';
  if (txt.includes('通过') || txt.includes('未达标')) break;
}
const rows = await ev(`Array.from(document.querySelectorAll('#selftest-out tbody tr')).map(tr=>tr.innerText.replace(/\\s+/g,' '))`);
const payload = { headline: txt.split('\n')[0], rows, exceptions: errs };
writeFileSync('selftest-only.json', JSON.stringify(payload, null, 2), 'utf8');
console.log(payload.headline);
for (const r of rows) console.log('  ', r);
if (errs.length) console.log('EXCEPTIONS:', errs);
ws.close();
