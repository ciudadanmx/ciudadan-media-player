// Descarga VLC portable win64 (zip oficial) a .vlc64/ following meta-refresh mirrors, y extrae con Python.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VER = process.argv[2] || '3.0.23';
const rel = `vlc-${VER}-win64.zip`;
const destDir = path.resolve('.vlc64');
const zipPath = path.join(destDir, rel);
const dllPath = path.join(destDir, 'vlc', 'libvlc.dll');
fs.mkdirSync(destDir, { recursive: true });

async function resolveReal(url) {
  // get.videolan.org sirve una página HTML con meta refresh al mirror real
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    if (res.status === 200 && ct.includes('html')) {
      const t = await res.text();
      const m = t.match(/URL='([^']+)'/i) || t.match(/href="([^"]+\.zip)"/i);
      if (m) { url = new URL(m[1], url).href; console.log('  meta-refresh ->', url); continue; }
      throw new Error('HTML sin enlace de descarga');
    }
    if (res.status === 200) return res;
    throw new Error('HTTP ' + res.status + ' en ' + url);
  }
  throw new Error(' demasiados saltos');
}

if (!fs.existsSync(dllPath)) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const res = await resolveReal(`https://get.videolan.org/vlc/${VER}/win64/${rel}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 2).toString('latin1') !== 'PK') throw new Error('no es ZIP: ' + buf.slice(0, 80).toString('latin1'));
  fs.writeFileSync(zipPath, buf);
  console.log('Descargado OK:', (buf.length / 1048576).toFixed(1), 'MB ->', zipPath);
  console.log('Extrayendo...');
  execFileSync('python', ['-m', 'zipfile', '-e', zipPath, destDir], { stdio: 'inherit' });
}
console.log('libvlc.dll 64-bit:', dllPath, fs.existsSync(dllPath) ? 'OK' : 'FALTA');
console.log('plugins:', fs.existsSync(path.join(destDir, 'vlc', 'plugins')) ? 'OK' : 'FALTA');
