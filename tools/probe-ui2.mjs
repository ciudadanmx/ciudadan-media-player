// Prueba real de la UI: abrir el explorador, buscar y comprobar el
// auto-ocultado con el ratón fuera de la ventana.
// Uso: node tools\probe-ui2.mjs [cdpPort]
const CDP_PORT = Number(process.argv[2] || 18133);
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((p) => /yt-controls\.html/.test(p.url));
if (!page) { console.log('no hay página yt-controls'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
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

console.log('--- 1) Abrir el explorador (clic en el botón de búsqueda)');
console.log(await ev(`(async()=>{document.getElementById('search').click(); await new Promise(r=>setTimeout(r,1200));
  const ex=document.getElementById('exRoot');
  const inp=ex.querySelector('input');
  return {bodyClass:document.body.className, exHitos:ex.innerHTML.length, hayInput:!!inp,
    inputs:[...ex.querySelectorAll('input')].map(i=>({ph:i.placeholder||i.id||'', type:i.type})).slice(0,6),
    botones:[...ex.querySelectorAll('button')].map(b=>b.textContent.trim()||b.id).slice(0,12)};})()`));

console.log('--- 2) Buscar "pink floyd" desde el input del explorador');
console.log(await ev(`(async()=>{const ex=document.getElementById('exRoot'); const inp=ex.querySelector('input');
  if(!inp) return {error:'sin input'};
  inp.focus(); inp.value='pink floyd';
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  const t0=Date.now();
  while(Date.now()-t0<60000){ await new Promise(r=>setTimeout(r,1500));
    const n=ex.querySelectorAll('img,.thumb,.card,[data-id]').length;
    const txt=(ex.innerText||'');
    if(n>0||/Error|error/i.test(txt)) break; }
  return { tarjetas: ex.querySelectorAll('img,.thumb,.card,[data-id]').length,
    texto: (ex.innerText||'').replace(/\\s+/g,' ').slice(0,300) };})()`));

console.log('--- 3) Estado del overlay con el ratón FUERA de la ventana');
await ev(`document.body.classList.remove('hidden')`);
ws.close();
