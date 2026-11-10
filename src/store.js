// Almacenamiento persistente de Ciudadan Media Player (listas, cola, historial).
//
// Se usa un fichero JSON con escritura atómica (tmp + rename): es simple, no
// añade ninguna base de datos nueva a la aplicación y sobrevive a reinicios.
// Los vídeos se identifican por su ID canónico de YouTube y conservan sus
// metadatos básicos para poder volver a mostrarlos sin volver a buscar.
import fs from 'node:fs';
import path from 'node:path';

export const FAVORITES_LIST_ID = 'favorites';
export const WATCH_LATER_LIST_ID = 'watch-later';

const SPECIAL_LISTS = [
  { id: FAVORITES_LIST_ID, name: 'Favoritos', special: true, system: true },
  { id: WATCH_LATER_LIST_ID, name: 'Ver más tarde', special: true, system: true },
];

function emptyData() {
  return {
    version: 1,
    lists: SPECIAL_LISTS.map((l) => ({ ...l, createdAt: new Date().toISOString(), items: [] })),
    queue: { items: [], currentId: null, autoAdvance: true },
    history: [],
  };
}

function slugId(name, taken) {
  const base = String(name || 'lista').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lista';
  let id = base; let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export class UserStore {
  constructor(filePath) {
    this.file = filePath;
    this.data = emptyData();
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.data = { ...emptyData(), ...raw };
          this.data.queue = { ...emptyData().queue, ...(raw.queue || {}) };
          this.data.lists = Array.isArray(raw.lists) ? raw.lists : emptyData().lists;
          this.data.history = Array.isArray(raw.history) ? raw.history : [];
        }
      }
    } catch (e) {
      // Un fichero corrupto no debe impedir arrancar: se conserva una copia y
      // se empieza de cero.
      try { fs.renameSync(this.file, this.file + '.corrupto-' + Date.now()); } catch {}
      this.data = emptyData();
    }
    this._ensureSpecialLists();
    return this.data;
  }

  _ensureSpecialLists() {
    for (const s of SPECIAL_LISTS) {
      let l = this.data.lists.find((x) => x.id === s.id);
      if (!l) {
        l = { ...s, createdAt: new Date().toISOString(), items: [] };
        this.data.lists.push(l);
      } else {
        l.name = s.name; l.special = true; l.system = true;
        if (!Array.isArray(l.items)) l.items = [];
      }
    }
  }

  // Escritura atómica y agrupada (no se escribe en cada micro-cambio).
  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch { return false; }
  }

  // --- listas ---------------------------------------------------------------
  lists() {
    return this.data.lists.map((l) => ({
      id: l.id, name: l.name, special: !!l.special, createdAt: l.createdAt,
      count: Array.isArray(l.items) ? l.items.length : 0,
    }));
  }

  list(id) {
    return this.data.lists.find((l) => l.id === id) || null;
  }

  createList(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('el nombre de la lista está vacío');
    const taken = new Set(this.data.lists.map((l) => l.id));
    const id = slugId(n, taken);
    const list = { id, name: n, special: false, createdAt: new Date().toISOString(), items: [] };
    this.data.lists.push(list);
    this.save();
    return list;
  }

  renameList(id, name) {
    const l = this.list(id);
    if (!l) throw new Error('no existe la lista ' + id);
    if (l.system) throw new Error('la lista "' + l.name + '" es del sistema y no se puede renombrar');
    const n = String(name || '').trim();
    if (!n) throw new Error('el nombre de la lista está vacío');
    l.name = n;
    this.save();
    return l;
  }

  deleteList(id) {
    const l = this.list(id);
    if (!l) throw new Error('no existe la lista ' + id);
    if (l.system) throw new Error('la lista "' + l.name + '" es del sistema y no se puede eliminar');
    this.data.lists = this.data.lists.filter((x) => x.id !== id);
    this.save();
    return true;
  }

  addToList(listId, item) {
    const l = this.list(listId);
    if (!l) throw new Error('no existe la lista ' + listId);
    if (!item || !item.id) throw new Error('vídeo sin id');
    if (!Array.isArray(l.items)) l.items = [];
    const existing = l.items.find((x) => x.id === item.id);
    if (existing) { Object.assign(existing, item); }
    else {
      l.items.push({
        id: item.id, title: item.title || item.id, url: item.url || null,
        channel: item.channel || null, duration: item.duration || null,
        thumbnail: item.thumbnail || null, viewCount: item.viewCount ?? null,
        publishedAt: item.publishedAt || null, addedAt: new Date().toISOString(),
      });
    }
    this.save();
    return l;
  }

  removeFromList(listId, itemId) {
    const l = this.list(listId);
    if (!l) throw new Error('no existe la lista ' + listId);
    l.items = (l.items || []).filter((x) => x.id !== itemId);
    this.save();
    return l;
  }

  moveInList(listId, from, to) {
    const l = this.list(listId);
    if (!l) throw new Error('no existe la lista ' + listId);
    const items = l.items || [];
    const i = Number(from), j = Number(to);
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= items.length || j >= items.length) {
      throw new Error('posición fuera de rango');
    }
    const [it] = items.splice(i, 1);
    items.splice(j, 0, it);
    this.save();
    return l;
  }

  // --- historial ------------------------------------------------------------
  addHistory(item) {
    if (!item || !item.id) return;
    this.data.history = (this.data.history || []).filter((h) => h.id !== item.id);
    this.data.history.unshift({
      id: item.id, title: item.title || item.id, url: item.url || null,
      channel: item.channel || null, duration: item.duration || null,
      thumbnail: item.thumbnail || null, at: new Date().toISOString(),
    });
    if (this.data.history.length > 200) this.data.history.length = 200;
    this.save();
  }

  history(limit = 50) { return (this.data.history || []).slice(0, limit); }
}
