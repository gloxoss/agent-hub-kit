#!/usr/bin/env node
// Launches hub tasks on external executor CLIs as detached background jobs, so the orchestrator
// plans and reviews while other models do the work.
//
//   node ${HUB_NAME}/dispatch.mjs ping [executor|all]                  say hi to executors, report OK / QUOTA / AUTH / DOWN
//   node ${HUB_NAME}/dispatch.mjs run <executor> <lane|auto> <task..>  build tasks, one session each, then stop
//   node ${HUB_NAME}/dispatch.mjs review <taskId> [executor]           read-only review, verdict in a short file
//   node ${HUB_NAME}/dispatch.mjs list [--all]                         jobs with status, session id, watch command
//   node ${HUB_NAME}/dispatch.mjs lanes                                which lanes are free or busy, sessions per executor
//   node ${HUB_NAME}/dispatch.mjs opencode-server                      start the shared opencode server (4096) if not running
//
// Every job streams events to .agent-hub/runs/<job>.log (gitignored), so a human can follow it live
// with `Get-Content -Wait <log>` and resume or attach with the executor's own command shown by `list`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stage as stageSkills } from './tools/skills.mjs';
import { fold } from './fold.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HUB = path.dirname(fileURLToPath(import.meta.url));
let ROOT = process.env.HUB_ROOT;
if (!ROOT) {
  try {
    const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HUB, encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      ROOT = path.dirname(res.stdout.trim());
    }
  } catch {}
}
if (!ROOT) {
  ROOT = path.dirname(HUB);
}
const HUB_NAME = path.basename(HUB);
const RUNS = path.join(HUB, 'runs');
const JOBS = path.join(RUNS, 'jobs.jsonl');
const OPENCODE_URL = 'http://127.0.0.1:4096';
const RECENT_MS = 120_000;
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
fs.mkdirSync(RUNS, { recursive: true });

function isInsideArea(scopePath, prefix) {
  const p = prefix.replace(/\\/g, '/');
  const s = scopePath.replace(/\\/g, '/');
  if (s === p) return true;
  const pNorm = p.endsWith('/') ? p : p + '/';
  return s.startsWith(pNorm);
}

function localTasks() {
  const file = path.join(HUB, 'events.jsonl');
  const tasks = {};
  if (!fs.existsSync(file)) return tasks;
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const { tasks: tmap } = fold(events);
  return tmap;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const CFG = readJson(path.join(HUB, 'config.json'), {});
const TABLE = readJson(path.join(HUB, 'executors.json'), { executors: [] });

export function isMigration(task) {
  if (!task) return false;
  if (task.phase && String(task.phase).toLowerCase() === 'migration') return true;
  const paths = CFG.migrationPaths || ["drizzle/", "migrations/", "prisma/migrations/", "db/migrations/"];
  const scope = task.scope || task.files || [];
  for (const scopePath of scope) {
    const s = String(scopePath).replace(/\\/g, '/');
    for (const mPath of paths) {
      const m = mPath.replace(/\\/g, '/');
      if (s === m || s.startsWith(m) || s.includes('/' + m) || s.includes(m)) {
        return true;
      }
    }
  }
  return false;
}
const ALL_DEFS = Array.isArray(TABLE) ? TABLE : (TABLE.executors ?? []);

function getWorktreePath(taskId) {
  if (!CFG.worktrees?.enabled) return ROOT;
  const wtBase = (CFG.worktrees?.base || '../{repo}-wt').replace('{repo}', path.basename(ROOT));
  return path.resolve(ROOT, wtBase, taskId);
}

function ensureWorktree(taskId) {
  if (!CFG.worktrees?.enabled) return ROOT;
  const wtPath = getWorktreePath(taskId);
  if (!fs.existsSync(wtPath)) {
    let res = spawnSync('git', ['worktree', 'add', wtPath, '-b', `task/${taskId}`], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) {
      res = spawnSync('git', ['worktree', 'add', wtPath, `task/${taskId}`], { cwd: ROOT, encoding: 'utf8' });
    }
    if (res.status !== 0) {
      spawnSync('git', ['worktree', 'add', '--force', wtPath, `task/${taskId}`], { cwd: ROOT, encoding: 'utf8' });
    }
    const installMode = CFG.worktrees?.install || 'auto';
    if (installMode !== 'none') {
      let installCmd = 'npm';
      let installArgs = ['ci'];
      if (fs.existsSync(path.join(wtPath, 'pnpm-lock.yaml'))) {
        installCmd = 'pnpm';
        installArgs = ['install'];
      } else if (fs.existsSync(path.join(wtPath, 'yarn.lock'))) {
        installCmd = 'yarn';
        installArgs = ['install'];
      } else if (!fs.existsSync(path.join(wtPath, 'package-lock.json'))) {
        installArgs = ['install'];
      }
      if (!fs.existsSync(path.join(wtPath, 'node_modules'))) {
        // Same lockfile as the main checkout: share its node_modules (0 bytes, 0 CPU) instead of a full install per worktree.
        const main = path.join(ROOT, 'node_modules');
        const sameLock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].every((f) => !fs.existsSync(path.join(wtPath, f)) || (fs.existsSync(path.join(ROOT, f)) && fs.readFileSync(path.join(wtPath, f)).equals(fs.readFileSync(path.join(ROOT, f)))));
        if (fs.existsSync(main) && sameLock) { try { fs.symlinkSync(main, path.join(wtPath, 'node_modules'), 'junction'); } catch { /* fall back to install */ } }
        if (!fs.existsSync(path.join(wtPath, 'node_modules'))) spawnSync(installCmd, installArgs, { cwd: wtPath, stdio: 'ignore', windowsHide: true });
      }
    }
  }
  return wtPath;
}

