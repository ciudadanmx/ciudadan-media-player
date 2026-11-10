// Integración libVLC vía FFI (koffi) cargando libvlc.dll de VideoLAN directamente.
// Expone Play, Pausa, Stop, Seek (set_time), Volumen y eventos — todo desde Node.js.
import koffi from 'koffi';
import { LIBVLC_DLL, VLC_PLUGINS } from './paths.js';

let apiCache = null;

// Eventos libvlc (libvlc_event_e)
export const EV = {
  MediaPlayerMediaChanged: 0x100, Opening: 0x101, Buffering: 0x102, Playing: 0x103,
  Paused: 0x104, Stopped: 0x105, EndReached: 0x106, EncounteredError: 0x107,
  TimeChanged: 0x108, PositionChanged: 0x109, SeekableChanged: 0x10a, PausableChanged: 0x10b,
  LengthChanged: 0x10c, Vout: 0x10d,
};
export const STATE_NAMES = { 0: 'NothingSpecial', 1: 'Opening', 2: 'Buffering', 3: 'Playing', 4: 'Paused', 5: 'Stopped', 6: 'EndReached', 7: 'Error' };

export function loadLibvlc(extraArgs = []) {
  if (apiCache) return apiCache;
  // libvlc localiza los plugins junto a libvlc.dll; reforzamos con VLC_PLUGIN_PATH.
  process.env.VLC_PLUGIN_PATH = VLC_PLUGINS;
  const lib = koffi.load(LIBVLC_DLL);

  const libvlc_instance_t = koffi.opaque('libvlc_instance_t');
  const libvlc_media_t = koffi.opaque('libvlc_media_t');
  const libvlc_media_player_t = koffi.opaque('libvlc_media_player_t');
  const libvlc_event_manager_t = koffi.opaque('libvlc_event_manager_t');
  const libvlc_time_t = koffi.alias('libvlc_time_t', 'int64_t');
  const libvlc_event_t = koffi.opaque('libvlc_event_t');
  const EventCb = koffi.proto('void libvlc_event_cb_t(const libvlc_event_t *event, void *user_data)');

  const api = {
    libvlc_new: lib.func('libvlc_instance_t *libvlc_new(int argc, char **argv)'), // OJO: 'const char *const argv[]' tumba a koffi; char** con array JS funciona
    libvlc_release: lib.func('void libvlc_release(libvlc_instance_t *instance)'),
    libvlc_media_new_location: lib.func('libvlc_media_t *libvlc_media_new_location(libvlc_instance_t *instance, const char *mrl)'),
    libvlc_media_add_option: lib.func('void libvlc_media_add_option(libvlc_media_t *media, const char *option)'),
    libvlc_media_release: lib.func('void libvlc_media_release(libvlc_media_t *media)'),
    libvlc_media_player_new_from_media: lib.func('libvlc_media_player_t *libvlc_media_player_new_from_media(libvlc_media_t *media)'),
    libvlc_media_player_release: lib.func('void libvlc_media_player_release(libvlc_media_player_t *player)'),
    libvlc_media_player_set_hwnd: lib.func('void libvlc_media_player_set_hwnd(libvlc_media_player_t *player, uintptr_t hwnd)'),
    libvlc_media_player_play: lib.func('int libvlc_media_player_play(libvlc_media_player_t *player)'),
    libvlc_media_player_pause: lib.func('void libvlc_media_player_pause(libvlc_media_player_t *player)'),
    // set_pause es idempotente (pause() alterna el estado y puede despausar solo).
    libvlc_media_player_set_pause: lib.func('void libvlc_media_player_set_pause(libvlc_media_player_t *player, int pause)'),
    libvlc_media_player_stop: lib.func('void libvlc_media_player_stop(libvlc_media_player_t *player)'),
    libvlc_media_player_is_playing: lib.func('int libvlc_media_player_is_playing(libvlc_media_player_t *player)'),
    libvlc_media_player_get_state: lib.func('int libvlc_media_player_get_state(libvlc_media_player_t *player)'),
    libvlc_media_player_get_time: lib.func('libvlc_time_t libvlc_media_player_get_time(libvlc_media_player_t *player)'),
    libvlc_media_player_set_time: lib.func('void libvlc_media_player_set_time(libvlc_media_player_t *player, libvlc_time_t t)'),
    libvlc_media_player_get_length: lib.func('libvlc_time_t libvlc_media_player_get_length(libvlc_media_player_t *player)'),
    libvlc_media_player_set_position: lib.func('void libvlc_media_player_set_position(libvlc_media_player_t *player, float pos)'),
    libvlc_media_player_get_position: lib.func('float libvlc_media_player_get_position(libvlc_media_player_t *player)'),
    libvlc_media_player_event_manager: lib.func('libvlc_event_manager_t *libvlc_media_player_event_manager(libvlc_media_player_t *player)'),
    libvlc_event_attach: lib.func('int libvlc_event_attach(libvlc_event_manager_t *em, int event_type, void *cb, void *user_data)'),
    libvlc_event_detach: lib.func('void libvlc_event_detach(libvlc_event_manager_t *em, int event_type, void *cb, void *user_data)'),
    libvlc_audio_set_volume: lib.func('int libvlc_audio_set_volume(libvlc_media_player_t *player, int volume)'),
    libvlc_audio_get_volume: lib.func('int libvlc_audio_get_volume(libvlc_media_player_t *player)'),
    libvlc_audio_set_mute: lib.func('int libvlc_audio_set_mute(libvlc_media_player_t *player, int mute)'),
    libvlc_audio_get_mute: lib.func('int libvlc_audio_get_mute(libvlc_media_player_t *player)'),
    libvlc_media_player_set_media: lib.func('void libvlc_media_player_set_media(libvlc_media_player_t *player, libvlc_media_t *media)'),
    // utilidades de diagnóstico
    libvlc_errmsg: lib.func('const char *libvlc_errmsg()'),
    libvlc_get_version: lib.func('const char *libvlc_get_version()'),
  };
  api._types = { libvlc_instance_t, libvlc_media_t, libvlc_media_player_t, libvlc_event_manager_t, libvlc_event_t, EventCb };
  apiCache = api;
  return api;
}

