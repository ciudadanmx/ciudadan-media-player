// HistoryRepository — historial persistente de reproducciones y de búsquedas,
// independiente de YouTube y reutilizable por otros módulos.
//
// Vive sobre el UserStore (JSON atómico con escritura asíncrona agrupada), pero
// encapsula todo el esquema: la UI nunca toca la persistencia directamente.
//
// Esquema de una entrada de reproducción:
//   { id (interno: provider:sourceId), provider, sourceId, title, creator, thumbnail,
//     url (playbackReference), duration, firstPlayedAt, lastPlayedAt, playCount,
//     positionMs (última posición guardada), status: 'started'|'partial'|'finished',
//     classification: 'music'|'theme'|null, searchContext }
// Esquema de una entrada de búsqueda:
//   { query, filters, mode, at, count }
//
// Reglas:
//  - Una actualización de progreso NUNCA crea elemento nuevo ni infla el
//    contador: recordPlay sube playCount sólo cuando cambia el medio.
//  - La posición se guarda con throttle (el llamador ya la limita; aquí además
//    se ignora si no pasan minSaveMs desde la última escritura de esa entrada).
//  - La búsqueda del historial es 100% local (nunca toca la red).
import { classifyItem } from './classifier.js';

export const HISTORY_MAX = 1000;
export const SEARCH_HISTORY_MAX = 100;
const MIN_SAVE_MS = 4000; // throttle de guardado de progreso por entrada

export class HistoryRepository {
  constructor(store, { log = () => {} } = {}) {
    this.store = store;
    this.log = log;
    this._lastSave = new Map(); // id -> timestamp del último guardado de progreso
    this._ensure();
  }

  _ensure() {
    const d = this.store.data;
    if (!Array.isArray(d.history)) d.history = [];
    if (!Array.isArray(d.searchHistory)) d.searchHistory = [];
    // Migración suave de entradas antiguas (id,title,url,at) al esquema nuevo.
    d.history = d.history.map((h) => (h && h.status && h.provider) ? h : this._migrateOld(h)).filter(Boolean);
    if (d.history.length > HISTORY_MAX) d.history.length = HISTORY_MAX;
  }

  _migrateOld(h) {
    if (!h || !h.id) return null;
    const id = String(h.id);
    const m = id.match(/^(?:ytdlp:)?(.+)$/);
    return {
      id: `ytdlp:${m ? m[1] : id}`,
      provider: 'ytdlp',
      sourceId: m ? m[1] : id,
      title: h.title || id,
      creator: h.channel || null,
      thumbnail: h.thumbnail || null,
      url: h.url || null,
      duration: h.duration || null,
      firstPlayedAt: h.at || new Date().toISOString(),
      lastPlayedAt: h.at || new Date().toISOString(),
      playCount: 1,
      positionMs: 0,
      status: 'started',
      classification: null,
      searchContext: null,
    };
  }

  _key(item) {
    const provider = item.provider || 'ytdlp';
    const sourceId = String(item.id || item.sourceId || '');
    return `${provider}:${sourceId}`;
  }

