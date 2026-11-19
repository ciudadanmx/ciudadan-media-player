// Sonda de la UI del overlay: auto-ocultado (título vs barra) y búsqueda real.
// Uso: node tools\probe-ui.mjs [cdpPort]
// Node 22 trae WebSocket global (no hace falta el paquete 'ws').

const CDP_PORT = Number(process.argv[2] || 18133);
const API_PORT = Number(process.argv[3] || 17990);

async function json(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

const list = await json(`http://127.0.0.1:${CDP_PORT}/json/list`);
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
function cmd(method, params = {}) {
  return new Promise((resolve) => {
    const myId = ++id;
    pend.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}
async function evaluate(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

console.log('--- 1) Estado inicial de las barras');
console.log(await evaluate(`(()=>{const g=(id)=>document.getElementById(id);const cs=(id)=>getComputedStyle(g(id));
  return {bodyClass:document.body.className, bar:cs('bar').opacity, top:cs('topbar').opacity, topText:(g('topTitle')||{}).textContent};})()`));

console.log('--- 2) Forzando body.hidden (simula mouse out)');
console.log(await evaluate(`(()=>{document.body.classList.add('hidden');
  const cs=(id)=>getComputedStyle(document.getElementById(id));
  const r={bar:cs('bar').opacity, barTransform:cs('bar').transform, top:cs('topbar').opacity, scrim:cs('scrim').opacity};
  document.body.classList.remove('hidden'); return r;})()`));

console.log('--- 3) ¿Qué elementos hay y cuáles están en la parte superior?');
console.log(await evaluate(`(()=>{const r=[];document.querySelectorAll('body *').forEach(el=>{const b=el.getBoundingClientRect();
  if(b.top<50&&b.height>10&&b.width>200&&getComputedStyle(el).position==='absolute') r.push({id:el.id,cls:el.className,top:Math.round(b.top),h:Math.round(b.height),z:getComputedStyle(el).zIndex});});
  return r;})()`));

console.log('--- 4) Búsqueda real desde la UI (como el usuario)');
console.log(await evaluate(`(async()=>{const ex=document.getElementById('exRoot');
  const inp=ex.querySelector('input[type=text],input:not([type])');
  if(!inp) return {error:'no hay input', html: ex.innerHTML.slice(0,300)};
  inp.focus(); inp.value='pink floyd';
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
  const t0=Date.now();
  while(Date.now()-t0<45000){ await new Promise(r=>setTimeout(r,1000));
    const st=(ex.textContent||'');
    if(/resultado/i.test(st)&&ex.querySelectorAll('img,video').length>0) break; }
  const cards=ex.querySelectorAll('.card,.item,[data-id]');
  return {valor:inp.value, tarjetas:cards.length, texto:(ex.innerText||'').slice(0,240)};})()`));

console.log('--- 5) Consola de la página (errores)');
const logs = await evaluate(`(()=>window.__probeLogs||null)()`);
console.log(logs);
ws.close();
