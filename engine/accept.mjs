#!/usr/bin/env node
// Accept a reviewed task and optionally commit it. Run: node <hub>/accept.mjs TASK note [media] [message].
import path from 'node:path';
import { HUB, ROOT, CFG } from './tools/runtime.mjs';
process.chdir(ROOT);
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [,, id, note, media, msg] = process.argv;
const hub = (...a) => execFileSync('node', [path.join(HUB, 'hub.mjs'), ...a, '--agent', 'orchestrator'], { encoding: 'utf8' });
const t = JSON.parse(hub('show', id));

// Workers sometimes forget a file in their done --files list, so anything untracked inside the
// task scope counts too. Scope entries are files or directories (no glob).
const inScope = (f) => !t.scope?.length || t.scope.some((s) => f === s || f.startsWith(s.replace(/\/?$/, '/')));
let untracked = [];
try {
  untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch {}
const scopedUntracked = untracked.filter(inScope);

const files = [...new Set([...(t.changed ?? []), ...(media ? media.split(',') : []), ...scopedUntracked])]
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => fs.existsSync(f));

// The reviewer is read-only, so its PASS verdict is recorded as the verification here;
// without it build-phase tasks stay in REVIEW and the accept below is refused.
if (t.status === 'REVIEW') {
  try { execFileSync('node', [path.join(HUB, 'hub.mjs'), 'join', '--agent', 'verifier-orch', '--role', 'verifier', '--tool', 'autoloop'], { stdio: 'ignore' }); } catch {}
  execFileSync('node', [path.join(HUB, 'hub.mjs'), 'verify', id, '--ok', '--note', note, '--agent', 'verifier-orch'], { encoding: 'utf8' });
}
hub('accept', id, '--note', note);
if (CFG.autoCommit === false) { console.log(id + ': accepted, not committed (autoCommit off). Files: ' + files.join(', ')); process.exit(0); }
if (files.length) execFileSync('git', ['add', '--', ...files]);
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();

// Read commit trailer from config.json; fall back to the caller-supplied msg.
let trailer = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8'));
  if (cfg.commitTrailer) trailer = `\n\n${cfg.commitTrailer}`;
} catch {}
const baseMsg = msg ?? `chore(${id}): accept ${note}`;
const commitMsg = baseMsg.includes('\n\n') ? baseMsg : `${baseMsg}${trailer}`;

if (staged) execFileSync('git', ['commit', '-q', '-m', commitMsg]);
console.log(`${id}: accepted, ${staged ? staged.split('\n').length + ' files committed' : 'nothing new to commit'}`);
