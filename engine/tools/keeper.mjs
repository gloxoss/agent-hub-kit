#!/usr/bin/env node
// keeper.mjs: keeps every builder lane busy. Every cycle it counts running builder jobs and, while a lane,
// memory and the executor's session cap allow it, starts the most useful READY task nobody is working on.
//
//   node .agent-hub/tools/keeper.mjs [--once] [--dry] [--interval 60]
//
// The autoloop never re-dispatches a task that already has old jobs, so finished-without-done, killed or
// idle ASSIGNED tasks sit forever. The keeper fills that gap. It starts builds only (reviews and accepts
// stay with the autoloop and the orchestrator) and never touches git.
//
// READY = status ASSIGNED, REWORK, OPEN or CLAIMED-without-a-live-job, dependencies met (strict tasks need
// ACCEPTED, the others need REVIEW or later), not excluded, not already running, scope not overlapping a
// running task (the claim would be refused), not tried in the last cooldown minutes, not stuck.
// Priority: the task that unblocks the most other unfinished tasks goes first.
// Executor: the queue lane, unless the task is sensitive (config.manualAccept) and the lane is an opencode
// one; then cursor, agy. Any executor at its maxSessions or that failed twice in 30 minutes is skipped.
//
// config.json "keeper": { "intervalSec": 60, "cooldownMin": 4, "maxAttempts": 3, "windowMin": 40,
//   "exclude": ["P-mollie-provider","O-observability"], "minFreeMB": 1000, "sensitiveFallback": ["cursor","agy"],
//   "fallback": ["cursor","agy","opencode-ds","opencode"], "lanes": 6 }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fold } from '../fold.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');
const ROOT = path.resolve(HUB, '..');
process.chdir(ROOT);
const HUB_REL = path.relative(ROOT, HUB).replace(/\\/g, '/');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY = args.includes('--dry');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const CFG = readJson(path.join(HUB, 'config.json'), {});
const K = { intervalSec: 60, cooldownMin: 4, maxAttempts: 3, windowMin: 40, lanes: 6, exclude: [], sensitiveFallback: ['cursor', 'agy'], fallback: ['cursor', 'agy', 'opencode-ds', 'opencode'], ...(CFG.keeper ?? {}) };
const iv = args.indexOf('--interval');
if (iv >= 0) K.intervalSec = Number(args[iv + 1]) || K.intervalSec;
// Free RAM swings by 2 to 4 GB each time an agent boots, so the keeper has its own, lower floor.
const MIN_FREE_MB = K.minFreeMB ?? CFG.resources?.buildMinFreeMB ?? 2500;
const BUILT = new Set(['REVIEW', 'VERIFIED', 'ACCEPTED']);
const FINAL = new Set(['ACCEPTED', 'CANCELLED']);
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

function jobs() {
  // Lines look like: <jobId>  <executor>  <task>  <STATUS>   (jobId ends with a base36 timestamp)
  let out = '';
  try { out = execFileSync('node', [`${HUB_REL}/dispatch.mjs`, 'list', '--all'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }); } catch (e) { out = String(e.stdout ?? ''); }
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^((builder|review)-\d+-.+-([a-z0-9]{6,10}))\s+(\S+)\s+(\S+)\s+(\S.*)$/);
    if (!m) continue;
    list.push({ id: m[1], kind: m[2], t: parseInt(m[3], 36), executor: m[4], task: m[5], status: m[6].trim().split(/\s+/)[0] });
  }
  return list;
}

const overlaps = (a, b) => a.some((x) => b.some((y) => x === y || x.startsWith(y.replace(/\/?$/, '/')) || y.startsWith(x.replace(/\/?$/, '/'))));

function transitiveUnblocked(T, id) {
  const seen = new Set();
  const walk = (x) => { for (const [k, t] of Object.entries(T)) if (!FINAL.has(t.status) && (t.deps ?? []).includes(x) && !seen.has(k)) { seen.add(k); walk(k); } };
  walk(id);
  return seen.size;
}

