// DiscoveryService — obtiene CANDIDATOS para la continuidad (hasta 3 por lote)
// usando EXCLUSIVAMENTE metadatos (yt-dlp --flat-playlist / búsqueda ligera):
// no abre reproductores ni descarga vídeos.
//
// Fuentes:
//   'search'    -> la búsqueda activa (query actual)
//   'channel'   -> vídeos del canal/creador del contenido actual
//   'topic'     -> consultas derivadas del título/metadatos del contenido actual
//                  (nunca relatedToVideoId, obsoleto)
//   'discover'  -> combinación: canal + temas afines con variedad
import { classifyItem } from './classifier.js';

const STOPWORDS = new Set(('el la los las un una y o de del al a en con por para sin sobre entre como es son fue ser estar ' +
  'que se su sus mi mis tu tus este esta estos estas eso esa video oficial oficiosa de del tema').split(' '));

// Palabras que no aportan tema (se quitan de las consultas derivadas).
const NOISE = /\b(official|video|audio|lyric|lyrics|hd|4k|mv|videoclip|videoclipping|topic|vevo)\b/gi;

export function topicQueriesFrom(item, max = 3) {
  const title = String((item && item.title) || '').replace(NOISE, ' ');
  const words = title
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  // Frecuencia para quitar duplicados conservando orden.
  const seen = new Set();
  const uniq = [];
  for (const w of words) if (!seen.has(w)) { seen.add(w); uniq.push(w); }
  const queries = [];
  if (uniq.length >= 2) queries.push(uniq.slice(0, 3).join(' '));
  if (uniq.length >= 4) queries.push(uniq.slice(2, 5).join(' '));
  if (item && item.channel) queries.push(String(item.channel).trim());
  return queries.filter((q) => q && q.length >= 4).slice(0, max);
}

// Categorías de YouTube (en inglés) traducidas para poder buscar por tema.
const CATEGORY_ES = {
  music: 'música', entertainment: 'entretenimiento', education: 'educación',
  documentary: 'documental', film: 'película', animation: 'animación',
  people: 'personas', sports: 'deportes', gaming: 'videojuegos', news: 'noticias',
  travel: 'viajes', howto: 'tutorial', science: 'ciencia', comedy: 'comedia',
  musicvideo: 'música', filmanimation: 'película',
};

/**
 * Consultas de "relacionados" derivadas de los METADATOS del vídeo actual.
 * Se usan cuando no hay una búsqueda activa (p. ej. el usuario pegó una URL
 * directa): sin esto, la continuidad se quedaba sin candidatos y no continuaba.
 */
