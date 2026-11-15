// Sonda: qué petición Range provoca el 416 del CDN de YouTube.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const YTDLP = 'C:\\Python313\\Scripts\\yt-dlp.exe';
const URL_VID = process.argv[2] || 'https://www.youtube.com/watch?v=k9ynZnEBtvw';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-range-'));
const out = path.join(tmp, 'info.json');

const args = ['--no-warnings', '--no-playlist', '--extractor-args', 'youtube:player_client=android',
  '-f', 'b[ext=mp4][vcodec!=none][acodec!=none][height<=720]/b[ext=mp4][vcodec!=none][acodec!=none]/b',
  '-j', URL_VID];
await new Promise((res, rej) => {
  const fd = fs.openSync(out, 'w');
  const c = spawn(YTDLP, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
  c.on('close', res); c.on('error', rej);
});
const j = JSON.parse(fs.readFileSync(out, 'utf8'));
const h = j.http_headers || {};
console.log('format', j.format_id, 'expire en url:', /expire=(\d+)/.exec(j.url)?.[1]);

const pruebas = [
  ['sin Range', null],
  ['bytes=0-', 'bytes=0-'],
  ['bytes=0-1048575', 'bytes=0-1048575'],
  ['bytes=1048576-', 'bytes=1048576-'],
  ['bytes=0-999999999999', 'bytes=0-999999999999'],
  ['bytes=0- (con UA de libVLC)', 'bytes=0-'],
];
for (const [nombre, rango] of pruebas) {
  const headers = { ...h };
  if (nombre.includes('libVLC')) { delete headers.Accept; delete headers['Accept-Language']; delete headers['Sec-Fetch-Mode']; headers['User-Agent'] = 'VLC/3.0.23 LibVLC/3.0.23'; }
  if (rango) headers.Range = rango;
  try {
    const t0 = Date.now();
    const r = await fetch(j.url, { headers, redirect: 'follow' });
    const len = r.headers.get('content-length');
    const cr = r.headers.get('content-range');
    console.log(`${nombre.padEnd(28)} -> ${r.status} ${Date.now() - t0}ms len=${len} range=${cr || '-'}`);
    // Consumir un trozo y cerrar
    try { await r.body?.cancel(); } catch {}
  } catch (e) {
    console.log(`${nombre.padEnd(28)} -> ERROR ${String(e.message || e)}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
