const VER = '3.0.23';
const rel = `vlc-${VER}-win64.zip`;
const mirrors = [
  'https://mirror.clarkson.edu/vlc',
  'https://ftp.nluug.nl/pub/videolan/vlc',
  'https://mirrors.ocf.berkeley.edu/vlc',
  'https://ftp.fau.de/vlc',
  'https://mirrors.mit.edu/vlc',
  'https://mirror.umd.edu/vlc',
  'https://mirrorservice.org/sites/download.videolan.org/vlc',
];
for (const m of mirrors) {
  const url = `${m}/${VER}/win64/${rel}`;
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    console.log(r.status, r.headers.get('content-type'), r.headers.get('content-length'), url);
  } catch (e) { console.log('ERR', e.message, url); }
}
