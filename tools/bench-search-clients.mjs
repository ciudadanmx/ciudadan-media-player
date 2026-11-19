// Cronometra la búsqueda con cada cliente de yt-dlp (mismo camino que usa la app).
// Uso: node tools\bench-search-clients.mjs [consulta]
import { spawn } from 'child_process';

const query = process.argv[2] || 'los gateways';
const YT = process.env.YT_DLP || 'C:\\Python313\\Scripts\\yt-dlp.exe';
const clients = ['web', 'mweb', 'android', 'tv', 'ios'];

function run(client, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ['--no-warnings', '--flat-playlist', '--dump-single-json',
      '--extractor-args', `youtube:player_client=${client}`, `ytsearch5:${query}`];
    const p = spawn(YT, args, { windowsHide: true });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ client, ms: Date.now() - t0, titles: 0, note: 'TIMEOUT ' + timeoutMs + 'ms' }); }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      let n = 0;
      try { const j = JSON.parse(out); n = (j.entries || []).length; } catch { n = (out.match(/"title"/g) || []).length; }
      resolve({ client, ms: Date.now() - t0, titles: n, note: code === 0 ? '' : (err.split('\n').filter(Boolean).slice(-1)[0] || '').slice(0, 90) });
    });
  });
}

console.log('cliente   tiempo   resultados   nota');
const res = await Promise.all(clients.map((c) => run(c, 90000)));
for (const r of res) console.log(`${r.client.padEnd(9)} ${String(Math.round(r.ms / 100) / 10).padStart(6)}s ${String(r.titles).padStart(8)}   ${r.note}`);
const best = res.filter((r) => r.titles > 0).sort((a, b) => a.ms - b.ms)[0];
console.log('más rápido con resultados:', best ? best.client + ' (' + Math.round(best.ms / 100) / 10 + 's)' : 'ninguno');
