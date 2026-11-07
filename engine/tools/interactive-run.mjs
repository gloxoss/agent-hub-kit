#!/usr/bin/env node
// Runs one agent job as a normal INTERACTIVE session inside the terminal pane that Herdr opened for it
// (the same screen you get when you type `opencode`, `agy` or `codex` yourself, with the task already sent
// as the first message). You can read it work and talk to it.
//
//   node .agent-hub/tools/interactive-run.mjs <spec.json>
//
// spec: { cmd, args, cwd, log, builder, task, startedAt }
//
// Hub accounting, because an interactive agent never "exits" by itself when it is done:
//  - the log gets a heartbeat line every 30 s, so the hub sees the job as alive;
//  - the log gets the usual "[dispatch] exit N" marker when the agent process quits, OR when the builder
//    writes its `leave` event in events.jsonl (its normal way of saying "I am finished");
//  - after that marker the agent window stays open and usable until YOU close it.
// Output of the session is not captured (it is a live screen), so a quota or login problem shows in the
// pane but not in the hub's diagnosis. Use the headless mode (config.herdr.interactive = false) for that.

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("usage: interactive-run.mjs <spec.json>  (runs one agent job as an interactive session in this terminal)"); process.exit(0); }

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');
const ROOT = path.resolve(HUB, '..');

const specFile = process.argv[2];
if (!specFile) {
  console.error('usage: interactive-run.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const log = path.isAbsolute(spec.log) ? spec.log : path.join(ROOT, spec.log);
const startedAt = spec.startedAt ?? Date.now();

const append = (s) => { try { fs.appendFileSync(log, `${s}\n`); } catch {} };
const quote = (s) => (/^[\w./:=@%+-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);

console.log(`\x1b[1mHub job: ${spec.task ?? ''}  (${spec.builder ?? ''})\x1b[0m`);
console.log('The agent below is a normal session. You can read it and talk to it.');
console.log('The hub counts the job as finished when the agent says "leave"; this window stays open for you.\n');

append(`[interactive] ${new Date().toISOString()} started: ${spec.cmd} (${spec.task ?? ''})`);

let ended = false;
function markEnded(code) {
  if (ended) return;
  ended = true;
  clearInterval(heartbeat);
  clearInterval(watcher);
  append(`\n[dispatch] exit ${code}`);
}

const line = process.platform === 'win32' ? [[spec.cmd, ...spec.args].map(quote).join(' ')] : null;
const child = line
  ? spawn(line[0], [], { cwd: spec.cwd || ROOT, stdio: 'inherit', shell: true, env: { ...process.env, HUB_ROOT: ROOT } })
  : spawn(spec.cmd, spec.args, { cwd: spec.cwd || ROOT, stdio: 'inherit', env: { ...process.env, HUB_ROOT: ROOT } });

const heartbeat = setInterval(() => append(`[interactive] alive ${new Date().toISOString()}`), 30000);

// The builder finishes by writing `leave` to the hub. Look for it after our start time.
const watcher = setInterval(() => {
  if (ended || !spec.builder) return;
  try {
    const tail = fs.readFileSync(path.join(HUB, 'events.jsonl'), 'utf8').split('\n').slice(-400);
    for (const l of tail) {
      if (!l.includes('"leave"') || !l.includes(spec.builder)) continue;
      const e = JSON.parse(l);
      if (e.type === 'leave' && e.agent === spec.builder && Date.parse(e.t) >= startedAt) {
        append(`[interactive] ${spec.builder} left the hub; the session stays open for you`);
        markEnded(0);
        return;
      }
    }
  } catch {}
}, 5000);

child.on('exit', (code) => {
  markEnded(code ?? 1);
  process.exit(code ?? 1);
});
child.on('error', (e) => {
  append(`[interactive] could not start: ${e.message}`);
  markEnded(1);
  process.exit(1);
});
