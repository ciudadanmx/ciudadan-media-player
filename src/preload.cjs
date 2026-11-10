// Preload (CJS) de la ventana de controles: expone API segura vía contextBridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cmp', {
  load: (url) => ipcRenderer.invoke('cmp:load', url),
  reload: () => ipcRenderer.invoke('cmp:reload'),
  play: () => ipcRenderer.invoke('cmp:play'),
  pause: () => ipcRenderer.invoke('cmp:pause'),
  stop: () => ipcRenderer.invoke('cmp:stop'),
  seek: (seconds) => ipcRenderer.invoke('cmp:seek', seconds),
  setVolume: (v) => ipcRenderer.invoke('cmp:volume', v),
  mute: () => ipcRenderer.invoke('cmp:mute'),
  state: () => ipcRenderer.invoke('cmp:state'),
  fullscreen: () => ipcRenderer.invoke('cmp:fullscreen'),
  diagnostics: () => ipcRenderer.invoke('cmp:diagnostics'),
  toggle: () => ipcRenderer.invoke('cmp:toggle'),
  // Lista de reproducción hardcodeada (con desplazamiento en la barra).
  playlist: () => ipcRenderer.invoke('cmp:playlist'),
  next: () => ipcRenderer.invoke('cmp:next'),
  previous: () => ipcRenderer.invoke('cmp:previous'),
  playIndex: (index) => ipcRenderer.invoke('cmp:playIndex', index),
  // --- Buscador ---------------------------------------------------------------
  search: (opts) => ipcRenderer.invoke('cmp:search', opts),
  searchDetails: (ref) => ipcRenderer.invoke('cmp:search-details', ref),
  searchProviders: () => ipcRenderer.invoke('cmp:search-providers'),
  playMedia: (item) => ipcRenderer.invoke('cmp:play-media', item),
  copy: (text) => ipcRenderer.invoke('cmp:copy', text),
  // --- Cola -------------------------------------------------------------------
  queue: () => ipcRenderer.invoke('cmp:queue'),
  queueAdd: (item, position) => ipcRenderer.invoke('cmp:queue-add', item, position),
  queueRemove: (index) => ipcRenderer.invoke('cmp:queue-remove', index),
  queueMove: (from, to) => ipcRenderer.invoke('cmp:queue-move', from, to),
  queueClear: () => ipcRenderer.invoke('cmp:queue-clear'),
  queueAuto: (on) => ipcRenderer.invoke('cmp:queue-auto', on),
  queuePlay: (index) => ipcRenderer.invoke('cmp:queue-play', index),
  // --- Listas -----------------------------------------------------------------
  lists: () => ipcRenderer.invoke('cmp:lists'),
  list: (id) => ipcRenderer.invoke('cmp:list', id),
  listCreate: (name) => ipcRenderer.invoke('cmp:list-create', name),
  listRename: (id, name) => ipcRenderer.invoke('cmp:list-rename', id, name),
  listDelete: (id) => ipcRenderer.invoke('cmp:list-delete', id),
  listAdd: (listId, item) => ipcRenderer.invoke('cmp:list-add', listId, item),
  listRemove: (listId, itemId) => ipcRenderer.invoke('cmp:list-remove', listId, itemId),
  listMove: (listId, from, to) => ipcRenderer.invoke('cmp:list-move', listId, from, to),
  listPlay: (listId) => ipcRenderer.invoke('cmp:list-play', listId),
  listToQueue: (listId) => ipcRenderer.invoke('cmp:list-to-queue', listId),
  history: () => ipcRenderer.invoke('cmp:history'),
  // Barra flotante estilo YouTube: el proceso principal avisa de mostrarla/ocultarla
  // y el renderer avisa de que el ratón se mueve sobre ella.
  overlayHover: () => ipcRenderer.send('cmp:overlay-hover'),
  onOverlay: (cb) => { const l = (_e, o) => cb(o); ipcRenderer.on('cmp:overlay', l); return () => ipcRenderer.removeListener('cmp:overlay', l); },
  onUpdate: (cb) => { const l = (_e, s) => cb(s); ipcRenderer.on('cmp:update', l); return () => ipcRenderer.removeListener('cmp:update', l); },
});
