// Captura los errores de consola de la página del overlay (CDP) y el estado de
// los módulos del explorador. Uso: node tools\probe-errors.mjs [cdpPort]
const CDP_PORT = Number(process.argv[2] || 18133);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((p) => /yt-controls\.html/.test(p.url));
if (!page) { console.log('no hay página yt-controls'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const errores = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errores.push('EXCEPCION: ' + (d.exception?.description || d.text) + ' @ ' + (d.url || '') + ':' + (d.lineNumber + 1));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    errores.push(msg.params.type.toUpperCase() + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const cmd = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id; pend.set(myId, resolve);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
await cmd('Runtime.enable');
await cmd('Log.enable');
await cmd('Page.enable');
await cmd('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
};
console.log('--- módulos del explorador:');
console.log(await ev(`({ CMPExplorer: typeof window.CMPExplorer, CMPUtils: typeof window.CMPUtils, exRoot: !!document.getElementById('exRoot'), scripts: [...document.scripts].map(s=>s.src.split('/').pop()) })`));
console.log('--- errores capturados:');
errores.forEach((e) => console.log('  ' + e));
if (!errores.length) console.log('  (ninguno)');
ws.close();
