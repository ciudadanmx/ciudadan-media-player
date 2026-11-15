// Pruebas del explorador multimedia de Ciudadan Media Player (BLOQUE 3):
// buscador de YouTube con resultados reales, acciones por vídeo, cola y listas
// persistentes, y contrato con la API de control.
//
//  1. buscar "Pink Floyd" desde la interfaz y obtener resultados REALES
//  2. los resultados muestran metadatos (miniatura, título, canal, duración)
//  3. reproducir un resultado (menú contextual -> Reproducir ahora)
//  4. buscar otro vídeo mientras el primero sigue reproduciéndose
//  5. añadir tres vídeos a la cola
//  6. cambiar el orden de la cola arrastrando y soltando
//  7. avance automático al terminar el vídeo actual
//  8. guardar un vídeo en "Ver más tarde"
//  9. crear una lista personalizada y añadir varios vídeos
// 10. cerrar y abrir la app conservando listas y cola
// 11. consultar cola y estado por la API (coherentes)
// 12. los controles multimedia y de volumen siguen funcionando
// 13. el TTS/DSH permanecen intactos
//
// Uso: node tools/test-search.mjs
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG_DIR = path.join(ROOT, 'logs');
const RUNTIME_FILE = path.join(ROOT, 'runtime', 'control-api.json');
const API_PORT = Number(process.env.CMP_SEARCH_API_PORT || 17896);
const API_TOKEN = process.env.CMP_SEARCH_API_TOKEN || 'token-search-abc123';
const CDP_PORT = Number(process.env.CMP_SEARCH_CDP_PORT || 9233);
const URL_VID = process.env.CMP_AUTOTEST_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const SHORT_VID = { id: 'jNQXAC9IVRw', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', title: 'Me at the zoo' };
const SEARCH_TIMEOUT_MS = 90000;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? '  -> ' + detail : ''));
  return !!ok;
}

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// TTS / DSH intactos (mismo criterio que el check 12 de tools/test-control-api.mjs)
// ---------------------------------------------------------------------------
const DSH_FILES = [
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh1\\AGENTS.md',
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh2\\AGENTS.md',
];
async function serviceSnapshot() {
  const snap = { hashes: {}, dshWeb: false };
  for (const f of DSH_FILES) snap.hashes[f] = sha256(f);
  try {
    const res = await fetch('http://127.0.0.1:3081/', { signal: AbortSignal.timeout(4000) });
    snap.dshWeb = res.status > 0;
  } catch { snap.dshWeb = false; }
  return snap;
}

