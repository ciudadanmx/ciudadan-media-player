// ===========================================================================
// CIUDADAN MEDIA PLAYER — Utilidades del explorador multimedia.
// Módulo independiente (sin estado) para poder reutilizarlo en la página de
// inicio de Ciudadan Media sin duplicar código.
// Script clásico: define window.CMPExplorerUtils.
// ===========================================================================
'use strict';
/* global window */
(function () {
  const U = {};

  // --- formato -------------------------------------------------------------
  U.fmtDuration = function (seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return null;
    const total = Math.round(s);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  U.fmtViews = function (n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace('.', ',')} mil M`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace('.', ',')} mil M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.', ',')} mil`;
    return String(v);
  };

  U.fmtDate = function (iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const hoy = new Date();
    const dias = Math.floor((hoy.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (dias === 0) return 'hoy';
    if (dias === 1) return 'ayer';
    if (dias > 1 && dias < 7) return `hace ${dias} días`;
    if (dias < 31 && dias >= 7) return `hace ${Math.floor(dias / 7)} sem`;
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const sameYear = d.getFullYear() === hoy.getFullYear();
    return `${d.getDate()} ${mes[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
  };

  U.fmtBytes = function (n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  };

  // --- DOM -----------------------------------------------------------------
  U.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  };

  U.clear = function (node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; };

  // --- iconos (SVG inline, 24x24) ----------------------------------------
  const P = {
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.49 4.49 0 0 1 9.5 14',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    play: 'M8 5v14l11-7z',
    queue: 'M3 10h12v2H3zm0-4h12v2H3zm0 8h8v2H3zm14-4v6.18a3 3 0 1 0 2 2.82V8h3V6h-5z',
    next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    list: 'M3 9h12v2H3zm0 4h12v2H3zm0-8h12v2H3zm16 8v6.18a3 3 0 1 0 2 2.82V8h3V6h-5z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    drag: 'M20 9H4v2h16V9zM4 15h16v-2H4v2z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  };

  U.icon = function (name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', P[name] || P.play);
    svg.appendChild(path);
    return svg;
  };

  U.iconBtn = function (name, title, onClick, cls) {
    const b = U.el('button', { class: cls || 'ic', title: title, type: 'button' });
    b.appendChild(U.icon(name));
    if (onClick) b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(ev); });
    return b;
  };

  // --- URLs ----------------------------------------------------------------
  U.isYoutubeUrl = function (text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)/i.test(t)
      || /^https?:\/\/www\.youtube\.com\/embed\//i.test(t);
  };

  U.videoIdOf = function (text) {
    const t = String(text || '').trim();
    let m = t.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    m = t.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    m = t.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    return null;
  };

  U.watchUrl = function (id) { return `https://www.youtube.com/watch?v=${id}`; };

  // --- miniaturas ----------------------------------------------------------
  U.pickThumb = function (item) {
    if (!item) return null;
    if (item.thumbnail) return item.thumbnail;
    const list = Array.isArray(item.thumbnails) ? item.thumbnails : [];
    if (!list.length) return null;
    const sized = list.filter((t) => t && t.url && Number(t.width) <= 480);
    const pool = sized.length ? sized : list;
    const best = pool.reduce((a, b) => ((Number(b.width) || 0) > (Number(a.width) || 0) ? b : a), pool[0]);
    return best ? best.url : null;
  };

  // --- otros ---------------------------------------------------------------
  // Nota: todo el texto se inserta con textContent (nunca innerHTML), así que
  // no hace falta escapar entidades: no hay riesgo de inyección de HTML.
  U.text = function (s) { return String(s === null || s === undefined ? '' : s); };

  U.debounce = function (fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  };

  window.CMPExplorerUtils = U;
})();