// A launcher is a user-made wrapper (a PATH command, or a script in ~/.claude-launchers);
// entries marked requiresLauncher are hidden from every chain until it exists.
function launcherExists(name) {
  const dir = path.join(os.homedir(), '.claude-launchers');
  if (['.ps1', '.cmd', '.bat', '.exe'].some((ext) => fs.existsSync(path.join(dir, name + ext)))) return true;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return probe.status === 0;
}

const EXECUTOR_DEFS = ALL_DEFS.filter((d) => !d.disabled && (!d.requiresLauncher || launcherExists(d.name)));
const EXECUTOR_MAP = Object.fromEntries(EXECUTOR_DEFS.map((e) => [e.name, e]));
const enabled = (name) => !!EXECUTOR_MAP[name];

// Build the executor object the rest of this file expects, mapping placeholders {msg} {sid} {job}
// {outFile} {model} {attach}. An array value is spliced in (used for opencode's optional attach args).
function fillArgs(template, vars) {
  const out = [];
  for (const a of template) {
    const whole = a.match(/^\{(\w+)\}$/);
    if (whole && Array.isArray(vars[whole[1]])) { out.push(...vars[whole[1]]); continue; }
    out.push(a.replace(/\{(\w+)\}/g, (_, k) => (Array.isArray(vars[k]) ? vars[k].join(' ') : vars[k] ?? a)));
  }
  return out;
}

