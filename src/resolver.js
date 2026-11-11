// Resuelve un video de YouTube a una URL de stream directa usando yt-dlp.
// IMPORTANTE (sandbox DSH): los named pipes están bloqueados (spawn con stdio pipe => EPERM),
// por eso yt-dlp escribe su JSON a un FD de archivo real en %TEMP% y se lee después.
// Esto funciona igual dentro y fuera del sandbox.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { YT_CLIENTS, TOOLS } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Temporal propio del proyecto: dentro de Electron el sandbox DSH impide crear
// carpetas en %TEMP% (EPERM en fs.mkdtempSync).
const TMP_BASE = process.env.CMP_TMPDIR || path.join(ROOT, '.tmp');
try { fs.mkdirSync(TMP_BASE, { recursive: true }); } catch {}

const FORMAT_SELECTOR =
  'b[ext=mp4][vcodec!=none][acodec!=none][height<=720]/' +
  'b[ext=mp4][vcodec!=none][acodec!=none]/' +
  'b[protocol=m3u8_native][vcodec!=none]/' +
  'b[protocol^=m3u8]/b';

function runYtdlpJson(videoUrl, client, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(fs.mkdtempSync(path.join(TMP_BASE, 'cmp-')), 'info.json');
    const outFd = fs.openSync(tmp, 'w');
    const errFd = fs.openSync(tmp + '.err', 'w');
    const args = [
      '--no-warnings', '--no-playlist',
      '--extractor-args', `youtube:player_client=${client}`,
      '-f', FORMAT_SELECTOR,
      '-j', videoUrl,
    ];
    let child;
    try {
      child = spawn(TOOLS.ytdlp, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
    } catch (e) {
      fs.closeSync(outFd); fs.closeSync(errFd);
      return reject(e);
    }
    const killer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`yt-dlp timeout (${client})`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', async (code) => {
      clearTimeout(killer);
      fs.closeSync(outFd); fs.closeSync(errFd);
      // La lectura del JSON es ASÍNCRONA: el fichero es recién creado y el
      // antivirus lo analiza en el primer acceso; con readFileSync ese análisis
      // bloquea el hilo principal de Electron (la app se quedaba "congelada"
      // durante la carga). Con fs/promises el análisis ocurre en el hilo del
      // pool y la interfaz sigue respondiendo.
      try {
        const out = await fsp.readFile(tmp, 'utf8');
        const err = await fsp.readFile(tmp + '.err', 'utf8').catch(() => '');
        await fsp.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
        if (code !== 0 || !out.trim()) {
          const msg = (err || '').trim().split('\n').slice(-3).join(' | ');
          return reject(new Error(`yt-dlp[${client}] exit=${code}: ${msg}`));
        }
        resolve(JSON.parse(out));
      } catch (e) { reject(e); }
    });
  });
}

export function videoIdOf(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || url;
  } catch { return url; }
}

// Devuelve { id, mode, url, headers, title, duration, formatId, client, resolution }
// mode: 'range' (mp4 progresivo vía proxy con Range => seek) | 'hls' (m3u8) | 'pipe' (yt-dlp -o -)
export async function resolveYouTube(videoUrl) {
  const errors = [];
  // Modo pipe forzado (pruebas): CMP_FORCE_PIPE=1 salta la resolución de URL directa.
  if (process.env.CMP_FORCE_PIPE === '1') {
    const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
    return { id, mode: 'pipe', url: null, sourceUrl: videoUrl, headers: {}, title: videoUrl, duration: 0, client: 'pipe', errors: ['modo pipe forzado (CMP_FORCE_PIPE=1)'] };
  }
  for (const client of YT_CLIENTS) {
    try {
      const j = await runYtdlpJson(videoUrl, client);
      const headers = j.http_headers || { 'User-Agent': 'Mozilla/5.0' };
      const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
      const base = {
        id, title: j.title || videoUrl, duration: j.duration || 0,
        client, url: j.url || null, sourceUrl: videoUrl, headers,
      };
      const muxed = j.vcodec && j.vcodec !== 'none' && j.acodec && j.acodec !== 'none';
      const proto = j.protocol || '';
      if (muxed && j.url) {
        return { ...base, mode: 'range', url: j.url, formatId: j.format_id, ext: j.ext, resolution: j.resolution };
      }
      if (j.url && (proto.includes('m3u8') || proto === 'm3u8_native')) {
        return { ...base, mode: 'hls', url: j.url, formatId: j.format_id, resolution: j.resolution };
      }
      // Sin URL directa utilizable con este cliente: probar siguiente; si ninguno, caerá a 'pipe'.
      errors.push(`${client}: sin URL directa (format_id=${j.format_id}, proto=${proto})`);
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  // Fallback: modo pipe (yt-dlp transmite por stdout; sin seek, se usa solo como último recurso).
  const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
  return { id, mode: 'pipe', url: null, sourceUrl: videoUrl, headers: {}, title: videoUrl, duration: 0, client: 'pipe', errors };
}
