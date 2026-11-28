// Prueba de reproducción REAL desde un resultado de búsqueda, contra una app
// ya en marcha (no arranca ni mata nada: no toca la instancia del usuario).
// Uso: node tools\verify-play-from-result.mjs [apiPort]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API_PORT = Number(process.argv[2] || 17990);
const runtimeFile = process.argv[3]
  || path.join(os.homedir(), 'AppData', 'Local', 'CiudadanMediaPlayer', 'workspace', 'runtime', 'control-api.json');
const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
const BASE = `http://127.0.0.1:${API_PORT}`;

async function cmd(command, args = {}) {
  const r = await fetch(`${BASE}/cmd`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + rt.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'pf-' + Math.random().toString(36).slice(2), command, args }),
  });
  return r.json();
}
async function state() {
  const r = await fetch(`${BASE}/state`, { headers: { Authorization: 'Bearer ' + rt.token } });
  return (await r.json()).state;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1) Buscando…');
const t0 = Date.now();
const s = await cmd('search', { query: 'pink floyd', limit: 6 });
const items = (s.result && s.result.items) || [];
console.log(`   ${items.length} resultados en ${Math.round((Date.now() - t0) / 100) / 10}s (origen: ${s.result.source || 'yt-dlp'})`);
if (!items.length) { console.log('FALLO: sin resultados'); process.exit(1); }
items.slice(0, 4).forEach((i) => console.log('   - ' + i.title));

console.log('2) Cargando y reproduciendo el primer resultado…');
const it = items[0];
const r = await cmd('load', { url: it.url });
console.log('   comando load:', r.ok ? 'aceptado' : ('ERROR ' + JSON.stringify(r.error || r)));
if (!r.ok) { console.log('   FALLO: no se pudo cargar'); process.exit(1); }
let playing = false;
for (let i = 0; i < 40; i++) {
  await sleep(1500);
  const st = await state();
  if (st.status === 'playing' && st.position > 1) { playing = true; console.log(`   reproduciendo: "${st.title}" pos=${st.position.toFixed(1)}s dur=${st.duration}s`); break; }
}
if (!playing) { const st = await state(); console.log('   FALLO: no llegó a reproducir. estado=', JSON.stringify({ status: st.status, error: st.error })); process.exit(1); }

console.log('3) La posición avanza (15 s de observación)…');
const p0 = (await state()).position;
await sleep(15000);
const p1 = (await state()).position;
console.log(`   ${p0.toFixed(1)}s -> ${p1.toFixed(1)}s (delta ${(p1 - p0).toFixed(1)}s)`);
console.log(p1 - p0 > 8 ? 'RESULTADO: la reproducción desde un resultado de búsqueda funciona' : 'FALLO: la posición no avanza');
process.exit(p1 - p0 > 8 ? 0 : 1);
