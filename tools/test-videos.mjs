// PRUEBA MULTIVIDEO: lanza cada video en un proceso hijo aislado (tools/test-video-one.mjs)
// para que un crash o un bloqueo de libVLC no detenga la suite. Cada hijo tiene un timeout.
// Registra por video: modo, cliente, formato, reproducción, seek y bytes servidos.
// Uso: node tools/test-videos.mjs [segundos_por_video] [timeout_segundos_por_video]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECS = Number(process.argv[2] || 10);
const TIMEOUT = Number(process.argv[3] || 240) * 1000;
const VIDEOS = [
  ['Big Buck Bunny (animación, 4K/60fps)', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  ['Me at the zoo (primer video de YouTube, 2005)', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['Sintel (película de prueba Blender)', 'https://www.youtube.com/watch?v=eRsGyueVLvQ'],
  ['Tears of Steel (película de prueba Blender)', 'https://www.youtube.com/watch?v=R6MlUcmOul8'],
  ['Rick Astley (vídeo musical popular)', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['Desert (timelapse 4K)', 'https://www.youtube.com/watch?v=LXb3EKWsInQ'],
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function runOne(url, label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'test-video-one.mjs'), url, String(SECS), label], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d.slice(-600); });
    const killer = setTimeout(() => { child.kill(); }, TIMEOUT);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const m = out.match(/###RESULT###(\{[\s\S]*\})/);
      if (m) {
        try { resolve({ ...JSON.parse(m[1]), exit: code, signal }); return; } catch {}
      }
      resolve({ label, url, ok: false, played: false, seekOk: false, bytes: 0, errors: [], mode: null, client: null,
        error: signal ? `proceso terminado por ${signal} (posible bloqueo/crash de libVLC)` : `proceso terminado sin resultado (exit=${code}) ${err.slice(-200)}` });
    });
  });
}

const results = [];
for (const [label, url] of VIDEOS) {
  log('=== ' + label + ' ===');
  const r = await runOne(url, label);
  log(`   modo=${r.mode} cliente=${r.client} formato=${r.format} res=${r.resolution} t=${(r.maxTime / 1000).toFixed(1)}s seek=${r.seekOk} bytes=${(r.bytes / 1048576).toFixed(2)}MB ${r.ok ? 'PASS' : 'FAIL'}${r.error ? ' | ' + r.error : ''}`);
  results.push(r);
}

const outDir = path.resolve('logs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'videos-test.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log('\n===== RESUMEN =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.mode}/${r.client} fmt=${r.format} res=${r.resolution} | t=${(r.maxTime / 1000).toFixed(1)}s seek=${r.seekOk} | ${(r.bytes / 1048576).toFixed(1)}MB | ${r.label}${r.error ? ' | ERROR: ' + r.error : ''}`);
}
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} videos PASS`);
process.exit(passed === results.length ? 0 : 3);
