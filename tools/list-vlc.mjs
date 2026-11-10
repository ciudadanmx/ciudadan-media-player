for (const base of ['https://get.videolan.org/vlc/3.0.23/win64/', 'https://get.videolan.org/vlc/last/win64/']) {
  try {
    const r = await fetch(base, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const t = await r.text();
    const links = [...t.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(x => /win64.*\.(zip|7z|exe)$/i.test(x));
    console.log(base, r.status, links.slice(0, 12));
  } catch (e) { console.log(base, 'ERR', e.message); }
}
