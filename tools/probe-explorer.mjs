// Sonda rápida de la UI del explorador por CDP (uso interno de verificación).
// node tools/probe-explorer.mjs [--search "texto"]
import fs from 'node:fs';

const CDP = process.env.CMP_PROBE_CDP || 'http://127.0.0.1:9241/json/list';
const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === 'page' && /yt-controls\.html$/.test(t.url));
if (!page) { console.log('NO PAGE'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => { ws.onopen = r; });
function send(method, params = {}) {
  const i = ++id;
  return new Promise((res) => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r) return null;
  if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result ? r.result.result.value : null;
}

const report = {};
report.beforeOpen = await ev(`(()=>{document.getElementById('search').click(); return {
  modal: document.body.classList.contains('showModal'),
  input: !!document.getElementById('modalInput'),
  grid: !!document.getElementById('exGrid'),
  menu: !!document.getElementById('exMenu'),
  queue: !!document.getElementById('exQueueList'),
  lists: !!document.getElementById('exListSide'),
  items: !!document.getElementById('exListItems'),
  auto: !!document.getElementById('exAutoAdvance'),
  tabs: document.querySelectorAll('.ex-tab').length,
  focus: document.activeElement && document.activeElement.id,
};})()`);

const q = process.argv.includes('--search') ? process.argv[process.argv.indexOf('--search') + 1] : 'Pink Floyd';
if (q) {
  await ev(`(()=>{const i=document.getElementById('modalInput'); i.value=${JSON.stringify(q)}; document.getElementById('modalSubmit').click(); return true;})()`);
  // la búsqueda tarda ~10-20 s
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await ev(`(()=>{const g=document.getElementById('exGrid'); return {cards:g.children.length, status:(document.getElementById('exStatus').textContent||'').trim(), more:(document.getElementById('exMore').textContent||'').trim()};})()`);
    if (st && st.cards > 0) { report.search = st; break; }
    if (i === 39) report.search = st;
  }
  report.firstCard = await ev(`(()=>{const c=document.querySelector('#exGrid .ex-card'); if(!c) return null; return {id:c.dataset.id, title:(c.querySelector('.ex-title')||{}).textContent, sub:(c.querySelector('.ex-sub')||{}).textContent, dur:(c.querySelector('.ex-dur')||{}).textContent, thumb:!!c.querySelector('img.ex-thumbimg'), more:!!c.querySelector('.ex-more-btn')};})()`);
  report.menu = await ev(`(()=>{const b=document.querySelector('#exGrid .ex-more-btn'); b.click(); const m=document.getElementById('exMenu'); return {shown:m.classList.contains('show'), actions:[...m.querySelectorAll('[data-action]')].map(x=>x.dataset.action)};})()`);
  report.addQueue = await ev(`(async()=>{const b=document.querySelector('#exMenu [data-action="add-queue"]'); if(!b) return 'no action'; b.click(); await new Promise(r=>setTimeout(r,900)); const q=await window.cmp.queue(); return {len:q.length, first:q.items[0]&&q.items[0].id};})()`);
  report.queueTab = await ev(`(async()=>{document.querySelector('.ex-tab[data-tab="queue"]').click(); await new Promise(r=>setTimeout(r,700)); const rows=document.querySelectorAll('#exQueueList .ex-row'); return {rows:rows.length, badge:(document.getElementById('exQueueCount')||{}).textContent};})()`);
  report.listsTab = await ev(`(async()=>{document.querySelector('.ex-tab[data-tab="lists"]').click(); await new Promise(r=>setTimeout(r,900)); return {side:document.querySelectorAll('#exListSide button').length, names:[...document.querySelectorAll('#exListSide button span')].map(x=>x.textContent)};})()`);
  report.watchLater = await ev(`(async()=>{document.querySelector('.ex-tab[data-tab="results"]').click(); document.querySelector('#exGrid .ex-more-btn').click(); await new Promise(r=>setTimeout(r,200)); const b=document.querySelector('#exMenu [data-action="watch-later"]'); if(!b) return 'no action'; b.click(); await new Promise(r=>setTimeout(r,900)); const l=await window.cmp.list('watch-later'); return {items:(l.items||[]).length};})()`);
  report.playNow = await ev(`(async()=>{document.querySelector('#exGrid .ex-more-btn').click(); await new Promise(r=>setTimeout(r,200)); const b=document.querySelector('#exMenu [data-action="play-now"]'); if(!b) return 'no action'; b.click(); await new Promise(r=>setTimeout(r,1500)); const s=await window.cmp.state(); return {status:s.status, title:s.title, modal:document.body.classList.contains('showModal')};})()`);
}

console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
