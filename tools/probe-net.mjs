// Verifica TLS de Node contra youtube.com y googlevideo (Range) sin named pipes.
const r1 = await fetch('https://www.youtube.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
console.log('youtube.com:', r1.status);

// Resolver vía yt-dlp escribiendo stdout a FD de archivo (evita named pipe del sandbox)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), 'ytdlp-' + Date.now() + '.json');
const outFd = fs.openSync(tmp, 'w');
const p = spawn('yt-dlp', [
  '--no-warnings',
  '--extractor-args', 'youtube:player_client=android',
  '-f', 'b[ext=mp4][vcodec!=none][acodec!=none]/b[ext=mp4]/b',
  '-j', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
], { stdio: ['ignore', outFd, 'ignore'], windowsHide: true });
const code = await new Promise(res => p.on('close', res));
fs.closeSync(outFd);
console.log('yt-dlp exit:', code, 'json bytes:', fs.statSync(tmp).size);
const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);
const fmt = (j.formats || []).find(f => f.vcodec !== 'none' && f.acodec !== 'none') || j;
console.log('format:', fmt.format_id, fmt.ext, fmt.resolution, 'dur', fmt.duration, 'UA:', fmt.http_headers['User-Agent']);

const h = { ...fmt.http_headers, Range: 'bytes=0-1048575' };
const r2 = await fetch(fmt.url, { headers: h });
const buf = Buffer.from(await r2.arrayBuffer());
console.log('googlevideo GET range:', r2.status, 'bytes:', buf.length, 'ct:', r2.headers.get('content-type'),
  'cr:', r2.headers.get('content-range'), 'ftyp@4:', buf.slice(4, 8).toString('latin1'));
