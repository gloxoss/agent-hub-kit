#!/usr/bin/env node
// Bridge between the agent hub and Herdr (terminal workspace manager).
//
// What it gives the owner: one Herdr workspace for the project. A "board" tab shows the hub live. Every agent
// job the hub starts gets a PANE in an "agents" tab, so several agents are visible side by side in one view
// (a grid of up to 4 panes per tab; a second "agents 2" tab opens only when the first is full).
// Interactive jobs run the real agent (opencode, agy, codex, claude...) so the owner can talk to it.
// Headless jobs (reviews) show a readable live view of their log.
//
//   node .agent-hub/tools/herdr-bridge.mjs ensure [--open] [--soft]   make sure Herdr runs and the workspace and board tab exist
//   node .agent-hub/tools/herdr-bridge.mjs run --spec <file> --log <file> --label <text>   place the agent INTERACTIVELY (exit 3 = Herdr unavailable)
//   node .agent-hub/tools/herdr-bridge.mjs watch --log <file> --label <text>   place a readable log view (never fails the caller)
//   node .agent-hub/tools/herdr-bridge.mjs prune [--minutes N]   close log-view panes of jobs finished more than N minutes ago (default 30)
//   node .agent-hub/tools/herdr-bridge.mjs reap       watch the windows: retire blocked ones in the hub, notify about finished or idle ones (never closes)
//   node .agent-hub/tools/herdr-bridge.mjs close --finished | --failed | --task <id> | --pane <id>   close windows, only when the owner asks
//   node .agent-hub/tools/herdr-bridge.mjs reopen <job id | task id>   bring a closed agent back (its own resume command)
//   node .agent-hub/tools/herdr-bridge.mjs tell <task id | pane id> <message>   send a follow-up INTO that agent session (reopens it if closed): same context, no new run
//   node .agent-hub/tools/herdr-bridge.mjs status
//
// Config (config.json, key "herdr"): enabled, interactive, workspaceLabel, panesPerTab (default 4), layout ("panes" | "tabs").
// Rules: it only talks to Herdr through the documented `herdr` CLI. `watch` and `prune` exit 0 on any problem, because
// a missing Herdr must never stop a job. Interactive panes are never closed by the bridge: a conversation may be in progress.

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log('usage: herdr-bridge.mjs ensure [--open] [--soft] | run --spec <file> --log <file> --label <text> | watch --log <file> --label <text> | prune [--minutes N] | gather | reap | close --finished | reopen <id> | tell <task> <message> | status'); process.exit(0); }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');
const ROOT = path.resolve(HUB, '..');
const STATE = path.join(HUB, 'runs', 'herdr-state.json');
const fwd = (p) => p.replace(/\\/g, '/');

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')).herdr ?? {}; } catch {}
const WORKSPACE_LABEL = CFG.workspaceLabel || `${path.basename(ROOT)} hub`;
const PER_TAB = Math.max(1, Number(CFG.panesPerTab ?? 4));
const LAYOUT = CFG.layout === 'tabs' ? 'tabs' : 'panes';

const [, , cmd = 'status', ...rest] = process.argv;
const arg = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
const flag = (name) => rest.includes(`--${name}`);
const quiet = cmd === 'watch' || cmd === 'prune';

