// Verificación visual de la barra superior, los colores y el modal de estilo
// de subtítulos, sobre la app YA arrancada (no la mata ni la reinicia).
//   node tools\verify-ui-style.mjs [puertoCDP] [puertoAPI]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = Number(process.argv[2] || process.env.CMP_CDP_PORT || 9333);
const API_PORT = Number(process.argv[3] || process.env.CMP_API_PORT || 17990);
const RUNTIME_DIR = process.env.CMP_RUNTIME_DIR || path.join(ROOT, 'runtime');
const API_TOKEN = (() => {
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'control-api.json'), 'utf8'));
    return rt.token;
  } catch { return ''; }
})();
const LOG_DIR = process.env.CMP_LOG_DIR || path.join(ROOT, 'logs');
const SHOTS = path.join(LOG_DIR, 'ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('PASS |', name, ' ->', detail); }
  else { fail++; console.log('FAIL |', name, ' ->', detail); }
}

let ws = null, wsId = 0;
const pending = new Map();
function cdpSend(method, params = {}) {
  const id = ++wsId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 20000);
  });
}
async function cdpEval(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : null;
}
async function connectPage(pattern) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && pattern.test(t.url));
  if (!page) return null;
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('timeout CDP')), 8000);
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  return page;
}
async function shot(name) {
  const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) {
    const p = path.join(SHOTS, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
  return null;
}
async function apiCmd(command, args = {}, timeoutMs = 120000) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_TOKEN },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await res.json().catch(() => null);
}

// --- 1. Conectar con la ventana de controles (overlay) ----------------------
const page = await connectPage(/yt-controls\.html/);
if (!page) {
  console.log('FAIL | no se encontró la ventana de controles por CDP');
  process.exit(1);
}
await cdpSend('Page.enable');
await cdpSend('Runtime.enable');
await sleep(800);

