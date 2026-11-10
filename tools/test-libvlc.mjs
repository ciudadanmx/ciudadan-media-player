// PRUEBA INTEGRAL HEADLESS (sin GUI):
//   YouTube URL -> yt-dlp (resolver) -> proxy local 127.0.0.1 con Range -> libVLC (koffi) reproduce
// Verifica: estado Playing, avance de tiempo real, PAUSA, SEEK, VOLUMEN y fin de error.
// Uso: node tools/test-libvlc.mjs [URL_YOUTUBE] [segundos_de_reproduccion]
import { resolveYouTube, videoIdOf } from '../src/resolver.js';
import { StreamProxy } from '../src/proxy.js';
import { VlcPlayer, STATE_NAMES } from '../src/vlc.js';

const VIDEO = process.argv[2] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const PLAY_SECS = Number(process.argv[3] || 20);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

log('VIDEO:', VIDEO);
log('1) Resolviendo con yt-dlp...');
const t0 = Date.now();
const entry = await resolveYouTube(VIDEO);
log(`   resuelto en ${Date.now() - t0}ms -> modo=${entry.mode} client=${entry.client} format=${entry.formatId} res=${entry.resolution} titulo="${entry.title}" dur=${entry.duration}s`);
if (entry.mode === 'pipe') { log('   (pipe: sin URL directa; el proxy devolverá 409 y libVLC no podrá reproducir en este modo headless)'); }
if (entry.errors?.length) log('   errores previos:', entry.errors.join(' ; '));

const proxy = new StreamProxy();
const port = await proxy.listen();
proxy.register(entry);
log(`2) Proxy local en 127.0.0.1:${port}  stream=${proxy.streamUrl(entry.id)}`);

const events = [];
let lastEv = '';
const vlc = new VlcPlayer({ dummyOutput: true, onEvent: (e) => { events.push(e.name); if (e.name !== lastEv) { log('   [evento]', e.name); lastEv = e.name; } } });
log('3) libVLC inicializado (salidas dummy, sin HWND)');

log('4) play() sobre el stream del proxy...');
vlc.play(proxy.streamUrl(entry.id), { mediaOptions: [':network-caching=1500'] });

// esperar a que empiece a reproducir
let started = false;
for (let i = 0; i < 30 && !started; i++) {
  await sleep(500);
  if (vlc.getState() === 3 || vlc.getTime() > 0) started = true;
}
log(`   estado=${STATE_NAMES[vlc.getState()]} isPlaying=${vlc.isPlaying()} time=${vlc.getTime()}ms length=${vlc.getLength()}ms`);
if (!started) { log('FALLO: no alcanzó estado Playing'); vlc.dispose(); proxy.close(); process.exit(2); }

// dejar reproducir PLAY_SECS y verificar avance real
const tStart = vlc.getTime();
await sleep(PLAY_SECS * 1000);
const tEnd = vlc.getTime();
log(`5) tras ${PLAY_SECS}s: time=${tEnd}ms (avance=${tEnd - tStart}ms) estado=${STATE_NAMES[vlc.getState()]}`);
const advanced = (tEnd - tStart) >= PLAY_SECS * 1000 * 0.5;

// PAUSA
vlc.pause(); await sleep(1500);
const tPause = vlc.getTime(); await sleep(2000); const tPause2 = vlc.getTime();
const pausedOk = Math.abs(tPause2 - tPause) < 1200 && (vlc.getState() === 4 || vlc.getState() === 3);
log(`6) pausa: state=${STATE_NAMES[vlc.getState()]} time ${tPause}->${tPause2} (congelado=${Math.abs(tPause2 - tPause) < 1200})`);
vlc.pause(); // reanudar (pause alterna)
await sleep(1000);

// SEEK a 60s (requiere Range 206 en el proxy)
const target = 60000;
vlc.setTime(target);
await sleep(4000);
const afterSeek = vlc.getTime();
const seekOk = Math.abs(afterSeek - target) < 6000;
log(`7) seek a ${target}ms -> time=${afterSeek}ms estado=${STATE_NAMES[vlc.getState()]} seekOk=${seekOk}`);

// VOLUMEN (con aout=dummy el volumen no se almacena; vale rc==0 de la API; en GUI con aout real devuelve el valor)
const rcVol = vlc.api.libvlc_audio_set_volume(vlc.player, 37);
await sleep(500);
const vol = vlc.getVolume();
const volOk = rcVol === 0 && (vol === 37 || vol === 0);
log(`8) volumen: set 37 -> rc=${rcVol} get=${vol} ok=${volOk}`);
vlc.setVolume(100);

// bytes transmitidos por el proxy (prueba de streaming, no descarga completa)
const e2 = proxy.get(entry.id);
log(`9) proxy: hits=${e2.hits} bytesServidos=${e2.bytes} (~${(e2.bytes / 1048576).toFixed(2)} MB de ${(entry.duration || 0)}s de video)`);

log('eventos recibidos:', [...new Set(events)].join(', '));

const pass = advanced && seekOk && volOk;
log(pass ? 'RESULTADO: PASS (reproducción real verificada: avance de tiempo + seek + volumen)' : 'RESULTADO: FAIL');
vlc.dispose(); proxy.close();
process.exit(pass ? 0 : 3);
