#!/usr/bin/env node
// Prueba de resistencia del Ciudadan Media Player.
//
// - Arranca la app y espera al motor.
// - Reproduce un vídeo largo y sondea el API cada 2 s: mide la latencia y
//   detecta bloqueos (una latencia alta = el hilo principal está ocupado).
// - Ejercita la cola y los turnos: play, pause, seek, siguiente, anterior,
//   volumen, y comprueba que el estado sigue siendo coherente.
// - Al final escribe logs/soak-report.json y termina con código 0 si todo
//   está dentro de los umbrales, 1 si hay bloqueos o incoherencias.
//
// Uso: node tools\soak.mjs [minutos] [url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MINUTES = Number(process.argv[2] || 8);
const URL = process.argv[3] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const ROOT = process.cwd();
const PORT = Number(process.env.CMP_SOAK_PORT || 17990);
const CDP_PORT = Number(process.env.CMP_SOAK_CDP || 9339);
const UA = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function apiGet(p, token) {
  const t0 = Date.now();
  const r = await fetch(UA + p, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  return { j, ms: Date.now() - t0 };
}
async function apiCmd(token, command, args = {}) {
  const t0 = Date.now();
  const r = await fetch(UA + '/cmd', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  const j = await r.json();
  return { j, ms: Date.now() - t0, status: r.status };
}

async function waitRuntime(timeoutMs = 240000) {
  const file = path.join(ROOT, 'runtime', 'control-api.json');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Sólo vale el fichero de ESTA ejecución (el puerto debe coincidir).
        if (raw && raw.port === PORT && raw.token) return raw;
      }
    } catch {}
    await sleep(500);
  }
  return null;
}

const report = { startedAt: new Date().toISOString(), minutes: MINUTES, url: URL, samples: [], actions: [], stalls: [], errors: [], incoherent: [] };
let child = null;

function cleanup(code) {
  try { if (child && !child.killed) child.kill('SIGKILL'); } catch {}
  try {
    for (const p of fs.readdirSync(path.join(ROOT, '.electron-userdata'))) {
      if (p.startsWith('Singleton')) { try { fs.unlinkSync(path.join(ROOT, '.electron-userdata', p)); } catch {} }
    }
  } catch {}
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', 'soak-report.json'), JSON.stringify(report, null, 2));
  process.exit(code);
}

async function main() {
  log('lanzando la app…');
  // El fichero de runtime de una ejecución anterior puede seguir en disco:
  // se borra para no confundir los puertos.
  try { fs.unlinkSync(path.join(ROOT, 'runtime', 'control-api.json')); } catch {}
  child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`, '.'],
    { cwd: ROOT, env: { ...process.env, CMP_API_PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });

  const rt = await waitRuntime();
  if (!rt) { report.errors.push('la app no expuso el API'); log('FALLO: sin API'); return cleanup(1); }
  log('API en', rt.port);

  // Esperar al motor (puede tardar por el antivirus).
  let st = null;
  for (let i = 0; i < 240; i++) {
    st = (await apiGet('/state', rt.token)).j.state;
    if (st.status === 'idle' || st.status === 'playing') break;
    await sleep(1000);
  }
  log('motor listo, estado:', st && st.status);

  log('cargando', URL);
  const load = await apiCmd(rt.token, 'load', { url: URL });
  report.actions.push({ action: 'load', ok: load.j.ok, ms: load.ms });
  log('carga:', load.j.ok ? 'ok' : JSON.stringify(load.j).slice(0, 200), load.ms + ' ms');

  // Esperar a que esté reproduciendo.
  for (let i = 0; i < 120; i++) {
    st = (await apiGet('/state', rt.token)).j.state;
    if (st.status === 'playing') break;
    await sleep(1000);
  }
  log('estado:', st.status, 'vol:', st.volume);

  const end = Date.now() + MINUTES * 60000;
  let n = 0;
  let lastPos = st.position, lastPosAt = Date.now();  while (Date.now() < end) {
    const t0 = Date.now();
    let s;
    try {
      s = (await apiGet('/state', rt.token)).j.state;
    } catch (e) {
      report.errors.push('estado: ' + e.message);
      await sleep(1000);
      continue;
    }
    const ms = Date.now() - t0;
    const sample = { at: new Date().toISOString(), ms, status: s.status, position: s.position, duration: s.duration, volume: s.volume };
    report.samples.push(sample);
    if (ms > 1500) { report.stalls.push(sample); log('LATENCIA ALTA', ms + ' ms', s.status); }
    // Coherencia: reproduciendo = la posición avanza; con posición fija y
    // estado "playing" durante 30 s -> medio colgado. También se vigila una
    // pausa larga sin que el soak haya pedido pausa (stream muerto que deja
    // el motor en "paused").
    if (s.status === 'playing' || s.status === 'paused') {
      if (Math.abs((s.position || 0) - lastPos) > 0.05) { lastPos = s.position; lastPosAt = Date.now(); }
      else if (Date.now() - lastPosAt > 30000) {
        report.incoherent.push({ at: sample.at, reason: 'posición no avanza con estado ' + s.status, position: s.position });
        log('INCOHERENTE: posición no avanza (' + s.status + ')');
        lastPosAt = Date.now();
      }
    } else { lastPos = s.position; lastPosAt = Date.now(); }
    n++;
    await sleep(2000);
  }
  log('sondeo terminado:', n, 'muestras');

  // --- Ejercicios de control (cola y turnos) --------------------------------
  const acts = [
    ['pause', {}], ['play', {}], ['seek', { position: 30 }], ['forward', { seconds: 10 }],
    ['rewind', { seconds: 5 }], ['setVolume', { value: 80 }], ['getVolume', {}], ['getState', {}],
  ];
  for (const [command, args] of acts) {
    const r = await apiCmd(rt.token, command, args);
    report.actions.push({ action: command, ok: r.j.ok, ms: r.ms, error: r.j.error || null });
    log('acción', command, r.j.ok ? 'ok' : 'ERROR ' + JSON.stringify(r.j).slice(0, 160), r.ms + ' ms');
    await sleep(1200);
  }
  // Coherencia final: el estado debe seguir siendo real
  const fin = (await apiGet('/state', rt.token)).j.state;
  report.final = fin;
  if (fin.status !== 'playing') report.incoherent.push({ at: new Date().toISOString(), reason: 'estado final no es playing: ' + fin.status });

  // Latencias
  const lats = report.samples.map(s => s.ms).sort((a, b) => a - b);
  const p = (q) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * q))] : -1;
  report.latency = { min: lats[0], p50: p(0.5), p95: p(0.95), max: lats[lats.length - 1], samples: lats.length };
  log('latencia: min', report.latency.min, 'p50', report.latency.p50, 'p95', report.latency.p95, 'max', report.latency.max);

  const bad = report.stalls.length || report.incoherent.length || report.errors.length;
  log(bad ? 'RESULTADO: CON PROBLEMAS' : 'RESULTADO: OK');
  return cleanup(bad ? 1 : 0);
}

main().catch((e) => { report.errors.push(String(e && e.stack || e)); console.error(e); cleanup(1); });
