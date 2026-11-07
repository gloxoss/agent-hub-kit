#!/usr/bin/env node
// Bridge between the agent hub and Herdr (terminal workspace manager).
//
// What it gives the owner: one Herdr workspace for the project. A "board" tab shows the hub live, and every
// agent job the hub starts gets its own tab that follows the job log in readable form (tools/job-view.mjs).
//
//   node .agent-hub/tools/herdr-bridge.mjs ensure [--open]     make sure Herdr runs and the workspace and board tab exist
//   node .agent-hub/tools/herdr-bridge.mjs watch --log <file> --label <text>   open a tab for one job (never fails the caller)
//   node .agent-hub/tools/herdr-bridge.mjs run --spec <file> --log <file> --label <text>   open a tab running the agent INTERACTIVELY (exit 3 = Herdr unavailable)
//   node .agent-hub/tools/herdr-bridge.mjs prune [--minutes N]  close tabs of jobs that finished more than N minutes ago (default 30)
//   node .agent-hub/tools/herdr-bridge.mjs status
//
// Rules: it only talks to Herdr through the documented `herdr` CLI. `watch` and `prune` exit 0 on any problem,
// because a missing Herdr must never stop a job. `--open` is the only thing that may open a window, and only
// `ensure` accepts it (used by the session start hook).

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("usage: herdr-bridge.mjs ensure [--open] [--soft] | watch --log <file> --label <text> | run --spec <file> --log <file> --label <text> | prune [--minutes N] | status"); process.exit(0); }

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
const MAX_TABS = Number(CFG.maxTabs ?? 14);

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
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { workspace_id: null, tabs: {} }; }
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

function runInPane(paneId, command) {
  herdr(['pane', 'run', paneId, command]);
}

function ensureWorkspace(state) {
  let id = findWorkspace(state);
  let created = false;
  if (!id) {
    const r = herdr(['workspace', 'create', '--label', WORKSPACE_LABEL, '--cwd', ROOT]).result;
    id = r.workspace.workspace_id;
    created = true;
    state.tabs = {};
    const boardPane = r.root_pane.pane_id;
    try { herdr(['tab', 'rename', r.tab.tab_id, 'board']); } catch {}
    runInPane(boardPane, `node "${fwd(path.join(HERE, 'hub-board.mjs'))}"`);
    state.board = { tab_id: r.tab.tab_id, pane_id: boardPane };
  }
  state.workspace_id = id;
  return { id, created };
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
  writeState(state);
  console.log(`herdr: ready, workspace ${id} "${WORKSPACE_LABEL}"${created ? ' (created, board tab started)' : ''}`);
  return 0;
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
  if (state.tabs?.[key]) { writeState(state); return 0; }

  // Keep the tab bar readable: drop the oldest finished tabs when there are too many.
  const keys = Object.keys(state.tabs ?? {}).filter((k) => !state.tabs[k].interactive);
  if (keys.length >= MAX_TABS) {
    for (const k of keys.slice(0, keys.length - MAX_TABS + 1)) closeTab(state, k);
  }

  const r = herdr(['tab', 'create', '--workspace', id, '--label', label.slice(0, 40), '--cwd', ROOT]).result;
  const pane = r.root_pane.pane_id;
  runInPane(pane, `node "${fwd(path.join(HERE, 'job-view.mjs'))}" "${key}" "${label}"`);
  (state.tabs ??= {})[key] = { tab_id: r.tab.tab_id, pane_id: pane, label, at: Date.now() };
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
  const r = herdr(['tab', 'create', '--workspace', id, '--label', label.slice(0, 40), '--cwd', ROOT]).result;
  const pane = r.root_pane.pane_id;
  const specAbs = path.isAbsolute(spec) ? spec : path.resolve(ROOT, spec);
  runInPane(pane, `node "${fwd(path.join(HERE, 'interactive-run.mjs'))}" "${fwd(specAbs)}"`);
  (state.tabs ??= {})[key] = { tab_id: r.tab.tab_id, pane_id: pane, label, at: Date.now(), interactive: true };
  writeState(state);
  return 0;
}

function finished(logKey) {
  try { return /^\[dispatch\] exit/m.test(fs.readFileSync(logKey, 'utf8')); } catch { return true; }
}

function closeTab(state, key) {
  const t = state.tabs?.[key];
  if (!t || t.interactive) return; // a live agent conversation is never closed by the bridge
  try { herdr(['tab', 'close', t.tab_id]); } catch {}
  delete state.tabs[key];
}

function prune() {
  if (!serverRunning()) return 0;
  const minutes = Number(arg('minutes', 30));
  const state = readState();
  const live = new Set((herdr(['tab', 'list', '--workspace', state.workspace_id ?? ''])?.result?.tabs ?? []).map((t) => t.tab_id));
  for (const [key, t] of Object.entries(state.tabs ?? {})) {
    if (!live.has(t.tab_id)) { delete state.tabs[key]; continue; }
    let ageMin = Infinity;
    try { ageMin = (Date.now() - fs.statSync(key).mtimeMs) / 60000; } catch {}
    if (finished(key) && ageMin > minutes) closeTab(state, key);
  }
  writeState(state);
  return 0;
}

function status() {
  const up = serverRunning();
  const state = readState();
  console.log(`herdr server: ${up ? 'running' : 'not running'}`);
  console.log(`workspace: ${state.workspace_id ?? '(none)'} "${WORKSPACE_LABEL}"`);
  const tabs = Object.entries(state.tabs ?? {});
  console.log(`job tabs: ${tabs.length}`);
  for (const [key, t] of tabs) console.log(`  ${t.tab_id}  ${t.label}  ${t.interactive ? 'interactive ' : 'log view   '}${finished(key) ? 'finished' : 'running'}`);
  return 0;
}

let code = 0;
try {
  if (cmd === 'ensure') code = await ensure();
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
