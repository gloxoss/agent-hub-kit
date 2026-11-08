#!/usr/bin/env node
// Type check that fails ONLY for errors inside this task's own files.
// With many builders working at once, one unfinished file used to make every other task fail its type check.
//
//   node .agent-hub/tools/scoped-tsc.mjs backend --task <TASK-ID>      runs tsc in the backend container
//   node .agent-hub/tools/scoped-tsc.mjs ui --task <TASK-ID>           runs tsc in "MORENE UI"
//   node .agent-hub/tools/scoped-tsc.mjs backend --files "a,b"         files given by hand
//
// Exit 0 = no error in the task's files (errors elsewhere are counted and named, not blamed). Exit 1 = error in the task's files.
// Exit 2 = the check could not run (container down, bad arguments): the proof was NOT run.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length < 4) {
  console.log('usage: scoped-tsc.mjs backend|ui --task <TASK-ID> | --files "a,b"   (fails only for errors in the task\'s own files)');
  process.exit(process.argv.length < 4 ? 2 : 0);
}

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HUB, '..');
const target = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const norm = (p) => p.replace(/\\/g, '/');

let mine = [];
if (arg('task')) {
  const out = execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), 'show', arg('task')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENT_ID: 'orchestrator' } });
  mine = JSON.parse(out).scope ?? [];
} else if (arg('files')) mine = arg('files').split(',').map((s) => s.trim()).filter(Boolean);
else { console.error('give --task or --files'); process.exit(2); }

let result;
if (target === 'backend') {
  result = spawnSync(process.execPath, [path.join(HUB, 'tools', 'container-check.mjs'), 'tsc'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
} else if (target === 'ui') {
  result = spawnSync(process.execPath, [path.join(ROOT, 'MORENE UI', 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(ROOT, 'MORENE UI')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
} else { console.error('target must be backend or ui'); process.exit(2); }

// tsc itself exits 2 when it finds type errors, so "container down" is recognised by its message, not by the exit code.
if (target === 'backend' && /is not running \(start Docker/.test(result.stderr ?? '')) { process.stdout.write(result.stderr); process.exit(2); }
const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const errors = text.split(/\r?\n/).map((l) => l.trim().match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)).filter(Boolean);
// tsc prints paths relative to the project folder (backend: src/...; ui: src/... or MORENE UI/...): match by file name tail.
const prefix = target === 'backend' ? 'MORENE/backend/' : 'MORENE UI/';
const inMine = (file) => {
  const full = norm(file).startsWith('MORENE') ? norm(file) : prefix + norm(file);
  return mine.some((m) => full === norm(m) || full.startsWith(norm(m).replace(/\/$/, '') + '/'));
};
const own = errors.filter((e) => inMine(e[1]));
const others = errors.filter((e) => !inMine(e[1]));
console.log(`type errors: ${errors.length} total, ${own.length} in this task's files, ${others.length} elsewhere (not blamed)`);
for (const e of others.slice(0, 5)) console.log(`  elsewhere: ${e[1]}(${e[2]}): ${e[4]}`);
if (!errors.length && result.status !== 0) { console.log('tsc failed without a readable error line:\n' + text.slice(0, 400)); process.exit(2); }
if (own.length) { console.log('ERRORS IN THIS TASK\'S FILES:'); for (const e of own) console.log(`  ${e[1]}(${e[2]},${e[3]}): ${e[4]} ${e[5]}`); process.exit(1); }
console.log('no type error in this task\'s files');
