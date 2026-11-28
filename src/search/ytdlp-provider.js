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
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SearchProvider } from './provider.js';
import { TOOLS, YT_CLIENTS } from '../paths.js';
import { SP as SP_CODES } from './sp-codes.js';
import { searchDirect } from './youtube-web-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TMP_BASE = process.env.CMP_TMPDIR || path.join(ROOT, '.tmp');
try { fs.mkdirSync(TMP_BASE, { recursive: true }); } catch {}

// Tiempos: YouTube puede ralentizar mucho las peticiones repetidas (una
// búsqueda puede tardar más de 60 s), así que el margen es amplio. El tiempo
// de espera se distingue de una cancelación real (mensajes distintos).
const SEARCH_TIMEOUT_MS = Number(process.env.CMP_SEARCH_TIMEOUT_MS || 60000);
const SEARCH_DEADLINE_MS = Number(process.env.CMP_SEARCH_DEADLINE_MS || 75000);
const DETAILS_TIMEOUT_MS = Number(process.env.CMP_DETAILS_TIMEOUT_MS || 90000);

// Caché temporal de resultados (evita repetir la misma búsqueda en poco tiempo).
// 10 minutos: con YouTube limitando las peticiones, repetir la misma búsqueda
// no debe volver a golpear la red (ni hacer esperar al usuario).
const CACHE_TTL_MS = Number(process.env.CMP_SEARCH_CACHE_MS || 600000);
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
    child.on('close', async (code) => {
      clearTimeout(killer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Lectura ASÍNCRONA: el antivirus analiza los ficheros recién creados en
      // el primer acceso y, con readFileSync, ese análisis congelaba la
      // interfaz durante toda la búsqueda.
      let out = '', err = '';
      try { out = await fsp.readFile(outFile, 'utf8'); } catch {}
      try { err = await fsp.readFile(errFile, 'utf8'); } catch {}
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
  if (entry.channel_id) item.channelId = entry.channel_id;
  if (entry.uploader_id) item.uploaderId = entry.uploader_id;
  if (entry.category) item.category = entry.category;
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
  // Tipo de resultado (para el filtro de tipo cuando la búsqueda devuelve mezcla).
  const ie = String(entry.ie_key || '');
  if (ie === 'YoutubePlaylist') item.type = 'playlist';
  else if (ie === 'YoutubeTab') item.type = 'channel';
  else if (item.isLive) item.type = 'live';
  else if (item.url && /\/shorts\//i.test(item.url)) item.type = 'short';
  else item.type = 'video';
  return item;
}

// --- filtros de búsqueda ------------------------------------------------------
// Los códigos "sp" viven en ./sp-codes.js (los usan también la búsqueda directa).
const SP = SP_CODES;

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Construye los argumentos de yt-dlp para una búsqueda con filtros. */
export function buildSearchArgs(query, { limit = 20, offset = 0, filters = {} } = {}) {
  const f = filters || {};
  const sp = [];
  if (f.type && f.type !== 'any' && SP.type[f.type]) sp.push(SP.type[f.type]);
  if (f.sort && f.sort !== 'relevance' && SP.sort[f.sort]) sp.push(SP.sort[f.sort]);
  if (f.date && f.date !== 'any' && SP.date[f.date]) sp.push(SP.date[f.date]);
  if (f.duration && f.duration !== 'any' && SP.duration[f.duration]) sp.push(SP.duration[f.duration]);
  for (const feat of (f.features || [])) if (SP.features[feat]) sp.push(SP.features[feat]);

  const args = ['--no-warnings', '--flat-playlist', '--dump-single-json', '--skip-download'];
  // Intervalo de fechas personalizado: argumentos del proveedor (no hay sp exacto).
  if (f.dateFrom) args.push('--dateafter', String(f.dateFrom).replace(/-/g, ''));
  if (f.dateTo) args.push('--datebefore', String(f.dateTo).replace(/-/g, ''));

  let target;
  if (sp.length) {
    // Hay filtros que sólo la página de resultados aplica: se usa su URL con sp.
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query)
      + '&sp=' + encodeURIComponent(sp.join(''));
    target = url;
  } else {
    // Sin filtros de sp: la ruta clásica ytsearchN (idéntica a la de siempre).
    target = `ytsearch${offset + limit}:${query}`;
  }
  args.push(target);
  return { args, usedResultsUrl: sp.length > 0 };
}

/** Post-filtros LOCALES (sobre metadatos ya obtenidos; nunca tocan la red). */
export function applyLocalFilters(items, filters = {}) {
  const f = filters || {};
  let out = items;
  if (f.type === 'shorts') out = out.filter((it) => it.type === 'short' || (it.url && /\/shorts\//i.test(it.url)));
  if (f.channel) {
    const c = String(f.channel).toLowerCase();
    out = out.filter((it) => (it.channel || '').toLowerCase().includes(c) || (it.channelId || '').toLowerCase() === c);
  }
  if (f.duration && f.duration !== 'any') {
    // Refuerzo local de la duración (por si el sp no vino en la respuesta):
    // los que no tienen dato real de duración no se descartan.
    out = out.filter((it) => {
      const d = Number(it.duration);
      if (!Number.isFinite(d) || d <= 0) return true;
      if (f.duration === 'short') return d < 240;
      if (f.duration === 'medium') return d >= 240 && d <= 1200;
      if (f.duration === 'long') return d > 1200;
      return true;
    });
  }
  return out;
}

export function hasProviderFilters(filters = {}) {
  const f = filters || {};
  return !!(f.type && f.type !== 'any' && f.type !== 'shorts' && SP.type[f.type])
    || !!(f.sort && f.sort !== 'relevance' && SP.sort[f.sort])
    || !!(f.date && f.date !== 'any' && SP.date[f.date])
    || !!(f.duration && f.duration !== 'any' && SP.duration[f.duration])
    || (f.features || []).some((x) => SP.features[x])
    || f.dateFrom || f.dateTo;
}

export class YtDlpSearchProvider extends SearchProvider {
  get id() { return 'ytdlp'; }
  get name() { return 'YouTube (yt-dlp)'; }
  get capabilities() {
    return {
      // Sólo se declaran filtros con implementación REAL. scope:'provider' =
      // lo aplica YouTube/yt-dlp en la propia consulta; scope:'local' = se
      // filtra sobre los metadatos devueltos (se marca en la interfaz).
      filters: [
        { id: 'type', name: 'Tipo', scope: 'provider', options: [
          { id: 'any', name: 'Cualquiera' },
          { id: 'video', name: 'Vídeos' },
          { id: 'channel', name: 'Canales' },
          { id: 'playlist', name: 'Listas de reproducción' },
          { id: 'live', name: 'Directos' },
          { id: 'shorts', name: 'Shorts', scope: 'local', note: 'detectados por la URL /shorts/' },
        ] },
        { id: 'date', name: 'Fecha de publicación', scope: 'provider', options: [
          { id: 'any', name: 'Cualquiera' },
          { id: 'hour', name: 'Última hora' },
          { id: 'today', name: 'Hoy' },
          { id: 'week', name: 'Esta semana' },
          { id: 'month', name: 'Este mes' },
          { id: 'year', name: 'Este año' },
        ], customRange: true }, // intervalo personalizado vía --dateafter/--datebefore
        { id: 'duration', name: 'Duración', scope: 'provider', options: [
          { id: 'any', name: 'Cualquiera' },
          { id: 'short', name: 'Menos de 4 min' },
          { id: 'medium', name: '4–20 min' },
          { id: 'long', name: 'Más de 20 min' },
        ] },
        { id: 'features', name: 'Características', scope: 'provider', multiple: true, options: [
          { id: 'cc', name: 'Con subtítulos' },
          { id: 'hd', name: 'HD (720p+)' },
          { id: '4k', name: '4K (aprox.)', note: 'la API no garantiza 4K exacto' },
          { id: 'live', name: 'En directo' },
          { id: '360', name: '360°' },
          { id: 'hdr', name: 'HDR' },
        ] },
        { id: 'sort', name: 'Ordenar por', scope: 'provider', options: [
          { id: 'relevance', name: 'Relevancia' },
          { id: 'date', name: 'Fecha' },
          { id: 'views', name: 'Visualizaciones' },
          { id: 'rating', name: 'Valoración' },
        ] },
        { id: 'channel', name: 'Canal específico', scope: 'local', text: true },
      ],
      details: true,
      pagination: true,
    };
  }

  /**
   * Búsqueda ligera con filtros opcionales.
   * opts.filters: { type, date, dateFrom, dateTo, duration, features:[], sort, channel }
   */
  async search(query, { limit = 20, offset = 0, signal = null, cancelPrevious = true, filters = null } = {}) {
    const q = String(query || '').trim();
    if (!q) return { items: [], hasMore: false };
    const n = Math.max(1, Math.min(50, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const fKey = filters ? JSON.stringify(filters) : '';
    const cacheKey = `${q}|${n}|${off}|${fKey}`;
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
    if (signal) signal.addEventListener('abort', () => { try { ctrl.abort(); } catch {} }, { once: true });

    try {
      // VÍA RÁPIDA primero: una sola petición HTTP a la página de resultados de
      // YouTube (~2 s). Si YouTube la bloquea o cambia el HTML, se cae al
      // respaldo de yt-dlp (más lento pero robusto). Así el usuario no se
      // queda mirando "Buscando..." durante un minuto.
      try {
        const fast = await searchDirect(q, { limit: n, offset: off, filters: filters || {}, signal: ctrl.signal });
        if (fast && fast.items && fast.items.length) {
          const out = { items: fast.items, hasMore: !!fast.hasMore, source: 'web-direct' };
          this._cache.set(cacheKey, { at: Date.now(), value: out });
          if (this._cache.size > CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
          return out;
        }
      } catch { /* la vía rápida falló: sigue con yt-dlp */ }

      // Búsqueda ligera: no resuelve formatos ni descarga nada.
      const built = buildSearchArgs(q, { limit: n, offset: off, filters: filters || {} });
      const args = built.args;
      const usedResultsUrl = built.usedResultsUrl;
      // El target (ytsearchN:... o la URL de resultados) es el ÚLTIMO argumento.
      const target = args[args.length - 1];
      let json = null; let lastErr = null;
      const deadline = Date.now() + SEARCH_DEADLINE_MS;
      // YouTube ralentiza o bloquea una petición si se repite: en vez de
      // esperar 120 s a un único cliente y luego reintentar en serie (lo que
      // dejaba la UI en "Buscando..." más de dos minutos), se prueban DOS
      // clientes EN PARALELO y se toma el primero que responde.
      const clientsTry = YT_CLIENTS.slice(0, 2);
      const perClient = Math.max(20000, Math.min(SEARCH_TIMEOUT_MS, Math.floor((deadline - Date.now()) / 2) || 20000));
      const group = new AbortController();
      const abortGroup = () => { try { group.abort(); } catch {} };
      if (signal) signal.addEventListener('abort', abortGroup, { once: true });
      ctrl.signal.addEventListener('abort', abortGroup, { once: true });
      const attempts = clientsTry.map((client) => {
        const cArgs = args.slice(0, -1);
        cArgs.push('--extractor-args', `youtube:player_client=${client}`, target);
        return runYtdlp(cArgs, { timeoutMs: perClient, signal: group.signal })
          .then((v) => ({ ok: true, v, client }))
          .catch((e) => ({ ok: false, e, client }));
      });
      try {
        const r = await Promise.any(attempts);
        if (r && r.ok) json = r.v;
        else lastErr = (r && r.e) || new Error('búsqueda sin resultados');
      } catch (agg) {
        const errs = (agg && agg.errors) || [];
        lastErr = errs.find((x) => x && x.ok === false && x.e) || lastErr || new Error('búsqueda sin resultados');
      } finally {
        abortGroup();   // cancela el cliente perdedor
      }
      if (!json) throw lastErr || new Error('búsqueda sin resultados');
      const entries = Array.isArray(json.entries) ? json.entries : (json.id ? [json] : []);
      let items = entries.map((e) => normalizeEntry(e, this.id)).filter(Boolean);
      // Filtros locales (shorts por URL, canal, duración de respaldo).
      if (filters) items = applyLocalFilters(items, filters);
      const hasMore = usedResultsUrl ? entries.length >= n : entries.length >= off + n;
      const out = { items: items.slice(off, off + n), hasMore };
      this._cache.set(cacheKey, { at: Date.now(), value: out });
      if (this._cache.size > CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
      return out;
    } finally {
      if (activeSearch === ctrl) activeSearch = null;
    }
  }

  /** Lista plana de una URL (p.ej. /channel/UC.../videos) sólo con metadatos. */
  async fetchFlat(url, { limit = 20, signal = null } = {}) {
    const u = String(url || '').trim();
    if (!/^https?:/i.test(u)) throw new Error('URL no válida');
    const n = Math.max(1, Math.min(50, Number(limit) || 20));
    const args = ['--no-warnings', '--flat-playlist', '--dump-single-json', '--skip-download', u];
    const json = await runYtdlp(args, { timeoutMs: SEARCH_TIMEOUT_MS, signal });
    const entries = Array.isArray(json.entries) ? json.entries : [];
    const items = entries.map((e) => normalizeEntry(e, this.id)).filter(Boolean);
    return { items: items.slice(0, n), hasMore: entries.length > n };
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
