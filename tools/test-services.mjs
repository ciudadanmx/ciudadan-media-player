// ===========================================================================
// Pruebas unitarias de los servicios del sprint (sin Electron, sin red):
//   ContentClassifier, MixScheduler, HistoryRepository, ContinuityEngine,
//   DiscoveryService y filtros del proveedor de búsqueda.
//
// Uso: node tools/test-services.mjs
// ===========================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyItem } from '../src/classifier.js';
import { MixScheduler } from '../src/mix.js';
import { HistoryRepository } from '../src/history.js';
import { ContinuityEngine } from '../src/continuity.js';
import { DiscoveryService, topicQueriesFrom } from '../src/discovery.js';
import { buildSearchArgs, applyLocalFilters } from '../src/search/ytdlp-provider.js';
import { UserStore } from '../src/store.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL | ' + name + (detail ? '  -> ' + detail : '')); }
}

// ---------------------------------------------------------------- classifier
console.log('\n== ContentClassifier ==');
check('categoría Music => música', classifyItem({ title: 'Lo que sea', category: 'Music' }) === 'music');
check('official video => música', classifyItem({ title: 'Artista - Tema (Official Video)' }) === 'music');
check('canal VEVO => música', classifyItem({ title: 'Tema nuevo', channel: 'CanalVEVO' }) === 'music');
check('documental => tema', classifyItem({ title: 'El universo explicado (Documental)' }) === 'theme');
check('tutorial how to => tema', classifyItem({ title: 'How to bake bread' }) === 'theme');
check('entrevista podcast => tema', classifyItem({ title: 'Entrevista con el autor' }) === 'theme');
check('sin señal => null', classifyItem({ title: 'xyz123 abc' }) === null);

// ---------------------------------------------------------------- mix
console.log('\n== MixScheduler (weighted round-robin) ==');
{
  const mix = new MixScheduler({ musicPct: 70 });
  const pool = [
    { item: { id: 'm1' }, cls: 'music' }, { item: { id: 'm2' }, cls: 'music' },
    { item: { id: 't1' }, cls: 'theme' }, { item: { id: 't2' }, cls: 'theme' },
  ];
  let maxRun = 0, run = 0, last = null;
  for (let i = 0; i < 1000; i++) {
    const p = mix.pick(pool);
    if (p.type === last) run++; else { run = 1; last = p.type; }
    maxRun = Math.max(maxRun, run);
  }
  const st = mix.stats();
  check('proporción 70/30 a largo plazo (±2%)', Math.abs(st.actualMusicPct - 70) <= 2, `real=${st.actualMusicPct.toFixed(2)}% de ${st.total}`);
  // La racha máxima natural de Bresenham para 70/30 es ceil(100/30)=4.
  check('racha acotada por la proporción (<=4 en 70/30)', maxRun <= 4, `maxRun=${maxRun}`);
  check('balance acumulado conservado', st.music + st.theme === 1000, `${st.music}+${st.theme}`);
}
{
  // 50/50 debe alternar casi siempre (la proporción lo permite).
  const mix = new MixScheduler({ musicPct: 50 });
  const pool = [{ item: { id: 'm' }, cls: 'music' }, { item: { id: 't' }, cls: 'theme' }];
  let maxRun = 0, run = 0, last = null;
  for (let i = 0; i < 500; i++) {
    const p = mix.pick(pool);
    if (p.type === last) run++; else { run = 1; last = p.type; }
    maxRun = Math.max(maxRun, run);
  }
  check('50/50 alterna (racha <=2)', maxRun <= 2, `maxRun=${maxRun}`);
  const st = mix.stats();
  check('50/50 exacto', Math.abs(st.actualMusicPct - 50) <= 2, `real=${st.actualMusicPct.toFixed(2)}%`);
}
{
  // Si falta un tipo, usa el otro sin bloquear y recupera progresivamente.
  const mix = new MixScheduler({ musicPct: 50 });
  const themeOnly = [{ item: { id: 't1' }, cls: 'theme' }];
  const all = themeOnly.concat([{ item: { id: 'm1' }, cls: 'music' }]);
  for (let i = 0; i < 20; i++) mix.pick(themeOnly); // sólo temas disponibles
  const st1 = mix.stats();
  check('fallback: sin música disponible no bloquea', st1.theme === 20 && st1.music === 0);
  for (let i = 0; i < 20; i++) mix.pick(all);     // vuelven ambos
  const st2 = mix.stats();
  check('recuperación progresiva al volver candidatos (50% de los nuevos)', st2.music >= 8 && st2.music <= 12, `music=${st2.music}/40 total`);
}
{
  const mix = new MixScheduler();
  mix.setRatioFromCounts(2, 1);
  check('cantidades 2/1 => ~67%', Math.abs(mix.musicPct - 200 / 3) < 0.01, `pct=${mix.musicPct}`);
  const before = mix.musicPct;
  mix.setRatioFromCounts(0, 0);
  check('cantidades 0/0 no cambian la proporción', mix.musicPct === before);
}