// Self-healing config: another session once overwrote config.json with an old copy (manualAccept, keeper and the
// slow-job floor vanished and the autoloop tried to accept sensitive tasks alone). config.good.json is the reference.
function guardConfig() {
  const good = readJson(path.join(HUB, 'config.good.json'), null);
  if (!good) return;
  const file = path.join(HUB, 'config.json');
  const cur = readJson(file, {});
  const lost = [];
  for (const key of ['manualAccept', 'keeper', 'slowJobFloorMinutes', 'skillRoots']) {
    if (good[key] === undefined) continue;
    const missing = cur[key] === undefined || (Array.isArray(good[key]) && Array.isArray(cur[key]) && good[key].some((x) => !cur[key].includes(x)));
    if (missing) lost.push(key);
  }
  // Memory floors and lane counts are tuning knobs the user or another session may change on purpose: never reverted.
  if (!lost.length) return;
  say(`KEEPER-CONFIG-LOST ${lost.join(',')}: restoring from config.good.json (restart the autoloop so it reloads)`);
  const merged = { ...cur };
  for (const key of lost) merged[key] = key === 'resources' ? { ...cur.resources, ...good.resources } : good[key];
  try { fs.chmodSync(file, 0o666); } catch {}
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  try { fs.chmodSync(file, 0o444); } catch {}
}

