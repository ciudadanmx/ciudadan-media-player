// ===========================================================================
// CIUDADAN MEDIA PLAYER — Resultados de búsqueda, menú contextual y ficha.
// Módulo sin estado: recibe la "app" (API + callbacks) y devuelve funciones.
// Script clásico: define window.CMPExplorerResults.
// ===========================================================================
'use strict';
/* global window, document, CMPExplorerUtils */
(function () {
  const U = window.CMPExplorerUtils;
  const R = {};

  // --- tarjeta de resultado -------------------------------------------------
  R.card = function (item, app) {
    const card = U.el('div', { class: 'ex-card', 'data-id': item.id });
    const thumb = U.el('div', { class: 'ex-thumb' });
    const src = U.pickThumb(item);
    if (src) {
      const img = U.el('img', { class: 'ex-thumb ex-thumbimg', src: src, alt: item.title || '', loading: 'lazy' });
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => { img.remove(); });
      thumb.appendChild(img);
    }
    const dur = U.fmtDuration(item.duration);
    if (dur) thumb.appendChild(U.el('span', { class: 'ex-dur', text: dur }));
    if (item.isLive) thumb.appendChild(U.el('span', { class: 'ex-live', text: 'EN DIRECTO' }));
    card.appendChild(thumb);

    const meta = U.el('div', { class: 'ex-meta' });
    meta.appendChild(U.el('div', { class: 'ex-title', text: item.title || item.id }));
    const facts = [];
    if (item.channel) facts.push(item.channel);
    const views = U.fmtViews(item.viewCount);
    if (views) facts.push(views + ' visualizaciones');
    const date = U.fmtDate(item.publishedAt);
    if (date) facts.push(date);
    if (facts.length) meta.appendChild(U.el('div', { class: 'ex-sub', text: facts.join(' · ') }));
    if (item.description) meta.appendChild(U.el('div', { class: 'ex-desc', text: item.description }));
    card.appendChild(meta);

    const more = U.el('button', { class: 'ex-more-btn', type: 'button', title: 'Más acciones', 'data-id': item.id });
    more.appendChild(U.icon('queue'));
    more.addEventListener('click', (e) => { e.stopPropagation(); app.openMenu(item, more); });
    card.appendChild(more);

    card.addEventListener('click', () => app.openDetails(item));
    return card;
  };

  // --- menú contextual ------------------------------------------------------
  const ACTIONS = [
    { action: 'play-now', icon: 'play', label: 'Reproducir ahora' },
    { action: 'add-queue', icon: 'queue', label: 'Agregar a la cola' },
    { action: 'play-next', icon: 'next', label: 'Reproducir a continuación' },
    { action: 'watch-later', icon: 'clock', label: 'Ver más tarde' },
    { action: 'save-list', icon: 'list', label: 'Guardar en lista' },
    { action: 'favorite', icon: 'star', label: 'Favoritos' },
    { action: 'copy-link', icon: 'copy', label: 'Compartir' },
  ];

  R.menu = function (item, anchor, app) {
    const menu = app.menuEl;
    U.clear(menu);
    for (const a of ACTIONS) {
      const b = U.el('button', { type: 'button', 'data-action': a.action, 'data-id': item.id });
      b.appendChild(U.icon(a.icon));
      b.appendChild(U.el('span', { text: a.label }));
      b.addEventListener('click', (e) => { e.stopPropagation(); app.onAction(a.action, item); });
      menu.appendChild(b);
    }
    // Posición: junto al botón, ajustada a los bordes de la ventana.
    menu.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const host = app.root.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = r.left - host.left;
    let top = r.bottom - host.top + 4;
    if (left + mw > host.width - 6) left = Math.max(6, host.width - mw - 6);
    if (top + mh > host.height - 6) top = Math.max(6, r.top - host.top - mh - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  };

  // --- ficha de detalle -----------------------------------------------------
  R.details = function (item, app) {
    const body = app.detailsBody;
    const title = app.detailsTitle;
    title.textContent = item.title || item.id;
    U.clear(body);

    const src = U.pickThumb(item);
    if (src) body.appendChild(U.el('img', { src: src, alt: item.title || '' }));

    body.appendChild(U.el('h3', { text: item.title || item.id }));

    const facts = [];
    if (item.channel) facts.push('Canal: ' + item.channel);
    if (item.duration) facts.push('Duración: ' + U.fmtDuration(item.duration));
    const views = U.fmtViews(item.viewCount);
    if (views) facts.push(views + ' visualizaciones');
    if (item.publishedAt) facts.push('Publicado: ' + item.publishedAt);
    if (facts.length) body.appendChild(U.el('div', { class: 'ex-facts', text: facts.join('  ·  ') }));

    body.appendChild(U.el('div', {
      class: item.description ? 'ex-desc-full' : 'ex-na',
      text: item.description || 'Descripción no disponible.',
    }));

    const acts = U.el('div', { class: 'ex-details-actions' });
    const mk = (label, action, primary) => {
      const b = U.el('button', { class: 'ex-btn' + (primary ? ' primary' : ''), type: 'button', text: label });
      b.addEventListener('click', () => app.onAction(action, item));
      return b;
    };
    acts.appendChild(mk('Reproducir ahora', 'play-now', true));
    acts.appendChild(mk('Agregar a la cola', 'add-queue'));
    acts.appendChild(mk('Ver más tarde', 'watch-later'));
    acts.appendChild(mk('Favoritos', 'favorite'));
    acts.appendChild(mk('Compartir', 'copy-link'));
    body.appendChild(acts);

    const link = U.el('div', { class: 'ex-note' });
    link.appendChild(U.el('span', { text: 'Enlace: ' + (item.url || U.watchUrl(item.id)) }));
    body.appendChild(link);

    app.detailsEl.classList.add('show');

    // Metadatos completos bajo demanda (no bloquea: si fallan, se muestran los que ya hay).
    if (item.id && !item.description) {
      app.cmp.searchDetails(item.id).then((res) => {
        if (!res || !res.ok || !res.item) return;
        if (app.detailsEl.dataset.id !== item.id) return;
        const full = res.item;
        const desc = body.querySelector('.ex-na, .ex-desc-full');
        if (desc && full.description) { desc.textContent = full.description; desc.className = 'ex-desc-full'; }
        const f = body.querySelector('.ex-facts');
        if (f && full.publishedAt && !item.publishedAt) {
          f.appendChild(U.el('span', { text: 'Publicado: ' + full.publishedAt }));
        }
      }).catch(() => {});
    }
  };

  window.CMPExplorerResults = R;
})();
