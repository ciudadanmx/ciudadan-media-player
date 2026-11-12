// ContinuityEngine — decide CUÁNDO pasar al siguiente contenido y de dónde
// sale, sin tocar el reproductor (sólo emite decisiones vía callback).
//
// Modo de reproducción (independiente del modo de contenido):
//   'solo'     -> al finalizar, se detiene; la cola manual NO se modifica.
//   'continuo' -> al finalizar, pasa al siguiente según prioridad:
//       1. Cola manual del usuario (queue.nextItem()).
//       2. Cola automática ya preparada (hasta 3 candidatos de metadatos).
//       3. Descubrimiento nuevo (DiscoveryService).
//       4. Estado informativo: no hay candidatos.
//
// Garantías:
//  - Un único disparo por fin de medio (dedupe de eventos END repetidos).
//  - Los errores de búsqueda nunca detienen el reproductor actual.
//  - La proporción Música/Temas (modo personalizado) la aplica MixScheduler
//    sobre los candidatos; la cola manual siempre tiene prioridad absoluta.
import { MixScheduler } from './mix.js';
import { classifyItem } from './classifier.js';

const END_DEDUPE_MS = 1500;
const PREPARE_N = 3; // candidatos preparados de antemano (sólo metadatos)

export class ContinuityEngine {
  /**
   * @param {object} deps
   * @param {object} deps.queue       QueueManager
   * @param {object} deps.discovery   DiscoveryService
   * @param {MixScheduler} deps.mix   MixScheduler
   * @param {Function} deps.onPlay    (item, origin) => Promise  reproduce el siguiente
   * @param {Function} deps.log
   */
  constructor({ queue, discovery, mix, onPlay, log = () => {} } = {}) {
    if (!queue || !discovery || !onPlay) throw new Error('ContinuityEngine: faltan dependencias');
    this.queue = queue;
    this.discovery = discovery;
    this.mix = mix || new MixScheduler({ musicPct: 50 });
    this.onPlay = onPlay;
    this.log = log;
    this.mode = 'continuo';           // 'solo' | 'continuo'
    this.source = 'search';           // 'search' | 'channel' | 'topic' | 'discover'
    this.contentMode = 'temas';       // 'musica' | 'temas' | 'personalizado'
    this.autoQueue = [];              // cola automática preparada (metadatos)
    this.lastEndAt = 0;
    this.busy = false;                // hay una transición en curso
    this.lastDecision = null;
  }

  setMode(mode) {
    this.mode = mode === 'solo' ? 'solo' : 'continuo';
    // Coherencia con el interruptor existente de la cola: "continuo" = autoavance.
    try { this.queue.setAutoAdvance(this.mode === 'continuo'); } catch {}
    return this.mode;
  }

  setSource(source) {
    this.source = ['search', 'channel', 'topic', 'discover'].includes(source) ? source : 'search';
    this.autoQueue = []; // cambia la fuente: se invalidan los candidatos preparados
    return this.source;
  }

  setContentMode(mode, mixCfg) {
    this.contentMode = ['musica', 'temas', 'personalizado'].includes(mode) ? mode : 'temas';
    if (mixCfg && typeof mixCfg.musicPct === 'number') this.mix.setRatio(mixCfg.musicPct);
    if (mixCfg && (mixCfg.musicCount || mixCfg.themeCount)) this.mix.setRatioFromCounts(mixCfg.musicCount, mixCfg.themeCount);
  }

