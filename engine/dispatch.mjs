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

const HUB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HUB);
const HUB_NAME = path.basename(HUB);
const RUNS = path.join(HUB, 'runs');
const JOBS = path.join(RUNS, 'jobs.jsonl');
const OPENCODE_URL = 'http://127.0.0.1:4096';
const RECENT_MS = 120_000;
fs.mkdirSync(RUNS, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const CFG = readJson(path.join(HUB, 'config.json'), {});
const TABLE = readJson(path.join(HUB, 'executors.json'), { executors: [] });
const ALL_DEFS = Array.isArray(TABLE) ? TABLE : (TABLE.executors ?? []);

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
    restore: def.restore ?? '',
  };
}

const EXECUTORS = Object.fromEntries(EXECUTOR_DEFS.map((d) => [d.name, makeExecutor(d)]));
const maxSessions = (ex) => EXECUTOR_MAP[ex]?.maxSessions ?? 2;
const buildOrder = (Array.isArray(TABLE.buildOrder) ? TABLE.buildOrder : EXECUTOR_DEFS.map((d) => d.name)).filter(enabled);
const reviewOrder = (Array.isArray(TABLE.reviewOrder) ? TABLE.reviewOrder : EXECUTOR_DEFS.map((d) => d.name))
  .filter((n) => enabled(n) && ['reviewer', 'both'].includes(EXECUTOR_MAP[n].kind));

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
  try {
    const ts = fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8');
    return [...new Set([...ts.matchAll(/\.next-(builder-\d+)\/types/g)].map((m) => m[1]))].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  } catch { return []; }
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
  const r = spawnSync(process.execPath, [path.join(HUB, 'hub.mjs'), ...args, '--agent', 'orchestrator'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && !quiet) throw new Error(`hub ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout ?? '';
}

function serverUp() {
  try { return execSync('netstat -ano', { encoding: 'utf8' }).split('\n').some((l) => l.includes(':4096 ') && l.includes('LISTEN')); } catch { return false; }
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

function launch(executor, message, base, opts = {}) {
  const ex = EXECUTORS[executor];
  if (!ex) throw new Error(`unknown executor "${executor}". Known: ${Object.keys(EXECUTORS).join(', ')}`);
  const sid = crypto.randomUUID();
  const [cmd, args] = ex.build(message, path.basename(base), sid, opts);
  // On Windows these CLIs write nothing when a file is attached directly as their stdout, but they do
  // write to a pipe. So a detached runner (this script, mode _runner) owns the pipe and streams to the log.
  // Codex writes the verdict file itself; for other reviewers the runner extracts it from the final result.
  const verdictArg = opts.outFile && executor !== 'codex' ? [opts.outFile] : [];
  const runner = spawn(process.execPath, [fileURLToPath(import.meta.url), '_runner', `${base}.log`, JSON.stringify([cmd, args]), ...verdictArg], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  runner.unref();
  return { pid: runner.pid, sessionId: args.includes('--session-id') ? sid : null };
}

// Runs one executor with stdin closed (several CLIs wait for piped input and hang otherwise) and
// appends its stdout and stderr to the log as they arrive, then an exit marker.
function runner(logFile, spec, verdictFile) {
  const [cmd, args] = JSON.parse(spec);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(...run(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
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
}

function jobStatus(job, alive) {
  const logPath = path.join(ROOT, job.log);
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const running = isLive(job, alive);
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

function workerPrompt(agentId, taskId) {
  const proj = projectName();
  const skills = stageSkills(taskId);
  const vars = { agentId, taskId, PROJECT: proj, root: ROOT, HUB_DIR: HUB_NAME, proofLines: defaultProofLines(agentId, taskId), skills };
  if (WORKER_TMPL) return WORKER_TMPL.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  // Inline fallback if template is missing.
  return `You are ${agentId}, a worker in the ${proj} agent hub. Repo root: ${ROOT}. Run every command from there.\n\nDo exactly one task, ${taskId}, then stop.\n1. Read AGENTS.md and ${HUB_NAME}/PROTOCOL.md.\n2. node ${HUB_NAME}/hub.mjs join --agent ${agentId} --role worker --tool cli --note "${taskId}"\n3. node ${HUB_NAME}/hub.mjs inbox --agent ${agentId}\n4. Read ${HUB_NAME}/tasks/${taskId}.md.\n5. node ${HUB_NAME}/hub.mjs claim ${taskId} --agent ${agentId} --files "<files>"\n6. Build it.\n7. ${defaultProofLines(agentId, taskId)}\n8. node ${HUB_NAME}/hub.mjs done ${taskId} --agent ${agentId} --summary "<summary>" --files "<files>" --verify "<cmd -> result>"\n9. node ${HUB_NAME}/hub.mjs leave --agent ${agentId}`;
}

function reviewPrompt(taskId) {
  const proj = projectName();
  const vars = { taskId, PROJECT: proj, root: ROOT, HUB_DIR: HUB_NAME };
  if (REVIEW_TMPL) return REVIEW_TMPL.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return `You are a read-only code reviewer for the ${proj} hub. Repo root: ${ROOT}. Do not edit any file.\n\nReview task ${taskId}:\n1. Read ${HUB_NAME}/tasks/${taskId}.md and its latest entry in ${HUB_NAME}/CHANGELOG.md.\n2. Read the changed files.\n3. Check requirements, serializable props, no hardcoded copy, tokens, reuse, server/client boundary, accessibility.\n4. Stop rule: if the brief has a "Rework" section, FAIL only for functional bug, accessibility failure or visible layout break. Else BACKLOG: and PASS.\n5. Final message: "VERDICT: PASS" or "VERDICT: FAIL", then at most 10 findings, then BACKLOG: lines.`;
}

// Health cache: one real "say HI" call per executor at most every HEALTH_TTL_MS, shared by every dispatch.
// Failures are cached for less time so a recovered quota is noticed quickly.
const HEALTH_FILE = path.join(RUNS, 'health.json');
const HEALTH_TTL_MS = 10 * 60_000;
const HEALTH_FAIL_TTL_MS = 5 * 60_000;
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
    : { ok: false, problem: r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (diagnose(text) ?? 'FAILED'), at: Date.now() };
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
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < (CFG.resources?.buildMinFreeMB ?? 0)) { console.log(`only ${freeMB} MB RAM free (below configured build floor); ${taskIds.join(', ')} not dispatched.`); process.exit(0); }
  const alive = alivePids();
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
    let prompt;
    try { prompt = workerPrompt(agentId, taskId); } catch (error) { console.log('SKILLS ' + taskId + ' not dispatched: ' + error.message); continue; }
    if (busy.has(agentId)) { console.log(agentId + ' already busy; ' + taskId + ' not dispatched.'); continue; }
    // No live job holds this lane, so a hub session still joined under its id is stale: retire it or the new worker's join is refused.
    if (!busy.has(agentId)) hubCmd(['kick', agentId, '--note', 'stale lane session'], true);
    busy.add(agentId);
    // Fixed lanes reassign too, or a stale assignee makes the worker's claim fail.
    hubCmd(['assign', taskId, '--to', agentId]);
    const id = `${agentId}-${taskId}-${Date.now().toString(36)}`;
    const base = path.join(RUNS, id);
    fs.writeFileSync(`${base}.prompt.md`, prompt);
    const { pid, sessionId: sid } = launch(executor, `Read the file ${rel(base + '.prompt.md')} and follow its instructions exactly.`, base);
    const job = { id, t: new Date().toISOString(), mode, executor, agentId, taskId, pid, sessionId: sid, log: rel(base + '.log') };
    record(job);
    printJob(job, { status: 'STARTED', sid, problem: null });
  }
} else if (mode === 'review') {
  // Reviewers never edit: codex runs in its read-only sandbox, Claude-family CLIs lose their edit tools.
  const [taskId, executor = reviewOrder[0] ?? 'codex'] = argv;
  if (!taskId) throw new Error('usage: review <taskId> [executor]');
  if (!reviewOrder.includes(executor)) throw new Error(`review runs on: ${reviewOrder.join(', ')}`);
  const alive = alivePids();
  const maxReviews = EXECUTOR_MAP[executor]?.maxReviews ?? 2;
  const liveReviews = readJobs().filter((j) => j.mode === 'review' && j.executor === executor && isLive(j, alive)).length;
  if (liveReviews >= maxReviews) { console.log(`${executor} already runs ${liveReviews} reviews (limit ${maxReviews}); ${taskId} not reviewed yet.`); process.exit(0); }
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < (CFG.resources?.reviewMinFreeMB ?? 0)) { console.log(`only ${freeMB} MB RAM free (below configured review floor); review of ${taskId} waits.`); process.exit(0); }
  const id = `review-${taskId}-${Date.now().toString(36)}`;
  const base = path.join(RUNS, id);
  const out = `${base}.verdict.md`;
  fs.writeFileSync(`${base}.prompt.md`, reviewPrompt(taskId));
  const { pid, sessionId: sid } = launch(executor, `Read the file ${rel(base + '.prompt.md')} and follow its instructions exactly.`, base, { review: true, outFile: out });
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
  const jobs = argv.includes('--all') ? readJobs() : readJobs().slice(-20);
  if (!jobs.length) console.log('no jobs yet');
  for (const job of jobs) printJob(job, jobStatus(job, alive));
} else {
  console.log('usage: health [executor|all] [--fresh] | ping [executor|all] | run <executor> <lane|auto> <task...> | review <taskId> [executor] | list [--all] | lanes | opencode-server');
}
