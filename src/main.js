// CIUDADAN MEDIA PLAYER — proceso principal Electron.
// YouTube -> yt-dlp (URL directa) -> proxy local 127.0.0.1 con Range -> libVLC (koffi) -> HWND.
// Controles Play/Pausa/Seek/Volumen vía IPC desde la ventana de controles.
import { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveYouTube, videoIdOf, clearResolveCache } from './resolver.js';
import { StreamProxy } from './proxy.js';
import { VlcPlayer, STATE_NAMES } from './vlc.js';
import { toolVersions } from './tools-info.js';
import { assertTools, VLC_DIR } from './paths.js';
import { ControlApi } from './control-api.js';
import { PLAYLIST } from './playlist.js';
import { UserStore, FAVORITES_LIST_ID, WATCH_LATER_LIST_ID } from './store.js';
import { QueueManager } from './queue.js';
import { SearchRegistry } from './search/provider.js';
import { YtDlpSearchProvider } from './search/ytdlp-provider.js';
import { classifyItem } from './classifier.js';
import { MixScheduler } from './mix.js';
import { HistoryRepository } from './history.js';
import { DiscoveryService } from './discovery.js';
import { ContinuityEngine } from './continuity.js';
import { pickTrack, downloadSubtitle, subtitleTracksFromInfo, subsDir, cleanupSubtitles, DEFAULT_SUB_LANGS } from './subtitles.js';

// ---------------------------------------------------------------------------
// Estilo de los subtítulos -> opciones de libVLC (módulo freetype).
// El usuario puede fijar tamaño, color del texto, color y opacidad del fondo y
// el contorno (stroke) de las letras. Los valores se aplican al crear el medio
// (afectan a las pistas SPU y a las externas) y se guardan en las preferencias.
// ---------------------------------------------------------------------------
const SUB_STYLE_DEFAULTS = {
  size: 100, color: '#ffffff', bgColor: '#000000', bgOpacity: 35,
  outlineColor: '#000000', outlineWidth: 2, bold: false,
};
function normalizeSubtitleStyle(raw) {
  const s = Object.assign({}, SUB_STYLE_DEFAULTS, raw || {});
  const hex = (v, def) => {
    const h = String(v || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return def;
    return '#' + h.toUpperCase();
  };
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  return {
    size: num(s.size, 100, 50, 300),
    color: hex(s.color, SUB_STYLE_DEFAULTS.color),
    bgColor: hex(s.bgColor, SUB_STYLE_DEFAULTS.bgColor),
    bgOpacity: num(s.bgOpacity, 35, 0, 100),
    outlineColor: hex(s.outlineColor, SUB_STYLE_DEFAULTS.outlineColor),
    outlineWidth: num(s.outlineWidth, 2, 0, 3),
    bold: !!s.bold,
  };
}
function subtitleStyleOptions(raw) {
  const s = normalizeSubtitleStyle(raw);
  // libVLC espera los colores en formato 0xRRGGBB.
  const toVlc = (hex) => '0x' + String(hex).replace('#', '').toUpperCase();
  // Tamaño relativo de libVLC: 16 = normal. El porcentaje del usuario se
  // aplica sobre esa base (100% -> 16, 200% -> 32).
  const rel = Math.max(8, Math.min(48, Math.round(16 * (s.size / 100))));
  const opts = [
    ':freetype-rel-fontsize=' + rel,
    ':freetype-color=' + toVlc(s.color),
    ':freetype-opacity=255',
    ':freetype-background-color=' + toVlc(s.bgColor),
    ':freetype-background-opacity=' + Math.round((s.bgOpacity / 100) * 255),
    ':freetype-outline-color=' + toVlc(s.outlineColor),
    ':freetype-outline-thickness=' + s.outlineWidth,
    ':freetype-bold=' + (s.bold ? 'true' : 'false'),
  ];
  return opts;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Identificador de esta instancia de reproductor (lo usa el coordinador para
// distinguir varios reproductores).
const PLAYER_ID = process.env.CMP_PLAYER_ID || 'ciudadan-media-main';
// Las carpetas de estado (runtime, logs, datos) pueden salirse del proyecto con
// variables de entorno. Es IMPORTANTE cuando el proyecto vive en una unidad
// sincronizada (Google Drive, OneDrive...): allí cada escritura pasa por el
// proceso de sincronización, que bloquea el fichero y ralentiza la app (el log
// llegó a tardar 1 s por línea y el hilo principal se congelaba).
const RUNTIME_DIR = process.env.CMP_RUNTIME_DIR || path.join(ROOT, 'runtime');
const API_FILE = path.join(RUNTIME_DIR, 'control-api.json');
// Favicon/icono de la app (Ciudadan morado, versión con transparencia)
const APP_ICON = path.join(ROOT, 'assets', 'favicon-ciudadan-morado-transparente.ico');
try { app.setAppUserModelId('ciudadan.media.player'); } catch {}
// Perfil de usuario propio y limpio: un perfil de Electron corrupto en %APPDATA% provoca
// crash (0xc0000005) del browser process antes de 'ready' en esta máquina.
app.setPath('userData', process.env.CMP_USER_DATA || path.join(ROOT, '.electron-userdata'));
const LOG_DIR = process.env.CMP_LOG_DIR || path.join(ROOT, 'logs');
// Datos persistentes del usuario (listas, cola, historial): un único JSON.
const DATA_DIR = process.env.CMP_DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'ciudadan-media-store.json');
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'app.log');
fs.writeFileSync(path.join(LOG_DIR, 'main-ran.txt'), 'main.js ejecutado pid=' + process.pid + ' argv=' + JSON.stringify(process.argv) + '\n');
// Log con ESCRITURA EN BUFFER: escribir en disco de forma sincrónica en cada
// línea bloqueaba el hilo principal (y el antivirus analizaba el fichero en
// cada escritura: cientos de ms por línea). Ahora se acumula y se vuelca cada
// 500 ms; al salir se descarga de forma sincrónica para no perder nada.
// El stdout (redirigido a un fichero por el lanzador) también se limita: es
// otra escritura sincrónica.
const logBuf = [];
let logFlushTimer = null;
let consoleCount = 0;
let consoleWindowStart = Date.now();
const slowLogWrites = [];   // duración de las escrituras lentas del log (diagnóstico)
let lastLogWriteMs = 0;
let logStream = null;
// El log se escribe con un HANDLE PERSISTENTE: antes se usaba appendFile, que
// abría y cerraba el fichero en cada volcado (cada 500 ms). El antivirus
// interceptaba esa apertura y el hilo principal se quedaba bloqueado hasta
// 5 s por volcado (la app "no servía" la reproducción). Con el stream abierto
// una sola vez, el antivirus analiza el fichero una vez y no en cada línea.
function getLogStream() {
  if (logStream) return logStream;
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.on('error', () => { try { logStream.destroy(); } catch {} logStream = null; });
  } catch { logStream = null; }
  return logStream;
}
function flushLog(sync = false) {
  if (!logBuf.length) return;
  const data = logBuf.join('');
  logBuf.length = 0;
  try {
    if (sync) {
      fs.appendFileSync(LOG_FILE, data);
      try { if (logStream) { logStream.end(); logStream = null; } } catch {}
    } else {
      const s = getLogStream();
      if (s) {
        const t0 = Date.now();
        s.write(data, () => {
          const dt = Date.now() - t0;
          lastLogWriteMs = dt;
          if (dt > 250) slowLogWrites.push(dt);
        });
      } else {
        fs.appendFile(LOG_FILE, data, () => {});
      }
    }
  } catch {}
}
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  logBuf.push(line + '\n');
  if (logBuf.length > 2000) logBuf.splice(0, logBuf.length - 1000);
  if (!logFlushTimer) logFlushTimer = setTimeout(() => { logFlushTimer = null; flushLog(false); }, 500);
  const now = Date.now();
  if (now - consoleWindowStart > 1000) { consoleWindowStart = now; consoleCount = 0; }
  if (consoleCount < 5) { consoleCount++; try { console.log(line); } catch {} }
};

// Modo auto-test: electron . --auto-test   (URL y duración por variables de entorno)
// OJO: pasar la URL como argumento posicional a Electron hace que el browser process
// muera antes de 'ready' (comprobado: '?v=...' como argumento posicional rompe el arranque).
const AUTO_TEST = process.argv.includes('--auto-test');
const AUTO_URL = process.env.CMP_AUTOTEST_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const AUTO_SECS = Number(process.env.CMP_AUTOTEST_SECS || 45);

const missing = assertTools();
if (missing.length) log('FALTAN rutas:', missing.join(', '));

let winVideo = null;
let winOverlay = null;
let proxy = null;
let vlc = null;
// Almacenamiento persistente (listas/cola/historial) y gestor de cola.
const store = new UserStore(STORE_FILE);
const queue = new QueueManager(store);
// Proveedores de búsqueda (hoy: YouTube vía yt-dlp; mañana caben más).
const searchRegistry = new SearchRegistry();
searchRegistry.register(new YtDlpSearchProvider());
// --- Servicios reutilizables del sprint (desacoplados de la UI) ---------------
// HistoryRepository: historial persistente de reproducciones y búsquedas.
const historyRepo = new HistoryRepository(store, { log });
// MixScheduler: rotación ponderada Música/Temas (modo personalizado).
const mix = new MixScheduler({ musicPct: store.prefs().mix.musicPct ?? 50 });
// DiscoveryService: candidatos de continuidad sólo con metadatos.
const discovery = new DiscoveryService({
  search: (q, opts) => searchRegistry.default().search(q, opts),
  fetchFlat: (u, opts) => searchRegistry.default().fetchFlat(u, opts),
  log,
});
// ContinuityEngine: decide el siguiente contenido al finalizar.
const continuity = new ContinuityEngine({
  queue, discovery, mix,
  onPlay: (item, origin) => playMediaItem(item, origin || 'system'),
  log,
});
// Aplica las preferencias persistentes a los servicios.
continuity.setMode(store.prefs().continuity.mode === 'solo' ? 'solo' : 'continuo');
continuity.setSource(store.prefs().continuity.source || 'search');
continuity.setContentMode(store.prefs().contentMode || 'temas', store.prefs().mix);
// Última búsqueda activa (fuente "Mi búsqueda" de la continuidad) y su contexto.
let lastSearchQuery = '';
let lastSearchFilters = null;
log('almacenamiento:', STORE_FILE, '| listas:', store.lists().map((l) => l.name).join(', '));
log('proveedores de búsqueda:', searchRegistry.list().map((p) => p.id).join(', '));
log('prefs:', JSON.stringify(store.prefs()));

// --- Barra flotante estilo YouTube sobre el vídeo -----------------------------
// La ventana de vídeo pinta con libVLC sobre un HWND nativo: el DOM no puede
// superponerse a ese HWND, así que la barra vive en una ventana propia
// transparente, siempre encima y con los mismos límites que el vídeo.
const OVERLAY_IDLE_MS = 3000; // se oculta tras 3 s sin movimiento del ratón
let overlayVisible = true;    // la barra se muestra al arrancar
let overlayLastMove = Date.now();
let cursor = { x: -1, y: -1 };

// La posición del ratón se lee con screen.getCursorScreenPoint() (mismas
// coordenadas DIP que winVideo.getContentBounds(), sin FFI).
function readCursor() {
  try { return screen.getCursorScreenPoint(); } catch { return null; }
}

function showOverlay(force = false) {
  if (!winOverlay || winOverlay.isDestroyed()) return;
  if (overlayVisible && !force) { overlayLastMove = Date.now(); return; }
  overlayVisible = true;
  overlayLastMove = Date.now();
  try { winOverlay.webContents.send('cmp:overlay', { visible: true }); } catch {}
}

function hideOverlay() {
  if (!winOverlay || winOverlay.isDestroyed()) return;
  if (!overlayVisible) return;
  overlayVisible = false;
  try { winOverlay.webContents.send('cmp:overlay', { visible: false }); } catch {}
}

