import koffi from 'koffi';
const lib = koffi.load('C:\\yii\\ciudadan-media-player\\.vlc64\\vlc-3.0.23\\libvlc.dll');
const t = koffi.opaque('libvlc_media_player_t');
const checks = [
  ['void libvlc_media_player_stop(libvlc_media_player_t *player)', 'libvlc_media_player_stop'],
  ['void libvlc_media_player_stop_async(libvlc_media_player_t *player)', 'libvlc_media_player_stop_async'],
  ['int libvlc_media_player_set_pause(libvlc_media_player_t *player, int do_pause)', 'libvlc_media_player_set_pause'],
  ['void libvlc_media_player_set_media(libvlc_media_player_t *player, libvlc_media_t *media)', 'libvlc_media_player_set_media'],
];
const media = koffi.opaque('libvlc_media_t');
for (const [sig, name] of checks) {
  try { lib.func(sig.replace('libvlc_media_t *media', 'void *media')); console.log('OK   ' + name); }
  catch (e) { console.log('NO   ' + name + ' => ' + String(e.message).slice(0, 100)); }
}