export function relatedQueriesFrom(current, searchQuery = '', max = 4) {
  const out = [];
  const add = (q) => {
    const s = String(q || '').trim();
    if (s && s.length >= 3 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  if (searchQuery) add(searchQuery);
  for (const q of topicQueriesFrom(current, 3)) add(q);
  if (current && current.title) {
    // Título sin el sufijo comercial habitual (" - Oficial", "| 4K", …).
    const t = String(current.title).replace(/\s*[-–|]\s*.*$/, '').trim();
    if (t.length >= 4) add(t);
  }
  if (current && current.category) {
    const c = String(current.category).toLowerCase().trim();
    if (c) add(CATEGORY_ES[c] || c);
  }
  return out.slice(0, Math.max(1, max));
}

export class DiscoveryService {
  /**
   * @param {object} deps
   * @param {(query:string, opts:object)=>Promise<{items:Array}>} deps.search  búsqueda ligera del proveedor
   * @param {(url:string, opts:object)=>Promise<{items:Array}>} deps.fetchFlat  lista plana de una URL (canal)
   * @param {Function} deps.log
   */
  constructor({ search, fetchFlat = null, log = () => {} } = {}) {
    if (!search) throw new Error('DiscoveryService necesita search()');
    this.search = search;
    this.fetchFlat = fetchFlat;
    this.log = log;
  }

  /**
   * Devuelve candidatos normalizados y clasificados (máx. limit).
   * Nunca lanza: un error de búsqueda no debe detener el reproductor.
   */
  async candidatesFor({ source = 'search', current = null, searchQuery = '', limit = 10, signal = null, excludeIds = [], maxQueries = 3, budgetMs = 45000 } = {}) {
    const norm = (v) => String(v || '').trim().toLowerCase();
    const exclude = new Set(excludeIds.filter(Boolean).map(norm));
    if (current && current.id) exclude.add(norm(current.id));
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const id = String((item && (item.id || item.videoId)) || '').trim();
      if (!id || seen.has(id) || exclude.has(norm(id))) return;
      seen.add(id);
      out.push({ ...item, id, classification: item.classification || classifyItem(item) });
    };

    // PRESUPUESTO DE TIEMPO: las búsquedas a YouTube tardan 30-120 s cuando la
    // red va mal. En serie, 3-4 consultas sumaban varios minutos y el usuario
    // se quedaba sin reproducción; ahora se lanzan EN PARALELO y con un
    // presupuesto global (por defecto 45 s) del que se sale con los
    // candidatos parciales.
    const deadline = Date.now() + Math.max(5000, budgetMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, Math.max(5000, budgetMs));
    const sig = signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal) : ctrl.signal;

    const run = async (fn, ...args) => {
      try { return await fn(...args); }
      catch (e) {
        if (sig && sig.aborted) return null;
        this.log('discovery: error tolerado en', source, String((e && e.message) || e));
        return null;
      }
    };
    // Búsquedas en paralelo: se recogen en el orden de las consultas.
    const buscar = async (queries, lim) => {
      const rs = await Promise.all(queries.map(async (q) => {
        if (Date.now() > deadline) return null;
        return run(this.search, q, { limit: lim, offset: 0, cancelPrevious: false, signal: sig });
      }));
      for (const r of rs) for (const it of (r && r.items) || []) push(it);
    };

    try {
      if (source === 'search') {
        // La búsqueda activa es la primera opción; si no hay (el usuario pegó una
        // URL directa) o si no devuelve nada, se buscan vídeos RELACIONADOS por
        // metadatos (tema del título, canal, categoría).
        const queries = [];
        if (searchQuery) queries.push(String(searchQuery));
        for (const q of relatedQueriesFrom(current, '', 3)) queries.push(q);
        await buscar(queries.slice(0, Math.max(1, maxQueries)), Math.max(limit, 10));
      } else if (source === 'channel' && current) {
        const chUrl = current.channelUrl || (current.channelId ? `https://www.youtube.com/channel/${current.channelId}/videos` : null)
          || (current.uploaderId ? `https://www.youtube.com/@${current.uploaderId}` : null);
        if (chUrl && this.fetchFlat) {
          const r = await run(this.fetchFlat, chUrl, { limit: Math.max(limit, 10), signal: sig });
          for (const it of (r && r.items) || []) push(it);
        }
        // Si el canal no dio candidatos (o no hay fetchFlat), caer a tema.
        if (!out.length) {
          await buscar(relatedQueriesFrom(current, '', 3), 6);
        }
      } else if (source === 'topic') {
        await buscar(relatedQueriesFrom(current, '', 4), 6);
      } else if (source === 'discover') {
        // Variedad: mitad del canal actual, mitad de temas afines.
        if (current && this.fetchFlat) {
          const chUrl = current.channelUrl || (current.channelId ? `https://www.youtube.com/channel/${current.channelId}/videos` : null);
          if (chUrl) {
            const r = await run(this.fetchFlat, chUrl, { limit: Math.ceil(limit / 2), signal: sig });
            for (const it of (r && r.items) || []) push(it);
          }
        }
        const queries = current ? relatedQueriesFrom(current, '', 2) : (searchQuery ? [searchQuery] : []);
        await buscar(queries, 6);
        if (!out.length && searchQuery) {
          const r = await run(this.search, searchQuery, { limit, offset: 0, cancelPrevious: false, signal: sig });
          for (const it of (r && r.items) || []) push(it);
        }
      }
      if (!out.length && source !== 'search' && searchQuery) {
        // Último recurso: la búsqueda activa.
        const r = await run(this.search, searchQuery, { limit, offset: 0, cancelPrevious: false, signal: sig });
        for (const it of (r && r.items) || []) push(it);
      }
    } finally {
      clearTimeout(timer);
      try { ctrl.abort(); } catch {}
    }
    return out.slice(0, limit);
  }
}