// El overlay se coloca sobre el ÁREA DE CONTENIDO de la ventana de vídeo
// (getContentBounds), NO sobre getBounds: así la barra de título del sistema
// queda libre y se puede minimizar, mover y cerrar la ventana.
function videoContentBounds() {
  try { return winVideo.getContentBounds(); } catch { return winVideo.getBounds(); }
}

function watchCursor() {
  setInterval(() => {
    const t0 = Date.now();
    if (!winOverlay || winOverlay.isDestroyed() || !winVideo || winVideo.isDestroyed()) return;
    const p = readCursor();
    if (!p) return;
    const moved = p.x !== cursor.x || p.y !== cursor.y;
    if (moved) { cursor = p; overlayLastMove = Date.now(); }
    const b = videoContentBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside && moved) showOverlay();
    else if (!inside && Date.now() - overlayLastMove > 600) hideOverlay();
    else if (inside && Date.now() - overlayLastMove > OVERLAY_IDLE_MS) hideOverlay();
    const ms = Date.now() - t0;
    if (ms > 120) log('CURSOR LENTO: ' + ms + ' ms');
  }, 150);
}

function createWindows() {
  // Monitor de pruebas: con CMP_SCREEN_INDEX=2 la ventana se abre en el
  // TERCER monitor (para no interferir con lo que el usuario está usando).
  // Sin la variable, la ventana aparece donde Electron la pone por defecto.
  let winOpts = {
    width: 960, height: 570, minWidth: 480, minHeight: 300,
    backgroundColor: '#000000', title: 'Ciudadan Media Player',
    icon: APP_ICON,
    // El menú (Archivo, Editar, Vista...) queda oculto y sólo aparece al
    // pulsar Alt, como en los reproductores nativos.
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  };
  try {
    const idx = Number(process.env.CMP_SCREEN_INDEX);
    if (Number.isFinite(idx) && idx >= 0) {
      const displays = screen.getAllDisplays();
      const d = displays[idx];
      if (d && d.bounds) {
        winOpts = { ...winOpts, x: d.bounds.x + 40, y: d.bounds.y + 40, width: Math.min(1100, d.bounds.width - 80), height: Math.min(660, d.bounds.height - 100) };
        log('ventana en el monitor', idx + 1, 'de', displays.length, JSON.stringify(d.bounds));
      }
    }
  } catch (e) { log('no se pudo elegir el monitor:', String(e.message || e)); }
  winVideo = new BrowserWindow(winOpts);
  winVideo.loadFile(path.join(ROOT, 'renderer', 'video.html'));
  winVideo.once('ready-to-show', () => {
    try {
      winVideo.show();
      winVideo.focus();
      log('ventana de video: visible=', winVideo.isVisible(), 'minimizada=', winVideo.isMinimized(), 'fullscreen=', winVideo.isFullScreen(), JSON.stringify(winVideo.getBounds()));
    } catch (e) { log('ventana de video: no se pudo mostrar:', String(e.message || e)); }
  });

  // Barra flotante estilo YouTube: ventana transparente encima del vídeo.
  // Es una ventana INDEPENDIENTE (no hija de la de vídeo): como hija, Electron
  // la crea como ventana embebida y las coordenadas absolutas de setBounds la
  // dejaban fuera de la ventana padre (la ventana de vídeo quedaba oculta y
  // sólo se veía la franja flotando sin poder moverse).
  winOverlay = new BrowserWindow({
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, focusable: true,
    show: false, width: 960, height: 540, icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  winOverlay.loadFile(path.join(ROOT, 'renderer', 'yt-controls.html'));
  winOverlay.once('ready-to-show', () => {
    try { winOverlay.show(); } catch {}
    // La barra es un overlay del vídeo: no debe aparecer como ventana aparte en
    // la barra de tareas (mismo título e icono -> se agrupa con la principal).
    try { winOverlay.setSkipTaskbar(true); } catch {}
    try { winOverlay.setMenuBarVisibility(false); } catch {}
    positionOverlay();
  });

  positionOverlay();
  watchCursor();
  overlayLastMove = Date.now();   // la barra permanece visible los primeros 3 s
  overlayVisible = true;
  winVideo.on('resize', positionOverlay);
  winVideo.on('move', positionOverlay);
  winVideo.on('maximize', positionOverlay);
  winVideo.on('restore', positionOverlay);
  winVideo.on('enter-full-screen', positionOverlay);
  winVideo.on('leave-full-screen', positionOverlay);
  winVideo.on('blur', () => {
    // Se sueltan los atajos globales (sólo deben actuar con el reproductor enfocado).
    unregisterVideoShortcuts();
    // Sólo se oculta si el ratón no está sobre el vídeo: al pulsar la barra
    // superpuesta el vídeo pierde el foco y no debe desaparecer.
    const p = readCursor();
    if (!p || !winVideo || winVideo.isDestroyed()) return;
    const b = videoContentBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (!inside) hideOverlay();
  });
  winVideo.on('focus', () => registerVideoShortcuts());
  winVideo.on('closed', () => { winVideo = null; try { winOverlay?.close(); } catch {} winOverlay = null; });
}

// --- Atajos tipo YouTube mientras el vídeo tiene el foco ------------------------
// El HWND nativo de libVLC se queda con el foco del teclado, así que las teclas
// no llegan al DOM: se registran atajos globales sólo mientras la ventana de
// vídeo está enfocada (y se sueltan en 'blur').
const VIDEO_SHORTCUTS = {
  'Space': { cmd: 'togglePlay', args: {} },
  'Left': { cmd: 'rewind', args: { seconds: 10 } },
  'Right': { cmd: 'forward', args: { seconds: 10 } },
  'Up': { cmd: 'volumeUp', args: { delta: 5 } },
  'Down': { cmd: 'volumeDown', args: { delta: 5 } },
  'M': { cmd: null, args: {} },   // silenciar/restaurar según el estado real
  'F': { cmd: 'fullscreen', args: {} },
};
let shortcutsRegistered = false;
function registerVideoShortcuts() {
  if (shortcutsRegistered) return;
  try {
    for (const [acc, spec] of Object.entries(VIDEO_SHORTCUTS)) {
      globalShortcut.register(acc, async () => {
        const cmd = spec.cmd || (vlc?.getMute?.() ? 'unmute' : 'mute');
        try { await executeCommand(cmd, spec.args, 'user'); }
        catch (e) { log('atajo ' + acc + ':', String(e.message || e)); }
        sendUpdate();
      });
    }
    shortcutsRegistered = true;
  } catch (e) { log('atajos globales no disponibles:', String(e)); }
}
function unregisterVideoShortcuts() {
  if (!shortcutsRegistered) return;
  try { for (const acc of Object.keys(VIDEO_SHORTCUTS)) globalShortcut.unregister(acc); } catch {}
  shortcutsRegistered = false;
}

// La ventana superpuesta ocupa el área de CONTENIDO del vídeo (deja libre la
// barra de título del sistema para poder mover, minimizar y cerrar la ventana).
function positionOverlay() {
  if (!winVideo || !winOverlay || winVideo.isDestroyed() || winOverlay.isDestroyed()) return;
  const b = videoContentBounds();
  try {
    // El overlay es una ventana independiente que se coloca justo encima del
    // área de contenido de la ventana de vídeo y la sigue al moverla.
    // Va con alwaysOnTop para que quede por encima del vídeo (que es un HWND
    // embebido de libVLC).
    winOverlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    winOverlay.setAlwaysOnTop(true);
  } catch {}
}

function sendUpdate(snap = null) {
  const s = snap || getState();
  if (winOverlay && !winOverlay.isDestroyed()) winOverlay.webContents.send('cmp:update', s);
}

function getState() {
  // Estado interno (renderer + pruebas). El motor libVLC es la fuente de verdad.
  const fs = fullscreenNow();
  const pl = { playlistIndex: currentPlaylistIndex, playlistLength: PLAYLIST.length };
  if (!vlc || !vlc.player) {
    const prefs = store.prefs();
    return {
      playerId: PLAYER_ID, state: 0, stateName: 'Idle', status: engineReady ? 'idle' : 'preparing',
      time: 0, length: 0, position: 0, duration: 0,
      volume: lastVolume, muted: lastMute, isPlaying: false, ended: false,
      seekable: false, fullscreen: fs,
      title: currentTitle, mode: currentMode, error: currentError,
      videoId: currentId, url: currentUrl, connected: !!api, stateVersion, ...pl,
      contentMode: prefs.contentMode,
      mix: prefs.mix,
      continuity: { mode: continuity.mode, source: continuity.source, autoQueue: continuity.autoQueue.length },
      subtitles: { enabled: prefs.subtitles.enabled !== false, lang: prefs.subtitles.lang, selected: -1 },
      filters: prefs.filters || {},
    };
  }
  const st = vlc.getState();
  const length = vlc.getLength();
  const time = vlc.getTime();
  const volume = vlc.getVolume();
  const muted = vlc.getMute();
  lastVolume = volume; lastMute = muted;
  const prefs = store.prefs();
  return {
    playerId: PLAYER_ID,
    state: st, stateName: STATE_NAMES[st] || '?', status: statusOf(st),
    time, length, position: vlc.getPosition(), duration: Math.round(length / 1000),
    positionSeconds: Math.round(time / 100) / 10,
    volume, muted, isPlaying: vlc.isPlaying(), ended: st === 6,
    seekable: length > 0, fullscreen: fs,
    title: currentTitle, mode: currentMode, error: currentError,
    videoId: currentId, url: currentUrl, connected: true, stateVersion, ...pl,
    // --- sprint: continuidad, modo de contenido y subtítulos (solo lectura) ---
    contentMode: prefs.contentMode,
    mix: prefs.mix,
    continuity: { mode: continuity.mode, source: continuity.source, autoQueue: continuity.autoQueue.length },
    subtitles: { enabled: prefs.subtitles.enabled !== false, lang: prefs.subtitles.lang, selected: vlc._last.spu ?? -1 },
    filters: prefs.filters || {},
  };
}

// Estado con la forma del contrato de control (segundos, no milisegundos).
function apiState() { return apiStateFrom(getState()); }
// Variante que reutiliza una lectura ya hecha del motor (evita llamadas FFI
// duplicadas en cada ciclo de sondeo).
function apiStateFrom(s) {
  return {
    playerId: PLAYER_ID,
    status: s.status,
    volume: s.volume,
    muted: s.muted,
    position: s.positionSeconds || 0,
    duration: s.duration || 0,
    seekable: !!s.seekable,
    fullscreen: !!s.fullscreen,
    videoId: s.videoId || null,
    title: s.title || '',
    url: s.url || '',
    mode: s.mode || null,
    connected: true,
    stateVersion,
    error: s.error || null,
    libvlcState: s.stateName,
    // --- sprint (sólo lectura, additive: el contrato anterior no cambia) ---
    contentMode: s.contentMode,
    mix: s.mix,
    continuity: s.continuity,
    subtitles: s.subtitles,
    filters: s.filters,
  };
}

function statusOf(st) {
  return ({ 0: 'idle', 1: 'opening', 2: 'buffering', 3: 'playing', 4: 'paused', 5: 'stopped', 6: 'ended', 7: 'error' })[st] || 'idle';
}

function fullscreenNow() {
  try { return !!(winVideo && !winVideo.isDestroyed() && winVideo.isFullScreen()); } catch { return false; }
}

let currentTitle = '';
let currentMode = null;
let currentError = null;
let currentId = null;
let currentUrl = '';
// Metadatos del medio actual (para continuidad "mismo canal" / "tema").
let currentChannel = null;
let currentChannelId = null;
let currentChannelUrl = null;
let currentCategory = null;
let currentUploaderId = null;
// Índice actual dentro de la lista hardcodeada (src/playlist.js).
let currentPlaylistIndex = 0;
// Control API local (coordinador Node.js) y control de estado.
let api = null;
let stateVersion = 0;
let lastVolume = 100;
let lastMute = false;
let lastStatus = 'idle';
// último evento del motor registrado en el log (para no repetir ráfagas)
let lastEventName = '';
let lastEventAt = 0;
let switchingMedia = false; // true mientras se cambia de medio (los errores del medio viejo son previstos)
// true cuando el usuario ha pedido parar: la vigilancia no debe "recuperar"
// ese medio (sería reiniciar un vídeo que el usuario ha parado a propósito).
let intentionalStop = false;
// true cuando el usuario ha pedido pausa: un stream muerto deja el motor en
// "paused" y, sin esta marca, la vigilancia no podría distinguirlo de una
// pausa pedida a propósito (y el vídeo se quedaría en negro sin recuperarse).
let intentionalPause = false;
// true cuando libVLC ya está listo para reproducir.
let engineReady = false;
// Promesa resuelta cuando el motor termina de arrancar.
let engineReadyPromise = null;
let resolveEngineReady = null;
const recentEvents = [];
let pollTick = 0;
// Guarda la posición actual en el historial de inmediato (pausa, stop, cambio
// de medio, cierre controlado): force=true salta el throttle del repositorio.
function saveProgressNow() {
  try {
    if (vlc && vlc.player && currentId) {
      historyRepo.updateProgress(currentId, vlc.getTime() || 0, vlc.getLength() || 0, { force: true });
    }
  } catch {}
}

// Carga (o recarga) de una URL de YouTube: resuelve con yt-dlp y arranca libVLC.
// Se ejecuta EN SERIE: si dos cargas llegan a la vez (API + botón + autoavance),
// libVLC recibiría dos cambios de medio cruzados y el motor quedaría
// inconsistente (vídeo en negro o estado incoherente). La cadena nunca se
// rompe: un fallo en una carga no bloquea las siguientes.
let loadChain = Promise.resolve();
async function loadUrl(url, origin = 'user') {
  const task = loadChain.then(() => loadUrlInner(url, origin), () => loadUrlInner(url, origin));
  loadChain = task.then(() => {}, () => {});
  return task;
}

async function loadUrlInner(url, origin = 'user') {
  try {
    log('load:', url);
    saveProgressNow();          // al cambiar de medio se guarda la posición del anterior
    intentionalStop = false;   // una carga nueva siempre es intencionada
    intentionalPause = false;
    // Si el motor todavía se está preparando (arranque en segundo plano), se
    // espera a que esté listo en vez de fallar.
    if (!engineReady && engineReadyPromise) {
      const ok = await Promise.race([
        engineReadyPromise,
        new Promise((r) => setTimeout(() => r(false), 180000)),
      ]);
      if (!ok) throw new Error('el motor de reproducción no está disponible');
    }
    const entry = await resolveYouTube(url);
    currentTitle = entry.title; currentMode = entry.mode; currentError = entry.errors?.join('; ') || null; currentId = entry.id;
    currentUrl = url;
    currentChannel = entry.channel || null;
    currentChannelId = entry.channelId || null;
    currentChannelUrl = entry.channelUrl || null;
    currentCategory = entry.category || null;
    currentUploaderId = entry.uploaderId || null;
    // Si la URL cargada es un elemento de la lista, se marca como actual.
    const plIdx = PLAYLIST.findIndex((it) => it.url === url || (entry.id && it.id === entry.id));
    if (plIdx >= 0) currentPlaylistIndex = plIdx;
    // Historial local de reproducciones (entrada rica: clasificación + contexto).
    const ytId = videoIdOf(url);
    const cls = classifyItem({ title: entry.title, channel: entry.channel, category: entry.category });
    const histEntry = historyRepo.recordPlay(
      { id: ytId, provider: 'ytdlp', title: entry.title, url, duration: entry.duration || null, channel: entry.channel, thumbnail: null, category: entry.category },
      { context: lastSearchQuery || null, classification: cls },
    );
    queue.setCurrent(ytId);
    // La continuidad no debe encadenar un vídeo ya reproducido hace poco.
    try {
      const recent = historyRepo.query({ limit: 30 }).items
        .map((h) => h.sourceId || String(h.id || '').replace(/^[^:]+:/, ''))
        .filter(Boolean);
      continuity.setRecentIds(recent);
    } catch {}
    if (entry.errors?.length) log('avisos del resolver:', entry.errors.join(' || '));
    proxy.register(entry);
    const streamUrl = proxy.streamUrl(entry.id);
    log(`resuelto: modo=${entry.mode} client=${entry.client} format=${entry.formatId} res=${entry.resolution} -> ${streamUrl}`);
    // --- Subtítulos externas (preferencia persistida) --------------------------
    // Se descargan en segundo plano con timeout corto: NUNCA retrasan el play.
    const subPrefs = store.prefs().subtitles || { enabled: true, lang: 'es' };
    let subtitleFile = null;
    if (subPrefs.enabled !== false && Array.isArray(entry.subtitleTracks) && entry.subtitleTracks.length) {
      const track = pickTrack(entry.subtitleTracks, [subPrefs.lang || 'es', ...DEFAULT_SUB_LANGS]);
      if (track) {
        subtitleFile = await downloadSubtitle(track, subsDir(process.env.CMP_TMPDIR || path.join(ROOT, '.tmp')), { timeoutMs: 4000 });
        if (subtitleFile) log('subtítulos: pista', track.lang, '->', subtitleFile);
        else log('subtítulos: no se pudo descargar la pista', track.lang, '(se reproduce sin CC)');
      }
    }
    // La ventana de video puede haberse cerrado mientras se resolvia la URL
    // (tarda ~4 s). En ese caso no se puede embeber libVLC: se avisa claro.
    if (!winVideo || winVideo.isDestroyed()) {
      throw new Error('la ventana de video esta cerrada: no se puede reproducir (vuelve a abrir la app)');
    }
    // Continuidad: se preparan (en segundo plano, sólo metadatos) hasta 3
    // candidatos para el vídeo SIGUIENTE. Así, al terminar el actual, el
    // siguiente arranca sin espera aunque no haya ninguna búsqueda activa.
    // No bloquea la reproducción ni el hilo principal.
    try {
      const prepMeta = {
        id: entry.id, title: entry.title, url,
        channel: entry.channel, channelId: entry.channelId, channelUrl: entry.channelUrl,
        category: entry.category, uploaderId: entry.uploaderId,
      };
      setTimeout(() => {
        continuity.prepare({ current: prepMeta, searchQuery: lastSearchQuery })
          .catch((e) => log('continuidad: preparación ignorada:', String(e.message || e)));
      }, 4000);
    } catch {}
    const hwndBuf = winVideo.getNativeWindowHandle();
    // Antes de cambiar de medio se corta el stream anterior: si el hilo de
    // entrada de libVLC sigue leyendo del socket, su stop() interno se bloquea
    // y el proceso principal deja de responder (la API muere al cambiar de
    // vídeo con algo sonando). Durante el cambio se ignoran los errores del
    // medio viejo, que son provocados por nosotros.
    switchingMedia = true;
    try { proxy.abortAll(); } catch {}
    const mediaOptions = [':network-caching=1200'];
    // --- Estilo de los subtítulos (libVLC freetype) --------------------------
    // Tamaño relativo, color de texto, fondo (color + opacidad) y contorno
    // (stroke) de las letras. Se aplican como opciones del medio, así que
    // affectan tanto a las pistas SPU internas como a las externas (slave).
    for (const opt of subtitleStyleOptions(subPrefs.style)) mediaOptions.push(opt);
    // OJO: con streams HTTP (nuestro proxy) ":sub-file=" NO engancha la pista;
    // hay que usar ":input-slave=file:///..." (verificado con sonda sobre HTTP).
    if (subtitleFile) {
      const fwd = subtitleFile.split('\\').join('/');
      const slave = /^[A-Za-z]:\//.test(fwd) ? 'file:///' + fwd : 'file://' + fwd;
      mediaOptions.push(':input-slave=' + slave);
    }
    // vlc.play() es asíncrono: no bloquea el hilo principal aunque stop()/
    // play() tarden dentro de libVLC (antes esto congelaba toda la app).
    await vlc.play(streamUrl, { hwnd: hwndBuf, mediaOptions });
    switchingMedia = false;
    // Tras arrancar, seleccionar la pista de subtítulos preferida si hay varias.
    if (subPrefs.enabled !== false) {
      try {
        const tracks = (await vlc.getSubtitleTracks()).filter((t) => t.id >= 0); // id -1 = "Deshabilitar"
        if (tracks.length > 1) {
          const want = String(subPrefs.lang || 'es').toLowerCase();
          const match = tracks.find((t) => String(t.name || '').toLowerCase().includes(want))
            || tracks.find((t) => /spanish|español/i.test(t.name || ''));
          if (match) await vlc.setSubtitleTrack(match.id);
        } else if (tracks.length === 1) {
          await vlc.setSubtitleTrack(tracks[0].id);
        }
      } catch (e) { log('subtítulos: no se pudo seleccionar pista:', String(e.message || e)); }
    }
    // Reanudar desde la última posición guardada (sólo si quedó a medias).
    if (histEntry && histEntry.status === 'partial' && histEntry.positionMs > 15000) {
      const posMs = histEntry.positionMs;
      setTimeout(() => {
        vlc?.setTime(posMs).then(() => log('historial: reanudado en', Math.round(posMs / 1000) + 's')).catch(() => {});
      }, 1500);
    }
    // Diagnóstico SPU (una vez por carga): ¿el slave de subtítulos enganchó?
    setTimeout(async () => {
      try {
        const raw = await vlc.getSpuCountRaw();
        const tr = await vlc.getSubtitleTracks();
        log('spu check: rawCount=' + raw + ' tracks=' + tr.length, JSON.stringify(tr), 'opts=', JSON.stringify(mediaOptions));
      } catch (e) { log('spu check error:', String(e.message || e)); }
    }, 6000);
    // lastStatus lo actualiza scheduleEngineSync() cuando el motor confirme.
    const st = notifyChange(origin, 'load');
    emitEvent('mediaChanged', { videoId: entry.id, title: entry.title, url, mode: entry.mode, state: st }, origin);
    return { ok: true, id: entry.id, mode: entry.mode, title: entry.title, duration: entry.duration, formatId: entry.formatId, client: entry.client, resolution: entry.resolution, errors: entry.errors || [] };
  } catch (e) {
    currentError = String(e.message || e);
    log('ERROR load:', currentError);
    return { ok: false, error: currentError };
  }
}

// Recarga el medio actual conservando la posición de reproducción. Se usa al
// cambiar el estilo de los subtítulos (el estilo se fija al crear el medio).
async function reloadCurrentMedia(posMs = 0) {
  if (!currentUrl) throw new Error('no hay ninguna URL cargada');
  const r = await loadUrl(currentUrl, 'style');
  if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo recargar');
  const pos = Number(posMs) || 0;
  if (pos > 1000) {
    // Se espera un poco a que el medio arranque para que el salto no se pierda.
    await new Promise((res) => setTimeout(res, 1200));
    try { await vlc.setTime(pos); log('estilo: medio recargado en', Math.round(pos / 1000) + 's'); } catch {}
  }
  return r;
}

// ---------------------------------------------------------------------------
// Eventos + dispatcher de comandos.
// La MISMA función ejecuta las órdenes tanto si llegan de la UI (IPC) como del
// coordinador externo (API HTTP): una única fuente de verdad (libVLC) y un
// único camino de eventos. Aquí NO se implementa ninguna política de audio.
// ---------------------------------------------------------------------------
function emitEvent(type, payload = {}, origin = 'system') {
  const evt = { type, playerId: PLAYER_ID, stateVersion, origin, at: new Date().toISOString(), ...payload };
  recentEvents.push(evt);
  if (recentEvents.length > 100) recentEvents.shift();
  try { api?.emit(evt); } catch {}
  return evt;
}

function notifyChange(origin = 'system', reason = '', extra = {}) {
  stateVersion++;
  const st = apiState();
  sendUpdate();
  emitEvent('stateChanged', { state: st, reason, ...extra }, origin);
  return st;
}

// Sincroniza los eventos con el estado REAL del motor: se relee libVLC y sólo
// se emite si hay una transición (evita eventos duplicados o contradictorios).
let engineSyncTimer = null;
function scheduleEngineSync() {
  if (engineSyncTimer) clearTimeout(engineSyncTimer);
  engineSyncTimer = setTimeout(async () => {
    engineSyncTimer = null;
    if (!vlc || !vlc.player) return;
    // Se relee el estado REAL del motor (no la caché): la caché se refresca en
    // el sondeo de 1 s y aquí puede estar obsoleta y perderse la transición
    // (p.ej. el "ended" que dispara el autoavance de la cola).
    try { await vlc.sync(); } catch {}
    const st = vlc.getState();
    const status = statusOf(st);
    if (status === lastStatus) return; // sin cambio real: no se duplica el evento
    const prev = lastStatus;
    lastStatus = status;
    const s = notifyChange('system', 'engine:' + status);
    if (status === 'playing') emitEvent('playbackStarted', { state: s, resumed: prev === 'paused' }, 'system');
    else if (status === 'paused') emitEvent('playbackPaused', { state: s }, 'system');
    else if (status === 'stopped') emitEvent('playbackStopped', { state: s }, 'system');
    else if (status === 'ended') {
      emitEvent('playbackEnded', { state: s }, 'system');
      // Continuidad: decide el motor (solo/continuo + fuente). Un END duplicado
      // se ignora dentro del motor (dedupe) y la cola manual tiene prioridad.
      //Sólo cuando el medio estaba reproduciendo (fin real, no un stop).
      if (prev === 'playing') {
        try {
          historyRepo.markFinished(currentId);
          const meta = {
            id: currentId, title: currentTitle, url: currentUrl,
            channel: currentChannel, channelId: currentChannelId, channelUrl: currentChannelUrl,
            category: currentCategory, uploaderId: currentUploaderId,
          };
          continuity.handleEnded({ current: meta, searchQuery: lastSearchQuery })
            .catch((e) => log('ERROR continuidad:', String(e.message || e)));
        } catch (e) { log('ERROR continuidad:', String(e.message || e)); }
      }
    }
    else if (status === 'error') emitEvent('playerError', { error: currentError || 'error del motor', state: s }, 'system');
  }, 180);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1500, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = fn(); if (r && typeof r.then === 'function') { if (await r) return true; } else if (r) return true; } catch {}
    await sleep(stepMs);
  }
  return false;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toNum = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };

