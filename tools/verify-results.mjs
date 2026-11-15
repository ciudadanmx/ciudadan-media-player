// Verificación de la reproducción de RESULTADOS DE BÚSQUEDA: se buscan vídeos
// reales y se reproducen uno tras otro, comprobando que el stream sirve imagen
// (posición avanzando) y que no se queda en buffering ni sin datos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime', 'control-api.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME, 'utf8')); } catch { return null; }
}

// La app debe estar viva; si no, se arranca aquí (Electron real, no simulado).
let launched = null;
let logStart = 0;
try { logStart = fs.statSync(path.join(ROOT, 'logs', 'app.log')).size; } catch {}
async function apiAlive(cur) {
  if (!cur || !cur.port || !cur.token) return false;
  let pidAlive = false;
  try { process.kill(cur.pid, 0); pidAlive = true; } catch {}
  if (!pidAlive) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${cur.port}/health`, { signal: AbortSignal.timeout(3000) });
    return r.status === 200;
  } catch { return false; }
}
let rt = null;
for (let i = 0; i < 20; i++) { const cur = readRuntime(); if (await apiAlive(cur)) { rt = cur; break; } await sleep(500); }
if (!rt) {
  console.log('no hay app viva: se arranca');
  launched = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore'] });
  for (let i = 0; i < 180; i++) { const cur = readRuntime(); if (await apiAlive(cur)) { rt = cur; break; } await sleep(1000); }
}
if (!rt) { console.log('ERROR: la app no responde (API)'); try { if (launched) launched.kill(); } catch {} process.exit(1); }
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rt.token };

async function apiCmd(command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${rt.port}/cmd`, {
    method: 'POST', headers, body: JSON.stringify({ command, args }), signal: AbortSignal.timeout(300000),
  });
  return await res.json().catch(() => null);
}
async function apiState() {
  const res = await fetch(`http://127.0.0.1:${rt.port}/state`, { headers });
  const b = await res.json().catch(() => null);
  return b && b.state;
}

// La app debe estar viva (la lanza el usuario o el script de verificación).
let alive = false;

// Modo continuo + cola vacía: cada vídeo se comprueba de forma aislada.
// Se guarda el modo original y se restaura al final: las preferencias se
// persisten y no se debe contaminar la sesión del usuario.
const st0 = await apiState();
const modoOriginal = st0 && st0.continuity && st0.continuity.mode ? st0.continuity.mode : null;
await apiCmd('setContinuity', { mode: 'solo', source: 'search' });
await apiCmd('clearQueue');
const q = process.argv[2] || 'pink floyd';
const sr = await apiCmd('search', { query: q, limit: 4 });
const items = (sr && sr.result && sr.result.items) || [];
console.log(`búsqueda "${q}": ${items.length} resultados`);

let ok = 0, fail = 0;
for (const it of items) {
  const url = it.url || `https://www.youtube.com/watch?v=${it.id}`;
  await apiCmd('load', { url });
  // Espera a que empiece a reproducir (o a que dé error claro).
  let st = null;
  for (let i = 0; i < 150; i++) { st = await apiState(); if (st && (st.status === 'playing' || st.status === 'error' || st.status === 'ended')) break; await sleep(1000); }
  const p0 = st && st.position ? st.position : 0;
  let p1 = p0, estado = st && st.status, cortadas = 0;
  // Observación sostenida: el stream debe seguir sirviendo (no quedarse
  // congelado a los few segundos, que era el síntoma reportado).
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const s = await apiState();
    if (!s) break;
    estado = s.status;
    p1 = s.position || 0;
    if (p1 < p0) cortadas++;
  }
  const avanza = p1 > p0 + 2;
  const bien = avanza && (estado === 'playing' || estado === 'ended') && cortadas === 0;
  console.log(`${bien ? 'OK  ' : 'FALLA'} ${it.id} "${String(it.title).slice(0, 44)}" estado=${estado} pos ${p0.toFixed(1)}s -> ${p1.toFixed(1)}s (15 s observados)`);
  if (bien) ok++; else fail++;
}
console.log(`RESULTADOS: ${ok}/${items.length} sirven reproducción real`);
// Se restaura el modo de continuidad que tenía la app.
if (modoOriginal && modoOriginal !== 'solo') {
  try { await apiCmd('setContinuity', { mode: modoOriginal, source: 'search' }); console.log('modo de continuidad restaurado: ' + modoOriginal); } catch {}
}
// Atascos del hilo principal durante la prueba (el síntoma "la app no sirve").
try {
  const logPath = path.join(ROOT, 'logs', 'app.log');
  const txt = fs.readFileSync(logPath, 'utf8');
  const stalls = txt.slice(logStart).split('\n').filter((l) => l.includes('ATASCO'));
  console.log(`ATASCOS del hilo principal en esta sesión: ${stalls.length}`);
  for (const l of stalls.slice(-3)) console.log('  ' + l.slice(0, 150));
} catch {}
try { if (launched) launched.kill(); } catch {}
process.exit(fail === 0 ? 0 : 1);
