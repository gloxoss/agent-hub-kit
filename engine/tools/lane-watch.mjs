#!/usr/bin/env node
// Looks at the running agents every 30 seconds and prints ONE line only when something needs the orchestrator:
// a window finished, an agent looks stuck, a task reached REVIEW, or fewer than the wanted number of agents run.
//
//   node .agent-hub/tools/lane-watch.mjs [--every 30] [--min 6]
//
// Each printed line is an event for the orchestrator (Monitor tool). Quiet when nothing changed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../fold.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: lane-watch.mjs [--every 30] [--min 6]   prints a line when a window finished, an agent is stuck, a task needs review, or fewer than --min agents run');
  process.exit(0);
}

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HUB, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const EVERY = arg('every', 30) * 1000;
const MIN_AGENTS = arg('min', 6);
const STUCK_MIN = 10;

const run = (file, args) => {
  try { return execFileSync(process.execPath, [path.join(HUB, file), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, AGENT_ID: 'orchestrator' } }); } catch { return ''; }
};

const seen = new Map(); // key -> last signature printed

// Names the executor whose latest run of this task ended on a quota or login error, from the run logs of the last 20 minutes.
function lastQuota(task) {
  try {
    const runs = path.join(HUB, 'runs');
    const files = fs.readdirSync(runs).filter((n) => n.endsWith('.log') && n.includes(`-${task}-mw`)).map((n) => ({ n, m: fs.statSync(path.join(runs, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    const f = files[0];
    if (!f || Date.now() - f.m > 20 * 60000) return '';
    const text = fs.readFileSync(path.join(runs, f.n), 'utf8');
    const m = text.match(/^ERROR (QUOTA|AUTH): (.*)$/m);
    if (!m) return '';
    const ex = (text.match(/started: (\S+)/) || [])[1] ?? '';
    return ` | last run ${ex} stopped by ${m[1]}: ${m[2].slice(0, 60)}`;
  } catch { return ''; }
}

// The five showcase pages share one dev server: a builder who leaves a missing import or a syntax error breaks them all.
// Report it (once per distinct error) with the file named by the compiler, so the right builder is told within 30 s.
const SITES_HEALTH = ['safah', 'chalant', 'dewskincare', 'mirea', 'raydiant'];
async function pageHealth() {
  const out = [];
  for (const site of SITES_HEALTH) {
    try {
      const r = await fetch(`http://localhost:3001/showcase/${site}`, { signal: AbortSignal.timeout(20000) });
      if (r.status >= 500) {
        const body = await r.text();
        const m = body.match(/Module not found: Can.{1,8}t resolve '([^']+)'/);
        const file = (body.match(/\.\/src\/[A-Za-z0-9_.\/\[\]-]+\.(?:tsx?|css)/) || [''])[0];
        out.push([`pagebroken:${site}:${file}${m ? m[1] || '' : ''}`, `PAGE BROKEN /showcase/${site} (HTTP ${r.status}) ${file ? 'in ' + file : ''} ${m && m[1] ? '(cannot resolve ' + m[1] + ')' : ''}: tell the builder who owns that file`]);
      }
    } catch { /* dev server busy or down: say nothing */ }
  }
  return out;
}

function snapshot() {
  const out = [];
  const win = run('tools/herdr-bridge.mjs', ['status']).split('\n').map((l) => l.match(/^\s+(w\d+:\w+)\s+(.+?)\s+(interactive|log view)\s+(running|finished)/)).filter(Boolean);
  const live = win.filter((m) => m[3] === 'interactive' && m[4] === 'running');
  const tasks = (run('hub.mjs', ['status']).match(/^tasks: (.*)$/m) || [])[1] ?? '';
  const review = Number((tasks.match(/REVIEW (\d+)/) || [])[1] ?? 0);

  for (const m of win.filter((x) => x[3] === 'interactive' && x[4] === 'finished')) out.push([`fin:${m[1]}:${m[2]}`, `FINISHED ${m[2]} (${m[1]}): review it or give the next work`]);

  // stuck: an interactive run whose log has not changed for STUCK_MIN minutes
  try {
    const runs = path.join(HUB, 'runs');
    for (const f of fs.readdirSync(runs).filter((n) => n.endsWith('.log') && /^builder-/.test(n))) {
      const p = path.join(runs, f);
      const t = fs.readFileSync(p, 'utf8');
      if (/^\[dispatch\] exit/m.test(t)) continue;
      const age = (Date.now() - fs.statSync(p).mtimeMs) / 60000;
      if (!(age > STUCK_MIN && age < 180)) continue;
      // an old run of a task that is already accepted or cancelled is not stuck, only left over
      const task = f.replace(/^builder-\d+-/, '').replace(/-mw[0-9a-z]+\.log$/, '');
      const shown = run('hub.mjs', ['show', task]);
      // when the hub could not answer (busy machine), say nothing rather than raise a false alarm
      if (!shown || /"status": "(ACCEPTED|CANCELLED)"/.test(shown)) continue;
      // only a window that is still open can be stuck: a log whose window was closed is a leftover, not a problem
      if (!live.some((m) => m[2].startsWith(`${task} `))) continue;
      // an older log of a task that has a newer run is a leftover of the old window, not the live one
      const newer = fs.readdirSync(runs).some((n) => n !== f && n.endsWith('.log') && n.includes(`-${task}-mw`) && fs.statSync(path.join(runs, n)).mtimeMs > fs.statSync(p).mtimeMs);
      if (newer) continue;
      out.push([`stuck:${f}`, `STUCK? ${f.replace(/\.log$/, '')} no log change for ${Math.round(age)} min`]);
    }
  } catch {}

  // An unfinished task with no open window has no agent working on it: the usual cause is a quota or login stop.
  // Say so every 30 s until someone restarts it, and name the executor that just failed.
  try {
    const ev = fs.readFileSync(path.join(HUB, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const state = fold(ev);
    const T = state.tasks ?? state;
    let excluded = [];
    try { excluded = JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')).keeper?.exclude ?? []; } catch {}
    const liveTasks = new Set(live.map((m) => m[2].replace(/\s*\[.*$/, '')));
    for (const [id, task] of Object.entries(T)) {
      if (!['ASSIGNED', 'CLAIMED', 'REWORK'].includes(task.status) || liveTasks.has(id) || excluded.includes(id)) continue;
      out.push([`noagent:${id}`, `NO AGENT on ${id} (${task.status}): restart it${lastQuota(id)}`]);
    }
  } catch {}

  out.push(...(globalThis.__health ?? []));
  if (review > 0) out.push([`review:${review}`, `REVIEW queue: ${review} task(s) wait for the orchestrator`]);
  if (live.length < MIN_AGENTS) out.push([`low:${live.length}`, `LOW LANES: ${live.length} of ${MIN_AGENTS} agents running, add work`]);
  return out;
}

for (;;) {
  globalThis.__health = await pageHealth();
  const now = new Set();
  for (const [key, line] of snapshot()) {
    now.add(key);
    if (!seen.has(key)) { seen.set(key, true); console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`); }
  }
  // forget keys that cleared, so the same problem can be reported again later
  for (const k of [...seen.keys()]) if (!now.has(k)) seen.delete(k);
  await new Promise((r) => setTimeout(r, EVERY));
}