// Normaliza un vídeo que llega desde la búsqueda, una lista o la cola.
// Sólo se conservan los campos con dato real (nada inventado).
function normalizeMediaItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  let id = String(it.id || it.videoId || '').trim();
  const rawUrl = String(it.url || '').trim();
  // Si llega una URL de YouTube sin id, se extrae el id canónico del enlace.
  if (!id && rawUrl) id = videoIdOf(rawUrl) || '';
  if (!id) throw new Error('vídeo sin id');
  const url = rawUrl || `https://www.youtube.com/watch?v=${id}`;
  const out = { id, url, title: it.title || null };
  if (it.channel) out.channel = it.channel;
  if (it.duration !== undefined && it.duration !== null) out.duration = Number(it.duration) || null;
  if (it.thumbnail) out.thumbnail = it.thumbnail;
  if (it.viewCount !== undefined && it.viewCount !== null) out.viewCount = Number(it.viewCount) || null;
  if (it.publishedAt) out.publishedAt = it.publishedAt;
  if (it.description) out.description = it.description;
  return out;
}

// Reproduce un vídeo (de búsqueda, lista o cola) con el MOTOR EXISTENTE:
// se resuelve con yt-dlp y se carga en libVLC a través de loadUrl().
async function playMediaItem(item, origin = 'user') {
  const norm = normalizeMediaItem(item);
  const r = await loadUrl(norm.url, origin);
  if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo cargar el vídeo');
  // El vídeo pasa a ser el elemento actual de la cola (sin resolver nada más).
  queue.ensureCurrent(norm);
  return { ...r, item: norm };
}

