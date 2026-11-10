// CIUDADAN MEDIA PLAYER — proceso principal Electron.
// YouTube -> yt-dlp (URL directa) -> proxy local 127.0.0.1 con Range -> libVLC (koffi) -> HWND.
// Controles Play/Pausa/Seek/Volumen vía IPC desde la ventana de controles.
import { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveYouTube, videoIdOf } from './resolver.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Identificador de esta instancia de reproductor (lo usa el coordinador para
// distinguir varios reproductores).
const PLAYER_ID = process.env.CMP_PLAYER_ID || 'ciudadan-media-main';
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const API_FILE = path.join(RUNTIME_DIR, 'control-api.json');
// Favicon/icono de la app (Ciudadan morado, versión con transparencia)
const APP_ICON = path.join(ROOT, 'assets', 'favicon-ciudadan-morado-transparente.ico');
try { app.setAppUserModelId('ciudadan.media.player'); } catch {}
// Perfil de usuario propio y limpio: un perfil de Electron corrupto en %APPDATA% provoca
// crash (0xc0000005) del browser process antes de 'ready' en esta máquina.
app.setPath('userData', process.env.CMP_USER_DATA || path.join(ROOT, '.electron-userdata'));
const LOG_DIR = path.join(ROOT, 'logs');
// Datos persistentes del usuario (listas, cola, historial): un único JSON.
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'ciudadan-media-store.json');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'app.log');
fs.writeFileSync(path.join(LOG_DIR, 'main-ran.txt'), 'main.js ejecutado pid=' + process.pid + ' argv=' + JSON.stringify(process.argv) + '\n');
// Log sincrónico: si la app termina abruptamente, no se pierde nada.
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  try { console.log(line); } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
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
log('almacenamiento:', STORE_FILE, '| listas:', store.lists().map((l) => l.name).join(', '));
log('proveedores de búsqueda:', searchRegistry.list().map((p) => p.id).join(', '));

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
  }, 150);
}

