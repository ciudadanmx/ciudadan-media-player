// Reproduce el spawn que hace el resolver (stdout a FD de fichero) y mide.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const which = process.argv[2] || 'yt-dlp';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-spawn-'));
const out = path.join(tmp, 'info.json');
const err = path.join(tmp, 'info.err');
const t0 = Date.now();
const outFd = fs.openSync(out, 'w');
const errFd = fs.openSync(err, 'w');
const args = ['--no-warnings', '--no-playlist', '--extractor-args', 'youtube:player_client=android',
  '-f', 'b[ext=mp4][vcodec!=none][acodec!=none][height<=720]/b[ext=mp4][vcodec!=none][acodec!=none]/b',
  '-j', 'https://www.youtube.com/watch?v=k9ynZnEBtvw'];
let child;
try {
  child = spawn(which, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
} catch (e) {
  console.log('spawn error:', e.message);
  process.exit(1);
}
child.on('error', (e) => console.log('child error:', e.message, Date.now() - t0, 'ms'));
child.on('close', (code) => {
  const size = fs.statSync(out).size;
  const errTxt = fs.readFileSync(err, 'utf8').slice(0, 300);
  console.log(`exit=${code} en ${Date.now() - t0} ms, json=${size} bytes`);
  if (errTxt) console.log('stderr:', errTxt);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
setTimeout(() => { console.log('TIMEOUT local 60s'); try { child.kill(); } catch {} }, 60000);
