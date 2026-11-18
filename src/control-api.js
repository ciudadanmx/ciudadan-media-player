// API local de control de Ciudadan Media Player.
//
// Expone un servidor HTTP en 127.0.0.1 con:
//   GET  /health   -> liveness (sin token, sin datos sensibles)
//   GET  /state    -> estado completo del motor (requiere token)
//   POST /cmd      -> ejecucion de comandos (requiere token)
//   GET  /events   -> flujo SSE de eventos (requiere token)
//
// El token se lee de CMP_API_TOKEN o se genera al arrancar y se escribe en
// runtime/control-api.json para que el coordinador Node.js lo lea.
// No se implementa aquí ninguna política de audio: el reproductor sólo ejecuta
// órdenes y devuelve el estado real de libVLC.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const API_COMMANDS = [
  'play', 'pause', 'stop', 'togglePlay',
  'setVolume', 'getVolume', 'volumeUp', 'volumeDown', 'mute', 'unmute',
  'seek', 'forward', 'rewind',
  'getState', 'fullscreen', 'load', 'reload',
  // Cola de reproducción y listas (contrato con el coordinador externo).
  'getQueue', 'addToQueue', 'removeFromQueue', 'moveInQueue', 'clearQueue',
  'setAutoAdvance', 'playQueueIndex', 'next', 'previous',
  'getLists', 'getList', 'createList', 'renameList', 'deleteList',
  'addToList', 'removeFromList', 'moveInList', 'playList', 'addListToQueue',
  // Buscador (proveedor de búsqueda).
  'search', 'searchDetails', 'searchProviders',
  'getHistory',
  // Sprint: modos, continuidad, subtítulos e historial enriquecido.
  'getPrefs', 'setContentMode', 'setContinuity', 'getContinuity',
  'setSubtitlePrefs', 'getSubtitlePrefs', 'getSubtitleTracks', 'setSubtitleTrack',
  'setSubtitleStyle',
  'queryHistory', 'removeFromHistory', 'clearHistory', 'exportHistory',
  'getSearchHistory', 'removeSearch', 'playHistory',
  'classify', 'setFilters', 'getFilters',
];

