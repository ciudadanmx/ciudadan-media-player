// Integración libVLC vía FFI (koffi) cargando libvlc.dll de VideoLAN directamente.
// Expone Play, Pausa, Stop, Seek (set_time), Volumen y eventos — todo desde Node.js.
import koffi from 'koffi';
import { LIBVLC_DLL, VLC_PLUGINS } from './paths.js';

let apiCache = null;

// Espejo de libvlc_track_description_t { int i_id; char *psz_name; ... next }
// Registrado UNA sola vez (a nivel de módulo): redefinirlo en cada llamada
// puede lanzar en koffi si el nombre ya existe en el proceso.
const TRACK_DESC = koffi.struct('libvlc_track_description_t_mirror', { i_id: 'int', psz_name: 'str', p_next: 'void *' });

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
    // La instancia se maneja como DIRECCIÓN (uintptr_t) para poder crearla en
    // un hilo worker y usarla desde el hilo principal (ver vlc-instance-worker).
    libvlc_new: lib.func('uintptr_t libvlc_new(int argc, char **argv)'), // OJO: 'const char *const argv[]' tumba a koffi; char** con array JS funciona
    libvlc_release: lib.func('void libvlc_release(uintptr_t instance)'),
    libvlc_media_new_location: lib.func('libvlc_media_t *libvlc_media_new_location(uintptr_t instance, const char *mrl)'),
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
    // --- pistas de subtítulos (SPU): control REAL porque usamos libVLC -------
    libvlc_video_get_spu_count: lib.func('int libvlc_video_get_spu_count(libvlc_media_player_t *player)'),
    libvlc_video_get_spu: lib.func('int libvlc_video_get_spu(libvlc_media_player_t *player)'),
    // i_spu = -1 desactiva los subtítulos; >=0 selecciona la pista con ese id.
    libvlc_video_set_spu: lib.func('int libvlc_video_set_spu(libvlc_media_player_t *player, int i_spu)'),
    libvlc_video_get_spu_description: lib.func('void *libvlc_video_get_spu_description(libvlc_media_player_t *player)'),
    libvlc_track_description_list_release: lib.func('void libvlc_track_description_list_release(void *p)'),
    // utilidades de diagnóstico
    libvlc_errmsg: lib.func('const char *libvlc_errmsg()'),
    libvlc_get_version: lib.func('const char *libvlc_get_version()'),
  };
  api._types = { libvlc_instance_t, libvlc_media_t, libvlc_media_player_t, libvlc_event_manager_t, libvlc_event_t, EventCb };
  apiCache = api;
  return api;
}

export class VlcPlayer {
  /**
   * Crea el reproductor. La instancia de libVLC se crea en un HILO WORKER
   * (no bloquea el hilo principal) y se reutiliza aquí desde su dirección.
   * @param {object} opts
   * @returns {Promise<VlcPlayer>}
   */
  static async create(opts = {}) {
    const { createVlcInstance } = await import('./vlc-instance.js');
    const address = await createVlcInstance(opts.args || null, opts.dummyOutput === true);
    if (!address) throw new Error('libvlc_new falló (sin instancia)');
    return new VlcPlayer({ ...opts, instance: address });
  }

  constructor({ hwnd = null, dummyOutput = false, onEvent = null, onTiming = null, instance = null } = {}) {
    this.api = loadLibvlc();
    const t = this.api._types;
    // --ignore-config evita que la configuración personal de VLC del usuario
    // (vlcrc) influya en el reproductor. Se puede desactivar con
    // CMP_VLC_IGNORE_CONFIG=0 para que VLC use su CACHÉ de plugins: sin caché,
    // libVLC escanea los 366 plugins en cada arranque y con el antivirus activo
    // eso puede tardar minutos (la app se quedaba "congelada" al abrir).
    const ignoreConfig = process.env.CMP_VLC_IGNORE_CONFIG !== '0';
    this._args = [];
    if (ignoreConfig) this._args.push('--ignore-config');
    this._args.push('--no-video-title-show', '--no-stats');
    if (dummyOutput) this._args.push('--vout=dummy', '--aout=dummy');
    else this._args.push('--vout=direct3d11');
    if (instance) {
      // Instancia ya creada (en otro hilo): se reutiliza su dirección.
      this.instance = Number(instance);
    } else {
      this.instance = Number(this.api.libvlc_new(this._args.length, this._args)); // koffi: array JS de strings -> char**
    }
    if (!this.instance) throw new Error('libvlc_new falló: ' + this.api.libvlc_errmsg());
    this.player = null;
    this.onEvent = onEvent || (() => {});
    this.onTiming = onTiming || null;
    this._callbacks = [];
    this._hwnd = hwnd;
    // --- Control de concurrencia y caché -------------------------------------
    // Las llamadas a libVLC pueden quedarse bloqueadas (stop()/play()). Si se
    // hacen en el hilo principal, Electron se congela entero (la UI, la API y
    // el reloj). Por eso:
    //   * las operaciones se ejecutan ASÍNCRONAS (hilo worker de koffi),
    //   * se encolan en serie (nunca dos llamadas simultáneas al player),
    //   * las lecturas de estado se cachean y, mientras hay una operación en
    //     curso, se devuelve la caché sin tocar libVLC.
    this._busy = 0;
    this._chain = Promise.resolve();
    this._last = { state: 0, time: 0, length: 0, volume: 100, mute: false, spu: -1 };
  }

