// Controles estilo YouTube superpuestos al vídeo.
// El estado llega del motor (libVLC) vía IPC; aquí sólo se refleja y se envían órdenes.
'use strict';
/* global cmp */
const $ = (id) => document.getElementById(id);
const body = document.body;
const playBtn = $('play'), icoPlay = $('icoPlay'), icoPause = $('icoPause');
const stopBtn = $('stop'), prevBtn = $('prev'), nextBtn = $('next');
const searchBtn = $('search'), plToggle = $('plToggle'), plClose = $('plClose');
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
let playlist = [];
let playlistIndex = 0;

// --- mostrar/ocultar la barra (lo decide el proceso principal: sigue al ratón) ---
function setVisible(v) { body.classList.toggle('hidden', !v); }
cmp.onOverlay && cmp.onOverlay((o) => setVisible(!!o.visible));
document.addEventListener('mousemove', () => { cmp.overlayHover && cmp.overlayHover(); });

// --- lista de reproducción (hardcodeada en el proceso principal) -------------
function renderPlaylist() {
  plList.innerHTML = '';
  if (!playlist.length) {
    const empty = document.createElement('div');
    empty.id = 'plEmpty';
    empty.textContent = 'La lista está vacía';
    plList.appendChild(empty);
    return;
  }
  playlist.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'plItem' + (i === playlistIndex ? ' current' : '');
    row.dataset.index = String(i);
    row.title = item.title;
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = String(i + 1);
    const t = document.createElement('div');
    t.className = 't';
    const b = document.createElement('b');
    b.textContent = item.title;
    const s = document.createElement('span');
    s.textContent = item.author || item.url;
    t.appendChild(b); t.appendChild(s);
    row.appendChild(n); row.appendChild(t);
    row.onclick = async (e) => {
      e.stopPropagation();
      playlistIndex = i;
      markCurrent();
      await cmp.playIndex(i);
    };
    plList.appendChild(row);
  });
}
function markCurrent() {
  [...plList.querySelectorAll('.plItem')].forEach((el, i) => {
    el.classList.toggle('current', i === playlistIndex);
  });
}
(async () => {
  const pl = await cmp.playlist();
  if (pl && pl.items) { playlist = pl.items; playlistIndex = pl.index || 0; renderPlaylist(); }
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
plToggle.onclick = (e) => { e.stopPropagation(); body.classList.toggle('showPlaylist'); };
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
cmp.onUpdate((s) => {
  window.__cmpUpdates = (window.__cmpUpdates || 0) + 1;
  try { render(s); } catch (e) { window.__cmpError = String(e && e.message || e); }
});

function render(s) {
  state = s;
  const playing = !!s.isPlaying;
  icoPlay.style.display = playing ? 'none' : 'block';
  icoPause.style.display = playing ? 'block' : 'none';
  curEl.textContent = fmt(s.time);
  totEl.textContent = fmt(s.length);
  const len = s.length || 0;
  const pct = len > 0 ? Math.max(0, Math.min(1, s.time / len)) : 0;
  played.style.width = (pct * 100) + '%';
  knob.style.left = (pct * 100) + '%';
  if (document.activeElement !== volEl) volEl.value = s.muted ? 0 : s.volume;
  icoVol.style.display = s.muted ? 'none' : 'block';
  icoMute.style.display = s.muted ? 'block' : 'none';
  icoFull.style.display = s.fullscreen ? 'none' : 'block';
  icoExit.style.display = s.fullscreen ? 'block' : 'none';
  body.classList.toggle('buffering', s.status === 'buffering' || s.status === 'opening');
  if (typeof s.playlistIndex === 'number' && s.playlistIndex !== playlistIndex) {
    playlistIndex = s.playlistIndex;
    markCurrent();
  }
}

(async () => { state = await cmp.state(); })();