function createWindows() {
  winVideo = new BrowserWindow({
    width: 960, height: 570, minWidth: 480, minHeight: 300,
    backgroundColor: '#000000', title: 'Ciudadan Media Player',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  winVideo.loadFile(path.join(ROOT, 'renderer', 'video.html'));

  // Barra flotante estilo YouTube: ventana transparente encima del vídeo.
  winOverlay = new BrowserWindow({
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, focusable: true,
    show: false, width: 960, height: 540, icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  winOverlay.loadFile(path.join(ROOT, 'renderer', 'yt-controls.html'));
  winOverlay.once('ready-to-show', () => { try { winOverlay.show(); } catch {} positionOverlay(); });

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
    winOverlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    winOverlay.setAlwaysOnTop(true);
  } catch {}
}

function sendUpdate() {
  const s = getState();
  if (winOverlay && !winOverlay.isDestroyed()) winOverlay.webContents.send('cmp:update', s);
}

function getState() {
  // Estado interno (renderer + pruebas). El motor libVLC es la fuente de verdad.
  const fs = fullscreenNow();
  const pl = { playlistIndex: currentPlaylistIndex, playlistLength: PLAYLIST.length };
  if (!vlc || !vlc.player) {
    return {
      playerId: PLAYER_ID, state: 0, stateName: 'Idle', status: 'idle',
      time: 0, length: 0, position: 0, duration: 0,
      volume: lastVolume, muted: lastMute, isPlaying: false, ended: false,
      seekable: false, fullscreen: fs,
      title: currentTitle, mode: currentMode, error: currentError,
      videoId: currentId, url: currentUrl, connected: !!api, stateVersion, ...pl,
    };
  }
  const st = vlc.getState();
  const length = vlc.getLength();
  const time = vlc.getTime();
  const volume = vlc.getVolume();
  const muted = vlc.getMute();
  lastVolume = volume; lastMute = muted;
  return {
    playerId: PLAYER_ID,
    state: st, stateName: STATE_NAMES[st] || '?', status: statusOf(st),
    time, length, position: vlc.getPosition(), duration: Math.round(length / 1000),
    positionSeconds: Math.round(time / 100) / 10,
    volume, muted, isPlaying: vlc.isPlaying(), ended: st === 6,
    seekable: length > 0, fullscreen: fs,
    title: currentTitle, mode: currentMode, error: currentError,
    videoId: currentId, url: currentUrl, connected: true, stateVersion, ...pl,
  };
}

// Estado con la forma del contrato de control (segundos, no milisegundos).
function apiState() {
  const s = getState();
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
// Índice actual dentro de la lista hardcodeada (src/playlist.js).
let currentPlaylistIndex = 0;
// Control API local (coordinador Node.js) y control de estado.
let api = null;
let stateVersion = 0;
let lastVolume = 100;
let lastMute = false;
let lastStatus = 'idle';
let switchingMedia = false; // true mientras se cambia de medio (los errores del medio viejo son previstos)
const recentEvents = [];

// Carga (o recarga) de una URL de YouTube: resuelve con yt-dlp y arranca libVLC.
async function loadUrl(url, origin = 'user') {
  try {
    log('load:', url);
    const entry = await resolveYouTube(url);
    currentTitle = entry.title; currentMode = entry.mode; currentError = entry.errors?.join('; ') || null; currentId = entry.id;
    currentUrl = url;
    // Si la URL cargada es un elemento de la lista, se marca como actual.
    const plIdx = PLAYLIST.findIndex((it) => it.url === url || (entry.id && it.id === entry.id));
    if (plIdx >= 0) currentPlaylistIndex = plIdx;
    // Historial local de reproducciones y posición actual de la cola.
    const ytId = videoIdOf(url);
    store.addHistory({ id: ytId, title: entry.title, url, duration: entry.duration || null });
    queue.setCurrent(ytId);
    if (entry.errors?.length) log('avisos del resolver:', entry.errors.join(' || '));
    proxy.register(entry);
    const streamUrl = proxy.streamUrl(entry.id);
    log(`resuelto: modo=${entry.mode} client=${entry.client} format=${entry.formatId} res=${entry.resolution} -> ${streamUrl}`);
    // La ventana de video puede haberse cerrado mientras se resolvia la URL
    // (tarda ~4 s). En ese caso no se puede embeber libVLC: se avisa claro.
    if (!winVideo || winVideo.isDestroyed()) {
      throw new Error('la ventana de video esta cerrada: no se puede reproducir (vuelve a abrir la app)');
    }
    const hwndBuf = winVideo.getNativeWindowHandle();
    // Antes de cambiar de medio se corta el stream anterior: si el hilo de
    // entrada de libVLC sigue leyendo del socket, su stop() interno se bloquea
    // y el proceso principal deja de responder (la API muere al cambiar de
    // vídeo con algo sonando). Durante el cambio se ignoran los errores del
    // medio viejo, que son provocados por nosotros.
    switchingMedia = true;
    try { proxy.abortAll(); } catch {}
    vlc.play(streamUrl, { hwnd: hwndBuf, mediaOptions: [':network-caching=1200'] });
    switchingMedia = false;
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
  engineSyncTimer = setTimeout(() => {
    engineSyncTimer = null;
    if (!vlc || !vlc.player) return;
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
      // Autoavance: si la cola está activada y hay siguiente, se reproduce.
      // Sólo cuando el medio estaba reproduciendo (fin real, no un stop).
      if (prev === 'playing' && queue.autoAdvance && queue.items.length && queue.currentIndex >= 0) {
        const nextItem = queue.nextItem();
        if (nextItem) {
          log('AUTOAVANCE: cola -> siguiente', nextItem.title || nextItem.id);
          setTimeout(() => {
            playMediaItem(nextItem, 'system').catch((e) => log('ERROR autoavance:', String(e.message || e)));
          }, 400);
        }
      }
    }
    else if (status === 'error') emitEvent('playerError', { error: currentError || 'error del motor', state: s }, 'system');
  }, 180);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1500, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return true; } catch {}
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
  const id = String(it.id || it.videoId || '').trim();
  if (!id) throw new Error('vídeo sin id');
  const url = String(it.url || '').trim() || `https://www.youtube.com/watch?v=${id}`;
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
  const rc = vlc.setVolume(target);
  if (rc !== 0) throw new Error('libVLC rechazo el volumen (rc=' + rc + ')');
  const real = vlc.getVolume();
  lastVolume = real;
  const st = notifyChange(origin, 'volume');
  emitEvent('volumeChanged', { volume: real, muted: vlc.getMute(), state: st }, origin);
  return { result: { volume: real, requested: target }, state: st };
}

async function applyMute(on, origin) {
  if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
  const rc = vlc.setMute(!!on);
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
  vlc.setTime(Math.round(t * 1000));
  const ok = await waitFor(() => Math.abs(vlc.getTime() / 1000 - t) < 2.5, 3000, 150);
  const st = notifyChange(origin, reason);
  emitEvent('positionChanged', { position: vlc.getTime() / 1000, duration: len / 1000, state: st }, origin);
  if (!ok) throw new Error('el motor no confirmo la posicion ' + t + 's (pos actual ' + (vlc.getTime() / 1000).toFixed(1) + 's)');
  return { result: { position: vlc.getTime() / 1000, requested: t }, state: st };
}

async function executeCommand(command, args = {}, origin = 'api') {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const curVolume = () => (vlc && vlc.player ? vlc.getVolume() : lastVolume);
  const curTime = () => (vlc && vlc.player ? vlc.getTime() / 1000 : 0);

  switch (command) {
    case 'play': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      const st0 = vlc.getState();
      if (st0 === 4) {
        // Reanudar: set_pause(0) es idempotente y no reinicia el medio.
        vlc.setPaused(false);
        const ok = await waitFor(() => vlc.getState() === 3, 2500);
        if (!ok) throw new Error('el motor no confirmo la reanudacion');
      } else {
        const rc = vlc.api.libvlc_media_player_play(vlc.player);
        if (rc !== 0) throw new Error('libVLC rechazo la reproduccion (rc=' + rc + ')');
      }
      // Los eventos playback* los emite scheduleEngineSync() a partir del estado
      // REAL del motor: aqui solo se confirma la orden y se notifica el cambio.
      const st = notifyChange(origin, 'play');
      return { result: { playing: true }, state: st };
    }
    case 'pause': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      vlc.setPaused(true);
      const ok = await waitFor(() => vlc.getState() === 4, 2000);
      if (!ok) throw new Error('el motor no confirmo la pausa');
      const st = notifyChange(origin, 'pause');
      return { result: { paused: true }, state: st };
    }
    case 'stop': {
      if (!vlc || !vlc.player) throw new Error('no hay medio cargado');
      vlc.stop();
      const ok = await waitFor(() => vlc.getState() === 5 || vlc.getTime() === 0, 2500);
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
      const provider = searchRegistry.get(a.provider);
      const res = await provider.search(q, { limit, offset, cancelPrevious: a.cancelPrevious !== false });
      return { result: { query: q, provider: provider.id, ...res }, state: apiState() };
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
      return { result: { history: store.history(clamp(Math.trunc(toNum(a.limit, 50)), 1, 200)) }, state: apiState() };
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
      const res = await provider.search(String(o.query || ''), {
        limit: clamp(Math.trunc(toNum(o.limit, 20)), 1, 50),
        offset: Math.max(0, Math.trunc(toNum(o.offset, 0))),
        // La paginación no cancela la búsqueda en curso.
        cancelPrevious: o.cancelPrevious !== false,
      });
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
  try { vlc.setTime(120000); } catch {}
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
  try {
    proxy = new StreamProxy();
    const port = await proxy.listen();
    log('proxy en 127.0.0.1:' + port);
    vlc = new VlcPlayer({ onEvent: (e) => {
      log('evento:', e.name);
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
    log('libVLC listo');
  } catch (e) {
    log('ERROR init:', (e && e.stack) || String(e));
  }
  try {
    createWindows();
    log('ventanas creadas');
  } catch (e) {
    log('ERROR createWindows:', (e && e.stack) || String(e));
  }
  setupIpc();
  setInterval(sendUpdate, 500);
  // Tick de posición: el coordinador recibe posición/duración sin tener que
  // preguntar (y con número de versión para descartar respuestas viejas).
  setInterval(() => {
    if (!vlc || !vlc.player) return;
    const st = vlc.getState();
    if (st !== 3) return; // sólo mientras reproduce
    stateVersion++;
    emitEvent('positionChanged', {
      position: vlc.getTime() / 1000, duration: vlc.getLength() / 1000,
      state: apiState(),
    }, 'system');
  }, 1000);
  // API de control local para el coordinador Node.js.
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
  winVideo?.webContents.on('did-finish-load', () => {
    if (winVideo && !winVideo.isDestroyed() && vlc) {
      // asignar HWND tras cargar (el handle ya existe; lo seteamos en play())
      log('winVideo hwnd:', winVideo.getNativeWindowHandle().toString('hex'));
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
  if (AUTO_TEST) setTimeout(() => autoTest().catch(e => { log('ERROR autoTest:', (e && e.stack) || String(e)); app.exit(4); }), 1500);
  if (process.argv.includes('--ui-test')) setTimeout(() => uiTest().catch(e => { log('ERROR uiTest:', (e && e.stack) || String(e)); app.exit(6); }), 1500);
  // Modo para las pruebas del API de control: carga el vídeo y se queda vivo.
  if (process.argv.includes('--api-test')) setTimeout(async () => {
    try {
      const r = await loadUrl(AUTO_URL, 'system');
      log('API-TEST:', r && r.ok ? 'cargado ' + r.title : 'error ' + JSON.stringify(r));
    } catch (e) { log('API-TEST error:', (e && e.stack) || String(e)); }
  }, 1500);
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
  try { api?.stop(); } catch {}
  try { vlc?.dispose(); } catch {}
  try { proxy?.close(); } catch {}
  log('will-quit');
});
