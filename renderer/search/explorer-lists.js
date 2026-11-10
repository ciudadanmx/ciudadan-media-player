// ===========================================================================
// CIUDADAN MEDIA PLAYER — Cola de reproducción y listas personales.
// Módulo sin estado: recibe la "app" (API + callbacks) y devuelve funciones.
// Script clásico: define window.CMPExplorerLists.
// ===========================================================================
'use strict';
/* global window, document, CMPExplorerUtils */
(function () {
  const U = window.CMPExplorerUtils;
  const L = {};

  // --- arrastre y soltar genérico ------------------------------------------
  // rows: NodeList de .ex-row; al soltar se llama onMove(from, to).
  L.enableDrag = function (rows, onMove) {
    let from = -1;
    rows.forEach((row, i) => {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (e) => {
        from = i;
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(i)); } catch {}
        }
      });
      row.addEventListener('dragend', () => {
        from = -1;
        row.classList.remove('dragging');
        rows.forEach((r) => r.classList.remove('over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('over');
        let src = from;
        if (src < 0 && e.dataTransfer) {
          const raw = e.dataTransfer.getData('text/plain');
          src = parseInt(raw, 10);
        }
        if (Number.isFinite(src) && src >= 0 && src !== i) onMove(src, i);
      });
    });
  };

  // --- cola -----------------------------------------------------------------
  L.queue = function (app, container) {
    U.clear(container);
    const q = app.queue || { items: [], currentIndex: -1, autoAdvance: true };
    if (!q.items.length) {
      container.appendChild(U.el('div', { class: 'ex-empty', text: 'La cola está vacía. Añade vídeos desde los resultados de búsqueda.' }));
      return;
    }
    const rows = [];
    q.items.forEach((item, index) => {
      const row = U.el('div', { class: 'ex-row' + (item.current ? ' current' : ''), 'data-index': index, 'data-id': item.id });
      row.appendChild(U.el('span', { class: 'grip', text: '⋮⋮' }));
      const src = U.pickThumb(item);
      if (src) row.appendChild(U.el('img', { src: src, alt: '' }));
      const t = U.el('div', { class: 't' });
      t.appendChild(U.el('b', { text: item.title || item.id }));
      const sub = [item.channel];
      const dur = U.fmtDuration(item.duration);
      if (dur) sub.push(dur);
      if (item.current) sub.push('reproduciendo');
      t.appendChild(U.el('span', { text: sub.filter(Boolean).join(' · ') }));
      row.appendChild(t);
      const acts = U.el('div', { class: 'acts' });
      const play = U.iconBtn('play', 'Reproducir', () => app.playQueue(index));
      const del = U.iconBtn('trash', 'Quitar de la cola', () => app.removeQueue(index));
      acts.appendChild(play); acts.appendChild(del);
      row.appendChild(acts);
      container.appendChild(row);
      rows.push(row);
    });
    L.enableDrag(rows, (from, to) => app.moveQueue(from, to));
  };

  // --- panel lateral de listas ---------------------------------------------
  L.listSide = function (app, container) {
    U.clear(container);
    const lists = app.lists || [];
    for (const l of lists) {
      const b = U.el('button', { type: 'button', 'data-list': l.id, class: app.selectedList === l.id ? 'active' : '' });
      b.appendChild(U.el('span', { text: l.name }));
      b.appendChild(U.el('em', { text: String(l.count || 0) }));
      b.addEventListener('click', () => app.selectList(l.id));
      container.appendChild(b);
    }
    if (!lists.length) container.appendChild(U.el('div', { class: 'ex-empty', text: 'No hay listas.' }));
  };

  // --- vídeos de una lista --------------------------------------------------
  L.listItems = function (app, container, list) {
    U.clear(container);
    if (!list) {
      container.appendChild(U.el('div', { class: 'ex-empty', text: 'Elige una lista para ver sus vídeos.' }));
      return;
    }
    const items = list.items || [];
    if (!items.length) {
      container.appendChild(U.el('div', { class: 'ex-empty', text: 'La lista "' + list.name + '" está vacía.' }));
      return;
    }
    const rows = [];
    items.forEach((item, index) => {
      const row = U.el('div', { class: 'ex-row', 'data-itemid': item.id, 'data-index': index });
      row.appendChild(U.el('span', { class: 'grip', text: '⋮⋮' }));
      const src = U.pickThumb(item);
      if (src) row.appendChild(U.el('img', { src: src, alt: '' }));
      const t = U.el('div', { class: 't' });
      t.appendChild(U.el('b', { text: item.title || item.id }));
      const sub = [item.channel];
      const dur = U.fmtDuration(item.duration);
      if (dur) sub.push(dur);
      t.appendChild(U.el('span', { text: sub.filter(Boolean).join(' · ') }));
      row.appendChild(t);
      const acts = U.el('div', { class: 'acts' });
      acts.appendChild(U.iconBtn('play', 'Reproducir', () => app.playItem(item)));
      acts.appendChild(U.iconBtn('queue', 'Agregar a la cola', () => app.addToQueue(item, 'end')));
      acts.appendChild(U.iconBtn('trash', 'Quitar de la lista', () => app.removeFromList(list.id, item.id)));
      row.appendChild(acts);
      container.appendChild(row);
      rows.push(row);
    });
    L.enableDrag(rows, (from, to) => app.moveInList(list.id, from, to));
  };

  window.CMPExplorerLists = L;
})();
