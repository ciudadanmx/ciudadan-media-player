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
import { subtitleTracksFromInfo } from './subtitles.js';

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

// Timeout POR CLIENTE: si un cliente no responde en 30 s no se espera más.
// Antes eran 90 s y con 5 clientes un bloqueo de YouTube ("Sign in to
// confirm you're not a bot") dejaba al usuario esperando más de 6 minutos
// sin que arrancara nada.
// Los dos clientes que hoy resuelven bien (android, mweb) se les da más margen
// porque tardan ~20 s; los de respaldo, menos (fallan rápido).
const CLIENT_TIMEOUT_MS = { android: 60000, mweb: 60000 };
// Presupuesto global de resolución: ningún load debe tardar más de esto.
const RESOLVE_BUDGET_MS = 75000;
function runYtdlpJson(videoUrl, client, timeoutMs = 20000) {
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

// Caché de resoluciones: la URL directa de YouTube caduca a las ~6 h, así que
// se reutiliza durante 10 minutos. Evita volver a preguntar a YouTube por el
// mismo vídeo (cada consulta extra aumenta el riesgo del muro "not a bot") y
// hace que las recargas del vigilante sean instantáneas.
const RESOLVE_CACHE = new Map();
const RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000;

export function clearResolveCache() { RESOLVE_CACHE.clear(); }

// Devuelve { id, mode, url, headers, title, duration, formatId, client, resolution }
// mode: 'range' (mp4 progresivo vía proxy con Range => seek) | 'hls' (m3u8) | 'pipe' (yt-dlp -o -)
export async function resolveYouTube(videoUrl) {
  const errors = [];
  const tInicio = Date.now();
  const cached = RESOLVE_CACHE.get(videoUrl);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
    return { ...cached.entry, cached: true };
  }
  // Modo pipe forzado (pruebas): CMP_FORCE_PIPE=1 salta la resolución de URL directa.
  if (process.env.CMP_FORCE_PIPE === '1') {
    const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
    return { id, mode: 'pipe', url: null, sourceUrl: videoUrl, headers: {}, title: videoUrl, duration: 0, client: 'pipe', errors: ['modo pipe forzado (CMP_FORCE_PIPE=1)'] };
  }
  // Fase 1: los dos clientes que hoy resuelven bien (android, mweb) se lanzan
  // EN PARALELO: la latencia de YouTube aquí es muy variable (18-37 s para el
  // mismo vídeo) y en serie el primero a veces agotaba el timeout y el
  // usuario se quedaba sin reproducción. Gana el primero que responda.
  const primary = YT_CLIENTS.slice(0, 2);
  const rest = YT_CLIENTS.slice(2);
  const tryClient = async (client) => {
    const j = await runYtdlpJson(videoUrl, client, CLIENT_TIMEOUT_MS[client] || 20000);
    const headers = j.http_headers || { 'User-Agent': 'Mozilla/5.0' };
    const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
    const base = {
      id, title: j.title || videoUrl, duration: j.duration || 0,
      client, url: j.url || null, sourceUrl: videoUrl, headers,
      // Metadatos para continuidad/clasificación (sólo datos reales de yt-dlp):
      channel: j.channel || j.uploader || null,
      channelId: j.channel_id || null,
      channelUrl: j.channel_url || j.uploader_url || null,
      uploaderId: j.uploader_id || null,
      category: j.category || null,
      description: j.description || null,
      // Pistas de subtítulos disponibles (se descargan aparte, sin bloquear).
      subtitleTracks: subtitleTracksFromInfo(j),
    };
    const muxed = j.vcodec && j.vcodec !== 'none' && j.acodec && j.acodec !== 'none';
    const proto = j.protocol || '';
    if (muxed && j.url) return { ...base, mode: 'range', url: j.url, formatId: j.format_id, ext: j.ext, resolution: j.resolution };
    if (j.url && (proto.includes('m3u8') || proto === 'm3u8_native')) return { ...base, mode: 'hls', url: j.url, formatId: j.format_id, resolution: j.resolution };
    throw new Error(`${client}: sin URL directa (format_id=${j.format_id}, proto=${proto})`);
  };
  try {
    const entry = await Promise.any(primary.map((c) => tryClient(c)));
    RESOLVE_CACHE.set(videoUrl, { at: Date.now(), entry });
    return entry;
  } catch (agg) {
    const list = (agg && agg.errors) || [];
    for (const e of list) errors.push(String(e && e.message ? e.message : e));
  }
  // Fase 2: clientes de respaldo, uno a uno (son menos fiables y más lentos),
  // pero con PRESUPUESTO GLOBAL: si ya se ha gastado el tiempo (YouTube lento
  // o bloqueado), no se sigue esperando y se cae al modo pipe para que el
  // usuario no se quede mirando una carga infinita.
  const deadline = Date.now() + (RESOLVE_BUDGET_MS || 75000) - (Date.now() - tInicio);
  for (const client of rest) {
    if (Date.now() > deadline) { errors.push('presupuesto de resolución agotado'); break; }
    try {
      const entry = await tryClient(client);
      RESOLVE_CACHE.set(videoUrl, { at: Date.now(), entry });
      return entry;
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  // Fallback: modo pipe (yt-dlp transmite por stdout; sin seek, se usa solo como último recurso).
  const id = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16);
  return { id, mode: 'pipe', url: null, sourceUrl: videoUrl, headers: {}, title: videoUrl, duration: 0, client: 'pipe', errors };
}
