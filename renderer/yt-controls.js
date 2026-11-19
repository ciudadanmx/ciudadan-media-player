// Controles estilo YouTube superpuestos al vídeo.
// El estado llega del motor (libVLC) vía IPC; aquí sólo se refleja y se envían órdenes.
'use strict';
/* global cmp */
const $ = (id) => document.getElementById(id);
const body = document.body;
const playBtn = $('play'), icoPlay = $('icoPlay'), icoPause = $('icoPause');
const stopBtn = $('stop'), prevBtn = $('prev'), nextBtn = $('next');
const searchBtn = $('search'), plToggle = $('plToggle'), plClose = $('plClose');
const plBack = $('plBack'), plTitle = $('plTitle');
const fullBtn = $('full'), icoFull = $('icoFull'), icoExit = $('icoExit');
const curEl = $('cur'), totEl = $('tot'), track = $('track'), rail = $('rail');
const played = $('played'), knob = $('knob'), tip = $('tip');
const volBtn = $('volBtn'), icoVol = $('icoVol'), icoMute = $('icoMute'), volEl = $('vol');
const plList = $('plList');

const fmt = (ms) => {
  if (!ms || !isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' + p(m) : String(m)) + ':' + p(ss);
};

let state = null;
let dragging = false;

// --- mostrar/ocultar la barra (lo decide el proceso principal: sigue al ratón) ---
// visibleBar se usa para NO repintar la barra 10 veces por segundo mientras
// está oculta (el interval de pintado sigue vivo, pero no toca el DOM).
let visibleBar = true;
function setVisible(v) { visibleBar = !!v; body.classList.toggle('hidden', !v); if (visibleBar) paintProgress(); }
cmp.onOverlay && cmp.onOverlay((o) => setVisible(!!o.visible));
document.addEventListener('mousemove', () => { cmp.overlayHover && cmp.overlayHover(); });

// --- Listas reales del usuario (Favoritos, Ver más tarde y las propias) ------
// Antes aquí se pintaba la lista hardcodeada del proceso principal. Ahora el
// panel muestra las listas guardadas de verdad (almacén local de Ciudadan).
let listsCache = [];
let openListId = null;

function plRow(title, sub, onClick, current) {
  const row = document.createElement('div');
  row.className = 'plItem' + (current ? ' current' : '');
  row.title = title || '';
  const n = document.createElement('div');
  n.className = 'n';
  n.textContent = '';
  const t = document.createElement('div');
  t.className = 't';
  const b = document.createElement('b');
  b.textContent = title || '';
  const s = document.createElement('span');
  s.textContent = sub || '';
  t.appendChild(b); t.appendChild(s);
  row.appendChild(n); row.appendChild(t);
  row.onclick = onClick;
  return row;
}

async function renderLists() {
  plList.innerHTML = '';
  try {
    const res = await cmp.lists();
    listsCache = (res && res.lists) || [];
  } catch (e) { listsCache = []; }
  if (!listsCache.length) {
    const empty = document.createElement('div');
    empty.id = 'plEmpty';
    empty.textContent = 'Todavía no hay listas. Añade vídeos desde Buscar.';
    plList.appendChild(empty);
    return;
  }
  for (const l of listsCache) {
    const count = Number(l.count) || 0;
    plList.appendChild(plRow(l.name, count + (count === 1 ? ' vídeo' : ' vídeos'), async () => {
      openListId = l.id;
      plTitle.textContent = l.name;
      plBack.style.display = 'inline-flex';
      await renderListItems(l.id);
    }));
  }
}

async function renderListItems(id) {
  plList.innerHTML = '';
  try {
    const l = await cmp.list(id);
    const items = (l && l.items) || [];
    if (!items.length) {
      const empty = document.createElement('div');
      empty.id = 'plEmpty';
      empty.textContent = 'Esta lista está vacía.';
      plList.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      plList.appendChild(plRow(item.title || item.id, item.channel || '', async () => {
        await cmp.playMedia(item);
      }, false));
    });
  } catch (e) {
    const empty = document.createElement('div');
    empty.id = 'plEmpty';
    empty.textContent = 'No se pudo abrir la lista.';
    plList.appendChild(empty);
  }
}

plBack.onclick = async (e) => {
  e.stopPropagation();
  openListId = null;
  plTitle.textContent = 'Mis listas';
  plBack.style.display = 'none';
  await renderLists();
};

