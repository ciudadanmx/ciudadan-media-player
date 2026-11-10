import koffi from 'koffi';
const lib = koffi.load('C:\\yii\\ciudadan-media-player\\.vlc64\\vlc-3.0.23\\libvlc.dll');
const inst = koffi.opaque('libvlc_instance_t');
const variants = [
  'libvlc_instance_t *libvlc_new(int argc, char **argv)',
  'libvlc_instance_t *libvlc_new(int argc, void *argv)',
  'libvlc_instance_t *libvlc_new(int argc, const void *argv)',
  'void *libvlc_new(int argc, char **argv)',
];
for (const v of variants) {
  try { const f = lib.func(v); console.log('OK  :', v); }
  catch (e) { console.log('ERR :', v, '->', e.message); }
}
console.log('done');
