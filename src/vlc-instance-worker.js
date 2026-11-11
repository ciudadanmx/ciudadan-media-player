// ===========================================================================
// CIUDADAN MEDIA PLAYER — Instancia de libVLC creada fuera del hilo principal.
// Motivo: libvlc_new() escanea los 363 plugins de VLC y, con el antivirus
// activo, esa llamada puede tardar 95-216 s. Si se hace en el hilo principal,
// Electron se queda CONGELADO (la ventana no repinta, el API no responde).
// En este worker: 1) se precalientan los plugins (para que el antivirus no
// analice las DLL durante el escaneo) y 2) se crea la instancia y se devuelve
// su DIRECCIÓN (uintptr_t). La DLL se carga una sola vez en el proceso, así
// que el hilo principal puede usar esa instancia con normalidad.
// ===========================================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import koffi from 'koffi';
import { parentPort, workerData } from 'node:worker_threads';
import { LIBVLC_DLL, VLC_PLUGINS } from './paths.js';

function warmPlugins(root) {
  let files = 0;
  let bytes = 0;
  const t0 = Date.now();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(dll|so|dylib)$/i.test(e.name)) continue;
      try {
        const fd = fs.openSync(p, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const head = Buffer.alloc(Math.min(size, 262144));
          fs.readSync(fd, head, 0, head.length, 0);
          bytes += head.length;
          if (size > 262144) {
            const tail = Buffer.alloc(262144);
            fs.readSync(fd, tail, 0, tail.length, size - tail.length);
            bytes += tail.length;
          }
          files++;
        } finally { fs.closeSync(fd); }
      } catch { /* un plugin ilegible no debe parar el precarga */ }
    }
  };
  walk(root);
  return { files, bytes, ms: Date.now() - t0 };
}

try {
  process.env.VLC_PLUGIN_PATH = VLC_PLUGINS;
  const warm = warmPlugins(VLC_PLUGINS);
  const lib = koffi.load(LIBVLC_DLL);
  const libvlc_new = lib.func('uintptr_t libvlc_new(int argc, char **argv)');
  const args = Array.isArray(workerData?.args) ? workerData.args : [];
  const t0 = Date.now();
  const inst = libvlc_new(args.length, args);
  const address = inst ? Number(inst) : 0;
  parentPort?.postMessage({ ok: !!address, address, ms: Date.now() - t0, warm });
} catch (e) {
  parentPort?.postMessage({ ok: false, address: 0, error: String((e && e.message) || e) });
}
