// Diagnóstico de herramientas externas (yt-dlp, FFmpeg, Deno) para mostrarlos en la app.
// IMPORTANTE (sandbox DSH): los named pipes están bloqueados, así que cada proceso
// escribe su salida en un FDT de archivo real y se lee después.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_BASE = process.env.CMP_TMPDIR || path.join(ROOT, '.tmp');
try { fs.mkdirSync(TMP_BASE, { recursive: true }); } catch {}

function runTool(cmd, args, { timeoutMs = 20000, take = 1 } = {}) {
  return new Promise((resolve) => {
    let outFile;
    try {
      const dir = fs.mkdtempSync(path.join(TMP_BASE, 'tool-'));
      outFile = path.join(dir, 'out.txt');
      const outFd = fs.openSync(outFile, 'w');
      const errFd = fs.openSync(outFile + '.err', 'w');
      const child = spawn(cmd, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
      const killer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on('error', (e) => { clearTimeout(killer); try { fs.closeSync(outFd); fs.closeSync(errFd); } catch {} resolve({ ok: false, error: String(e.message || e) }); });
      child.on('close', async (code) => {
        clearTimeout(killer);
        try { fs.closeSync(outFd); fs.closeSync(errFd); } catch {}
        // Lectura ASÍNCRONA: el antivirus analiza los ficheros recién creados
        // en el primer acceso; con readFileSync bloqueaba el hilo principal.
        const text = await fsp.readFile(outFile, 'utf8').catch(() => '');
        const err = await fsp.readFile(outFile + '.err', 'utf8').catch(() => '');
        const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        resolve({ ok: code === 0, code, value: lines.slice(0, take).join(' | '), error: err.slice(-200) });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

export async function toolVersions() {
  const [ytdlp, ffmpeg, deno] = await Promise.all([
    runTool(TOOLS.ytdlp, ['--version']),
    runTool(TOOLS.ffmpeg, ['-version']),
    runTool(TOOLS.deno, ['--version']),
  ]);
  const first = (t, prefix) => {
    if (!t.ok) return 'ERROR';
    const v = String(t.value || '').split(' | ')[0];
    return v || 'ERROR';
  };
  return {
    ytdlp: first(ytdlp),
    ffmpeg: first(ffmpeg).replace(/^ffmpeg version\s*/i, ''),
    deno: first(deno),
    raw: { ytdlp, ffmpeg, deno },
  };
}
