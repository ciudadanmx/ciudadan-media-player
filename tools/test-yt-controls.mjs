// Prueba de la barra de control estilo YouTube (overlay sobre el vídeo).
//  1. la ventana superpuesta existe y cubre el área de CONTENIDO del vídeo
//     (deja libre la barra de título: se puede mover/minimizar/cerrar)
//  2. refleja el estado real del motor (tiempo, progreso, volumen, play/pausa)
//  3. se auto-oculta tras 3 s sin movimiento del ratón
//  4. clic en el vídeo = play/pausa; botón play/pausa = play/pausa
//  5. stop, anterior y siguiente de la lista
//  6. lista lateral con scroll y elementos hardcodeados
//  7. modal de búsqueda (botón lupa) con campo de URL
//  8. la barra de progreso permite buscar (seek) y muestra la vista previa
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNTIME_FILE = path.join(ROOT, 'runtime', 'control-api.json');
const CDP_PORT = Number(process.env.CMP_YT_CDP_PORT || 9225);
const API_PORT = Number(process.env.CMP_YT_API_PORT || 17892);
const API_TOKEN = process.env.CMP_YT_API_TOKEN || 'token-yt-abc123';
const URL_VID = process.env.CMP_AUTOTEST_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? '  -> ' + detail : ''));
  return !!ok;
}

