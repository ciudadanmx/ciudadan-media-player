// ===========================================================================
// CIUDADAN MEDIA PLAYER — Sprint: modos de contenido, filtros avanzados,
// continuidad e historial persistente (capa de UI del explorador).
//
// Este módulo sólo PRESENTA estado y EMITE acciones: toda la lógica vive en
// el proceso principal (servicios reutilizables) y llega por window.cmp.
// Script clásico: define window.CMPExplorerSprint con wire(ctx).
// ===========================================================================
'use strict';
/* global window, document, CMPExplorerUtils */
(function () {
  const U = window.CMPExplorerUtils;

  const H_TABS = [['all', 'Todos'], ['music', 'Música'], ['theme', 'Temas'], ['pending', 'Pendientes'], ['finished', 'Terminados']];
  const H_SORTS = [['recent', 'Más recientes'], ['oldest', 'Más antiguos'], ['mostPlayed', 'Más reproducidos']];
  const H_PERIODS = [['all', 'Todo el historial'], ['today', 'Hoy'], ['week', 'Última semana'], ['month', 'Último mes']];
  const MIX_PRESETS = [['50/50', 50], ['70/30', 70], ['30/70', 30]];

  function wire(ctx) {
    const { cmp, root, state, input, doSearch, fetchPage, showTab, say, closeModal } = ctx;
    const { modes, mixPop, filterPop, filtersBtn, filterBadge, historyBtn, paneHistory } = ctx;

    let prefs = null;
    const S = { tab: 'all', q: '', sort: 'recent', offset: 0, limit: 30, total: 0, showSearches: false };
    let filterPopBuilt = false;
    let mixOpen = false, filterOpen = false;

    // ---------------------------------------------------------------- prefs
    async function loadPrefs() {
      try { const r = await cmp.prefs(); prefs = r.prefs || {}; }
      catch { prefs = { contentMode: 'temas', mix: { musicPct: 50 }, filters: {} }; }
      paintModes();
      paintFilterBadge();
    }

    function paintModes() {
      const mode = (prefs && prefs.contentMode) || 'temas';
      modes.querySelectorAll('.ex-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    }

    // ------------------------------------------------- modo de contenido
    modes.querySelectorAll('.ex-mode').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mode = b.dataset.mode;
        if (mode === 'personalizado') { openMixPop(); return; }
        try {
          await cmp.setContentMode({ mode });
          await loadPrefs();
          say('Modo: ' + b.textContent.trim());
          if (state.query) fetchPage(true);   // re-aplica el modo a la búsqueda activa
        } catch (err) { say('Error: ' + (err && err.message || err)); }
      });
    });

    // ------------------------------------------- popover "Personalizado"
    function openMixPop() {
      closePops();
      mixOpen = true;
      buildMixPop();
      mixPop.classList.add('show');
      positionPop(mixPop, modes);
    }

    function buildMixPop() {
      U.clear(mixPop);
      const mix = (prefs && prefs.mix) || { musicPct: 50, musicCount: 0, themeCount: 0 };
      mixPop.appendChild(U.el('div', { class: 'ex-pop-title', text: 'Personalizado' }));

      const row = U.el('div', { class: 'ex-mix-row' });
      row.appendChild(U.el('label', { class: 'ex-mix-label', text: 'Música', for: 'mixSlider' }));
      const slider = U.el('input', { id: 'mixSlider', type: 'range', min: '0', max: '100', step: '1', value: String(mix.musicPct ?? 50) });
      const pct = U.el('span', { id: 'mixPct', class: 'ex-mix-pct', text: (mix.musicPct ?? 50) + '%' });
      row.appendChild(slider); row.appendChild(pct);
      mixPop.appendChild(row);
      mixPop.appendChild(U.el('div', { class: 'ex-mix-sub', id: 'mixPctT', text: 'Temas: ' + (100 - (mix.musicPct ?? 50)) + '% (complementario)' }));

      const counts = U.el('div', { class: 'ex-mix-counts' });
      counts.appendChild(U.el('label', { text: 'Música por ciclo', for: 'mixCountM' }));
      const cM = U.el('input', { id: 'mixCountM', type: 'number', min: '0', max: '50', step: '1', value: String(mix.musicCount || ''), placeholder: 'auto' });
      counts.appendChild(cM);
      counts.appendChild(U.el('label', { text: 'Temas por ciclo', for: 'mixCountT' }));
      const cT = U.el('input', { id: 'mixCountT', type: 'number', min: '0', max: '50', step: '1', value: String(mix.themeCount || ''), placeholder: 'auto' });
      counts.appendChild(cT);
      mixPop.appendChild(counts);
      const preview = U.el('div', { class: 'ex-mix-preview', id: 'mixPreview' });
      mixPop.appendChild(preview);

      // Coherencia slider <-> campos: los campos fijan la proporción
      // (música 2 / temas 1 = 67/33) y el slider se ajusta; al mover el
      // slider se limpian los campos (una sola fuente de verdad a la vez).
      function refreshPreview() {
        const p = Number(slider.value);
        pct.textContent = p + '%';
        document.getElementById('mixPctT').textContent = 'Temas: ' + (100 - p) + '% (complementario)';
        const m = Number(cM.value) || 0, t = Number(cT.value) || 0;
        let txt;
        if (m + t > 0) txt = 'Cada ciclo: ' + m + ' música / ' + t + ' temas ≈ ' + Math.round((m / (m + t)) * 100) + '/' + Math.round((t / (m + t)) * 100);
        else txt = 'Proporción: ' + p + '% música / ' + (100 - p) + '% temas';
        preview.textContent = txt;
      }
      slider.addEventListener('input', () => { cM.value = ''; cT.value = ''; refreshPreview(); });
      const onCount = () => {
        const m = Number(cM.value) || 0, t = Number(cT.value) || 0;
        if (m + t > 0) slider.value = String(Math.round((m / (m + t)) * 100));
        refreshPreview();
      };
      cM.addEventListener('input', onCount);
      cT.addEventListener('input', onCount);
      refreshPreview();

      const presets = U.el('div', { class: 'ex-mix-presets' });
      for (const [label, p] of MIX_PRESETS) {
        const b = U.el('button', { class: 'ex-btn', type: 'button', 'data-pct': String(p), text: label });
        b.addEventListener('click', () => { slider.value = String(p); cM.value = ''; cT.value = ''; refreshPreview(); });
        presets.appendChild(b);
      }
      mixPop.appendChild(presets);

      const actions = U.el('div', { class: 'ex-pop-actions' });
      const apply = U.el('button', { id: 'mixApply', class: 'ex-btn primary', type: 'button', text: 'Aplicar' });
      apply.addEventListener('click', async () => {
        const m = Number(cM.value) || 0, t = Number(cT.value) || 0;
        const musicPct = Number(slider.value);
        try {
          await cmp.setContentMode({ mode: 'personalizado', mix: { musicPct, musicCount: m, themeCount: t } });
          await loadPrefs();
          closePops();
          say('Mezcla ' + musicPct + '% música / ' + (100 - musicPct) + '% temas');
          if (state.query) fetchPage(true);
        } catch (err) { say('Error: ' + (err && err.message || err)); }
      });
      const reset = U.el('button', { id: 'mixReset', class: 'ex-btn', type: 'button', text: 'Restablecer' });
      reset.addEventListener('click', () => { slider.value = '50'; cM.value = ''; cT.value = ''; refreshPreview(); });
      actions.appendChild(apply); actions.appendChild(reset);
      mixPop.appendChild(actions);
    }

    // --------------------------------------------------- popover de filtros
    async function openFilterPop() {
      closePops();
      filterOpen = true;
      if (!filterPopBuilt) { await buildFilterPop(); filterPopBuilt = true; }
      syncFilterControls();
      filterPop.classList.add('show');
      positionPop(filterPop, filtersBtn);
    }

    filtersBtn.addEventListener('click', (e) => { e.stopPropagation(); filterOpen ? closePops() : openFilterPop(); });
    historyBtn.addEventListener('click', (e) => { e.stopPropagation(); showTab('history'); });

    function positionPop(pop, anchor) {
      const r = anchor.getBoundingClientRect();
      const host = root.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(host.width - 320, r.left - host.left)) + 'px';
      pop.style.top = (r.bottom - host.top + 6) + 'px';
    }

    function closePops() {
      mixOpen = false; filterOpen = false;
      mixPop.classList.remove('show');
      filterPop.classList.remove('show');
    }

    // Cierra popovers al hacer clic fuera o con Escape (navegación por teclado).
    root.addEventListener('click', (e) => {
      if (!e.target.closest('.ex-pop') && !e.target.closest('#exFiltersBtn') && !e.target.closest('.ex-modes')) closePops();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (mixOpen || filterOpen)) { closePops(); e.stopPropagation(); }
    });

    async function buildFilterPop() {
      U.clear(filterPop);
      filterPop.appendChild(U.el('div', { class: 'ex-pop-title', text: 'Filtros de búsqueda' }));
      let caps = null;
      try {
        const res = await cmp.searchProviders();
        caps = (res.providers && res.providers[0] && res.providers[0].capabilities) || null;
      } catch { caps = null; }
      const filters = (caps && caps.filters) || [];
      if (!filters.length) {
        filterPop.appendChild(U.el('div', { class: 'ex-note', text: 'El proveedor actual no declara filtros.' }));
      }
      for (const f of filters) {
        filterPop.appendChild(buildFilterRow(f));
      }
      // Rango de fechas personalizado (si el filtro de fecha lo admite).
      if (filters.some((f) => f.id === 'date' && f.customRange)) {
        const row = U.el('div', { class: 'ex-frow' });
        row.appendChild(U.el('span', { class: 'ex-flabel', text: 'Intervalo personalizado' }));
        const wrap = U.el('span', { class: 'ex-fctl' });
        const from = U.el('input', { type: 'date', id: 'fDateFrom', title: 'Desde' });
        const to = U.el('input', { type: 'date', id: 'fDateTo', title: 'Hasta' });
        from.addEventListener('change', onFilterChange);
        to.addEventListener('change', onFilterChange);
        wrap.appendChild(from); wrap.appendChild(to);
        row.appendChild(wrap);
        filterPop.appendChild(row);
      }
      const actions = U.el('div', { class: 'ex-pop-actions' });
      const reset = U.el('button', { id: 'exFiltersReset', class: 'ex-btn', type: 'button', text: 'Restablecer' });
      reset.addEventListener('click', () => {
        state.filters = {};
        syncFilterControls();
        paintFilterBadge();
        persistAndApply();
      });
      actions.appendChild(reset);
      filterPop.appendChild(actions);
    }

    function scopeTag(scope, note) {
      const s = U.el('span', { class: 'ex-scope' + (scope === 'local' ? ' local' : ''), text: scope === 'local' ? 'local' : 'YouTube' });
      if (note) s.title = note;
      return s;
    }

    function buildFilterRow(f) {
      const row = U.el('div', { class: 'ex-frow', 'data-filter': f.id });
      const lab = U.el('span', { class: 'ex-flabel', text: f.name });
      lab.appendChild(scopeTag(f.scope, null));
      row.appendChild(lab);
      const ctl = U.el('span', { class: 'ex-fctl' });
      if (f.text) {
        const inp = U.el('input', { type: 'text', class: 'ex-input ex-ftext', 'data-filter': f.id, placeholder: 'nombre o ID de canal' });
        inp.value = state.filters[f.id] || '';
        inp.addEventListener('input', onFilterChange);
        ctl.appendChild(inp);
      } else if (f.multiple) {
        for (const opt of (f.options || [])) {
          const id = 'fFeat_' + opt.id;
          const lab = U.el('label', { class: 'ex-check' });
          const cb = U.el('input', { type: 'checkbox', id, 'data-filter': f.id, value: opt.id });
          cb.checked = (state.filters.features || []).includes(opt.id);
          cb.addEventListener('change', onFilterChange);
          lab.appendChild(cb);
          lab.appendChild(U.el('span', { text: opt.name }));
          if (opt.note) lab.title = opt.note;
          ctl.appendChild(lab);
        }
      } else {
        const sel = U.el('select', { class: 'ex-filter', 'data-filter': f.id });
        for (const opt of (f.options || [])) {
          const op = U.el('option', { value: opt.id, text: opt.name });
          if (opt.scope === 'local') op.textContent += ' (local)';
          if (opt.note) op.title = opt.note;
          sel.appendChild(op);
        }
        sel.value = state.filters[f.id] || (f.options && f.options[0] ? f.options[0].id : 'any');
        sel.addEventListener('change', onFilterChange);
        ctl.appendChild(sel);
      }
      row.appendChild(ctl);
      return row;
    }

    const onFilterChange = U.debounce(async () => {
      readFilterControls();
      paintFilterBadge();
      persistAndApply();
    }, 600);

    function readFilterControls() {
      const f = {};
      filterPop.querySelectorAll('select.ex-filter[data-filter], input.ex-ftext[data-filter]').forEach((el) => {
        const id = el.dataset.filter;
        if (el.tagName === 'SELECT') {
          const def = el.querySelector('option') && el.querySelector('option').value;
          if (el.value !== def && !(id === 'sort' && el.value === 'relevance')) f[id] = el.value;
        } else if (el.value.trim()) f[id] = el.value.trim();
      });
      const feats = [];
      filterPop.querySelectorAll('input[type=checkbox][data-filter=features]').forEach((cb) => { if (cb.checked) feats.push(cb.value); });
      if (feats.length) f.features = feats;
      const from = document.getElementById('fDateFrom');
      const to = document.getElementById('fDateTo');
      if (from && from.value) f.dateFrom = from.value;
      if (to && to.value) f.dateTo = to.value;
      state.filters = f;
    }

    function syncFilterControls() {
      const f = state.filters || {};
      filterPop.querySelectorAll('select.ex-filter[data-filter], input.ex-ftext[data-filter]').forEach((el) => {
        const id = el.dataset.filter;
        if (el.tagName === 'SELECT') {
          const def = el.querySelector('option') && el.querySelector('option').value;
          el.value = f[id] || (id === 'sort' ? 'relevance' : def);
        } else el.value = f[id] || '';
      });
      filterPop.querySelectorAll('input[type=checkbox][data-filter=features]').forEach((cb) => {
        cb.checked = (f.features || []).includes(cb.value);
      });
      const from = document.getElementById('fDateFrom');
      const to = document.getElementById('fDateTo');
      if (from) from.value = f.dateFrom || '';
      if (to) to.value = f.dateTo || '';
    }

    function activeFilterCount() {
      const f = state.filters || {};
      let n = 0;
      for (const k of ['type', 'date', 'duration', 'sort', 'channel']) if (f[k] && !(k === 'sort' && f[k] === 'relevance')) n++;
      if (f.features && f.features.length) n++;
      if (f.dateFrom || f.dateTo) n++;
      return n;
    }

    function paintFilterBadge() {
      const n = activeFilterCount();
      filterBadge.textContent = String(n);
      filterBadge.style.display = n ? 'inline-flex' : 'none';
    }

    async function persistAndApply() {
      try { await cmp.setFilters(state.filters || {}); } catch {}
      if (state.query) { doSearch(state.query); }  // re-busca con los filtros (debounce ya aplicado)
    }

    // --------------------------------------------- clasificación de resultados
    async function afterResults(items) {
      try {
        const r = await cmp.classify(items || []);
        state.classes = state.classes || {};
        for (const c of (r.classes || [])) state.classes[c.id] = c.cls;
      } catch { /* sin clasificación: se muestran todos */ }
    }

    function clsOf(it) { return (state.classes && state.classes[it.id]) || it.classification || null; }

    function filterByMode(stateArg, baseItems) {
      const mode = (prefs && prefs.contentMode) || 'temas';
      if (mode === 'musica') return baseItems.filter((it) => clsOf(it) === 'music');
      if (mode === 'temas') return baseItems.filter((it) => clsOf(it) !== 'music');
      return baseItems; // personalizado: se muestran ambos (la mezcla actúa en la continuidad)
    }

    function decorateCards(grid) {
      grid.querySelectorAll('.ex-card').forEach((card) => {
        const id = card.dataset.id;
        const cls = (state.classes && state.classes[id]) || null;
        card.classList.remove('cls-music', 'cls-theme');
        if (cls) card.classList.add('cls-' + cls);
        if (!card.querySelector('.ex-cls')) {
          card.appendChild(U.el('span', { class: 'ex-cls', text: cls === 'music' ? '♪ música' : cls === 'theme' ? 'Tema' : '' }));
        }
      });
    }

    // ------------------------------------------------------------ historial
    function buildHistoryPane() {
      U.clear(paneHistory);
      const bar = U.el('div', { class: 'ex-toolbar ex-hist-bar' });
      const chips = U.el('div', { class: 'ex-chips', id: 'exHistChips' });
      for (const [id, label] of H_TABS) {
        const c = U.el('button', { class: 'ex-chip' + (id === S.tab ? ' active' : ''), type: 'button', 'data-htab': id, text: label });
        c.addEventListener('click', () => { S.tab = id; S.offset = 0; paintChips(); loadHistory(false); });
        chips.appendChild(c);
      }
      const hSearch = U.el('input', { id: 'exHistSearch', class: 'ex-input ex-hist-search', type: 'search', placeholder: 'Buscar en el historial (local, sin red)' });
      hSearch.addEventListener('input', U.debounce(() => { S.q = hSearch.value; S.offset = 0; loadHistory(false); }, 300));
      const sort = U.el('select', { id: 'exHistSort', class: 'ex-filter' });
      for (const [v, l] of H_SORTS) sort.appendChild(U.el('option', { value: v, text: l }));
      sort.addEventListener('change', () => { S.sort = sort.value; S.offset = 0; loadHistory(false); });
      const sToggle = U.el('button', { id: 'exHistSearchesToggle', class: 'ex-btn', type: 'button', text: 'Búsquedas' });
      sToggle.addEventListener('click', () => { S.showSearches = !S.showSearches; S.offset = 0; loadHistory(false); });
      bar.appendChild(chips); bar.appendChild(hSearch); bar.appendChild(sort); bar.appendChild(sToggle);

      const list = U.el('div', { class: 'ex-list ex-hist-list', id: 'exHistList' });
      const more = U.el('button', { id: 'exHistMore', class: 'ex-btn', type: 'button', text: 'Cargar más', style: 'display:none' });
      more.addEventListener('click', () => { S.offset += S.limit; loadHistory(true); });

      const foot = U.el('div', { class: 'ex-toolbar ex-hist-foot' });
      const exp = U.el('button', { id: 'exHistExport', class: 'ex-btn', type: 'button', text: 'Exportar JSON' });
      exp.addEventListener('click', exportHistory);
      const period = U.el('select', { id: 'exHistPeriod', class: 'ex-filter' });
      for (const [v, l] of H_PERIODS) period.appendChild(U.el('option', { value: v, text: l }));
      const clearP = U.el('button', { id: 'exHistClear', class: 'ex-btn danger', type: 'button', text: 'Borrar periodo' });
      clearP.addEventListener('click', async () => {
        const p = period.value;
        if (!window.confirm('¿Borrar el historial de ' + (H_PERIODS.find((x) => x[0] === p) || [p, p])[1].toLowerCase() + '?')) return;
        const r = await cmp.historyClear(p);
        say('Borradas ' + ((r && r.removed) || 0) + ' entradas');
        loadHistory(false);
      });
      const clearAll = U.el('button', { id: 'exHistClearAll', class: 'ex-btn danger', type: 'button', text: 'Borrar todo' });
      clearAll.addEventListener('click', async () => {
        if (!window.confirm('¿Borrar TODO el historial de reproducción? Esta acción no se puede deshacer.')) return;
        const r = await cmp.historyClear('all');
        say('Historial vaciado (' + ((r && r.removed) || 0) + ' entradas)');
        loadHistory(false);
      });
      foot.appendChild(exp); foot.appendChild(period); foot.appendChild(clearP); foot.appendChild(clearAll);

      paneHistory.appendChild(bar);
      paneHistory.appendChild(list);
      paneHistory.appendChild(more);
      paneHistory.appendChild(foot);
    }

    function paintChips() {
      paneHistory.querySelectorAll('.ex-chip').forEach((c) => c.classList.toggle('active', c.dataset.htab === S.tab));
      const t = document.getElementById('exHistSearchesToggle');
      if (t) t.classList.toggle('active', S.showSearches);
    }

    async function loadHistory(append) {
      const list = document.getElementById('exHistList');
      const more = document.getElementById('exHistMore');
      if (!list) return;
      if (!append) U.clear(list);
      if (S.showSearches) { await loadSearches(list); more.style.display = 'none'; return; }
      try {
        const r = await cmp.historyQuery({ tab: S.tab, q: S.q, sort: S.sort, offset: S.offset, limit: S.limit });
        const items = (r && r.items) || [];
        S.total = (r && r.total) || 0;
        if (!items.length && !append) {
          list.appendChild(U.el('div', { class: 'ex-note', text: 'Sin resultados en el historial.' }));
        }
        for (const e of items) list.appendChild(histRow(e));
        more.style.display = (S.offset + items.length) < S.total ? 'inline-flex' : 'none';
      } catch (e) {
        list.appendChild(U.el('div', { class: 'ex-note', text: 'Error al leer el historial: ' + String(e.message || e) }));
      }
    }

    function histRow(e) {
      const row = U.el('div', { class: 'ex-hrow', 'data-id': e.id });
      const thumb = U.el('div', { class: 'ex-hthumb' });
      if (e.thumbnail) {
        const img = U.el('img', { src: e.thumbnail, alt: '', loading: 'lazy' });
        img.addEventListener('error', () => img.remove());
        thumb.appendChild(img);
      }
      row.appendChild(thumb);

      const body = U.el('div', { class: 'ex-hbody' });
      const t = U.el('div', { class: 'ex-htitle', text: e.title || e.sourceId });
      body.appendChild(t);
      const facts = [];
      if (e.creator) facts.push(e.creator);
      const d = U.fmtDate(e.lastPlayedAt);
      if (d) facts.push(d);
      const dur = U.fmtDuration(e.duration);
      if (dur) facts.push(dur);
      facts.push((e.playCount || 1) + ((e.playCount || 1) === 1 ? ' reproducción' : ' reproducciones'));
      if (facts.length) body.appendChild(U.el('div', { class: 'ex-hsub', text: facts.join(' · ') }));

      // barra fina de progreso + estado
      const prog = U.el('div', { class: 'ex-hprog' });
      const pct = e.duration ? Math.max(0, Math.min(100, ((e.positionMs || 0) / 1000) / e.duration * 100)) : 0;
      prog.appendChild(U.el('i', { style: 'width:' + pct.toFixed(1) + '%' }));
      body.appendChild(prog);
      const badges = U.el('div', { class: 'ex-hbadges' });
      if (e.status === 'finished') badges.appendChild(U.el('span', { class: 'ex-hbadge done', text: 'Terminado' }));
      else if (e.status === 'partial') badges.appendChild(U.el('span', { class: 'ex-hbadge partial', text: 'A medias ' + (e.duration ? Math.round(pct) + '%' : '') }));
      if (e.classification === 'music') badges.appendChild(U.el('span', { class: 'ex-hbadge music', text: '♪ música' }));
      else if (e.classification === 'theme') badges.appendChild(U.el('span', { class: 'ex-hbadge theme', text: 'Tema' }));
      if (e.searchContext) badges.appendChild(U.el('span', { class: 'ex-hbadge ctx', text: 'búsqueda: ' + e.searchContext, title: 'Contexto de búsqueda: ' + e.searchContext }));
      body.appendChild(badges);
      row.appendChild(body);

      // acciones contextuales
      const acts = U.el('div', { class: 'ex-hactions' });
      const mk = (icon, label, title, fn) => {
        const b = U.el('button', { class: 'ex-act', type: 'button', title: title || label, 'data-hact': label });
        b.appendChild(U.icon(icon));
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        acts.appendChild(b);
        return b;
      };
      const item = { id: e.sourceId, url: e.url, title: e.title, channel: e.creator, duration: e.duration, thumbnail: e.thumbnail, provider: e.provider };
      mk('play', 'Reproducir', 'Reproducir', async () => {
        await cmp.playHistory(e.id);
        say('Reproduciendo: ' + (e.title || e.sourceId));
        if (closeModal) closeModal();
      });
      if (e.status === 'partial' && e.positionMs > 0) {
        mk('forward', 'Continuar', 'Continuar desde ' + Math.round((e.positionMs || 0) / 1000) + 's', async () => {
          await cmp.playHistory(e.id); // el proceso principal reanuda la posición guardada
          say('Continuando: ' + (e.title || e.sourceId));
          if (closeModal) closeModal();
        });
      }
      mk('queue', 'Cola', 'Agregar a la cola', async () => {
        await cmp.queueAdd(item, 'end');
        say('Añadido a la cola');
        if (ctx.refreshQueue) ctx.refreshQueue();
      });
      mk('search', 'Relacionados', 'Buscar contenido relacionado', () => {
        const words = String(e.title || '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4).slice(0, 3).join(' ');
        if (words) { input.value = words; doSearch(words); }
      });
      mk('repeat', 'Repetir', 'Repetir al final de la cola', async () => {
        await cmp.queueAdd(item, 'end');
        say('Se repetirá: ' + (e.title || e.sourceId));
        if (ctx.refreshQueue) ctx.refreshQueue();
      });
      mk('trash', 'Eliminar', 'Eliminar esta entrada', async () => {
        await cmp.historyRemove(e.id);
        row.remove();
      });
      row.appendChild(acts);
      return row;
    }

    async function loadSearches(list) {
      U.clear(list);
      try {
        const r = await cmp.searchHistory(30);
        const items = (r && r.searches) || [];
        if (!items.length) { list.appendChild(U.el('div', { class: 'ex-note', text: 'Aún no hay búsquedas guardadas.' })); return; }
        for (const s of items) {
          const row = U.el('div', { class: 'ex-hrow ex-srow', 'data-query': s.query });
          const body = U.el('div', { class: 'ex-hbody' });
          body.appendChild(U.el('div', { class: 'ex-htitle', text: s.query }));
          const fCount = s.filters ? Object.keys(s.filters).filter((k) => s.filters[k] && !(k === 'sort' && s.filters[k] === 'relevance')).length : 0;
          body.appendChild(U.el('div', { class: 'ex-hsub', text: [
            s.mode || 'temas',
            fCount ? fCount + ' filtro(s)' : 'sin filtros',
            U.fmtDate(s.at) || '',
            (s.count || 1) + ' uso(s)',
          ].filter(Boolean).join(' · ') }));
          row.appendChild(body);
          const acts = U.el('div', { class: 'ex-hactions' });
          const rep = U.el('button', { class: 'ex-act', type: 'button', title: 'Repetir esta búsqueda con sus filtros', 'data-hact': 'Repetir' });
          rep.appendChild(U.icon('repeat'));
          rep.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            state.filters = Object.assign({}, s.filters || {});
            try { await cmp.setFilters(state.filters); } catch {}
            paintFilterBadge();
            if (filterPopBuilt) syncFilterControls();
            input.value = s.query;
            doSearch(s.query);
          });
          acts.appendChild(rep);
          const del = U.el('button', { class: 'ex-act', type: 'button', title: 'Eliminar del historial de búsquedas', 'data-hact': 'Eliminar' });
          del.appendChild(U.icon('trash'));
          del.addEventListener('click', async (ev) => { ev.stopPropagation(); await cmp.searchHistoryRemove(s.query); row.remove(); });
          acts.appendChild(del);
          row.appendChild(acts);
          list.appendChild(row);
        }
      } catch (e) {
        list.appendChild(U.el('div', { class: 'ex-note', text: 'Error: ' + String(e.message || e) }));
      }
    }

    async function exportHistory() {
      try {
        const r = await cmp.historyExport();
        const json = (r && r.json) || '{}';
        JSON.parse(json); // valida que es JSON antes de exportar
        const blob = new Blob([json], { type: 'application/json' });
        const a = U.el('a', { href: URL.createObjectURL(blob), download: 'ciudadan-historial-' + new Date().toISOString().slice(0, 10) + '.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} }, 5000);
        say('Historial exportado a JSON');
      } catch (e) { say('Error al exportar: ' + String(e.message || e)); }
    }

    // ------------------------------------------------------------- init
    async function init() {
      await loadPrefs();
      try {
        const r = await cmp.getFilters();
        state.filters = Object.assign({}, (r && r.filters) || {});
      } catch { state.filters = {}; }
      paintFilterBadge();
      buildHistoryPane();
      loadHistory(false);
    }

    const api = {
      init, loadHistory,
      afterResults, filterByMode, decorateCards,
      closePops,
      setFiltersExternal(f) { state.filters = Object.assign({}, f || {}); paintFilterBadge(); if (filterPopBuilt) syncFilterControls(); },
    };
    // También se expone en el namespace por si algún llamador lo referencia ahí.
    window.CMPExplorerSprint.api = api;
    return api;
  }

  window.CMPExplorerSprint = { wire };
})();
