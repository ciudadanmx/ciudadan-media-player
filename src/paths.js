// Rutas de herramientas externas en Windows 11.
// Prioridad: VLC portable win64 descargado en el proyecto (.vlc64) porque el del sistema
// (C:\Program Files (x86)\VideoLAN) es de 32 bits y Node/Electron aquí son x64.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATE_VLC_DIRS = [
  path.join(ROOT, '.vlc64', 'vlc-3.0.23'),                 // portable win64 del proyecto
  path.join(ROOT, '.vlc64', 'vlc-3.0.24'),
  'C:\\Program Files\\VideoLAN\\VLC',                        // instalación 64 bits
  'C:\\Program Files (x86)\\VideoLAN\\VLC',                  // instalación 32 bits (no usable con Node x64)
];

export const VLC_DIR = CANDIDATE_VLC_DIRS.find(d => existsSync(path.join(d, 'libvlc.dll'))) || CANDIDATE_VLC_DIRS[0];
export const LIBVLC_DLL = path.join(VLC_DIR, 'libvlc.dll');
export const VLC_PLUGINS = path.join(VLC_DIR, 'plugins');

export const TOOLS = {
  ytdlp: 'yt-dlp',
  ffmpeg: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
  deno: 'deno',
};

export function assertTools() {
  const missing = [];
  if (!existsSync(LIBVLC_DLL)) missing.push(LIBVLC_DLL);
  if (!existsSync(VLC_PLUGINS)) missing.push(VLC_PLUGINS);
  return missing;
}

// Clientes de YouTube que yt-dlp probará en orden (el anti-bot 429/"Sign in" exige variar).
// android suele dar MP4 progresivo muxado (itag 18) con URL directa seekable.
// web_embedded/mweb resuelven retos JS con Deno (jsc:deno) — razón del rol de Deno.
export const YT_CLIENTS = ['android', 'tv_embedded', 'web_embedded', 'mweb', 'ios'];
