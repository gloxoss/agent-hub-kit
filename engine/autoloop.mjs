#!/usr/bin/env node
// Autoloop: runs the routine review cycle so the orchestrator only wakes for decisions.
//   built (REVIEW)             -> start a read-only review
//   review PASS                -> accept + commit the task's files
//   first review FAIL          -> verdict appended to the brief, reject, re-dispatch the builder's executor
//   later review FAIL          -> print DECIDE (orchestrator applies the stop rule)
//   REWORK with deps met, idle -> dispatch a build
//   build/review job failed    -> retry on the next executor; quota/auth problems are printed
// Only lines worth waking the orchestrator go to stdout. Usage: node .agent-hub/autoloop.mjs [--once] [--dry]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
let HUB = path.basename(path.dirname(fileURLToPath(import.meta.url)));
if (!fs.existsSync(path.join(ROOT, HUB, 'hub.mjs'))) {
  if (fs.existsSync(path.join(ROOT, 'hub.mjs'))) HUB = '.';
  else if (fs.existsSync(path.join(ROOT, '.agent-hub-orch', 'hub.mjs'))) HUB = '.agent-hub-orch';
  else if (fs.existsSync(path.join(ROOT, '.hub', 'hub.mjs'))) HUB = '.hub';
}
const STATE = `${HUB}/autoloop-state.json`;
const TICK_MS = 60_000;

const JOBS_FILE = path.join(ROOT, HUB, 'runs', 'jobs.jsonl');
const readJobs = () => (fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function alivePids() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
      return new Set([...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => m[1]));
    }
    const out = execSync('ps -eo pid=', { encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

function isLive(job, alive) {
  const logPath = path.join(ROOT, job.log || `${HUB}/runs/${job.id}.log`);
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch {}
  if (/^\[dispatch\] exit/m.test(text)) return false;
  if (alive.has(String(job.pid))) return true;
  try { return Date.now() - fs.statSync(logPath).mtimeMs < 120_000; } catch { return false; }
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      try { execSync(`pkill -P ${pid}`); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

const DURATIONS_FILE = path.join(ROOT, HUB, 'runs', 'durations.json');
function getMedian(executor, phase) {
  try {
    const data = JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8'));
    const key = `${executor}:${phase}`;
    if (typeof data[key] === 'number') return data[key];
    const arr = data.durations?.[key];
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  } catch {
    return null;
  }
}

// Read config.json for project-specific settings.
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(`${HUB}/config.json`, 'utf8')); } catch { return {}; }
}
const CFG = loadConfig();
const BACKLOG_PATH = CFG.backlogPath ?? 'docs/BACKLOG.md';
const DIGEST_MS = (CFG.digestMinutes ?? 20) * 60_000;
const COMMIT_TRAILER = CFG.commitTrailer ?? '';

// Read the executor table. An entry that needs a user-made launcher is skipped until that launcher exists.
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function launcherExists(name) {
  const dir = path.join(os.homedir(), '.claude-launchers');
  if (['.ps1', '.cmd', '.bat', '.exe'].some((ext) => fs.existsSync(path.join(dir, name + ext)))) return true;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return probe.status === 0;
}
const TABLE = readJson(`${HUB}/executors.json`, { executors: [] });
const ALL_DEFS = Array.isArray(TABLE) ? TABLE : (TABLE.executors ?? []);
const EXECUTOR_DEFS = ALL_DEFS.filter((d) => !d.disabled && (!d.requiresLauncher || launcherExists(d.name)));
const enabled = (name) => EXECUTOR_DEFS.some((d) => d.name === name);

function resolveExecutor(entry) {
  if (!entry) return null;
  const candidates = [entry.id, entry.command, entry.family];
  for (const c of candidates) {
    if (c && enabled(c)) return c;
  }
  const familyMap = { gemini: 'agy', antigravity: 'agy', codex: 'codex', opencode: 'opencode', cursor: 'cursor', claude: 'claude-ag2-sonnet' };
  const mapped = familyMap[entry.family] || familyMap[entry.command];
  if (mapped && enabled(mapped)) return mapped;
  const found = EXECUTOR_DEFS.find((d) => d.disabled !== true && (d.name.includes(entry.id) || d.name.includes(entry.family) || d.name.includes(entry.command)));
  return found ? found.name : null;
}

function getPickedList(role, excludeList = []) {
  try {
    const accountsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'accounts.mjs');
    if (!fs.existsSync(accountsPath)) return [];
    const { pick } = require('./accounts.mjs');
    if (typeof pick !== 'function') return [];
    const entries = pick({ role, hubDir: HUB, exclude: excludeList });
    const list = [];
    for (const entry of entries) {
      const name = resolveExecutor(entry);
      if (name && enabled(name) && !list.includes(name)) {
        list.push(name);
      }
    }
    return list;
  } catch {
    return [];
  }
}