  /**
   * Llamar cuando el medio termina (prev === 'playing').
   * Devuelve la decisión tomada (para pruebas y log).
   */
  async handleEnded({ current = null, searchQuery = '', signal = null } = {}) {
    const now = Date.now();
    if (now - this.lastEndAt < END_DEDUPE_MS) {
      this.log('continuidad: END duplicado ignorado');
      return { action: 'ignored-duplicate' };
    }
    this.lastEndAt = now;
    if (this.mode === 'solo') {
      this.log('continuidad: modo "solo este" -> se detiene al finalizar');
      return { action: 'stop' };
    }
    if (this.busy) return { action: 'busy' };
    this.busy = true;
    try {
      // 1) Cola manual del usuario (prioridad absoluta; respeta autoAdvance).
      if (this.queue.autoAdvance && this.queue.items.length && this.queue.currentIndex >= 0) {
        const next = this.queue.nextItem();
        if (next) {
          this.log('continuidad: cola manual ->', next.title || next.id);
          const decision = { action: 'play', origin: 'queue', item: next };
          this.lastDecision = decision;
          setTimeout(() => { this.onPlay(next, 'system').catch((e) => this.log('continuidad: error al reproducir cola:', String(e.message || e))); }, 400);
          return decision;
        }
      }
      // 2) Cola automática ya preparada.
      if (this.autoQueue.length) {
        const item = this.autoQueue.shift();
        this.log('continuidad: cola automática ->', item.title || item.id);
        const decision = { action: 'play', origin: 'auto', item };
        this.lastDecision = decision;
        setTimeout(() => { this.onPlay(item, 'system').catch((e) => this.log('continuidad: error auto:', String(e.message || e))); }, 400);
        return decision;
      }
      // 3) Descubrimiento nuevo (sólo metadatos, hasta 3 preparados).
      //    Un error de red/búsqueda NUNCA debe detener la reproducción actual.
      const exclude = this.queue.items.map((i) => i.id).concat(current ? [String(current.id)] : []);
      let candidates = [];
      try {
        candidates = await this.discovery.candidatesFor({
          source: this.source, current, searchQuery,
          limit: Math.max(10, PREPARE_N * 3), signal, excludeIds: exclude,
        }) || [];
      } catch (e) {
        this.log('continuidad: descubrimiento falló (tolerado):', String((e && e.message) || e));
        return { action: 'no-candidates' };
      }
      if (!candidates.length) {
        this.log('continuidad: sin candidatos (fuente:', this.source + ')');
        return { action: 'no-candidates' };
      }
      // Filtrar por modo de contenido y mezclar si es personalizado.
      const filtered = this._filterByContentMode(candidates);
      const pool = filtered.length ? filtered : candidates; // si el filtro lo vacía, no bloquear
      // Preparar hasta 3 para la cola automática; elegir el primero con la mezcla.
      const prepared = pool.slice(0, Math.max(PREPARE_N, Math.min(10, pool.length)));
      this.autoQueue = prepared.slice(1, PREPARE_N + 1).map((c) => c.item ? c.item : c);
      const pick = this.contentMode === 'personalizado'
        ? this.mix.pick(prepared.map((c) => ({ item: c, cls: c.classification || classifyItem(c) })))
        : { item: prepared[0], cls: prepared[0].classification, type: prepared[0].classification };
      if (!pick || !pick.item) return { action: 'no-candidates' };
      this.log('continuidad: descubrimiento (' + this.source + ') ->', pick.item.title || pick.item.id,
        this.contentMode === 'personalizado' ? 'mezcla=' + this.mix.stats().actualMusicPct?.toFixed(0) + '% música' : '');
      const decision = { action: 'play', origin: 'discover', item: pick.item };
      this.lastDecision = decision;
      setTimeout(() => { this.onPlay(pick.item, 'system').catch((e) => this.log('continuidad: error descubrimiento:', String(e.message || e))); }, 400);
      return decision;
    } finally {
      this.busy = false;
    }
  }

  _filterByContentMode(candidates) {
    if (this.contentMode === 'musica') return candidates.filter((c) => (c.classification || classifyItem(c)) === 'music');
    if (this.contentMode === 'temas') return candidates.filter((c) => (c.classification || classifyItem(c)) !== 'music');
    return candidates; // personalizado: la mezcla decide
  }

  snapshot() {
    return {
      mode: this.mode, source: this.source, contentMode: this.contentMode,
      autoQueueLength: this.autoQueue.length,
      mix: this.mix.stats(),
      lastDecision: this.lastDecision ? { action: this.lastDecision.action, origin: this.lastDecision.origin, id: this.lastDecision.item && this.lastDecision.item.id } : null,
    };
  }
}
