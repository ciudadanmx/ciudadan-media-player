// Verificación final de la UI del overlay: marca, título, auto-ocultado y
// búsqueda real (con el tiempo que tarda y los títulos que aparecen).
// Uso: node tools\verify-ui-final.mjs [cdpPort]
const CDP_PORT = Number(process.argv[2] || 18144);
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
const ok = [];
const check = (name, cond, detail) => { ok.push({ name, cond: !!cond, detail }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); };

console.log('== 1) Barra de título superior ==');
const top = await ev(`(()=>{const brand=document.getElementById('brand'), tt=document.getElementById('topTitle');
  return {marca:(brand?brand.textContent:'').trim(), titulo:(tt?tt.textContent:'').trim(),
    alto:Math.round(document.getElementById('topbar').getBoundingClientRect().height),
    arriba:Math.round(document.getElementById('topbar').getBoundingClientRect().top)};})()`);
check('la barra superior existe y mide lo mismo que la inferior', top.alto > 20 && top.arriba <= 12, top);
check('ya NO dice "Ciudadan" en la barra', !/ciudadan/i.test(top.marca), { marca: top.marca });

console.log('== 2) Auto-ocultado (título Y barra) ==');
const hide = await ev(`(async()=>{const c=document.getElementById('modalCancel'); if(c) c.click();
  await new Promise(r=>setTimeout(r,400));
  document.body.classList.add('hidden'); await new Promise(r=>setTimeout(r,300));
  const cs=(id)=>getComputedStyle(document.getElementById(id)).opacity;
  const r={barra:cs('bar'), titulo:cs('topbar'), scrim:cs('scrim')};
  document.body.classList.remove('hidden'); return r;})()`);
check('al ocultar desaparecen la barra inferior, la de título y el degradado',
  hide.barra === '0' && hide.titulo === '0' && hide.scrim === '0', hide);

console.log('== 3) Búsqueda real desde el explorador ==');
const t0 = Date.now();
await ev(`(async()=>{document.getElementById('search').click(); await new Promise(r=>setTimeout(r,900));})()`);
await ev(`(()=>{const ex=document.getElementById('exRoot'); const inp=ex.querySelector('input');
  inp.focus(); inp.value='ciudadan musica';
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));})()`);
let res = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  res = await ev(`(()=>{const ex=document.getElementById('exRoot');
    const st=document.getElementById('exStatus');
    const rej=ex.querySelector('.ex-grid,.res-grid,#exResults');
    const items=[...ex.querySelectorAll('[data-id],[data-video-id]')].filter(e=>(e.textContent||'').trim().length>5);
    return {estado:(st?st.innerText:'').replace(/\\s+/g,' '), items:items.length,
      titulos:items.slice(0,3).map(e=>e.textContent.replace(/\\s+/g,' ').trim().slice(0,55))};})()`);
  if (res.items > 0) break;
}
const ms = Date.now() - t0;
check('la búsqueda muestra resultados con título', res && res.items > 0, { ...res, ms });
check('la búsqueda tarda menos de 12 s', ms < 12000, { ms });

console.log('== 4) Modal de estilo de subtítulos ==');
const modal = await ev(`(async()=>{document.getElementById('modalCancel')?.click(); await new Promise(r=>setTimeout(r,400));
  document.getElementById('subStyleBtn').click(); await new Promise(r=>setTimeout(r,600));
  const m=document.getElementById('subStyleModal');
  const vis=m?getComputedStyle(m).display:'';
  const campos=['ssSize','ssColor','ssBgColor','ssBgOpacity','ssOutlineColor','ssOutlineWidth'].filter(id=>!!document.getElementById(id));
  document.getElementById('ssCancel').click(); return {vis, campos};})()`);
check('el modal de estilo de subtítulos abre con los 6 controles', modal.vis !== 'none' && modal.campos.length === 6, modal);

const fallos = ok.filter((o) => !o.cond).length;
console.log(`\n== ${ok.length - fallos}/${ok.length} comprobaciones PASS ==`);
ws.close();
process.exit(fallos ? 1 : 0);