function cycle() {
  guardConfig();
  const events = fs.readFileSync(path.join(HUB, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = fold(events);
  const T = state.tasks ?? state;
  const J = jobs();
  const running = J.filter((j) => j.status === 'RUNNING');
  const runBuilds = running.filter((j) => j.kind === 'builder');
  const runningTasks = new Set(runBuilds.map((j) => j.task));
  const executors = readJson(path.join(HUB, 'executors.json'), { executors: [] }).executors;
  const cap = (name) => executors.find((e) => e.name === name)?.maxSessions ?? 3;
  const queue = readJson(path.join(HUB, 'autoloop-queue.json'), {});
  const manual = new Set(CFG.manualAccept ?? []);
  const now = Date.now();

  // Tasks waiting for the orchestrator: say so every cycle so nothing is forgotten.
  const waiting = Object.entries(T).filter(([id, t]) => t.status === 'REVIEW' && manual.has(id)).map(([id]) => id);
  if (waiting.length) say(`KEEPER-NEEDS-ORCH ${waiting.join(' ')}`);

  let free = K.lanes - runBuilds.length;
  const freeMb = Math.round(os.freemem() / 1048576);
  if (free <= 0) return say(`KEEPER-FULL ${runBuilds.length}/${K.lanes} lanes busy: ${runBuilds.map((j) => j.task + '@' + j.executor).join(' ')}`);
  if (freeMb < MIN_FREE_MB) return say(`KEEPER-LOW-RAM ${freeMb} MB free (< ${MIN_FREE_MB}), ${free} lane(s) idle`);

  const cand = [];
  for (const [id, t] of Object.entries(T)) {
    if (FINAL.has(t.status) || K.exclude.includes(id)) continue;
    if (!['ASSIGNED', 'REWORK', 'OPEN', 'CLAIMED', 'BLOCKED'].includes(t.status)) continue;
    if (runningTasks.has(id)) continue;
    if (t.phase === 'chore' || /^D-/.test(id)) continue;
    const unmet = (t.deps ?? []).filter((d) => (t.strict ? T[d]?.status !== 'ACCEPTED' : !BUILT.has(T[d]?.status)));
    if (unmet.length) continue;
    // An orchestrator fix (wider scope, new brief) wipes the past: runs/keeper-reset.json = { "TASK-ID": epoch_ms }.
    const resetAt = Number(readJson(path.join(HUB, 'runs', 'keeper-reset.json'), {})[id] ?? 0);
    const tries = J.filter((j) => j.kind === 'builder' && j.task === id && j.t > resetAt && now - j.t < K.windowMin * 60_000);
    if (tries.some((j) => now - j.t < K.cooldownMin * 60_000)) continue;
    if (tries.length >= K.maxAttempts) { say(`KEEPER-STUCK ${id}: ${tries.length} attempts in ${K.windowMin} min (${tries.map((j) => j.executor + ':' + j.status).join(', ')})`); continue; }
    // config keeper.priority: task ids that must start before anything else (critical path the dependency count cannot see).
    const prio = (K.priority ?? []).indexOf(id);
    cand.push({ id, t, tries, score: transitiveUnblocked(T, id) + (prio >= 0 ? 1000 - prio : 0) });
  }
  cand.sort((a, b) => b.score - a.score || (a.t.status === 'REWORK' ? -1 : 1));

  const started = [];
  const runScopes = runBuilds.map((j) => T[j.task]?.scope ?? []);
  for (const c of cand) {
    if (free <= 0) break;
    const scope = c.t.scope ?? [];
    if (scope.length && runScopes.some((s) => overlaps(scope, s))) continue;
    // Executor-level trouble only: a task that fails, or a job the orchestrator killed (DOWN), says nothing about the executor.
    // QUOTA or AUTH means the account is out; four plain failures in 30 minutes is a sign too.
    const bad = (ex) => {
      const recent = J.filter((j) => j.executor === ex && j.kind === 'builder' && now - j.t < 30 * 60_000);
      return recent.some((j) => /QUOTA|AUTH/.test(j.status)) || recent.filter((j) => /^FAILED/.test(j.status)).length >= 4;
    };
    const used = (ex) => running.filter((j) => j.kind === 'builder' && j.executor === ex).length + started.filter((s) => s.ex === ex).length;
    const sensitive = manual.has(c.id);
    const order = [queue[c.id], ...(sensitive ? K.sensitiveFallback : K.fallback)].filter((x, i, a) => x && a.indexOf(x) === i && executors.some((e) => e.name === x && e.kind !== 'reviewer'));
    const allowed = order.filter((ex) => !(sensitive && /^opencode/.test(ex)));
    const ex = allowed.find((e) => used(e) < cap(e) && !bad(e));
    if (!ex) { say(`KEEPER-SKIP ${c.id}: no healthy executor with a free session (${allowed.join(',')})`); continue; }
    if (DRY) { say(`KEEPER-DRY would start ${c.id} on ${ex} (unblocks ${c.score})`); started.push({ id: c.id, ex }); free--; runScopes.push(scope); continue; }
    let out = '';
    try { out = execFileSync('node', [`${HUB_REL}/dispatch.mjs`, 'run', ex, 'auto', c.id], { encoding: 'utf8', timeout: 120_000 }); } catch (e) { out = String(e.stdout ?? '') + String(e.message ?? ''); }
    if (/STARTED/.test(out)) { say(`KEEPER-START ${c.id} on ${ex} (unblocks ${c.score}, ${c.t.status}, try ${c.tries.length + 1})`); started.push({ id: c.id, ex }); free--; runScopes.push(scope); }
    else if (/no free lane/.test(out)) { say('KEEPER-FULL dispatch reports no free lane'); break; }
    else if (/already runs \d+ sessions/.test(out)) { say(`KEEPER-WAIT ${c.id}: executor at its session limit`); break; }
    else say(`KEEPER-FAIL ${c.id} on ${ex}: ${out.trim().split('\n')[0].slice(0, 160)}`);
  }
  if (!started.length) say(`KEEPER-IDLE ${runBuilds.length}/${K.lanes} lanes busy, ${cand.length} ready candidate(s), none startable`);
}

say(`KEEPER-UP lanes=${K.lanes} interval=${K.intervalSec}s minFreeMB=${MIN_FREE_MB}${DRY ? ' DRY' : ''}`);
const loop = () => { try { cycle(); } catch (e) { say(`KEEPER-ERROR ${e.message}`); } };
loop();
if (!ONCE) setInterval(loop, K.intervalSec * 1000);