async function applyVolume(value, origin) {
  if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
  const target = clamp(Math.round(toNum(value, lastVolume)), 0, 100);
  const rc = await vlc.setVolume(target);
  if (rc !== 0) throw new Error('libVLC rechazo el volumen (rc=' + rc + ')');
  const real = vlc.getVolume();
  lastVolume = real;
  const st = notifyChange(origin, 'volume');
  emitEvent('volumeChanged', { volume: real, muted: vlc.getMute(), state: st }, origin);
  return { result: { volume: real, requested: target }, state: st };
}

async function applyMute(on, origin) {
  if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
  const rc = await vlc.setMute(!!on);
  if (rc !== 0) throw new Error('libVLC rechazo el mute (rc=' + rc + ')');
  const real = vlc.getMute();
  lastMute = real;
  const st = notifyChange(origin, 'mute');
  emitEvent('volumeChanged', { volume: vlc.getVolume(), muted: real, state: st }, origin);
  return { result: { muted: real }, state: st };
}

async function applySeek(seconds, origin, reason = 'seek') {
  if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
  const len = vlc.getLength();
  let t = toNum(seconds, NaN);
  if (!Number.isFinite(t) || t < 0) throw new Error('posicion invalida: ' + seconds);
  if (len > 0) t = Math.min(t, len / 1000);
  await vlc.setTime(Math.round(t * 1000));
  saveProgressNow(); // el salto cambia la posición guardada: se persiste ya
  // Se espera a que el motor confirme la nueva posición (con refresco asíncrono).
  const ok = await waitFor(async () => { await vlc.sync(); return Math.abs(vlc.getTime() / 1000 - t) < 2.5; }, 4000, 150);
  const st = notifyChange(origin, reason);
  emitEvent('positionChanged', { position: vlc.getTime() / 1000, duration: len / 1000, state: st }, origin);
  if (!ok) throw new Error('el motor no confirmo la posicion ' + t + 's (pos actual ' + (vlc.getTime() / 1000).toFixed(1) + 's)');
  return { result: { position: vlc.getTime() / 1000, requested: t }, state: st };
}

// Órdenes que cambian el medio. Se ejecutan EN SERIE (una detrás de otra):
// si dos "load"/"next" llegan a la vez, libVLC recibiría dos cambios de medio
// cruzados y el motor se queda inconsistente (vídeo en negro o estado
// incoherente). El resto de órdenes (volumen, pausa, seek) pueden coexistir.
const MEDIA_COMMANDS = new Set(['load', 'reload', 'next', 'previous', 'playList', 'playQueueIndex', 'stop', 'playHistory']);
let mediaChain = Promise.resolve();
function serializeMedia(fn) {
  const next = mediaChain.then(fn, fn);
  // La cadena nunca se rompe: un fallo en una orden no bloquea las siguientes.
  mediaChain = next.then(() => {}, () => {});
  return next;
}

async function executeCommand(command, args = {}, origin = 'api') {
  if (MEDIA_COMMANDS.has(command)) {
    return serializeMedia(() => executeCommandInner(command, args, origin));
  }
  return executeCommandInner(command, args, origin);
}