// La lista de reproducción heredada (hardcodeada) se conserva como respaldo
// del botón "siguiente/anterior" cuando no hay cola ni listas reales.
let playlist = [];
let playlistIndex = 0;
(async () => {
  const pl = await cmp.playlist();
  if (pl && pl.items) { playlist = pl.items; playlistIndex = pl.index || 0; }
})();

// --- Explorador multimedia (buscador + resultados + cola + listas) ---------
// El módulo (renderer/search/explorer.js) construye su propia interfaz y es
// reutilizable tal cual en la futura página de inicio de Ciudadan Media.
let explorer = null;
function getExplorer() {
  if (explorer) return explorer;
  const root = $('exRoot');
  if (!root || !window.CMPExplorer) return null;
  explorer = window.CMPExplorer.create({
    container: root,
    cmp: window.cmp,
    onClose: () => { body.classList.remove('showModal'); },
  });
  return explorer;
}
function openModal() {
  body.classList.add('showModal');
  const ex = getExplorer();
  if (ex && ex.open) ex.open();
}
function closeModal() {
  body.classList.remove('showModal');
  const ex = getExplorer();
  if (ex && ex.close) ex.close();
}
searchBtn.onclick = (e) => { e.stopPropagation(); openModal(); };
plToggle.onclick = async (e) => {
  e.stopPropagation();
  const abrir = !body.classList.contains('showPlaylist');
  body.classList.toggle('showPlaylist', abrir);
  if (abrir) {
    openListId = null;
    plTitle.textContent = 'Mis listas';
    plBack.style.display = 'none';
    await renderLists();
  }
};
plClose.onclick = (e) => { e.stopPropagation(); body.classList.remove('showPlaylist'); };
// El explorador crea su propio #modalCancel; nos encargamos de cerrar el modal.
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'modalCancel') closeModal();
}, true);
// Escape cierra el explorador sin detener la reproducción.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && body.classList.contains('showModal')) { closeModal(); }
});

// --- acciones ---------------------------------------------------------------
async function togglePlay() {
  const s = state || (await cmp.state());
  // Si no hay nada cargado, el play carga el elemento actual de la lista.
  if (!s || !s.url || s.status === 'idle' || s.status === 'stopped' || s.status === 'ended') {
    if (s && s.url && s.status === 'ended') { await cmp.play(); return; }
    await cmp.playIndex(playlistIndex || 0);
    return;
  }
  if (s.isPlaying) await cmp.pause(); else await cmp.play();
}
playBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); };
stopBtn.onclick = async (e) => { e.stopPropagation(); await cmp.stop(); };
// El índice real lo lleva el proceso principal (el estado lo refleja y marca el
// elemento actual): aquí sólo se pide avanzar/retroceder.
prevBtn.onclick = async (e) => { e.stopPropagation(); await cmp.previous(); };
nextBtn.onclick = async (e) => { e.stopPropagation(); await cmp.next(); };
volBtn.onclick = (e) => { e.stopPropagation(); cmp.mute(); };
fullBtn.onclick = (e) => { e.stopPropagation(); cmp.fullscreen(); };

// Clic en el vídeo = play/pausa; doble clic = pantalla completa (como YouTube).
body.addEventListener('click', (e) => {
  if (e.target.closest('#bar') || e.target.closest('#playlist') || e.target.closest('#modal')) return;
  togglePlay();
});
body.addEventListener('dblclick', (e) => {
  if (e.target.closest('#bar') || e.target.closest('#playlist') || e.target.closest('#modal')) return;
  cmp.fullscreen();
});

// --- barra de progreso: clic y arrastre para buscar ---
function ratioFromEvent(e) {
  const r = rail.getBoundingClientRect();
  if (!r.width) return 0;
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}
function showTip(e) {
  const pct = ratioFromEvent(e);
  const len = (state && state.length) || 0;
  tip.style.left = (pct * 100) + '%';
  tip.textContent = fmt(pct * len);
  knob.style.left = (pct * 100) + '%';
}
track.addEventListener('pointermove', showTip);
track.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  dragging = true;
  track.setPointerCapture(e.pointerId);
  showTip(e);
});
track.addEventListener('pointerup', async (e) => {
  e.stopPropagation();
  if (!dragging) return;
  dragging = false;
  const pct = ratioFromEvent(e);
  const len = (state && state.length) || 0;
  if (len > 0) await cmp.seek((pct * len) / 1000);
});
volEl.addEventListener('input', (e) => { e.stopPropagation(); cmp.setVolume(Number(volEl.value)); });
volEl.addEventListener('pointerdown', (e) => e.stopPropagation());

