// Prueba de UN video en un proceso aislado (para que un crash/bloqueo de libVLC
// no afecte a la suite multivideo). Imprime un JSON con el resultado.
// Uso: node tools/test-video-one.mjs <url> <segundos> [etiqueta]
import { resolveYouTube } from '../src/resolver.js';
import { StreamProxy } from '../src/proxy.js';
import { VlcPlayer, STATE_NAMES } from '../src/vlc.js';

const url = process.argv[2];
const secs = Number(process.argv[3] || 10);
const label = process.argv[4] || url;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stage = (s) => { try { process.stderr.write('ETAPA: ' + s + '\n'); } catch {} };
const out = { label, url, ok: false, mode: null, client: null, format: null, resolution: null, title: null,
  played: false, maxTime: 0, seekOk: false, bytes: 0, errors: [], error: null };

const proxy = new StreamProxy();
await proxy.listen();
const vlc = new VlcPlayer({ dummyOutput: true, onEvent: () => {} });
try {
  stage('inicio');
  const entry = await resolveYouTube(url);
  stage('resuelto ' + entry.mode);
  out.mode = entry.mode; out.client = entry.client; out.format = entry.formatId; out.resolution = entry.resolution;
  out.title = entry.title; out.errors = entry.errors || [];
  if (!['range', 'hls', 'pipe'].includes(entry.mode)) throw new Error('sin modo proxyable: ' + entry.mode);
  proxy.register(entry);
  vlc.play(proxy.streamUrl(entry.id), { mediaOptions: [':network-caching=1000'] });
  stage('play lanzado');
  let started = false;
  for (let i = 0; i < 60 && !started; i++) { await sleep(500); if (vlc.getState() === 3 && vlc.getTime() > 0) started = true; }
  if (!started) throw new Error('no alcanzó Playing (estado=' + STATE_NAMES[vlc.getState()] + ')');
  stage('reproduciendo t=' + vlc.getTime());
  await sleep(secs * 1000);
  stage('espera fin t=' + vlc.getTime());
  out.maxTime = vlc.getTime(); out.played = out.maxTime > 2000;
  const len = vlc.getLength();
  if (len > 10000 && entry.mode !== 'pipe') { // el modo pipe no soporta Range => sin seek
    const target = Math.floor(len * 0.3);
    vlc.setTime(target);
    stage('seek enviado -> ' + target);
    await sleep(4000);
    stage('seek t=' + vlc.getTime() + ' estado=' + STATE_NAMES[vlc.getState()]);
    out.seekOk = Math.abs(vlc.getTime() - target) < 10000;
  }
  out.bytes = proxy.get(entry.id)?.bytes || 0;
  // En modo pipe no hay Range => el seek no aplica (no cuenta como fallo).
  out.ok = out.played && (entry.mode === 'pipe' ? true : out.seekOk);
  stage('medido');
} catch (e) {
  out.error = String(e.message || e);
}
stage('dispose...');
// No liberamos el media player: con el vout 'dummy' y vídeos cortos, el stop/release
// de un player en reproducción provoca 0xC0000005 dentro de libVLC. El proceso termina
// inmediatamente después y el sistema operativo libera los recursos.
try { proxy.close(); } catch {}
stage('fin');
console.log('###RESULT###' + JSON.stringify(out));
process.exit(out.ok ? 0 : 3);
