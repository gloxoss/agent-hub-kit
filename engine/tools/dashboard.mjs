#!/usr/bin/env node
// Data collector and live renderer for dashboard: aggregates running jobs, review queue, accepts,
// account quotas, manager ledger, builder usage, and driver status.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { fold } from '../fold.mjs';
import { help } from './runtime.mjs';

help('usage: dashboard.mjs [--once] [--test] [hubDir]');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function getAlivePids() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
      return new Set([...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => m[1]));
    }
    const out = execSync('ps -e -o pid=', { encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function collect(hubDir) {
  const resolvedHub = path.resolve(hubDir);
  const runsDir = path.join(resolvedHub, 'runs');

  // 1. Running jobs from runs/jobs.jsonl
  const jobsFile = path.join(runsDir, 'jobs.jsonl');
  const allJobs = readJsonl(jobsFile);
  const alivePids = getAlivePids();
  const now = Date.now();

  const runningJobs = allJobs.filter((j) => {
    const logPath = path.join(runsDir, `${j.id}.log`);
    let logText = '';
    try { logText = fs.readFileSync(logPath, 'utf8'); } catch {}
    if (logText.includes('[dispatch] exit')) return false;
    if (j.pid && alivePids.has(String(j.pid))) return true;
    // A job with no live process is not running, whatever its log says (old runs lost their exit line in restarts).
    if (j.pid) return false;
    try {
      const mtime = fs.statSync(logPath).mtimeMs;
      if (now - mtime < 120_000) return true;
    } catch {}
    if (now - new Date(j.t || now).getTime() < 12 * 3600_000 && !logText.includes('[dispatch] exit')) {
      return true;
    }
    return false;
  }).map((j) => ({
    lane: j.lane ?? j.executor ?? 'unknown',
    executor: j.executor ?? 'unknown',
    task: j.taskId ?? j.task ?? 'unknown',
    minutes: Math.round((now - new Date(j.t || now).getTime()) / 60000)
  }));

  // 2. Review queue and last 5 accepts from the hub fold
  const eventsFile = path.join(resolvedHub, 'events.jsonl');
  const events = readJsonl(eventsFile);
  const folded = fold(events);
  const reviewQueue = Object.values(folded.tasks || {}).filter((t) => t.status === 'REVIEW' || t.status === 'VERIFIED');

  const acceptEvents = events.filter((e) => e.type === 'accept');
  const acceptedTasks = Object.values(folded.tasks || {})
    .filter((t) => t.status === 'ACCEPTED')
    .sort((a, b) => new Date(b.acceptedAt || 0) - new Date(a.acceptedAt || 0))
    .slice(0, 5);

  const lastAccepts = acceptedTasks.length ? acceptedTasks : acceptEvents.slice(-5).reverse();

  // 3. Allowance per account from runs/quota-cache.json
  const quotaFile = path.join(runsDir, 'quota-cache.json');
  const quotas = readJson(quotaFile, {});

  // 4. Manager turns/tokens/cost today from runs/orch-ledger.jsonl
  const ledgerFile = path.join(runsDir, 'orch-ledger.jsonl');
  const ledgerEntries = readJsonl(ledgerFile);
  const today = new Date().toISOString().slice(0, 10);

  let managerTurns = 0;
  let managerInput = 0;
  let managerOutput = 0;
  let managerTotal = 0;
  let managerCost = 0;

  for (const entry of ledgerEntries) {
    const ts = entry.timestamp || entry.t || '';
    if (!ts || ts.startsWith(today) || process.env.TEST_DASHBOARD) {
      managerTurns++;
      const usage = entry.usage || entry.tokenUsage || entry;
      const inp = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
      const out = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0);
      const tot = Number(usage.total_tokens ?? usage.totalTokens ?? (inp + out));
      managerInput += inp;
      managerOutput += out;
      managerTotal += tot;
      if (typeof entry.cost === 'number') managerCost += entry.cost;
    }
  }

  const manager = {
    turns: managerTurns,
    tokens: { input: managerInput, output: managerOutput, total: managerTotal },
    cost: managerCost
  };

  // 5. Builder usage per lane today (jobs count, and tokens when the job log contains a usage event)
  const builderUsage = {};
  for (const j of allJobs) {
    const ts = j.t || '';
    if (ts && !ts.startsWith(today) && !process.env.TEST_DASHBOARD) continue;

    const lane = j.lane ?? j.executor ?? 'unknown';
    if (!builderUsage[lane]) {
      builderUsage[lane] = { jobsCount: 0, tokens: { input: 0, output: 0, total: 0 } };
    }
    builderUsage[lane].jobsCount++;

    const logPath = path.join(runsDir, `${j.id}.log`);
    if (fs.existsSync(logPath)) {
      try {
        const logContent = fs.readFileSync(logPath, 'utf8');
        for (const line of logContent.split('\n')) {
          if (line.includes('usage') || line.includes('modelUsage')) {
            try {
              const obj = JSON.parse(line.trim());
              const u = obj.usage || obj.modelUsage;
              if (u) {
                builderUsage[lane].tokens.input += Number(u.input_tokens || u.prompt_tokens || 0);
                builderUsage[lane].tokens.output += Number(u.output_tokens || u.completion_tokens || 0);
                builderUsage[lane].tokens.total += Number(u.total_tokens || ((u.input_tokens || u.prompt_tokens || 0) + (u.output_tokens || u.completion_tokens || 0)));
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  // 6. Who is on duty from orch-driver.json
  const driverFile = path.join(resolvedHub, 'orch-driver.json');
  const driverData = readJson(driverFile, {});
  const onDuty = driverData.current || driverData.onDuty || null;

  return {
    runningJobs,
    reviewQueue,
    lastAccepts,
    quotas,
    manager,
    builderUsage,
    onDuty
  };
}

export function formatDashboard(data, columns = 80, useColor = true) {
  const c = (code, text) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

  const lines = [];
  const width = Math.max(columns, 40);

  const title = ' SchoolOS Agent Hub Dashboard ';
  const timeStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const headerLine = `[ ${timeStr} ] On Duty: ${data.onDuty || 'none'}`;
  lines.push(c('1;36', title) + ' ' + c('2', headerLine));
  lines.push('='.repeat(Math.min(width, 100)));

  // Panel 1: Running Jobs
  lines.push(c('1;33', '--- Running Jobs ---'));
  if (data.runningJobs.length === 0) {
    lines.push(c('2', '  (no active jobs)'));
  } else {
    for (const j of data.runningJobs) {
      lines.push(`  Lane: ${c('32', j.lane)} | Executor: ${j.executor} | Task: ${c('1', j.task)} | Running: ${j.minutes}m`);
    }
  }

  // Panel 2: Review Queue & Recent Accepts
  lines.push(c('1;33', '--- Review Queue ---'));
  if (data.reviewQueue.length === 0) {
    lines.push(c('2', '  (review queue empty)'));
  } else {
    for (const t of data.reviewQueue) {
      lines.push(`  [${t.status}] ${c('1', t.id)}: ${t.title || ''} (assignee: ${t.assignee || 'none'})`);
    }
  }

  lines.push(c('1;33', '--- Recent Accepts ---'));
  const accepts = data.lastAccepts || [];
  if (accepts.length === 0) {
    lines.push(c('2', '  (no recent accepts)'));
  } else {
    for (const a of accepts) {
      const id = a.id || a.taskId || 'unknown';
      const title = a.title || '';
      lines.push(`  [ACCEPTED] ${c('32', id)} ${title}`);
    }
  }

  // Panel 3: Account Quotas
  lines.push(c('1;33', '--- Account Quotas ---'));
  const quotas = data.quotas || {};
  if (Object.keys(quotas).length === 0) {
    lines.push(c('2', '  (no quota data cached)'));
  } else {
    // The cache is a list of rows {provider, account, remaining, models:{pool:{remaining}}}; older caches were keyed objects.
    const rows = Array.isArray(quotas) ? quotas : Object.entries(quotas).map(([account, v]) => ({ account, ...v }));
    const colour = (rem) => (rem <= 0 ? '31' : rem <= 0.2 ? '33' : '32');
    const pct = (rem) => `${Math.round((rem ?? 0) * 100)}%`;
    for (const r of rows.slice(0, 24)) {
      const name = String(r.account ?? '?').split('@')[0].slice(0, 22);
      const pools = Object.entries(r.models ?? {}).map(([pool, m]) => `${pool.split(' ')[0]} ${c(colour(m.remaining ?? 0), pct(m.remaining))}`).join('  ');
      lines.push(`  ${name.padEnd(22)} ${pools || c(colour(r.remaining ?? 1), pct(r.remaining ?? 1))}`);
    }
    if (rows.length > 24) lines.push(c('2', `  ... and ${rows.length - 24} more accounts`));
  }

  // Panel 4: Manager & Builder Usage Today
  lines.push(c('1;33', '--- Manager & Builder Usage (Today) ---'));
  const mgr = data.manager || {};
  const tokens = mgr.tokens || {};
  lines.push(`  Manager Turns: ${mgr.turns} | Tokens: in ${tokens.input || 0}, out ${tokens.output || 0}, total ${tokens.total || 0} | Cost: $${(mgr.cost || 0).toFixed(4)}`);

  const bUsage = data.builderUsage || {};
  if (Object.keys(bUsage).length === 0) {
    lines.push(c('2', '  (no builder usage today)'));
  } else {
    for (const [lane, usage] of Object.entries(bUsage)) {
      const ut = usage.tokens || {};
      lines.push(`  Lane ${c('36', lane)}: ${usage.jobsCount} jobs | Tokens: in ${ut.input || 0}, out ${ut.output || 0}, total ${ut.total || 0}`);
    }
  }

  lines.push('='.repeat(Math.min(width, 100)));
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const isTest = process.argv.includes('--test');
  const isOnce = process.argv.includes('--once');
  const hubArg = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '.agent-hub-orch';

  if (isTest) {
    process.env.TEST_DASHBOARD = '1';
    const tmpHub = fs.mkdtempSync(path.join(process.cwd(), '.dashboard-test-'));
    fs.mkdirSync(path.join(tmpHub, 'runs'), { recursive: true });

    fs.writeFileSync(path.join(tmpHub, 'runs', 'jobs.jsonl'), JSON.stringify({ id: 'job-1', lane: 'builder-1', executor: 'opencode', taskId: 'S-11-01', t: new Date().toISOString(), pid: process.pid }) + '\n');
    fs.writeFileSync(path.join(tmpHub, 'runs', 'job-1.log'), 'some log output\n{"usage": {"input_tokens": 500, "output_tokens": 100, "total_tokens": 600}}\n');
    fs.writeFileSync(path.join(tmpHub, 'events.jsonl'), JSON.stringify({ t: new Date().toISOString(), type: 'task-add', id: 'S-11-01', phase: 'build', title: 'Data collector' }) + '\n' +
      JSON.stringify({ t: new Date().toISOString(), type: 'done', agent: 'builder-1', id: 'S-11-01', summary: 'done', files: [] }) + '\n');
    fs.writeFileSync(path.join(tmpHub, 'runs', 'quota-cache.json'), JSON.stringify({ 'account-1': { remaining: 0.8 } }));
    fs.writeFileSync(path.join(tmpHub, 'runs', 'orch-ledger.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }, cost: 0.05 }) + '\n');
    fs.writeFileSync(path.join(tmpHub, 'orch-driver.json'), JSON.stringify({ current: 'claude-sonnet' }));

    const res = collect(tmpHub);
    console.log(JSON.stringify(res, null, 2));
    fs.rmSync(tmpHub, { recursive: true, force: true });
  } else if (isOnce || !process.stdout.isTTY) {
    const data = collect(hubArg);
    const cols = process.stdout.columns || 80;
    const output = formatDashboard(data, cols, process.stdout.isTTY && !isOnce);
    console.log(output);
  } else {
    // Interactive live mode
    const cols = process.stdout.columns || 80;

    // Enter alternate screen and hide cursor
    process.stdout.write('\x1b[?1049h\x1b[?25l');

    function draw() {
      const c = process.stdout.columns || 80;
      const data = collect(hubArg);
      const text = formatDashboard(data, c, true);
      process.stdout.write('\x1b[H\x1b[2J' + text);
    }

    draw();

    const timer = setInterval(draw, 2000);

    const resizeHandler = () => {
      draw();
    };
    process.stdout.on('resize', resizeHandler);

    function cleanup() {
      clearInterval(timer);
      process.stdout.removeListener('resize', resizeHandler);
      // Restore cursor and normal screen
      process.stdout.write('\x1b[?25h\x1b[?1049l\r\n');
      process.exit(0);
    }

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }
}