function getRemoteReviewerNode() {
  try {
    const out = execSync(`node ${path.join(ROOT, HUB, 'board.mjs')} area list --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const areas = JSON.parse(out);
    const now = Date.now();
    const node = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
    for (const a of areas) {
      if (a.prefix === 'reviews' && a.node && a.node.toLowerCase() !== node) {
        if (a.since && now - Date.parse(a.since) < 3600_000) {
          return a.node.toLowerCase();
        }
      }
    }
  } catch {}
  return null;
}

function areWeReviewsOwner() {
  try {
    const out = execSync(`node ${path.join(ROOT, HUB, 'board.mjs')} area list --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const areas = JSON.parse(out);
    const now = Date.now();
    const node = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
    for (const a of areas) {
      if (a.prefix === 'reviews' && a.node && a.node.toLowerCase() === node) {
        if (a.since && now - Date.parse(a.since) < 3600_000) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

// Fallbacks and picked accounts (accounts.pick integration)
const staticBuild = (Array.isArray(TABLE.buildOrder) ? TABLE.buildOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['builder', 'both'].includes(EXECUTOR_DEFS.find((d) => d.name === n).kind));
const pickedBuild = getPickedList('builder');
const buildOrder = pickedBuild.length ? [...new Set([...pickedBuild, ...staticBuild])] : staticBuild;
const BUILD_FALLBACK = buildOrder;

const staticReview = (Array.isArray(TABLE.reviewOrder) ? TABLE.reviewOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['reviewer', 'both'].includes(EXECUTOR_DEFS.find((d) => d.name === n).kind));
const pickedReview = getPickedList('reviewer');
const reviewOrder = pickedReview.length ? [...new Set([...pickedReview, ...staticReview])] : staticReview;
// When the first reviewer is down, these two take turns so neither drains alone.
const SHARED_REVIEWERS = (Array.isArray(TABLE.sharedReviewers) ? TABLE.sharedReviewers : []).filter(enabled);

const DOWN_MS = (CFG.cooldownMinutes ?? 60) * 60_000; // an executor that hit QUOTA/AUTH/DOWN is skipped for an hour
const BUILT = new Set(['REVIEW', 'VERIFIED', 'ACCEPTED']);
const PROBLEM = /QUOTA|AUTH|DOWN|FAILED|NO VERDICT/;

const say = (s) => console.log(s);
const DRY = process.argv.includes('--dry');
function maybeEmitResource(msg) {
  const stateFile = path.join(HUB, 'runs', 'resource-last.json');
  let last = 0;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    last = data.at ?? 0;
  } catch {}
  const now = Date.now();
  if (now - last > 3600_000) {
    console.log(`RESOURCE: ${msg}`);
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ at: now, msg }));
    } catch {}
  }
}
// The quota-burn breaker holds NEW BUILDS only (reviews and accepts must keep running or the backlog can never clear).
// The hold releases itself after the first accept since it tripped, or after burnHoldMinutes.
const HOLD_FILE = `${HUB}/runs/burn-hold.json`;
const readHold = () => { try { return JSON.parse(fs.readFileSync(HOLD_FILE, 'utf8')); } catch { return null; } };
let REVIEW_BACKLOG = 0;   // tasks waiting for a review verdict; refreshed every tick
const run = (args) => {
  if (args[0].endsWith('dispatch.mjs') && args[1] === 'run' && !DRY) {
    const last = String(args[args.length - 1]);
    const hold = readHold();
    if (hold) { say(`HELD build ${last}: ${hold.why}`); return ''; }
    const cap = CFG.maxReviewBacklog ?? 8;
    if (REVIEW_BACKLOG >= cap) { say(`WAIT build ${last}: ${REVIEW_BACKLOG} tasks are waiting for review (limit ${cap}); reviews go first`); return ''; }
  }
  if (DRY && !(args[0].endsWith('dispatch.mjs') && args[1] === 'list')) { say(`DRY ${args.join(' ')}`); return ''; }
  try { return execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) {
    const why = String(e.stderr || e.message).split('\n')[0];
    say(`DISPATCH-FAIL ${args.slice(0, 4).map((x) => String(x).replace(/^.*[\\/]/, '')).join(' ')}: ${why.slice(0, 160)}`);   // never swallow a failed dispatch
    return `ERROR ${why}`;
  }
};
const hub =(...a) => run([`${HUB}/hub.mjs`, ...a, '--agent', (CFG.orchestratorAgent || 'orchestrator')]);
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { handled: {}, lastDigest: 0 }; } };
// Retry-type keys expire after 30 min so a stuck task is retried instead of silently parked.
const EXPIRE = /^(retry|queue|rework|resume|review):/;
const prune = (s) => { for (const [k, at] of Object.entries(s.handled)) if (EXPIRE.test(k) && Date.now() - at > (k.startsWith('queue:') ? (CFG.queueRetryMinutes ?? 10) : 30) * 60_000) delete s.handled[k]; return s; };
const save = (s) => DRY || fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