// --- 2. Estructura de la barra superior --------------------------------------
// "Negro verdoso" = el canal verde es el más alto de los tres (G > R y G > B).
const esVerde = (c) => {
  const m = String(c || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const r = +m[1], g = +m[2], b = +m[3];
  return g > r && g > b && g < 90;
};
const top = await cdpEval(`(()=>{const t=document.getElementById('topbar');
  return { existe: !!t, alto: t?Math.round(t.getBoundingClientRect().height):0,
    arriba: t?Math.round(t.getBoundingClientRect().top):-1,
    fondo: t?getComputedStyle(t).backgroundColor:'',
    marca: (document.getElementById('brand')||{}).textContent||'',
    titulo: (document.getElementById('topTitle')||{}).textContent||'' };})()`);
check('barra de título superior presente y arriba del todo', top && top.existe && top.alto > 20 && top.arriba <= 12, JSON.stringify(top));
check('barra superior con negro verdoso (no gris)', esVerde(top.fondo), top.fondo);
check('barra superior muestra la marca Ciudadan', /ciudadan/i.test(top.marca || ''), top.marca);

// --- 3. Colores: barras verde-negras y progreso morada neón ------------------
const colors = await cdpEval(`(()=>{const bar=document.getElementById('bar'), pl=document.getElementById('played'), kn=document.getElementById('knob');
  const g=(el)=>el?getComputedStyle(el):null;
  return { barra: g(bar)?g(bar).backgroundColor:'', played: g(pl)?g(pl).backgroundImage+' | '+g(pl).backgroundColor:'',
    knob: g(kn)?g(kn).backgroundColor:'', knobSombra: g(kn)?g(kn).boxShadow:'' };})()`);
check('barra inferior en negro verdoso', esVerde(colors.barra), colors.barra);
check('progreso morado (no rojo)', /purple|fuchsia|rgb\(2[0-9][0-9], ?[0-9]{1,3}, ?2[0-9][0-9]\)|#[a-f0-9]{6}/i.test(colors.played || '') && !/#ff0000|rgb\(255, ?0, ?0\)/i.test(colors.played || ''), colors.played);
check('knob morado con brillo neón', /rgb\(2[0-9][0-9], ?[0-9]{1,3}, ?2[0-9][0-9]\)/i.test(colors.knob || '') && /rgba?\(217, ?70, ?239/.test(colors.knobSombra || ''), colors.knob + ' / ' + colors.knobSombra);

// --- 4. El modal de estilo de subtítulos ------------------------------------
await cdpEval(`document.getElementById('subStyleBtn').click()`);
await sleep(500);
const modal = await cdpEval(`(()=>{const m=document.getElementById('subStyleModal'), c=document.getElementById('subStyleCard');
  const vis=m?getComputedStyle(m).display:'';
  return { visible: !!m && vis!=='none', campos: ['ssSize','ssColor','ssBgColor','ssBgOpacity','ssOutlineColor','ssOutlineWidth'].filter(id=>!!document.getElementById(id)),
    tam: (document.getElementById('ssSize')||{}).value, color: (document.getElementById('ssColor')||{}).value,
    fondo: (document.getElementById('ssBgColor')||{}).value, op: (document.getElementById('ssBgOpacity')||{}).value,
    borde: (document.getElementById('ssOutlineColor')||{}).value, grosor: (document.getElementById('ssOutlineWidth')||{}).value,
    prev: (document.getElementById('ssPreviewText')||{}).textContent||'' };})()`);
check('modal de estilo de subtítulos se abre', modal && modal.visible, JSON.stringify({ visible: modal.visible, campos: modal.campos }));
check('modal con tamaño, colores, fondo y contorno', modal && modal.campos.length === 6, JSON.stringify(modal.campos));
const shotModal = await shot('modal-subtitulos');
check('captura del modal', !!shotModal, shotModal || '');

// --- 5. Aplicar un estilo neón y comprobar que llega al motor ----------------
const applied = await cdpEval(`(()=>{document.getElementById('ssSize').value='160';
  document.getElementById('ssSize').dispatchEvent(new Event('input'));
  document.getElementById('ssColor').value='#f0abfc';
  document.getElementById('ssColor').dispatchEvent(new Event('input'));
  document.getElementById('ssBgColor').value='#101a14';
  document.getElementById('ssBgColor').dispatchEvent(new Event('input'));
  document.getElementById('ssBgOpacity').value='55';
  document.getElementById('ssBgOpacity').dispatchEvent(new Event('input'));
  document.getElementById('ssOutlineColor').value='#d946ef';
  document.getElementById('ssOutlineColor').dispatchEvent(new Event('input'));
  document.getElementById('ssOutlineWidth').value='3';
  document.getElementById('ssOutlineWidth').dispatchEvent(new Event('input'));
  document.getElementById('ssApply').click(); return true;})()`);
await sleep(2500);
const prefs = await apiCmd('getSubtitlePrefs');
const st = prefs && prefs.result && prefs.result.subtitles ? prefs.result.subtitles.style : null;
check('el estilo aplicado se guarda en las preferencias', !!st && Number(st.size) === 160 && String(st.color).toLowerCase() === '#f0abfc', JSON.stringify(st));

// --- 7. La barra no tapa las acciones del explorador ------------------------
const modalState = await cdpEval(`(()=>{document.getElementById('modalCancel')&&0; return 1;})()`);
await cdpEval(`document.getElementById('search').click()`);
await sleep(700);
const cover = await cdpEval(`(()=>{const bar=document.getElementById('bar');
  return { modal: document.body.classList.contains('showModal'),
    barraVisible: getComputedStyle(bar).opacity, puntero: getComputedStyle(bar).pointerEvents };})()`);
check('con el explorador abierto la barra se aparta (no tapa las acciones)',
  cover && cover.modal && Number(cover.barraVisible) < 0.2 && cover.puntero === 'none', JSON.stringify(cover));
const shotModal2 = await shot('explorador-sin-barra');
check('captura del explorador sin barra', !!shotModal2, shotModal2 || '');

// --- 8. Estilo aplicado al motor: se carga un vídeo real con subtítulos -----
const logFile = path.join(LOG_DIR, 'app.log');
const logBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
const cmd = await apiCmd('setSubtitleStyle', { style: { size: 175, color: '#e879f9', bgColor: '#0b1a12', bgOpacity: 60, outlineColor: '#d946ef', outlineWidth: 3, bold: true } });
check('comando setSubtitleStyle aceptado por la API', !!cmd && cmd.result && !!cmd.result.style, JSON.stringify(cmd && cmd.result));
// Vídeo con subtítulos en español (el de la prueba del sprint).
const load = await apiCmd('load', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, 180000);
check('vídeo real cargado para probar los subtítulos', !!load && load.result && load.result.ok, JSON.stringify(load && load.result));
await sleep(12000);
const logTxt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(logBefore) : '';
const opts = (logTxt.match(/opts=.*$/m) || [])[0] || '';
check('el motor recibe las opciones freetype del estilo',
  /freetype-rel-fontsize=28/.test(opts) && /freetype-color=0xE879F9/.test(opts)
  && /freetype-outline-thickness=3/.test(opts) && /freetype-background-opacity=153/.test(opts), opts.slice(0, 300) || 'sin coincidencia');
const st2 = await apiCmd('getState').catch(() => null);
check('el vídeo sigue reproduciéndose con el estilo aplicado', !!(st2 && st2.result && st2.result.state), JSON.stringify(st2 && st2.result && st2.result.state && { status: st2.result.state.status, pos: st2.result.state.position }));

console.log(`\n== ${pass}/${pass + fail} comprobaciones PASS ==`);
process.exit(fail ? 1 : 0);
