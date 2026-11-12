// Sonda aislada: ¿añade ":sub-file=..." una pista SPU en libVLC 3.0?
// Descarga un mp4 pequeño + su pista .vtt con yt-dlp y reproduce en libVLC
// con vout dummy, leyendo libvlc_video_get_spu_count / get_spu_description.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/paths.js';
import { VlcPlayer } from '../src/vlc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.tmp', 'probe-spu');
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const out = path.join(DIR, 'out.json');
    try { fs.unlinkSync(out); } catch {}
    const child = spawn(TOOLS.ytdlp, [
      '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:player_client=android',
      ...args, '-o', path.join(DIR, '%(id)s.%(ext)s'), '--paths', DIR, VIDEO,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('yt-dlp exit=' + code + ' ' + err.slice(-300))));
  });
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const have = fs.existsSync(path.join(DIR, 'jNQXAC9IVRw.mp4')) && fs.existsSync(path.join(DIR, 'jNQXAC9IVRw.en.vtt'));
  if (!have) {
    console.log('descargando vídeo + subtítulos de prueba...');
    await runYtdlp(['-f', '18/best[height<=360]', '--write-subs', '--sub-langs', 'en', '--sub-format', 'vtt', '--skip-download', '--write-info-json']);
    await runYtdlp(['-f', '18', '--no-write-info-json']);
  }
  const files = fs.readdirSync(DIR);
  const mp4 = files.find((f) => f.endsWith('.mp4'));
  const vtt = files.find((f) => f.endsWith('.vtt'));
  console.log('archivos:', files.join(', '));
  if (!mp4 || !vtt) { console.log('FALTA mp4 o vtt'); process.exit(1); }

  const mp4Path = path.join(DIR, mp4);
  const vttPath = process.argv[5] ? path.resolve(process.argv[5]) : path.join(DIR, vtt);
  const which = Number(process.argv[2] || 0);
  const variants = [
    [':sub-file=' + vttPath],
    [':sub-file=' + vttPath.split('\\').join('/')],
    [':sub-file=file:///' + vttPath.split('\\').join('/')],
    [], // sin opción: autodetección de .vtt junto al vídeo (línea base)
    [':input-slave=file:///' + vttPath.split('\\').join('/')],
    [':input-slave=' + vttPath.split('\\').join('/')],
    [':network-caching=1200', ':input-slave=file:///' + vttPath.split('\\').join('/')],
  ];
  const opts = variants[which] || [];
  console.log(`== variante ${which}: mediaOptions=${JSON.stringify(opts)}`);
  const vlc = await VlcPlayer.create({ dummyOutput: process.argv[4] !== 'real' });
  try {
    let mrl = 'file:///' + mp4Path.split('\\').join('/');
    if (process.argv[3] === 'proxy') {
      // URL real del proxy de la app en ejecución (pasada como 4º argumento)
      mrl = process.argv[4];
      console.log('mrl proxy:', mrl);
    } else if (process.argv[3] === 'http') {
      // servidor HTTP local que sirve el mp4 (igual que el proxy de la app)
      const http = await import('node:http');
      const srv = http.createServer((req, res) => {
        const st = fs.statSync(mp4Path);
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = Math.min(Number(m[1]), st.size - 1);
          const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
          if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
          fs.createReadStream(mp4Path, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' });
          fs.createReadStream(mp4Path).pipe(res);
        }
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      mrl = `http://127.0.0.1:${port}/stream?id=probe123`;
      console.log('mrl http:', mrl);
    }
    await vlc.play(mrl, { mediaOptions: opts });
    for (const wait of [3000, 4000, 5000, 8000, 10000]) {
      await sleep(wait);
      try {
        const rawCount = await vlc._enqueue(async () => await vlc._call(vlc.api.libvlc_video_get_spu_count, vlc.player));
        const tracks = await vlc.getSubtitleTracks();
        const st = await vlc.getState();
        console.log(`state=${st} rawCount=${rawCount} tracks=${JSON.stringify(tracks)}`);
        if (tracks.length) {
          await vlc.setSubtitleTrack(tracks[0].id);
          await sleep(500);
          console.log('set_spu ->', await vlc.getSubtitleTrack());
          break;
        }
      } catch (e) { console.log('err lectura spu:', String(e.message || e)); }
    }
  } catch (e) { console.log('err play:', String(e.message || e)); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
