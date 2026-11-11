#!/usr/bin/env node
// Bitácora / ledger del Ciudadan Media Player.
//
// El servicio MCP `ciudadan_knowledge` (ledger_append / memory_append) no está
// disponible en esta sesión, así que este script escribe en el ESPEJO LOCAL
// documentado por operations/ledger-policy.md:
//   $DSH_HOME/memory/operations-log.jsonl   (append-only, nunca se reescribe)
// y además en el registro propio del proyecto (logs/ledger.jsonl), que
// acompaña al repositorio.
//
// Uso:
//   node tools\ledger.mjs start "texto" [json-extra]
//   node tools\ledger.mjs checkpoint "texto" [json-extra]
//   node tools\ledger.mjs finish "texto" [json-extra]
//   node tools\ledger.mjs fail "texto" [json-extra]
//
// El campo `extra` es JSON con: result, evidence, changes, constraints_respected,
// risk, next. Nunca se registran tokens, cookies ni claves.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT = 'ciudadan-media-player';
const SCOPE = 'repo:ciudadan-media-player:app';
const RESOURCE = 'repo:ciudadan-media-player';
const AGENT = 'minimax-m3.1-flash/' + ((process.env.DSH_HOME || '').match(/dsh(\d)/i)?.[1] || 'dsh1');
const SESSION = process.env.DSH_SESSION_ID || 'session-ciudadan-media-player';

const [, , kind, intent, extraRaw] = process.argv;
if (!kind || !intent) {
  console.error('uso: node tools\\ledger.mjs <start|checkpoint|finish|fail> "texto" [json]');
  process.exit(2);
}
let extra = {};
if (extraRaw) {
  try { extra = JSON.parse(extraRaw); } catch (e) {
    console.error('JSON extra invalido:', e.message);
    process.exit(2);
  }
}

const now = new Date();
const entry = {
  ts: now.toISOString(),
  op: 'ciudadan-media-player-' + kind + '-' + Date.now().toString(36),
  agent_id: AGENT,
  session_id: SESSION,
  project: PROJECT,
  scope: SCOPE,
  resource_key: RESOURCE,
  intent,
  status: kind === 'fail' ? 'task_fail' : (kind === 'finish' ? 'task_finish' : 'task_checkpoint'),
  result: extra.result || null,
  evidence: extra.evidence || null,
  changes: extra.changes || [],
  constraints_respected: extra.constraints_respected || [],
  risk: extra.risk || 'low',
  next: extra.next || null,
};
const line = JSON.stringify(entry);

function append(file) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('no se pudo escribir en', file, e.message);
    return false;
  }
}

const written = [];
// 1) registro propio del proyecto
if (append(path.join(process.cwd(), 'logs', 'ledger.jsonl'))) written.push(path.join(process.cwd(), 'logs', 'ledger.jsonl'));
// 2) espejo local del DSH (append-only). Se prueban los homes conocidos y el
//    primero que exista recibe la entrada.
const homes = [
  process.env.DSH_HOME,
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh1',
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh2',
].filter(Boolean);
for (const home of homes) {
  const file = path.join(home, 'memory', 'operations-log.jsonl');
  if (fs.existsSync(path.dirname(file)) && append(file)) { written.push(file); break; }
}

console.log('ledger ' + kind + ' -> ' + (written.length ? written.join(', ') : 'sin destino'));
console.log(line);
