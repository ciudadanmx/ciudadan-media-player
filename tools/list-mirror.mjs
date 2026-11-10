for (const base of [
  'https://ftp.nluug.nl/pub/videolan/vlc/3.0.23/win64/',
  'https://mirror.clarkson.edu/vlc/3.0.23/win64/',
  'https://get.videolan.org/vlc/3.0.23/win64/',
]) {
  try {
    const r = await fetch(base, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const t = await r.text();
    const links = [...t.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(x => /\.(zip|7z|exe)$/i.test(x) && !/debugsym/i.test(x));
    console.log(base, r.status, JSON.stringify(links));
  } catch (e) { console.log(base, 'ERR', e.message); }
}
