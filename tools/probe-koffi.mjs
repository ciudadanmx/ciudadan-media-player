import koffi from 'koffi';
const lib = koffi.load('C:\\yii\\ciudadan-media-player\\.vlc64\\vlc-3.0.23\\libvlc.dll');
console.log('loaded');
const tests = [
  'const char *libvlc_get_version()',
  'void libvlc_free(void *p)',
  'libvlc_instance_t *libvlc_new(int argc, const char *const argv[])',
];
const inst = koffi.opaque('libvlc_instance_t');
console.log('opaque ok');
tests[0] = null;
try { const f = lib.func('const char *libvlc_get_version()'); console.log('get_version OK ->', f()); } catch (e) { console.log('get_version ERR', e.message); }
try { const f = lib.func('libvlc_instance_t *libvlc_new(int argc, const char *const argv[])'); console.log('new sig OK'); } catch (e) { console.log('new sig ERR', e.message); }
