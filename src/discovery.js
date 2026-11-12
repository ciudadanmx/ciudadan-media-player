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
  async candidatesFor({ source = 'search', current = null, searchQuery = '', limit = 10, signal = null, excludeIds = [] } = {}) {
    const exclude = new Set(excludeIds.filter(Boolean));
    if (current && current.id) exclude.add(String(current.id));
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const id = String(item && item.id || '');
      if (!id || seen.has(id) || exclude.has(id)) return;
      seen.add(id);
      out.push({ ...item, id, classification: item.classification || classifyItem(item) });
    };

    const run = async (fn, ...args) => {
      try { return await fn(...args); }
      catch (e) {
        if (signal && signal.aborted) return null;
        this.log('discovery: error tolerado en', source, String((e && e.message) || e));
        return null;
      }
    };

    if (source === 'search') {
      // La búsqueda activa es la primera opción; si no hay (el usuario pegó una
      // URL directa) o si no devuelve nada, se buscan vídeos RELACIONADOS por
      // metadatos (tema del título, canal, categoría).
      const queries = [];
      if (searchQuery) queries.push(String(searchQuery));
      for (const q of relatedQueriesFrom(current, '', 3)) queries.push(q);
      for (const q of queries) {
        const r = await run(this.search, q, { limit: Math.max(limit, 10), offset: 0, cancelPrevious: false, signal });
        for (const it of (r && r.items) || []) push(it);
        if (out.length >= limit) break;
      }
    } else if (source === 'channel' && current) {
      const chUrl = current.channelUrl || (current.channelId ? `https://www.youtube.com/channel/${current.channelId}/videos` : null)
        || (current.uploaderId ? `https://www.youtube.com/@${current.uploaderId}` : null);
      if (chUrl && this.fetchFlat) {
        const r = await run(this.fetchFlat, chUrl, { limit: Math.max(limit, 10), signal });
        for (const it of (r && r.items) || []) push(it);
      }
      // Si el canal no dio candidatos (o no hay fetchFlat), caer a tema.
      if (!out.length) {
        for (const q of relatedQueriesFrom(current, '', 3)) {
          const r = await run(this.search, q, { limit: 6, offset: 0, cancelPrevious: false, signal });
          for (const it of (r && r.items) || []) push(it);
          if (out.length >= limit) break;
        }
      }
    } else if (source === 'topic') {
      for (const q of relatedQueriesFrom(current, '', 4)) {
        const r = await run(this.search, q, { limit: 6, offset: 0, cancelPrevious: false, signal });
        for (const it of (r && r.items) || []) push(it);
        if (out.length >= limit) break;
      }
    } else if (source === 'discover') {
      // Variedad: mitad del canal actual, mitad de temas afines.
      if (current && this.fetchFlat) {
        const chUrl = current.channelUrl || (current.channelId ? `https://www.youtube.com/channel/${current.channelId}/videos` : null);
        if (chUrl) {
          const r = await run(this.fetchFlat, chUrl, { limit: Math.ceil(limit / 2), signal });
          for (const it of (r && r.items) || []) push(it);
        }
      }
      const queries = current ? relatedQueriesFrom(current, '', 2) : (searchQuery ? [searchQuery] : []);
      for (const q of queries) {
        const r = await run(this.search, q, { limit: 6, offset: 0, cancelPrevious: false, signal });
        for (const it of (r && r.items) || []) push(it);
        if (out.length >= limit) break;
      }
      if (!out.length && searchQuery) {
        const r = await run(this.search, searchQuery, { limit, offset: 0, cancelPrevious: false, signal });
        for (const it of (r && r.items) || []) push(it);
      }
    }
    if (!out.length && source !== 'search' && searchQuery) {
      // Último recurso: la búsqueda activa.
      const r = await run(this.search, searchQuery, { limit, offset: 0, cancelPrevious: false, signal });
      for (const it of (r && r.items) || []) push(it);
    }
    return out.slice(0, limit);
  }
}
