// Captura de pantalla real del tercer monitor (la ventana de libVLC es un HWND
// embebido: el CDP no la ve, hay que capturar el escritorio).
//   node tools\capture-monitor.mjs <salida.png> [puertoAPI] [url]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'logs', 'monitor3.png');
const API_PORT = Number(process.argv[3] || process.env.CMP_API_PORT || 17990);
const URL_LOAD = process.argv[4] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const RUNTIME_DIR = process.env.CMP_RUNTIME_DIR || path.join(ROOT, 'runtime');
const API_TOKEN = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'control-api.json'), 'utf8')).token; }
  catch { return ''; }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiCmd(command, args = {}, timeoutMs = 180000) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await res.json().catch(() => null);
}

// 1) Cargar el vídeo y esperar a que esté sonando con subtítulos.
const load = await apiCmd('load', { url: URL_LOAD });
console.log('carga:', JSON.stringify(load && load.result));
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const st = await apiCmd('getState').catch(() => null);
  const s = st && st.result ? st.result.state : null;
  if (s && (s.status === 'playing' || s.status === 'buffering')) {
    console.log('estado:', s.status, 'pos=', s.position, 'titulo=', s.title);
    break;
  }
}
await sleep(4000);

// 2) Captura del tercer monitor (DISPLAY3: x=-1440, y=76, 1440x900).
const ps = `$b = New-Object System.Drawing.Bitmap 1440,900
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(-1440,76,0,0,(New-Object System.Drawing.Size(1440,900)))
$b.Save('${OUT.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose()
Write-Output 'captura lista'`;
execFileSync('powershell', ['-NoProfile', '-Command', `
Add-Type -AssemblyName System.Drawing
${ps}`], { stdio: 'inherit' });
console.log('captura guardada en', OUT);
