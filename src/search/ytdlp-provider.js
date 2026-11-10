// Proveedor de búsqueda de YouTube basado en yt-dlp.
//
// - Búsqueda LIGERA: `ytsearchN:<consulta> --flat-playlist --dump-single-json`
//   devuelve id, título, canal, duración, visualizaciones y miniaturas sin
//   resolver ningún flujo multimedia (no se descarga ni se resuelve ningún vídeo).
// - Metadatos COMPLETOS bajo demanda: se piden con un único vídeo y, si el
//   cliente web de YouTube exige verificación, se reintenta con los clientes
//   que ya usa el resolver (android, tv_embedded, ...).
// - El texto del usuario NUNCA se interpola en una orden de shell: todo se
//   pasa como argumento de `spawn` (sin shell).
// - La búsqueda corre en un proceso hijo: el hilo de interfaz de Electron no
//   se bloquea y la reproducción actual no se congela.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SearchProvider } from './provider.js';
import { TOOLS, YT_CLIENTS } from '../paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TMP_BASE = process.env.CMP_TMPDIR || path.join(ROOT, '.tmp');
try { fs.mkdirSync(TMP_BASE, { recursive: true }); } catch {}

// Tiempos: YouTube puede ralentizar mucho las peticiones repetidas (una
// búsqueda puede tardar más de 60 s), así que el margen es amplio. El tiempo
// de espera se distingue de una cancelación real (mensajes distintos).
const SEARCH_TIMEOUT_MS = Number(process.env.CMP_SEARCH_TIMEOUT_MS || 120000);
const SEARCH_DEADLINE_MS = Number(process.env.CMP_SEARCH_DEADLINE_MS || 210000);
const DETAILS_TIMEOUT_MS = Number(process.env.CMP_DETAILS_TIMEOUT_MS || 90000);

// Caché temporal de resultados (evita repetir la misma búsqueda en poco tiempo).
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 30;

// Límite de concurrencia: una búsqueda activa (la nueva cancela la anterior) y
// como mucho 2 peticiones de metadatos simultáneas.
let activeSearch = null;
let detailsInFlight = 0;
const detailsQueue = [];

// --- ejecución segura de yt-dlp ---------------------------------------------
// Escribe la salida en un fichero real (en el sandbox de DSH los named pipes
// están bloqueados) y devuelve el JSON parseado.
function runYtdlp(args, { timeoutMs = 30000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let tmpDir;
    try { tmpDir = fs.mkdtempSync(path.join(TMP_BASE, 'cmp-search-')); }
    catch (e) { return reject(e); }
    const outFile = path.join(tmpDir, 'out.json');
    const errFile = path.join(tmpDir, 'err.txt');
    let outFd, errFd;
    try {
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return reject(e);
    }
    let child = null;
    let killed = false;
    let timedOut = false;
    const cleanup = () => {
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };
    const kill = () => { killed = true; try { child?.kill(); } catch {} };
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) { cleanup(); return reject(new Error('búsqueda cancelada')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // Sin shell: la consulta viaja como argumento propio (nunca interpolada).
      child = spawn(TOOLS.ytdlp, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, shell: false });
    } catch (e) {
      cleanup();
      return reject(e);
    }
    const killer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); cleanup(); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let out = '', err = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch {}
      try { err = fs.readFileSync(errFile, 'utf8'); } catch {}
      cleanup();
      if (killed) return reject(new Error(timedOut ? `tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s)` : 'búsqueda cancelada'));
      if (code !== 0 || !out.trim()) {
        const msg = (err || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ');
        return reject(new Error('yt-dlp exit=' + code + (msg ? ': ' + msg : '')));
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('JSON de yt-dlp inválido')); }
    });
  });
}

// --- normalización de metadatos ---------------------------------------------
function pickThumb(thumbs, maxW = 480) {
  if (!Array.isArray(thumbs) || !thumbs.length) return null;
  const withUrl = thumbs.filter((t) => t && t.url);
  if (!withUrl.length) return null;
  const sorted = [...withUrl].sort((a, b) => (b.width || 0) - (a.width || 0));
  const fit = sorted.find((t) => (t.width || 0) <= maxW);
  return (fit || sorted[sorted.length - 1]).url;
}

function publishedFrom(entry) {
  //yt-dlp puede dar upload_date (YYYYMMDD), timestamp o release_timestamp.
  const ud = entry.upload_date;
  if (typeof ud === 'string' && /^\d{8}$/.test(ud)) {
    return `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}`;
  }
  const ts = entry.release_timestamp || entry.timestamp;
  if (typeof ts === 'number' && ts > 0) return new Date(ts * 1000).toISOString().slice(0, 10);
  return null;
}

export function normalizeEntry(entry, providerId = 'ytdlp') {
  if (!entry || !entry.id) return null;
  const id = String(entry.id);
  const url = entry.webpage_url || entry.original_url || entry.url ||
    (entry.ie_key === 'Youtube' ? `https://www.youtube.com/watch?v=${id}` : null);
  const item = {
    id,
    provider: providerId,
    title: entry.title || null,
    url: url && /^https?:/i.test(url) ? url : null,
  };
  if (entry.channel || entry.uploader) item.channel = entry.channel || entry.uploader;
  if (entry.channel_url) item.channelUrl = entry.channel_url;
  if (typeof entry.duration === 'number' && entry.duration > 0) item.duration = entry.duration;
  if (typeof entry.view_count === 'number' && entry.view_count >= 0) item.viewCount = entry.view_count;
  const published = publishedFrom(entry);
  if (published) item.publishedAt = published;
  if (entry.description && String(entry.description).trim()) item.description = String(entry.description).trim();
  const thumb = pickThumb(entry.thumbnails);
  if (thumb) item.thumbnail = thumb;
  if (Array.isArray(entry.thumbnails)) {
    item.thumbnails = entry.thumbnails.filter((t) => t && t.url).map((t) => ({ url: t.url, width: t.width || 0, height: t.height || 0 }));
  }
  const live = entry.live_status || entry.is_live;
  if (live === 'is_live' || live === 'is_upcoming' || entry.is_live === true) item.isLive = live;
  return item;
}