async function executeCommandInner(command, args = {}, origin = 'api') {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const curVolume = () => (vlc && vlc.player ? vlc.getVolume() : lastVolume);
  const curTime = () => (vlc && vlc.player ? vlc.getTime() / 1000 : 0);
  // Espera a una condición del motor refrescando la caché de forma asíncrona.
  const waitState = (pred, ms) => waitFor(async () => { await vlc.sync(); return pred(); }, ms);

  switch (command) {
    case 'play': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      intentionalStop = false;   // el usuario vuelve a reproducir: la vigilancia vuelve a estar activa
      intentionalPause = false;
      const st0 = vlc.getState();
      if (st0 === 4) {
        // Reanudar: set_pause(0) es idempotente y no reinicia el medio.
        await vlc.setPaused(false);
        const ok = await waitState(() => vlc.getState() === 3, 2500);
        if (!ok) throw new Error('el motor no confirmo la reanudacion');
      } else {
        // Reanudar un medio parado: la llamada es asíncrona para no bloquear.
        const rc = await vlc.resume();
        if (rc !== 0) throw new Error('libVLC rechazo la reproduccion (rc=' + rc + ')');
        await waitState(() => vlc.getState() === 3, 2500);
      }
      // Los eventos playback* los emite scheduleEngineSync() a partir del estado
      // REAL del motor: aqui solo se confirma la orden y se notifica el cambio.
      const st = notifyChange(origin, 'play');
      return { result: { playing: true }, state: st };
    }
    case 'pause': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      intentionalPause = true;   // pausa pedida por el usuario: no recuperar
      await vlc.setPaused(true);
      const ok = await waitState(() => vlc.getState() === 4, 2000);
      if (!ok) throw new Error('el motor no confirmo la pausa');
      saveProgressNow();
      const st = notifyChange(origin, 'pause');
      return { result: { paused: true }, state: st };
    }
    case 'stop': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      intentionalStop = true;   // el usuario paró: la vigilancia no debe recargar
      saveProgressNow();
      await vlc.stop();
      const ok = await waitState(() => vlc.getState() === 5 || vlc.getTime() === 0, 2500);
      if (!ok) throw new Error('el motor no confirmo el stop');
      const st = notifyChange(origin, 'stop');
      return { result: { stopped: true }, state: st };
    }
    case 'togglePlay': {
      return executeCommand(vlc && vlc.player && vlc.isPlaying() ? 'pause' : 'play', {}, origin);
    }
    case 'setVolume': return applyVolume(a.value ?? a.volume ?? a.level, origin);
    case 'getVolume': {
      const st = apiState();
      return { result: { volume: curVolume(), muted: st.muted }, state: st };
    }
    case 'volumeUp': {
      const step = clamp(toNum(a.delta ?? a.step ?? a.value, 5), 1, 100);
      return applyVolume(curVolume() + step, origin);
    }
    case 'volumeDown': {
      const step = clamp(toNum(a.delta ?? a.step ?? a.value, 5), 1, 100);
      return applyVolume(curVolume() - step, origin);
    }
    case 'mute': return applyMute(true, origin);
    case 'unmute': return applyMute(false, origin);
    case 'seek': return applySeek(a.seconds ?? a.position ?? a.time, origin, 'seek');
    case 'forward': {
      const step = clamp(toNum(a.seconds ?? a.delta ?? a.step, 10), 0, 3600);
      return applySeek(curTime() + step, origin, 'forward');
    }
    case 'rewind': {
      const step = clamp(toNum(a.seconds ?? a.delta ?? a.step, 10), 0, 3600);
      return applySeek(Math.max(0, curTime() - step), origin, 'rewind');
    }
    case 'getState': {
      const st = apiState();
      return { result: st, state: st };
    }
    case 'fullscreen': {
      if (!winVideo || winVideo.isDestroyed()) throw new Error('la ventana de video esta cerrada');
      const on = a.on === undefined ? !fullscreenNow() : !!a.on;
      winVideo.setFullScreen(on);
      await waitFor(() => fullscreenNow() === on, 1500);
      const st = notifyChange(origin, 'fullscreen');
      return { result: { fullscreen: fullscreenNow() }, state: st };
    }
    case 'load': {
      const url = String(a.url || '').trim();
      if (!/^https?:\/\/(www\.)?(youtube\.com\/watch\?|youtu\.be\/)/i.test(url)) throw new Error('URL de YouTube no valida: ' + url);
      const r = await loadUrl(url, origin);
      if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo cargar la URL');
      return { result: r, state: apiState() };
    }
    case 'reload': {
      if (!currentUrl) throw new Error('no hay ninguna URL cargada');
      const r = await loadUrl(currentUrl, origin);
      if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo recargar');
      return { result: r, state: apiState() };
    }
    // --- Lista de reproducción -------------------------------------------------
    case 'playlist': {
      return { result: { items: PLAYLIST, index: currentPlaylistIndex }, state: apiState() };
    }
    case 'playIndex': {
      const i = clamp(Math.trunc(toNum(a.index, 0)), 0, PLAYLIST.length - 1);
      currentPlaylistIndex = i;
      const item = PLAYLIST[i];
      const r = await loadUrl(item.url, origin);
      if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo cargar el elemento de la lista');
      return { result: { ...r, index: i, item }, state: apiState() };
    }
    // --- Búsqueda (proveedor de búsqueda) --------------------------------------
    case 'search': {
      const q = String(a.query || a.q || '').trim();
      const limit = clamp(Math.trunc(toNum(a.limit, 20)), 1, 50);
      const offset = Math.max(0, Math.trunc(toNum(a.offset, 0)));
      const filters = (a.filters && typeof a.filters === 'object') ? a.filters : null;
      const provider = searchRegistry.get(a.provider);
      const res = await provider.search(q, { limit, offset, cancelPrevious: a.cancelPrevious !== false, filters });
      // La búsqueda activa alimenta la continuidad ("Mi búsqueda") y el
      // historial de búsquedas (local, sin red adicional).
      if (q) {
        lastSearchQuery = q;
        lastSearchFilters = filters;
        try { historyRepo.recordSearch({ query: q, filters: filters || {}, mode: store.prefs().contentMode || 'temas' }); } catch {}
      }
      return { result: { ok: true, query: q, provider: provider.id, ...res }, state: apiState() };
    }
    case 'searchDetails': {
      const provider = searchRegistry.get(a.provider);
      const item = await provider.details(String(a.id || a.url || ''));
      return { result: item, state: apiState() };
    }
    case 'searchProviders': {
      return { result: { providers: searchRegistry.list() }, state: apiState() };
    }
    // --- Cola de reproducción --------------------------------------------------
    case 'getQueue': {
      return { result: queue.snapshot(), state: apiState() };
    }
    case 'addToQueue': {
      const item = normalizeMediaItem(a.item || a);
      const position = a.position === 'next' ? 'next' : 'end';
      const r = queue.add(item, position);
      return { result: { ...r, queue: queue.snapshot() }, state: apiState() };
    }
    case 'removeFromQueue': {
      const r = queue.remove(a.index);
      return { result: { ...r, queue: queue.snapshot() }, state: apiState() };
    }
    case 'moveInQueue': {
      const r = queue.move(a.from ?? a.source, a.to ?? a.target);
      return { result: { ...r, queue: queue.snapshot() }, state: apiState() };
    }
    case 'clearQueue': {
      const r = queue.clear();
      return { result: { ...r, queue: queue.snapshot() }, state: apiState() };
    }
    case 'setAutoAdvance': {
      const on = a.on === undefined ? !queue.autoAdvance : !!a.on;
      queue.setAutoAdvance(on);
      return { result: { autoAdvance: on, queue: queue.snapshot() }, state: apiState() };
    }
    case 'playQueueIndex': {
      const i = Math.trunc(toNum(a.index, -1));
      const item = queue.items[i];
      if (!item) throw new Error('no hay ningún elemento en esa posición de la cola');
      const r = await playMediaItem(item, origin);
      return { result: { ...r, index: i, item }, state: apiState() };
    }
    case 'next': {
      // Si el vídeo actual está en la cola, se avanza dentro de la cola;
      // si la cola no tiene siguiente (o el vídeo no está en ella), se mantiene
      // el comportamiento de la lista de reproducción hardcodeada.
      if (queue.items.length && queue.currentIndex >= 0) {
        const item = queue.nextItem();
        if (item) {
          const r = await playMediaItem(item, origin);
          return { result: { ...r, item, source: 'queue' }, state: apiState() };
        }
      }
      currentPlaylistIndex = (currentPlaylistIndex + 1) % PLAYLIST.length;
      const item = PLAYLIST[currentPlaylistIndex];
      const r = await loadUrl(item.url, origin);
      if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo cargar el siguiente');
      return { result: { ...r, index: currentPlaylistIndex, item, source: 'playlist' }, state: apiState() };
    }
    case 'previous': {
      if (queue.items.length && queue.currentIndex >= 0) {
        const item = queue.previousItem();
        if (item) {
          const r = await playMediaItem(item, origin);
          return { result: { ...r, item, source: 'queue' }, state: apiState() };
        }
      }
      currentPlaylistIndex = (currentPlaylistIndex - 1 + PLAYLIST.length) % PLAYLIST.length;
      const item = PLAYLIST[currentPlaylistIndex];
      const r = await loadUrl(item.url, origin);
      if (!r || !r.ok) throw new Error((r && r.error) || 'no se pudo cargar el anterior');
      return { result: { ...r, index: currentPlaylistIndex, item, source: 'playlist' }, state: apiState() };
    }
    // --- Listas personales -----------------------------------------------------
    case 'getLists': {
      return { result: { lists: store.lists() }, state: apiState() };
    }
    case 'createList': {
      const l = store.createList(a.name);
      return { result: { list: { id: l.id, name: l.name, count: 0 }, lists: store.lists() }, state: apiState() };
    }
    case 'renameList': {
      const l = store.renameList(a.id || a.listId, a.name);
      return { result: { list: { id: l.id, name: l.name }, lists: store.lists() }, state: apiState() };
    }
    case 'deleteList': {
      store.deleteList(a.id || a.listId);
      return { result: { deleted: true, lists: store.lists() }, state: apiState() };
    }
    case 'addToList': {
      const item = normalizeMediaItem(a.item || a);
      const l = store.addToList(a.listId || a.id, item);
      return { result: { list: { id: l.id, name: l.name, count: l.items.length }, lists: store.lists() }, state: apiState() };
    }
    case 'removeFromList': {
      const l = store.removeFromList(a.listId || a.id, a.itemId || a.videoId);
      return { result: { list: { id: l.id, name: l.name, count: l.items.length }, lists: store.lists() }, state: apiState() };
    }
    case 'moveInList': {
      const l = store.moveInList(a.listId || a.id, a.from, a.to);
      return { result: { list: { id: l.id, name: l.name, count: l.items.length } }, state: apiState() };
    }
    case 'getList': {
      const l = store.list(a.listId || a.id);
      if (!l) throw new Error('no existe esa lista');
      return { result: { list: { id: l.id, name: l.name, special: !!l.special, items: l.items || [] } }, state: apiState() };
    }
    case 'playList': {
      const l = store.list(a.listId || a.id);
      if (!l) throw new Error('no existe esa lista');
      const items = l.items || [];
      if (!items.length) throw new Error('la lista está vacía');
      // La lista pasa a ser la cola: se reproduce el primero y el resto queda en cola.
      queue.clear();
      for (const it of items) queue.add(it, 'end');
      const r = await playMediaItem(queue.items[0], origin);
      return { result: { ...r, list: l.id, queued: items.length }, state: apiState() };
    }
    case 'addListToQueue': {
      const l = store.list(a.listId || a.id);
      if (!l) throw new Error('no existe esa lista');
      const items = l.items || [];
      for (const it of items) queue.add(it, 'end');
      return { result: { added: items.length, queue: queue.snapshot() }, state: apiState() };
    }
    case 'getHistory': {
      const q = a.q !== undefined ? String(a.q) : '';
      if (q || a.tab || a.sort || a.offset !== undefined || a.period || a.source || a.channel) {
        return { result: { ...historyRepo.query({
          q, tab: a.tab, sort: a.sort, offset: toNum(a.offset, 0),
          limit: clamp(Math.trunc(toNum(a.limit, 30)), 1, 200),
          period: a.period, source: a.source, channel: a.channel,
        }) }, state: apiState() };
      }
      return { result: { history: store.history(clamp(Math.trunc(toNum(a.limit, 50)), 1, 200)) }, state: apiState() };
    }
    // --- Preferencias y modos del sprint ---------------------------------------
    case 'getPrefs': {
      return { result: { prefs: store.prefs(), continuity: continuity.snapshot() }, state: apiState() };
    }
    case 'setContentMode': {
      const mode = String(a.mode || '');
      const p = store.setPrefs({ contentMode: mode, ...(a.mix ? { mix: a.mix } : {}) });
      continuity.setContentMode(p.contentMode, p.mix);
      log('modo de contenido:', p.contentMode, JSON.stringify(p.mix));
      const st = notifyChange('api', 'contentMode');
      return { result: { prefs: p, continuity: continuity.snapshot() }, state: st };
    }
    case 'setContinuity': {
      const p = store.setPrefs({ continuity: {
        mode: a.mode !== undefined ? a.mode : store.prefs().continuity.mode,
        source: a.source !== undefined ? a.source : store.prefs().continuity.source,
      } });
      continuity.setMode(p.continuity.mode);
      continuity.setSource(p.continuity.source);
      log('continuidad:', JSON.stringify(p.continuity));
      const st = notifyChange('api', 'continuity');
      return { result: { prefs: p, continuity: continuity.snapshot() }, state: st };
    }
    case 'getContinuity': {
      return { result: { continuity: continuity.snapshot(), prefs: store.prefs().continuity }, state: apiState() };
    }
    case 'setSubtitlePrefs': {
      const p = store.setPrefs({ subtitles: {
        enabled: a.enabled !== undefined ? !!a.enabled : store.prefs().subtitles.enabled,
        lang: a.lang !== undefined ? String(a.lang) : store.prefs().subtitles.lang,
        style: a.style !== undefined ? normalizeSubtitleStyle(a.style) : store.prefs().subtitles.style,
      } });
      // Aplica en caliente sobre el medio actual (sin recrear el reproductor).
      if (vlc && vlc.player) {
        if (a.enabled === false) { vlc.setSubtitleTrack(-1).catch(() => {}); }
        else {
          vlc.getSubtitleTracks().then(async (tracks) => {
            const real = (tracks || []).filter((t) => t.id >= 0); // id -1 = "Deshabilitar"
            if (!real.length) return;
            const want = String(p.subtitles.lang || 'es').toLowerCase();
            const match = real.find((t) => String(t.name || '').toLowerCase().includes(want))
              || real.find((t) => /spanish|español/i.test(t.name || ''))
              || real[0];
            if (match) await vlc.setSubtitleTrack(match.id);
          }).catch(() => {});
        }
      }
      log('prefs subtítulos:', JSON.stringify(p.subtitles));
      const st = notifyChange('api', 'subtitles');
      return { result: { prefs: p }, state: st };
    }
    case 'getSubtitlePrefs': {
      return { result: { subtitles: store.prefs().subtitles }, state: apiState() };
    }
    // Estilo de los subtítulos (tamaño, color, fondo, contorno). El estilo se
    // fija al crear el medio, así que para que se vea al instante se recarga
    // el medio actual conservando la posición de reproducción.
    case 'setSubtitleStyle': {
      const style = normalizeSubtitleStyle(a.style || a);
      const prev = store.prefs().subtitles || {};
      const p = store.setPrefs({ subtitles: { ...prev, style } });
      log('estilo de subtítulos:', JSON.stringify(style));
      let reloaded = false;
      try {
        if (vlc && vlc.player && currentUrl) {
          const pos = Math.max(0, toNum(vlc.getTime && vlc.getTime(), 0));
          await reloadCurrentMedia(pos);
          reloaded = true;
        }
      } catch (e) { log('estilo de subtítulos: no se pudo recargar el medio:', String(e.message || e)); }
      const st = notifyChange('api', 'subtitles');
      emitEvent('subtitleStyleChanged', { style, reloaded, state: st }, 'api');
      return { result: { style: p.subtitles.style, reloaded }, state: st };
    }
    case 'getSubtitleTracks': {
      const tracks = vlc && vlc.player ? await vlc.getSubtitleTracks() : [];
      const rawCount = vlc && vlc.player ? await vlc.getSpuCountRaw() : -1;
      return { result: { tracks, selected: vlc && vlc.player ? (vlc._last.spu ?? -1) : -1, rawCount }, state: apiState() };
    }
    case 'setSubtitleTrack': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      const id = a.id === undefined ? -1 : Math.trunc(toNum(a.id, -1));
      const rc = await vlc.setSubtitleTrack(id);
      if (rc !== 0 && rc !== undefined) log('set_spu rc=', rc);
      const st = notifyChange('api', 'subtitleTrack');
      emitEvent('subtitleChanged', { track: id, state: st }, 'api');
      return { result: { track: id, rc }, state: st };
    }
    // --- Historial (repositorio enriquecido) ------------------------------------
    case 'queryHistory': {
      return { result: historyRepo.query({
        q: a.q ? String(a.q) : '', tab: a.tab, sort: a.sort,
        offset: toNum(a.offset, 0), limit: clamp(Math.trunc(toNum(a.limit, 30)), 1, 200),
        period: a.period, source: a.source, channel: a.channel,
      }), state: apiState() };
    }
    case 'removeFromHistory': {
      const r = historyRepo.remove(String(a.id || a.sourceId || ''));
      return { result: r, state: apiState() };
    }
    case 'clearHistory': {
      const r = historyRepo.clear(a.period || 'all');
      return { result: r, state: apiState() };
    }
    case 'exportHistory': {
      return { result: { json: historyRepo.exportJSON() }, state: apiState() };
    }
    case 'getSearchHistory': {
      return { result: { searches: historyRepo.listSearches(toNum(a.limit, 20)) }, state: apiState() };
    }
    case 'removeSearch': {
      return { result: historyRepo.removeSearch(String(a.query || '')), state: apiState() };
    }
    case 'playHistory': {
      const e = historyRepo.get(String(a.id || ''));
      if (!e) throw new Error('no hay entrada de historial con ese id');
      const item = { id: e.sourceId, url: e.url, title: e.title, channel: e.creator, duration: e.duration, thumbnail: e.thumbnail, provider: e.provider };
      const r = await playMediaItem(item, origin);
      return { result: { ...r, history: e }, state: apiState() };
    }
    case 'classify': {
      const items = Array.isArray(a.items) ? a.items : [];
      return { result: { classes: items.map((it) => ({ id: it && it.id, cls: classifyItem(it) })) }, state: apiState() };
    }
    case 'setFilters': {
      const p = store.setPrefs({ filters: (a.filters && typeof a.filters === 'object') ? a.filters : {} });
      return { result: { filters: p.filters }, state: apiState() };
    }
    case 'getFilters': {
      return { result: { filters: store.prefs().filters || {} }, state: apiState() };
    }
    default:
      throw new Error('comando no soportado: ' + command);
  }
}