// --- atajos (cuando la barra tiene el foco) ---
window.addEventListener('keydown', async (e) => {
  if (body.classList.contains('showModal') && !(e.target && e.target.closest && e.target.closest('#modal'))) return;
  const s = state || (await cmp.state());
  switch (e.key) {
    case ' ': case 'Spacebar': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); if (s) await cmp.seek(Math.max(0, (s.time / 1000) - (e.shiftKey ? 60 : 10))); break;
    case 'ArrowRight': e.preventDefault(); if (s) await cmp.seek((s.time / 1000) + (e.shiftKey ? 60 : 10)); break;
    case 'ArrowUp': e.preventDefault(); await cmp.setVolume(Math.min(100, (s?.volume ?? 100) + 5)); break;
    case 'ArrowDown': e.preventDefault(); await cmp.setVolume(Math.max(0, (s?.volume ?? 100) - 5)); break;
    case 'm': case 'M': cmp.mute(); break;
    case 'f': case 'F': cmp.fullscreen(); break;
    case 'n': case 'N': nextBtn.onclick(e); break;
    case 'b': case 'B': prevBtn.onclick(e); break;
  }
});

// --- reflejo del estado real del motor ---
// El motor notifica el estado ~1 vez por segundo (sondear más rápido saturaba
// libVLC y congelaba la app). El reloj de la barra se avanza EN LOCAL entre
// notificaciones, así que la barra sigue siendo suave sin llamar al motor.
let stateAt = Date.now();
cmp.onUpdate((s) => {
  window.__cmpUpdates = (window.__cmpUpdates || 0) + 1;
  try { render(s); } catch (e) { window.__cmpError = String(e && e.message || e); }
});

function currentTime() {
  if (!state) return 0;
  const base = state.time || 0;
  if (!state.isPlaying) return base;
  const max = state.length || 0;
  const t = base + (Date.now() - stateAt);
  return max ? Math.min(max, t) : t;
}

function paintProgress() {
  // Se pinta SIEMPRE (también con la barra oculta): son 3 escrituras de estilo
  // cada 100 ms y así el DOM refleja el estado real en cuanto se lea.
  const t = currentTime();
  const len = (state && state.length) || 0;
  const pct = len > 0 ? Math.max(0, Math.min(1, t / len)) : 0;
  curEl.textContent = fmt(t);
  played.style.width = (pct * 100) + '%';
  knob.style.left = (pct * 100) + '%';
}
setInterval(paintProgress, 100);

function render(s) {
  state = s;
  stateAt = Date.now();
  const playing = !!s.isPlaying;
  icoPlay.style.display = playing ? 'none' : 'block';
  icoPause.style.display = playing ? 'block' : 'none';
  totEl.textContent = fmt(s.length);
  paintProgress();
  if (document.activeElement !== volEl) volEl.value = s.muted ? 0 : s.volume;
  icoVol.style.display = s.muted ? 'none' : 'block';
  icoMute.style.display = s.muted ? 'block' : 'none';
  icoFull.style.display = s.fullscreen ? 'none' : 'block';
  icoExit.style.display = s.fullscreen ? 'block' : 'none';
  body.classList.toggle('buffering', s.status === 'buffering' || s.status === 'opening');
  paintTopTitle();
  // Al cambiar de medio se refrescan las pistas de subtítulos disponibles.
  // Las pistas SPU tardan un poco en aparecer (libVLC las enumera tras parsear
  // el medio): se reintenta unas veces antes de concluir "sin pistas".
  if (s.videoId !== lastSprintVideoId) {
    lastSprintVideoId = s.videoId;
    let tries = 0;
    const retry = async () => {
      await refreshSubtitleUI();
      tries++;
      if (tries < 6) {
        try {
          const t = await cmp.subtitleTracks();
          if (!t || !t.tracks || !t.tracks.length) setTimeout(retry, 2000);
        } catch { setTimeout(retry, 2000); }
      }
    };
    retry();
  }
}

// ---------------------------------------------------------------------------
// Sprint: continuidad ([Solo este | Continuo] + fuente) y subtítulos (CC/idioma).
// La UI sólo refleja prefs y emite acciones; la lógica vive en el proceso main.
// ---------------------------------------------------------------------------
const contBtn = $('contBtn'), contPop = $('contPop'), contSource = $('contSource');
const ccBtn = $('ccBtn'), langSel = $('langSel'), subPop = $('subPop'), subTracks = $('subTracks');
let lastSprintVideoId = null;

