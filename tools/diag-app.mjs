// Diagnóstico SPU dentro de la app real (spawn como las suites).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const API_PORT = 17997;
const API_TOKEN = 'tok-diag3';
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
  env: { ...process.env, CMP_API_PORT: String(API_PORT), CMP_API_TOKEN: API_TOKEN, CMP_AUTOTEST_URL: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', CMP_AUTOTEST_SECS: '60' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

try {
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${API_PORT}/health`); if (r.status === 200) { up = true; break; } } catch {}
    await sleep(500);
  }
  console.log('api up:', up);
  let st = null;
  for (let i = 0; i < 180; i++) { st = await apiState(); if (st && st.status === 'playing') break; await sleep(1000); }
  console.log('status:', st && st.status, 'url:', st && st.url);
  for (let i = 0; i < 12; i++) {
    const r = await apiCmd('getSubtitleTracks');
    console.log(`t+${i * 3}s rawCount=`, r && r.result && r.result.rawCount, 'tracks=', JSON.stringify(r && r.result && r.result.tracks));
    if (r && r.result && r.result.tracks && r.result.tracks.length) break;
    await sleep(3000);
  }
} finally {
  try { child.kill(); } catch {}
  process.exit(0);
}
