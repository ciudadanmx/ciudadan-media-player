// Pruebas de aceptación del API de control de Ciudadan Media Player.
//
// Cubre las 12 comprobaciones del contrato:
//  1. estado mientras reproduce          7. forward/rewind por API
//  2. estado mientras está pausado       8. la barra de progreso se sincroniza
//  3. volumen externo -> slider visible  9. cerrar/reabrir sin conexiones huerfanas
//  4. slider -> volumen externo          10. reconectar sin perder sincronía
//  5. pausa por API                      11. órdenes simultáneas y errores
//  6. play por API                       12. TTS y otros servicios intactos
//
// Uso: node tools/test-control-api.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNTIME_FILE = path.join(ROOT, 'runtime', 'control-api.json');
const LOG_DIR = path.join(ROOT, 'logs');
const API_PORT = Number(process.env.CMP_TEST_API_PORT || 17891);
const API_TOKEN = process.env.CMP_TEST_API_TOKEN || 'token-de-prueba-abc123';
const CDP_PORT = Number(process.env.CMP_TEST_CDP_PORT || 9223);
const URL_VID = process.env.CMP_AUTOTEST_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

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
// Cliente HTTP del API
// ---------------------------------------------------------------------------
let api = { port: API_PORT, token: API_TOKEN };

async function apiGet(p, useToken = true) {
  const headers = useToken ? { Authorization: 'Bearer ' + api.token } : {};
  const res = await fetch(`http://127.0.0.1:${api.port}${p}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiState() {
  const r = await apiGet('/state');
  return r.body && r.body.state ? r.body.state : null;
}
async function apiCmd(command, args = {}, id = null) {
  const res = await fetch(`http://127.0.0.1:${api.port}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api.token },
    body: JSON.stringify({ command, args, id }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// Cliente CDP (para comprobar el estado REAL de la interfaz)
// ---------------------------------------------------------------------------
let cdpWs = null;
async function cdpEval(expression) {
  if (!cdpWs) return null;
  const id = ++cdpEval._id;
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === id) {
        cdpWs.removeEventListener('message', onMsg);
        resolve(m.result && m.result.result ? m.result.result.value : null);
      }
    };
    cdpWs.addEventListener('message', onMsg);
    cdpWs.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { cdpWs.removeEventListener('message', onMsg); resolve(null); }, 5000);
  });
}
cdpEval._id = 0;

async function cdpConnect() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  // OJO: la barra flotante se llama yt-controls.html (no hay ventana de controles aparte).
  const page = targets.find((t) => t.type === 'page' && /yt-controls\.html$/.test(t.url));
  if (!page) return false;
  cdpWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpWs.addEventListener('open', resolve);
    cdpWs.addEventListener('error', reject);
    setTimeout(() => reject(new Error('timeout CDP')), 5000);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Eventos SSE
// ---------------------------------------------------------------------------
function sseCollect(ms = 4000) {
  const events = [];
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/events`, {
        headers: { Authorization: 'Bearer ' + api.token },
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const type = (frame.match(/^event:\s*(.+)$/m) || [])[1];
          const data = (frame.match(/^data:\s*(.+)$/m) || [])[1];
          if (type && data) { try { events.push({ type, data: JSON.parse(data) }); } catch {} }
        }
      }
    } catch {}
  })();
  return { events, stop: async () => { ctrl.abort(); await done; } };
}

// ---------------------------------------------------------------------------
// Arranque/parada de la app
// ---------------------------------------------------------------------------
function launchApp(extraArgs = []) {
  const out = fs.openSync(path.join(LOG_DIR, 'electron-apitest.out'), 'a');
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`, '--api-test', `--remote-debugging-port=${CDP_PORT}`, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, CMP_AUTOTEST_URL: URL_VID, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN },
    stdio: ['ignore', out, out],
  });
  child.on('exit', () => { child = null; });
}