export class YtDlpSearchProvider extends SearchProvider {
  get id() { return 'ytdlp'; }
  get name() { return 'YouTube (yt-dlp)'; }
  get capabilities() {
    return {
      // Sólo se declaran los filtros que el proveedor puede aplicar DE VERDAD
      // sobre los datos que devuelve: la búsqueda ligera de yt-dlp no trae
      // fecha de publicación (no se inventa ni se simula ese filtro), pero sí
      // trae la duración real de cada vídeo.
      filters: [
        { id: 'duration', name: 'Duración', options: [
          { id: 'any', name: 'Cualquiera' },
          { id: 'short', name: 'Corto (<4 min)' },
          { id: 'medium', name: 'Medio (4-20 min)' },
          { id: 'long', name: 'Largo (>20 min)' },
        ] },
      ],
      // El proveedor devuelve los resultados ordenados por relevancia de YouTube.
      sort: [{ id: 'relevance', name: 'Relevancia' }],
      details: true,
      pagination: true,
    };
  }

  async search(query, { limit = 20, offset = 0, signal = null, cancelPrevious = true } = {}) {
    const q = String(query || '').trim();
    if (!q) return { items: [], hasMore: false };
    const n = Math.max(1, Math.min(50, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const cacheKey = `${q}|${n}|${off}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.value, cached: true };
    }

    // Una búsqueda NUEVA cancela la anterior (no se ejecutan búsquedas
    // simultáneas). La paginación (cancelPrevious=false) NO cancela nada: si no,
    // pedir la página 2 abortaría la página 1 y se perderían los resultados.
    if (cancelPrevious) { if (activeSearch) { try { activeSearch.abort(); } catch {} } }
    const ctrl = new AbortController();
    activeSearch = ctrl;

    try {
      // Búsqueda ligera: no resuelve formatos ni descarga nada.
      const target = `ytsearch${off + n}:${q}`;
      const args = ['--no-warnings', '--flat-playlist', '--dump-single-json', '--skip-download', target];
      let json = null; let lastErr = null;
      const deadline = Date.now() + SEARCH_DEADLINE_MS;
      try {
        json = await runYtdlp(args, { timeoutMs: SEARCH_TIMEOUT_MS, signal: ctrl.signal });
      } catch (e) {
        lastErr = e;
        // Reintento con un cliente concreto si el cliente web pide verificación
        // o si se agota el tiempo (YouTube ralentiza las peticiones repetidas).
        for (const client of YT_CLIENTS.slice(0, 3)) {
          if (Date.now() > deadline) break;   // no se encadena reintentos eternos
          const left = Math.max(15000, deadline - Date.now());
          try {
            json = await runYtdlp(
              ['--no-warnings', '--flat-playlist', '--dump-single-json', '--skip-download',
                '--extractor-args', `youtube:player_client=${client}`, target],
              { timeoutMs: Math.min(SEARCH_TIMEOUT_MS, left), signal: ctrl.signal },
            );
            lastErr = null;
            break;
          } catch (e2) { lastErr = e2; }
        }
      }
      if (!json) throw lastErr || new Error('búsqueda sin resultados');
      const entries = Array.isArray(json.entries) ? json.entries : [];
      const items = entries.map((e) => normalizeEntry(e, this.id)).filter(Boolean);
      const out = { items: items.slice(off, off + n), hasMore: entries.length >= off + n };
      this._cache.set(cacheKey, { at: Date.now(), value: out });
      if (this._cache.size > CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
      return out;
    } finally {
      if (activeSearch === ctrl) activeSearch = null;
    }
  }

  async details(idOrUrl) {
    const ref = String(idOrUrl || '').trim();
    if (!ref) return null;
    const url = /^https?:/i.test(ref) ? ref : `https://www.youtube.com/watch?v=${ref}`;
    // Límite de concurrencia para los metadatos: 2 simultáneos, el resto espera.
    if (detailsInFlight >= 2) {
      await new Promise((resolve, reject) => {
        detailsQueue.push({ resolve, reject });
      });
    }
    detailsInFlight++;
    try {
      let json = null; let lastErr = null;
      // El cliente web de YouTube suele pedir verificación ("Sign in to confirm
      // you're not a bot"): se prueban alternativas. mweb y android funcionan
      // con extracción ligera (no resuelven formatos: no descargan nada).
      const attempts = [
        { client: null, timeout: 20000 },
        { client: 'mweb', timeout: 30000 },
        { client: 'android', timeout: 30000 },
      ];
      for (const a of attempts) {
        const args = ['--no-warnings', '--skip-download', '--flat-playlist', '--dump-single-json'];
        if (a.client) args.push('--extractor-args', `youtube:player_client=${a.client}`);
        args.push(url);
        try {
          json = await runYtdlp(args, { timeoutMs: a.timeout });
          break;
        } catch (e) { lastErr = e; }
      }
      if (!json) throw lastErr || new Error('no se pudieron obtener los metadatos');
      return normalizeEntry(json, this.id);
    } finally {
      detailsInFlight--;
      const next = detailsQueue.shift();
      if (next) next.resolve();
    }
  }

  cancel() { if (activeSearch) { try { activeSearch.abort(); } catch {} activeSearch = null; } }
}

YtDlpSearchProvider.prototype._cache = new Map();
