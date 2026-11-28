// Búsqueda RÁPIDA en la página de resultados de YouTube (una sola petición
// HTTP y se lee el `ytInitialData` embebido).
//
// Por qué existe: con yt-dlp, cuando YouTube aplica su anti-bot, la búsqueda
// tarda 30-90 s (o se queda colgada) y el usuario ve "Buscando..." sin
// resultados. Leyendo la página directamente la misma consulta tarda ~2 s.
// Si esta vía falla (cambia el HTML, bloquea la IP...), el proveedor vuelve al
// camino de yt-dlp, que sigue siendo el respaldo.
import { SP } from './sp-codes.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function buildResultsUrl(query, filters = {}) {
  const f = filters || {};
  const sp = [];
  if (f.type && f.type !== 'any' && SP.type[f.type]) sp.push(SP.type[f.type]);
  if (f.sort && f.sort !== 'relevance' && SP.sort[f.sort]) sp.push(SP.sort[f.sort]);
  if (f.date && f.date !== 'any' && SP.date[f.date]) sp.push(SP.date[f.date]);
  if (f.duration && f.duration !== 'any' && SP.duration[f.duration]) sp.push(SP.duration[f.duration]);
  for (const feat of (f.features || [])) if (SP.features[feat]) sp.push(SP.features[feat]);
  let url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
  if (sp.length) url += '&sp=' + encodeURIComponent(sp.join(''));
  return url;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  return '';
}

function parseDuration(txt) {
  const s = String(txt || '').trim();
  if (!s) return 0;
  const parts = s.split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function parseViews(txt) {
  const s = String(txt || '').trim();
  const m = s.match(/([\d.,]+)\s*(K|M|B|millones|millón)?/i);
  if (!m) return undefined;
  let n = parseInt(m[1].replace(/[.,]/g, ''), 10);
  if (!Number.isFinite(n)) return undefined;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1000;
  else if (suf === 'm' || suf === 'millón' || suf === 'millones') n *= 1000000;
  else if (suf === 'b') n *= 1000000000;
  return n;
}

/** Extrae los vídeos del `ytInitialData` de la página de resultados. */
export function parseInitialData(html) {
  const m = String(html || '').match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/)
    || String(html || '').match(/ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('la página no trae ytInitialData');
  const data = JSON.parse(m[1]);
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    const vr = n.videoRenderer;
    if (vr && vr.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const title = textOf(vr.title);
      const channel = textOf(vr.ownerText) || textOf(vr.longBylineText);
      const duration = parseDuration(textOf(vr.lengthText));
      const views = parseViews(textOf(vr.viewCountText));
      const thumbs = (vr.thumbnail && Array.isArray(vr.thumbnail.thumbnails))
        ? vr.thumbnail.thumbnails.filter((t) => t && t.url).map((t) => ({ url: t.url, width: t.width || 0, height: t.height || 0 }))
        : [];
      const badges = (Array.isArray(vr.badges) ? vr.badges : []).map((b) => textOf(b.metadataBadgeRenderer)).join(' ');
      const item = {
        id: vr.videoId,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        title: title || null,
        provider: 'ytdlp',
        type: 'video',
      };
      if (channel) { item.channel = channel; }
      if (duration > 0) item.duration = duration;
      if (typeof views === 'number') item.viewCount = views;
      const pub = textOf(vr.publishedTimeText);
      if (pub) item.publishedText = pub;
      if (thumbs.length) { item.thumbnail = thumbs[thumbs.length - 1].url; item.thumbnails = thumbs; }
      if (/\bCC\b|Captions/i.test(badges)) item.hasCaptions = true;
      if (vr.badgesMetadataRenderer && /\bCC\b/i.test(badges)) item.hasCaptions = true;
      out.push(item);
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(data);
  return out;
}

/** Devuelve los resultados por la vía rápida; null si esta vía no sirve. */
export async function searchDirect(query, { limit = 20, offset = 0, filters = {}, signal = null, timeoutMs = 15000 } = {}) {
  const url = buildResultsUrl(query, filters);
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  const onAbort = () => { try { ctrl.abort(); } catch {} };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const items = parseInitialData(html);
    if (!items.length) return null;
    return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit, source: 'web-direct' };
  } catch {
    return null;   // esta vía falló: el proveedor usa el respaldo (yt-dlp)
  } finally {
    clearTimeout(timer);
  }
}