  /** Registra (o actualiza) el inicio de reproducción de un ítem: cada llamada = una reproducción más. */
  recordPlay(item, { context = null, classification = undefined } = {}) {
    if (!item || !item.id) return null;
    const d = this.store.data;
    const key = this._key(item);
    const now = new Date().toISOString();
    let e = d.history.find((h) => h.id === key);
    if (!e) {
      e = {
        id: key, provider: item.provider || 'ytdlp', sourceId: String(item.id),
        title: item.title || String(item.id), creator: item.channel || item.creator || null,
        thumbnail: item.thumbnail || null,
        url: item.url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : null),
        duration: item.duration ?? null,
        firstPlayedAt: now, lastPlayedAt: now, playCount: 1,
        positionMs: 0, status: 'started',
        classification: classification !== undefined ? classification : classifyItem(item),
        searchContext: context,
      };
      d.history.unshift(e);
    } else {
      // Conserva el registro y refresca metadatos; NO crea duplicado.
      // Cada inicio de reproducción suma 1 (updateProgress nunca toca esto).
      e.title = item.title || e.title;
      e.creator = item.channel || item.creator || e.creator;
      e.thumbnail = item.thumbnail || e.thumbnail;
      if (item.url) e.url = item.url;
      if (item.duration) e.duration = item.duration;
      if (classification !== undefined) e.classification = classification;
      else if (!e.classification) e.classification = classifyItem(item);
      if (context) e.searchContext = context;
      e.lastPlayedAt = now;
      e.playCount = (e.playCount || 0) + 1;
    }
    e.status = 'started';
    e.positionMs = 0;
    if (d.history.length > HISTORY_MAX) d.history.length = HISTORY_MAX;
    this.store.save();
    return e;
  }

  /** Acepta tanto el id interno ("ytdlp:xxxx") como el sourceId ("xxxx"). */
  _keyOf(ref) {
    const r = String(ref || '');
    if (!r) return r;
    const d = this.store.data;
    if (Array.isArray(d.history) && d.history.some((h) => h.id === r)) return r;
    return this._key({ id: r });
  }

  /**
   * Actualiza el progreso de la entrada en curso (throttle interno) y deriva
   * el estado: partial (<95%) o finished (>=95%).
   */
  updateProgress(sourceId, positionMs, durationMs, { force = false } = {}) {
    if (!sourceId) return null;
    const d = this.store.data;
    const key = this._keyOf(sourceId);
    const e = d.history.find((h) => h.id === key);
    if (!e) return null;
    const now = Date.now();
    const last = this._lastSave.get(key) || 0;
    if (!force && now - last < MIN_SAVE_MS) return e; // throttle: no machacar el disco
    this._lastSave.set(key, now);
    e.positionMs = Math.max(0, Math.round(Number(positionMs) || 0));
    if (durationMs > 0) {
      e.status = (e.positionMs / durationMs) >= 0.95 ? 'finished' : 'partial';
    }
    e.lastPlayedAt = new Date().toISOString();
    this.store.save();
    return e;
  }

  markFinished(sourceId) { return this.updateProgress(sourceId, Number.MAX_SAFE_INTEGER / 2, 1, { force: true }); }

  get(ref) {
    return this.store.data.history.find((h) => h.id === this._keyOf(ref)) || null;
  }

  /**
   * Consulta paginada con filtros locales.
   * opts: { q, tab ('all'|'music'|'theme'|'pending'|'finished'), source, channel,
   *         period ('today'|'week'|'month'|'all'), sort ('recent'|'oldest'|'mostPlayed'),
   *         offset, limit }
   */
  query(opts = {}) {
    const o = opts || {};
    let rows = [...(this.store.data.history || [])];
    const q = String(o.q || '').trim().toLowerCase();
    if (q) {
      // Búsqueda 100% local: título, autor/canal, palabras del contexto y fuente.
      rows = rows.filter((h) => {
        const hay = [h.title, h.creator, h.searchContext, h.provider, h.sourceId]
          .filter(Boolean).join(' ').toLowerCase();
        return q.split(/\s+/).every((w) => hay.includes(w));
      });
    }
    const tab = o.tab || 'all';
    if (tab === 'music') rows = rows.filter((h) => h.classification === 'music');
    else if (tab === 'theme') rows = rows.filter((h) => h.classification === 'theme' || !h.classification);
    else if (tab === 'pending') rows = rows.filter((h) => h.status !== 'finished');
    else if (tab === 'finished') rows = rows.filter((h) => h.status === 'finished');
    if (o.source) rows = rows.filter((h) => h.provider === o.source);
    if (o.channel) {
      const c = String(o.channel).toLowerCase();
      rows = rows.filter((h) => (h.creator || '').toLowerCase().includes(c));
    }
    if (o.period && o.period !== 'all') {
      const now = Date.now();
      const span = { today: 86400000, week: 7 * 86400000, month: 30 * 86400000 }[o.period];
      if (span) rows = rows.filter((h) => now - new Date(h.lastPlayedAt).getTime() <= span);
    }
    const sort = o.sort || 'recent';
    if (sort === 'oldest') rows.sort((a, b) => new Date(a.lastPlayedAt) - new Date(b.lastPlayedAt));
    else if (sort === 'mostPlayed') rows.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    else rows.sort((a, b) => new Date(b.lastPlayedAt) - new Date(a.lastPlayedAt));
    const total = rows.length;
    const offset = Math.max(0, o.offset | 0);
    const limit = Math.max(1, Math.min(200, o.limit || 30));
    return { items: rows.slice(offset, offset + limit), total, offset, limit };
  }

  remove(ref) {
    const d = this.store.data;
    const key = this._keyOf(ref);
    const n = d.history.length;
    d.history = d.history.filter((h) => h.id !== key);
    this.store.save();
    return { removed: n - d.history.length };
  }

  /** Borra por periodo ('today'|'week'|'month'|'all'). */
  clear(period = 'all') {
    const d = this.store.data;
    if (period === 'all') {
      const n = d.history.length;
      d.history = [];
      this.store.save();
      return { removed: n };
    }
    const now = Date.now();
    const span = { today: 86400000, week: 7 * 86400000, month: 30 * 86400000 }[period];
    if (!span) throw new Error('periodo no soportado: ' + period);
    const before = d.history.length;
    d.history = d.history.filter((h) => now - new Date(h.lastPlayedAt).getTime() > span);
    this.store.save();
    return { removed: before - d.history.length };
  }

  /** Exporta el historial completo a un objeto JSON serializable (sin binarios). */
  exportJSON() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: 1,
      playHistory: this.store.data.history || [],
      searchHistory: this.store.data.searchHistory || [],
    }, null, 2);
  }

  // --- historial de búsquedas -------------------------------------------------
  /** Registra una búsqueda; si ya existe (misma consulta+filtros+modo), sube count. */
  recordSearch({ query, filters = {}, mode = 'temas' } = {}) {
    const q = String(query || '').trim();
    if (!q) return null;
    const d = this.store.data;
    const fKey = JSON.stringify(filters || {});
    let e = d.searchHistory.find((s) => s.query === q && s.filtersKey === fKey && s.mode === mode);
    const now = new Date().toISOString();
    if (e) {
      e.count = (e.count || 1) + 1;
      e.at = now;
    } else {
      e = { query: q, filtersKey: fKey, filters: filters || {}, mode, at: now, count: 1 };
      d.searchHistory.unshift(e);
    }
    // Las entradas duplicadas por consulta sola (sin importar filtros) se
    // fusionan en la vista, no como entradas independientes.
    if (d.searchHistory.length > SEARCH_HISTORY_MAX) d.searchHistory.length = SEARCH_HISTORY_MAX;
    this.store.save();
    return e;
  }

  listSearches(limit = 20) {
    return (this.store.data.searchHistory || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, Math.max(1, Math.min(100, limit | 0)));
  }

  removeSearch(query) {
    const d = this.store.data;
    const n = d.searchHistory.length;
    d.searchHistory = d.searchHistory.filter((s) => s.query !== query);
    this.store.save();
    return { removed: n - d.searchHistory.length };
  }
}
