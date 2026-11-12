// Verificación en vivo de la continuidad: app real (sin autotest), vídeo cargado
// por URL directa (sin ninguna búsqueda previa) -> al terminar debe seguir con
// un vídeo relacionado. Deja la app en marcha al terminar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNTIME = path.join(ROOT, 'runtime', 'control-api.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME, 'utf8')); } catch { return null; }
}

async function apiCmd(rt, command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${rt.port}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rt.token },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(120000),
  });
  return await res.json().catch(() => null);
}
async function apiState(rt) {
  const res = await fetch(`http://127.0.0.1:${rt.port}/state`, { headers: { Authorization: 'Bearer ' + rt.token } });
  const b = await res.json().catch(() => null);
  return b && b.state;
}

const child = spawn(ELECTRON, ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'ignore', 'ignore'],
});

let ok = false;
try {
  let rt = null;
  let alive = false;
  // El runtime puede ser de una ejecución anterior: se espera a que el PID
  // publicado esté vivo y a que /health responda (el motor tarda en arrancar).
  for (let i = 0; i < 360; i++) {
    const cur = readRuntime();
    if (cur && cur.port && cur.token) {
      let pidAlive = false;
      try { process.kill(cur.pid, 0); pidAlive = true; } catch {}
      if (pidAlive) {
        try {
          const r = await fetch(`http://127.0.0.1:${cur.port}/health`, { signal: AbortSignal.timeout(3000) });
          if (r.status === 200) { rt = cur; alive = true; break; }
        } catch {}
      }
    }
    await sleep(1000);
  }
  if (!rt) throw new Error('la app no publicó un API vivo (runtime/control-api.json)');
  console.log('API viva:', alive, 'puerto', rt.port);

  // Modo continuo + cola vacía: se reproduce una URL directa (sin búsqueda).
  await apiCmd(rt, 'setContinuity', { mode: 'continuo', source: 'search' });
  await apiCmd(rt, 'clearQueue');
  await apiCmd(rt, 'load', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });

  let st = null;
  for (let i = 0; i < 180; i++) { st = await apiState(rt); if (st && st.status === 'playing') break; await sleep(1000); }
  const url0 = st && st.url;
  console.log('reproduciendo:', st && st.status, url0);

  for (let i = 0; i < 120; i++) { st = await apiState(rt); if (st && (st.status === 'ended' || st.status === 'stopped' || st.status === 'idle')) break; await sleep(1000); }
  console.log('estado al terminar:', st && st.status);

  let next = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const s = await apiState(rt);
    if (s && s.url && url0 && s.url !== url0 && (s.status === 'playing' || s.status === 'opening' || s.status === 'buffering')) { next = s; break; }
  }
  if (next) {
    console.log('CONTINUIDAD OK:', url0, '->', next.url, '(' + next.status + ')');
    ok = true;
  } else {
    const s = await apiState(rt);
    console.log('CONTINUIDAD FALLIDA: no siguió (estado=' + (s && s.status) + ', url=' + (s && s.url) + ')');
  }
} catch (e) {
  console.log('ERROR:', String(e.message || e));
} finally {
  if (!ok) { try { child.kill(); } catch {} }
  console.log(ok ? 'app left running' : 'app closed');
  process.exit(ok ? 0 : 1);
}
