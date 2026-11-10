// Interfaz de proveedor de búsqueda + registro de proveedores.
// Un proveedor encapsulates CÓMO se buscan y detallan vídeos (YouTube hoy vía
// yt-dlp; mañana podría haber otro). La UI y el proceso principal sólo dependen
// de este contrato, así que añadir otro proveedor no obliga a tocar la interfaz.
//
// Contrato:
//   id          identificador estable del proveedor
//   name        nombre para la interfaz
//   capabilities filtros realmente soportados por el proveedor (no simulados)
//   search(query, {limit, offset, signal}) -> {items:[], hasMore:boolean}
//   details(idOrUrl) -> item|null
//
// El item normalizado tiene esta forma (sólo campos con dato real):
//   { id, title, url, channel, channelUrl, duration, viewCount,
//     publishedAt, description, thumbnail, thumbnails:[], isLive, provider }

export class SearchProvider {
  constructor() {
    if (new.target === SearchProvider) throw new Error('SearchProvider es una clase base');
  }

  get id() { return 'base'; }
  get name() { return 'Proveedor base'; }

  // Filtros que el proveedor REALMENTE puede aplicar. La interfaz sólo ofrece
  // los que devuelva esta lista (nada de filtros simulados).
  get capabilities() { return { filters: [], details: false, pagination: false }; }

  /** @returns {Promise<{items:Array, hasMore:boolean, total?:number}>} */
  async search(_query, _opts = {}) {
    throw new Error('search() no implementado en ' + this.id);
  }

  /** @returns {Promise<object|null>} metadatos completos del vídeo */
  async details(_idOrUrl) {
    return null;
  }
}

export class SearchRegistry {
  constructor() { this.providers = new Map(); this.defaultId = null; }

  register(provider) {
    if (!provider || !provider.id) throw new Error('proveedor sin id');
    this.providers.set(provider.id, provider);
    if (!this.defaultId) this.defaultId = provider.id;
    return provider;
  }

  get(id) {
    const p = this.providers.get(id || this.defaultId);
    if (!p) throw new Error('no hay proveedor de búsqueda: ' + (id || this.defaultId));
    return p;
  }

  default() { return this.get(this.defaultId); }

  list() {
    return [...this.providers.values()].map((p) => ({
      id: p.id, name: p.name, capabilities: p.capabilities,
    }));
  }
}