async function refreshContinuityUI() {
  try {
    const r = await cmp.getContinuity();
    const c = (r && r.continuity) || {};
    const mode = c.mode || 'continuo';
    document.querySelectorAll('input[name=contMode]').forEach((rb) => { rb.checked = rb.value === mode; });
    contSource.value = c.source || 'search';
    contBtn.classList.toggle('on', mode !== 'solo');
    contBtn.classList.toggle('off', mode === 'solo');
    contBtn.textContent = mode === 'solo' ? 'Solo' : '∞';
    contBtn.title = 'Continuidad: ' + (mode === 'solo' ? 'solo este vídeo' : 'continuo desde ' + contSource.value);
  } catch {}
}
contBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  subPop.classList.remove('show');
  contPop.classList.toggle('show');
});
document.querySelectorAll('input[name=contMode]').forEach((rb) => {
  rb.addEventListener('change', async () => {
    await cmp.setContinuity({ mode: rb.value }).catch(() => {});
    await refreshContinuityUI();
  });
});
contSource.addEventListener('change', async () => {
  await cmp.setContinuity({ source: contSource.value }).catch(() => {});
  await refreshContinuityUI();
});

async function refreshSubtitleUI() {
  try {
    const p = await cmp.getSubtitlePrefs();
    const en = p && p.subtitles ? p.subtitles.enabled !== false : true;
    ccBtn.classList.toggle('on', en);
    ccBtn.classList.toggle('off', !en);
    langSel.value = (p && p.subtitles && p.subtitles.lang) || 'es';
  } catch {}
  try {
    const t = await cmp.subtitleTracks();
    const tracks = (t && t.tracks) || [];
    const sel = t ? t.selected : -1;
    subTracks.innerHTML = '';
    const mk = (label, id, isSel) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = isSel ? 'sel' : '';
      b.textContent = label + (isSel ? '  ✓' : '');
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await cmp.setSubtitleTrack(id).catch(() => {});
        await refreshSubtitleUI();
      });
      subTracks.appendChild(b);
    };
    if (!tracks.length) {
      const d = document.createElement('div');
      d.className = 'none';
      d.textContent = 'Sin pistas de subtítulos en este vídeo';
      subTracks.appendChild(d);
    } else {
      mk('Desactivados', -1, sel === -1);
      for (const tr of tracks.filter((t) => t.id >= 0)) mk(tr.name || ('Pista ' + tr.id), tr.id, sel === tr.id);
    }
  } catch {}
}
ccBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  contPop.classList.remove('show');
  const p = await cmp.getSubtitlePrefs().catch(() => null);
  const en = !(p && p.subtitles && p.subtitles.enabled !== false);
  await cmp.setSubtitlePrefs({ enabled: en }).catch(() => {});
  subPop.classList.add('show');   // al conmutar se muestran las pistas reales
  await refreshSubtitleUI();
});
langSel.addEventListener('change', async () => {
  await cmp.setSubtitlePrefs({ lang: langSel.value }).catch(() => {});
  subPop.classList.add('show');
  await refreshSubtitleUI();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#contPop') && !e.target.closest('#contBtn')) contPop.classList.remove('show');
  if (!e.target.closest('#subPop') && !e.target.closest('#ccBtn') && !e.target.closest('#langSel')) subPop.classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { contPop.classList.remove('show'); subPop.classList.remove('show'); }
});
refreshContinuityUI();
refreshSubtitleUI();

// ---------------------------------------------------------------------------
// Barra de título SUPERIOR: muestra el vídeo actual (estilo YouTube).
// ---------------------------------------------------------------------------
const topTitle = $('topTitle');
function paintTopTitle() {
  const t = (state && state.title) ? String(state.title) : '';
  topTitle.innerHTML = '';
  if (t) {
    const b = document.createElement('b');
    b.textContent = t;
    topTitle.appendChild(b);
  }
  topTitle.title = t || '';
}

// ---------------------------------------------------------------------------
// Modal de ESTILO de subtítulos: tamaño, color de texto, color y opacidad del
// fondo y contorno (stroke) de las letras. Se guarda en las preferencias y
// el proceso principal lo aplica a libVLC (opciones freetype-*).
// ---------------------------------------------------------------------------
const ssModal = $('subStyleModal'), ssBtn = $('subStyleBtn');
const ssSize = $('ssSize'), ssColor = $('ssColor'), ssBgColor = $('ssBgColor');
const ssBgOpacity = $('ssBgOpacity'), ssOutlineColor = $('ssOutlineColor');
const ssOutlineWidth = $('ssOutlineWidth'), ssBold = $('ssBold');
const ssPreviewText = $('ssPreviewText');

