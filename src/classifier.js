// ContentClassifier — clasificación ligera Música/Temas usando SOLO metadatos
// (título, canal, categoría de YouTube, contexto de lista) y reglas
// configurables. Sin IA y sin red: es determinista y reutilizable por búsqueda,
// cola, continuidad e historial.
//
// Devuelve: 'music' | 'theme' | null (no determinado).
export const CLASS_MUSIC = 'music';
export const CLASS_THEME = 'theme';

// Reglas sobre el título/canal. Ordenadas de más a menos fiable.
const MUSIC_TITLE = [
  /official\s+(music\s+)?video/i, /official\s+audio/i, /\bmusic\s+video\b/i,
  /\blyric(s)?\s+video\b/i, /\b(lyrics?|letra)\b/i,
  /\b(remix|cover|version|acústic|acoustic)\b/i,
  /\balbum\b/i, /\b(greatest hits|recopilatorio|colecci[oó]n)\b/i,
  /\b(live|en vivo|concierto)\b.*(session|sessions|concert|tour|fest)/i,
  /\b(sesión|session)\b.*(acústic|acustic|unplugged|en vivo|live)/i,
  /\bconcierto\b/i, /\bfestival\b/i, /\bvevo\b/i, /\btopic\b/i,
  /\b(música|musica)\b/i, /\b(single|ep|mixtape)\b/i,
  /\bvs\.?\b|\bbattle\b/i,
];
const THEME_TITLE = [
  /\b(documental|documentary)\b/i, /\b(entrevista|interview|podcast)\b/i,
  /\b(tutorial|c[oó]mo hacer|how to)\b/i, /\b(review|reseña|análisis|analisis)\b/i,
  /\b(noticias|news)\b/i, /\b(explicado|explicaci[oó]n|por qu[eé])\b/i,
  /\b(ciencia|science|tecnolog[ií]a|tech|historia|history)\b/i,
  /\b(vlog|unboxing|gameplay|walkthrough)\b/i, /\b(debate|mesa redonda)\b/i,
  /\b(análisis de|analisis de|reportaje)\b/i,
];
// Categorías de YouTube que casi siempre son música.
const MUSIC_CATEGORIES = new Set(['music']);
// ...y categorías claramente temáticas.
const THEME_CATEGORIES = new Set([
  'education', 'science & technology', 'news & politics', 'people & blogs',
  'howto & style', 'film & animation', 'gaming', 'sports', 'travel & events',
  'nonprofits & activism', 'autos & vehicles', 'pets & animals', 'comedy',
]);

export function classifyItem(item, rules = {}) {
  const it = item || {};
  const title = String(it.title || '');
  const channel = String(it.channel || it.uploader || it.creator || '');
  const category = String(it.category || '').trim().toLowerCase();
  const plTitle = String(it.playlistTitle || '');
  const musicRes = rules.musicTitle || MUSIC_TITLE;
  const themeRes = rules.themeTitle || THEME_TITLE;

  if (category && MUSIC_CATEGORIES.has(category)) return CLASS_MUSIC;
  if (category && THEME_CATEGORIES.has(category)) {
    // La categoría temática gana salvo que el título diga claramente música.
    for (const re of musicRes) if (re.test(title)) return CLASS_MUSIC;
    return CLASS_THEME;
  }
  for (const re of musicRes) if (re.test(title)) return CLASS_MUSIC;
  // Señales de canal (sin frontera de palabra: "CanalVEVO", "- Topic"…).
  if (/vevo|topic|official|records\b/i.test(channel)) return CLASS_MUSIC;
  for (const re of themeRes) if (re.test(title)) return CLASS_THEME;
  if (/\b(album|greatest hits|best of|discografía|discografia)\b/i.test(plTitle)) return CLASS_MUSIC;
  // Duración muy corta y sin señal: probablemente un clip/short temático o musical;
  // se deja sin determinar (null) para no forzar.
  return null;
}

export function classifyAll(items, rules) {
  return (items || []).map((it) => ({ ...it, classification: it.classification || classifyItem(it, rules) }));
}
