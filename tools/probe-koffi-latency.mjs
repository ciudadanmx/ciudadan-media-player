#!/usr/bin/env node
// Medición del coste de las llamadas FFI asíncronas de koffi.
//
// PREGUNTA: si cada llamada asíncrona crea un hilo de trabajo nuevo, el sondeo
// de 1 Hz (3-5 llamadas por ciclo) puede provocar pausas de cientos de ms en
// el hilo principal del proceso de Electron (el síntoma: "la app se traba").
//
// La medición se hace con GetTickCount64 de kernel32 (coste despreciable): así
// se aísla el coste de koffi sin meter a libVLC en medio.
//
// NOTAS (errores ya cometidos y su causa):
//  * libvlc_new(0, null) provoca un CRASH 0xC0000005: argv no puede ser NULL.
//  * libvlc_media_player_new() (sin medio) también provoca 0xC0000005 en esta
//    build: el reproductor sólo se crea a partir de un medio
//    (libvlc_media_player_new_from_media), que es lo que usa la app.
import koffi from 'koffi';

const k32 = koffi.load('kernel32.dll');
const getTick = k32.func('uint64_t GetTickCount64()');

function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// 1) Coste de UNA llamada asíncrona (encabezado + trabajo + retorno).
const N = 300;
let t0 = Date.now();
for (let i = 0; i < N; i++) await call(getTick);
const perCall = (Date.now() - t0) / N;
console.log('asíncrona 1 llamada : ' + perCall.toFixed(3) + ' ms/llamada  (' + N + ' llamadas en ' + (Date.now() - t0) + ' ms)');

// 2) El ciclo completo del sondeo de 1 Hz: 3 llamadas de estado + 2 de audio.
t0 = Date.now();
const CYCLES = 100;
for (let i = 0; i < CYCLES; i++) {
  await call(getTick); await call(getTick); await call(getTick);
  await call(getTick); await call(getTick);
}
console.log('ciclo de sondeo (5) : ' + ((Date.now() - t0) / CYCLES).toFixed(3) + ' ms/ciclo');

// 3) Cinco llamadas EN PARALELO (así sería si se dispararan a la vez).
t0 = Date.now();
for (let i = 0; i < CYCLES; i++) {
  await Promise.all([call(getTick), call(getTick), call(getTick), call(getTick), call(getTick)]);
}
console.log('ciclo en paralelo (5): ' + ((Date.now() - t0) / CYCLES).toFixed(3) + ' ms/ciclo');

// 4) Coste de la llamada SÍNCRONA (la que antes congelaba la app).
t0 = Date.now();
for (let i = 0; i < 300; i++) getTick();
console.log('síncrona 1 llamada  : ' + ((Date.now() - t0) / 300).toFixed(4) + ' ms/llamada');
process.exit(0);