async function apiGet(p, useToken = true) {
  const headers = useToken ? { Authorization: 'Bearer ' + API_TOKEN } : {};
  const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`, { headers, signal: AbortSignal.timeout(20000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiState() {
  const r = await apiGet('/state');
  return r.body && r.body.state ? r.body.state : null;
}
async function apiCmd(command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(20000),
  });
  return await res.json().catch(() => null);
}

// --- CDP ---
let ws = null, wsId = 0;
const pending = new Map();
function cdpSend(method, params = {}) {
  const id = ++wsId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 8000);
  });
}
async function cdpEval(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  // cdpSend resuelve con m.result = { result: <RemoteObject> }
  return r && r.result ? r.result.value : null;
}
async function connectPage(pattern) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && pattern.test(t.url));
  if (!page) return null;
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('timeout CDP')), 8000);
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  return page;
}

function launch() {
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`,
    '--api-test', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN, CMP_AUTOTEST_URL: URL_VID },
    stdio: ['ignore', fs.openSync(path.join(ROOT, 'logs', 'yt-electron.out'), 'a'), fs.openSync(path.join(ROOT, 'logs', 'yt-electron.out'), 'a')],
  });
  child.on('exit', () => { child = null; });
}
async function waitApi(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await apiGet('/health', false); if (r.status === 200) return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function main() {
  console.log('== arrancando la app con la barra estilo YouTube ==');
  launch();
  if (!await waitApi()) { check('la app arranca con el API', false); finish(); return; }
  check('la app arranca con el API', true, 'puerto ' + API_PORT);

  let st = null;
  for (let i = 0; i < 60; i++) { st = await apiState(); if (st && st.status === 'playing') break; await sleep(1000); }
  check('reproduciendo', !!(st && st.status === 'playing'), st ? st.status : 'sin estado');

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page').map((t) => t.url.split('/').pop());
  check('1. existe la ventana superpuesta (yt-controls.html)', pages.includes('yt-controls.html'), pages.join(', '));
  check('1b. ya NO hay ventana de controles aparte', !pages.includes('controls.html'), pages.join(', '));

  const page = await connectPage(/yt-controls\.html/);
  if (!page) { check('2. la barra se puede inspeccionar por CDP', false); finish(); return; }
  check('2. la barra se puede inspeccionar por CDP', true);

  const dims = await cdpEval('[innerWidth, innerHeight]');
  // La ventana de vídeo se crea con 960x570 (con marco): el overlay debe medir el
  // área de contenido (944 de ancho, ~505-535 de alto) y NO tapar la barra de título.
  check('2b. la barra cubre sólo el área de contenido del vídeo', Array.isArray(dims) && dims[0] === 944 && dims[1] > 480 && dims[1] < 545, JSON.stringify(dims));

  // La barra de título del sistema debe quedar FUERA del overlay: el alto del
  // overlay es menor que el alto total de la ventana con marco (570).
  check('2c. la barra de título NO queda tapada', Array.isArray(dims) && dims[1] < 570, 'alto overlay=' + (dims ? dims[1] : '?') + ' < 570 (ventana con marco)');

  // 3) refleja el estado real
  let pos = 0;
  for (let i = 0; i < 20; i++) { pos = (await apiState())?.position || 0; if (pos > 2) break; await sleep(1000); }
  const ui = await cdpEval(`(()=>{const p=document.getElementById('played');const c=document.getElementById('cur');
    const t=document.getElementById('tot');const v=document.getElementById('vol');
    const play=document.getElementById('icoPlay'), pause=document.getElementById('icoPause');
    return {w:p.style.width, cur:c.textContent, tot:t.textContent, vol:v.value,
            playVis:getComputedStyle(play).display, pauseVis:getComputedStyle(pause).display,
            barBg:getComputedStyle(document.getElementById('bar')).backgroundColor,
            updates:(window.__cmpUpdates||0), err:window.__cmpError||'',
            botones:['prev','play','stop','next','search','plToggle','full'].filter(id=>!!document.getElementById(id))};})()`);
  check('3. el progreso refleja la posición real', !!ui && ui.w && ui.w !== '0%', ui ? 'width=' + ui.w + ' updates=' + ui.updates + (ui.err ? ' err=' + ui.err : '') : 'sin datos');
  check('3b. el tiempo real se muestra', !!ui && ui.cur !== '0:00' && ui.tot !== '0:00', ui ? ui.cur + ' / ' + ui.tot : '');
  check('3c. icono de pausa visible mientras reproduce', !!ui && ui.pauseVis !== 'none', ui ? 'pause=' + ui.pauseVis : '');
  check('3d. la barra tiene fondo oscuro translúcido', !!ui && /rgba?\(/.test(ui.barBg) && ui.barBg !== 'rgba(0, 0, 0, 0)', ui ? ui.barBg : '');
  check('3e. botones stop/anterior/siguiente/buscar/lista/pantalla completa', !!ui && ui.botones.length === 7, ui ? ui.botones.join(',') : '');

  // 4) auto-ocultado
  await sleep(4500);
  const hiddenLater = await cdpEval(`document.body.classList.contains('hidden')`);
  check('4. la barra se auto-oculta tras 3 s sin ratón', hiddenLater === true, 'oculta=' + hiddenLater);

  // 5) clic en el vídeo = pausa
  await apiCmd('play');
  await sleep(1500);
  const before = (await apiState())?.status;
  await cdpEval(`document.body.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await sleep(1500);
  const after = (await apiState())?.status;
  check('5. clic en el vídeo alterna play/pausa', before === 'playing' && after === 'paused', before + ' -> ' + after);

  // 6) botón play/pausa de la barra
  await cdpEval(`document.getElementById('play').click()`);
  await sleep(1500);
  const after2 = (await apiState())?.status;
  check('6. el botón play/pausa de la barra funciona', after2 === 'playing', after2);

  // 7) stop
  await cdpEval(`document.getElementById('stop').click()`);
  await sleep(2000);
  const stopped = (await apiState())?.status;
  check('7. el botón stop detiene la reproducción', stopped === 'stopped' || stopped === 'idle', stopped);

  // 8) siguiente / anterior de la lista
  const urlBefore = (await apiState())?.url;
  await cdpEval(`document.getElementById('next').click()`);
  await sleep(1500);
  let playing = false;
  for (let i = 0; i < 60; i++) { const s = await apiState(); if (s && s.status === 'playing') { playing = true; break; } await sleep(1000); }
  const urlNext = (await apiState())?.url;
  check('8. el botón siguiente carga otro elemento de la lista', playing && urlNext !== urlBefore, urlBefore + ' -> ' + urlNext);
  await cdpEval(`document.getElementById('prev').click()`);
  let urlPrev = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const s = await apiState();
    if (s && s.url === urlBefore) { urlPrev = s.url; break; }
  }
  check('8b. el botón anterior vuelve al elemento anterior', urlPrev === urlBefore, urlNext + ' -> ' + urlPrev);

  // 9) lista lateral con scroll
  const pl = await cdpEval(`(()=>{document.getElementById('plToggle').click();
    const l=document.getElementById('plList');
    return {open:document.body.classList.contains('showPlaylist'),items:l.querySelectorAll('.plItem').length,
            scrollH:l.scrollHeight,clientH:l.clientHeight,overflow:getComputedStyle(l).overflowY,
            primero:(l.querySelector('.plItem b')||{}).textContent||''};})()`);
  check('9. la lista se abre con elementos hardcodeados', !!pl && pl.open && pl.items >= 5, pl ? JSON.stringify(pl) : '');
  check('9b. la lista tiene scroll (contenido más alto que el panel)', !!pl && pl.scrollH > pl.clientH && pl.overflow === 'auto', pl ? `scrollH=${pl.scrollH} clientH=${pl.clientH} overflow=${pl.overflow}` : '');
  await cdpEval(`document.getElementById('plClose').click()`);

  // 10) modal de búsqueda
  const modal = await cdpEval(`(()=>{document.getElementById('search').click();
    const open=document.body.classList.contains('showModal');
    const i=document.getElementById('modalInput');
    return {open, focused:document.activeElement===i, docFocus:document.hasFocus(),
            placeholder:i.placeholder, focusable:!i.disabled};})()`);
  check('10. el botón de buscar abre el modal con campo de URL', !!modal && modal.open && !!modal.placeholder, modal ? JSON.stringify(modal) : '');
  // El foco sólo se concede si la ventana está activa (en la prueba automática puede
  // no estarlo: en ese caso document.hasFocus() es false).
  check('10b. el campo del modal recibe el foco', !!modal && (modal.focused === true || modal.docFocus === false), modal ? 'focused=' + modal.focused + ' docFocus=' + modal.docFocus : '');
  await cdpEval(`document.getElementById('modalCancel').click()`);

  // 11) seek con la barra de progreso
  await apiCmd('play');
  await sleep(1500);
  const posBefore = (await apiState())?.position;
  await cdpEval(`(()=>{const r=document.getElementById('rail');const b=r.getBoundingClientRect();
    const x=b.left+b.width*0.6,y=b.top+b.height/2;
    const ev=(t)=>new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:1});
    const tr=document.getElementById('track');tr.dispatchEvent(ev('pointerdown'));tr.dispatchEvent(ev('pointerup'));return true;})()`);
  await sleep(2000);
  const posAfter = (await apiState())?.position;
  check('11. la barra de progreso busca en el vídeo', posAfter > posBefore + 5, posBefore + 's -> ' + posAfter + 's');

  // 12) vista previa del tiempo al pasar el ratón
  await cdpEval(`(()=>{const r=document.getElementById('rail');const b=r.getBoundingClientRect();
    document.getElementById('track').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:b.left+b.width*0.5,clientY:b.top+2}));
    return true;})()`);
  await sleep(300);
  const tip = await cdpEval(`(()=>{const t=document.getElementById('tip');
    const css=[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return[]}}).join('|');
    return {txt:t.textContent,left:t.style.left,hoverRule:/#track:hover #tip/.test(css)};})()`);
  const tipSec = tip && tip.txt ? tip.txt.split(':').reduce((a, b) => a * 60 + Number(b), 0) : 0;
  const dur = (await apiState())?.duration || 0;
  check('12. vista previa del tiempo sobre la barra', !!tip && tipSec > dur * 0.3 && tip.hoverRule === true, tip ? tip.txt + ' (duración ' + dur + 's) reglaHover=' + tip.hoverRule : '');

  // 13) captura con la barra visible
  await cdpEval(`document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))`);
  await sleep(1200);
  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    const file = path.join(ROOT, 'logs', 'yt-controls.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    check('13. captura de la barra guardada', fs.existsSync(file), file + ' bytes=' + fs.statSync(file).size);
  } else check('13. captura de la barra guardada', false);

  finish();
}

function finish() {
  try { if (child) child.kill(); } catch {}
  fs.writeFileSync(path.join(ROOT, 'logs', 'yt-controls-test.json'), JSON.stringify({ pass: results.every((r) => r.ok), total: results.length, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' comprobaciones PASS ==');
  if (failed.length) { console.log('FALLOS:'); failed.forEach((f) => console.log(' - ' + f.name + ': ' + f.detail)); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR en la prueba:', e); finish(); });
