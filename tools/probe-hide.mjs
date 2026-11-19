// Comprueba el auto-ocultado: mueve el ratón fuera de la ventana del overlay y
// mide qué se oculta (barra inferior, barra de título, degradado, texto).
// Uso: node tools\probe-hide.mjs [cdpPort]
import { execFileSync } from 'child_process';

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
const measure = () => ev(`(()=>{const cs=(id)=>getComputedStyle(document.getElementById(id));
 const tt=document.getElementById('topTitle');
 return {bodyClass:document.body.className, bar:cs('bar').opacity, top:cs('topbar').opacity,
   scrim:cs('scrim').opacity, titulo:(tt.textContent||'').trim(), tituloOpac:cs('topTitle').opacity,
   marcaVisible: (document.getElementById('brand')||{}).offsetParent !== null};})()`);

console.log('--- 0) Cerrando el explorador (si estaba abierto)');
console.log(await ev(`(async()=>{const c=document.getElementById('modalCancel'); if(c) c.click();
  await new Promise(r=>setTimeout(r,800)); return {bodyClass:document.body.className};})()`));

console.log('--- A) Con el ratón DENTRO de la ventana del reproductor (-1300,300):');
execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(-1300,300)']);
await new Promise((r) => setTimeout(r, 2500));
console.log(await measure());

console.log('--- B) Ratón FUERA de la ventana (monitor 1, 100,100):');
execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(100,100)']);
await new Promise((r) => setTimeout(r, 3500));
console.log(await measure());

console.log('--- C) Vuelve el ratón a la ventana:');
execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(-1300,300)']);
await new Promise((r) => setTimeout(r, 2500));
console.log(await measure());
ws.close();