const MAX_BODY = 64 * 1024;

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class ControlApi {
  /**
   * @param {object} opts
   * @param {string} opts.playerId  identificador de la instancia
   * @param {number} opts.port       puertoPreferred en 127.0.0.1
   * @param {string|null} opts.token token (si no, se genera)
   * @param {(cmd:string,args:object,origin:string)=>Promise<any>} opts.onCommand
   * @param {(evt:object)=>void} opts.getState  estado actual para /state y /health
   */
  constructor({ playerId = 'ciudadan-media-main', port = 17890, token = null, onCommand, getState, log = () => {}, runtimeFile = null } = {}) {
    this.playerId = playerId;
    this.preferredPort = Number(port) || 17890;
    this.token = token || crypto.randomBytes(24).toString('hex');
    this.onCommand = onCommand;
    this.getState = getState || (() => ({}));
    this.log = log;
    this.runtimeFile = runtimeFile;
    this.server = null;
    this.port = null;
    this.clients = new Set();     // respuestas SSE abiertas
    this.commandCache = new Map(); // id -> resultado (evita ejecuciones duplicadas)
    this.startedAt = Date.now();
  }

  isAuthed(req, url) {
    const h = req.headers['authorization'];
    if (h && /^Bearer\s+/i.test(h)) return timingSafeEqualStr(h.replace(/^Bearer\s+/i, ''), this.token);
    const x = req.headers['x-cmp-token'];
    if (x) return timingSafeEqualStr(x, this.token);
    const q = url.searchParams.get('token');
    if (q) return timingSafeEqualStr(q, this.token);
    return false;
  }

  async start() {
    // Se intenta el puerto preferido y, si está ocupado (típico al reiniciar
    // rápido: la instancia anterior aún no ha soltado el socket), se reintenta
    // con espera antes de pasar al siguiente puerto.
    const maxPortTries = 12;
    let lastError = null;
    for (let attempt = 0; attempt < maxPortTries; attempt++) {
      const port = this.preferredPort + attempt;
      const srv = http.createServer((req, res) => this._handle(req, res).catch((e) => {
        this.log('API ERROR:', (e && e.stack) || String(e));
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'error interno' })); } catch {}
      }));
      srv.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
      const ok = await this._listen(srv, port);
      if (ok) {
        this.server = srv;
        this.port = port;
        break;
      }
      lastError = port;
      try { srv.close(); } catch {}
      await new Promise((r) => setTimeout(r, 750)); // espera a que se libere el socket
    }
    if (!this.port) throw new Error('no se pudo escuchar en 127.0.0.1 (puerto ' + this.preferredPort + ', ultimo=' + lastError + ')');

    if (this.runtimeFile) {
      try {
        fs.mkdirSync(path.dirname(this.runtimeFile), { recursive: true });
        fs.writeFileSync(this.runtimeFile, JSON.stringify({
          service: 'ciudadan-media-player',
          playerId: this.playerId,
          host: '127.0.0.1',
          port: this.port,
          token: this.token,
          pid: process.pid,
          startedAt: new Date(this.startedAt).toISOString(),
          commands: API_COMMANDS,
        }, null, 2));
        this.log('API de control en http://127.0.0.1:' + this.port + ' (token en ' + this.runtimeFile + ')');
      } catch (e) { this.log('API: no se pudo escribir el fichero de runtime:', String(e)); }
    }
    return { port: this.port, token: this.token };
  }

  _listen(srv, port) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const onErr = () => { srv.removeListener('listening', onOk); finish(false); };
      const onOk = () => { srv.removeListener('error', onErr); finish(true); };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      try { srv.listen(port, '127.0.0.1'); } catch { finish(false); }
    });
  }

  stop() {
    for (const c of this.clients) { try { c.end(); } catch {} }
    this.clients.clear();
    try { this.server?.close(); } catch {}
    try { if (this.runtimeFile && fs.existsSync(this.runtimeFile)) fs.unlinkSync(this.runtimeFile); } catch {}
  }

  /** Reenvía un evento a todos los clientes SSE. */
  emit(evt) {
    const payload = JSON.stringify(evt);
    for (const c of this.clients) {
      try {
        c.write(`event: ${evt.type || 'message'}\n`);
        c.write(`id: ${evt.stateVersion || 0}\n`);
        c.write(`data: ${payload}\n\n`);
      } catch { this.clients.delete(c); }
    }
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const json = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }

    if (path === '/health' && req.method === 'GET') {
      // Liveness sin token: no revela estado de reproducción ni datos sensibles.
      const s = this.getState() || {};
      json(200, {
        ok: true, service: 'ciudadan-media-player', playerId: this.playerId,
        pid: process.pid, connected: true, stateVersion: s.stateVersion || 0,
        uptimeMs: Date.now() - this.startedAt,
      });
      return;
    }

    if (!this.isAuthed(req, url)) { json(401, { ok: false, error: 'no autorizado' }); return; }

    if (path === '/' && req.method === 'GET') {
      json(200, {
        ok: true, service: 'ciudadan-media-player', playerId: this.playerId,
        endpoints: { health: 'GET /health', state: 'GET /state', command: 'POST /cmd', events: 'GET /events' },
        commands: API_COMMANDS,
      });
      return;
    }

    if (path === '/state' && req.method === 'GET') {
      json(200, { ok: true, state: this.getState() });
      return;
    }

    if (path === '/cmd' && req.method === 'POST') {
      let raw = '';
      let tooBig = false;
      req.on('data', (c) => { if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); return; } raw += c; });
      req.on('end', async () => {
        if (tooBig) { try { json(413, { ok: false, error: 'cuerpo demasiado grande' }); } catch {} return; }
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { json(400, { ok: false, error: 'JSON invalido' }); return; }
        const command = String(body.command || body.cmd || '').trim();
        const args = body.args || body.payload || {};
        const id = body.id ? String(body.id) : null;

        // Idempotencia: un id repetido devuelve el resultado ya calculado.
        if (id && this.commandCache.has(id)) {
          json(200, { ...this.commandCache.get(id), duplicate: true });
          return;
        }
        if (!command) { json(400, { ok: false, error: 'falta "command"' }); return; }
        if (!API_COMMANDS.includes(command)) {
          json(400, { ok: false, error: 'comando no soportado: ' + command, supported: API_COMMANDS });
          return;
        }
        try {
          const result = await this.onCommand(command, args, 'api');
          const out = { ok: true, id, command, ...result };
          if (id) this._remember(id, out);
          json(200, out);
        } catch (e) {
          const out = { ok: false, id, command, error: String((e && e.message) || e) };
          if (id) this._remember(id, out);
          this.log('API comando fallido:', command, out.error);
          json(200, out); // 200 con ok:false: el fallo del motor no es un error de transporte
        }
      });
      return;
    }

    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const s = this.getState() || {};
      res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', playerId: this.playerId, state: s })}\n\n`);
      this.clients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(hb); this.clients.delete(res); });
      return;
    }

    json(404, { ok: false, error: 'ruta no encontrada: ' + path });
  }

  _remember(id, out) {
    this.commandCache.set(id, out);
    if (this.commandCache.size > 200) {
      const first = this.commandCache.keys().next().value;
      this.commandCache.delete(first);
    }
  }
}
