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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const HUB = path.basename(path.dirname(fileURLToPath(import.meta.url)));
const STATE = `${HUB}/autoloop-state.json`;
const TICK_MS = 60_000;

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

// Build fallback: strong first, from buildOrder (or the table order).
const BUILD_FALLBACK = (Array.isArray(TABLE.buildOrder) ? TABLE.buildOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['builder', 'both'].includes(EXECUTOR_DEFS.find((d) => d.name === n).kind));
// Review fallback: codex first, then cursor and sonnet alternating, fresh Claude last.
const REVIEW_FALLBACK = (Array.isArray(TABLE.reviewOrder) ? TABLE.reviewOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['reviewer', 'both'].includes(EXECUTOR_DEFS.find((d) => d.name === n).kind));
// When the first reviewer is down, these two take turns so neither drains alone.
const SHARED_REVIEWERS = (Array.isArray(TABLE.sharedReviewers) ? TABLE.sharedReviewers : []).filter(enabled);

const DOWN_MS = (CFG.cooldownMinutes ?? 60) * 60_000; // an executor that hit QUOTA/AUTH/DOWN is skipped for an hour
const BUILT = new Set(['REVIEW', 'VERIFIED', 'ACCEPTED']);
const PROBLEM = /QUOTA|AUTH|DOWN|FAILED|NO VERDICT/;

const say = (s) => console.log(s);
const DRY = process.argv.includes('--dry');
const run = (args) => {
  if (DRY && !(args[0].endsWith('dispatch.mjs') && args[1] === 'list')) { say(`DRY ${args.join(' ')}`); return ''; }
  try { return execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
};
const hub = (...a) => run([`${HUB}/hub.mjs`, ...a, '--agent', 'orchestrator']);
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

function jobs() {
  const out = [];
  const text = run([`${HUB}/dispatch.mjs`, 'list', '--all']);
  for (const line of text.split('\n')) {
    if (!/^(builder|review)-/.test(line)) continue;
    const [name, executor, task, ...rest] = line.trim().split(/\s{2,}/);
    const id = name.split('-').pop();
    out.push({ name, executor, task, status: rest.join(' '), review: name.startsWith('review-'), lane: name.slice(0, name.indexOf(`-${task}-`)), started: parseInt(id, 36) || 0 });
  }
  return out;
}

const latest = (js, task, review, after) => js.filter((j) => j.task === task && j.review === review && j.started >= after).sort((a, b) => b.started - a.started)[0];
const nextOf = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

function tick(st) {
  const T = tasks();
  const J = jobs();
  const once = (key, fn) => { if (!st.handled[key]) { st.handled[key] = Date.now(); fn(); } };
  const depsMet = (t) => t.deps.every((d) => (t.strict ? T[d]?.status === 'ACCEPTED' : BUILT.has(T[d]?.status)));
  const lastBuild = (t) => latest(J, t.id, false, 0);
  st.down ??= {};
  const up = (ex) => !st.down[ex] || Date.now() - st.down[ex] > DOWN_MS;
  // Healthy-first: skip the reviewer that just failed, and rotate the shared reviewers when the first is down.
  const reviewer = (failed, builder) => {
    const ok = (e) => e !== failed && e !== builder && up(e);
    if (!failed && REVIEW_FALLBACK.length && !up(REVIEW_FALLBACK[0])) {
      const pool = SHARED_REVIEWERS.filter(ok);
      if (pool.length) { st.rr = ((st.rr ?? 0) + 1) % pool.length; return pool[st.rr]; }
    }
    return REVIEW_FALLBACK.find(ok) ?? null;
  };
  const builderOf = (id) => latest(J, id, false, 0)?.executor;
  const nextHealthy = (list, cur) => { const i = list.indexOf(cur); const order = [...list.slice(i + 1), ...list.slice(0, Math.max(i, 0))]; return order.find((e) => e !== cur && up(e) && enabled(e)) ?? nextOf(list, cur); };
  // Any rework or resume goes to a healthy executor, never back to one that is cooling down.
  const pickBuilder = (preferred) => (preferred && up(preferred) && enabled(preferred) ? preferred : (BUILD_FALLBACK.find(up) ?? BUILD_FALLBACK[0] ?? preferred ?? 'opencode'));

  for (const t of Object.values(T)) {
    if (t.status === 'REVIEW') {
      const r = latest(J, t.id, true, t.doneAt - 5_000);
      if (!r) {
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

  if (Date.now() - st.lastDigest > DIGEST_MS) {
    st.lastDigest = Date.now();
    const count = {};
    for (const t of Object.values(T)) count[t.status] = (count[t.status] ?? 0) + 1;
    const live = J.filter((j) => j.status === 'RUNNING').map((j) => `${j.review ? 'review' : 'build'}:${j.task}@${j.executor}`);
    say(`DIGEST ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ')} | running: ${live.join(' ') || 'none'}`);
  }
}

const st = prune(load());
const loop = () => { prune(st); try { tick(st); } catch (e) { say(`AUTOLOOP ERROR ${e.message}`); } save(st); };
loop();
if (!process.argv.includes('--once')) setInterval(loop, TICK_MS);