// Built-in interactive arguments. They apply when executors.json defines none, so a rewritten config cannot
// silently turn the interactive agent windows off. executors.json can still override them per executor.
const DEFAULT_INTERACTIVE_ARGS = {
  agy: ['--dangerously-skip-permissions', '-i', '{msg}'],
  opencode: ['-m', '{model}', '--prompt', '{msg}'],
  'opencode-ds': ['-m', '{model}', '--prompt', '{msg}'],
  codex: ['--sandbox', 'workspace-write', '{msg}'],
  'claude-ag2-sonnet': ['--strict-mcp-config', '--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  'claude-ag2-gemini': ['--strict-mcp-config', '--tools', 'Bash,Read,Edit,Write,Glob,Grep', '--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  'claude-grok': ['--strict-mcp-config', '--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  'claude-ds1': ['--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  'claude-ds2': ['--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  'claude-ds3': ['--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  claude: ['--session-id', '{sid}', '--dangerously-skip-permissions', '{msg}'],
  cursor: ['--model', 'grok-4.7-medium-fast', '--force', '{msg}'],
};

function makeExecutor(def) {
  const model = process.env.OPENCODE_MODEL || def.model || CFG.opencodeModel || 'opencode/beam-free';
  const usesAttach = [...(def.buildExtraArgs ?? []), ...(def.reviewExtraArgs ?? [])].some((a) => a.includes('{attach}'));
  const varsFor = (msg, job, sid, opts) => ({
    msg, job, sid: sid ?? '', outFile: opts.outFile ?? '', model,
    attach: usesAttach && serverUp() ? ['--attach', OPENCODE_URL] : [],
  });
  return {
    build: (msg, job, sid, opts = {}) => {
      const vars = varsFor(msg, job, sid, opts);
      if (opts.review && def.reviewCmd) return [def.reviewCmd, fillArgs(def.reviewExtraArgs ?? [], vars)];
      return [def.buildCmd, fillArgs(def.buildExtraArgs ?? [], vars)];
    },
    watch: (id) => {
      if (!def.watch || def.watch === 'null') return null;
      return def.watch.replace(/\{sid\}/g, id ?? '');
    },
    interactive: (def.interactiveArgs ?? DEFAULT_INTERACTIVE_ARGS[def.name]) ? (msg, job, sid, opts = {}) => [def.buildCmd, fillArgs(def.interactiveArgs ?? DEFAULT_INTERACTIVE_ARGS[def.name], varsFor(msg, job, sid, opts))] : null,
    restore: def.restore ?? '',
  };
}

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
    const entries = pick({ role, hubDir: HUB_NAME, exclude: excludeList });
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

const EXECUTORS = Object.fromEntries(EXECUTOR_DEFS.map((d) => [d.name, makeExecutor(d)]));
const maxSessions = (ex) => EXECUTOR_MAP[ex]?.maxSessions ?? 2;

const staticBuild = (Array.isArray(TABLE.buildOrder) ? TABLE.buildOrder : EXECUTOR_DEFS.map((d) => d.name)).filter(enabled);
const pickedBuild = getPickedList('builder');
const buildOrder = pickedBuild.length ? [...new Set([...pickedBuild, ...staticBuild])] : staticBuild;

const staticReview = (Array.isArray(TABLE.reviewOrder) ? TABLE.reviewOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['reviewer', 'both'].includes(EXECUTOR_MAP[n].kind));
const pickedReview = getPickedList('reviewer');
const reviewOrder = pickedReview.length ? [...new Set([...pickedReview, ...staticReview])] : staticReview;

// Load prompt templates (worker.md and review.md).
const WORKER_TMPL = fs.existsSync(path.join(HUB, 'templates', 'prompts', 'worker.md'))
  ? fs.readFileSync(path.join(HUB, 'templates', 'prompts', 'worker.md'), 'utf8')
  : null;
const REVIEW_TMPL = fs.existsSync(path.join(HUB, 'templates', 'prompts', 'review.md'))
  ? fs.readFileSync(path.join(HUB, 'templates', 'prompts', 'review.md'), 'utf8')
  : null;

// Read project name from AGENTS.md first line or fall back to dir name.
function projectName() {
  try {
    const first = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').split('\n')[0];
    return first.replace(/^#\s*/, '').split('—')[0].trim() || path.basename(ROOT);
  } catch { return path.basename(ROOT); }
}

// Ordered: the first matching rule names the problem the human has to fix. DOWN comes first because a
// refused connection often also mentions retries or limits.
const PROBLEMS = [
  ['DOWN', /ECONNREFUSED|ENOTFOUND|connection refused|No such file or directory|command not found|is not recognized|ETIMEDOUT/i],
  ['QUOTA', /\b429\b|quota|rate[ _-]?limit(ed| reached| exceeded)|usage limit|hit your (usage )?limit|purchase more credits|insufficient[ _-]?(balance|credit|quota|funds)|out of credits|resource[ _-]?exhausted|exceeded your|credit balance|too many requests/i],
  ['AUTH', /\b401\b|\b403\b|unauthori[sz]ed|not logged in|please log ?in|invalid (api )?key|authentication/i],
];
// Only error lines are judged: normal JSON events carry field names like "rate_limits" on success.
const ERROR_LINE = /error|"is_error":\s*true|failed|denied|exceeded|refused|not recognized|not found|limit reached/i;

const readJobs = () => (fs.existsSync(JOBS) ? fs.readFileSync(JOBS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const record = (job) => fs.appendFileSync(JOBS, JSON.stringify(job) + '\n');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const DURATIONS_FILE = path.join(RUNS, 'durations.json');
const RECORDED_DURATIONS_FILE = path.join(RUNS, 'durations-recorded.json');

function recordDuration(job) {
  if (!job || !job.t) return;
  try {
    let recorded = {};
    try { recorded = JSON.parse(fs.readFileSync(RECORDED_DURATIONS_FILE, 'utf8')); } catch {}
    if (recorded[job.id]) return;

    const startTime = Date.parse(job.t);
    if (isNaN(startTime)) return;
    const durationMin = Math.max(1, (Date.now() - startTime) / 60_000);
    const phase = job.mode ?? (job.review ? 'review' : 'run');
    const key = `${job.executor}:${phase}`;

    let data = {};
    try { data = JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8')); } catch {}

    data.samples = data.samples || {};
    data.samples[key] = data.samples[key] || [];
    data.samples[key].push(durationMin);
    if (data.samples[key].length > 50) data.samples[key].shift();

    const samples = [...data.samples[key]].sort((a, b) => a - b);
    const mid = Math.floor(samples.length / 2);
    const median = samples.length % 2 !== 0 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;

    data.durations = data.durations || {};
    data.durations[key] = samples;
    data[key] = Math.round(median * 10) / 10;

    fs.writeFileSync(DURATIONS_FILE, JSON.stringify(data, null, 1));
    recorded[job.id] = true;
    fs.writeFileSync(RECORDED_DURATIONS_FILE, JSON.stringify(recorded, null, 1));
  } catch {}
}

// Windows launchers are .cmd files, which only run through a shell, and the shell does not quote
// arguments for us: a prompt with spaces would arrive as separate words. Build one quoted command line.
const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
function run(cmd, args, options) {
  return process.platform === 'win32'
    ? [[cmd, ...args].map(quote).join(' '), [], { ...options, shell: true }]
    : [cmd, args, { ...options, shell: false }];
}

// Lanes are the builder-N ids whose build dirs are listed in tsconfig.json; without them, no lane is offered.
function lanes() {
  if (Array.isArray(CFG.lanes) && CFG.lanes.length) return CFG.lanes;
  let found = [];
  try {
    const ts = fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8');
    found = [...new Set([...ts.matchAll(/\.next-(builder-\d+)\/types/g)].map((m) => m[1]))].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  } catch {}
  if (found.length) return found;
  return ['builder-1', 'builder-2', 'builder-3', 'builder-4', 'builder-5', 'builder-6'];
}

// Windows reuses PIDs, so a finished job can look alive: it is live only if its log has no exit marker.
// A job whose log changed in the last two minutes also counts as live (a wrapper may briefly look dead).
function isLive(job, alive) {
  const logPath = path.join(ROOT, job.log);
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch {}
  // Only the runner's own exit line counts: agents often print '[dispatch] exit' when they read other logs.
  if (/^\[dispatch\] exit/m.test(text)) return false;
  if (alive.has(String(job.pid))) return true;
  try { return Date.now() - fs.statSync(logPath).mtimeMs < RECENT_MS; } catch { return false; }
}

function freeLane(busy) {
  const status = hubCmd(['status'], true);
  const activeLine = status.split('\n').find((l) => l.startsWith('agents:')) ?? '';
  const active = new Set([...activeLine.matchAll(/(builder-\d+)\((?![^)]*STALE)/g)].map((m) => m[1]));
  return lanes().find((l) => !busy.has(l) && !active.has(l)) ?? null;
}

function hubCmd(args, quiet = false) {
  const r = spawnSync(process.execPath, [path.join(HUB, 'hub.mjs'), ...args, '--agent', (CFG.orchestratorAgent || 'orchestrator')], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && !quiet) throw new Error(`hub ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout ?? '';
}

function serverUp() {
  try { return execSync('netstat -ano', { encoding: 'utf8' }).split('\n').some((l) => l.includes(':4096 ') && l.includes('LISTEN')); } catch { return false; }
}

const DISPATCH_DURATIONS_FILE = path.join(RUNS, 'durations.json');
function updateDurations(alive) {
  let data = { durations: {}, processed: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(DISPATCH_DURATIONS_FILE, 'utf8'));
    data.durations = parsed.durations || parsed;
    data.processed = parsed.processed || {};
  } catch {}
  const jobs = readJobs();
  let updated = false;
  for (const job of jobs) {
    if (data.processed[job.id]) continue;
    if (!isLive(job, alive)) {
      const logPath = path.join(ROOT, job.log);
      let durationMin = 0;
      try {
        const stats = fs.statSync(logPath);
        durationMin = Math.max(1, Math.round((stats.mtimeMs - Date.parse(job.t)) / 60000));
      } catch {
        durationMin = Math.max(1, Math.round((Date.now() - Date.parse(job.t)) / 60000));
      }
      const phase = job.mode === 'review' || job.review ? 'review' : 'run';
      const key = `${job.executor}:${phase}`;
      data.durations[key] ??= [];
      data.durations[key].push(durationMin);
      data.processed[job.id] = true;
      updated = true;
    }
  }
  if (updated) {
    try { fs.writeFileSync(DISPATCH_DURATIONS_FILE, JSON.stringify(data, null, 1)); } catch {}
  }
  return data;
}

// PIDs currently alive, as strings. Windows uses tasklist (CSV), POSIX uses ps.
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

// Pull the executor's session id out of its JSON event stream.
function sessionId(job, text) {
  if (job.sessionId) return job.sessionId;
  const m = text.match(/"sessionID":"(ses_[^"]+)"/) || text.match(/"thread_id":"([^"]+)"/) || text.match(/"conversation(?:_id|Id)":"([^"]+)"/) || text.match(/"session_id":"([^"]+)"/);
  return m?.[1] ?? null;
}

function diagnose(text) {
  // Only judge the tail: a model quoting the word "quota" mid-task is not an outage.
  const tail = text.split('\n').slice(-40).filter((l) => ERROR_LINE.test(l)).join('\n');
  for (const [kind, re] of PROBLEMS) if (re.test(tail)) return kind;
  return null;
}

// Shows the job in its own Herdr tab (live, readable) when Herdr runs and config.herdr.enabled is true.
// Fire and forget: a missing Herdr or any error here must never stop a job.
function openInHerdr(executor, base) {
  try {
    if (CFG.herdr?.enabled === false) return;
    const name = path.basename(base).replace(/-mw[a-z0-9]+$/, '');
    const isReview = name.startsWith('review-');
    const task = name.replace(/^(builder-\d+-|review-)/, '');
    const label = isReview ? `review ${task}` : `${task} [${executor}]`;
    const bridge = path.join(ROOT, '.agent-hub', 'tools', 'herdr-bridge.mjs');
    if (!fs.existsSync(bridge)) return;
    const logRel = `${base}.log`;
    spawn(process.execPath, [bridge, 'watch', '--log', logRel, '--label', label], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

// Interactive mode: the agent runs as a normal session in its own Herdr tab, so the owner can read and talk to it.
// Returns null (and the caller falls back to the hidden headless runner) when Herdr is off, unreachable, or the
// executor has no interactive arguments. Reviews stay headless because their verdict file is extracted from the log.
function launchInteractive(executor, ex, message, base, opts) {
  try {
    if (CFG.herdr?.enabled === false || CFG.herdr?.interactive === false || opts.review || !ex.interactive) return null;
    const bridge = path.join(ROOT, '.agent-hub', 'tools', 'herdr-bridge.mjs');
    if (!fs.existsSync(bridge)) return null;
    const abs = path.resolve(ROOT, base);
    const [cmd, args] = ex.interactive(message, path.basename(base), crypto.randomUUID(), opts);
    const name = path.basename(base).replace(/-mw[a-z0-9]+$/, '');
    const builder = (name.match(/^(builder-\d+)-/) || [])[1] || '';
    const task = name.replace(/^(builder-\d+-|review-)/, '');
    const specFile = `${abs}.spec.json`;
    fs.writeFileSync(specFile, JSON.stringify({ cmd, args, cwd: opts.cwd || ROOT, log: `${abs}.log`, builder, task, startedAt: Date.now() }));
    fs.appendFileSync(`${abs}.log`, `[interactive] queued ${new Date().toISOString()}
`);
    const r = spawnSync(process.execPath, [bridge, 'run', '--spec', specFile, '--log', `${abs}.log`, '--label', `${task} [${executor}]`], { cwd: ROOT, timeout: 30000, stdio: 'ignore', windowsHide: true });
    return r.status === 0 ? { pid: null, sessionId: null } : null;
  } catch {
    return null;
  }
}

function launch(executor, message, base, opts = {}) {
  const ex = EXECUTORS[executor];
  if (!ex) throw new Error(`unknown executor "${executor}". Known: ${Object.keys(EXECUTORS).join(', ')}`);
  const interactive = launchInteractive(executor, ex, message, base, opts);
  if (interactive) return interactive;
  const sid = crypto.randomUUID();
  const [cmd, args] = ex.build(message, path.basename(base), sid, opts);
  // On Windows these CLIs write nothing when a file is attached directly as their stdout, but they do
  // write to a pipe. So a detached runner (this script, mode _runner) owns the pipe and streams to the log.
  // Codex writes the verdict file itself; for other reviewers the runner extracts it from the final result.
  const verdictArg = opts.outFile && executor !== 'codex' ? [opts.outFile] : [];
  const runnerCwd = opts.cwd || ROOT;
  const runner = spawn(process.execPath, [fileURLToPath(import.meta.url), '_runner', `${base}.log`, JSON.stringify([cmd, args]), ...verdictArg], { cwd: runnerCwd, detached: true, stdio: 'ignore', windowsHide: true });
  runner.unref();
  openInHerdr(executor, base);
  return { pid: runner.pid, sessionId: args.includes('--session-id') ? sid : null };
}

// Runs one executor with stdin closed (several CLIs wait for piped input and hang otherwise) and
// appends its stdout and stderr to the log as they arrive, then an exit marker.
function runner(logFile, spec, verdictFile) {
  const [cmd, args] = JSON.parse(spec);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(...run(cmd, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_ROOT: ROOT }, windowsHide: true, detached: process.platform !== 'win32' }));
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on('close', (code) => {
    out.end(`\n[dispatch] exit ${code}\n`, () => {
      // Claude-family reviewers end with a stream-json "result" event holding the verdict text.
      if (!verdictFile || fs.existsSync(verdictFile)) return;
      const results = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{') && l.includes('"type":"result"'));
      try {
        const r = JSON.parse(results.at(-1));
        if (r?.result && !r.is_error) fs.writeFileSync(verdictFile, `${String(r.result).trim()}\n`);
      } catch {}
    });
  });
  child.on('error', (err) => out.end(`\n[dispatch] error ${err.message}\n`));
  // Watchdog: a worker that outlives its wall-clock budget or goes silent is killed (exit 124) so it cannot sit in RAM for hours.
  // HUB_MAX_JOB_MS / HUB_MAX_SILENCE_MS override the limits (used to test the watchdog in seconds).
  const maxMs = Number(process.env.HUB_MAX_JOB_MS) || (CFG.resources?.maxJobMinutes ?? 90) * 60_000, silentMs = Number(process.env.HUB_MAX_SILENCE_MS) || (CFG.resources?.maxSilenceMinutes ?? 20) * 60_000;
  const started = Date.now();
  const dog = setInterval(() => {
    let quiet = 0; try { quiet = Date.now() - fs.statSync(logFile).mtimeMs; } catch { /* log not there yet */ }
    const why = Date.now() - started > maxMs ? `over ${Math.round(maxMs / 6000) / 10} min` : quiet > silentMs ? `silent for ${Math.round(quiet / 60000)} min` : null;
    if (!why) return;
    clearInterval(dog);
    out.write(`\n[dispatch] watchdog: ${why}, killing the worker\n`);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }, Math.max(500, Math.min(30_000, Math.floor(silentMs / 3))));
  child.on('close', () => clearInterval(dog));
}

function jobStatus(job, alive) {
  const logPath = path.join(ROOT, job.log);
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const running = isLive(job, alive);
  if (!running) {
    recordDuration(job);
  }
  const exit = text.match(/\[dispatch\] exit (-?\d+|null)\s*$/)?.[1];
  // A clean exit is never a quota or auth problem, whatever words the agent's own output contains.
  const failed = !running && exit !== '0';
  const problem = failed ? diagnose(text) : null;
  const sid = sessionId(job, text);
  let status = running ? 'RUNNING' : failed ? problem ?? `FAILED (exit ${exit ?? '?'})` : 'DONE';
  if (!running && !problem && job.mode === 'review') {
    // Some reviewers write a sentence before the verdict line, so find it anywhere in the file.
    const verdict = job.out && fs.existsSync(path.join(ROOT, job.out)) ? fs.readFileSync(path.join(ROOT, job.out), 'utf8') : '';
    status = verdict.match(/VERDICT:\s*(PASS|FAIL)/)?.[0].replace(/\s+/, ' ') ?? 'NO VERDICT';
  }
  return { status, problem, sid };
}

function printJob(job, st) {
  const ex = EXECUTORS[job.executor];
  console.log(`${job.id}  ${job.executor}  ${job.taskId ?? ''}  ${st.status}`);
  console.log(`  live:    Get-Content -Wait ${job.log.replace(/\//g, '\\')}`);
  const w = ex?.watch(st.sid);
  if (w) console.log(`  session: ${st.sid ?? '(pending)'}   open: ${w}`);
  if (st.problem) console.log(`  ACTION FOR YOU (${st.problem}): ${ex?.restore ?? ''}`);
}

// Proof lines for this workspace — read from AGENTS.md if present, else generic.
function defaultProofLines(agentId, taskId) {
  const proof = CFG.proofLines ?? `Proof: the project's build and lint commands exit 0, the gates pass in your files, and git status --short shows nothing outside your claim. No browser checks unless the brief says otherwise. If the build fails only because of files outside your claim (another task mid-edit), do not block: make sure lint and gates pass for your files, run done, and write 'cross-lane build break in <file:error>' in --verify.`;
  return proof.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ agentId, taskId })[k] ?? '');
}

function workerPrompt(agentId, taskId, worktreePath) {
  const proj = projectName();
  const skills = stageSkills(taskId);
  const rootDir = worktreePath || getWorktreePath(taskId);
  const vars = { agentId, taskId, PROJECT: proj, root: rootDir, HUB_DIR: HUB_NAME, proofLines: defaultProofLines(agentId, taskId), skills };
  if (WORKER_TMPL) return WORKER_TMPL.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  // Inline fallback if template is missing.
  return `You are ${agentId}, a worker in the ${proj} agent hub. Repo root: ${rootDir}. Run every command from there.\n\nDo exactly one task, ${taskId}, then stop.\n1. Read AGENTS.md and ${HUB_NAME}/PROTOCOL.md.\n2. node ${HUB_NAME}/hub.mjs join --agent ${agentId} --role worker --tool cli --note "${taskId}"\n3. node ${HUB_NAME}/hub.mjs inbox --agent ${agentId}\n4. Read ${HUB_NAME}/tasks/${taskId}.md.\n5. node ${HUB_NAME}/hub.mjs claim ${taskId} --agent ${agentId} --files "<files>"\n6. Build it.\n7. ${defaultProofLines(agentId, taskId)}\n8. node ${HUB_NAME}/hub.mjs done ${taskId} --agent ${agentId} --summary "<summary>" --files "<files>" --verify "<cmd -> result>"\n9. node ${HUB_NAME}/hub.mjs leave --agent ${agentId}`;
}

function reviewPrompt(taskId, worktreePath) {
  const proj = projectName();
  const rootDir = worktreePath || getWorktreePath(taskId);
  const vars = { taskId, PROJECT: proj, root: rootDir, HUB_DIR: HUB_NAME };
  if (REVIEW_TMPL) return REVIEW_TMPL.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return `You are a read-only code reviewer for the ${proj} hub. Repo root: ${rootDir}. Do not edit any file.\n\nReview task ${taskId}:\n1. Read ${HUB_NAME}/tasks/${taskId}.md and its latest entry in ${HUB_NAME}/CHANGELOG.md.\n2. Read the changed files.\n3. Check requirements, serializable props, no hardcoded copy, tokens, reuse, server/client boundary, accessibility.\n4. Stop rule: if the brief has a "Rework" section, FAIL only for functional bug, accessibility failure or visible layout break. Else BACKLOG: and PASS.\n5. Final message: "VERDICT: PASS" or "VERDICT: FAIL", then at most 10 findings, then BACKLOG: lines.`;
}

// Health cache: one real "say HI" call per executor at most every HEALTH_TTL_MS, shared by every dispatch.
// Failures are cached for less time so a recovered quota is noticed quickly.
const HEALTH_FILE = path.join(RUNS, 'health.json');
const HEALTH_TTL_MS = 10 * 60_000;
const HEALTH_FAIL_TTL_MS = 5 * 60_000;

function maybeEmitResource(msg) {
  const stateFile = path.join(RUNS, 'resource-last.json');
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

function checkResources(isReview = false) {
  const freeMB = Math.round(os.freemem() / 1048576);
  const minMB = isReview ? (CFG.resources?.reviewMinFreeMB ?? 2048) : (CFG.resources?.buildMinFreeMB ?? 2048);
  if (freeMB < minMB) {
    const msg = `not dispatched: low memory (${freeMB} MB free)`;
    console.log(msg);
    maybeEmitResource(msg);
    process.exit(0);
  }

  let freeDiskGB = 999;
  try {
    const stats = fs.statfsSync(ROOT);
    freeDiskGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
  } catch {}
  const minDisk = CFG.resources?.minFreeDiskGB ?? 5;
  if (freeDiskGB < minDisk) {
    const msg = `not dispatched: low disk (${Math.round(freeDiskGB)} GB free)`;
    console.log(msg);
    maybeEmitResource(msg);
    process.exit(0);
  }
}

function checkHealth(name, fresh = false) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch {}
  const prev = cache[name];
  if (!fresh && prev && Date.now() - prev.at < (prev.ok ? HEALTH_TTL_MS : HEALTH_FAIL_TTL_MS)) return prev;
  const ex = EXECUTORS[name];
  if (!ex) return { ok: false, problem: 'UNKNOWN', at: Date.now() };
  const msg = 'Reply with exactly one short line: HI from <your model name>. Do not use any tools.';
  // Review-mode commands (codex) need a real output file, or the CLI rejects the empty path.
  const [cmd, args] = ex.build(msg, `health-${name}`, crypto.randomUUID(), { review: true, outFile: path.join(RUNS, `health-${name}.txt`) });
  const r = spawnSync(...run(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: (EXECUTOR_MAP[name]?.healthTimeoutSec ?? 90) * 1000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const hi = [...text.matchAll(/HI from[^"\\\n]*/gi)].map((m) => m[0]).find((h) => !h.includes('<your model name>'));
  const result = hi && r.status === 0
    ? { ok: true, model: hi.trim(), at: Date.now() }
    : { ok: false, problem: r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (diagnose(text) ?? 'FAILED'), at: Date.now(), detail: `${cmd} (cwd ${ROOT}) exit ${r.status}${r.error ? " " + r.error.code : ""}: ${text.replace(/s+/g, ' ').trim().slice(-240)}` };
  // Re-read just before writing: parallel checks would otherwise overwrite each other's results.
  try { cache = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch {}
  cache[name] = result;
  try { fs.writeFileSync(HEALTH_FILE, JSON.stringify(cache, null, 1)); } catch {}
  return result;
}

const [mode, ...argv] = process.argv.slice(2);

if (mode === '_runner') {
  runner(argv[0], argv[1], argv[2]);
} else if (mode === 'opencode-server') {
  if (serverUp()) { console.log(`opencode server already running at ${OPENCODE_URL}`); process.exit(0); }
  const log = fs.openSync(path.join(RUNS, 'opencode-server.log'), 'a');
  const child = spawn(...run('opencode', ['serve', '--port', '4096', '--hostname', '127.0.0.1'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true }));
  child.unref();
  console.log(`opencode server starting at ${OPENCODE_URL} (pid ${child.pid}). Watch every opencode job with: opencode attach ${OPENCODE_URL}`);
} else if (mode === 'ping') {
  const target = argv[0] ?? 'all';
  const names = target === 'all' ? Object.keys(EXECUTORS) : [target];
  const msg = 'Reply with exactly one short line: HI from <your model name>. Do not use any tools.';
  for (const name of names) {
    const ex = EXECUTORS[name];
    if (!ex) { console.log(`${name.padEnd(11)} UNKNOWN  (not in executors.json, or its launcher is missing)`); continue; }
    const [cmd, args] = ex.build(msg, `ping-${name}`, crypto.randomUUID(), { review: true, outFile: path.join(RUNS, 'ping-' + name + '.txt') });
    const r = spawnSync(...run(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // A real answer names a model; an echoed prompt (missing binary, shell error) still says "<your model name>".
    const hi = [...text.matchAll(/HI from[^"\\\n]*/gi)].map((m) => m[0]).find((h) => !h.includes('<your model name>'));
    const problem = r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : diagnose(text);
    if (hi && r.status === 0) console.log(`${name.padEnd(11)} OK      ${hi.trim()}`);
    else console.log(`${name.padEnd(11)} ${(problem ?? 'FAILED').padEnd(7)} ${EXECUTOR_MAP[name]?.restore ?? ''}`);
  }
} else if (mode === 'health') {
  // health [executor|all] [--fresh]: cached quota/health check used before every dispatch.
  const target = argv[0] ?? 'all';
  for (const name of target === 'all' ? Object.keys(EXECUTORS) : [target]) {
    const h = checkHealth(name, argv.includes('--fresh'));
    console.log(`${name.padEnd(18)} ${h.ok ? 'OK     ' : (h.problem ?? 'FAILED').padEnd(7)} checked ${Math.round((Date.now() - h.at) / 60000)}m ago`);
  }
} else if (mode === 'run') {
  // run <executor> <laneId|auto> <task> [task ...]
  // Several sessions of the same executor run side by side, each in its own lane (build dir + hub id).
  const [executor, laneArg, ...taskIds] = argv;
  if (!executor || !laneArg || !taskIds.length) throw new Error('usage: run <executor> <laneId|auto> <taskId> [taskId ...]');
  if (!enabled(executor)) throw new Error(`executor "${executor}" is not available (missing from executors.json or its launcher is missing)`);

  // Enforce Rule 0: Claude is strictly for ORCHESTRATION, never for execution/building tasks
  if (['claude', 'claude-cpa', 'claude-sonnet', 'claude-opus'].includes(executor)) {
    console.log(`[POLICY REJECTED] ${executor} is reserved exclusively for ORCHESTRATION, never for execution. Task ${taskIds.join(', ')} not dispatched.`);
    process.exit(1);
  }
  if (laneArg !== 'auto' && taskIds.length > 1) throw new Error('a fixed lane takes one task; use auto for several');
  // Shared board: when several machines work on this repo, a task runs only on the machine that
  // claimed it on GitHub first (board.mjs claim exits 3 when another machine owns it).
  if (CFG.board?.enabled) {
    for (const id of [...taskIds]) {
      const c = spawnSync(process.execPath, [path.join(HUB, 'board.mjs'), 'claim', id], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      if (c.status === 0) continue;
      console.log(`not dispatched: ${id} ${c.status === 3 ? (c.stdout.trim() || 'is owned by another machine') : `board claim failed: ${(c.stderr || c.stdout).trim().slice(0, 200)}`}`);
      taskIds.splice(taskIds.indexOf(id), 1);
    }
    if (!taskIds.length) process.exit(0);

    const tasksMap = localTasks();
    const areasRes = spawnSync(process.execPath, [path.join(HUB, 'board.mjs'), 'area', 'list', '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    let areas = [];
    try { areas = JSON.parse(areasRes.stdout); } catch {}

    for (const id of [...taskIds]) {
      const task = tasksMap[id];
      if (!task || !task.scope || !task.scope.length) continue;
      let blockedBy = null;
      for (const scopePath of task.scope) {
        for (const area of areas) {
          const areaNode = (area.node || '').toLowerCase();
          if (areaNode && areaNode !== NODE) {
            if (isInsideArea(scopePath, area.prefix)) {
              blockedBy = { node: areaNode, prefix: area.prefix };
              break;
            }
          }
        }
        if (blockedBy) break;
      }
      if (blockedBy) {
        console.log(`not dispatched: ${id} is in ${blockedBy.node}'s area ${blockedBy.prefix}`);
        try {
          spawnSync(process.execPath, [path.join(HUB, 'board.mjs'), 'note', id, `requesting handover for area ${blockedBy.prefix}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
        } catch {}
        taskIds.splice(taskIds.indexOf(id), 1);
      }
    }
    if (!taskIds.length) process.exit(0);
  }
  const budgets = CFG.dailyJobLimit ?? {};
  const group = Object.keys(budgets).find((g) => new RegExp(`^${g.replace('*', '.*')}$`).test(executor));
  if (group) {
    const today = new Date().toISOString().slice(0, 10);
    const used = readJobs().filter((j) => j.mode === 'run' && new RegExp(`^${group.replace('*', '.*')}$`).test(j.executor) && String(j.t).startsWith(today)).length;
    if (used >= budgets[group]) {
      console.log(`${executor} daily budget reached (${used}/${budgets[group]} jobs for ${group} today); ${taskIds.join(', ')} not dispatched.`);
      process.exit(0);
    }
  }
  const health = CFG.checkHealthBeforeDispatch ? checkHealth(executor) : { ok: true };
  if (!health.ok) {
    console.log(`${executor} health check ${health.problem ?? 'FAILED'}; ${taskIds.join(', ')} not dispatched.`);
    process.exit(0);
  }
  checkResources(false);
  const alive = alivePids();

  const migrationLockFile = path.join(RUNS, 'migration.lock');
  if (fs.existsSync(migrationLockFile)) {
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(migrationLockFile, 'utf8')); } catch {}
    if (lock) {
      const lockJob = readJobs().find((j) => j.taskId === lock.task || j.pid === lock.pid);
      const running = lockJob ? isLive(lockJob, alive) : alive.has(String(lock.pid));
      if (running) {
        console.log(`not dispatched: migration lock (${lock.task})`);
        process.exit(0);
      } else {
        try { fs.unlinkSync(migrationLockFile); } catch {}
      }
    }
  }

  const tasksMap = localTasks();
  const isMigrationDispatch = taskIds.some((id) => isMigration(tasksMap[id]));
  if (isMigrationDispatch) {
    const runningBuilds = readJobs().filter((j) => j.mode === 'run' && isLive(j, alive));
    if (runningBuilds.length > 0) {
      console.log(`not dispatched: migration requires zero running builds`);
      process.exit(0);
    }
  }

  const busy = new Set(readJobs().filter((j) => j.mode === 'run' && isLive(j, alive)).map((j) => j.agentId));
  // Only build sessions count toward the cap; reviews are short and read-only.
  const runningOf = (ex) => readJobs().filter((j) => j.mode === 'run' && j.executor === ex && isLive(j, alive)).length;
  for (const taskId of taskIds) {
    if (group && readJobs().filter((j) => j.mode === 'run' && new RegExp('^' + group.replace('*', '.*') + '$').test(j.executor) && String(j.t).startsWith(new Date().toISOString().slice(0, 10))).length >= budgets[group]) { console.log(executor + ' daily budget reached; ' + taskId + ' not dispatched.'); break; }
    if (runningOf(executor) >= maxSessions(executor)) {
      console.log(`${executor} already runs ${maxSessions(executor)} sessions (limit); ${taskId} not dispatched. Raise maxSessions or wait.`);
      break;
    }
    const agentId = laneArg === 'auto' ? freeLane(busy) : laneArg;
    if (!agentId) { console.log(`no free lane for ${taskId}; all lanes in tsconfig.json are busy`); break; }
    // Builds use .next-<agentId>; only ids listed in tsconfig.json include are safe, otherwise Next rewrites tsconfig.
    if (lanes().length && !lanes().includes(agentId)) throw new Error(`lane ${agentId} has no build dir in tsconfig.json include`);
    const worktreePath = ensureWorktree(taskId);
    let prompt;
    try { prompt = workerPrompt(agentId, taskId, worktreePath); } catch (error) { console.log('SKILLS ' + taskId + ' not dispatched: ' + error.message); continue; }
    if (busy.has(agentId)) { console.log(agentId + ' already busy; ' + taskId + ' not dispatched.'); continue; }
    // No live job holds this lane, so a hub session still joined under its id is stale: retire it or the new worker's join is refused.
    if (!busy.has(agentId)) hubCmd(['kick', agentId, '--note', 'stale lane session'], true);
    busy.add(agentId);
    // Fixed lanes reassign too, or a stale assignee makes the worker's claim fail.
    hubCmd(['assign', taskId, '--to', agentId]);
    const id = `${agentId}-${taskId}-${Date.now().toString(36)}`;
    const base = path.join(RUNS, id);
    fs.writeFileSync(`${base}.prompt.md`, prompt);
    const { pid, sessionId: sid } = launch(executor, `Read the file ${rel(base + '.prompt.md')} and follow its instructions exactly.`, base, { cwd: worktreePath });
    const job = { id, t: new Date().toISOString(), mode, executor, agentId, taskId, pid, sessionId: sid, log: rel(base + '.log') };
    record(job);
    if (isMigration(tasksMap[taskId])) {
      try {
        fs.writeFileSync(migrationLockFile, JSON.stringify({ task: taskId, pid, t: new Date().toISOString() }, null, 2));
      } catch {}
    }
    printJob(job, { status: 'STARTED', sid, problem: null });
  }
} else if (mode === 'review') {
  // Reviewers never edit: codex runs in its read-only sandbox, Claude-family CLIs lose their edit tools.
  const [taskId, executor = reviewOrder[0] ?? 'codex'] = argv;
  if (!taskId) throw new Error('usage: review <taskId> [executor]');
  if (['claude', 'claude-cpa', 'claude-sonnet', 'claude-opus'].includes(executor)) {
    console.log(`[POLICY REJECTED] ${executor} is reserved exclusively for ORCHESTRATION, never for execution/review.`);
    process.exit(1);
  }
  if (!reviewOrder.includes(executor)) throw new Error(`review runs on: ${reviewOrder.join(', ')}`);
  const alive = alivePids();
  const maxReviews = EXECUTOR_MAP[executor]?.maxReviews ?? 2;
  const liveReviews = readJobs().filter((j) => j.mode === 'review' && j.executor === executor && isLive(j, alive)).length;
  if (liveReviews >= maxReviews) { console.log(`${executor} already runs ${liveReviews} reviews (limit ${maxReviews}); ${taskId} not reviewed yet.`); process.exit(0); }
  checkResources(true);
  const worktreePath = CFG.worktrees?.enabled ? ensureWorktree(taskId) : ROOT;
  const id = `review-${taskId}-${Date.now().toString(36)}`;
  const base = path.join(RUNS, id);
  const out = `${base}.verdict.md`;
  fs.writeFileSync(`${base}.prompt.md`, reviewPrompt(taskId, worktreePath));
  const { pid, sessionId: sid } = launch(executor, `Read the file ${rel(base + '.prompt.md')} and follow its instructions exactly.`, base, { review: true, outFile: out, cwd: worktreePath });
  const job = { id, t: new Date().toISOString(), mode, executor, taskId, pid, sessionId: sid, log: rel(base + '.log'), out: rel(out) };
  record(job);
  printJob(job, { status: 'STARTED', sid: null, problem: null });
  console.log(`  verdict: ${job.out}`);
} else if (mode === 'lanes') {
  const alive = alivePids();
  const jobs = readJobs().filter((j) => j.mode === 'run' && isLive(j, alive));
  const busy = new Set(jobs.map((j) => j.agentId));
  const status = hubCmd(['status'], true).split('\n').find((l) => l.startsWith('agents:')) ?? '';
  for (const lane of lanes()) {
    const job = jobs.find((j) => j.agentId === lane);
    const manual = new RegExp(`${lane}\\((?![^)]*STALE)`).test(status) && !job;
    console.log(`${lane.padEnd(11)} ${job ? `busy: ${job.executor} on ${job.taskId}` : manual ? 'busy: live hub session' : 'free'}`);
  }
  for (const ex of Object.keys(EXECUTORS)) {
    const n = jobs.filter((j) => j.executor === ex).length;
    if (n) console.log(`${ex}: ${n}/${maxSessions(ex)} sessions running`);
  }
} else if (mode === 'list') {
  const alive = alivePids();
  updateDurations(alive);
  const jobs = argv.includes('--all') ? readJobs() : readJobs().slice(-20);
  if (!jobs.length) console.log('no jobs yet');
  for (const job of jobs) printJob(job, jobStatus(job, alive));
} else if (mode === 'is-migration') {
  const fixtures = [
    { id: 'F1', phase: 'migration', scope: ['src/index.ts'] },
    { id: 'F2', phase: 'build', scope: ['drizzle/0001_init.sql'] },
    { id: 'F3', phase: 'build', scope: ['src/components/Card.tsx'] },
    { id: 'F4', phase: 'chore', scope: ['migrations/2026_01_01.sql'] },
    { id: 'F5', phase: 'build', scope: ['db/migrations/001.js'] },
  ];
  for (const f of fixtures) {
    console.log(`Task ${f.id} (phase: ${f.phase}, scope: ${f.scope.join(', ')}) => isMigration: ${isMigration(f)}`);
  }
} else {
  console.log('usage: health [executor|all] [--fresh] | ping [executor|all] | run <executor> <lane|auto> <task...> | review <taskId> [executor] | list [--all] | lanes | opencode-server | is-migration');
}
