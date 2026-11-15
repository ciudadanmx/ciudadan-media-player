// Diagnóstico: reproducir un 416 real y ver qué Range/URL lo provoca.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime', 'control-api.json');
const LOG = path.join(ROOT, 'logs', 'app.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`],
  { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore'] });

async function alive(rt) {
  if (!rt || !rt.port) return false;
  try { const r = await fetch(`http://127.0.0.1:${rt.port}/health`, { signal: AbortSignal.timeout(2500) }); return r.status === 200; } catch { return false; }
}
let rt = null;
for (let i = 0; i < 180; i++) {
  try { rt = JSON.parse(fs.readFileSync(RUNTIME, 'utf8')); } catch {}
  if (await alive(rt)) break;
  await sleep(1000);
}
if (!rt || !(await alive(rt))) { console.log('sin API'); try { child.kill(); } catch {} process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rt.token };
await fetch(`http://127.0.0.1:${rt.port}/cmd`, { method: 'POST', headers: H, body: JSON.stringify({ command: 'setContinuity', args: { mode: 'solo' } }) });
await fetch(`http://127.0.0.1:${rt.port}/cmd`, { method: 'POST', headers: H, body: JSON.stringify({ command: 'load', args: { url: 'https://www.youtube.com/watch?v=k9ynZnEBtvw' } }) });
await sleep(75000);
try { child.kill(); } catch {}
const txt = fs.readFileSync(LOG, 'utf8').slice(before);
const lines = txt.split('\n').filter((l) => /416|resuelto|ATASCO|evento: Playing|sin datos/i.test(l));
for (const l of lines.slice(0, 40)) console.log(l.slice(0, 300));
process.exit(0);
