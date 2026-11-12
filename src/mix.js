// MixScheduler — rotación ponderada (Bresenham) para mezclar Música y Temas
// según una proporción configurada.
//
// Propiedades:
//  - Proporción exacta a largo plazo: el acumulador suma musicPct por
//    selección y descuenta 100 al tocar música (p.ej. 70/30 -> ~70/30 en
//    1000 selecciones, error <= 1%).
//  - No depende de aleatoriedad.
//  - Evita rachas largas del mismo tipo en la medida en que la proporción lo
//    permite: la racha máxima natural queda acotada por
//    ceil(100 / min(pct, 100-pct)) (50/50 alterna; 70/30 a lo sumo ~3 seguidas).
//  - Si falta contenido de un tipo, usa el otro sin bloquear; el crédito se
//    guarda (tope 100) y la proporción se recupera progresivamente cuando
//    vuelven a haber candidatos.
//
// Uso:
//   const mix = new MixScheduler({ musicPct: 70 });
//   const pick = mix.pick([{ item, cls: 'music' }, { item, cls: 'theme' }, ...]);
export class MixScheduler {
  constructor({ musicPct = 50, maxRun = 2 } = {}) {
    this.maxRun = Math.max(1, maxRun | 0); // se conserva por compatibilidad (la racha la fija la proporción)
    this.setRatio(musicPct);
    this.reset();
  }

  reset() {
    this.acc = 0;          // acumulador Bresenham (crédito hacia "music")
    this.count = { music: 0, theme: 0 };
    this.lastType = null;
    this.run = 0;          // seguidas del mismo tipo
  }

  /** musicPct: 0..100 de música; el resto es temas. */
  setRatio(musicPct) {
    const p = Math.max(0, Math.min(100, Number(musicPct) || 0));
    this.musicPct = p;
    this.themePct = 100 - p;
  }

  /** Proporción derivada de cantidades por ciclo (música 2 / temas 1 -> ~67/33). */
  setRatioFromCounts(musicCount, themeCount) {
    const m = Math.max(0, Number(musicCount) || 0);
    const t = Math.max(0, Number(themeCount) || 0);
    if (m + t > 0) this.setRatio((m / (m + t)) * 100);
  }

  /**
   * Elige un candidato de la lista (Bresenham sobre la proporción).
   * @param {Array<{item:any, cls:string|null}>} candidates cls: 'music'|'theme'|null (desconocido = comodín)
   * @returns {{item:any, cls:string|null, type:string}|null}
   */
  pick(candidates) {
    const list = (candidates || []).filter((c) => c && c.item);
    if (!list.length) return null;

    const hasMusic = list.some((c) => c.cls === 'music' || c.cls == null);
    const hasTheme = list.some((c) => c.cls === 'theme' || c.cls == null);

    // Bresenham: cada selección suma musicPct al acumulador; al llegar a 100
    // toca música y se descuenta. La racha máxima natural queda acotada por
    // ceil(100 / min(pct, 100-pct)) (p.ej. 50/50 alterna, 70/30 a lo sumo 3
    // seguidas): la proporción permite alternar justo hasta ahí.
    const tentative = this.acc + this.musicPct;
    let type;
    if (tentative >= 100) {
      if (hasMusic) { this.acc = tentative - 100; type = 'music'; }
      else { type = 'theme'; this.acc = Math.min(tentative, 100); } // crédito guardado (tope 100): se recupera después
    } else {
      if (hasTheme) { this.acc = tentative; type = 'theme'; }
      else { type = 'music'; this.acc = Math.min(tentative, 100); }
    }
    // El acumulador se mantiene acotado (la recuperación es progresiva).
    if (this.acc > 100) this.acc = 100;
    if (this.acc < 0) this.acc = 0;

    // Dentro del tipo elegido: primero los de ese tipo; los comodines (cls
    // null) sólo si no hay ninguno estricto del tipo elegido.
    const strict = list.filter((c) => c.cls === type);
    const pool = strict.length ? strict : list;
    const chosen = pool[0];
    return this._record(chosen, type);
  }

  _record(candidate, type) {
    this.count[type]++;
    if (this.lastType === type) this.run++; else { this.lastType = type; this.run = 1; }
    return { item: candidate.item, cls: candidate.cls || type, type };
  }

  /** Estadísticas del balance acumulado (pruebas y depuración). */
  stats() {
    const total = this.count.music + this.count.theme;
    return {
      total,
      music: this.count.music,
      theme: this.count.theme,
      musicPct: this.musicPct,
      actualMusicPct: total ? (this.count.music / total) * 100 : null,
      acc: this.acc,
      lastType: this.lastType,
      run: this.run,
    };
  }
}
