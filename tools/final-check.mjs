// Verificación final: reproducción real (posición avanzando) + volumen 100 vía API.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const API_PORT = 17998;
const API_TOKEN = 'tok-final';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiCmd(command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(120000),
  });
  return await res.json().catch(() => null);
}
async function apiState() {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/state`, { headers: { Authorization: 'Bearer ' + API_TOKEN } });
  const b = await res.json().catch(() => null);
  return b && b.state;
}

const child = spawn(ELECTRON, ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`, '--api-test'], {
  cwd: ROOT,
  env: { ...process.env, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN, CMP_AUTOTEST_URL: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', CMP_AUTOTEST_SECS: '30' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

let ok = true;
try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${API_PORT}/health`); if (r.status === 200) { up = true; break; } } catch {} await sleep(500); }
  console.log('API arriba:', up);
  let st = null;
  for (let i = 0; i < 180; i++) { st = await apiState(); if (st && st.status === 'playing') break; await sleep(1000); }
  console.log('estado inicial:', st && st.status, st && st.url);
  await apiCmd('setVolume', { volume: 100 });
  const s1 = await apiState();
  await sleep(4000);
  const s2 = await apiState();
  const p1 = (s1.position || 0) * 1000, p2 = (s2.position || 0) * 1000;
  const adv = p2 > p1;
  console.log(`volumen=${s2.volume} status=${s2.status} pos ${p1}ms -> ${p2}ms avanzando=${adv}`);
  const pass = up && s2.status === 'playing' && adv && s2.volume === 100;
  console.log(pass ? 'VERIFICACIÓN FINAL: PASS (reproducción real, posición avanzando, volumen 100)' : 'VERIFICACIÓN FINAL: FAIL');
  ok = pass;
} finally {
  try { child.kill(); } catch {}
  process.exit(ok ? 0 : 1);
}
