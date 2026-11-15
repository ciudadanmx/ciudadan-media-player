// Bisección: arranca la app con una bandera y cuenta los atascos en N segundos.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'logs', 'app.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flag = process.argv[2] || '';
const secs = Number(process.argv[3] || 45);
const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

const env = { ...process.env };
if (flag && flag !== 'base') env[flag] = '1';
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--no-sandbox', `--user-data-dir=${path.join(ROOT, '.electron-userdata')}`],
  { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
await sleep(secs * 1000);
try { child.kill(); } catch {}
const txt = fs.readFileSync(LOG, 'utf8').slice(before);
const stalls = (txt.match(/ATASCO/g) || []).length;
const ms = [...txt.matchAll(/ATASCO: hilo principal bloqueado (\d+) ms/g)].map((m) => Number(m[1]));
const total = ms.reduce((a, b) => a + b, 0);
console.log(`${flag || 'base'}: atascos=${stalls} suma=${total}ms max=${ms.length ? Math.max(...ms) : 0}ms`);
process.exit(0);