function herdr(args, { timeout = 15000 } = {}) {
  const raw = execFileSync('herdr', args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function serverRunning() {
  try {
    const raw = execFileSync('herdr', ['status', 'server'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return /status:\s*running/.test(raw);
  } catch { return false; }
}

function readStateRaw() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    s.tabs ??= {};
    s.groups ??= [];
    return s;
  } catch { return { workspace_id: null, tabs: {}, groups: [] }; }
}
// Remembers which jobs this process knew about when it read the file.
function readState() {
  const s = readStateRaw();
  Object.defineProperty(s, '_known', { value: new Set(Object.keys(s.tabs)), enumerable: false });
  return s;
}
// Several processes use this file at once (the hub starting jobs, the watcher, the owner). Before writing, keep
// every entry another process added since this one read the file, so a slow process never erases a new window.
function writeState(s) {
  try {
    const disk = readStateRaw();
    for (const [k, v] of Object.entries(disk.tabs)) if (!(k in s.tabs) && !s._known?.has(k)) s.tabs[k] = v;
    for (const g of disk.groups) {
      const mine = s.groups.find((x) => x.tab_id === g.tab_id);
      if (!mine) s.groups.push(g);
      else for (const p of g.panes) if (!mine.panes.includes(p)) mine.panes.push(p);
    }
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
  } catch {}
}

// A short exclusive lock for the commands that place windows, so two jobs starting together do not split the same pane.
async function withLock(fn) {
  const lock = `${STATE}.lock`;
  const start = Date.now();
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.unlinkSync(lock); } catch {}
      if (Date.now() - start > 30000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { return await fn(); } finally { if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch {} } }
}

async function openWindow() {
  const exe = execFileSync('where', ['herdr'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
  const wt = (() => { try { return execFileSync('where', ['wt.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return null; } })();
  const child = wt
    ? spawn(wt, ['-w', 'new', '--title', 'MoreneHub', '-d', ROOT, exe], { detached: true, stdio: 'ignore' })
    : spawn(exe, [], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (serverRunning()) return true;
  }
  return false;
}

function findWorkspace(state) {
  const list = herdr(['workspace', 'list'])?.result?.workspaces ?? [];
  if (state.workspace_id && list.some((w) => w.workspace_id === state.workspace_id)) return state.workspace_id;
  return list.find((w) => w.label === WORKSPACE_LABEL)?.workspace_id ?? null;
}

const runInPane = (paneId, command) => herdr(['pane', 'run', paneId, command]);
const node = (script, ...a) => `node "${fwd(path.join(HERE, script))}" ${a.map((x) => `"${x}"`).join(' ')}`.trim();

function liveSets(ws) {
  const tabs = new Set((herdr(['tab', 'list', '--workspace', ws])?.result?.tabs ?? []).map((t) => t.tab_id));
  const panes = new Set((herdr(['pane', 'list', '--workspace', ws])?.result?.panes ?? []).map((p) => p.pane_id));
  return { tabs, panes };
}

// Forget everything the user (or a crash) closed, so slots free up again.
function reconcile(state, ws) {
  const { tabs, panes } = liveSets(ws);
  for (const [key, t] of Object.entries(state.tabs)) if (!panes.has(t.pane_id) && !tabs.has(t.tab_id)) delete state.tabs[key];
  for (const g of state.groups) g.panes = g.panes.filter((p) => panes.has(p));
  state.groups = state.groups.filter((g) => tabs.has(g.tab_id) && g.panes.length > 0);
}

function ensureBoard(state, ws) {
  const tabs = herdr(['tab', 'list', '--workspace', ws])?.result?.tabs ?? [];
  if (tabs.some((t) => t.label === 'board')) return;
  const r = herdr(['tab', 'create', '--workspace', ws, '--label', 'board', '--cwd', ROOT]).result;
  runInPane(r.root_pane.pane_id, node('hub-board.mjs'));
  state.board = { tab_id: r.tab.tab_id, pane_id: r.root_pane.pane_id };
}

function ensureWorkspace(state) {
  let id = findWorkspace(state);
  let created = false;
  if (!id) {
    const r = herdr(['workspace', 'create', '--label', WORKSPACE_LABEL, '--cwd', ROOT]).result;
    id = r.workspace.workspace_id;
    created = true;
    state.tabs = {};
    state.groups = [];
    try { herdr(['tab', 'rename', r.tab.tab_id, 'board']); } catch {}
    runInPane(r.root_pane.pane_id, node('hub-board.mjs'));
    state.board = { tab_id: r.tab.tab_id, pane_id: r.root_pane.pane_id };
  }
  state.workspace_id = id;
  return { id, created };
}

// Finds the id of the pane created by `pane split`, whatever shape the response has.
function newPaneId(result, before) {
  const seen = [];
  (function walk(o) {
    if (o && typeof o === 'object') {
      if (typeof o.pane_id === 'string') seen.push(o.pane_id);
      for (const v of Object.values(o)) walk(v);
    }
  })(result);
  return seen.find((p) => p !== before) ?? null;
}

// Gives the caller a pane for one job: a free slot in the newest "agents" tab, or a new tab when it is full.
function place(state, ws, label) {
  if (LAYOUT === 'tabs') {
    const r = herdr(['tab', 'create', '--workspace', ws, '--label', label.slice(0, 40), '--cwd', ROOT]).result;
    return { tab_id: r.tab.tab_id, pane_id: r.root_pane.pane_id };
  }
  reconcile(state, ws);
  let g = state.groups.find((x) => x.panes.length < PER_TAB);
  let paneId;
  if (!g) {
    const n = state.groups.length + 1;
    const r = herdr(['tab', 'create', '--workspace', ws, '--label', n === 1 ? 'agents' : `agents ${n}`, '--cwd', ROOT]).result;
    g = { tab_id: r.tab.tab_id, panes: [r.root_pane.pane_id] };
    state.groups.push(g);
    paneId = r.root_pane.pane_id;
  } else {
    // Grid order for 4 panes: right of the first, below the first, below the second. More than 4: below the last.
    const n = g.panes.length;
    const [target, direction] = n === 1 ? [g.panes[0], 'right'] : n === 2 ? [g.panes[0], 'down'] : n === 3 ? [g.panes[1], 'down'] : [g.panes[n - 1], 'down'];
    const r = herdr(['pane', 'split', target, '--direction', direction, '--cwd', ROOT]).result;
    paneId = newPaneId(r, target);
    if (!paneId) throw new Error('could not read the new pane id');
    g.panes.push(paneId);
  }
  try { herdr(['pane', 'rename', paneId, label.slice(0, 40)]); } catch {}
  return { tab_id: g.tab_id, pane_id: paneId };
}

async function ensure() {
  let up = serverRunning();
  if (!up && flag('open')) up = await openWindow();
  if (!up) {
    console.log('herdr: server not running (use --open to start it)');
    return 1;
  }
  const state = readState();
  const { id, created } = ensureWorkspace(state);
  reconcile(state, id);
  ensureBoard(state, id);
  writeState(state);
  console.log(`herdr: ready, workspace ${id} "${WORKSPACE_LABEL}"${created ? ' (created, board tab started)' : ''}`);
  return 0;
}

function track(state, key, p, extra) {
  state.tabs[key] = { tab_id: p.tab_id, pane_id: p.pane_id, at: Date.now(), ...extra };
}

function watch() {
  const log = arg('log');
  const label = arg('label', 'job');
  if (!log) return 0;
  if (!serverRunning()) return 0;
  const state = readState();
  const { id } = ensureWorkspace(state);
  const abs = path.isAbsolute(log) ? log : path.resolve(ROOT, log);
  const key = fwd(abs);
  reconcile(state, id);
  if (state.tabs[key]) { writeState(state); return 0; }
  const p = place(state, id, label);
  runInPane(p.pane_id, node('job-view.mjs', key, label));
  track(state, key, p, { label });
  writeState(state);
  return 0;
}

function runInteractive() {
  const spec = arg('spec');
  const log = arg('log');
  const label = arg('label', 'job');
  if (!spec || !log) return 2;
  if (!serverRunning()) return 3;
  const state = readState();
  const { id } = ensureWorkspace(state);
  const abs = path.isAbsolute(log) ? log : path.resolve(ROOT, log);
  const key = fwd(abs);
  const specAbs = path.isAbsolute(spec) ? spec : path.resolve(ROOT, spec);
  const p = place(state, id, label);
  runInPane(p.pane_id, node('interactive-run.mjs', fwd(specAbs)));
  track(state, key, p, { label, interactive: true });
  writeState(state);
  return 0;
}

function finished(logKey) {
  try { return /^\[dispatch\] exit/m.test(fs.readFileSync(logKey, 'utf8')); } catch { return true; }
}

function prune() {
  if (!serverRunning()) return 0;
  const minutes = Number(arg('minutes', 30));
  const state = readState();
  if (!state.workspace_id) return 0;
  reconcile(state, state.workspace_id);
  for (const [key, t] of Object.entries(state.tabs)) {
    if (t.interactive) continue; // a live agent conversation is never closed by the bridge
    let ageMin = Infinity;
    try { ageMin = (Date.now() - fs.statSync(key).mtimeMs) / 60000; } catch {}
    if (finished(key) && ageMin > minutes) {
      try { herdr(['pane', 'close', t.pane_id]); } catch {}
      delete state.tabs[key];
    }
  }
  reconcile(state, state.workspace_id);
  writeState(state);
  return 0;
}

function status() {
  const up = serverRunning();
  const state = readState();
  console.log(`herdr server: ${up ? 'running' : 'not running'}`);
  console.log(`workspace: ${state.workspace_id ?? '(none)'} "${WORKSPACE_LABEL}"  layout: ${LAYOUT}, ${PER_TAB} panes per tab`);
  for (const g of state.groups) console.log(`  view ${g.tab_id}: ${g.panes.length} pane(s)`);
  const jobs = Object.entries(state.tabs);
  console.log(`jobs: ${jobs.length}`);
  for (const [key, t] of jobs) console.log(`  ${t.pane_id}  ${t.label}  ${t.interactive ? 'interactive ' : 'log view   '}${finished(key) ? 'finished' : 'running'}`);
  return 0;
}

// Moves job panes that sit in their own tabs (older layout) into the grid, without restarting the agents.
function gather() {
  if (!serverRunning()) { console.log('herdr: server not running'); return 1; }
  const state = readState();
  const { id } = ensureWorkspace(state);
  reconcile(state, id);
  const inGrid = new Set(state.groups.flatMap((g) => g.panes));
  let moved = 0;
  for (const t of Object.values(state.tabs)) {
    if (inGrid.has(t.pane_id)) continue;
    let g = state.groups.find((x) => x.panes.length < PER_TAB);
    let res;
    if (!g) {
      const n = state.groups.length + 1;
      res = herdr(['pane', 'move', t.pane_id, '--new-tab', '--workspace', id, '--label', n === 1 ? 'agents' : `agents ${n}`, '--no-focus']).result;
      const pane = res?.move_result?.pane ?? {};
      g = { tab_id: pane.tab_id ?? t.tab_id, panes: [] };
      state.groups.push(g);
      t.pane_id = pane.pane_id ?? t.pane_id;
      t.tab_id = g.tab_id;
      g.panes.push(t.pane_id);
    } else {
      const n = g.panes.length;
      const [target, direction] = n === 1 ? [g.panes[0], 'right'] : n === 2 ? [g.panes[0], 'down'] : n === 3 ? [g.panes[1], 'down'] : [g.panes[n - 1], 'down'];
      res = herdr(['pane', 'move', t.pane_id, '--tab', g.tab_id, '--split', direction, '--target-pane', target, '--no-focus']).result;
      const pane = res?.move_result?.pane ?? {};
      t.pane_id = pane.pane_id ?? t.pane_id;
      t.tab_id = g.tab_id;
      g.panes.push(t.pane_id);
    }
    try { herdr(['pane', 'rename', t.pane_id, String(t.label ?? 'job').slice(0, 40)]); } catch {}
    moved++;
  }
  reconcile(state, id);
  writeState(state);
  console.log(`gathered ${moved} pane(s) into ${state.groups.length} view(s)`);
  return 0;
}

// ------------------------------------------------------------------------------------------------------------
// Watching the agent windows.
//  - A window whose agent FAILED (quota or login error on screen, or the agent process ended with an error) is
//    closed by the watcher, its session is saved in the history library, and the task is restarted on the next
//    healthy agent, with a note to continue from the files already changed.
//  - A window whose agent FINISHED WELL is never closed by the watcher: the owner reads the output first. If it stays
//    open too long, or an agent is idle for a long time, the owner gets a notification.
//  - Finished windows are closed only by \`close\`, which the owner asks for.
// ------------------------------------------------------------------------------------------------------------
const NOTES = path.join(HUB, 'runs', 'notifications.log');
const REAP = CFG.reap ?? {};
const MIN = {
  errorIdle: Number(REAP.errorIdleMinutes ?? 2),
  finishedNotify: Number(REAP.finishedNotifyMinutes ?? 10),
  renotify: Number(REAP.renotifyMinutes ?? 60),
  stalled: Number(REAP.stalledMinutes ?? 30),
};
const ERROR_PATTERNS = [
  ['QUOTA', /weekly usage limit reached|usage limit reached|insufficient balance|out of credits|credit balance is too low|rate limit (reached|exceeded)|prepaid_balance_exhausted|exceeded your (current )?quota/i],
  ['AUTH', /invalid api key|please run \/login|not logged in|api error: 40[13]|authentication (failed|error)/i],
];

async function history() {
  try { return await import('./agent-history.mjs'); } catch { return null; }
}

function notify(title, body, key) {
  try {
    fs.mkdirSync(path.dirname(NOTES), { recursive: true });
    fs.appendFileSync(NOTES, `${new Date().toISOString()} NOTIFY ${key} | ${title} | ${body}\n`);
  } catch {}
  try { herdr(['notification', 'show', title, '--body', body, '--sound', 'request', '--position', 'top-right']); } catch {}
}

function markExecutorDown(label, kind, line) {
  const executor = String(label ?? '').match(/\[([^\]]+)\]\s*$/)?.[1];
  if (!executor) return;
  const file = path.join(HUB, 'runs', 'health.json');
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    h[executor] = { ok: false, problem: kind, at: Date.now(), detail: String(line).slice(0, 160) };
    fs.writeFileSync(file, JSON.stringify(h, null, 2));
  } catch {}
}

const sha = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

const hubCmd = (a) => { try { execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), ...a], { cwd: ROOT, stdio: 'ignore', timeout: 30000 }); } catch {} };

// True when another agent already works on this task (its log has no exit marker and is still being written).
function taskHasLiveJob(task, exceptJob) {
  try {
    const jobs = new Map();
    for (const l of fs.readFileSync(path.join(HUB, 'runs', 'jobs.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      try { const j = JSON.parse(l); jobs.set(j.id, { ...(jobs.get(j.id) ?? {}), ...j }); } catch {}
    }
    for (const j of jobs.values()) {
      if ((j.taskId ?? j.task) !== task || j.id === exceptJob || j.review || j.mode === 'review' || !j.log) continue;
      const file = path.resolve(ROOT, j.log);
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (/^\[dispatch\] exit/m.test(text)) continue;
        if (Date.now() - fs.statSync(file).mtimeMs < (text.includes('[interactive]') ? 100000 : 15 * 60000)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

// First agent of the build order that is not the failed one, is not marked down, and may run sessions.
function nextExecutor(failed) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(HUB, 'executors.json'), 'utf8'));
    const defs = Array.isArray(e.executors) ? e.executors : Object.values(e.executors);
    let health = {};
    try { health = JSON.parse(fs.readFileSync(path.join(HUB, 'runs', 'health.json'), 'utf8')); } catch {}
    for (const name of e.buildOrder ?? []) {
      if (name === failed || health[name]?.ok === false) continue;
      const def = defs.find((d) => d.name === name);
      if (def && (def.maxSessions ?? 1) > 0) return name;
    }
  } catch {}
  return null;
}

// A failed agent: save the way back, close its window, restart the task on the next healthy agent.
async function retire(state, key, t, hist, kind) {
  const jobId = path.basename(key, '.log');
  const task = String(t.label).replace(/\s*\[.*$/, '');
  const failedExec = String(t.label).match(/\[([^\]]+)\]\s*$/)?.[1];
  const builder = (jobId.match(/^(builder-\d+)-/) || [])[1];
  if (hist) {
    const rec = hist.readAll().find((r) => r.id === jobId);
    if (rec && !rec.sessionId) { const sid = hist.discover(rec); if (sid) hist.record({ id: jobId, sessionId: sid }); }
    hist.record({ id: jobId, closedReason: `auto:${kind}`, closedAt: new Date().toISOString() });
  }
  try { herdr(['pane', 'close', t.pane_id]); } catch {}
  delete state.tabs[key];
  let outcome;
  if (taskHasLiveJob(task, jobId)) outcome = 'the task already runs on another agent';
  else {
    const next = nextExecutor(failedExec);
    if (!next) outcome = 'no healthy agent is available, the keeper retries later';
    else {
      hubCmd(['progress', task, '--agent', 'orchestrator', '--note', `Previous agent (${failedExec}) stopped: ${kind}. Continue from the files already changed: run git status and git diff on your scope before writing anything.`]);
      if (builder) hubCmd(['kick', builder, '--agent', 'orchestrator', '--note', `window closed by the watcher (${kind})`]);
      try {
        execFileSync(process.execPath, [path.join(HUB, 'dispatch.mjs'), 'run', next, 'auto', task], { cwd: ROOT, stdio: 'ignore', timeout: 120000 });
        outcome = `restarted on ${next}`;
      } catch { outcome = 'restart failed, the keeper retries'; }
    }
  }
  notify(`${t.label}: ${kind}`, `Window closed by the watcher; ${outcome}. The session is saved (reopen ${jobId}).`, `${jobId}:retired`);
}

async function reap() {
  if (!serverRunning()) return 0;
  const state = readState();
  if (!state.workspace_id) return 0;
  reconcile(state, state.workspace_id);
  const hist = await history();
  const now = Date.now();
  for (const [key, t] of Object.entries(state.tabs)) {
    if (!t.interactive || t.reopened) continue;
    const w = (t.watch ??= {});
    let text = '';
    try { text = String(herdr(['pane', 'read', t.pane_id, '--lines', '60'])?.raw ?? ''); } catch { continue; }
    const h = sha(text);
    if (h !== w.hash) { w.hash = h; w.changedAt = now; }
    const idleMin = (now - (w.changedAt ?? now)) / 60000;
    const done = finished(key);
    const jobId = path.basename(key, '.log');

    if (!done) {
      // 1. blocked by a quota or login error: free the hub, keep the window
      const tail = text.split('\n').slice(-25);
      const hit = ERROR_PATTERNS.map(([kind, re]) => [kind, tail.find((l) => re.test(l))]).find(([, l]) => l);
      if (hit && idleMin >= MIN.errorIdle && !w.errorHandled) {
        const [kind, line] = hit;
        w.errorHandled = true;
        try { fs.appendFileSync(key, `\nERROR ${kind}: ${line.trim()}\n[reaper] ${t.label} stopped by ${kind}\n[dispatch] exit 1\n`); } catch {}
        markExecutorDown(t.label, kind, line);
        await retire(state, key, t, hist, kind);
        continue;
      }
      // 2. idle for a long time without finishing: it may be waiting for an answer
      if (idleMin >= MIN.stalled && !w.stalledNotified) {
        w.stalledNotified = true;
        notify(`${t.label} is idle`, `No activity for ${Math.round(idleMin)} min. It may be waiting for you.`, `${jobId}:stalled`);
      }
      if (idleMin < MIN.stalled) w.stalledNotified = false;
      continue;
    }

    // 3a. the agent ended with an error (non-zero exit, or marked blocked earlier): close the window and restart the task
    const logText = (() => { try { return fs.readFileSync(key, 'utf8'); } catch { return ''; } })();
    const exitN = Number((logText.match(/^\[dispatch\] exit (-?\d+)/m) || [])[1] ?? 0);
    if (exitN !== 0 || /^\[reaper\]/m.test(logText)) {
      await retire(state, key, t, hist, (/^\[reaper\] .*stopped by (\w+)/m.exec(logText) || [])[1] ?? 'FAILED');
      continue;
    }
    // 3. finished well and still open: remind the owner, never close it
    if (!w.finishedAt) { try { w.finishedAt = fs.statSync(key).mtimeMs; } catch { w.finishedAt = now; } }
    const since = (now - w.finishedAt) / 60000;
    if (since >= MIN.finishedNotify && idleMin >= 1 && (!w.lastNotified || (now - w.lastNotified) / 60000 >= MIN.renotify)) {
      w.lastNotified = now;
      notify(`${t.label} finished ${Math.round(since)} min ago`, 'Still open for you to read. Close it yourself or ask the orchestrator to close it.', `${jobId}:finished`);
    }
  }
  writeState(state);
  return 0;
}

// Closes windows only when the owner asked: --finished, --task <id>, --pane <id>, --failed.
async function closeWindows() {
  if (!serverRunning()) { console.log('herdr: server not running'); return 1; }
  const state = readState();
  if (!state.workspace_id) return 0;
  reconcile(state, state.workspace_id);
  const hist = await history();
  const task = arg('task');
  const pane = arg('pane');
  let closed = 0;
  for (const [key, t] of Object.entries(state.tabs)) {
    const done = finished(key);
    const failed = done && /^\[reaper\]/m.test((() => { try { return fs.readFileSync(key, 'utf8'); } catch { return ''; } })());
    const pick = (flag('finished') && done) || (flag('failed') && failed) || (task && String(t.label).startsWith(task)) || (pane && t.pane_id === pane);
    if (!pick) continue;
    const jobId = path.basename(key, '.log');
    if (hist) {
      const rec = hist.readAll().find((r) => r.id === jobId);
      if (rec && !rec.sessionId) { const sid = hist.discover(rec); if (sid) hist.record({ id: jobId, sessionId: sid }); }
      hist.record({ id: jobId, closedReason: 'owner', closedAt: new Date().toISOString() });
    }
    try { herdr(['pane', 'close', t.pane_id]); } catch {}
    delete state.tabs[key];
    closed++;
    console.log(`closed ${t.label}`);
  }
  reconcile(state, state.workspace_id);
  writeState(state);
  console.log(`${closed} window(s) closed (history kept: node .agent-hub/tools/agent-history.mjs list)`);
  return 0;
}

// Brings a closed agent back into the grid: opens a pane and runs the agent's own resume command.
async function reopen() {
  const hist = await history();
  const wanted = rest.find((a) => !a.startsWith('--'));
  if (!hist || !wanted) { console.log('usage: reopen <job id | task id>'); return 2; }
  if (!serverRunning()) { console.log('herdr: server not running'); return 1; }
  let rec = hist.readAll().find((r) => r.id === wanted) ?? hist.readAll().find((r) => r.task === wanted && r.mode !== 'review');
  if (!rec) { console.log(`no history for "${wanted}"`); return 1; }
  if (!rec.sessionId) { const sid = hist.discover(rec); if (sid) { hist.record({ id: rec.id, sessionId: sid }); rec = { ...rec, sessionId: sid }; } }
  const command = hist.resumeCommand(rec);
  const state = readState();
  const { id } = ensureWorkspace(state);
  const label = `${rec.task ?? rec.id} [${rec.executor}] (reopened)`;
  const p = place(state, id, label);
  runInPane(p.pane_id, command);
  state.tabs[`reopen:${rec.id}:${Date.now()}`] = { tab_id: p.tab_id, pane_id: p.pane_id, at: Date.now(), label, interactive: true, reopened: true };
  writeState(state);
  console.log(`reopened ${label}: ${command}${rec.sessionId ? '' : '  (session id not found: pick the conversation from the list it shows)'}`);
  return 0;
}

// Sends a follow-up message into the EXACT agent session that did the work (it keeps all its context), so nothing
// is re-run and no context is injected again. If the window was closed it is reopened first from the history library.
async function tell() {
  const words = rest.filter((a) => !a.startsWith('--'));
  const wanted = words[0];
  const message = words.slice(1).join(' ').replace(/\s*\n\s*/g, ' ').trim();
  if (!wanted || !message) { console.log('usage: tell <task id | pane id> <message>'); return 2; }
  if (!serverRunning()) { console.log('herdr: server not running'); return 1; }
  const findWindow = () => {
    const state = readState();
    reconcile(state, state.workspace_id);
    const entries = Object.values(state.tabs).filter((t) => t.interactive && (t.pane_id === wanted || String(t.label).startsWith(`${wanted} `) || String(t.label) === wanted));
    return entries.sort((a, b) => b.at - a.at)[0] ?? null;
  };
  let win = findWindow();
  if (!win) {
    console.log('window is closed, reopening the session from the history library...');
    const rc = await reopen();
    if (rc !== 0) return rc;
    await new Promise((r) => setTimeout(r, 20000)); // let the agent start and load the conversation
    win = findWindow();
    if (!win) { console.log('could not find the reopened window'); return 1; }
  }
  herdr(['pane', 'send-text', win.pane_id, message]);
  await new Promise((r) => setTimeout(r, 800));
  herdr(['pane', 'send-keys', win.pane_id, 'Enter']);
  const task = String(win.label).replace(/\s*\[.*$/, '');
  try { execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), 'progress', task, '--agent', 'orchestrator', '--note', `Follow-up sent into the live agent session: ${message.slice(0, 300)}`], { cwd: ROOT, stdio: 'ignore', timeout: 20000 }); } catch {}
  console.log(`sent to ${win.label} (${win.pane_id}); the note is recorded on the task`);
  return 0;
}

let code = 0;
try {
  if (cmd === 'tell') code = await tell();
  else if (cmd === 'reap') code = await reap();
  else if (cmd === 'close') code = await withLock(closeWindows);
  else if (cmd === 'reopen') code = await withLock(reopen);
  else if (cmd === 'gather') code = await withLock(async () => gather());
  else if (cmd === 'ensure') code = await ensure();
  else if (cmd === 'watch') code = await withLock(async () => watch());
  else if (cmd === 'run') code = await withLock(async () => runInteractive());
  else if (cmd === 'prune') code = prune();
  else if (cmd === 'status') code = status();
  else { console.error(`unknown command "${cmd}"`); code = 2; }
} catch (e) {
  if (!quiet) console.error(`herdr-bridge: ${String(e?.message ?? e).split('\n')[0]}`);
  code = quiet ? 0 : 1;
}
// --soft: never report a failure to the caller (used by the session start hook).
process.exit(flag('soft') ? 0 : code);