const SS_DEFAULTS = {
  size: 100, color: '#ffffff', bgColor: '#000000', bgOpacity: 35,
  outlineColor: '#000000', outlineWidth: 2, bold: false,
};

function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}
function readStyle() {
  return {
    size: Number(ssSize.value) || 100,
    color: ssColor.value,
    bgColor: ssBgColor.value,
    bgOpacity: Number(ssBgOpacity.value) || 0,
    outlineColor: ssOutlineColor.value,
    outlineWidth: Number(ssOutlineWidth.value) || 0,
    bold: !!ssBold.checked,
  };
}
function writeStyle(st) {
  const s = Object.assign({}, SS_DEFAULTS, st || {});
  ssSize.value = s.size;
  ssColor.value = s.color;
  ssBgColor.value = s.bgColor;
  ssBgOpacity.value = s.bgOpacity;
  ssOutlineColor.value = s.outlineColor;
  ssOutlineWidth.value = String(s.outlineWidth);
  ssBold.checked = !!s.bold;
  paintStyleLabels();
  paintStylePreview();
}
function paintStyleLabels() {
  $('ssSizeVal').textContent = ssSize.value + '%';
  $('ssColorVal').textContent = String(ssColor.value).toUpperCase();
  $('ssBgColorVal').textContent = String(ssBgColor.value).toUpperCase();
  $('ssBgOpacityVal').textContent = ssBgOpacity.value + '%';
  $('ssOutlineColorVal').textContent = String(ssOutlineColor.value).toUpperCase();
  $('ssOutlineWidthVal').textContent = ssOutlineWidth.value;
}
function paintStylePreview() {
  const s = readStyle();
  const bg = hexToRgb(s.bgColor);
  ssPreviewText.style.color = s.color;
  ssPreviewText.style.fontSize = Math.round(10 + (s.size / 100) * 14) + 'px';
  ssPreviewText.style.fontWeight = s.bold ? '800' : '700';
  ssPreviewText.style.background = 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ',' + (s.bgOpacity / 100) + ')';
  const px = s.outlineWidth === 0 ? 0 : s.outlineWidth === 1 ? 1 : s.outlineWidth === 2 ? 2 : 3;
  ssPreviewText.style.webkitTextStroke = px ? px + 'px ' + s.outlineColor : '0';
  ssPreviewText.style.paintOrder = 'stroke fill';
}
[ssSize, ssBgOpacity, ssOutlineWidth].forEach((el) => el.addEventListener('input', () => { paintStyleLabels(); paintStylePreview(); }));
[ssColor, ssBgColor, ssOutlineColor].forEach((el) => el.addEventListener('input', () => { paintStyleLabels(); paintStylePreview(); }));
ssBold.addEventListener('change', paintStylePreview);

async function openSubStyle() {
  try {
    const p = await cmp.getSubtitlePrefs();
    writeStyle((p && p.subtitles && p.subtitles.style) || SS_DEFAULTS);
  } catch { writeStyle(SS_DEFAULTS); }
  body.classList.add('showSubStyle');
  try { $('ssSize').focus(); } catch {}
}
function closeSubStyle() { body.classList.remove('showSubStyle'); }
ssBtn.addEventListener('click', (e) => { e.stopPropagation(); openSubStyle(); });
$('ssCancel').addEventListener('click', (e) => { e.stopPropagation(); closeSubStyle(); });
$('ssReset').addEventListener('click', (e) => { e.stopPropagation(); writeStyle(SS_DEFAULTS); });
$('ssApply').addEventListener('click', async (e) => {
  e.stopPropagation();
  const st = readStyle();
  await cmp.setSubtitleStyle(st).catch(() => {});
  closeSubStyle();
});
ssModal.addEventListener('click', (e) => { if (e.target === ssModal) closeSubStyle(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && body.classList.contains('showSubStyle')) closeSubStyle();
});
// Al abrir/cerrar el modal de estilo la barra se aparta (no tapa nada).
document.addEventListener('click', (e) => {
  if (body.classList.contains('showSubStyle') && !e.target.closest('#subStyleModal') && !e.target.closest('#subStyleBtn')) {
    closeSubStyle();
  }
});

(async () => { state = await cmp.state(); })();
