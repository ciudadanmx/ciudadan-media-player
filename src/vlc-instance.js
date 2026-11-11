// ===========================================================================
// CIUDADAN MEDIA PLAYER — Instancia de libVLC creada fuera del hilo principal.
// La llamada libvlc_new() escanea los plugins de VLC y puede tardar minutos
// si el antivirus analiza las DLL. Se ejecuta en un worker para que la app
// siga respondiendo (ventana, API de control, explorador) mientras tanto.
// ===========================================================================
'use strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'vlc-instance-worker.js');

// Último detalle de la creación (para el log): {ms, warm}
export let lastInfo = null;

/**
 * Crea la instancia de libVLC en un worker y devuelve su dirección.
 * @param {string[]|null} args argumentos extra de libVLC
 * @param {boolean} dummyOutput usar salidas ficticias (pruebas)
 * @param {number} timeoutMs tiempo máximo de espera
 * @returns {Promise<number>} dirección de la instancia (0 si falla)
 */
export function createVlcInstance(args = null, dummyOutput = false, timeoutMs = 300000) {
  const finalArgs = args ? args.slice() : [];  if (!finalArgs.includes('--ignore-config') && process.env.CMP_VLC_IGNORE_CONFIG !== '0') {
    finalArgs.unshift('--ignore-config');
  }
  if (!finalArgs.includes('--no-video-title-show')) finalArgs.push('--no-video-title-show', '--no-stats');
  if (dummyOutput) finalArgs.push('--vout=dummy', '--aout=dummy');
  else if (!finalArgs.some((a) => String(a).startsWith('--vout='))) finalArgs.push('--vout=direct3d11');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let worker;
    try {
      worker = new Worker(WORKER, { workerData: { args: finalArgs } });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      finish(0);
      try { worker.terminate(); } catch { /* ignore */ }
    }, timeoutMs);
    worker.on('message', (m) => {
      clearTimeout(timer);
      if (m && m.ok) {
        lastInfo = { ms: m.ms, warm: m.warm || null };
      }
      finish(m && m.ok ? Number(m.address) : 0);
      // El worker termina: la instancia sigue viva en el proceso (la DLL es la
      // misma) y la libera el hilo principal al salir.
      try { worker.terminate(); } catch { /* ignore */ }
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      finish(0);
      reject(e);
    });
    worker.on('exit', () => {
      clearTimeout(timer);
      finish(0);
    });
  });
}
