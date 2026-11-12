// Subtítulos: selección y descarga de pistas usando los metadatos que ya trae
// yt-dlp (subtitles / automatic_captions). Descarga ASÍNCRONA con timeout corto:
// nunca retrasa ni interrumpe la reproducción (si falla, el vídeo sigue sin CC).
//
// Nota sobre el reproductor: usamos libVLC (no la IFrame API), así que SÍ hay
// control real de pistas (libvlc_video_get_spu*/set_spu). Las opciones
// cc_load_policy=1 / cc_lang_pref=es son parámetros de la IFrame API de YouTube
// y no aplican aquí; el equivalente real es elegir la pista preferida (es) al
// descargar el .vtt y engancharla con la opción de medio ":input-slave=file:///..."
// (con streams HTTP "sub-file=" NO engancha; verificado con sonda).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SUB_LANGS = ['es', 'es-419', 'es-419', 'en'];

/**
 * Elige la mejor pista disponible según el idioma preferido.
 * @param {Array<{lang:string, url:string, ext:string, kind?:string}>} tracks
 */
export function pickTrack(tracks, prefLangs = DEFAULT_SUB_LANGS) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const withUrl = tracks.filter((t) => t && t.url);
  if (!withUrl.length) return null;
  const norm = (l) => String(l || '').toLowerCase().replace('_', '-');
  for (const pref of prefLangs) {
    const p = norm(pref);
    const exact = withUrl.find((t) => norm(t.lang) === p);
    if (exact) return bestFormat(exact, withUrl.filter((t) => norm(t.lang) === p));
    const prefix = withUrl.find((t) => norm(t.lang).startsWith(p + '-') || p.startsWith(norm(t.lang) + '-'));
    if (prefix) return bestFormat(prefix, withUrl.filter((t) => norm(t.lang).startsWith(p)));
  }
  // Sin preferencia disponible: la primera pista con URL.
  return bestFormat(withUrl[0], withUrl);
}

// Prefiere vtt (VLC lo lee nativamente); si no, srv3/srv1 (XML) también sirve.
function bestFormat(track, sameLang) {
  const pool = sameLang && sameLang.length ? sameLang : [track];
  const vtt = pool.find((t) => String(t.ext || '').toLowerCase() === 'vtt');
  return vtt || pool[0];
}

/** Extrae las pistas de subtítulos del JSON completo de yt-dlp. */
export function subtitleTracksFromInfo(j) {
  const out = [];
  const push = (map, kind) => {
    if (!map || typeof map !== 'object') return;
    for (const [lang, list] of Object.entries(map)) {
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        if (t && t.url) out.push({ lang, url: t.url, ext: t.ext || '', kind });
      }
    }
  };
  push(j && j.subtitles, 'subtitles');            // pistas manuales (mejor calidad)
  push(j && j.automatic_captions, 'captions');     // automáticas
  return out;
}

/**
 * Descarga una pista a un .vtt local (añade &fmt=vtt si la URL lo permite).
 * Devuelve la ruta del fichero o null si falla (nunca lanza).
 */
export async function downloadSubtitle(track, destDir, { timeoutMs = 4000 } = {}) {
  if (!track || !track.url) return null;
  try {
    await fsp.mkdir(destDir, { recursive: true });
    const ac = new AbortController();
    const killer = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
    try {
      let url = track.url;
      if (!/[?&]fmt=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'fmt=vtt';
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || text.length < 20) return null;
      const name = String(track.lang || 'sub').replace(/[^a-z0-9-]/gi, '_') + '.vtt';
      const file = path.join(destDir, name);
      await fsp.writeFile(file, text, 'utf8');
      // "Calentar" el fichero recién creado: el antivirus lo escanea en el
      // primer acceso y, si libVLC lo abre antes de terminar el escaneo, el
      // slave de subtítulos no engancha (spu count = 0). Leyéndolo aquí
      // (async) el escaneo queda fuera de la ruta crítica del play.
      try { await fsp.readFile(file); } catch {}
      return file;
    } finally { clearTimeout(killer); }
  } catch {
    return null; // timeout o error de red: sin subtítulos, la reproducción sigue
  }
}

/** Limpia ficheros de subtítulos antiguos (best-effort, asíncrono). */
export async function cleanupSubtitles(destDir, maxAgeMs = 6 * 3600 * 1000) {
  try {
    const entries = await fsp.readdir(destDir);
    const now = Date.now();
    await Promise.all(entries.map(async (f) => {
      try {
        const st = await fsp.stat(path.join(destDir, f));
        if (now - st.mtimeMs > maxAgeMs) await fsp.rm(path.join(destDir, f), { force: true });
      } catch {}
    }));
  } catch {}
}

export function subsDir(tmpBase) { return path.join(tmpBase, 'subs'); }
export { fs };
