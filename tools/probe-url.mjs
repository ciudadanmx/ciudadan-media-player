// Prueba mínima: obtener URL directa con yt-dlp y comprobar Range (206) con fetch nativo de Node.
import { spawn } from 'node:child_process';

const VIDEO = process.argv[2] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const CLIENT = process.argv[3] || 'android';

function ytdlpJson(url, client) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', [
      '--no-warnings',
      '--extractor-args', `youtube:player_client=${client}`,
      '-f', 'b[ext=mp4][vcodec!=none][acodec!=none]/b[ext=mp4]/b',
      '-j', url,
    ], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      if (code === 0 && out.trim()) { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('JSON parse: ' + e.message + '\n' + out.slice(0, 500))); } }
      else reject(new Error('yt-dlp exit ' + code + ': ' + err.slice(-800)));
    });
  });
}

const info = await ytdlpJson(VIDEO, CLIENT);
const fmt = (info.formats || []).find(f => f.vcodec !== 'none' && f.acodec !== 'none') || info;
console.log('format_id:', fmt.format_id, 'ext:', fmt.ext, 'res:', fmt.resolution, 'dur:', fmt.duration);
console.log('headers:', JSON.stringify(fmt.http_headers));

// 1) HEAD con Range para verificar 206
const h = { ...fmt.http_headers, Range: 'bytes=0-1023' };
const res = await fetch(fmt.url, { method: 'HEAD', headers: h });
console.log('HEAD+Range status:', res.status, 'content-type:', res.headers.get('content-type'),
  'content-range:', res.headers.get('content-range'), 'accept-ranges:', res.headers.get('accept-ranges'),
  'content-length:', res.headers.get('content-length'));

// 2) GET parcial real (1 MB) para verificar que descarga bytes
const res2 = await fetch(fmt.url, { headers: { ...fmt.http_headers, Range: 'bytes=0-1048575' } });
const buf = Buffer.from(await res2.arrayBuffer());
console.log('GET range status:', res2.status, 'bytes recibidos:', buf.length,
  'firma MP4 (ftyp en offset 4):', buf.slice(4, 8).toString('latin1'));
