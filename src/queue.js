// Cola de reproducción multimedia de Ciudadan Media Player.
//
// - Cola REAL y persistente (vive en src/store.js): añadir, quitar, reordenar,
//   vaciar, saber cuál suena, avanzar y retroceder.
// - Al reproducir un vídeo, la cola lo sitúa como elemento actual (si no está,
//   se inserta justo detrás) para que "siguiente"/"anterior" tengan sentido.
// - NO se resuelve ni se descarga ningún flujo al añadir: sólo se guarda la
//   referencia (id + metadatos). El flujo se resuelve cuando toca reproducir.
// - Es una cola independiente de las colas del TTS (no se tocan).
export class QueueManager {
  constructor(store) {
    this.store = store;
    this._ensure();
  }

  _ensure() {
    const q = this.store.data.queue;
    if (!q || typeof q !== 'object') {
      this.store.data.queue = { items: [], currentId: null, autoAdvance: true };
    }
    if (!Array.isArray(this.store.data.queue.items)) this.store.data.queue.items = [];
    if (this.store.data.queue.autoAdvance === undefined) this.store.data.queue.autoAdvance = true;
  }

  get items() { return this.store.data.queue.items; }
  get autoAdvance() { return !!this.store.data.queue.autoAdvance; }

  setAutoAdvance(on) {
    this.store.data.queue.autoAdvance = !!on;
    this.store.save();
    return this.autoAdvance;
  }

  indexOf(id) { return this.items.findIndex((x) => x.id === id); }
  get currentIndex() { return this.indexOf(this.store.data.queue.currentId); }
  get current() {
    const i = this.currentIndex;
    return i >= 0 ? this.items[i] : null;
  }

  _normalize(item) {
    return {
      id: String(item.id),
      title: item.title || item.id,
      url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
      channel: item.channel || null,
      duration: item.duration || null,
      thumbnail: item.thumbnail || null,
      viewCount: item.viewCount ?? null,
      publishedAt: item.publishedAt || null,
      addedAt: item.addedAt || new Date().toISOString(),
    };
  }

  /**
   * Añade un vídeo a la cola.
   * @param {object} item
   * @param {'end'|'next'} position  'next' lo inserta justo después del actual
   */
  add(item, position = 'end') {
    if (!item || !item.id) throw new Error('vídeo sin id');
    const norm = this._normalize(item);
    const existing = this.indexOf(norm.id);
    if (existing >= 0) {
      Object.assign(this.items[existing], norm);
      this.store.save();
      return { item: this.items[existing], index: existing, added: false };
    }
    let at = this.items.length;
    if (position === 'next') {
      const cur = this.currentIndex;
      at = cur >= 0 ? cur + 1 : 0;
    }
    this.items.splice(at, 0, norm);
    this.store.save();
    return { item: norm, index: at, added: true };
  }

  remove(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) throw new Error('índice fuera de rango');
    const [it] = this.items.splice(i, 1);
    // Si se quita el que sonaba, el actual pasa al siguiente (o al anterior).
    if (this.store.data.queue.currentId === it.id) {
      const nextId = this.items[i] ? this.items[i].id : (this.items[i - 1] ? this.items[i - 1].id : null);
      this.store.data.queue.currentId = nextId;
    }
    this.store.save();
    return { removed: it, index: i };
  }

  move(from, to) {
    const a = Number(from), b = Number(to);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= this.items.length || b >= this.items.length) {
      throw new Error('posición fuera de rango');
    }
    const [it] = this.items.splice(a, 1);
    this.items.splice(b, 0, it);
    this.store.save();
    return { item: it, from: a, to: b };
  }

  clear() {
    const n = this.items.length;
    this.items.length = 0;
    this.store.data.queue.currentId = null;
    this.store.save();
    return { cleared: n };
  }

  /** Marca el vídeo que está sonando (sin resolverlo). */
  setCurrent(id) {
    if (!id) return null;
    const i = this.indexOf(id);
    if (i >= 0) { this.store.data.queue.currentId = id; this.store.save(); }
    return i >= 0 ? this.items[i] : null;
  }

  /**
   * Asegura que el vídeo que se va a reproducir forma parte de la cola y
   * queda como actual. Si no está, se inserta detrás del actual.
   */
  ensureCurrent(item) {
    if (!item || !item.id) return null;
    let i = this.indexOf(item.id);
    if (i < 0) {
      const cur = this.currentIndex;
      const at = cur >= 0 ? cur + 1 : 0;
      this.items.splice(at, 0, this._normalize(item));
      i = at;
    } else {
      Object.assign(this.items[i], this._normalize(item));
    }
    this.store.data.queue.currentId = this.items[i].id;
    this.store.save();
    return this.items[i];
  }

  nextItem() {
    const cur = this.currentIndex;
    if (cur < 0) return this.items[0] || null;
    return this.items[cur + 1] || null;
  }

  previousItem() {
    const cur = this.currentIndex;
    if (cur <= 0) return null;
    return this.items[cur - 1] || null;
  }

  /** Instantánea para la interfaz y para la API. */
  snapshot() {
    const cur = this.currentIndex;
    return {
      items: this.items.map((it, i) => ({ ...it, position: i, current: i === cur })),
      length: this.items.length,
      currentIndex: cur,
      currentId: cur >= 0 ? this.items[cur].id : null,
      autoAdvance: this.autoAdvance,
    };
  }
}