function setupIpc() {
  ipcMain.handle('cmp:load', (_e, url) => loadUrl(url, 'user'));
  // Recarga: vuelve a resolver la URL (las URLs de YouTube caducan ~6 h o(expiran por IP/bot).
  ipcMain.handle('cmp:reload', async () => {
    if (!currentUrl) return { ok: false, error: 'no hay ninguna URL cargada' };
    log('reload:', currentUrl);
    return loadUrl(currentUrl, 'user');
  });
  // Los cambios hechos en la UI pasan por el MISMO dispatcher que usa el API
  // externo, con origin 'user': el coordinador recibe también los cambios
  // manuales del usuario (no sólo los aplicados por API).
  const run = async (cmd, args = {}) => {
    try { await executeCommand(cmd, args, 'user'); }
    catch (e) { currentError = String(e.message || e); log('ERROR ui', cmd, currentError); }
    sendUpdate();
    return getState();
  };
  ipcMain.handle('cmp:play', () => run('play'));
  ipcMain.handle('cmp:pause', () => run('pause'));
  ipcMain.handle('cmp:stop', () => run('stop'));
  ipcMain.handle('cmp:seek', (_e, seconds) => run('seek', { seconds }));
  ipcMain.handle('cmp:volume', (_e, v) => run('setVolume', { value: v }));
  ipcMain.handle('cmp:mute', () => run(vlc?.getMute?.() ? 'unmute' : 'mute'));
  ipcMain.handle('cmp:toggle', () => run('togglePlay'));
  // Lista de reproducción hardcodeada (con scroll en la barra flotante).
  ipcMain.handle('cmp:playlist', () => ({ items: PLAYLIST, index: currentPlaylistIndex }));
  ipcMain.handle('cmp:next', () => run('next'));
  ipcMain.handle('cmp:previous', () => run('previous'));
  ipcMain.handle('cmp:playIndex', (_e, index) => run('playIndex', { index }));
  // --- Buscador (proveedor de búsqueda) ---------------------------------------
  ipcMain.handle('cmp:search', async (_e, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    try {
      const provider = searchRegistry.get(o.provider);
      const filters = (o.filters && typeof o.filters === 'object') ? o.filters : null;
      const res = await provider.search(String(o.query || ''), {
        limit: clamp(Math.trunc(toNum(o.limit, 20)), 1, 50),
        offset: Math.max(0, Math.trunc(toNum(o.offset, 0))),
        // La paginación no cancela la búsqueda en curso.
        cancelPrevious: o.cancelPrevious !== false,
        filters,
      });
      const q = String(o.query || '').trim();
      if (q && o.record !== false) {
        lastSearchQuery = q;
        lastSearchFilters = filters;
        try { historyRepo.recordSearch({ query: q, filters: filters || {}, mode: store.prefs().contentMode || 'temas' }); } catch {}
      }
      return { ok: true, ...res, provider: provider.id };
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('ERROR search:', msg);
      return { ok: false, error: msg, items: [], hasMore: false };
    }
  });
  ipcMain.handle('cmp:search-details', async (_e, ref) => {
    try {
      const provider = searchRegistry.default();
      const item = await provider.details(String(ref || ''));
      return { ok: !!item, item };
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('ERROR search-details:', msg);
      return { ok: false, error: msg, item: null };
    }
  });
  ipcMain.handle('cmp:search-providers', () => ({ providers: searchRegistry.list() }));
  // --- Cola y listas ----------------------------------------------------------
  // Los manejadores devuelven el RESULTADO (sin el sobre), igual que cmp.queue().
  ipcMain.handle('cmp:queue', () => queue.snapshot());
  ipcMain.handle('cmp:queue-add', (_e, item, position) => run('addToQueue', { item, position }).then((r) => r.result));
  ipcMain.handle('cmp:queue-remove', (_e, index) => run('removeFromQueue', { index }).then((r) => r.result));
  ipcMain.handle('cmp:queue-move', (_e, from, to) => run('moveInQueue', { from, to }).then((r) => r.result));
  ipcMain.handle('cmp:queue-clear', () => run('clearQueue').then((r) => r.result));
  ipcMain.handle('cmp:queue-auto', (_e, on) => run('setAutoAdvance', { on }).then((r) => r.result));
  ipcMain.handle('cmp:queue-play', (_e, index) => run('playQueueIndex', { index }).then((r) => r.result));
  ipcMain.handle('cmp:lists', () => ({ lists: store.lists() }));
  ipcMain.handle('cmp:list', (_e, id) => {
    const l = store.list(id);
    return l ? { id: l.id, name: l.name, special: !!l.special, items: l.items || [] } : null;
  });
  ipcMain.handle('cmp:list-create', (_e, name) => run('createList', { name }).then((r) => r.result));
  ipcMain.handle('cmp:list-rename', (_e, id, name) => run('renameList', { id, name }).then((r) => r.result));
  ipcMain.handle('cmp:list-delete', (_e, id) => run('deleteList', { id }).then((r) => r.result));
  ipcMain.handle('cmp:list-add', (_e, listId, item) => run('addToList', { listId, item }).then((r) => r.result));
  ipcMain.handle('cmp:list-remove', (_e, listId, itemId) => run('removeFromList', { listId, itemId }).then((r) => r.result));
  ipcMain.handle('cmp:list-move', (_e, listId, from, to) => run('moveInList', { listId, from, to }).then((r) => r.result));
  ipcMain.handle('cmp:list-play', (_e, listId) => run('playList', { listId }).then((r) => r.result));
  ipcMain.handle('cmp:list-to-queue', (_e, listId) => run('addListToQueue', { listId }).then((r) => r.result));
  ipcMain.handle('cmp:history', () => ({ history: store.history(100) }));
  // --- Sprint: preferencias, continuidad, subtítulos, historial -----------------
  // Toda la UI pasa por el mismo dispatcher (executeCommand) que el API externa.
  const runRes = async (cmd, args = {}) => {
    try { const r = await executeCommand(cmd, args, 'user'); return { ok: true, ...r.result }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };
  ipcMain.handle('cmp:prefs', () => ({ prefs: store.prefs(), continuity: continuity.snapshot() }));
  ipcMain.handle('cmp:set-content-mode', (_e, payload) => runRes('setContentMode', payload || {}));
  ipcMain.handle('cmp:set-continuity', (_e, payload) => runRes('setContinuity', payload || {}));
  ipcMain.handle('cmp:get-continuity', () => ({ continuity: continuity.snapshot(), prefs: store.prefs().continuity }));
  ipcMain.handle('cmp:set-subtitle-prefs', (_e, payload) => runRes('setSubtitlePrefs', payload || {}));
  ipcMain.handle('cmp:get-subtitle-prefs', () => ({ subtitles: store.prefs().subtitles }));
  ipcMain.handle('cmp:set-subtitle-style', (_e, style) => runRes('setSubtitleStyle', { style: style || {} }));
  ipcMain.handle('cmp:subtitle-tracks', async () => {
    const tracks = vlc && vlc.player ? await vlc.getSubtitleTracks().catch(() => []) : [];
    return { tracks, selected: vlc && vlc.player ? (vlc._last.spu ?? -1) : -1 };
  });
  ipcMain.handle('cmp:set-subtitle-track', (_e, id) => runRes('setSubtitleTrack', { id }));
  ipcMain.handle('cmp:history-query', (_e, opts) => {
    try { return { ok: true, ...historyRepo.query(opts || {}) }; }
    catch (e) { return { ok: false, error: String(e.message || e), items: [], total: 0 }; }
  });
  ipcMain.handle('cmp:history-remove', (_e, id) => runRes('removeFromHistory', { id }));
  ipcMain.handle('cmp:history-clear', (_e, period) => runRes('clearHistory', { period: period || 'all' }));
  ipcMain.handle('cmp:history-export', () => ({ ok: true, json: historyRepo.exportJSON() }));
  ipcMain.handle('cmp:search-history', (_e, limit) => ({ searches: historyRepo.listSearches(limit || 20) }));
  ipcMain.handle('cmp:search-history-remove', (_e, query) => runRes('removeSearch', { query }));
  ipcMain.handle('cmp:play-history', (_e, id) => runRes('playHistory', { id }));
  ipcMain.handle('cmp:classify', (_e, items) => {
    const list = Array.isArray(items) ? items : [];
    return { classes: list.map((it) => ({ id: it && it.id, cls: classifyItem(it) })) };
  });
  ipcMain.handle('cmp:set-filters', (_e, filters) => runRes('setFilters', { filters }));
  ipcMain.handle('cmp:get-filters', () => ({ filters: store.prefs().filters || {} }));
  // Reproducir un resultado de búsqueda: motor existente + cola + historial.
  ipcMain.handle('cmp:play-media', async (_e, item) => {
    try {
      const r = await playMediaItem(item, 'user');
      return { ok: true, ...r };
    } catch (e) {
      const msg = String((e && e.message) || e);
      currentError = msg;
      log('ERROR play-media:', msg);
      return { ok: false, error: msg };
    }
  });
  // Copiar un enlace al portapapeles del sistema.
  ipcMain.handle('cmp:copy', (_e, text) => {
    try {
      clipboard.writeText(String(text || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // La barra flotante pide que se mantenga visible mientras el ratón se mueve.
  ipcMain.on('cmp:overlay-hover', () => { overlayLastMove = Date.now(); showOverlay(); });
  ipcMain.handle('cmp:state', () => getState());
  ipcMain.handle('cmp:fullscreen', async () => {
    if (!winVideo || winVideo.isDestroyed()) return { ok: false };
    try { await executeCommand('fullscreen', {}, 'user'); } catch (e) { currentError = String(e.message || e); }
    return { ok: true, fullscreen: fullscreenNow() };
  });
  // Diagnóstico de herramientas: comprueba en vivo yt-dlp, FFmpeg, Deno y libVLC.
  ipcMain.handle('cmp:diagnostics', async () => {
    const t = await toolVersions();
    const diag = {
      ytdlp: t.ytdlp, ffmpeg: t.ffmpeg, deno: t.deno,
      libvlc: vlc?.version?.() || 'no inicializado',
      vlcPath: VLC_DIR,
      electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      proxyPort: proxy?.port, mode: currentMode,
    };
    log('diagnóstico:', JSON.stringify(diag));
    return diag;
  });
}

async function autoTest() {
  // En modo auto-test: cargar video, reproducir N segundos, registrar estado real y salir.
  const url = AUTO_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const t0 = Date.now();
  log('AUTO-TEST inicio', url, AUTO_SECS + 's');
  const r = await ipcMain.emit ? null : null;
  // llamamos la misma lógica que cmp:load
  const entry = await resolveYouTube(url);
  currentTitle = entry.title; currentMode = entry.mode; currentId = entry.id;
  proxy.register(entry);
  const streamUrl = proxy.streamUrl(entry.id);
  log(`AUTO-TEST resuelto modo=${entry.mode} client=${entry.client} format=${entry.formatId} res=${entry.resolution} titulo="${entry.title}"`);
  if (entry.errors?.length) log('AUTO-TEST avisos del resolver:', entry.errors.join(' || '));
  if (winVideo && !winVideo.isDestroyed()) {
    const hwndBuf = winVideo.getNativeWindowHandle();
    log('AUTO-TEST hwnd:', hwndBuf.toString('hex'));
    vlc.play(streamUrl, { hwnd: hwndBuf, mediaOptions: [':network-caching=1200'] });
  } else {
    vlc.play(streamUrl, { mediaOptions: [':network-caching=1200'] }); // sin hwnd (dummy vout no; vout default)
  }
  let maxTime = 0; let playingSeen = false; let seekOk = false; let volOk = false;
  const iv = setInterval(() => {
    const s = getState();
    if (s.isPlaying) playingSeen = true;
    if (s.time > maxTime) maxTime = s.time;
    log(`AUTO-TEST t+${((Date.now() - t0) / 1000).toFixed(0)}s state=${s.stateName} time=${(s.time / 1000).toFixed(1)}s len=${(s.length / 1000).toFixed(1)}s vol=${s.volume}`);
  }, 2000);
  // a mitad, probar seek y volumen
  await new Promise(r => setTimeout(r, Math.max(5000, AUTO_SECS * 500)));
  try { await vlc.setTime(120000); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  const sSeek = getState();
  seekOk = Math.abs(sSeek.time - 120000) < 8000 && sSeek.time > 0;
  log(`AUTO-TEST seek a 120s -> time=${(sSeek.time / 1000).toFixed(1)}s seekOk=${seekOk}`);
  const rcVol = vlc.api.libvlc_audio_set_volume(vlc.player, 55);
  await new Promise(r => setTimeout(r, 500));
  const vol = vlc.getVolume();
  volOk = rcVol === 0 && (vol === 55 || vol === 0);
  log(`AUTO-TEST volumen 55 -> rc=${rcVol} get=${vol} volOk=${volOk}`);
  await new Promise(r => setTimeout(r, Math.max(3000, (AUTO_SECS - Math.max(5, AUTO_SECS / 2) - 4) * 1000)));
  clearInterval(iv);
  const bytes = proxy.get(currentId)?.bytes || 0;
  const pass = playingSeen && maxTime > 5000 && seekOk;
  log(`AUTO-TEST FIN: playing=${playingSeen} maxTime=${(maxTime / 1000).toFixed(1)}s seekOk=${seekOk} volOk=${volOk} bytesProxy=${bytes} -> ${pass ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(path.join(LOG_DIR, 'auto-test-result.json'), JSON.stringify({ pass, playingSeen, maxTime, seekOk, volOk, bytes, title: currentTitle, mode: currentMode }, null, 2));
  if (process.env.CMP_HOLD === '1') {
    // Modo evidencia: no se cierra la app (queda reproduciendo para captura de pantalla).
    log('AUTO-TEST HOLD: la app sigue abierta (CMP_HOLD=1)');
    return;
  }
  // Salida limpia: detener libVLC antes de cerrar Electron (si no, el teardown
  // del player pegado al HWND provoca 0xC0000005 al salir).
  try { vlc?.stop(); } catch {}
  try { vlc?.dispose({ safe: true }); } catch {}
  await new Promise(r => setTimeout(r, 1200));
  app.exit(pass ? 0 : 3);
}

// ---------------------------------------------------------------------------
// Prueba de UI real: acciona los botones de la BARRA FLOTANTE (play/pausa/stop,
// barra de progreso y de volumen) vía executeJavaScript y comprueba el efecto
// real en libVLC. Verifica el camino completo: DOM -> preload -> IPC -> libVLC.
// ---------------------------------------------------------------------------
async function uiTest() {
  const result = { pass: false, loaded: false, paused: false, resumed: false, seekOk: false, volOk: false, stopOk: false, diagOk: false, reloadOk: false, fullscreenOk: false, listOk: false, modalOk: false, errors: [] };
  const js = (code) => winOverlay.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const state = () => getState();
  try {
    log('UI-TEST: esperando carga de la barra flotante');
    for (let i = 0; i < 40; i++) { await sleep(250); if (await js("!!document.getElementById('play')")) break; }
    log('UI-TEST: cargando el primer elemento de la lista con el botón play');
    await js("document.getElementById('play').click(); true");
    let playing = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const s = state();
      if (s.isPlaying && s.time > 0) { playing = true; break; }
      if (s.error) { result.errors.push(s.error); break; }
    }
    result.loaded = playing;
    log('UI-TEST: reproducción tras play (lista) =', playing, 'estado=', state().stateName, 't=', state().time);
    if (!playing) throw new Error('la UI no consiguió reproducir');

    // Pausa (botón real)
    const t0 = state().time;
    await js("document.getElementById('play').click(); true");
    await sleep(2500);
    const sp = state();
    const t1 = sp.time;
    result.paused = sp.stateName === 'Paused' && Math.abs(t1 - t0) < 1200;
    log(`UI-TEST: Pausa -> estado=${sp.stateName} t0=${t0} t1=${t1} pausedOk=${result.paused}`);

    // Play (botón real)
    await js("document.getElementById('play').click(); true");
    await sleep(3500);
    const sr = state();
    result.resumed = sr.isPlaying && sr.time > t1;
    log(`UI-TEST: Play -> estado=${sr.stateName} t=${sr.time} resumedOk=${result.resumed}`);

    // Seek al 50% (barra real: pointerdown + pointerup)
    const len = state().length;
    if (len > 10000) {
      await js(`(() => { const tr=document.getElementById('track'); const r=document.getElementById('rail').getBoundingClientRect();
        const x=r.left+r.width*0.5, y=r.top+r.height/2;
        const ev=(t)=>new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:1});
        tr.dispatchEvent(ev('pointerdown')); tr.dispatchEvent(ev('pointerup')); return true; })()`);
      await sleep(5000);
      const ss = state();
      result.seekOk = Math.abs(ss.time - len / 2) < 15000;
      log(`UI-TEST: Seek 50% (${(len / 2 / 1000).toFixed(0)}s) -> t=${(ss.time / 1000).toFixed(1)}s seekOk=${result.seekOk}`);
    } else {
      result.errors.push('longitud no disponible para seek');
    }

    // Volumen (barra real: evento input)
    await js(`(() => { const v=document.getElementById('vol'); v.value=40; v.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1500);
    const sv = state();
    result.volOk = sv.volume === 40;
    log(`UI-TEST: Volumen 40 -> get=${sv.volume} volOk=${result.volOk}`);

    // Stop (botón real)
    await js("document.getElementById('stop').click(); true");
    await sleep(2000);
    const sst = state();
    result.stopOk = sst.stateName === 'Stopped' || sst.stateName === 'Idle' || sst.time === 0;
    log(`UI-TEST: Stop -> estado=${sst.stateName} stopOk=${result.stopOk}`);

    // Lista lateral: se abre, tiene elementos y hace scroll
    const plInfo = await js(`(() => { document.getElementById('plToggle').click();
      const l=document.getElementById('plList');
      return {open:document.body.classList.contains('showPlaylist'), items:l.querySelectorAll('.plItem').length,
              scrollable:l.scrollHeight>l.clientHeight, overflow:getComputedStyle(l).overflowY}; })()`);
    result.listOk = !!plInfo && plInfo.open && plInfo.items > 0 && plInfo.scrollable && plInfo.overflow === 'auto';
    log(`UI-TEST: Lista -> ${JSON.stringify(plInfo)} listOk=${result.listOk}`);

    // Modal de búsqueda: se abre con el botón de la lupa y acepta una URL
    const modalInfo = await js(`(() => { document.getElementById('search').click();
      const open=document.body.classList.contains('showModal');
      const input=document.getElementById('modalInput');
      input.value=${JSON.stringify(AUTO_URL)};
      return {open, hasInput:!!input}; })()`);
    result.modalOk = !!modalInfo && modalInfo.open && modalInfo.hasInput;
    log(`UI-TEST: Modal de búsqueda -> ${JSON.stringify(modalInfo)} modalOk=${result.modalOk}`);
    await js("document.getElementById('modalCancel').click(); true");

    // Diagnóstico de herramientas (se ejecuta en la app al arrancar)
    const d = await toolVersions();
    const dv = vlc?.version?.() || '';
    result.diagOk = !/ERROR/.test(d.ytdlp + d.ffmpeg + d.deno) && !!dv;
    result.diag = { ...d, libvlc: dv };
    log(`UI-TEST: diagnóstico -> yt-dlp=${d.ytdlp} ffmpeg=${d.ffmpeg} deno=${d.deno} libVLC=${dv} diagOk=${result.diagOk}`);

    // Recarga (vuelve a resolver la URL) y sigue reproduciendo
    await js("document.getElementById('play').click(); true");
    let reloaded = false;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      const s = state();
      if (s.isPlaying && s.time > 0) { reloaded = true; break; }
    }
    result.reloadOk = reloaded;
    log(`UI-TEST: Recargar -> vuelve a reproducir=${reloaded} estado=${state().stateName} modo=${state().mode}`);

    // Pantalla completa (botón real)
    const fsr = await js("document.getElementById('full').click(); true");
    await sleep(1200);
    result.fullscreenOk = state().fullscreen === true;
    log(`UI-TEST: Pantalla completa -> ${JSON.stringify(fsr)} fullscreen=${state().fullscreen}`);
  } catch (e) {
    result.errors.push(String(e.message || e));
    log('UI-TEST ERROR:', result.errors.join('; '));
  }
  result.pass = result.loaded && result.paused && result.resumed && result.seekOk && result.volOk && result.stopOk
    && result.diagOk && result.reloadOk && result.listOk && result.modalOk;
  fs.writeFileSync(path.join(LOG_DIR, 'ui-test-result.json'), JSON.stringify(result, null, 2));
  log('UI-TEST FIN:', JSON.stringify(result));
  if (process.env.CMP_HOLD === '1') return;
  try { vlc?.stop(); } catch {}
  try { vlc?.dispose({ safe: true }); } catch {}
  await new Promise(r => setTimeout(r, 1000));
  app.exit(result.pass ? 0 : 5);
}

app.whenReady().then(async () => {
  log('app ready');
  log('userData:', app.getPath('userData'));
  if (process.env.CMP_ELECTRON_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');

  // ORDEN IMPORTANTE: primero las ventanas, después el motor.
  // libVLC puede tardar mucho en arrancar (escanea los 366 plugins y a veces
  // Windows/Defender lo ralentiza hasta 2 minutos). Si se esperaba aquí, la
  // app no aparecía y parecía congelada. Ahora la ventana sale AL INSTANTE y el
  // motor se inicializa en segundo plano.
  try {
    createWindows();
    log('ventanas creadas');
  } catch (e) {
    log('ERROR createWindows:', (e && e.stack) || String(e));
  }
  setupIpc();
  engineReady = false;
  engineReadyPromise = new Promise((r) => { resolveEngineReady = r; });

  // --- Watchdog del hilo principal -------------------------------------------
  // Mide el retardo del bucle de eventos. Si el hilo principal se bloquea (una
  // llamada FFI síncrona, un spawn, un DWM...), la app se queda "congelada" y
  // aquí queda registrado exactamente cuánto tiempo y en qué momento.
  let lastTick = Date.now();
  let stalls = 0;
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 1000;
    lastTick = now;
    if (lag > 400) {
      stalls++;
      log('ATASCO: hilo principal bloqueado ' + lag + ' ms (acumulados: ' + stalls + ')' +
        ' | escrituraLog=' + lastLogWriteMs + 'ms lentas=' + JSON.stringify(slowLogWrites.slice(-3)));
      if (stalls === 1 || stalls % 10 === 0) {
        try { emitEvent('playerError', { error: 'hilo principal bloqueado ' + lag + ' ms', kind: 'stall' }, 'system'); } catch {}
      }
    }
  }, 1000);

  // API de control local para el coordinador Node.js (arranca ya: el estado
  // refleja que el motor todavía se está preparando).
  try {
    api = new ControlApi({
      playerId: PLAYER_ID,
      port: Number(process.env.CMP_API_PORT || 17890),
      token: process.env.CMP_API_TOKEN || null,
      onCommand: (cmd, args, origin) => executeCommand(cmd, args, origin),
      getState: () => apiState(),
      log,
      runtimeFile: API_FILE,
    });
    await api.start();
  } catch (e) {
    log('ERROR API de control:', (e && e.stack) || String(e));
    api = null;
  }
  // Un ÚNICO ciclo de sondeo (antes había dos: uno a 500 ms y otro a 1 s, cada
  // uno con varias llamadas FFI a libVLC; eso saturaba el hilo principal y la
  // app se trababa). Ahora:
  //   * se lee el estado UNA vez por ciclo,
  //   * mientras libVLC está en una operación (cambio de medio) se usan los
  //     valores cacheados (vlc.busy) y no se toca el motor,
  //   * la posición se notifica por el mismo ciclo.
  setInterval(() => {
    if (!vlc || !vlc.player) return;
    // La lectura del motor es ASÍNCRONA: no bloquea el hilo principal (antes
    // una llamada FFI síncrona congelaba la app entera varios segundos).
    const t0 = Date.now();
    vlc.sync().then((last) => {
      const syncMs = Date.now() - t0;
      // Si el sondeo ve una transición que ningún evento ha reflejado todavía
      // (evento perdido), se programa la sincronización de eventos.
      try { if (statusOf(vlc.getState()) !== lastStatus) scheduleEngineSync(); } catch {}
      const snap = getState();               // una sola lectura (desde caché)
      // Guardado periódico de la posición en el historial (throttle: cada ~5 s
      // y el repositorio además limita por entrada). Nunca crea entradas nuevas:
      // sólo actualiza la del medio actual.
      pollTick++;
      if (pollTick % 5 === 0 && currentId && (snap.status === 'playing' || snap.status === 'paused')) {
        try { historyRepo.updateProgress(currentId, snap.time || 0, snap.length || 0); } catch {}
      }
      if (snap.status === 'playing') {
        stateVersion++;
        emitEvent('positionChanged', {
          position: (snap.time || 0) / 1000, duration: (snap.length || 0) / 1000,
          state: apiStateFrom(snap),
        }, 'system');
      }
      const tSend = Date.now();
      sendUpdate(snap);
      const sendMs = Date.now() - tSend;
      // Diagnóstico: cualquier fase lenta del sondeo se registra con su coste.
      if (syncMs > 150 || sendMs > 150) {
        log('SONDEO LENTO: sync=' + syncMs + ' ms, envio=' + sendMs + ' ms, estado=' + snap.status);
      }
    }).catch(() => {});
  }, 1000);
  winVideo?.webContents.on('did-finish-load', () => {
    if (winVideo && !winVideo.isDestroyed() && vlc) {
      // asignar HWND tras cargar (el handle ya existe; lo seteamos en play())
      log('winVideo hwnd:', winVideo.getNativeWindowHandle().toString('hex'));
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });

  // --- motor en segundo plano ----------------------------------------------
  // La interfaz ya está visible: aquí se prepara el proxy y libVLC. Si libVLC
  // tarda (escaneo de plugins), la app sigue respondiendo y lo avisa.
  (async () => {
    try {
      proxy = new StreamProxy({
        onLog: (m) => log(m),
        // Si el CDN rechaza la URL directa (416/403), se invalida la caché de
        // resoluciones para que la recarga vuelva a preguntar a YouTube.
        onUrlExpired: (id, status) => { try { clearResolveCache(); log('proxy: URL expirada (' + status + '), se re-resolverá'); } catch {} },
      });
      const port = await proxy.listen();
      log('proxy en 127.0.0.1:' + port);
    } catch (e) {
      log('ERROR proxy:', (e && e.stack) || String(e));
      proxy = null;
    }
    try {
      const t0 = Date.now();
      vlc = await VlcPlayer.create({ onTiming: (t) => {
        if (t.fase) { log('FFI ' + t.fase + ': ' + t.ms + ' ms' + (t.ptrTipo ? ' ptr=' + t.ptr : '') + (t.playerTipo ? ' player=' + t.player : '')); return; }
        log('tiempos de carga (ms): media=' + t.media + ' player=' + t.player + ' play=' + t.play + ' total=' + t.total);
      }, onEvent: (e) => {
        // libVLC repite a veces el mismo evento en ráfaga (p.ej. 20 "Playing"
        // en 100 ms). Se registra en el log sólo si cambió respecto al último
        // (o pasaron más de 2 s): el log crecía sin control y cada línea es E/S.
        const now = Date.now();
        if (e.name !== lastEventName || now - lastEventAt > 2000) {
          lastEventName = e.name; lastEventAt = now;
          log('evento:', e.name);
        }
        // Los eventos del motor llegan de forma asíncrona y a veces desordenada
        // (p.ej. 'Paused' después de 'Playing'). Por eso NO se traducen 1:1:
        // se relee el estado REAL de libVLC y se emite sólo la transición.
        scheduleEngineSync();
        if (e.name === 'EncounteredError') {
          // Durante un cambio de medio el error del medio anterior es previsto
          // (lo causamos nosotros al cortar el stream): no se reporta.
          if (!switchingMedia) currentError = 'error de reproduccion en libVLC';
        }
        // Modo HOLD (capturas de evidencia): al terminar, vuelve a empezar el medio.
        if (e.name === 'EndReached' && process.env.CMP_HOLD === '1') {
          setTimeout(() => { try { vlc?.setTime(0); vlc?.api.libvlc_media_player_play(vlc.player); log('HOLD: medio reiniciado'); } catch (err) { log('HOLD: no se pudo reiniciar', String(err)); } }, 600);
        }
      } });
      log('libVLC listo en ' + Math.round((Date.now() - t0) / 1000) + ' s');
      engineReady = true;
      try { resolveEngineReady?.(true); } catch {}
      notifyChange('system', 'engine-ready');
      sendUpdate();
      // Si el modo de prueba pidió un vídeo, se carga ahora que el motor está.
      if (process.argv.includes('--api-test')) {
        try {
          const r = await loadUrl(AUTO_URL, 'system');
          log('API-TEST:', r && r.ok ? 'cargado ' + r.title : 'error ' + JSON.stringify(r));
        } catch (e) { log('API-TEST error:', (e && e.stack) || String(e)); }
      }
    } catch (e) {
      log('ERROR init:', (e && e.stack) || String(e));
      currentError = 'no se pudo iniciar el motor de reproducción';
      try { resolveEngineReady?.(false); } catch {}
      notifyChange('system', 'engine-error');
    }
  })();

  // Vigilancia del medio: si la posición no avanza durante 20 s en un estado
  // que debería estar avanzando, el stream está cortado o el vout ha muerto
  // (la ventana se queda en negro). Se distingue lo que el usuario pidió:
  //   - estado 3 (playing) sin avanzar  -> siempre se recupera
  //   - estado 4 (paused) sin avanzar   -> sólo si NO fue una pausa pedida
  //   - estado 5 (stopped) / 7 (error)  -> sólo si NO fue un stop pedido
  // El 6 (ended) lo gestiona el autoavance de la cola y no se toca.
  // Al recuperarse se recarga la URL actual (las URLs de YouTube caducan,
  // así que además hay que volver a resolver con yt-dlp).
  let lastProgressAt = Date.now();
  let lastProgressPos = -1;
  let lastRecoveryAt = 0;
  const recover = (why) => {
    if (Date.now() - lastRecoveryAt < 60000) return;   // no repetir en bucle
    if (!currentUrl || intentionalStop || switchingMedia) return;
    lastRecoveryAt = Date.now();
    lastProgressAt = Date.now();
    lastProgressPos = -1;
    log('MEDIO COLGADO (' + why + '): se recarga ' + currentUrl);
    try { emitEvent('playerError', { error: 'medio colgado (' + why + '), se recarga', kind: 'stall' }, 'system'); } catch {}
    loadUrl(currentUrl, 'system').catch((e) => log('ERROR recuperacion:', String(e && e.message || e)));
  };
  setInterval(() => {
    if (!vlc || !vlc.player || !engineReady) return;
    const st = vlc.getState();
    const pos = vlc.getTime();
    if (pos !== lastProgressPos) { lastProgressPos = pos; lastProgressAt = Date.now(); }
    const quiet = Date.now() - lastProgressAt;
    let why = null;
    let limit = 20000;
    if (st === 3) why = 'reproduciendo sin avanzar';
    else if (st === 2 || st === 1) {
      // Sin datos, libVLC se queda en Buffering/Opening: ANTES esto se
      // reiniciaba el contador y el medio muerto nunca se recuperaba.
      limit = 30000;
      why = 'sin datos (' + (st === 2 ? 'buffering' : 'opening') + ')';
    }
    else if (st === 4 && !intentionalPause) why = 'pausado sin avanzar (stream muerto)';
    else if ((st === 5 || st === 7) && !intentionalStop) why = 'estado ' + st;
    if (!why) { if (st !== 2 && st !== 1) lastProgressAt = Date.now(); return; }  // pausa/stop pedidos: no recuperar
    if (quiet < limit) return;
    recover(why);
  }, 5000);

  if (AUTO_TEST) setTimeout(() => autoTest().catch(e => { log('ERROR autoTest:', (e && e.stack) || String(e)); app.exit(4); }), 1500);
  if (process.argv.includes('--ui-test')) setTimeout(() => uiTest().catch(e => { log('ERROR uiTest:', (e && e.stack) || String(e)); app.exit(6); }), 1500);
});

app.on('window-all-closed', () => {
  if (AUTO_TEST) { log('window-all-closed (auto-test: no se sale)'); return; }
  try { vlc?.dispose({ safe: true }); } catch {}
  try { proxy?.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try { unregisterVideoShortcuts(); } catch {}
  try { emitEvent('playerDisconnected', { reason: 'la app se cierra' }, 'system'); } catch {}
  try { saveProgressNow(); } catch {}
  try { api?.stop(); } catch {}
  try { vlc?.dispose(); } catch {}
  try { proxy?.close(); } catch {}
  try { store?.flush(true); } catch {}
  try { cleanupSubtitles(subsDir(process.env.CMP_TMPDIR || path.join(ROOT, '.tmp'))); } catch {}
  log('will-quit');
  flushLog(true);   // volcado sincrónico final: no se pierde nada del log
});