export class VlcPlayer {
  constructor({ hwnd = null, dummyOutput = false, onEvent = null } = {}) {
    this.api = loadLibvlc();
    const t = this.api._types;
    const args = ['--ignore-config', '--no-video-title-show', '--no-stats'];
    if (dummyOutput) { args.push('--vout=dummy', '--aout=dummy'); }
    else { args.push('--vout=direct3d11'); }
    this.instance = this.api.libvlc_new(args.length, args); // koffi: array JS de strings -> char**
    if (!this.instance) throw new Error('libvlc_new falló: ' + this.api.libvlc_errmsg());
    this.player = this.api.libvlc_media_player_new_from_media?.call ? null : null;
    this.player = null;
    this.onEvent = onEvent || (() => {});
    this._callbacks = [];
    if (hwnd) {
      const buf = Buffer.isBuffer(hwnd) ? hwnd : Buffer.from(hwnd);
      this.api.libvlc_media_player_set_hwnd; // ensure symbol
    }
    this._hwnd = hwnd;
  }

  attachEvents() {
    if (!this.player) return;
    const t = this.api._types;
    const self = this;
    for (const [name, code] of Object.entries(EV)) {
      if (!['Playing', 'Paused', 'Stopped', 'EndReached', 'EncounteredError', 'TimeChanged', 'LengthChanged', 'Buffering', 'Opening', 'SeekableChanged'].includes(name)) continue;
      const cb = koffi.register((event, user) => {
        try { self.onEvent({ type: code, name }); } catch {}
      }, koffi.pointer(t.EventCb));
      this._callbacks.push(cb);
      this.api.libvlc_event_attach(this.api.libvlc_media_player_event_manager(this.player), code, cb, null);
    }
  }