function tasks() {
  const t = {};
  for (const l of fs.readFileSync(`${HUB}/events.jsonl`, 'utf8').split('\n')) {
    if (!l) continue;
    const e = JSON.parse(l);
    if (e.type === 'task-add') t[e.id] = { id: e.id, deps: e.deps ?? [], scope: e.scope ?? [], status: 'OPEN', rejects: 0, doneAt: 0, rejectAt: 0 };
    const x = e.id && t[e.id];
    if (!x || e.type === 'task-add') continue;
    const at = Date.parse(e.t);
    switch (e.type) {
      case 'claim': x.status = 'CLAIMED'; break;
      case 'assign': if (['OPEN', 'REWORK'].includes(x.status)) x.status = 'ASSIGNED'; break;
      case 'release': x.status = 'ASSIGNED'; break;
      case 'block': x.status = 'BLOCKED'; break;
      case 'done': Object.assign(x, { status: 'REVIEW', doneAt: at }); break;
      case 'accept': x.status = 'ACCEPTED'; break;
      case 'reject': Object.assign(x, { status: 'REWORK', rejects: x.rejects + 1, rejectAt: at }); break;
      case 'cancel': x.status = 'CANCELLED'; break;
      case 'edit': for (const k of ['deps', 'scope', 'strict']) if (e[k] !== undefined) x[k] = e[k]; break;
    }
  }
  return t;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function jobs() {
  const out = [];
  const text = run([`${HUB}/dispatch.mjs`, 'list', '--all']);
  const rawJobs = readJobs();
  for (const line of text.split('\n')) {
    if (!/^(builder|review)-/.test(line)) continue;
    const [name, executor, task, ...rest] = line.trim().split(/\s{2,}/);
    const id = name.split('-').pop();
    const raw = rawJobs.find((j) => j.taskId === task && j.executor === executor && j.id.endsWith(id)) || rawJobs.find((j) => j.taskId === task && j.executor === executor) || {};
    out.push({
      name,
      executor,
      task,
      status: rest.join(' '),
      review: name.startsWith('review-'),
      lane: name.slice(0, name.indexOf(`-${task}-`)),
      started: raw.t ? Date.parse(raw.t) : (parseInt(id, 36) || 0),
      pid: raw.pid,
      mode: raw.mode,
      id: raw.id || id
    });
  }
  return out;
}

const latest = (js, task, review, after) => js.filter((j) => j.task === task && j.review === review && j.started >= after).sort((a, b) => b.started - a.started)[0];
const nextOf = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

function tick(st) {
  const T = tasks();
  REVIEW_BACKLOG = Object.values(T).filter((t) => t.status === 'REVIEW').length;
  const hold = readHold();
  if (hold) {
    const accepted = Object.values(T).filter((t) => t.status === 'ACCEPTED').length;
    if (hold.acceptedAtTrip === undefined) { try { fs.writeFileSync(HOLD_FILE, JSON.stringify({ ...hold, acceptedAtTrip: accepted })); } catch { /* retry next tick */ } }
    else {
      const ageMin = (Date.now() - Date.parse(hold.at)) / 60000;
      if (accepted > hold.acceptedAtTrip || ageMin >= (CFG.burnHoldMinutes ?? 45)) {
        try { fs.unlinkSync(HOLD_FILE); } catch { /* already gone */ }
        say(`BURN-RELEASED after ${Math.round(ageMin)} min (${accepted - hold.acceptedAtTrip} task(s) accepted since the hold)`);
      }
    }
  }
  const J = jobs();
  const once = (key, fn) => { if (!st.handled[key]) { st.handled[key] = Date.now(); fn(); } };
  const depsMet = (t) => t.deps.every((d) => (t.strict ? T[d]?.status === 'ACCEPTED' : BUILT.has(T[d]?.status)));
  const lastBuild = (t) => latest(J, t.id, false, 0);
  st.down ??= {};
  const up = (ex) => !st.down[ex] || Date.now() - st.down[ex] > DOWN_MS;
  // Healthy-first: skip the reviewer that just failed, and rotate the shared reviewers when the first is down.
  const reviewer = (failed, builder) => {
    const exclude = [failed, builder, ...Object.keys(st.down || {}).filter((e) => !up(e))].filter(Boolean);
    const picked = getPickedList('reviewer', exclude);
    const ok = (e) => e !== failed && e !== builder && up(e);
    const pool = picked.length ? picked.filter(ok) : SHARED_REVIEWERS.filter(ok);
    if (!failed && pool.length && !up(pool[0])) {
      st.rr = ((st.rr ?? 0) + 1) % pool.length;
      return pool[st.rr];
    }
    const found = (picked.length ? picked : reviewOrder).find(ok);
    if (found) return found;
    return SHARED_REVIEWERS.find(ok) ?? null;
  };
  const builderOf = (id) => latest(J, id, false, 0)?.executor;
  const nextHealthy = (list, cur) => {
    const exclude = Object.keys(st.down || {}).filter((e) => !up(e));
    const picked = getPickedList('builder', exclude);
    const order = picked.length ? picked : list;
    const i = order.indexOf(cur);
    const rotated = [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0))];
    return rotated.find((e) => e !== cur && up(e) && enabled(e)) ?? nextOf(list, cur);
  };
  // Any rework or resume goes to a healthy executor, never back to one that is cooling down.
  const pickBuilder = (preferred) => {
    const exclude = Object.keys(st.down || {}).filter((e) => !up(e));
    const picked = getPickedList('builder', exclude);
    const validPicked = picked.find(up);
    if (validPicked) return validPicked;
    if (preferred && up(preferred) && enabled(preferred)) return preferred;
    return buildOrder.find(up) ?? buildOrder[0] ?? preferred ?? 'opencode';
  };

  // Check for overlong running jobs (> 2x median, min 20 min, default 45 min)
  for (const j of J) {
    if (j.status !== 'RUNNING') continue;
    const started = j.started || Date.parse(j.t) || Date.now();
    const elapsedMin = Math.round((Date.now() - started) / 60_000);
    const phase = j.review ? 'review' : (j.mode || 'run');
    let durationsData = { durations: {} };
    try { durationsData = JSON.parse(fs.readFileSync(path.join(HUB, 'runs', 'durations.json'), 'utf8')); } catch {}
    const key = `${j.executor}:${phase}`;
    const arr = durationsData.durations?.[key] || [];
    const med = median(arr);
    const thresholdMin = med !== null ? Math.max(20, 2 * med) : 45;

    if (elapsedMin > thresholdMin) {
      once(`slow:${j.id}`, () => {
        killProcessTree(j.pid);
        const lane = j.lane || j.agentId;
        if (lane) {
          hub('kick', lane, '--note', `stopped after ${elapsedMin} min (2x normal)`);
        }
        const next = nextHealthy(BUILD_FALLBACK, j.executor);
        run([`${HUB}/dispatch.mjs`, 'run', next, lane || 'auto', j.task]);
        say(`MOVED ${j.task}: slow`);
      });
    }
  }

  // If we own the "reviews" area, pick up review requests from other machines
  if (areWeReviewsOwner()) {
    try {
      const list = JSON.parse(execSync('gh issue list --label board --state open --limit 50 --json number,title,comments', { encoding: 'utf8' }));
      for (const issue of list) {
        const tid = issue.title.match(/^\[([^\]]+)\]/)?.[1];
        if (!tid) continue;
        const hasReviewReq = issue.comments?.some((c) => c.body && c.body.includes(`review request ${tid}`));
        if (hasReviewReq) {
          const existingReview = latest(J, tid, true, 0);
          if (!existingReview && T[tid]?.status === 'REVIEW') {
            const rv = reviewer(undefined, null);
            if (rv) {
              once(`remote-review-dispatch:${tid}`, () => {
                run([`${HUB}/dispatch.mjs`, 'review', tid, rv]);
                say(`DISPATCHED remote review for ${tid} on ${rv}`);
              });
            }
          }
        }
      }
    } catch {}
  }

  for (const t of Object.values(T)) {
    if (t.status === 'REVIEW') {
      const r = latest(J, t.id, true, t.doneAt - 5_000);
      if (!r) {
        const remoteNode = getRemoteReviewerNode();
        if (remoteNode) {
          once(`review-request:${t.id}`, () => {
            try {
              execSync(`node ${path.join(ROOT, HUB, 'board.mjs')} note ${t.id} "review request ${t.id}"`, { stdio: 'ignore' });
            } catch {}
          });
          continue;
        }
        const rv = reviewer(undefined, builderOf(t.id));
        // Keyed per 10-minute window: if dispatch could not start the review (reviewer at its session cap),
        // no review job appears and the next window tries again instead of parking forever.
        if (rv) once(`review:${t.id}:${t.doneAt}:${Math.floor(Date.now() / 600_000)}`, () => run([`${HUB}/dispatch.mjs`, 'review', t.id, rv]));
        continue;
      }
      if (r.status === 'VERDICT: PASS') {
        once(`accept:${r.name}`, () => {
          const media = t.scope.filter((s) => s.startsWith('public/')).join(',');
          // Reviewer's non-blocking findings (stop rule) go to the configured backlog.
          const backlog = fs.readFileSync(`${HUB}/runs/${r.name}.verdict.md`, 'utf8').split('\n').filter((l) => l.startsWith('BACKLOG:'));
          if (backlog.length && !DRY) {
            try {
              fs.mkdirSync(path.dirname(BACKLOG_PATH), { recursive: true });
              if (!fs.existsSync(BACKLOG_PATH)) fs.writeFileSync(BACKLOG_PATH, '# Backlog\n');
              fs.appendFileSync(BACKLOG_PATH, `\n- **${t.id}** (review ${r.name}): ${backlog.map((l) => l.slice(8).trim()).join(' | ')}\n`);
            } catch (e) { say(`BACKLOG ERROR ${e.message}`); }
          }
          const trailer = COMMIT_TRAILER ? `\n\n${COMMIT_TRAILER}` : '';
          run([`${HUB}/accept.mjs`, t.id, `review ${r.name} PASS`, media, `feat: ${t.id} (autoloop accept)${trailer}`]);
          say(`ACCEPTED ${t.id}`);
          // Work the user wants to look at as soon as it lands (config.notifyVisible: regex on task ids).
          if (CFG.notifyVisible && new RegExp(CFG.notifyVisible).test(t.id)) say(`VISIBLE ${t.id}`);
          // An accepted planner with a task table becomes build tasks right away (config.planners: regex on task ids).
          const plan = new RegExp(CFG.planners ?? '^M-').test(t.id) && t.scope.find((s) => /\/plans\/.+\.md$/.test(s));
          if (plan && fs.existsSync(plan) && /#+ .*Task table/i.test(fs.readFileSync(plan, 'utf8'))) {
            const out = run([`${HUB}/tools/gen-tasks.mjs`, plan, '[A-Z]-[a-z0-9]+-', '--after', '### Task table']);
            say(`GENERATED from ${plan}: ${String(out).trim().split('\n').pop()}`);
          }
        });
      } else if (r.status === 'VERDICT: FAIL') {
        once(`fail:${r.name}`, () => {
          const verdict = `${HUB}/runs/${r.name}.verdict.md`;
          if (t.rejects > 1) { say(`DECIDE ${t.id}: FAIL after ${t.rejects} rework(s), verdict ${verdict}`); return; }
          // Second FAIL is already filtered by the reviewer's stop rule, so it holds blocking items only.
          const n = t.rejects + 1;
          const body = fs.readFileSync(verdict, 'utf8').split('\n').slice(1).filter((l) => !l.startsWith('BACKLOG:')).join('\n');
          if (!DRY) fs.appendFileSync(`${HUB}/tasks/${t.id}.md`, `\n## Rework ${n}${n > 1 ? ' (final, blocking items only)' : ' (the only rework round)'}\nFix every numbered item below, inside your scope. Then the same proof.\n\n${body}`);
          hub('reject', t.id, '--note', `Rework ${n}: items in the brief (autoloop)`);
          run([`${HUB}/dispatch.mjs`, 'run', pickBuilder(lastBuild(t)?.executor), 'auto', t.id]);
        });
      } else if (PROBLEM.test(r.status)) {
        once(`retry:${r.name}`, () => {
          if (/QUOTA|AUTH|DOWN/.test(r.status)) say(`QUOTA ${r.executor}: ${r.status} (review ${t.id})`);
          st.down[r.executor] = Date.now();
          { const rv = reviewer(r.executor, builderOf(t.id)); if (rv) run([`${HUB}/dispatch.mjs`, 'review', t.id, rv]); else delete st.handled[`retry:${r.name}`]; }
        });
      }
      continue;
    }
    if (!['REWORK', 'CLAIMED', 'ASSIGNED', 'BLOCKED'].includes(t.status)) continue;
    const b = latest(J, t.id, false, 0);
    if (b?.status === 'RUNNING') continue;
    if (J.some((j) => j.task === t.id && !j.review && j.status === 'RUNNING')) continue;
    if (b && PROBLEM.test(b.status) && b.started >= t.rejectAt && depsMet(t)) {
      once(`retry:${b.name}`, () => {
        if (/QUOTA|AUTH|DOWN/.test(b.status)) say(`QUOTA ${b.executor}: ${b.status} (build ${t.id})`);
        st.down[b.executor] = Date.now();
        const next = nextHealthy(BUILD_FALLBACK, b.executor);
        run([`${HUB}/dispatch.mjs`, 'run', next, b.lane, t.id]);
        say(`MOVED ${t.id}: ${b.executor} failed (${b.status}), now on ${next}`);
      });
      continue;
    }
    // Job exited cleanly but never reported done (session ended early, or a stale claim refused it):
    // retire the lane's session to free the claim and resume once; a second time needs a decision.
    if (b?.status === 'DONE' && b.started >= t.rejectAt && t.status !== 'REWORK' && depsMet(t)) {
      once(`resume:${b.name}`, () => {
        const tries = Object.keys(st.handled).filter((k) => k.startsWith('resume:') && k.includes(`-${t.id}-`)).length;
        if (tries > 1) { say(`DECIDE ${t.id}: ${b.executor} exited twice without done, log ${HUB}/runs/${b.name}.log`); return; }
        const holder = latest(J, t.id, false, 0)?.lane;
        if (holder) hub('kick', holder, '--note', 'autoloop: job exited without done');
        run([`${HUB}/dispatch.mjs`, 'run', pickBuilder(b.executor), b.lane, t.id]);
      });
      continue;
    }
    if (t.status === 'REWORK' && depsMet(t) && !(b && b.started >= t.rejectAt)) {
      once(`rework:${t.id}:${t.rejectAt}`, () => run([`${HUB}/dispatch.mjs`, 'run', pickBuilder(b?.executor), 'auto', t.id]));
    }
  }

  // Check for overlong RUNNING jobs (Task S-05-05)
  const allJobs = readJobs();
  const alivePidsSet = alivePids();
  for (const j of allJobs) {
    if (j.mode !== 'run') continue;
    if (!isLive(j, alivePidsSet)) continue;

    const ageMin = Math.round((Date.now() - Date.parse(j.t)) / 60000);
    const phase = j.mode === 'review' ? 'review' : 'run';
    const medianVal = getMedian(j.executor, phase);
    const defaultMedian = 45;
    const baseMedian = medianVal !== null ? medianVal : defaultMedian;
    const limit = Math.max(20, 2 * baseMedian);

    if (ageMin >= limit) {
      once(`slow:${j.id}:${Math.floor(Date.now() / 300_000)}`, () => {
        killProcessTree(j.pid);
        const lane = j.agentId || j.lane;
        if (lane) {
          try { hub('kick', lane, '--note', `autoloop: stopped after ${ageMin} min (2x normal)`); } catch {}
        }
        const next = nextHealthy(BUILD_FALLBACK, j.executor);
        run([`${HUB}/dispatch.mjs`, 'run', next, lane || 'auto', j.taskId]);
        try {
          const taskFile = `${HUB}/tasks/${j.taskId}.md`;
          if (fs.existsSync(taskFile)) {
            fs.appendFileSync(taskFile, `\n## Requeue\nStopped after ${ageMin} min (2x normal), requeued to ${next}.\n`);
          }
        } catch {}
        say(`MOVED ${j.taskId}: slow`);
      });
    }
  }

  // Queued new tasks: { "<task>": "<executor>" } in autoloop-queue.json, dispatched once their deps are built.
  let queue = {};
  try { queue = JSON.parse(fs.readFileSync(`${HUB}/autoloop-queue.json`, 'utf8')); } catch {}
  for (const [id, executor] of Object.entries(queue)) {
    const t = T[id];
    if (!t || !['OPEN', 'ASSIGNED'].includes(t.status) || !depsMet(t) || latest(J, id, false, 0)) continue;
    // Preferred executor first; if it is down or at its session limit, take the next free builder instead of parking the task.
    once(`queue:${id}`, () => {
      for (const ex of [executor, ...BUILD_FALLBACK.filter((e) => e !== executor)].filter(up)) {
        const out = run([`${HUB}/dispatch.mjs`, 'run', ex, 'auto', id]);
        if (/^SKILLS /m.test(out)) { say(out.trim()); return; }
        if (!/not dispatched|no free lane|^ERROR /im.test(out)) return;
      }
    });
  }

  // Shared board: mirror this machine's live tasks to GitHub issues every few minutes, in the
  // background so a slow GitHub never stalls the loop.
  if (CFG.board?.enabled && Date.now() - (st.lastBoardSync ?? 0) > (CFG.board.syncMinutes ?? 3) * 60_000) {
    st.lastBoardSync = Date.now();
    spawn(process.execPath, [path.join(ROOT, HUB, 'board.mjs'), 'sync'], { cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true }).unref();
  }

  // Multi-machine sync: shared memory branch + safe pull/push of the code (sync.mjs). Only problems
  // are surfaced, so a quiet loop means every machine is in step.
  if (CFG.sync?.enabled && Date.now() - (st.lastSync ?? 0) > (CFG.sync.minutes ?? 5) * 60_000) {
    st.lastSync = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, HUB, 'sync.mjs'), 'run'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    for (const line of `${r.stdout ?? ''}`.split('\n')) if (/failed|blocked|diverged|conflict/.test(line)) say(line);
  }

  if (Date.now() - st.lastDigest > DIGEST_MS) {
    st.lastDigest = Date.now();
    const count = {};
    for (const t of Object.values(T)) count[t.status] = (count[t.status] ?? 0) + 1;
    const live = J.filter((j) => j.status === 'RUNNING').map((j) => `${j.review ? 'review' : 'build'}:${j.task}@${j.executor}`);
    say(`DIGEST ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ')} | running: ${live.join(' ') || 'none'}`);
  }

  if (Date.now() - (st.lastGc ?? 0) > 3600_000) {
    st.lastGc = Date.now();
    try { hub('gc', '--stale-min', '120'); } catch {}
  }

  if (Date.now() - (st.lastWorktreeSweep ?? 0) > 3600_000) {
    st.lastWorktreeSweep = Date.now();
    try {
      let freeDiskGB = 999;
      try {
        const stats = fs.statfsSync(ROOT);
        freeDiskGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
      } catch {}
      const minDisk = CFG.resources?.minFreeDiskGB ?? 5;
      if (freeDiskGB < minDisk) {
        maybeEmitResource(`low disk (${Math.round(freeDiskGB)} GB free)`);
      }

      const wtBase = path.resolve(ROOT, (CFG.worktrees?.base || '../{repo}-wt').replace('{repo}', path.basename(ROOT)));
      if (fs.existsSync(wtBase)) {
        const entries = fs.readdirSync(wtBase, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const taskId = entry.name;
          const wtPath = path.join(wtBase, taskId);
          const status = T[taskId]?.status;

          if (status === 'ACCEPTED' || status === 'CANCELLED') {
            try {
              execSync(`git worktree remove --force ${wtPath}`, { cwd: ROOT, stdio: 'ignore' });
              execSync(`git branch -d task/${taskId}`, { cwd: ROOT, stdio: 'ignore' });
              execSync('git worktree prune', { cwd: ROOT, stdio: 'ignore' });
            } catch {
              try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
              try { execSync('git worktree prune', { cwd: ROOT, stdio: 'ignore' }); } catch {}
            }
          } else {
            try {
              const stats = fs.statSync(wtPath);
              const ageMs = Date.now() - (stats.birthtimeMs || stats.mtimeMs);
              const hasRunningJob = J.some((j) => j.task === taskId && j.status === 'RUNNING');
              if (ageMs > 24 * 3600_000 && !hasRunningJob) {
                say(`STALE WORKTREE ${taskId}: older than 24h with no running job`);
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  if (Date.now() - (st.lastCompact ?? 0) > 7 * 24 * 3600_000) {
    st.lastCompact = Date.now();
  }
}

const st = prune(load());
const loop = () => { prune(st); try { tick(st); } catch (e) { say(`AUTOLOOP ERROR ${e.message}`); } save(st); };
loop();
if (!process.argv.includes('--once')) setInterval(loop, TICK_MS);