// ---------------------------------------------------------------- history
console.log('\n== HistoryRepository ==');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-hist-'));
  const store = new UserStore(path.join(dir, 'store.json'));
  const repo = new HistoryRepository(store);

  const e1 = repo.recordPlay({ id: 'abc123', title: 'Vídeo Uno', channel: 'Canal A', url: 'https://www.youtube.com/watch?v=abc123', duration: 600 }, { context: 'rock' });
  check('primera reproducción crea registro', !!e1 && e1.playCount === 1 && e1.status === 'started');
  check('clasificación automática', e1.classification !== undefined);

  repo.updateProgress('abc123', 100000, 600000, { force: true });
  let e = repo.get('abc123');
  check('progreso parcial no duplica ni infla contador', e.playCount === 1 && e.status === 'partial' && e.positionMs === 100000);

  repo.updateProgress('abc123', 590000, 600000, { force: true });
  e = repo.get('abc123');
  check('>=95% => finished', e.status === 'finished');

  repo.recordPlay({ id: 'abc123', title: 'Vídeo Uno', url: 'https://www.youtube.com/watch?v=abc123', duration: 600 });
  e = repo.get('abc123');
  check('reproducir de nuevo: playCount=2, mismo id, sin duplicado', e.playCount === 2 && store.data.history.filter((h) => h.id === e.id).length === 1);

  repo.recordPlay({ id: 'def456', title: 'Official Video - Banda', channel: 'BandaVEVO', duration: 200 });
  const q1 = repo.query({ tab: 'music' });
  check('filtro Música del historial', q1.items.every((h) => h.classification === 'music') && q1.items.length === 1, `items=${q1.items.map((x) => x.sourceId)}`);
  const q2 = repo.query({ q: 'banda' }); // búsqueda 100% local
  check('búsqueda local por título/canal', q2.total === 1 && q2.items[0].sourceId === 'def456');
  const q3 = repo.query({ sort: 'mostPlayed' });
  check('orden más reproducidos', q3.items[0].sourceId === 'abc123');
  const q4 = repo.query({ offset: 1, limit: 1 });
  check('paginación', q4.items.length === 1 && q4.total === 2 && q4.offset === 1);

  // Migración de entrada antigua
  store.data.history.push({ id: 'viejo1', title: 'Viejo', url: 'https://youtu.be/viejo1', at: '2026-01-01T00:00:00Z' });
  const repo2 = new HistoryRepository(store);
  const old = repo2.get('viejo1');
  check('migración de esquema antiguo', !!old && old.provider === 'ytdlp' && old.status === 'started' && old.playCount === 1);

  const exp = JSON.parse(repo.exportJSON());
  check('export JSON válido con playHistory y searchHistory', Array.isArray(exp.playHistory) && Array.isArray(exp.searchHistory));

  repo.recordSearch({ query: 'rock', filters: { sort: 'date' }, mode: 'temas' });
  repo.recordSearch({ query: 'rock', filters: { sort: 'date' }, mode: 'temas' });
  repo.recordSearch({ query: 'rock', filters: {}, mode: 'temas' });
  const sh = repo.listSearches();
  check('historial de búsquedas sin duplicados (misma query+filtros+modo)', sh.filter((s) => s.query === 'rock').length === 2 && sh.find((s) => s.query === 'rock' && s.filtersKey.includes('date')).count === 2);

  repo.remove('def456');
  check('eliminar entrada', repo.get('def456') === null);
  check('get acepta id interno y sourceId', repo.get('ytdlp:abc123') === repo.get('abc123') && !!repo.get('ytdlp:abc123'));
  const before = store.data.history.length;
  const cleared = repo.clear('all');
  check('borrar todo el historial', cleared.removed === before && store.data.history.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- continuity
console.log('\n== ContinuityEngine ==');
{
  const mkQueue = (items, currentId) => ({
    items, autoAdvance: true,
    currentIndex: items.findIndex((i) => i.id === currentId),
    setAutoAdvance(on) { this.autoAdvance = on; },
    nextItem() { const c = this.currentIndex; return c >= 0 ? (this.items[c + 1] || null) : (this.items[0] || null); },
  });
  let played = [];
  const onPlay = async (item) => { played.push(item.id); };

  // 1) modo solo
  {
    const q = mkQueue([{ id: 'a' }, { id: 'b' }], 'a');
    const disc = { candidatesFor: async () => [{ id: 'x', title: 'X', classification: 'theme' }] };
    const eng = new ContinuityEngine({ queue: q, discovery: disc, onPlay, log: () => {} });
    eng.setMode('solo');
    const d = await eng.handleEnded({ current: { id: 'a' } });
    check('modo "solo este" => stop (no autoavance)', d.action === 'stop');
    check('modo solo no modifica la cola', q.items.length === 2 && q.autoAdvance === false);
    await new Promise((r) => setTimeout(r, 600));
    check('modo solo no reproduce nada', played.length === 0);
  }
  // 2) prioridad: cola manual > cola automática > descubrimiento
  {
    played = [];
    const q = mkQueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a');
    const disc = { candidatesFor: async () => [{ id: 'x', classification: 'theme' }, { id: 'y', classification: 'music' }] };
    const eng = new ContinuityEngine({ queue: q, discovery: disc, onPlay, log: () => {} });
    eng.setMode('continuo');
    const d = await eng.handleEnded({ current: { id: 'a' } });
    check('prioridad 1: cola manual', d.action === 'play' && d.origin === 'queue' && d.item.id === 'b');
    await new Promise((r) => setTimeout(r, 600));
    check('se reprodujo el siguiente de la cola', played.join(',') === 'b');
    // END duplicado inmediato: se ignora
    const d2 = await eng.handleEnded({ current: { id: 'b' } });
    check('END duplicado se ignora (sin doble disparo)', d2.action === 'ignored-duplicate');
    // sin siguiente en cola manual: va a descubrimiento
    const q2 = mkQueue([{ id: 'c' }], 'c');
    const eng2 = new ContinuityEngine({ queue: q2, discovery: disc, onPlay, log: () => {} });
    eng2.setMode('continuo');
    eng2.lastEndAt = 0;
    const d3 = await eng2.handleEnded({ current: { id: 'c' } });
    check('prioridad 3: descubrimiento cuando la cola manual no tiene siguiente', d3.action === 'play' && d3.origin === 'discover');
    check('se preparan hasta 3 candidatos en la cola automática', eng2.autoQueue.length <= 3, `autoQueue=${eng2.autoQueue.length}`);
  }
  // 3) cola automática preparada antes que descubrimiento nuevo
  {
    played = [];
    const q = mkQueue([], null);
    const calls = { disc: 0 };
    const disc = { candidatesFor: async () => { calls.disc++; return [{ id: 'n1', classification: 'theme' }, { id: 'n2', classification: 'theme' }, { id: 'n3', classification: 'theme' }, { id: 'n4', classification: 'theme' }]; } };
    const eng = new ContinuityEngine({ queue: q, discovery: disc, onPlay, log: () => {} });
    eng.setMode('continuo');
    await eng.handleEnded({ current: { id: 'z' } });
    check('descubrimiento inicial prepara cola automática', eng.autoQueue.length === 3);
    eng.lastEndAt = 0;
    const d = await eng.handleEnded({ current: { id: 'n1' } });
    check('prioridad 2: cola automática antes de nuevo descubrimiento', d.origin === 'auto' && calls.disc === 1, `discCalls=${calls.disc} origin=${d.origin}`);
  }
  // 4) error de búsqueda tolerado
  {
    const q = mkQueue([], null);
    const disc = { candidatesFor: async () => { throw new Error('red caída'); } };
    const eng = new ContinuityEngine({ queue: q, discovery: disc, onPlay, log: () => {} });
    eng.setMode('continuo');
    const d = await eng.handleEnded({ current: { id: 'z' } });
    check('error de descubrimiento no rompe el reproductor', d.action === 'no-candidates');
  }
  // 5) modo personalizado usa la mezcla
  {
    const q = mkQueue([], null);
    const disc = { candidatesFor: async () => [
      { id: 'm1', classification: 'music' }, { id: 't1', classification: 'theme' },
      { id: 'm2', classification: 'music' }, { id: 't2', classification: 'theme' },
    ] };
    const eng = new ContinuityEngine({ queue: q, discovery: disc, onPlay, log: () => {} });
    eng.setMode('continuo');
    eng.setContentMode('personalizado', { musicPct: 100 });
    const d = await eng.handleEnded({ current: { id: 'z' } });
    check('modo personalizado 100% música elige música', d.item && d.item.classification === 'music', `elegido=${d.item && d.item.id}`);
  }
}

// ---------------------------------------------------------------- discovery
console.log('\n== DiscoveryService ==');
{
  const qs = topicQueriesFrom({ title: 'Pink Floyd - Comfortably Numb (Official Music Video) HD', channel: 'Pink Floyd' }, 3);
  check('consultas de tema derivadas del título (sin relatedToVideoId)', qs.length >= 1 && /pink|floyd|comfortably|numb/i.test(qs[0]), JSON.stringify(qs));
  check('sin relatedToVideoId en ninguna consulta', qs.every((q) => !/related/i.test(q)));

  const seen = [];
  const search = async (q) => { seen.push(q); return { items: [
    { id: 'v1', title: q + ' resultado 1' }, { id: 'cur', title: 'actual' }, { id: 'v1', title: 'duplicado' },
  ] }; };
  const fetchFlat = async (url) => ({ items: [{ id: 'ch1', title: 'del canal' }] });
  const disc = new DiscoveryService({ search, fetchFlat, log: () => {} });
  const r1 = await disc.candidatesFor({ source: 'channel', current: { id: 'cur', channelUrl: 'https://www.youtube.com/@x/videos' }, limit: 10 });
  check('fuente "mismo canal" usa el canal y excluye el actual', r1.some((c) => c.id === 'ch1') && !r1.some((c) => c.id === 'cur'));
  const r2 = await disc.candidatesFor({ source: 'topic', current: { id: 'cur', title: 'Aprende física cuántica explicada' }, limit: 10 });
  check('fuente "tema" deriva consultas del título', r2.length >= 1 && seen.some((q) => /física|fisica|cuántica|cuantica/i.test(q)), `queries=${JSON.stringify(seen.slice(-3))}`);
  const r3 = await disc.candidatesFor({ source: 'search', searchQuery: 'lofi beats', limit: 5 });
  check('fuente "mi búsqueda" reutiliza la consulta activa', r3.length >= 1 && seen.includes('lofi beats'));
  const discErr = new DiscoveryService({ search: async () => { throw new Error('boom'); }, log: () => {} });
  const r4 = await discErr.candidatesFor({ source: 'search', searchQuery: 'x' });
  check('error de red en descubrimiento => lista vacía, sin lanzar', Array.isArray(r4) && r4.length === 0);
  check('candidatos clasificados', r1.every((c) => 'classification' in c));

  // --- Regresión del usuario: sin búsqueda activa NO puede quedarse sin candidatos ---
  const seen2 = [];
  const search2 = async (q) => {
    seen2.push(q);
    return { items: [{ id: 'rel' + seen2.length, title: 'relacionado para ' + q }, { id: 'cur', title: 'el actual' }] };
  };
  const disc2 = new DiscoveryService({ search: search2, log: () => {} });
  const r5 = await disc2.candidatesFor({ source: 'search', searchQuery: '', current: { id: 'cur', title: 'Me at the zoo' }, limit: 5 });
  check('sin búsqueda activa busca relacionados por metadatos (tema/canal/título)', r5.length >= 1 && seen2.length >= 1, `queries=${JSON.stringify(seen2)}`);
  check('excluye el vídeo actual', !r5.some((c) => c.id === 'cur'));
  const r6 = await disc2.candidatesFor({ source: 'topic', current: { id: 'cur', title: 'Me at the zoo' }, limit: 5 });
  check('fuente "tema" usa el título aunque no haya palabras largas', r6.length >= 1 && seen2.some((q) => /me at the zoo/i.test(q)), `queries=${JSON.stringify(seen2.slice(-3))}`);
  const r7 = await disc2.candidatesFor({ source: 'search', searchQuery: 'consulta activa', current: { id: 'cur', title: 'Big Buck Bunny' }, limit: 5 });
  check('con búsqueda activa se usa primero esa consulta', seen2.includes('consulta activa'));
}

// ------------------------------------------------- continuidad: caso "sin búsqueda"
console.log('\n== Continuidad: continuar sin búsqueda activa ==');
{
  const played = [];
  const search = async (q) => ({ items: [{ id: 'rel1', title: 'relacionado: ' + q }] });
  const disc = new DiscoveryService({ search, log: () => {} });
  const q = { items: [], currentIndex: -1, autoAdvance: true, nextItem: () => null, setAutoAdvance: () => {} };
  const eng = new ContinuityEngine({
    queue: q, discovery: disc, mix: new MixScheduler({ musicPct: 50 }),
    onPlay: async (it) => { played.push(it.id); }, log: () => {},
  });
  eng.setMode('continuo');
  eng.setSource('search');
  // Sin búsqueda activa y con el vídeo actual con metadatos:
  const d = await eng.handleEnded({ current: { id: 'cur', title: 'Me at the zoo', channel: 'zoosworld' }, searchQuery: '' });
  check('sin búsqueda activa CONTINÚA con un vídeo relacionado', d.action === 'play' && d.origin === 'discover', JSON.stringify(d));
  await new Promise((r) => setTimeout(r, 700));
  check('se reproduce el candidato encontrado', played.length === 1, `played=${JSON.stringify(played)}`);

  // Preparación anticipada: deja candidatos listos para el final del medio.
  const eng2 = new ContinuityEngine({
    queue: { items: [], currentIndex: -1, autoAdvance: true, nextItem: () => null, setAutoAdvance: () => {} },
    discovery: disc, onPlay: async () => {}, log: () => {},
  });
  const prep = await eng2.prepare({ current: { id: 'cur', title: 'Big Buck Bunny' }, searchQuery: '' });
  check('preparación anticipada deja candidatos listos', prep.action === 'prepared' && eng2.autoQueue.length >= 1 && eng2.autoQueue.length <= 3, JSON.stringify(prep));

  // Degradación: la fuente configurada falla -> se prueban las demás.
  let calls = [];
  const discAlt = new DiscoveryService({
    search: async (qq) => { calls.push(qq); return { items: [{ id: 'alt', title: 'de reserva' }] }; },
    fetchFlat: async () => { throw new Error('sin canal'); },
    log: () => {},
  });
  const eng3 = new ContinuityEngine({
    queue: { items: [], currentIndex: -1, autoAdvance: true, nextItem: () => null, setAutoAdvance: () => {} },
    discovery: discAlt, onPlay: async () => {}, log: () => {},
  });
  eng3.setMode('continuo');
  eng3.setSource('channel');
  const d3 = await eng3.handleEnded({ current: { id: 'cur', title: 'Tema sin canal' }, searchQuery: '' });
  check('fuente sin resultados degrada a otra fuente y continúa', d3.action === 'play', JSON.stringify(d3));
}

// ---------------------------------------------------------------- filtros proveedor
console.log('\n== Filtros del proveedor (sp de YouTube + locales) ==');
{
  const def = buildSearchArgs('pink floyd', { limit: 20, offset: 0, filters: {} });
  check('sin filtros: ruta clásica ytsearchN (compatibilidad)', def.args[def.args.length - 1].startsWith('ytsearch20:pink floyd') && !def.usedResultsUrl);
  const f1 = buildSearchArgs('pink floyd', { limit: 20, offset: 0, filters: { type: 'video', sort: 'date', duration: 'long', features: ['cc', 'hd'], date: 'week' } });
  check('con filtros: URL de resultados con sp', f1.usedResultsUrl && /results\?search_query=/.test(f1.args[f1.args.length - 1]) && /sp=/.test(f1.args[f1.args.length - 1]));
  const f2 = buildSearchArgs('x', { limit: 10, offset: 0, filters: { dateFrom: '2026-01-01', dateTo: '2026-02-01' } });
  check('intervalo personalizado usa --dateafter/--datebefore', f2.args.includes('--dateafter') && f2.args.includes('20260101') && f2.args.includes('--datebefore') && f2.args.includes('20260201'));
  const items = [
    { id: 'a', type: 'video', duration: 100, channel: 'Rock' },
    { id: 'b', type: 'short', url: 'https://www.youtube.com/shorts/b', duration: 30, channel: 'Pop' },
    { id: 'c', type: 'video', duration: 3000, channel: 'Rock' },
  ];
  check('filtro local shorts por URL', applyLocalFilters(items, { type: 'shorts' }).map((i) => i.id).join() === 'b');
  check('filtro local canal', applyLocalFilters(items, { channel: 'rock' }).length === 2);
  check('filtro local duración corta', applyLocalFilters(items, { duration: 'short' }).map((i) => i.id).join() === 'a,b');
  check('filtro local duración larga', applyLocalFilters(items, { duration: 'long' }).map((i) => i.id).join() === 'c');
}

console.log(`\n== ${pass}/${pass + fail} comprobaciones PASS ==`);
if (failures.length) console.log('FALLOS:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