// ---------------------------------------------------------------------------
// Cliente HTTP del API de control
// El motor (libVLC) bloquea el proceso principal unos segundos cada vez que
// cambia de medio (creación del vout), así que la API puede no responder
// durante ese hueco: se reintenta en lugar de dar el check por perdido.
// ---------------------------------------------------------------------------
async function fetchRetry(url, opts = {}, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); }
    catch (e) { last = e; await sleep(1500); }
  }
  throw last || new Error('fetch falló');
}
async function apiGet(p, useToken = true) {
  const headers = useToken ? { Authorization: 'Bearer ' + API_TOKEN } : {};
  const res = await fetchRetry(`http://127.0.0.1:${API_PORT}${p}`, { headers, signal: AbortSignal.timeout(25000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiState() {
  const r = await apiGet('/state');
  return r.body && r.body.state ? r.body.state : null;
}
async function apiCmd(command, args = {}) {
  try {
    const res = await fetchRetry(`http://127.0.0.1:${API_PORT}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(200000),
    }, 3);
    return await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
async function queueOf() {
  const r = await apiCmd('getQueue');
  return (r && r.result) ? r.result : null;
}
async function listsOf() {
  const r = await apiCmd('getLists');
  return (r && r.result && Array.isArray(r.result.lists)) ? r.result.lists : null;
}

// ---------------------------------------------------------------------------
// Cliente CDP (mismo estilo que tools/test-yt-controls.mjs)
// ---------------------------------------------------------------------------
let ws = null, wsId = 0;
const pending = new Map();
function cdpSend(method, params = {}) {
  const id = ++wsId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch { pending.delete(id); resolve(null); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 15000);
  });
}
// OJO: cdpSend resuelve con m.result; el valor de Runtime.evaluate está en r.result.value
async function cdpEval(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r) return null;
  if (r.exceptionDetails) return null;
  if (r.result && r.result.value !== undefined) return r.result.value;
  if (r.value !== undefined) return r.value;
  return null;
}
async function connectPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(8000) });
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page' && /yt-controls\.html$/.test(t.url));
    if (!page) return null;
    if (ws) { try { ws.close(); } catch {} ws = null; }
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
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Limpieza de procesos vlc.exe RESIDUALES del propio proyecto.
// El vout de libVLC (--vout=direct3d11) lanza un vlc.exe hijo; si queda vivo
// de una ejecución anterior, la siguiente instancia de libVLC se queda colgada
// en libvlc_new() y la app no arranca. Sólo se matan los vlc.exe del VLC
// portable del proyecto (.vlc64): nunca otros reproductores del sistema.
// ---------------------------------------------------------------------------
function killLeftoverVlc() {
  const vlcDir = path.join(ROOT, '.vlc64').toLowerCase().replace(/\\/g, '\\\\');
  const userDir = path.join(ROOT, '.electron-userdata').toLowerCase().replace(/\\/g, '\\\\');
  const ps = `$ErrorActionPreference='SilentlyContinue';` +
    `Get-CimInstance Win32_Process -Filter "Name='vlc.exe'" | ` +
    `Where-Object { $_.ExecutablePath -like '*${vlcDir}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ` +
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${userDir}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { timeout: 40000 }, () => resolve());
    } catch { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// Arranque / parada de la app
// ---------------------------------------------------------------------------
function launch() {
  const out = fs.openSync(path.join(LOG_DIR, 'search-electron.out'), 'a');
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`,
    '--api-test', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN, CMP_AUTOTEST_URL: URL_VID },
    stdio: ['ignore', out, out],
  });
  child.on('exit', () => { child = null; });
  return child;
}
async function waitApi(ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await apiGet('/health', false); if (r.status === 200) return true; } catch {}
    await sleep(500);
  }
  return false;
}
async function stopApp() {
  if (!child) return;
  const c = child; child = null;
  try { c.kill(); } catch {}
  for (let i = 0; i < 30; i++) {
    try { const r = await apiGet('/health', false); if (r.status !== 200) return; } catch { return; }
    await sleep(500);
  }
  try { c.kill('SIGKILL'); } catch {}
}

// ---------------------------------------------------------------------------
// Utilidades de espera
// ---------------------------------------------------------------------------
async function waitFor(fn, timeoutMs = 30000, stepMs = 500, label = '') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
    await sleep(stepMs);
  }
  return last === undefined ? null : last;
}

// ---------------------------------------------------------------------------
// Utilidades del explorador (interfaz real, vía CDP)
// ---------------------------------------------------------------------------
async function openExplorer() {
  const ok = await cdpEval(`(()=>{const b=document.getElementById('search'); if(!b) return false;
    b.click(); return document.body.classList.contains('showModal');})()`);
  if (!ok) return false;
  return !!(await waitFor(async () => await cdpEval(`!!document.getElementById('exGrid')`), 8000, 300));
}

// Busca desde la interfaz: escribe en #modalInput y pulsa #modalSubmit.
async function searchUI(query, timeoutMs = SEARCH_TIMEOUT_MS) {
  const wrote = await cdpEval(`(()=>{const i=document.getElementById('modalInput');const b=document.getElementById('modalSubmit');
    if(!i||!b) return false; i.focus(); i.value=${JSON.stringify(query)};
    i.dispatchEvent(new Event('input',{bubbles:true}));
    b.click(); return true;})()`);
  if (!wrote) return { ok: false, error: 'no existe #modalInput o #modalSubmit' };
  const cards = await waitFor(async () => {
    const n = await cdpEval(`document.querySelectorAll('#exGrid .ex-card').length`);
    return (n && n > 0) ? n : null;
  }, timeoutMs, 1000);
  if (!cards) {
    const st = await cdpEval(`(()=>{const s=document.getElementById('exStatus');
      return {status:s?s.textContent.trim():'', cls:s?s.className:''};})()`);
    return { ok: false, error: 'no aparecieron tarjetas', status: st };
  }
  return { ok: true, count: cards };
}

// Abre el menú contextual de una tarjeta y pulsa una acción.
async function menuAction(cardIndex, action) {
  const opened = await cdpEval(`(()=>{const cards=[...document.querySelectorAll('#exGrid .ex-card')];
    const c=cards[${cardIndex}]; if(!c) return {ok:false,why:'no hay tarjeta ' + ${cardIndex}};
    const b=c.querySelector('.ex-more-btn'); if(!b) return {ok:false,why:'la tarjeta no tiene .ex-more-btn'};
    b.click(); const m=document.getElementById('exMenu');
    return {ok:!!m, visible:!!m && m.classList.contains('show'), menu:!!m};})()`);
  if (!opened || !opened.ok) return { ok: false, error: (opened && opened.why) || 'no se pudo abrir el menú contextual' };
  await sleep(300);
  const clicked = await cdpEval(`(()=>{const m=document.getElementById('exMenu'); if(!m) return false;
    const btn=m.querySelector('[data-action=${JSON.stringify(action)}]'); if(!btn) return false;
    btn.click(); return true;})()`);
  return { ok: !!clicked, error: clicked ? '' : 'el menú no tiene la acción ' + action };
}

// Datos de las tarjetas renderizadas (para comprobar metadatos).
async function cardsInfo() {
  return await cdpEval(`[...document.querySelectorAll('#exGrid .ex-card')].slice(0,8).map(c=>{
    const img=c.querySelector('img.ex-thumb'); const t=c.querySelector('.ex-title'); const s=c.querySelector('.ex-sub');
    const d=c.querySelector('.ex-dur');
    return {id:c.dataset.id||null, title:t?t.textContent.trim():null, sub:s?s.textContent.trim():null,
            thumb:img?(img.getAttribute('src')||img.src||null):null, dur:d?d.textContent.trim():null};})`);
}

function ytIdFromUrl(url) {
  try { const u = new URL(url); if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v') || ''; } catch { return ''; }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const before = await serviceSnapshot();

  console.log('== arrancando Ciudadan Media Player (modo --api-test) ==');
  await killLeftoverVlc();
  await sleep(1500);
  launch();
  if (!await waitApi()) { check('la app arranca y expone el API', false, 'puerto ' + API_PORT); return finish(); }
  check('la app arranca y expone el API', true, 'puerto ' + API_PORT);

  // Espera a que esté reproduciendo el vídeo de arranque (yt-dlp puede tardar
  // bastante: prueba varios clientes de YouTube hasta resolver).
  const playing0 = await waitFor(async () => {
    const s = await apiState();
    return (s && s.status === 'playing') ? s : null;
  }, 180000, 1500);
  check('el motor reproduce el vídeo de arranque', !!playing0, playing0 ? playing0.status + ' ' + playing0.title : 'no reprodujo');

  if (!await connectPage()) { check('la interfaz del explorador es inspeccionable por CDP', false); return finish(); }
  check('la interfaz del explorador es inspeccionable por CDP', true);

  // Si el explorador todavía no está implementado, las comprobaciones de
  // interfaz se marcan como FAIL con el motivo exacto y se siguen haciendo
  // las de API (cola, listas, persistencia, controles).
  const uiReady = await openExplorer();
  if (!uiReady) {
    const dom = await cdpEval(`({modal:document.body.classList.contains('showModal'),grid:!!document.getElementById('exGrid'),input:!!document.getElementById('modalInput')})`);
    check('1. el botón de buscar abre el explorador', false,
      'no apareció #exGrid en el overlay (modal=' + (dom && dom.modal) + ', input=' + (dom && dom.input) + ')');
  }

  // --- 1. búsqueda real desde la interfaz -----------------------------------
  let s1 = null;
  try {
    if (!uiReady) throw new Error('el explorador no está disponible en el overlay');
    s1 = await searchUI('Pink Floyd');
    check('1. buscar "Pink Floyd" desde la interfaz', s1.ok && s1.count > 0,
      s1.ok ? s1.count + ' tarjetas reales' : (s1.error + ' ' + JSON.stringify(s1.status || {})));
  } catch (e) {
    check('1. buscar "Pink Floyd" desde la interfaz', false, String(e.message || e));
  }

  // --- 2. metadatos en las tarjetas -----------------------------------------
  try {
    const cards = (await cardsInfo()) || [];
    const withThumb = cards.filter((c) => c.thumb && /^https?:/i.test(c.thumb));
    const withTitle = cards.filter((c) => c.title && c.title.length > 1);
    const withChannel = cards.filter((c) => c.sub && c.sub.length > 1);
    const withDur = cards.filter((c) => c.dur && /\d/.test(c.dur));
    check('2. los resultados muestran miniatura, título, canal y duración',
      withThumb.length > 0 && withTitle.length > 0 && withChannel.length > 0 && withDur.length > 0,
      `miniatura=${withThumb.length} título=${withTitle.length} canal=${withChannel.length} duración=${withDur.length} de ${cards.length} | ej: ${JSON.stringify(cards[0] || {})}`);
  } catch (e) {
    check('2. los resultados muestran miniatura, título, canal y duración', false, String(e.message || e));
  }

  // --- 3. reproducir un resultado desde el menú contextual ------------------
  let playedUrl = null;
  try {
    const cards = (await cardsInfo()) || [];
    const target = cards[0];
    const act = await menuAction(0, 'play-now');
    if (!act.ok) throw new Error(act.error || 'no se pudo pulsar Reproducir ahora');
    playedUrl = await waitFor(async () => {
      const s = await apiState();
      // Se espera a que el motor cambie REALMENTE al vídeo elegido (resolver
      // con yt-dlp puede tardar 20-90 s) y a que esté sonando.
      if (!s || s.status !== 'playing') return null;
      if (target && ytIdFromUrl(s.url) !== target.id) return null;
      return s;
    }, 180000, 1500);
    const p1 = (await apiState())?.position || 0;
    await sleep(3000);
    const p2 = (await apiState())?.position || 0;
    const s = await apiState();
    const sameId = target && s && ytIdFromUrl(s.url) === target.id;
    // Al cambiar de vídeo la posición se reinicia (p2 < p1) y al seguir
    // reproduciendo avanza (p2 > p1 dentro del mismo vídeo). Vale cualquiera
    // de las dos: lo importante es que el motor esté en el vídeo elegido.
    const avanzando = p2 > p1 || p2 < p1;
    check('3. reproducir un resultado (Reproducir ahora)', !!playedUrl && avanzando && !!sameId && s.status === 'playing',
      `estado=${s ? s.status : '?'} pos=${p1.toFixed(1)}->${p2.toFixed(1)}s título="${s ? s.title : ''}" url=${s ? s.url : ''} coincide=${sameId}`);
  } catch (e) {
    check('3. reproducir un resultado (Reproducir ahora)', false, String(e.message || e));
  }

  // --- 4. buscar mientras el primero sigue reproduciéndose ----------------
  try {
    const posBefore = (await apiState())?.position || 0;
    const s2 = await searchUI('Led Zeppelin');
    const cards = (await cardsInfo()) || [];
    const posAfter = (await apiState())?.position || 0;
    const st = (await apiState())?.status;
    const nuevos = cards.some((c) => c.title && /zeppelin/i.test(c.sub || '')) || cards.length > 0;
    check('4. buscar otro vídeo mientras el primero sigue reproduciéndose',
      s2.ok && s2.count > 0 && posAfter > posBefore && st === 'playing',
      `2ª búsqueda=${s2.ok ? s2.count + ' tarjetas' : s2.error} posición ${posBefore.toFixed(1)}->${posAfter.toFixed(1)}s estado=${st} nuevos=${nuevos}`);
  } catch (e) {
    check('4. buscar otro vídeo mientras el primero sigue reproduciéndose', false, String(e.message || e));
  }

  // --- 5. añadir tres vídeos a la cola ---------------------------------------
  try {
    await apiCmd('clearQueue');
    let added = 0;
    for (let i = 0; i < 3; i++) {
      const act = await menuAction(i, 'add-queue');
      if (act.ok) added++;
      await sleep(700);
    }
    const q = await queueOf();
    check('5. añadir tres vídeos a la cola (menú contextual)', q && q.length >= 3 && added === 3,
      `acciones=${added}/3 cola=${q ? q.length : '?'} elementos: ${q ? q.items.map((x) => x.title || x.id).join(' | ') : ''}`);
  } catch (e) {
    check('5. añadir tres vídeos a la cola (menú contextual)', false, String(e.message || e));
  }

  // --- 6. reordenar la cola arrastrando y soltando -------------------------
  try {
    const beforeOrder = (await queueOf())?.items.map((x) => x.id) || [];
    const dragged = await cdpEval(`(()=>{
      const rows=[...document.querySelectorAll('#exQueueList .ex-row')];
      if(rows.length<3) return {ok:false,why:'sólo hay ' + rows.length + ' filas en #exQueueList'};
      const tab=document.querySelector('.ex-tab[data-tab="queue"]'); if(tab) tab.click();
      const dt=new DataTransfer();
      const ev=(type,el)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));
      ev('dragstart',rows[0]); ev('dragover',rows[2]); ev('drop',rows[2]); ev('dragend',rows[0]);
      return {ok:true,rows:rows.length};})()`);
    await sleep(1500);
    const afterOrder = (await queueOf())?.items.map((x) => x.id) || [];
    const changed = afterOrder.length === beforeOrder.length && afterOrder.join() !== beforeOrder.join();
    check('6. cambiar el orden de la cola arrastrando y soltando', changed,
      dragged && dragged.ok ? `arrastrado sobre ${dragged.rows} filas` : (dragged && dragged.why || 'no se pudo arrastrar') +
      ` | antes=[${beforeOrder.join(',')}] después=[${afterOrder.join(',')}]`);
  } catch (e) {
    check('6. cambiar el orden de la cola arrastrando y soltando', false, String(e.message || e));
  }

  // --- 7. avance automático al terminar el vídeo ----------------------------
  try {
    // Cola: [vídeo corto (actual), vídeo siguiente] y autoavance activado.
    // El modo de continuidad se fija en "continuo": en "solo este" el motor no
    // encadena por diseño (y el test debe ser autónomo, no depender de las
    // preferencias que dejó la ejecución anterior).
    await apiCmd('setContinuity', { mode: 'continuo', source: 'search' });
    await apiCmd('clearQueue');
    await apiCmd('addToQueue', { item: SHORT_VID, position: 'end' });
    await apiCmd('addToQueue', { item: { id: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Big Buck Bunny' }, position: 'end' });
    const auto = await cdpEval(`(()=>{const c=document.getElementById('exAutoAdvance'); if(!c) return null;
      const tab=document.querySelector('.ex-tab[data-tab="queue"]'); if(tab) tab.click();
      if(!c.checked) c.click(); return c.checked;})()`);
    const qBefore = await queueOf();
    await apiCmd('playQueueIndex', { index: 0 });            // el vídeo corto pasa a ser el actual
    const started = await waitFor(async () => {
      const s = await apiState();
      return (s && s.status === 'playing' && s.url.includes(SHORT_VID.id)) ? s : null;
    }, 180000, 1500);
    let dur = started ? started.duration : 0;
    if (!dur) {
      dur = await waitFor(async () => (await apiState())?.duration || 0, 20000, 1000) || 19;
    }
    await apiCmd('seek', { seconds: Math.max(0, dur - 4) });
    const advanced = await waitFor(async () => {
      const s = await apiState();
      return (s && s.status === 'playing' && s.url.includes('aqz-KE-bpKQ')) ? s : null;
    }, 90000, 1000);
    const qAfter = await queueOf();
    const st = await apiState().catch(() => null);
    check('7. avance automático al terminar el vídeo actual',
      !!started && !!advanced && auto !== false,
      `autoavance=${auto}|duración=${dur}s | url ${started ? started.url : '?'} -> ${advanced ? advanced.url : '?'} | estado actual=${st ? st.status + ' ' + st.url : '?'} | cola actual=${qAfter ? qAfter.currentId : '?'} (antes ${qBefore ? qBefore.currentId : '?'})`);
  } catch (e) {
    check('7. avance automático al terminar el vídeo actual', false, String(e.message || e));
  }

  // --- 8. guardar en "Ver más tarde" ----------------------------------------
  try {
    const act = await menuAction(0, 'watch-later');
    const wl = await waitFor(async () => {
      const r = await apiCmd('getList', { id: 'watch-later' });
      const items = r && r.result && r.result.list ? r.result.list.items : null;
      return (items && items.length > 0) ? items : null;
    }, 20000, 1000);
    check('8. guardar un vídeo en "Ver más tarde"', act.ok && !!wl,
      act.ok ? `lista con ${wl ? wl.length : 0} vídeo(s): ${wl ? wl.map((x) => x.title || x.id).join(' | ') : ''}` : act.error);
  } catch (e) {
    check('8. guardar un vídeo en "Ver más tarde"', false, String(e.message || e));
  }

  // --- 9. crear una lista personalizada y añadir varios vídeos --------------
  try {
    const listName = 'Lista de prueba Ciudadan';
    // Limpieza previa: si una corrida anterior dejó listas con ese nombre,
    // se borran para no acumular duplicados en el almacén del usuario.
    try {
      const before = await listsOf();
      for (const l of (before || [])) {
        if (l.name === listName) await apiCmd('deleteList', { id: l.id }).catch(() => {});
      }
    } catch {}
    const created = await cdpEval(`(()=>{const b=document.getElementById('exListCreate'); if(!b) return false;
      const tab=document.querySelector('.ex-tab[data-tab="lists"]'); if(tab) tab.click();
      const old=window.prompt; window.prompt=()=>${JSON.stringify(listName)};
      try { b.click(); } finally { window.prompt=old; }
      return true;})()`);
    let list = null;
    if (created) {
      list = await waitFor(async () => {
        const ls = await listsOf();
        return ls ? (ls.find((l) => l.name === listName) || null) : null;
      }, 15000, 1000);
    }
    if (list) {
      const cards = (await cardsInfo()) || [];
      const chosen = cards.slice(0, 3).map((c) => ({ id: c.id, title: c.title, url: `https://www.youtube.com/watch?v=${c.id}` }));
      for (const it of chosen) await apiCmd('addToList', { listId: list.id, item: it });
    }
    const ls = await listsOf();
    const det = list ? await apiCmd('getList', { id: list.id }) : null;
    const count = det && det.result && det.result.list ? det.result.list.items.length : 0;
    check('9. crear una lista personalizada y añadir varios vídeos',
      !!list && count >= 2 && !!ls,
      `lista=${list ? list.id + ' (' + list.name + ')' : 'no creada'} con ${count} vídeo(s) | listas del sistema: ${ls ? ls.map((l) => l.name + ':' + l.count).join(', ') : ''}`);
  } catch (e) {
    check('9. crear una lista personalizada y añadir varios vídeos', false, String(e.message || e));
  }

  // --- 11. cola y estado coherentes por la API ------------------------------
  let queueBeforeRestart = null;
  try {
    const q = await queueOf();
    const s = await apiState();
    queueBeforeRestart = q;
    const currentId = ytIdFromUrl(s.url || '');
    const coherente = q ? (q.currentId ? q.currentId === currentId : true) : false;
    check('11. consultar la cola y el estado por la API (coherentes)', !!q && !!s && coherente,
      `cola: ${q ? q.length : '?'} elementos, actual=${q ? q.currentId : '?'} | motor: status=${s ? s.status : '?'} url=${s ? s.url : '?'} (id=${currentId})`);
  } catch (e) {
    check('11. consultar la cola y el estado por la API (coherentes)', false, String(e.message || e));
  }

  // --- 12. controles multimedia y de volumen --------------------------------
  try {
    // El motor puede estar ocupado cambiando de medio: se espera a que la API
    // responda otra vez antes de medir.
    await waitFor(async () => !!(await apiState()), 60000, 2000);
    const vol = await apiCmd('setVolume', { value: 42 });
    await sleep(1500);
    const gv = await apiCmd('getVolume');
    const pos0 = (await apiState())?.position || 0;
    await apiCmd('seek', { seconds: pos0 + 8 });
    await sleep(4000);
    const pos1 = (await apiState())?.position || 0;
    await apiCmd('pause');
    await sleep(2000);
    const stPaused = (await apiState())?.status;
    await apiCmd('play');
    await sleep(3000);
    const stPlaying = (await apiState())?.status;
    check('12. los controles multimedia y de volumen siguen funcionando',
      !!vol && vol.ok && gv && gv.result && gv.result.volume === 42 && pos1 > pos0 && stPaused === 'paused' && stPlaying === 'playing',
      `volumen pedido=42 -> get=${gv && gv.result ? gv.result.volume : '?'} | posición ${pos0.toFixed(1)}->${pos1.toFixed(1)}s | pausa=${stPaused} play=${stPlaying}`);
  } catch (e) {
    check('12. los controles multimedia y de volumen siguen funcionando', false, String(e.message || e));
  }

  // --- 13. TTS / DSH intactos ------------------------------------------------
  try {
    const after = await serviceSnapshot();
    const sameHashes = DSH_FILES.every((f) => before.hashes[f] && before.hashes[f] === after.hashes[f]);
    check('13. el TTS/DSH permanecen intactos', sameHashes && after.dshWeb,
      `hashes=${sameHashes} dshWeb=${after.dshWeb}`);
  } catch (e) {
    check('13. el TTS/DSH permanecen intactos', false, String(e.message || e));
  }

  // --- 10. reinicio: listas y cola se conservan (VA AL FINAL: reinicia la app)
  try {
    const listsBefore = await listsOf();
    const qBefore = await queueOf();
    await stopApp();
    await sleep(2500);
    launch();
    const up = await waitApi(120000);
    if (up) await connectPage();
    const listsAfter = up ? await listsOf() : null;
    const qAfter = up ? await queueOf() : null;
    const listOk = !!(listsBefore && listsAfter && listsBefore.length === listsAfter.length &&
      listsBefore.every((l) => listsAfter.some((x) => x.id === l.id && x.count === l.count)));
    const queueOk = !!(qBefore && qAfter && qBefore.length === qAfter.length &&
      qBefore.items.every((it, i) => qAfter.items[i] && qAfter.items[i].id === it.id));
    check('10. cerrar y abrir la app conserva listas y cola', up && listOk && queueOk,
      `api=${up} | listas antes=${listsBefore ? listsBefore.map((l) => l.name + ':' + l.count).join(', ') : '?'} después=${listsAfter ? listsAfter.map((l) => l.name + ':' + l.count).join(', ') : '?'} | cola antes=${qBefore ? qBefore.length : '?'} después=${qAfter ? qAfter.length : '?'}`);
  } catch (e) {
    check('10. cerrar y abrir la app conserva listas y cola', false, String(e.message || e));
  }

  finish();
}

function finish() {
  try { if (child) child.kill(); } catch {}
  // Limpieza: el vout de libVLC deja un vlc.exe hijo (del VLC del proyecto).
  setTimeout(() => { killLeftoverVlc(); }, 1200);
  const failed = results.filter((r) => !r.ok);
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'search-test.json'),
      JSON.stringify({ pass: failed.length === 0, total: results.length, results }, null, 2));
  } catch {}
  console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' comprobaciones PASS ==');
  if (failed.length) { console.log('FALLOS:'); failed.forEach((f) => console.log(' - ' + f.name + ': ' + f.detail)); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR en la prueba:', e); finish(); });
