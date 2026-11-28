// Prueba si la página de resultados de YouTube se puede leer directamente
// (mucho más rápido que yt-dlp cuando no hay verificación JS).
// Uso: node tools\probe-direct-search.mjs "consulta"
const q = process.argv[2] || 'ciudadan musica';
const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D';
const t0 = Date.now();
const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'Accept-Language': 'es-MX,es;q=0.9',
    'Accept': 'text/html,application/xhtml+xml',
  },
});
const html = await res.text();
const ms = Date.now() - t0;
console.log('HTTP', res.status, 'en', Math.round(ms / 100) / 10, 's,', html.length, 'bytes');
const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
console.log('ytInitialData:', m ? 'SI (' + m[1].length + ' bytes)' : 'NO');
if (m) {
  try {
    const data = JSON.parse(m[1]);
    const titles = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.videoRenderer && n.videoRenderer.title) titles.push({ t: n.videoRenderer.title.runs?.map((r) => r.text).join('') || '', id: n.videoRenderer.videoId });
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(data);
    console.log('videos encontrados:', titles.length);
    titles.slice(0, 5).forEach((v) => console.log('  -', v.t.slice(0, 70), '|', v.id));
  } catch (e) { console.log('no se pudo parsear:', e.message); }
}
