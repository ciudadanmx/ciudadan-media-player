// Mide cuánto tarda la búsqueda desde la UI y si llega a pintar resultados.
// Uso: node tools\probe-search-time.mjs [cdpPort]
const CDP_PORT = Number(process.argv[2] || 18133);
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((p) => /yt-controls\.html/.test(p.url));
if (!page) { console.log('no hay página yt-controls'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const cmd = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id; pend.set(myId, resolve);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await ev(`(async()=>{const c=document.getElementById('modalCancel'); if(c) c.click();
  await new Promise(r=>setTimeout(r,500));
  document.getElementById('search').click(); await new Promise(r=>setTimeout(r,900));})()`);
console.log('--- buscando "los gateways" y midiendo...');
const t0 = Date.now();
await ev(`(()=>{const ex=document.getElementById('exRoot'); const inp=ex.querySelector('input');
  inp.focus(); inp.value='los gateways';
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));})()`);
let ultimo = '';
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await ev(`(()=>{const ex=document.getElementById('exRoot');
    const vis=[...ex.querySelectorAll('.card,.item,[data-id],.resCard')].length;
    const txt=(ex.innerText||'').replace(/\\s+/g,' ');
    return {vis, txt:txt.slice(0,160)};})()`);
  const linea = `[${Math.round((Date.now() - t0) / 1000)}s] tarjetas=${s.vis} :: ${s.txt}`;
  if (linea !== ultimo) console.log(linea);
  ultimo = linea;
  if (s.vis > 0 && /Gateway|gateway|Result/i.test(s.txt)) break;
}
ws.close();