  play(mrl, { hwnd = null, mediaOptions = [] } = {}) {
    const a = this.api;
    const media = a.libvlc_media_new_location(this.instance, mrl);
    if (!media) throw new Error('libvlc_media_new_location falló: ' + a.libvlc_errmsg());
    for (const opt of mediaOptions) a.libvlc_media_add_option(media, opt);
    if (!this.player) {
      this.player = a.libvlc_media_player_new_from_media(media);
      if (!this.player) throw new Error('libvlc_media_player_new_from_media falló');
      const h = hwnd ?? this._hwnd;
      if (h) {
        const buf = Buffer.isBuffer(h) ? h : Buffer.from(h);
        const val = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
        a.libvlc_media_player_set_hwnd(this.player, val);
      }
      this.attachEvents();
    } else {
      // Patrón recomendado de libVLC: reutilizar el MISMO media player y sólo
      // cambiar el media. Liberar y recrear el player tras un EndReached provoca
      // crash 0xC0000005 dentro de libVLC.
      // OJO: si el medio ya terminó (EndReached) NO se llama a stop(): en ese
      // momento libVLC está destruyendo el vout y stop() puede tumbar el motor.
      let st = 0;
      try { st = a.libvlc_media_player_get_state(this.player); } catch {}
      if (st !== 6) { try { a.libvlc_media_player_stop(this.player); } catch {} }
      a.libvlc_media_player_set_media(this.player, media);
    }
    a.libvlc_media_release(media);
    const rc = a.libvlc_media_player_play(this.player);
    return rc;
  }

  pause() { if (this.player) this.api.libvlc_media_player_pause(this.player); }
  // Fija el estado de pausa de forma explícita (no alterna como pause()).
  setPaused(on) { if (this.player) this.api.libvlc_media_player_set_pause(this.player, on ? 1 : 0); }
  isPaused() { return this.player ? this.api.libvlc_media_player_get_state(this.player) === 4 : false; }
  version() { try { return String(this.api.libvlc_get_version()); } catch { return 'desconocida'; } }
  stop() {
    if (!this.player) return;
    // Si el medio ya terminó (EndReached), libVLC está destruyendo el vout en ese
    // momento y llamar a stop() provoca un crash 0xC0000005 dentro de libVLC.
    const st = this.api.libvlc_media_player_get_state(this.player);
    if (st === 6) return; // EndReached
    this.api.libvlc_media_player_stop(this.player);
  }
  isPlaying() { return this.player ? !!this.api.libvlc_media_player_is_playing(this.player) : false; }
  getState() { return this.player ? this.api.libvlc_media_player_get_state(this.player) : 0; }
  getTime() { return this.player ? Number(this.api.libvlc_media_player_get_time(this.player)) : 0; } // ms
  setTime(ms) { if (this.player) this.api.libvlc_media_player_set_time(this.player, BigInt(Math.round(ms))); }
  getLength() { return this.player ? Number(this.api.libvlc_media_player_get_length(this.player)) : 0; } // ms
  setVolume(v) { if (this.player) return this.api.libvlc_audio_set_volume(this.player, Math.max(0, Math.min(200, Math.round(v)))); return -1; }
  getVolume() { if (this.player) { const v = this.api.libvlc_audio_get_volume(this.player); return v < 0 ? 0 : v; } return 0; }
  setMute(on) { if (this.player) return this.api.libvlc_audio_set_mute(this.player, on ? 1 : 0); return -1; }
  getMute() { if (this.player) return !!this.api.libvlc_audio_get_mute(this.player); return false; }
  getPosition() { return this.player ? this.api.libvlc_media_player_get_position(this.player) : 0; }

  // safe=true: NO libera el media player si sigue en reproducción (al salir de la app).
  //           stopping/releasing un player activo puede tumbar libVLC con 0xC0000005
  //           en vídeos cortos; el sistema operativo libera la memoria al cerrar el proceso.
  dispose({ safe = false } = {}) {
    try {
      if (this.player) {
        const st = this.api.libvlc_media_player_get_state(this.player);
        const canRelease = !safe && st !== 6; // 6 = EndReached (vout destruyéndose)
        if (canRelease) {
          try { this.api.libvlc_media_player_stop(this.player); } catch {}
          try { this.api.libvlc_media_player_release(this.player); } catch {}
        }
      }
      for (const cb of this._callbacks) { try { koffi.unregister(cb); } catch {} }
      this._callbacks = [];
      if (this.instance) this.api.libvlc_release(this.instance);
    } catch {}
    this.player = null; this.instance = null;
  }
}
