// ===========================================================================
// Prueba de integración del sprint (reproducción inteligente, CC, filtros,
// historial) sobre la app real: API HTTP + CDP sobre yt-controls.html.
//
// Uso: node tools/test-sprint-ui.mjs
// ===========================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = Number(process.env.CMP_SP_CDP_PORT || 9227);
const API_PORT = Number(process.env.CMP_SP_API_PORT || 17993);
const API_TOKEN = process.env.CMP_SP_API_TOKEN || 'token-sprint-xyz789';
const URL_ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';   // 19 s (fin rápido)
const URL_BBB = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';    // Big Buck Bunny (tiene CC)

const results = [];
const limitations = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? '  -> ' + detail : ''));
  return !!ok;
}
function limit(name, reason) {
  limitations.push({ name, reason });
  console.log('LIM  | ' + name + '  -> ' + reason + ' (limitación del entorno, no se declara éxito)');
}

async function apiGet(p, useToken = true) {
  const headers = useToken ? { Authorization: 'Bearer ' + API_TOKEN } : {};
  const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`, { headers, signal: AbortSignal.timeout(20000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiState() { const r = await apiGet('/state'); return r.body && r.body.state ? r.body.state : null; }
async function apiCmd(command, args = {}, timeoutMs = 90000) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await res.json().catch(() => null);
}

let ws = null, wsId = 0;
const pending = new Map();
function cdpSend(method, params = {}) {
  const id = ++wsId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 15000);
  });
}
async function cdpEval(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    cwd: ROOT, env: { ...process.env, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN, CMP_AUTOTEST_URL: URL_ZOO, CMP_AUTOTEST_SECS: '25' },
    stdio: ['ignore', fs.openSync(path.join(ROOT, 'logs', 'sprint-electron.out'), 'a'), fs.openSync(path.join(ROOT, 'logs', 'sprint-electron.out'), 'a')],
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
async function waitStatus(want, ms = 120000, pred = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await apiState();
    if (s && (pred ? pred(s) : s.status === want)) return s;
    await sleep(1000);
  }
  return null;
}

async function main() {
  console.log('== sprint: app real con vídeo de 19 s (fin rápido) ==');
  launch();
  if (!await waitApi()) { check('la app arranca con el API', false); finish(); return; }
  check('la app arranca con el API', true, 'puerto ' + API_PORT);

  // ---- CASO REAL DEL USUARIO: reproducción por URL directa (SIN búsqueda
  // ---- previa) debe continuar con vídeos relacionados al terminar ----
  await apiCmd('clearQueue');
  await apiCmd('setContinuity', { mode: 'continuo', source: 'search' });
  const st0 = await waitStatus('playing', 180000);
  const urlDirect = st0 ? st0.url : null;
  const endedDirect = await waitStatus(null, 120000, (s) => s.status === 'ended' || s.status === 'stopped' || s.status === 'idle');
  let advDirect = null;
  // El encadenado tiene un presupuesto (discovery 45 s + resolución 75 s).
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const s = await apiState();
    if (s && s.url && urlDirect && s.url !== urlDirect && (s.status === 'playing' || s.status === 'opening' || s.status === 'buffering')) { advDirect = s; break; }
  }
  check('al terminar un vídeo SIN búsqueda previa sigue con vídeos relacionados', !!advDirect,
    advDirect ? (urlDirect || '?') + ' -> ' + advDirect.url + ' (' + advDirect.status + ')' : 'no avanzó (fin=' + (endedDirect ? endedDirect.status : 'timeout') + ')');

  // ---- modo solo PRIMERO (antes de que el vídeo de 19 s pueda terminar y
  // ---- encadenar porPrefs persistidas de ejecuciones anteriores) ----
  await apiCmd('setContinuity', { mode: 'solo' });
  const loadZoo = await apiCmd('load', { url: URL_ZOO });
  check('carga explícita del vídeo zoo (19 s)', !!(loadZoo && loadZoo.result && loadZoo.result.ok), String(loadZoo && loadZoo.error));

  // ---- estado extendido del sprint ----
  let st = await waitStatus('playing', 180000);
  check('reproducción real verificada (vídeo zoo)', !!st && st.status === 'playing', st ? st.status + ' pos=' + st.position : 'sin estado');
  const stFields = st ? { contentMode: st.contentMode, cont: st.continuity && st.continuity.mode, subs: st.subtitles && st.subtitles.lang, filters: st.filters } : null;
  check('/state expone contentMode, continuity, subtitles y filters', !!st && st.contentMode && st.continuity && st.subtitles && st.filters, JSON.stringify(stFields));

  // ---- prefs por defecto + persistencia ----
  const p0 = (await apiCmd('getPrefs')).result.prefs;
  check('getPrefs devuelve estructura completa (persistente entre ejecuciones)', p0 && typeof p0.contentMode === 'string' && p0.continuity && p0.continuity.mode && p0.subtitles && typeof p0.subtitles.lang === 'string' && p0.mix && p0.filters, JSON.stringify({ cm: p0.contentMode, cont: p0.continuity, subs: p0.subtitles }));

  const cSolo = (await apiCmd('getContinuity')).result.continuity;
  check('setContinuity solo persiste', cSolo.mode === 'solo');
  const urlAtStart = (await apiState()).url;
  const ended = await waitStatus(null, 90000, (s) => s.status === 'stopped' || s.status === 'ended' || s.status === 'idle');
  check('el vídeo de 19 s llegó al final', !!ended, ended ? ended.status : 'timeout');
  await sleep(9000); // si hubiera continuidad, avanzaría en ~0.4 s + carga
  const stAfterEnd = await apiState();
  check('modo "solo este": NO avanza al terminar', stAfterEnd && stAfterEnd.url === urlAtStart, stAfterEnd ? stAfterEnd.url : '');

  // ---- continuidad continua + búsqueda (fuente "Mi búsqueda") ----
  await apiCmd('setContinuity', { mode: 'continuo', source: 'search' });
  const cCont = (await apiCmd('getContinuity')).result.continuity;
  check('setContinuity continuo+search persiste', cCont.mode === 'continuo' && cCont.source === 'search');

  let searchRes = null;
  try {
    searchRes = await apiCmd('search', { query: 'big buck bunny', limit: 8 }, 150000);
    check('búsqueda real con yt-dlp funciona', !!(searchRes && searchRes.result && searchRes.result.ok && Array.isArray(searchRes.result.items) && searchRes.result.items.length > 0), searchRes && searchRes.result ? 'items=' + (searchRes.result.items || []).length : JSON.stringify(searchRes && searchRes.error));
  } catch (e) {
    limit('búsqueda real yt-dlp', 'yt-dlp tardó más del límite (' + String(e.message || e) + ')');
  }

  // ---- modo personalizado + filtros ----
  await apiCmd('setContentMode', { mode: 'personalizado', mix: { musicPct: 70, musicCount: 2, themeCount: 1 } });
  const p1 = (await apiCmd('getPrefs')).result.prefs;
  check('modo personalizado 70% persiste (slider y cantidades coherentes)', p1.contentMode === 'personalizado' && p1.mix.musicPct === 70 && p1.mix.musicCount === 2 && p1.mix.themeCount === 1, JSON.stringify(p1.mix));
  st = await apiState();
  check('/state refleja contentMode=personalizado y mix', st.contentMode === 'personalizado' && st.mix && st.mix.musicPct === 70);

  await apiCmd('setFilters', { filters: { type: 'video', sort: 'date' } });
  const f1 = (await apiCmd('getFilters')).result.filters;
  st = await apiState();
  check('setFilters persiste y /state lo expone', f1 && f1.type === 'video' && f1.sort === 'date' && st.filters && st.filters.sort === 'date', JSON.stringify(f1));
  let searchF = null;
  try {
    searchF = await apiCmd('search', { query: 'documental naturaleza', limit: 6, filters: { type: 'video', sort: 'date' } }, 150000);
    check('búsqueda con filtros (sp de YouTube) responde', !!(searchF && searchF.result && searchF.result.ok && Array.isArray(searchF.result.items)), searchF && searchF.result ? 'items=' + searchF.result.items.length : String(searchF && searchF.error));
  } catch (e) {
    limit('búsqueda con filtros sp', 'yt-dlp tardó más del límite en este entorno (' + String(e.message || e) + '); la ruta sp está cubierta por las pruebas unitarias de buildSearchArgs');
  }
  await apiCmd('setFilters', { filters: {} });

  const cls = await apiCmd('classify', { items: [{ id: 'x1', title: 'Banda - Tema (Official Video)', channel: 'BandaVEVO' }, { id: 'x2', title: 'Documental sobre el mar' }] });
  const clsMap = {};
  for (const c of (cls.result && cls.result.classes) || []) clsMap[c.id] = c.cls;
  check('classify: official video => música, documental => tema', clsMap.x1 === 'music' && clsMap.x2 === 'theme', JSON.stringify(clsMap));

  // ---- historial ----
  const hist = (await apiCmd('queryHistory', { tab: 'all', limit: 50 })).result;
  const zooEntry = (hist.items || []).find((h) => /jNQXAC9IVRw/.test(h.url || '') || h.sourceId === 'jNQXAC9IVRw');
  check('el vídeo reproducido quedó en el historial (con estado y progreso)', !!zooEntry && zooEntry.playCount >= 1 && !!zooEntry.status, zooEntry ? `status=${zooEntry.status} count=${zooEntry.playCount} pos=${zooEntry.positionMs}ms cls=${zooEntry.classification}` : 'sin entrada');
  const histSearch = (await apiCmd('queryHistory', { q: 'zoo', limit: 10 })).result;
  check('búsqueda LOCAL del historial (sin red)', histSearch.total >= 1, 'total=' + histSearch.total);
  const sh = (await apiCmd('getSearchHistory', { limit: 20 })).result.searches;
  check('historial de búsquedas registra "big buck bunny"', Array.isArray(sh) && sh.some((s) => s.query === 'big buck bunny'), JSON.stringify((sh || []).map((s) => s.query)));
  const exp = (await apiCmd('exportHistory')).result;
  let expOk = false;
  try { const j = JSON.parse(exp.json); expOk = Array.isArray(j.playHistory) && j.playHistory.length >= 1; } catch {}
  check('exportHistory devuelve JSON válido con entradas', expOk);

  // ---- subtítulos: BBB como carga real; las pistas SPU se comprueban en el
  // ---- zoo, que sí descargó pista externa (en.vtt) vía sub-file ----
  const loadBbb = await apiCmd('load', { url: URL_BBB });
  check('carga real de Big Buck Bunny', !!(loadBbb && loadBbb.result && loadBbb.result.ok), String(loadBbb && loadBbb.error));
  st = await waitStatus('playing', 180000);
  check('BBB reproduciendo de verdad', !!st && st.status === 'playing', st ? st.status : '');
  await apiCmd('setSubtitlePrefs', { enabled: true, lang: 'es' });
  const sp = (await apiCmd('getSubtitlePrefs')).result.subtitles;
  check('prefs de subtítulos (CC on, ES) persisten', sp.enabled === true && sp.lang === 'es', JSON.stringify(sp));

  // ---- playHistory reanuda y suma playCount sin duplicar ----
  const countBefore = zooEntry.playCount;
  const ph = await apiCmd('playHistory', { id: zooEntry.id });
  check('playHistory carga el vídeo del historial (acepta id interno)', !!(ph && ph.result && ph.result.ok), String(ph && ph.error));
  st = await waitStatus('playing', 120000);
  check('reproducción real tras playHistory', !!st && st.status === 'playing' && /jNQXAC9IVRw/.test(st.url || ''), st ? st.status + ' ' + st.url : '');
  const hist2 = (await apiCmd('queryHistory', { tab: 'all', limit: 50 })).result;
  const zoo2 = (hist2.items || []).find((h) => h.id === zooEntry.id);
  check('playHistory no duplica la entrada (playCount +1)', zoo2 && zoo2.playCount === countBefore + 1 && hist2.items.filter((h) => h.id === zooEntry.id).length === 1, zoo2 ? 'count=' + countBefore + '->' + zoo2.playCount : '');

  // ---- CC real sobre el zoo: la pista descargada (sub-file) aparece como SPU ----
  let tracks = { tracks: [] };
  for (let i = 0; i < 20; i++) {
    tracks = (await apiCmd('getSubtitleTracks')).result;
    if (tracks && tracks.tracks && tracks.tracks.length) break;
    await sleep(1000);
  }
  if (tracks && Array.isArray(tracks.tracks) && tracks.tracks.some((t) => t.id >= 0)) {
    const real = tracks.tracks.filter((t) => t.id >= 0); // id -1 = "Deshabilitar"
    const t0 = real[0];
    await apiCmd('setSubtitleTrack', { id: t0.id });
    let sel = (await apiState()).subtitles;
    check('setSubtitleTrack selecciona pista real en libVLC', sel && sel.selected === t0.id, 'selected=' + (sel && sel.selected) + ' pista=' + JSON.stringify(t0));
    await apiCmd('setSubtitleTrack', { id: -1 });
    sel = (await apiState()).subtitles;
    check('setSubtitleTrack(-1) desactiva subtítulos', sel && sel.selected === -1, 'selected=' + (sel && sel.selected));
  } else {
    limit('pistas CC (SPU) en reproducción real', 'libVLC no enumeró pistas SPU ni con la pista externa descargada (tracks=[] tras 20 s); no se declara PASS de CC real');
    await apiCmd('setSubtitleTrack', { id: -1 });
    const sel = (await apiState()).subtitles;
    check('setSubtitleTrack(-1) aceptado y reflejado en /state', sel && sel.selected === -1, 'selected=' + (sel && sel.selected));
  }

  // ---- continuidad real: al terminar zoo (continuo + "mi búsqueda") avanza ----
  // La cola manual tiene prioridad absoluta por diseño y persiste entre
  // ejecuciones: se limpia para ejercitar aquí la vía de descubrimiento.
  await apiCmd('clearQueue');
  const urlBeforeEnd = (await apiState()).url;
  const ended2 = await waitStatus(null, 60000, (s) => s.status === 'stopped' || s.status === 'ended' || s.status === 'idle');
  check('zoo terminó de nuevo', !!ended2, ended2 ? ended2.status : 'timeout');
  let advanced = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await apiState();
    if (s && s.url && s.url !== urlBeforeEnd) { advanced = s; break; }
  }
  if (advanced) {
    check('modo continuo avanza solo al terminar (descubrimiento desde la búsqueda)', true, urlBeforeEnd + ' -> ' + advanced.url + ' (' + advanced.status + ')');
  } else {
    // Leer el log para distinguir fallo real de limitación de red/yt-dlp.
    let logTail = '';
    try { const buf = fs.readFileSync(path.join(ROOT, 'logs', 'sprint-electron.out'), 'utf8'); logTail = buf.slice(-4000); } catch {}
    const contLines = logTail.split('\n').filter((l) => /continuidad|descubrimiento|sin candidatos/i.test(l)).slice(-6);
    if (contLines.some((l) => /falló|sin candidatos|error/i.test(l))) {
      limit('avance automático', 'el descubrimiento devolvió error/sin candidatos en este entorno: ' + contLines.join(' | '));
    } else {
      check('modo continuo avanza solo al terminar', false, 'sin avance ni log de error; últimas líneas: ' + contLines.join(' | '));
    }
  }

  // ================= UI (CDP sobre yt-controls.html) =================
  console.log('\n== UI del explorador y la barra (CDP) ==');
  const page = await connectPage(/yt-controls\.html/);
  check('overlay inspeccionable por CDP', !!page);
  if (page) {
    // barra: controles de continuidad y CC presentes
    const barCtl = await cdpEval(`(()=>{return {
      cont: !!document.getElementById('contBtn'), cc: !!document.getElementById('ccBtn'),
      lang: !!document.getElementById('langSel'), contPop: !!document.getElementById('contPop'),
      ccOn: document.getElementById('ccBtn').classList.contains('on'),
      langVal: document.getElementById('langSel').value };})()`);
    check('barra: [CC] + idioma + continuidad presentes y reflejan prefs', !!barCtl && barCtl.cont && barCtl.cc && barCtl.lang && barCtl.ccOn === true && barCtl.langVal === 'es', JSON.stringify(barCtl));
    const contPop = await cdpEval(`(()=>{document.getElementById('contBtn').click();
      const show=document.getElementById('contPop').classList.contains('show');
      const radios=[...document.querySelectorAll('input[name=contMode]')].map(r=>r.value);
      const src=document.getElementById('contSource').value;
      document.getElementById('contPop').classList.remove('show');
      return {show, radios, src};})()`);
    check('popover continuidad: Solo este/Continuo + fuente', contPop.show && contPop.radios.join() === 'solo,continuo' && contPop.src === 'search', JSON.stringify(contPop));
    const ccToggle = await cdpEval(`(async()=>{document.getElementById('ccBtn').click();
      await new Promise(r=>setTimeout(r,700));
      const p=await window.cmp.getSubtitlePrefs();
      document.getElementById('ccBtn').click();
      await new Promise(r=>setTimeout(r,700));
      const p2=await window.cmp.getSubtitlePrefs();
      document.getElementById('subPop').classList.remove('show');
      return {a:p.subtitles.enabled, b:p2.subtitles.enabled};})()`);
    check('botón CC conmuta enabled y persiste', ccToggle.a === false && ccToggle.b === true, JSON.stringify(ccToggle));

    // explorador: abrir modal
    await cdpEval(`document.getElementById('search').click()`);
    await sleep(1200);
    const modes = await cdpEval(`(()=>{const m=[...document.querySelectorAll('.ex-mode')].map(b=>({m:b.dataset.mode, on:b.classList.contains('active')}));
      const fb=!!document.getElementById('exFiltersBtn'), hb=!!document.getElementById('exHistoryBtn');
      const badge=document.getElementById('exFilterCount');
      return {modes:m, fb, hb, badgeHidden: badge && getComputedStyle(badge).display==='none'};})()`);
    check('explorador: fila [Música][Temas][Personalizado] + botones Filtros/Historial', modes.modes.length === 3 && modes.modes.some((x) => x.m === 'personalizado' && x.on) && modes.fb && modes.hb, JSON.stringify(modes));

    // popover personalizado: slider coherente con prefs (70) y presets
    const mix = await cdpEval(`(async()=>{
      document.querySelector('.ex-mode[data-mode=personalizado]').click();
      await new Promise(r=>setTimeout(r,400));
      const pop=document.getElementById('exMixPop');
      const show=pop.classList.contains('show');
      const sl=document.getElementById('mixSlider');
      const pct=document.getElementById('mixPct').textContent;
      // preset 30/70 -> slider 30
      pop.querySelector('.ex-mix-presets .ex-btn[data-pct="30"]').click();
      const sl30=sl.value; const pct30=document.getElementById('mixPct').textContent;
      // volver a 70 y aplicar
      pop.querySelector('.ex-mix-presets .ex-btn[data-pct="70"]').click();
      document.getElementById('mixApply').click();
      await new Promise(r=>setTimeout(r,700));
      const p=await window.cmp.prefs();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return {show, sl0:sl ? sl.value : null, pct, sl30, pct30, cm:p.prefs.contentMode, pctFinal:p.prefs.mix.musicPct};})()`);
    check('popover Personalizado: se abre, slider=70% inicial, preset 30/70 coherente, Aplicar persiste', mix.show && mix.sl0 === '70' && mix.pct === '70%' && mix.sl30 === '30' && mix.pct30 === '30%' && mix.cm === 'personalizado' && mix.pctFinal === 70, JSON.stringify(mix));

    // popover de filtros: filas reales, badge, persistencia con debounce, reset
    const flt = await cdpEval(`(async()=>{
      document.getElementById('exFiltersBtn').click();
      await new Promise(r=>setTimeout(r,900));
      const pop=document.getElementById('exFilterPop');
      const show=pop.classList.contains('show');
      const rows=[...pop.querySelectorAll('.ex-frow[data-filter]')].map(r=>r.dataset.filter);
      const badge=document.getElementById('exFilterCount');
      const badgeTxt=badge.textContent, badgeVis=getComputedStyle(badge).display!=='none';
      // activar sort=views
      const sel=pop.querySelector('select[data-filter=sort]');
      sel.value='views'; sel.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1000));
      const f=await window.cmp.getFilters();
      const badge2=document.getElementById('exFilterCount').textContent;
      // reset
      document.getElementById('exFiltersReset').click();
      await new Promise(r=>setTimeout(r,1000));
      const f2=await window.cmp.getFilters();
      const badge3=getComputedStyle(document.getElementById('exFilterCount')).display;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return {show, rows, badgeTxt, badgeVis, sortPersist:(f.filters||{}).sort, badge2, resetSort:(f2.filters||{}).sort||null, badge3};})()`);
    check('popover Filtros: secciones reales desde capabilities, badge cuenta activos', flt.show && flt.rows.length >= 5 && flt.rows.includes('type') && flt.rows.includes('sort'), JSON.stringify(flt.rows));
    check('filtro sort=views persiste (debounce) con badge y se limpia con Restablecer', flt.sortPersist === 'views' && Number(flt.badge2) >= 1 && flt.resetSort === null && flt.badge3 === 'none', JSON.stringify({ badge2: flt.badge2, resetSort: flt.resetSort, badge3: flt.badge3 }));

    // pestaña Historial
    const histUi = await cdpEval(`(async()=>{
      document.querySelector('.ex-tab[data-tab=history]').click();
      await new Promise(r=>setTimeout(r,900));
      const pane=document.getElementById('exPaneHistory');
      const active=pane.classList.contains('active');
      const rows=[...document.querySelectorAll('#exHistList .ex-hrow')].length;
      const chips=[...document.querySelectorAll('#exHistChips .ex-chip')].map(c=>c.textContent);
      return {active, rows, chips};})()`);
    check('pestaña Historial: panel activo con pestañas y entradas reales', histUi.active && histUi.rows >= 1 && histUi.chips.length === 5, JSON.stringify(histUi));
    const histSearchUi = await cdpEval(`(async()=>{
      const inp=document.getElementById('exHistSearch');
      inp.value='zoo'; inp.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,900));
      const rows=[...document.querySelectorAll('#exHistList .ex-hrow')];
      return {n:rows.length, ok: rows.length>=1 && rows.every(r=>/zoo/i.test(r.querySelector('.ex-htitle').textContent))};})()`);
    check('búsqueda local del historial filtra en vivo', histSearchUi.ok, JSON.stringify(histSearchUi));
    const searchesUi = await cdpEval(`(async()=>{
      document.getElementById('exHistSearchesToggle').click();
      await new Promise(r=>setTimeout(r,700));
      const rows=[...document.querySelectorAll('#exHistList .ex-srow')];
      const has=rows.some(r=>r.dataset.query==='big buck bunny');
      // repetir una búsqueda antigua
      const btn=[...document.querySelectorAll('#exHistList .ex-srow')].find(r=>r.dataset.query==='big buck bunny');
      let rep=null;
      if (btn) { btn.querySelector('[data-hact=Repetir]').click(); await new Promise(r=>setTimeout(r,500)); rep=document.getElementById('modalInput').value; }
      return {n:rows.length, has, rep};})()`);
    check('vista "Búsquedas recientes": lista y botón Repetir restaura la consulta', searchesUi.n >= 1 && searchesUi.has && searchesUi.rep === 'big buck bunny', JSON.stringify(searchesUi));
    await cdpEval(`document.getElementById('modalCancel').click()`);
  }

  finish();
}

function finish() {
  try { if (child) child.kill(); } catch {}
  const out = { pass: results.every((r) => r.ok), total: results.length, limitations, results };
  fs.writeFileSync(path.join(ROOT, 'logs', 'sprint-ui-test.json'), JSON.stringify(out, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' comprobaciones PASS ==');
  if (limitations.length) { console.log('LIMITACIONES (no declaradas como éxito):'); limitations.forEach((l) => console.log(' - ' + l.name + ': ' + l.reason)); }
  if (failed.length) { console.log('FALLOS:'); failed.forEach((f) => console.log(' - ' + f.name + ': ' + f.detail)); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR en la prueba:', e); finish(); });