  /** true si hay una operación bloqueante en curso (no se consulta libVLC). */
  get busy() { return this._busy > 0; }

  // Ejecuta una operación en serie y sin bloquear el hilo principal.
  _enqueue(fn) {
    this._busy++;
    const run = this._chain.then(() => fn());
    this._chain = run.then(() => {}, () => {});
    return run.finally(() => { this._busy--; });
  }

  // Llamada FFI asíncrona (koffi la ejecuta en un hilo worker).
  _call(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        fn.async(...args, (err, res) => (err ? reject(err) : resolve(res)));
      } catch (e) { reject(e); }
    });
  }

  attachEvents() {
    if (!this.player) return;
    const t = this.api._types;
    const self = this;
    for (const [name, code] of Object.entries(EV)) {
      // Se ignoran los eventos de alta frecuencia (LengthChanged/TimeChanged):
      // llegan varias veces por segundo y cada uno disparaba una sincronización
      // y una escritura de log. La posición se obtiene del sondeo periódico.
      if (!['Playing', 'Paused', 'Stopped', 'EndReached', 'EncounteredError', 'Buffering', 'Opening', 'SeekableChanged'].includes(name)) continue;
      const cb = koffi.register((event, user) => {
        try { self.onEvent({ type: code, name }); } catch {}
      }, koffi.pointer(t.EventCb));
      this._callbacks.push(cb);
      this.api.libvlc_event_attach(this.api.libvlc_media_player_event_manager(this.player), code, cb, null);
    }
  }

  // Reproduce un medio. Devuelve una promesa: el hilo principal NO se bloquea
  // aunque stop()/play() tarden dentro de libVLC.
  async play(mrl, { hwnd = null, mediaOptions = [] } = {}) {
    return this._enqueue(async () => {
      const a = this.api;
      const t0 = Date.now();
      // Los punteros de koffi son objetos: nunca se convierten con String()
      // directamente (lanza "Cannot convert object to primitive value").
      const ptrInfo = (v) => {
        try { return typeof v + ':' + String(v).slice(0, 24); } catch { return typeof v + ':<obj>'; }
      };
      // IMPORTANTE: TODAS las llamadas a libVLC de este bloque se hacen por
      // koffi en un hilo worker (_call). Antes eran FFI síncronas en el hilo
      // principal: libvlc_media_new_location / new_from_media / set_media
      // pueden quedarse varios segundos esperando los locks internos de
      // libVLC (el hilo principal se quedaba congelado y la app "no servía"
      // la reproducción). El orden se conserva porque _call es secuencial.
      const media = await this._call(a.libvlc_media_new_location, this.instance, mrl);
      this.onTiming?.({ fase: 'media_new_location', ms: Date.now() - t0, ptrTipo: typeof media, ptr: ptrInfo(media) });
      if (!media) throw new Error('libvlc_media_new_location falló: ' + a.libvlc_errmsg());
      for (const opt of mediaOptions) await this._call(a.libvlc_media_add_option, media, opt);
      const tMedia = Date.now();
      if (!this.player) {
        this.player = await this._call(a.libvlc_media_player_new_from_media, media);
        if (!this.player) { await this._call(a.libvlc_media_release, media); throw new Error('libvlc_media_player_new_from_media falló'); }
        const h = hwnd ?? this._hwnd;
        if (h) {
          const buf = Buffer.isBuffer(h) ? h : Buffer.from(h);
          const val = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
          await this._call(a.libvlc_media_player_set_hwnd, this.player, val);
        }
        this.attachEvents();
        // El motor arranca con el volumen por defecto de su propia configuración:
        // se fuerza el volumen pedido para que el sonido nunca salga bajo.
        try { await this._call(a.libvlc_audio_set_volume, this.player, this._last.volume); } catch {}
        try { await this._call(a.libvlc_audio_set_mute, this.player, this._last.mute ? 1 : 0); } catch {}
      } else {
        // Patrón recomendado de libVLC: reutilizar el MISMO media player y sólo
        // cambiar el media. Liberar y recrear el player tras un EndReached provoca
        // crash 0xC0000005 dentro de libVLC.
        // OJO: si el medio ya terminó (EndReached) NO se llama a stop(): en ese
        // momento libVLC está destruyendo el vout y stop() puede tumbar el motor.
        let st = 0;
        try { st = await this._call(a.libvlc_media_player_get_state, this.player); } catch {}
        if (st !== 6) {
          try { await this._call(a.libvlc_media_player_stop, this.player); } catch {}
        }
        await this._call(a.libvlc_media_player_set_media, this.player, media);
      }
      const tPlayer = Date.now();
      this.onTiming?.({ fase: 'player', ms: tPlayer - tMedia, playerTipo: typeof this.player, player: ptrInfo(this.player) });
      await this._call(a.libvlc_media_release, media);
      const rc = await this._call(a.libvlc_media_player_play, this.player);
      const tPlay = Date.now();
      this.onTiming?.({
        media: tMedia - t0, player: tPlayer - tMedia, play: tPlay - tPlayer, total: tPlay - t0,
      });
      this._last.state = 3;
      this._last.time = 0;
      return rc;
    });
  }

  async pause() {
    if (!this.player) return -1;
    try { return await this._call(this.api.libvlc_media_player_pause, this.player); } catch { return -1; }
  }
  // Reanuda un medio parado sin bloquear el hilo principal.
  async resume() {
    if (!this.player) return -1;
    return this._enqueue(async () => await this._call(this.api.libvlc_media_player_play, this.player));
  }
  // Fija el estado de pausa de forma explícita (no alterna como pause()).
  async setPaused(on) {
    if (!this.player) return -1;
    return this._call(this.api.libvlc_media_player_set_pause, this.player, on ? 1 : 0);
  }
  // El salto (seek) puede tardar dentro de libVLC: se hace fuera del hilo principal.
  async setTime(ms) {
    if (!this.player) return -1;
    return this._call(this.api.libvlc_media_player_set_time, this.player, BigInt(Math.round(ms)));
  }
  isPaused() { return this.getState() === 4; }
  version() { try { return String(this.api.libvlc_get_version()); } catch { return 'desconocida'; } }
  // Detiene el medio sin bloquear el hilo principal.
  async stop() {
    if (!this.player) return;
    return this._enqueue(async () => {
      // Si el medio ya terminó (EndReached), libVLC está destruyendo el vout en ese
      // momento y llamar a stop() provoca un crash 0xC0000005 dentro de libVLC.
      // La lectura del estado es ASÍNCRONA: una FFI síncrona puede congelar la app.
      let st = this._last.state;
      try { st = await this._call(this.api.libvlc_media_player_get_state, this.player); } catch {}
      if (st === 6) return; // EndReached
      await this._call(this.api.libvlc_media_player_stop, this.player);
    });
  }

  // --- Lecturas de estado: SIEMPRE desde la caché, nunca FFI síncrono --------
  // Una llamada FFI síncrona a libVLC puede quedarse bloqueada varios segundos
  // (get_time/get_state esperan al vout). Como esas llamadas sehacían desde el
  // hilo principal, la app entera se congelaba: la UI no respondía y el API de
  // control tardaba 6-30 s. Ahora las lecturas se hacen ASÍNCRONAS (sync()) y
  // el resto del código lee siempre la caché, que se refresca cada segundo.
  isPlaying() { return this.getState() === 3; }
  getState() { return this._last.state; }
  getTime() { return this._last.time; } // ms
  getLength() { return this._last.length; } // ms

  // Refresca la caché de estado con llamadas FFI ASÍNCRONAS (no bloquean).
  // No llama a libVLC si hay una operación en curso (el motor está ocupado).
  async sync() {
    if (!this.player || this.busy) return this._last;
    const t0 = Date.now();
    const a = this.api;
    try {
      const st = await this._call(a.libvlc_media_player_get_state, this.player);
      if (typeof st === 'number') this._last.state = st;
    } catch {}
    try {
      const t = await this._call(a.libvlc_media_player_get_time, this.player);
      if (t !== undefined && t !== null) this._last.time = Number(t);
    } catch {}
    try {
      const l = await this._call(a.libvlc_media_player_get_length, this.player);
      if (l !== undefined && l !== null) this._last.length = Number(l);
    } catch {}
    // El volumen REAL del motor: la caché optimista puede divergir (y entonces
    // la interfaz marca 100 mientras el sonido sale bajo). Se relee del motor,
    // pero no en cada ciclo: el volumen cambia muy rara vez y cada llamada FFI
    // cuesta un paso por el hilo de trabajo de koffi.
    this._syncCount = (this._syncCount || 0) + 1;
    if (this._syncCount % 4 === 1) {
      try {
        const v = await this._call(a.libvlc_audio_get_volume, this.player);
        if (typeof v === 'number' && v >= 0) this._last.volume = v;
      } catch {}
      try {
        const m = await this._call(a.libvlc_audio_get_mute, this.player);
        if (typeof m === 'number') this._last.mute = !!m;
      } catch {}
      try {
        const spu = await this._call(a.libvlc_video_get_spu, this.player);
        if (typeof spu === 'number') this._last.spu = spu;
      } catch {}
    }
    // El coste de esta sincronización se mide: si sube, el sondeo se está
    // comiendo el hilo principal (y con él, la interfaz y el API).
    this.lastSyncMs = Date.now() - t0;
    return this._last;
  }
  // --- Ajustes: llamadas ASÍNCRONAS (una FFI síncrona puede congelar la app) --
  async setVolume(v) {
    const val = Math.max(0, Math.min(200, Math.round(v)));
    this._last.volume = val;
    if (!this.player) return -1;
    return this._call(this.api.libvlc_audio_set_volume, this.player, val);
  }
  getVolume() {
    // El volumen real se relee del motor en sync(); la caché es sólo el valor
    // optimista entre sincronizaciones.
    return this._last.volume;
  }
  async setMute(on) {
    this._last.mute = !!on;
    if (!this.player) return -1;
    return this._call(this.api.libvlc_audio_set_mute, this.player, on ? 1 : 0);
  }
  getMute() { return this._last.mute; }
  // La posición es redundante: se deriva de tiempo/duración (evita una llamada
  // FFI más en cada sondeo).
  getPosition() {
    const len = this.getLength();
    if (!len) return 0;
    return Math.max(0, Math.min(1, this.getTime() / len));
  }

  // --- Subtítulos (pistas SPU del medio actual) -------------------------------
  // Todas las lecturas/escrituras son ASÍNCRONAS (igual que el resto de FFI):
  // una llamada síncrona puede bloquear el hilo principal.
  async getSubtitleTrack() {
    if (!this.player) return -1;
    try { return await this._call(this.api.libvlc_video_get_spu, this.player); } catch { return -1; }
  }

  /** Selecciona una pista por su id (>=0) o desactiva subtítulos (-1). */
  async setSubtitleTrack(spuId) {
    if (!this.player) return -1;
    const id = spuId === null || spuId === undefined ? -1 : Math.trunc(Number(spuId));
    return this._enqueue(async () => {
      const rc = await this._call(this.api.libvlc_video_set_spu, this.player, id);
      this._last.spu = id;
      return rc;
    });
  }

  /**
   * Lista las pistas de subtítulos disponibles: [{ id, name, selected }].
   * Recorre la lista enlazada de libvlc_track_description_t con koffi.
   */
  /** Diagnóstico: número crudo de pistas SPU que ve libVLC ahora mismo. */
  async getSpuCountRaw() {
    if (!this.player) return -1;
    return this._enqueue(async () => {
      try { return await this._call(this.api.libvlc_video_get_spu_count, this.player); } catch { return -2; }
    });
  }

  async getSubtitleTracks() {
    if (!this.player) return [];
    return this._enqueue(async () => {
      const a = this.api;
      const tracks = [];
      try {
        const count = await this._call(a.libvlc_video_get_spu_count, this.player);
        const current = await this._call(a.libvlc_video_get_spu, this.player);
        this._last.spu = current;
        if (!count || count < 0) return [];
        // Estructura: { int i_id; char *psz_name; void *p_next } (registrada una
        // sola vez a nivel de módulo: redefinirla en cada llamada puede lanzar).
        let head = null;
        try { head = await this._call(a.libvlc_video_get_spu_description, this.player); } catch { head = null; }
        if (head && koffi.address(head) !== 0n) {
          let p = head;
          let guard = 0;
          while (p && koffi.address(p) !== 0n && guard++ < 64) {
            let d;
            try { d = koffi.decode(p, TRACK_DESC); } catch { break; }
            tracks.push({ id: d.i_id, name: String(d.psz_name || ('Pista ' + d.i_id)), selected: d.i_id === current });
            p = d.p_next; // void* -> external; address 0 = fin de lista
          }
          try { await this._call(a.libvlc_track_description_list_release, head); } catch {}
        }
        if (!tracks.length && count > 0) {
          // Fallback sin nombres: por índice.
          for (let i = 0; i < count; i++) tracks.push({ id: i, name: 'Pista ' + i, selected: i === current });
        }
        return tracks;
      } catch (e) {
        return [];
      }
    });
  }

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
