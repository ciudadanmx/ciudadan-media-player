// ===========================================================================
// CIUDADAN MEDIA PLAYER — Explorador multimedia (bloque 3).
// Buscador de YouTube con resultados reales, ficha, menú contextual, cola de
// reproducción y listas personales persistentes.
//
// Módulo REUTILIZABLE: window.CMPExplorer.create({container, cmp, onClose})
// se puede montar tal cual en la futura página de inicio de Ciudadan Media.
//
// Script clásico (el renderer carga por file://): define window.CMPExplorer.
// ===========================================================================
'use strict';
/* global window, document, CMPExplorerUtils, CMPExplorerResults, CMPExplorerLists */
(function () {
  const U = window.CMPExplorerUtils;
  const Res = window.CMPExplorerResults;
  const Lis = window.CMPExplorerLists;

  const PAGE = 20;

  function create(opts) {
    const o = opts || {};
    const cmp = o.cmp || window.cmp;
    const container = o.container || document.getElementById('exRoot');
    if (!container || !cmp) return null;

    // ---------------------------------------------------------------- estado
    const state = {
      query: '',
      items: [],
      hasMore: false,
      loading: false,
      reqId: 0,
      offset: 0,
      filters: {},
      capabilities: null,
      queue: { items: [], currentIndex: -1, autoAdvance: true },
      lists: [],
      selectedList: null,
      listDetail: null,
    };

    // ------------------------------------------------------------------ DOM
    U.clear(container);
    const root = U.el('div', { class: 'cmp-explorer' });
    container.appendChild(root);

    // -- cabecera
    const top = U.el('div', { class: 'ex-top' });
    const searchBox = U.el('div', { class: 'ex-search' });
    searchBox.appendChild(U.icon('search'));
    const input = U.el('input', { id: 'modalInput', class: 'ex-input', type: 'text', spellcheck: 'false', placeholder: 'Buscar en YouTube o pega una URL' });
    const submit = U.el('button', { id: 'modalSubmit', class: 'ex-btn primary', type: 'button', text: 'Buscar' });
    searchBox.appendChild(input);
    searchBox.appendChild(submit);
    top.appendChild(searchBox);

    const filtersBox = U.el('div', { class: 'ex-filters' });
    top.appendChild(filtersBox);

    const cancel = U.el('button', { id: 'modalCancel', class: 'ex-btn icon', type: 'button', title: 'Cerrar' });
    cancel.appendChild(U.icon('close'));
    top.appendChild(cancel);
    root.appendChild(top);

    // -- pestañas
    const tabs = U.el('div', { class: 'ex-tabs' });
    const mkTab = (id, label) => {
      const b = U.el('button', { class: 'ex-tab' + (id === 'results' ? ' active' : ''), type: 'button', 'data-tab': id, text: label });
      b.addEventListener('click', () => showTab(id));
      tabs.appendChild(b);
      return b;
    };
    mkTab('results', 'Resultados');
    const tabQueue = mkTab('queue', 'Cola');
    const badge = U.el('span', { id: 'exQueueCount', class: 'ex-badge', text: '0' });
    tabQueue.appendChild(badge);
    mkTab('lists', 'Listas');
    const now = U.el('div', { class: 'ex-now' });
    now.appendChild(U.el('span', { class: 'dot' }));
    const nowTitle = U.el('b', { id: 'exNowTitle', text: 'Nada reproduciéndose' });
    now.appendChild(nowTitle);
    tabs.appendChild(now);
    root.appendChild(tabs);

    // -- cuerpo
    const body = U.el('div', { class: 'ex-body' });
    const paneResults = U.el('div', { class: 'ex-pane active', id: 'exPaneResults' });
    const status = U.el('div', { class: 'ex-status', id: 'exStatus' });
    const grid = U.el('div', { class: 'ex-grid', id: 'exGrid' });
    const more = U.el('div', { class: 'ex-more', id: 'exMore' });
    paneResults.appendChild(status); paneResults.appendChild(grid); paneResults.appendChild(more);

    const paneQueue = U.el('div', { class: 'ex-pane', id: 'exPaneQueue' });
    const qToolbar = U.el('div', { class: 'ex-toolbar' });
    const autoLabel = U.el('label', { class: 'ex-switch' });
    const autoBox = U.el('input', { id: 'exAutoAdvance', type: 'checkbox' });
    autoLabel.appendChild(autoBox);
    autoLabel.appendChild(U.el('span', { text: 'Avance automático' }));
    const qClear = U.el('button', { id: 'exQueueClear', class: 'ex-btn', type: 'button', text: 'Vaciar cola' });
    qToolbar.appendChild(autoLabel); qToolbar.appendChild(U.el('span', { class: 'sp' })); qToolbar.appendChild(qClear);
    const queueList = U.el('div', { class: 'ex-list', id: 'exQueueList' });
    paneQueue.appendChild(qToolbar); paneQueue.appendChild(queueList);

    const paneLists = U.el('div', { class: 'ex-pane', id: 'exPaneLists' });
    const split = U.el('div', { class: 'ex-split' });
    const side = U.el('div', { class: 'ex-side', id: 'exListSide' });
    const right = U.el('div');
    const lToolbar = U.el('div', { class: 'ex-toolbar' });
    const lCreate = U.el('button', { id: 'exListCreate', class: 'ex-btn', type: 'button', text: 'Crear' });
    const lRename = U.el('button', { id: 'exListRename', class: 'ex-btn', type: 'button', text: 'Renombrar' });
    const lDelete = U.el('button', { id: 'exListDelete', class: 'ex-btn danger', type: 'button', text: 'Eliminar' });
    const lPlay = U.el('button', { id: 'exListPlay', class: 'ex-btn primary', type: 'button', text: 'Reproducir' });
    const lToQueue = U.el('button', { id: 'exListToQueue', class: 'ex-btn', type: 'button', text: 'A la cola' });
    lToolbar.appendChild(lCreate); lToolbar.appendChild(lRename); lToolbar.appendChild(lDelete);
    lToolbar.appendChild(U.el('span', { class: 'sp' })); lToolbar.appendChild(lPlay); lToolbar.appendChild(lToQueue);
    const listItems = U.el('div', { class: 'ex-list', id: 'exListItems' });
    right.appendChild(lToolbar); right.appendChild(listItems);
    split.appendChild(side); split.appendChild(right);
    paneLists.appendChild(split);

    body.appendChild(paneResults); body.appendChild(paneQueue); body.appendChild(paneLists);
    root.appendChild(body);

    // -- ficha de detalle
    const details = U.el('div', { class: 'ex-details', id: 'exDetails' });
    const dHead = U.el('div', { class: 'ex-details-head' });
    const dTitle = U.el('b', { id: 'exDetailsTitle', text: '' });
    const dClose = U.el('button', { id: 'exDetailsClose', class: 'ex-btn icon', type: 'button', title: 'Cerrar' });
    dClose.appendChild(U.icon('close'));
    dHead.appendChild(dTitle); dHead.appendChild(dClose);
    const dBody = U.el('div', { class: 'ex-details-body', id: 'exDetailsBody' });
    details.appendChild(dHead); details.appendChild(dBody);
    root.appendChild(details);

    // -- menú contextual y toast
    const menu = U.el('div', { class: 'ex-menu', id: 'exMenu' });
    root.appendChild(menu);
    const toast = U.el('div', { class: 'ex-toast', id: 'exToast' });
    root.appendChild(toast);

    // ------------------------------------------------------------- callbacks
    let toastTimer = null;
    function say(msg) {
      toast.textContent = msg;
      toast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function setStatus(kind, msg) {
      U.clear(status);
      status.className = 'ex-status' + (kind ? ' ' + kind : '');
      if (!kind) { status.classList.remove('show'); return; }
      status.classList.add('show');
      if (kind === 'loading') status.appendChild(U.el('span', { class: 'ex-spin' }));
      status.appendChild(U.el('span', { text: msg }));
    }

    // ------------------------------------------------------------- búsqueda
    async function doSearch(query) {
      const q = String(query || '').trim();
      if (!q) { say('Escribe qué quieres buscar'); return; }
      state.query = q;
      state.offset = 0;
      state.items = [];
      state.reqId++;           // invalida cualquier búsqueda anterior en curso
      U.clear(grid);
      more.textContent = '';

      // URL pegada: se resuelve ese vídeo (no hay búsqueda de texto).
      if (U.isYoutubeUrl(q)) {
        setStatus('loading', 'Resolviendo el vídeo…');
        const id = U.videoIdOf(q);
        try {
          const res = await cmp.searchDetails(id || q);
          if (!res || !res.ok || !res.item) {
            setStatus('error', 'No se pudo resolver ese enlace.');
            return;
          }
          state.items = [res.item];
          state.hasMore = false;
          renderResults();
          setStatus(null);
          input.value = '';
        } catch (e) {
          setStatus('error', 'Error al resolver: ' + String((e && e.message) || e));
        }
        return;
      }

      await fetchPage(true);
      input.value = '';
    }

    async function fetchPage(first) {
      if (state.loading) return;
      state.loading = true;
      const myReq = ++state.reqId;
      setStatus('loading', first ? 'Buscando…' : 'Cargando más resultados…');
      more.textContent = '';
      try {
        // La primera página cancela la búsqueda anterior; la paginación NO
        // (si no, pedir la página 2 abortaría la página 1).
        const res = await cmp.search({ query: state.query, limit: PAGE, offset: state.offset, cancelPrevious: !!first });
        // Una búsqueda más nueva invalida esta respuesta.
        if (myReq !== state.reqId) return;
        if (!res || !res.ok) {
          setStatus('error', 'Error de búsqueda: ' + String((res && res.error) || 'desconocido'));
          return;
        }
        const items = Array.isArray(res.items) ? res.items : [];
        if (!items.length && !first) {
          // La paginación no devuelve nada más: se cierra la lista.
          state.hasMore = false;
          more.textContent = 'Fin de resultados';
          setStatus(null);
          return;
        }
        state.items = state.items.concat(items);
        state.hasMore = !!res.hasMore;
        state.offset += items.length;
        renderResults();
        if (!state.items.length) setStatus('empty', 'Sin resultados para "' + state.query + '".');
        else setStatus(null);
        more.textContent = state.hasMore ? 'Cargando más…' : (state.items.length ? 'Fin de resultados' : '');
      } catch (e) {
        if (myReq !== state.reqId) return;
        setStatus('error', 'Error de búsqueda: ' + String((e && e.message) || e));
      } finally {
        if (myReq === state.reqId) state.loading = false;
      }
    }

    function visibleItems() {
      const f = state.filters.duration || 'any';
      if (f === 'any') return state.items;
      return state.items.filter((it) => {
        const d = Number(it.duration);
        if (!Number.isFinite(d) || d <= 0) return true; // sin dato real: no se descarta
        if (f === 'short') return d < 240;
        if (f === 'medium') return d >= 240 && d <= 1200;
        if (f === 'long') return d > 1200;
        return true;
      });
    }

    function renderResults() {
      U.clear(grid);
      const items = visibleItems();
      for (const it of items) grid.appendChild(Res.card(it, app));
      if (state.filters.duration && state.filters.duration !== 'any') {
        grid.appendChild(U.el('div', {
          class: 'ex-note',
          text: items.length + ' de ' + state.items.length + ' resultados cargados pasan el filtro de duración.',
        }));
      }
    }

    // ------------------------------------------------------------- filtros
    async function loadCapabilities() {
      try {
        const res = await cmp.searchProviders();
        const providers = (res && res.providers) || [];
        const p = providers[0];
        if (!p) return;
        state.capabilities = p.capabilities || {};
        buildFilters(state.capabilities);
      } catch (e) { /* sin filtros: la búsqueda funciona igual */ }
    }

    function buildFilters(caps) {
      U.clear(filtersBox);
      const filters = (caps && caps.filters) || [];
      for (const f of filters) {
        const sel = U.el('select', { class: 'ex-filter', 'data-filter': f.id });
        for (const opt of (f.options || [])) {
          const op = U.el('option', { value: opt.id, text: opt.name });
          sel.appendChild(op);
        }
        sel.value = state.filters[f.id] || (f.options && f.options[0] ? f.options[0].id : 'any');
        state.filters[f.id] = sel.value;
        sel.addEventListener('change', () => { state.filters[f.id] = sel.value; renderResults(); });
        filtersBox.appendChild(sel);
      }
    }

    // ------------------------------------------------------------- acciones
    async function onAction(action, item) {
      closeMenu();
      try {
        if (action === 'play-now') {
          say('Cargando…');
          const r = await cmp.playMedia(item);
          if (r && r.ok) {
            say('Reproduciendo: ' + (item.title || item.id));
            await refreshQueue();
            if (o.autoCloseOnPlay !== false) close();
          } else {
            say('No se pudo reproducir: ' + String((r && r.error) || 'error'));
          }
          return;
        }
        if (action === 'add-queue') {
          await cmp.queueAdd(item, 'end');
          say('Añadido a la cola');
          await refreshQueue();
          return;
        }
        if (action === 'play-next') {
          await cmp.queueAdd(item, 'next');
          say('Se reproducirá a continuación');
          await refreshQueue();
          return;
        }
        if (action === 'watch-later') {
          await cmp.listAdd('watch-later', item);
          say('Guardado en Ver más tarde');
          await refreshLists();
          return;
        }
        if (action === 'favorite') {
          await cmp.listAdd('favorites', item);
          say('Guardado en Favoritos');
          await refreshLists();
          return;
        }
        if (action === 'copy-link') {
          const url = item.url || U.watchUrl(item.id);
          await cmp.copy(url);
          say('Enlace copiado: ' + url);
          return;
        }
        if (action === 'save-list') {
          await openSaveList(item);
          return;
        }
      } catch (e) {
        say('Error: ' + String((e && e.message) || e));
      }
    }

    // Submenú de "Guardar en lista" (se reutiliza el menú contextual).
    async function openSaveList(item) {
      U.clear(menu);
      const head = U.el('div', { class: 'ex-note', text: 'Guardar en:' });
      menu.appendChild(head);
      for (const l of state.lists) {
        const b = U.el('button', { type: 'button', 'data-action': 'list-pick', 'data-id': item.id, 'data-list': l.id });
        b.appendChild(U.icon('list'));
        b.appendChild(U.el('span', { text: l.name }));
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          closeMenu();
          await cmp.listAdd(l.id, item);
          say('Guardado en ' + l.name);
          await refreshLists();
        });
        menu.appendChild(b);
      }
      menu.appendChild(U.el('hr'));
      const nb = U.el('button', { type: 'button', 'data-action': 'list-new' });
      nb.appendChild(U.icon('plus'));
      nb.appendChild(U.el('span', { text: 'Crear lista nueva…' }));
      nb.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeMenu();
        const name = window.prompt('Nombre de la nueva lista:');
        if (!name) return;
        const res = await cmp.listCreate(name);
        if (res && res.list) {
          await cmp.listAdd(res.list.id, item);
          say('Guardado en ' + res.list.name);
          await refreshLists();
        }
      });
      menu.appendChild(nb);
      menu.classList.add('show');
      const r = menu.getBoundingClientRect();
      const host = root.getBoundingClientRect();
      menu.style.left = Math.max(6, Math.min(host.width - r.width - 6, host.width / 2 - r.width / 2)) + 'px';
      menu.style.top = Math.max(6, host.height / 2 - r.height / 2) + 'px';
    }

    // --------------------------------------------------------- cola y listas
    async function refreshQueue() {
      try {
        const q = await cmp.queue();
        if (q) state.queue = q;
        badge.textContent = String((state.queue.items || []).length);
        autoBox.checked = !!state.queue.autoAdvance;
        Lis.queue(app, queueList);
      } catch (e) { /* la cola se refresca luego */ }
    }

    async function refreshLists() {
      try {
        const res = await cmp.lists();
        state.lists = (res && res.lists) || [];
        Lis.listSide(app, side);
        if (state.selectedList) await selectList(state.selectedList);
      } catch (e) { /* idem */ }
    }

    async function selectList(id) {
      state.selectedList = id;
      try {
        const l = await cmp.list(id);
        state.listDetail = l;
      } catch (e) { state.listDetail = null; }
      Lis.listSide(app, side);
      Lis.listItems(app, listItems, state.listDetail);
      const special = !!(state.listDetail && state.listDetail.special);
      lRename.disabled = special;
      lDelete.disabled = special;
      lPlay.disabled = special ? false : false;
    }

    // ------------------------------------------------------------- pestañas
    function showTab(id) {
      for (const b of tabs.querySelectorAll('.ex-tab')) b.classList.toggle('active', b.getAttribute('data-tab') === id);
      paneResults.classList.toggle('active', id === 'results');
      paneQueue.classList.toggle('active', id === 'queue');
      paneLists.classList.toggle('active', id === 'lists');
      if (id === 'queue') refreshQueue();
      if (id === 'lists') refreshLists();
    }

    // ----------------------------------------------------------------- API
    const app = {
      cmp,
      root,
      menuEl: menu,
      detailsEl: details,
      detailsBody: dBody,
      detailsTitle: dTitle,
      get queue() { return state.queue; },
      get lists() { return state.lists; },
      get selectedList() { return state.selectedList; },
      toast: say,
      openMenu(item, anchor) { Res.menu(item, anchor, app); },
      onAction,
      openDetails(item) {
        details.dataset.id = item.id;
        Res.details(item, app);
      },
      selectList,
      playQueue(index) { cmp.queuePlay(index).then(refreshQueue).catch((e) => say('Error: ' + e.message)); },
      removeQueue(index) { cmp.queueRemove(index).then(refreshQueue).catch((e) => say('Error: ' + e.message)); },
      moveQueue(from, to) { cmp.queueMove(from, to).then(refreshQueue).catch((e) => say('Error: ' + e.message)); },
      playItem(item) { onAction('play-now', item); },
      addToQueue(item, pos) { cmp.queueAdd(item, pos || 'end').then(refreshQueue).then(() => say('Añadido a la cola')).catch((e) => say('Error: ' + e.message)); },
      removeFromList(listId, itemId) { cmp.listRemove(listId, itemId).then(refreshLists).catch((e) => say('Error: ' + e.message)); },
      moveInList(listId, from, to) { cmp.listMove(listId, from, to).then(() => selectList(listId)).catch((e) => say('Error: ' + e.message)); },
    };

    function closeMenu() { menu.classList.remove('show'); }

    // ------------------------------------------------------------- eventos
    submit.addEventListener('click', (e) => { e.stopPropagation(); doSearch(input.value); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); doSearch(input.value); }
      if (e.key === 'Escape') close();
    });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    dClose.addEventListener('click', (e) => { e.stopPropagation(); details.classList.remove('show'); });
    root.addEventListener('click', (e) => {
      if (!e.target.closest('#exMenu')) closeMenu();
    });

    // Scroll infinito: al llegar al final se piden más resultados.
    // Sólo se pide una página por cada desplazamiento real hacia abajo (si no,
    // el evento de scroll se repetiría en bucle y se abortarían las búsquedas).
    let lastScrollTop = 0;
    paneResults.addEventListener('scroll', () => {
      const top = paneResults.scrollTop;
      const abajo = top > lastScrollTop + 8;
      lastScrollTop = top;
      if (!abajo) return;
      if (!state.hasMore || state.loading) return;
      if (paneResults.scrollTop + paneResults.clientHeight >= paneResults.scrollHeight - 220) fetchPage(false);
    });

    qClear.addEventListener('click', () => {
      cmp.queueClear().then(refreshQueue).then(() => say('Cola vaciada')).catch((e) => say('Error: ' + e.message));
    });
    autoBox.addEventListener('change', () => {
      cmp.queueAuto(autoBox.checked).then(refreshQueue).catch((e) => say('Error: ' + e.message));
    });

    lCreate.addEventListener('click', () => {
      const name = window.prompt('Nombre de la nueva lista:');
      if (!name) return;
      cmp.listCreate(name).then((res) => {
        say('Lista creada: ' + ((res && res.list && res.list.name) || name));
        return refreshLists().then(() => { if (res && res.list) selectList(res.list.id); });
      }).catch((e) => say('Error: ' + e.message));
    });
    lRename.addEventListener('click', () => {
      const cur = state.lists.find((l) => l.id === state.selectedList);
      if (!cur) { say('Elige una lista primero'); return; }
      if (cur.special) { say('Las listas del sistema no se renombran'); return; }
      const name = window.prompt('Nuevo nombre:', cur.name);
      if (!name) return;
      cmp.listRename(cur.id, name).then(refreshLists).catch((e) => say('Error: ' + e.message));
    });
    lDelete.addEventListener('click', () => {
      const cur = state.lists.find((l) => l.id === state.selectedList);
      if (!cur) { say('Elige una lista primero'); return; }
      if (cur.special) { say('Las listas del sistema no se eliminan'); return; }
      if (!window.confirm('¿Eliminar la lista "' + cur.name + '"?')) return;
      cmp.listDelete(cur.id).then(() => { state.selectedList = null; state.listDetail = null; refreshLists(); say('Lista eliminada'); })
        .catch((e) => say('Error: ' + e.message));
    });
    lPlay.addEventListener('click', () => {
      if (!state.selectedList) { say('Elige una lista primero'); return; }
      cmp.listPlay(state.selectedList).then(() => { say('Reproduciendo la lista'); refreshQueue(); })
        .catch((e) => say('Error: ' + e.message));
    });
    lToQueue.addEventListener('click', () => {
      if (!state.selectedList) { say('Elige una lista primero'); return; }
      cmp.listToQueue(state.selectedList).then((r) => { say((r && r.added ? r.added : 0) + ' vídeos en la cola'); refreshQueue(); })
        .catch((e) => say('Error: ' + e.message));
    });

    // Estado del reproductor (indicador de lo que suena).
    function updateNow() {
      try {
        cmp.state().then((s) => {
          if (!s) return;
          const t = s.title || (s.status === 'playing' ? 'Reproduciendo…' : 'Nada reproduciéndose');
          nowTitle.textContent = t;
          const dot = now.querySelector('.dot');
          if (dot) dot.classList.toggle('live', s.status === 'playing');
        }).catch(() => {});
      } catch (e) { /* sin estado */ }
    }
    const nowTimer = setInterval(updateNow, 2000);

    // ------------------------------------------------------------------ API
    function open() {
      loadCapabilities();
      refreshQueue();
      refreshLists();
      updateNow();
      // El foco se pone de inmediato (el campo debe poder escribirse nada más
      // abrir) y se repite un instante después por si el navegador aún no ha
      // pintado la ventana.
      try { input.focus(); } catch {}
      setTimeout(() => { try { input.focus(); } catch {} }, 30);
    }
    function close() {
      closeMenu();
      details.classList.remove('show');
      if (o.onClose) o.onClose();
    }
    function destroy() {
      clearInterval(nowTimer);
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    return {
      open, close, destroy,
      search: (q) => doSearch(q),
      refreshQueue, refreshLists,
      showTab,
    };
  }

  window.CMPExplorer = { create };
})();
