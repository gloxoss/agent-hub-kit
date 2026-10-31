#!/usr/bin/env node
// Merge a second hub folder into the live one. Safe to run twice: events are de-duplicated by content, task briefs and
// other files are copied only when missing, and the live events.jsonl is backed up first. Dry run unless --apply.
//   node hub-merge.mjs <srcHubDir> <destHubDir> [--apply] [--archive]
// --archive renames the source folder to <src>.merged-<date> after a successful apply, so only one hub stays live.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { help } from './runtime.mjs';

help('usage: hub-merge.mjs <srcHubDir> <destHubDir> [--apply] [--archive]');

const readEvents = (dir) => {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

// Union by content, ordered by time (ties keep their original order: sources first, then dest), then re-fold.
export function mergeEvents(src, dest) {
  const seen = new Set();
  const all = [];
  let n = 0;
  for (const e of [...src, ...dest]) {
    const k = JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push({ e, n: n++ });
  }
  all.sort((a, b) => (Date.parse(a.e.t) || 0) - (Date.parse(b.e.t) || 0) || a.n - b.n);
  return all.map((x) => x.e);
}

const count = (events, type) => events.filter((e) => e.type === type).length;
const taskStates = (events) => {
  const st = new Map();
  for (const e of events) {
    if (e.type === 'task-add') st.set(e.id, 'OPEN');
    else if (e.type === 'accept') st.set(e.id, 'ACCEPTED');
    else if (e.type === 'cancel') st.set(e.id, 'CANCELLED');
    else if (e.type === 'reject') st.set(e.id, 'REWORK');
    else if (e.type === 'done' && st.get(e.id) !== 'ACCEPTED') st.set(e.id, 'REVIEW');
  }
  return st;
};

function copyMissing(srcDir, destDir, rel, stats) {
  const from = path.join(srcDir, rel);
  if (!fs.existsSync(from)) return;
  const to = path.join(destDir, rel);
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(from)) copyMissing(srcDir, destDir, path.join(rel, name), stats);
  } else if (!fs.existsSync(to)) {
    stats.files++;
    if (stats.apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}

export function runSelfTest() {
  const a = [{ t: '2026-01-01T00:00:01Z', type: 'task-add', id: 'T1' }, { t: '2026-01-01T00:00:05Z', type: 'accept', id: 'T1' }];
  const b = [{ t: '2026-01-01T00:00:01Z', type: 'task-add', id: 'T1' }, { t: '2026-01-01T00:00:02Z', type: 'task-add', id: 'T2' }];
  const m = mergeEvents(a, b);
  const twice = mergeEvents(m, m);
  const st = taskStates(m);
  return [
    ['union de-duplicates', m.length === 3],
    ['merging twice changes nothing', twice.length === 3],
    ['time ordered', m.map((e) => e.t).join() === [...m.map((e) => e.t)].sort().join()],
    ['later accept wins', st.get('T1') === 'ACCEPTED' && st.get('T2') === 'OPEN'],
  ];
}

const argv = process.argv.slice(2);
if (argv[0] === '--selftest') {
  const rows = runSelfTest();
  for (const [name, ok] of rows) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  process.exit(rows.every(([, ok]) => ok) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [srcArg, destArg] = argv.filter((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  if (!srcArg || !destArg) { console.error('usage: hub-merge.mjs <srcHubDir> <destHubDir> [--apply] [--archive]'); process.exit(2); }
  const src = path.resolve(srcArg), dest = path.resolve(destArg);
  if (src === dest) { console.error('source and destination are the same folder'); process.exit(2); }

  // Refuse while jobs are running in either hub: a merge under a live autoloop races its writes.
  for (const dir of [src, dest]) {
    const f = path.join(dir, 'runs', 'jobs.jsonl');
    if (!fs.existsSync(f)) continue;
    const live = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-80).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((j) => j?.pid && (() => { try { process.kill(Number(j.pid), 0); return true; } catch { return false; } })());
    if (live.length && apply) { console.error(`${live.length} job(s) still running in ${dir}: ${live.map((j) => j.taskId).join(', ')}. Merge in a quiet window.`); process.exit(3); }
    if (live.length) console.log(`note: ${live.length} job(s) running in ${dir}; --apply would refuse`);
  }

  const a = readEvents(src), b = readEvents(dest);
  const merged = mergeEvents(a, b);
  const before = taskStates(b), after = taskStates(merged);
  const changed = [...after].filter(([id, s]) => before.get(id) !== s);
  const stats = { files: 0, apply };
  for (const rel of ['tasks', 'docs', 'pages', 'skills']) copyMissing(src, dest, rel, stats);
  console.log(`events: source ${a.length}, destination ${b.length}, merged ${merged.length} (+${merged.length - b.length})`);
  console.log(`tasks: destination ${before.size}, merged ${after.size}; ${changed.length} task(s) change state`);
  const byState = {};
  for (const [, s] of after) byState[s] = (byState[s] ?? 0) + 1;
  console.log(`merged states: ${JSON.stringify(byState)}`);
  console.log(`files to copy (missing in destination): ${stats.files}`);
  if (!apply) { console.log('(dry run: nothing written; add --apply)'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dest, 'engine.prev', `merge-${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(path.join(dest, 'events.jsonl'), path.join(backup, 'events.jsonl'));
  const tmp = path.join(dest, 'events.jsonl.merge');
  fs.writeFileSync(tmp, merged.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, path.join(dest, 'events.jsonl'));
  console.log(`merged. Previous events saved in ${backup}`);
  const status = spawnSync(process.execPath, [path.join(dest, 'hub.mjs'), 'status'], { cwd: path.dirname(dest), encoding: 'utf8' });
  console.log((status.stdout || '').split('\n').find((l) => l.startsWith('tasks:')) ?? '(status unavailable)');
  if (argv.includes('--archive')) {
    const target = `${src}.merged-${stamp.slice(0, 10)}`;
    fs.renameSync(src, target);
    console.log(`source archived as ${target}`);
  }
}
