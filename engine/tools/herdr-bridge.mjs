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
//   node .agent-hub/tools/herdr-bridge.mjs status
//
// Config (config.json, key "herdr"): enabled, interactive, workspaceLabel, panesPerTab (default 4), layout ("panes" | "tabs").
// Rules: it only talks to Herdr through the documented `herdr` CLI. `watch` and `prune` exit 0 on any problem, because
// a missing Herdr must never stop a job. Interactive panes are never closed by the bridge: a conversation may be in progress.

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log('usage: herdr-bridge.mjs ensure [--open] [--soft] | run --spec <file> --log <file> --label <text> | watch --log <file> --label <text> | prune [--minutes N] | gather | status'); process.exit(0); }

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

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    s.tabs ??= {};
    s.groups ??= [];
    return s;
  } catch { return { workspace_id: null, tabs: {}, groups: [] }; }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch {}
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

let code = 0;
try {
  if (cmd === 'gather') code = gather();
  else if (cmd === 'ensure') code = await ensure();
  else if (cmd === 'watch') code = watch();
  else if (cmd === 'run') code = runInteractive();
  else if (cmd === 'prune') code = prune();
  else if (cmd === 'status') code = status();
  else { console.error(`unknown command "${cmd}"`); code = 2; }
} catch (e) {
  if (!quiet) console.error(`herdr-bridge: ${String(e?.message ?? e).split('\n')[0]}`);
  code = quiet ? 0 : 1;
}
// --soft: never report a failure to the caller (used by the session start hook).
process.exit(flag('soft') ? 0 : code);
