// Sonda: ¿set/get volume funciona con aout dummy vs aout real (directsound) en esta sesión?
import { VlcPlayer } from '../src/vlc.js';
import { StreamProxy } from '../src/proxy.js';
import { resolveYouTube } from '../src/resolver.js';

const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const entry = await resolveYouTube(VIDEO);
const proxy = new StreamProxy();
await proxy.listen();
proxy.register(entry);
const url = proxy.streamUrl(entry.id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const dummy of [true, false]) {
  const vlc = new VlcPlayer({ dummyOutput: dummy, onEvent: () => {} });
  vlc.play(url, { mediaOptions: [':network-caching=800'] });
  for (let i = 0; i < 20 && vlc.getState() !== 3; i++) await sleep(500);
  await sleep(3000);
  const rcSet = vlc.api.libvlc_audio_set_volume(vlc.player, 37);
  await sleep(300);
  const vol = vlc.api.libvlc_audio_get_volume(vlc.player);
  console.log(`dummy=${dummy}: state=${vlc.getState()} set_rc=${rcSet} get_volume=${vol}`);
  vlc.dispose();
}
proxy.close();
process.exit(0);
