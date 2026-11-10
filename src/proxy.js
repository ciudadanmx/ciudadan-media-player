// Servidor proxy HTTP local (127.0.0.1) que sirve el stream de YouTube a libVLC.
// Reenvía el encabezado Range a googlevideo => respuestas 206 => libVLC puede hacer SEEK.
// No descarga el video completo: transmite chunk a chunk (streaming).
import http from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { TOOLS } from './paths.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

export class StreamProxy {
  constructor() {
    this.entries = new Map(); // id -> { url, headers, title, duration, mode, formatId, resolution, client, resolvedAt, hits, bytes }
    this.active = new Map();  // id -> Set<{res, ac}>  (streams vivos, para poder cortarlos)
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    this.port = 0;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); });
    });
    return this.port;
  }

  close() { try { this.server.close(); } catch {} }

  // Corta los streams vivos de una entrada (o de todas). Es imprescindible
  // antes de cambiar de medio: si el hilo de entrada de libVLC sigue leyendo
  // del socket, el stop() interno se queda bloqueado y el proceso principal
  // deja de responder (la API muere durante el cambio de vídeo).
  abortEntry(id) {
    const set = this.active.get(id);
    if (!set) return 0;
    let n = 0;
    for (const s of set) {
      try { s.ac.abort(); } catch {}
      try { s.res.destroy(); } catch {}
      n++;
    }
    set.clear();
    this.active.delete(id);
    return n;
  }

  abortAll() {
    let n = 0;
    for (const id of [...this.active.keys()]) n += this.abortEntry(id);
    return n;
  }

  #track(id, res, ac) {
    let set = this.active.get(id);
    if (!set) { set = new Set(); this.active.set(id, set); }
    const rec = { res, ac };
    set.add(rec);
    const off = () => {
      try { set.delete(rec); } catch {}
      if (!set.size) this.active.delete(id);
    };
    res.on('close', off);
    res.on('error', off);
    return rec;
  }

  register(entry) {
    this.entries.set(entry.id, { ...entry, resolvedAt: Date.now(), hits: 0, bytes: 0 });
    return entry.id;
  }

  get(id) { return this.entries.get(id); }

  streamUrl(id) { return `http://127.0.0.1:${this.port}/stream?id=${encodeURIComponent(id)}`; }

  async #onRequest(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, port: this.port, entries: this.entries.size })); return; }
    if (u.pathname === '/stream') {
      const id = u.searchParams.get('id');
      const entry = this.entries.get(id);
      if (!entry) { res.writeHead(404); res.end('unknown id'); return; }
      if (entry.mode === 'pipe') return this.#servePipe(entry, req, res);
      if (entry.mode !== 'range' && entry.mode !== 'hls') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'mode not proxyable', mode: entry.mode })); return; }
      entry.hits++;
      const headers = { ...(entry.headers || {}) };
      if (req.headers.range) headers['Range'] = req.headers.range;
      if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent']; // respeta UA de libVLC si lo envía
      const ac = new AbortController();
      req.on('close', () => { try { ac.abort(); } catch {} });
      this.#track(id, res, ac);
      try {
        const upstream = await fetch(entry.url, { headers, redirect: 'follow', signal: ac.signal });
        if (!upstream.ok && upstream.status !== 206) {
          const body = await upstream.text().catch(() => '');
          res.writeHead(upstream.status, { 'content-type': 'text/plain' });
          res.end(`upstream ${upstream.status}: ${body.slice(0, 300)}`);
          return;
        }
        const outHeaders = {};
        for (const [k, v] of upstream.headers) {
          const lk = k.toLowerCase();
          if (HOP_BY_HOP.has(lk)) continue;
          if (lk === 'content-encoding') continue; // fetch ya descomprime; reenviamos crudo
          outHeaders[k] = v;
        }
        res.writeHead(upstream.status, outHeaders);
        const reader = Readable.fromWeb(upstream.body);
        reader.on('data', (c) => { entry.bytes = (entry.bytes || 0) + c.length; });
        reader.on('error', () => { try { res.destroy(); } catch {} });
        res.on('close', () => { try { reader.destroy(); } catch {} });
        reader.pipe(res);
      } catch (e) {
        if (ac.signal.aborted) return; // el cliente cerró (seek/pausa): no es error
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('proxy error: ' + (e.message || e));
      }
      return;
    }
    res.writeHead(404); res.end('not found');
  }

  // Modo pipe: yt-dlp transmite el stream por stdout (sin Range => sin seek).
  // Es la vía de reproducción "por pipe" heredada de la implementación de septiembre.
  #servePipe(entry, req, res) {
    entry.hits++;
    const args = [
      '--no-warnings', '--no-playlist',
      '--extractor-args', `youtube:player_client=${entry.pipeClient || 'android'}`,
      '-f', 'bv*+ba/b', '-o', '-', entry.sourceUrl,
    ];
    let child;
    try {
      child = spawn(TOOLS.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('spawn yt-dlp fallo: ' + (e.message || e));
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'none' });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-400); });
    child.stdout.on('data', (c) => { entry.bytes = (entry.bytes || 0) + c.length; });
    child.stdout.on('error', () => {});
    child.on('error', (e) => { try { res.end(); } catch {} });
    child.on('close', (code) => {
      entry.pipeExit = code; entry.pipeError = errBuf.trim();
      try { res.end(); } catch {}
    });
    const kill = () => { try { child.kill(); } catch {} };
    req.on('close', kill);
    res.on('close', kill);
    child.stdout.pipe(res);
  }
}