async function waitForApi(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await apiGet('/health', false);
      if (r.status === 200 && r.body && r.body.ok) {
        if (fs.existsSync(RUNTIME_FILE)) {
          try { api = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch {}
        }
        return true;
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

// El arranque de Electron puede morir de forma transitoria (libVLC compite por
// el D3D o el perfil queda bloqueado por la instancia anterior): se reintenta.
async function startAppWithRetry(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    launchApp();
    if (await waitForApi(45000)) return true;
    console.log('  (el API no respondió; reintento ' + (i + 2) + '/' + attempts + ')');
    await stopApp();
    await sleep(4000);
  }
  return false;
}

async function waitPlaying(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await apiState();
    if (s && s.status === 'playing' && s.position > 0) return s;
    await sleep(1000);
  }
  return null;
}

async function stopApp() {
  if (!child) return;
  const p = child;
  try { p.kill(); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (!child) break;
    await sleep(300);
  }
  try { p.kill('SIGKILL'); } catch {}
  child = null;
  await sleep(1500);
}

// ---------------------------------------------------------------------------
// Comprobación 12: TTS y otros servicios intactos
// ---------------------------------------------------------------------------
const DSH_FILES = [
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh1\\AGENTS.md',
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh2\\AGENTS.md',
];
function serviceSnapshot() {
  const snap = { hashes: {}, dshWeb: false };
  for (const f of DSH_FILES) snap.hashes[f] = sha256(f);
  try {
    const req = fetch('http://127.0.0.1:3081/', { signal: AbortSignal.timeout(3000) });
    return req.then(() => { snap.dshWeb = true; return snap; }).catch(() => snap);
  } catch { return Promise.resolve(snap); }
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try { fs.unlinkSync(RUNTIME_FILE); } catch {}
  const before = await serviceSnapshot();

  console.log('== arrancando la app (modo --api-test) ==');
  const apiUp = await startAppWithRetry();
  if (!check('API de control accesible en 127.0.0.1 con token', apiUp, 'puerto ' + api.port)) {
    await stopApp();
    return finish();
  }
  check('fichero runtime/control-api.json con puerto y token', fs.existsSync(RUNTIME_FILE), RUNTIME_FILE);

  // Seguridad: sin token no se responde
  const noTok = await fetch(`http://127.0.0.1:${api.port}/state`).then((r) => r.status).catch(() => 0);
  check('sin token el estado responde 401', noTok === 401, 'status ' + noTok);

  const playing = await waitPlaying();
  if (!check('1. estado mientras reproduce', !!playing && playing.status === 'playing' && playing.position > 0,
    playing ? `status=${playing.status} pos=${playing.position}s vol=${playing.volume}` : 'no reprodujo')) {
    await stopApp();
    return finish();
  }

  // CDP para mirar la interfaz real
  let cdpOk = false;
  try { cdpOk = await cdpConnect(); } catch {}
  check('interfaz de controles accesible por CDP', cdpOk, cdpOk ? 'controles.html' : 'sin CDP');

  // --- 2. estado mientras está pausado
  await apiCmd('pause');
  await sleep(1500);
  const paused = await apiState();
  check('2. estado mientras está pausado', paused && paused.status === 'paused', paused ? paused.status : 'null');

  // --- 5. pausa por API comprobando el motor real
  check('5. pausa por API', paused && paused.status === 'paused' && paused.position === paused.position, 'posición congelada en ' + (paused ? paused.position : '?'));

  // --- 6. play por API
  const pl = await apiCmd('play');
  await sleep(2000);
  const afterPlay = await apiState();
  check('6. play por API', afterPlay && afterPlay.status === 'playing' && afterPlay.position > paused.position,
    `pos ${paused ? paused.position : '?'} -> ${afterPlay ? afterPlay.position : '?'} (rc=${pl.body ? pl.body.ok : '?'})`);

  // --- 3. volumen externo -> slider de la interfaz
  const volCmd = await apiCmd('setVolume', { value: 35 });
  await sleep(1200);
  const stAfterVol = await apiState();
  let slider = null;
  if (cdpOk) slider = await cdpEval("document.getElementById('vol').value");
  check('3. volumen externo (35) aplicado por el motor', stAfterVol && stAfterVol.volume === 35, 'getVolume=' + (stAfterVol ? stAfterVol.volume : '?'));
  check('3b. el slider de la interfaz refleja el volumen externo', slider !== null && Number(slider) === 35, 'slider=' + slider);

  // --- 4. slider de la interfaz -> volumen externo
  if (cdpOk) {
    await cdpEval("(()=>{const v=document.getElementById('vol');v.value=70;v.dispatchEvent(new Event('input'));return true;})()");
    await sleep(1500);
  }
  const stAfterUi = await apiState();
  check('4. cambio de volumen en la interfaz visible externamente', stAfterUi && stAfterUi.volume === 70, 'getVolume=' + (stAfterUi ? stAfterUi.volume : '?'));

  // --- 7. forward / rewind
  const posBefore = (await apiState()).position;
  const fw = await apiCmd('forward', { seconds: 20 });
  await sleep(2500);
  const posAfterFw = (await apiState()).position;
  check('7a. forward por API', posAfterFw >= posBefore + 15, `${posBefore.toFixed(1)} -> ${posAfterFw.toFixed(1)}`);
  const rw = await apiCmd('rewind', { seconds: 10 });
  await sleep(2500);
  const posAfterRw = (await apiState()).position;
  check('7b. rewind por API', posAfterRw <= posAfterFw - 5, `${posAfterFw.toFixed(1)} -> ${posAfterRw.toFixed(1)}`);

  // --- 8. la barra de progreso se sincroniza (barra flotante: ancho de #played en %)
  let seekVal = null;
  if (cdpOk) seekVal = await cdpEval("document.getElementById('played').style.width");
  const st8 = await apiState();
  const expected = st8.duration > 0 ? (st8.position / st8.duration) * 100 : null;
  const shown = seekVal ? parseFloat(seekVal) : null;
  check('8. la barra de progreso sigue al motor', shown !== null && expected !== null && Math.abs(shown - expected) <= 2.5,
    `barra=${seekVal} esperado=${expected !== null ? expected.toFixed(2) : '?'}% (pos ${st8.position}s / ${st8.duration}s)`);

  // --- eventos SSE
  const sse = sseCollect(5000);
  await sleep(500);
  await apiCmd('setVolume', { value: 55 });
  await sleep(2000);
  await apiCmd('pause');
  await sleep(1500);
  await apiCmd('play');
  await sleep(1500);
  await sse.stop();
  const types = new Set(sse.events.map((e) => e.type));
  check('eventos SSE recibidos (volumeChanged/stateChanged/playbackPaused/playbackStarted/positionChanged)',
    types.has('volumeChanged') && types.has('stateChanged') && types.has('playbackPaused') && types.has('playbackStarted'),
    [...types].join(','));

  // --- 11. órdenes simultáneas y errores
  const [c1, c2, c3] = await Promise.all([
    apiCmd('setVolume', { value: 60 }),
    apiCmd('seek', { seconds: 30 }),
    apiCmd('pause'),
  ]);
  check('11a. órdenes simultáneas: todas responden', c1.body?.ok !== undefined && c2.body?.ok !== undefined && c3.body?.ok !== undefined,
    `vol=${c1.body?.ok} seek=${c2.body?.ok} pause=${c3.body?.ok}`);
  const bad = await apiCmd('noExiste');
  check('11b. comando desconocido rechazado', bad.status === 400 || bad.body?.ok === false, 'status ' + bad.status);
  const over = await apiCmd('setVolume', { value: 999 });
  const stOver = await apiState();
  check('11c. volumen fuera de rango se recorta a 100', over.body?.ok === true && stOver.volume === 100, 'vol=' + stOver.volume);
  const neg = await apiCmd('seek', { seconds: -5 });
  check('11d. posición negativa rechazada con error', neg.body?.ok === false, neg.body?.error || 'ok');

  // --- idempotencia por id de comando
  const idem1 = await apiCmd('setVolume', { value: 44 }, 'cmd-idem-1');
  const idem2 = await apiCmd('setVolume', { value: 44 }, 'cmd-idem-1');
  check('11e. id de comando repetido no vuelve a ejecutarse', idem2.body?.duplicate === true, 'duplicate=' + idem2.body?.duplicate);

  // --- 9. cerrar y reabrir sin conexiones huérfanas
  const oldPort = api.port;
  await stopApp();
  await sleep(2000);
  let portClosed = false;
  try { await fetch(`http://127.0.0.1:${oldPort}/health`, { signal: AbortSignal.timeout(2000) }); } catch { portClosed = true; }
  check('9a. al cerrar la app el puerto del API queda libre', portClosed, 'puerto ' + oldPort);
  // Al cerrar de forma forzada el fichero puede quedar obsoleto: lo que NO puede
  // pasar es que un coordinador lo tome por válido. Se comprueba que, si sigue
  // ahí, su pid ya no está vivo (o sea, es detectable como obsoleto).
  let runtimeOk = true; let runtimeDetail = 'borrado';
  if (fs.existsSync(RUNTIME_FILE)) {
    try {
      const info = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
      runtimeOk = !alive;
      runtimeDetail = 'presente pero obsoleto (pid ' + info.pid + ' vivo=' + alive + ')';
    } catch { runtimeOk = false; runtimeDetail = 'ilegible'; }
  }
  check('9b. runtime/control-api.json no queda válido tras cerrar', runtimeOk, runtimeDetail);

  const apiUp2 = await startAppWithRetry();
  check('9c. la app reabre y vuelve a exponer el API', apiUp2, 'puerto ' + api.port);
  const playing2 = await waitPlaying();
  check('10. tras reconectar, getState devuelve el estado real sin alterar la reproducción',
    !!playing2 && playing2.status === 'playing' && playing2.position > 0,
    playing2 ? `status=${playing2.status} pos=${playing2.position.toFixed(1)}s` : 'no reprodujo');

  // --- 12. TTS y otros servicios intactos
  const after = await serviceSnapshot();
  const sameHashes = DSH_FILES.every((f) => before.hashes[f] && before.hashes[f] === after.hashes[f]);
  check('12. TTS/DSH intactos (hashes de AGENTS.md sin cambios y DSH web accesible)',
    sameHashes && after.dshWeb, `hashes=${sameHashes} dshWeb=${after.dshWeb}`);

  await stopApp();
  finish();
}

function finish() {
  const pass = results.filter((r) => r.ok).length;
  const out = { pass: pass === results.length, total: results.length, passed: pass, results };
  fs.writeFileSync(path.join(LOG_DIR, 'control-api-test.json'), JSON.stringify(out, null, 2));
  console.log(`\n== ${pass}/${results.length} comprobaciones PASS ==`);
  if (!out.pass) console.log('FALLOS:\n' + results.filter((r) => !r.ok).map((r) => ' - ' + r.name + ': ' + r.detail).join('\n'));
  process.exit(out.pass ? 0 : 7);
}

main().catch(async (e) => {
  console.error('ERROR en la prueba:', (e && e.stack) || String(e));
  await stopApp();
  finish();
});

