// Verifica: (1) la barra superior ya no dice "Ciudadan", (2) la búsqueda con
// el contador de espera, (3) que el resultado llega o explica la espera.
// Uso: node tools\verify-search-ui.mjs [cdpPort]
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
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
};

console.log('--- 1) Barra de título superior (sin la marca "Ciudadan"):');
console.log(await ev(`(()=>{const brand=document.getElementById('brand'), tt=document.getElementById('topTitle');
  return {marca: brand?brand.textContent.trim():'(sin marca)', textoMarca: brand?brand.innerText.trim():'',
    titulo: tt?tt.textContent.trim():'', topVisible: getComputedStyle(document.getElementById('topbar')).opacity};})()`));

console.log('--- 2) Buscando "ciudadan musica" (con contador de espera):');
await ev(`(async()=>{const c=document.getElementById('modalCancel'); if(c) c.click();
  await new Promise(r=>setTimeout(r,400));
  document.getElementById('search').click(); await new Promise(r=>setTimeout(r,900));})()`);
await ev(`(()=>{const ex=document.getElementById('exRoot'); const inp=ex.querySelector('input');
  inp.focus(); inp.value='ciudadan musica';
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));})()`);
const t0 = Date.now();
let ultimo = '';
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await ev(`(()=>{const ex=document.getElementById('exRoot');
    const st=document.getElementById('exStatus');
    const items=[...ex.querySelectorAll('.ex-item,.res-item,.card,[data-id]')].filter(e=>e.textContent&&e.textContent.trim().length>3);
    return {status:(st?st.innerText:'').replace(/\\s+/g,' '), items:items.length,
      titulos:items.slice(0,3).map(e=>e.textContent.replace(/\\s+/g,' ').trim().slice(0,60))};})()`);
  const linea = `[${Math.round((Date.now() - t0) / 1000)}s] estado="${s.status}" items=${s.items} ${s.titulos ? JSON.stringify(s.titulos) : ''}`;
  if (linea !== ultimo) console.log(linea);
  ultimo = linea;
  if (s.items > 0) break;
}
ws.close();
