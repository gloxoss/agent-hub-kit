#!/usr/bin/env node
// Orchestrator driver: lets any agent CLI be the project's orchestrator, with failover.
// Watches hub autoloop and user WhatsApp replies, manages failovers, quota detection, and steering.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 1. Auto-load vault environment variables
const VAULT_ENV = path.join(os.homedir(), '.config', 'devbox', 'vault', 'env');
if (fs.existsSync(VAULT_ENV)) {
  try {
    const lines = fs.readFileSync(VAULT_ENV, 'utf8').split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('usage: node orch-driver.mjs [repoDir] [--order a,b,c] [--no-autoloop] [--say "message"] [--cmd "status|quotas|use <entry>|order a,b|pause|resume|reset|models"]');
  process.exit(0);
}
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const orderArg = opt('--order');
const sayOnce = opt('--say');
const cmdOnce = opt('--cmd');
const withAutoloop = !argv.includes('--no-autoloop');
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const HUB = ['.agent-hub-orch', '.agent-hub', '.hub'].map((d) => path.join(ROOT, d)).find((d) => fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'BOARD.md')));
if (!HUB) { console.error(`no hub in ${ROOT}: run agentify first`); process.exit(1); }
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYBOOK = path.join(KIT, 'engine', 'ORCHESTRATOR.md');
const REPO = path.basename(ROOT);
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')).orchestrator ?? {}; } catch { return {}; }
})();

// Exact user-specified failover order:
// 1. claude-sonnet -> 2. codex -> 3. cursor -> 4. claude-ds1 -> 5. claude-ag2@claude-sonnet-4-6 -> 6. claude-ag2@gemini-3-flash
const DEFAULT_ORDER = [
  'claude-sonnet',
  'claude-cpa@claude-sonnet-5-5',
  'codex',
  'cursor',
  'claude-cpa@grok-4.7',
  'claude-ds1',
  'claude-ag2@claude-sonnet-4-6',
  'claude-ag2@gemini-3-flash'
];

const BASE_ORDER = (orderArg?.split(',') ?? CFG.order ?? DEFAULT_ORDER).map((s) => s.trim()).filter(Boolean);
const CONTROL = path.join(HUB, 'orch-control.json');
const control = () => { try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return {}; } };
const setControl = (patch) => fs.writeFileSync(CONTROL, JSON.stringify({ ...control(), ...patch }, null, 2));
const order = () => control().order ?? BASE_ORDER;

const BATCH_MS = (CFG.batchSeconds ?? 20) * 1000;
const IDLE_MS = (CFG.idleMinutes ?? 60) * 60_000;
const DOWN_MS = (CFG.downMinutes ?? 120) * 60_000;          // 2 hour cooldown for real quota exhaustion
const SHORT_DOWN_MS = (CFG.shortDownMinutes ?? 3) * 60_000;  // 3 min cooldown for transient responding errors
const TURN_MS = (CFG.turnMinutes ?? 30) * 60_000;
const SILENCE_MS = (CFG.silenceMinutes ?? 3) * 60_000;      // 3 min maximum silence watchdog
const STATE = path.join(HUB, 'orch-driver.json');
const LOG = path.join(HUB, 'runs', 'orchestrator.log');
const WA = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');

const ICONS = {
  eye: '\u{1F441}\u{FE0F}',
  alarm: '\u{1F6A8}',
  lightning: '\u{26A1}',
  hourglass: '\u{23F3}',
  bullet: '\u{2022}',
  check: '\u{2705}',
  stop: '\u{26D4}',
  pause: '\u{23F8}\u{FE0F}',
  warning: '\u{26A0}\u{FE0F}'
};

// Strict regex distinguishing true quota exhaustion from transient network/responding errors
const QUOTA_LIMIT = /(?:usage_limit|rate_limit|rate limit reached|usage limit reached|credit balance is too low|insufficient_quota|exceeded your current quota|account quota exceeded|all \d+ accounts 0% quota|\b429\b|\b402\b|upgrade to plus|quota exceeded)/i;

try {
  const ex = path.join(ROOT, '.git', 'info', 'exclude');
  for (const file of [STATE, CONTROL]) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (fs.existsSync(ex) && !fs.readFileSync(ex, 'utf8').includes(rel)) fs.appendFileSync(ex, `\n${rel}\n`);
  }
} catch {}

const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sessions: {}, until: {} }; } })();
if (!st.until) st.until = {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const log = (s) => { const line = `${new Date().toISOString().slice(5, 19)} ${s}`; console.log(line); fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); };
const notify = (text) => fs.existsSync(WA) && spawn(process.execPath, [WA, 'send', text], { cwd: ROOT, stdio: 'ignore', windowsHide: true });

const healthy = (agent) => !st.until[agent] || st.until[agent] < Date.now();
const until = (agent) => new Date(st.until[agent]).toTimeString().slice(0, 5);

// Real-time proxy quota check helper
async function checkProxyQuota(agent, timeoutMs = 3500) {
  const [name, model] = agent.split('@');
  if (name === 'claude-cpa' || name.startsWith('cpa-')) {
    const targetModel = model || 'claude-sonnet-5-5';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch('http://127.0.0.1:8317/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-cliproxyapi-local', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: targetModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
      });
      clearTimeout(t);
      if (res.ok) return { ok: true };
      const isQ = res.status === 429 || res.status === 402;
      return { ok: false, reason: `HTTP ${res.status}`, isQuota: isQ };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'probe timeout (>3.5s)' : e.message, isQuota: false };
    }
  }

  if (name.startsWith('claude-ag') || name.startsWith('ag-')) {
    const targetModel = model || 'claude-sonnet-4-6';
    try {
      const res = await fetch('http://127.0.0.1:8080/account-limits', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        const accounts = data.accounts || [];
        let available = 0;
        let earliestReset = null;
        for (const a of accounts) {
          const lim = a.limits?.[targetModel];
          const rateLim = a.modelRateLimits?.[targetModel];
          const isLimited = rateLim?.isRateLimited || lim?.remainingFraction === 0;
          if (!isLimited) available++;
          else if (lim?.resetTime) {
            const rt = new Date(lim.resetTime);
            if (!earliestReset || rt < earliestReset) earliestReset = rt;
          }
        }
        if (available === 0 && accounts.length > 0) {
          return { isQuota: true, reason: `all ${accounts.length} accounts 0% quota`, resetTime: earliestReset?.getTime() };
        }
        return { isQuota: false, available };
      }
    } catch {}
  }
  return { isQuota: false };
}

// Fast Preflight Probe: test if model API is alive before allocating heavy turn
async function pingAgent(agent, timeoutMs = 3500) {
  const [name, model] = agent.split('@');

  // Fast check: check proxy limits first
  const proxyCheck = await checkProxyQuota(agent);
  if (proxyCheck.isQuota) {
    return { ok: false, reason: proxyCheck.reason, isQuota: true, resetTime: proxyCheck.resetTime };
  }

  if (name === 'claude-sonnet' || name === 'claude') {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { ok: false, reason: 'CLAUDE_CODE_OAUTH_TOKEN missing in vault', isQuota: false };
    }
    return { ok: true };
  }

  if (name === 'codex') {
    // Probe codex quickly
    try {
      const probe = spawnSync('codex', ['exec', '--skip-git-repo-check', 'ping'], {
        timeout: 3500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const combined = (probe.stdout || '') + (probe.stderr || '');
      if (QUOTA_LIMIT.test(combined)) {
        return { ok: false, reason: 'Codex usage limit reached', isQuota: true };
      }
      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  if (name === 'cursor' || name === 'cursor-agent') {
    return { ok: true };
  }

  if (name === 'claude-ds1') {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (res.status === 402) return { ok: false, reason: 'DeepSeek insufficient balance', isQuota: true };
      if (res.ok) return { ok: true };
      return { ok: false, reason: `DeepSeek HTTP ${res.status}`, isQuota: res.status === 402 || res.status === 429 };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'probe timeout (>3.5s)' : e.message, isQuota: false };
    }
  }

  if (name === 'claude-cpa' || name.startsWith('cpa-')) {
    const targetModel = model || 'claude-sonnet-5-5';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch('http://127.0.0.1:8317/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-cliproxyapi-local', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: targetModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
      });
      clearTimeout(t);
      if (res.ok) return { ok: true };
      const isQ = res.status === 429 || res.status === 402;
      return { ok: false, reason: `HTTP ${res.status}`, isQuota: isQ };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'probe timeout (>3.5s)' : e.message, isQuota: false };
    }
  }

  if (name.startsWith('claude-ag') || name.startsWith('ag-')) {
    const targetModel = model || 'claude-sonnet-4-6';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch('http://127.0.0.1:8080/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: targetModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
      });
      clearTimeout(t);
      if (res.ok) return { ok: true };
      const isQ = res.status === 429 || res.status === 402;
      return { ok: false, reason: `HTTP ${res.status}`, isQuota: isQ };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'probe timeout (>3.5s)' : e.message, isQuota: false };
    }
  }

  return { ok: true };
}

const downFor = (r, isQuota) => {
  // 429 rate-limits (RPM / per-minute token spikes) should cool down for 2 minutes, not 2 hours!
  if (/\b429\b|too many requests|rate.?limit/i.test(r.out) && !/all \d+ accounts 0%|quota exhausted/i.test(r.out)) {
    return 2 * 60_000;
  }
  if (!isQuota) return SHORT_DOWN_MS; // 3 min only for transient responding glitches
  const t = r.out?.match(/resets? (\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/i)?.[1];
  if (t) {
    const now = new Date();
    const d = new Date(now);
    const [, h, m, ap] = t.match(/(\d{1,2})(?::(\d\d))?\s*(am|pm)?/i) ?? [];
    if (h) {
      let hr = parseInt(h, 10);
      if (ap && ap.toLowerCase() === 'pm' && hr < 12) hr += 12;
      if (ap && ap.toLowerCase() === 'am' && hr === 12) hr = 0;
      d.setHours(hr, parseInt(m ?? '0', 10), 0, 0);
      if (d < now) d.setDate(d.getDate() + 1);
      return Math.max(d - now, 60_000);
    }
  }
  const minMatch = r.out?.match(/resets? (?:in|after) (\d+)\s*m/i);
  if (minMatch) return parseInt(minMatch[1], 10) * 60_000;
  return DOWN_MS;
};

function command(entry, prompt, sid) {
  const [agent, model] = entry.split('@');
  const mFlag = model ? ['--model', model] : [];

  if (agent === 'claude' || agent === 'claude-sonnet') {
    return [path.join(os.homedir(), '.local', 'bin', 'claude'), [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      ...mFlag,
      ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])
    ]];
  }
  if (agent === 'cursor-agent' || agent === 'cursor') {
    return ['cursor-agent', ['-p', '--force', '--output-format', 'stream-json', prompt]];
  }
  if (agent.startsWith('codex')) {
    return ['codex', [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      prompt,
      ...(sid ? ['--resume', sid] : [])
    ]];
  }
  if (agent === 'claude-ds1') {
    return [path.join(os.homedir(), '.claude-launchers', 'claude-ds1'), [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])
    ]];
  }
  if (agent === 'claude-cpa' || agent.startsWith('cpa-')) {
    return [path.join(os.homedir(), '.claude-launchers', 'claude-cpa'), [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      ...mFlag,
      ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])
    ]];
  }
  if (agent.startsWith('claude-ag') || agent.startsWith('ag-')) {
    return [path.join(os.homedir(), '.claude-launchers', 'claude-ag2'), [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      ...mFlag,
      ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])
    ]];
  }
  return [agent, ['-p', prompt, ...mFlag, ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])]];
}

const sessionFrom = (entry, out) => {
  const agent = entry.split('@')[0];
  if (agent.startsWith('codex')) return out.match(/session id:\s*([0-9a-f-]{36})/i)?.[1];
  return st.pending;
};

function resolveLane(raw) {
  if (!raw) return '';
  let str = raw.replace(/\\(["'])/g, '$1').replace(/\\/g, '').trim();

  let modelFlag = null;
  const modelMatch = str.match(/(?:--?model|-m|\bmodel)\s*(?:=|\s+)\s*["']?\s*([^"'\s]+)\s*["']?/i);
  if (modelMatch) {
    modelFlag = modelMatch[1].replace(/["']/g, '').trim();
    str = str.replace(modelMatch[0], '').trim();
  }

  str = str.replace(/\s*·\s*/g, '@').replace(/\s+/g, ' ');
  let [agentPart, modelPart] = str.split('@');
  agentPart = (agentPart || '').trim().toLowerCase();
  modelPart = (modelFlag || modelPart || '').trim().toLowerCase();

  if (agentPart === 'sonnet' || agentPart === 'claude' || agentPart === 'claude-sonnet') return 'claude-sonnet';
  if (agentPart === 'codex') return 'codex';
  if (agentPart === 'cursor') return 'cursor';
  if (agentPart === 'ds1' || agentPart === 'claude-ds1' || agentPart === 'deepseek') return 'claude-ds1';
  if (agentPart === 'ag2-sonnet' || (agentPart === 'claude-ag2' && modelPart.includes('sonnet'))) return 'claude-ag2@claude-sonnet-4-6';
  if (agentPart === 'gemini' || agentPart === 'flash' || (agentPart === 'claude-ag2' && modelPart.includes('gemini'))) return 'claude-ag2@gemini-3-flash';

  return modelPart ? `${agentPart}@${modelPart}` : agentPart;
}

async function orchCommand(text) {
  const [rawVerb = 'status', ...rest] = text.trim().split(/\s+/);
  const verb = rawVerb.toLowerCase();
  const restStr = rest.join(' ');
  const arg = resolveLane(verb === 'model' ? `model ${restStr}` : restStr);

  const pretty = (e) => e.replace('@', ' \u{2022} ');
  const list = () => order().map((e, i) => `${i + 1}. ${healthy(e) ? ICONS.check : ICONS.stop} ${pretty(e)}${healthy(e) ? '' : `  (down until ${until(e)})`}`).join('\n');
  const onDuty = () => order().find(healthy);
  const HELP = '_/orch status \u{2022} quotas \u{2022} use <lane> \u{2022} order \u{2022} pause \u{2022} resume \u{2022} reset_';

  switch (verb) {
    case 'quotas':
    case 'quota': {
      try {
        const qp = path.join(os.homedir(), '.local', 'bin', 'check-quotas.mjs');
        if (fs.existsSync(qp)) {
          const out = spawnSync(process.execPath, [qp], { encoding: 'utf8' }).stdout;
          const q = JSON.parse(out);
          const lines = [
            `*${ICONS.lightning} Live Quota Health Check*`,
            `• *Claude 3.7 Sonnet:* ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'Active (OAuth Token OK)' : 'No Token'}`,
            `• *Codex / ChatGPT Plus:* ${healthy('codex') ? 'Ready' : 'Usage Limit Cooling Down'}`,
            `• *Cursor Agent:* Ready`,
            `• *DeepSeek (claude-ds1):* ${healthy('claude-ds1') ? 'Ready' : '402 Insufficient Balance'}`,
            `• *Antigravity CloudCode Proxy:*`,
            `   - Sonnet 4.6: ${q.antigravity?.['claude-sonnet-4-6']?.status || 'Down'} (${q.antigravity?.['claude-sonnet-4-6']?.available ?? 0}/${q.antigravity?.['claude-sonnet-4-6']?.total ?? 15})`,
            `   - Opus Thinking: ${q.antigravity?.['claude-opus-4-6-thinking']?.status || 'Down'} (${q.antigravity?.['claude-opus-4-6-thinking']?.available ?? 0}/${q.antigravity?.['claude-opus-4-6-thinking']?.total ?? 15})`,
            `   - Gemini 3 Flash: ${q.antigravity?.['gemini-3-flash']?.status || 'OK'} (${q.antigravity?.['gemini-3-flash']?.available ?? 15}/${q.antigravity?.['gemini-3-flash']?.total ?? 15} accounts active)`
          ];
          return lines.join('\n');
        }
      } catch (e) {
        return `Quota check error: ${e.message}`;
      }
      return 'Quota checker unavailable.';
    }
    case 'use':
    case 'model': {
      if (!arg) return 'Usage: /orch use <lane>\nShortcuts: sonnet, codex, cursor, ds1, ag2-sonnet, gemini';
      setControl({ order: [arg, ...order().filter((e) => e !== arg)] });
      delete st.until[arg]; save();
      return `\u{1F449} Next turn: *${pretty(arg)}*\nOrder:\n${list()}`;
    }
    case 'order': {
      const items = restStr.split(',').map((x) => resolveLane(x.trim())).filter(Boolean);
      if (!items.length) return 'Usage: /orch order a,b,c   (or /orch order default)';
      setControl({ order: items[0] === 'default' ? undefined : items });
      return `\u{1F501} New order:\n${list()}`;
    }
    case 'pause': setControl({ paused: true }); return `${ICONS.pause} Paused. Events are kept and handled after /orch resume.`;
    case 'resume': setControl({ paused: false }); return `\u{25B6}\u{FE0F} Resumed. On duty: *${pretty(onDuty() ?? 'none')}*`;
    case 'reset': st.until = {}; save(); return `\u{267B}\u{FE0F} Every agent marked ready again.\nOrder:\n${list()}`;
    default: {
      const c = control();
      return [`${c.paused ? `${ICONS.pause} *Paused*\n` : ''}On duty: *${pretty(onDuty() ?? 'none available')}*${st.current && st.current !== onDuty() ? `  (last turn: ${pretty(st.current)})` : ''}`,
        'Order:', list(), HELP].join('\n');
    }
  }
}

let currentTurn = null; // { child, agent, startedAt, isUser, abort: (reason) => void }

function turn(agent, prompt, isUserTurn = false) {
  return new Promise((resolve) => {
    const sid = isUserTurn ? undefined : st.sessions[agent];
    const [cmd, args] = command(agent, prompt, sid);
    const orchSubagentEnv = {
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.ORCH_SUBAGENT_MODEL || CFG.subagentModel || 'claude-3-5-haiku-20241022',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(CFG.maxConcurrentSubagents ?? 2),
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: String(CFG.maxSubagentsPerSession ?? 5),
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022'
    };

    const isPosix = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: ROOT,
      detached: isPosix,
      env: {
        ...process.env,
        ...orchSubagentEnv,
        AGENT_PROJECT: REPO,
        PATH: [path.join(os.homedir(), '.claude-launchers'), path.join(os.homedir(), '.local', 'bin'), process.env.PATH].join(path.delimiter)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    });

    let out = '';
    let quietSince = Date.now();
    const take = (d) => { out += d; quietSince = Date.now(); fs.appendFileSync(LOG, d); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const killTree = () => {
      if (!child.pid) return;
      try {
        if (isPosix) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      try { child.kill('SIGTERM'); } catch {}
      try { spawn('pkill', ['-TERM', '-g', String(child.pid)], { stdio: 'ignore' }); } catch {}
      try { spawn('pkill', ['-TERM', '-P', String(child.pid)], { stdio: 'ignore' }); } catch {}
      
      setTimeout(() => {
        try {
          if (isPosix) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
        try { child.kill('SIGKILL'); } catch {}
        try { spawn('pkill', ['-KILL', '-g', String(child.pid)], { stdio: 'ignore' }); } catch {}
        try { spawn('pkill', ['-KILL', '-P', String(child.pid)], { stdio: 'ignore' }); } catch {}
      }, 500);
    };

    let preempted = false;
    let doneCalled = false;

    const done = (code, text) => {
      if (doneCalled) return;
      doneCalled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      currentTurn = null;
      resolve({ code, out: text, preempted });
    };

    currentTurn = {
      agent,
      child,
      isUser: isUserTurn,
      startedAt: Date.now(),
      abort: (reason) => {
        log(`[turn] abort requested (${reason}) for ${agent}`);
        preempted = true;
        out += `\n[driver] preempted: ${reason}\n`;
        killTree();
        setTimeout(() => {
          if (!doneCalled) {
            log(`[turn] child did not exit in 350ms after abort; force-resolving turn`);
            done(143, out);
          }
        }, 350);
      }
    };

    const timer = setTimeout(() => killTree(), TURN_MS);
    const watchdog = setInterval(() => {
      if (Date.now() - quietSince > SILENCE_MS) {
        out += `\n[driver] no output for ${SILENCE_MS / 60000} min: timeout\n`;
        killTree();
      }
    }, 15_000);

    child.on('error', (e) => done(-1, String(e.message)));
    child.on('close', (code) => done(code, out));
  });
}

// Proactive Orchestrator Prompt with Subagent Concurrency rules
const bootstrap = (agent, takeover) => {
  const isClaudeOrCodex = agent === 'claude-sonnet' || agent === 'claude' || agent.startsWith('codex');
  
  return [
    `You are the active orchestrator for "${REPO}" on "${NODE}" (turn agent: ${agent}).`,
    `Read and follow ${PLAYBOOK} now.`,
    `YOUR CORE MISSION IN THIS TURN:`,
    `0. CRITICAL OWNER INVARIANT (ABSOLUTE RULE):`,
    `   - CLAUDE IS RESERVED EXCLUSIVELY FOR ORCHESTRATION, NEVER FOR TASK EXECUTION.`,
    `   - NEVER assign, spawn, or dispatch Claude (claude, claude-sonnet, claude-cpa, claude-ag2-sonnet) to build, code, or execute tasks.`,
    `   - All worker build jobs MUST be assigned to non-Claude workers: cursor, opencode, agy, claude-ag2-gemini, oc-build.`,
    `1. REVIEW QUEUE FIRST:`,
    `   - Run: \`node .agent-hub-orch/dispatch.mjs list\` and check .agent-hub-orch/BOARD.md.`,
    `   - Inspect any completed tasks in REVIEW.`,
    `   - If verification and tests pass, accept immediately: \`node .agent-hub-orch/hub.mjs accept <task-id>\`.`,
    `2. DISPATCH NEXT WORK:`,
    `   - Keep worker lanes busy. Check ready tasks in the board backlog.`,
    `   - Dispatch tasks to available lanes using: \`node .agent-hub-orch/dispatch.mjs run auto <task-id>\`.`,
    !isClaudeOrCodex ? [
      `3. WORKER CONCURRENCY RULE (CRITICAL FOR ${agent.toUpperCase()}):`,
      `   - You are running on a non-Claude/non-Codex coordinator (${agent}).`,
      `   - You may use AT MOST 3 TO 5 workers of your own engine simultaneously so you do NOT drain your quota.`,
      `   - All remaining tasks MUST be dispatched to alternative active builders (e.g. cursor, opencode, agy, claude-oc1).`
    ].join('\n') : '',
    `4. KEEP USER INFORMED:`,
    `   - Post significant milestone updates to WhatsApp using: \`wa send "<concise 2-line update>"\`.`,
    `5. HANDOFF: Update docs/HANDOFF.md before ending your turn.`,
    takeover ? `You take over from ${takeover}. Read docs/HANDOFF.md first, then proceed.` : '',
    `\nHANDLE THE EVENTS BELOW.`
  ].filter(Boolean).join('\n');
};

function extractReply(out) {
  if (!out) return '';
  const lines = out.trim().split('\n');
  let finalResult = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const p = JSON.parse(line);
        if (p.type === 'result' && typeof p.result === 'string' && p.result.trim()) {
          finalResult = p.result.trim();
          break;
        }
        if (p.result && typeof p.result === 'string' && p.result.trim()) {
          finalResult = p.result.trim();
          break;
        }
      } catch {}
    }
  }

  // If finalResult is a generic status report, intercept it and find the actual drafted conversational response
  const isGenericReport = /^\*+\s*Orchestrator Status Report/i.test(finalResult);
  if (isGenericReport) {
    // 1. Check if thinking block drafted a direct answer
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const p = JSON.parse(line);
          const thinking = p.message?.content?.find((c) => c.type === 'thinking')?.thinking || '';
          const draftMatch = thinking.match(/(?:draft the response|response to the user|answer to the operator)[:\s]*\n*["“]([\s\S]+?)["”]/i);
          if (draftMatch && draftMatch[1].trim().length > 20) {
            return draftMatch[1].trim();
          }
        } catch {}
      }
    }
    // 2. Check earlier assistant text messages that are not status reports
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const p = JSON.parse(line);
          if (p.type === 'assistant' && p.message?.content) {
            const texts = p.message.content
              .filter((c) => c.type === 'text' && c.text && !/^\*+\s*Orchestrator Status Report/i.test(c.text.trim()))
              .map((c) => c.text.trim())
              .filter(Boolean);
            if (texts.length) return texts.join('\n\n');
          }
        } catch {}
      }
    }
  }

  if (finalResult && !isGenericReport) return finalResult;
  if (finalResult) return finalResult;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const p = JSON.parse(line);
        if (p.type === 'assistant' && p.message?.content) {
          const texts = p.message.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text.trim())
            .filter(Boolean);
          if (texts.length) return texts.join('\n\n');
        }
      } catch {}
    }
  }
  const clean = lines.filter((l) => !l.startsWith('{') && !l.startsWith('[driver]') && !l.startsWith('10-')).join('\n').trim();
  if (clean) return clean.length > 3500 ? clean.slice(0, 3500) + '\n\n...(truncated for WhatsApp length)' : clean;
  return '';
}

function buildSteerPrompt(agent, userTexts) {
  const nameMatch = userTexts.match(/(?:my name is|i am|call me|je m'appelle|smiti)\s+([a-zA-Z\u0600-\u06FF]+)/i);
  if (nameMatch) {
    st.operatorName = nameMatch[1];
    save();
    log(`[handle] Learned operator name: "${st.operatorName}"`);
  }

  const opName = st.operatorName || 'Ossama (Epioso)';
  const wantsDetails = /\b(?:detail|details|full doc|explain all|breakdown|report|deep dive|comprehensive|koulchi|tafasil)\b/i.test(userTexts);
  const isActionDirective = /\b(?:build|create|make|add|fix|implement|run|start|dispatch|rework|generate|update|code|write|setup|develop)\b/i.test(userTexts);

  let directiveInstructions = [];
  if (isActionDirective) {
    directiveInstructions = [
      `2. ACTION DIRECTIVE DETECTED: The operator asked you to build, fix, create, or run something.`,
      `   - You are the Autonomous Orchestrator. Take full care of all settings, context scoping, skill bindings, and model selection.`,
      `   - Create a complete A-to-Z task brief in \`.agent-hub-orch/tasks/<TASK-ID>.md\` following \`.agent-hub-orch/templates/brief.md\`:`,
      `     * Scope: define exact 1 to 3 files to create or modify. Prevent whole-repo reading to save tokens.`,
      `     * Skills: select 2 to 4 exact skills from \`.agent-hub-orch/skills/\` (verify with \`node .agent-hub-orch/tools/skills.mjs check <TASK-ID>\`).`,
      `     * Logic: write clear step-by-step implementation recipe so the worker finishes in 1 turn without guessing.`,
      `     * Test: define exact verification command (e.g. \`npx vitest run ... && npm run check:branch-scope\`).`,
      `   - Select the optimal execution engine (QuotaShield):`,
      `     * Fast & Free / UI / Routine edits: dispatch to \`claude-ag2-gemini\` (Gemini 3 Flash, 15 rotating accounts) or \`opencode\` or \`cursor\` (composer-2.5).`,
      `     * Heavy Reasoning / Math / Complex Architecture: dispatch to \`codex\` with \`model_reasoning_effort="low"\`.`,
      `   - Dispatch the task: \`node .agent-hub-orch/dispatch.mjs run <executor> auto <TASK-ID>\`.`,
      `   - Update docs/HANDOFF.md.`,
      `   - Reply directly to ${opName} on WhatsApp: announce the task created, the assigned executor, and that you'll update them with live screenshot proof when done.`
    ];
  } else if (wantsDetails) {
    directiveInstructions = [
      `2. The operator explicitly asked for FULL DETAILS / COMPREHENSIVE EXPLANATION. Provide a complete, structured briefing with clear headers:`,
      `   - Current Status: high-level progress on the platform.`,
      `   - Completed & Accepted Work: recent pages and features verified and merged.`,
      `   - Active Work in Flight: exact tasks and models currently running (e.g. OpenCode on shifts and collection desk).`,
      `   - Blockers & Next Actions: any hurdles or immediate next priorities.`,
      `   Format it clearly with clean markdown headers and bullet points.`
    ];
  } else {
    directiveInstructions = [
      `2. Answer ONLY what the operator is asking directly in 1-3 concise, conversational sentences. Do NOT bring up unasked topics, unsolicited questions, or ask what to call them.`,
      `3. NEVER output an "*Orchestrator Status Report*" template or recite numbered review/dispatch checklists.`
    ];
  }

  return [
    `You are the active orchestrator for "${REPO}" on "${NODE}" (turn agent: ${agent}).`,
    `A HUMAN OPERATOR (${opName}) SENT THIS MESSAGE TO YOU FROM WHATSAPP:`,
    `"""`,
    userTexts,
    `"""`,
    '',
    `CRITICAL INSTRUCTIONS FOR THIS TURN:`,
    `1. TALK DIRECTLY TO THE OPERATOR (${opName}) in natural, friendly language (first person: "I...", "You...").`,
    ...directiveInstructions,
    `4. NEVER speak about the operator in the third person.`,
    isActionDirective ? `5. Execute necessary planning, brief writing, and dispatch tools now.` : `5. DO NOT execute unnecessary tools or edit files in this purely conversational turn!`,
    `6. YOUR ENTIRE FINAL OUTPUT MUST BE ADDRESSED DIRECTLY TO THE OPERATOR ON WHATSAPP.`
  ].join('\n');
}

let busy = false;
let queue = [];
let lastEvent = Date.now();

async function handle(events) {
  busy = true;
  const userEvents = events.filter((e) => e.startsWith('whatsapp:') || e.startsWith('USER ('));
  const hasUserMessage = userEvents.length > 0;
  
  let userTexts = '';
  if (hasUserMessage) {
    userTexts = userEvents
      .map((e) => e.replace(/^(whatsapp:\s*(WHATSAPP\s*\d\d:\d\d:\s*)?|USER\s*\([^)]*\):\s*)/i, '').trim())
      .filter(Boolean)
      .join('\n');
  }

  const body = `EVENTS:\n${events.join('\n')}`;
  let takeover = null;
  const failed = [];
  
  for (const agent of order().filter(healthy)) {
    // 1. FAST PREFLIGHT PROBE: Check API health in <3.5s before launching CLI
    const probe = await pingAgent(agent, 3500);
    if (!probe.ok) {
      const isQuota = probe.isQuota || QUOTA_LIMIT.test(probe.reason);
      const cooldown = isQuota ? DOWN_MS : SHORT_DOWN_MS;
      st.until[agent] = Date.now() + cooldown;
      delete st.sessions[agent];
      save();

      const tag = isQuota ? `${ICONS.stop} Quota Ended` : `${ICONS.warning} Responding Error`;
      log(`[preflight] ${tag}: ${agent} (${probe.reason}) cooldown: ${cooldown / 60000}m. Fast failover.`);
      failed.push(`${tag} \u{2022} *${agent.replace('@', ' \u{2022} ')}*: ${probe.reason} (until ${until(agent)})`);
      takeover = agent;
      continue;
    }

    const fresh = !st.sessions[agent];
    const prompt = hasUserMessage
      ? buildSteerPrompt(agent, userTexts)
      : (fresh || takeover ? `${bootstrap(agent, takeover)}\n\n${body}` : `${body}\n\nHandle these per the playbook; update docs/HANDOFF.md before you finish.`);
    log(`turn → ${agent}${fresh ? ' (new session)' : ''}: ${events.length} event(s)`);
    
    let r = await turn(agent, prompt, hasUserMessage);

    if (r.preempted) {
      log(`[handle] Turn preempted by incoming user directive. Yielding turn immediately.`);
      const nonUserEvents = events.filter((e) => !e.startsWith('whatsapp:') && !e.startsWith('USER ('));
      if (nonUserEvents.length) queue.push(...nonUserEvents);
      busy = false;
      setImmediate(flush);
      return;
    }

    // Check if turn succeeded (exit code 0 and no error result payload)
    let hasExplicitError = false;
    if (r.code !== 0) {
      hasExplicitError = true;
    } else {
      const lastLines = (r.out || '').trim().split('\n');
      for (let i = lastLines.length - 1; i >= Math.max(0, lastLines.length - 20); i--) {
        const l = lastLines[i].trim();
        if (l.startsWith('{') && l.endsWith('}')) {
          try {
            const p = JSON.parse(l);
            if (p.type === 'result' && p.is_error === true) { hasExplicitError = true; break; }
            if (p.type === 'result' && p.subtype === 'error_exit') { hasExplicitError = true; break; }
            if (p.type === 'error' && p.error) { hasExplicitError = true; break; }
          } catch {}
        }
      }
    }

    const sid = sessionFrom(agent, r.out);
    
    if (!hasExplicitError) {
      if (sid && !hasUserMessage) {
        st.sessions[agent] = sid;
        st.turnCount = st.turnCount || {};
        st.turnCount[agent] = (st.turnCount[agent] || 0) + 1;
        // Auto-rotate session after 8 turns to prevent cumulative 150k+ token re-reads and quota burn
        if (st.turnCount[agent] >= 8) {
          log(`[driver] Auto-rotating session for ${agent} after 8 turns to prevent token bloat.`);
          delete st.sessions[agent];
          st.turnCount[agent] = 0;
        }
      }
      st.current = agent;
      save();
      log(`turn ok (${agent})`);
      if (failed.length) notify(`${ICONS.warning} Switched to *${agent.replace('@', ' \u{2022} ')}*\n${failed.join('\n')}`);
      if (hasUserMessage) {
        const reply = extractReply(r.out);
        if (reply) {
          log(`replying to user via WhatsApp (${reply.length} chars)`);
          notify(reply);
        } else {
          log('turn completed with user message but extractReply was empty; sending fallback completion');
          notify(`${ICONS.check} *Received:* "_${userTexts.slice(0, 40)}_" \u{2022} *Turn Completed*\nOrchestrator finished executing your directive.`);
        }
        const nonUserEvents = events.filter((e) => !e.startsWith('whatsapp:') && !e.startsWith('USER ('));
        if (nonUserEvents.length) {
          queue.push(...nonUserEvents);
          setImmediate(flush);
        }
      }
      st.pausedNote = null; save();
      busy = false;
      return;
    }
    
    // Evaluate failure: genuine quota vs responding error
    const isQuotaError = QUOTA_LIMIT.test(r.out);
    const cooldown = downFor(r, isQuotaError);
    st.until[agent] = Date.now() + cooldown;
    delete st.sessions[agent];
    save();

    const shortReason = (r.out.match(QUOTA_LIMIT)?.[0] ?? `exit ${r.code}`).slice(0, 60);
    const tag = isQuotaError ? `${ICONS.stop} Quota Limit` : `${ICONS.warning} Responding Error`;
    failed.push(`${tag} \u{2022} *${agent.replace('@', ' \u{2022} ')}*: ${shortReason} (until ${until(agent)})`);
    log(`${agent} unavailable (${shortReason}) until ${until(agent)}; next: ${order().filter(healthy)[0] ?? 'none'}`);
    takeover = agent;
  }
  
  if (failed.length) {
    const next = Math.min(...order().map((e) => st.until[e] ?? Infinity));
    const note = `${ICONS.pause} No agent available right now, I retry at ${new Date(next).toTimeString().slice(0, 5)}.\n${failed.join('\n')}`;
    if (st.pausedNote?.text !== note.split('\n')[0] || Date.now() - st.pausedNote.at > 3 * 3600_000) {
      notify(note); st.pausedNote = { text: note.split('\n')[0], at: Date.now() }; save();
    }
  }
  busy = false;
  queue.unshift(...events);
}

const flush = () => {
  if (busy || control().paused || !queue.length) return;
  const batch = queue;
  queue = [];
  handle(batch);
};

const push = (line) => {
  if (queue.length && queue[queue.length - 1] === line) return;
  lastEvent = Date.now();
  queue.push(line);
  if ((line.startsWith('whatsapp:') || line.startsWith('USER (')) && !busy) {
    setTimeout(flush, 100);
  }
};

setInterval(() => {
  if (busy || control().paused) return;
  if (!queue.length && Date.now() - lastEvent > IDLE_MS) push(`TICK ${new Date().toISOString().slice(11, 16)}: no events for ${IDLE_MS / 60000} min; check the hub and keep lanes busy within quota.`);
  flush();
}, BATCH_MS);

function follow(name, cmd, args, filter = () => true) {
  const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines.map((x) => x.trim()).filter(Boolean)) if (filter(l)) push(`${name}: ${l}`);
  });
  child.on('close', (code) => { log(`${name} stopped (${code}); restarting in 10s`); setTimeout(() => follow(name, cmd, args, filter), 10_000); });
}

if (cmdOnce) {
  console.log(await orchCommand(cmdOnce));
  process.exit(0);
}
if (sayOnce) {
  await handle([`USER (terminal): ${sayOnce}`]);
  process.exit(0);
}
log(`driver up for ${REPO} on ${NODE}; order: ${order().join(' → ')}`);
if (withAutoloop) follow('autoloop', process.execPath, [path.join(HUB, 'autoloop.mjs')], (l) => {
  if (/^DIGEST\b.*\|\s*running:\s*none$/i.test(l)) return false;
  if (/^SYNC\b.*pulled 0/i.test(l)) return false;
  return true;
});

// WhatsApp Listener: User messages have top priority and immediately steer or preempt the agent
if (fs.existsSync(WA)) follow('whatsapp', process.execPath, [WA, 'inbox'], (l) => {
  if (!l.startsWith('WHATSAPP')) return false;
  
  const m = l.match(/^WHATSAPP \d\d:\d\d:\s*.*?\b\/?orch\b\s*(.*)$/i) || l.match(/^WHATSAPP \d\d:\d\d:\s*\b(quotas|status)\b/i);
  if (m) {
    const cmdText = m[1] || m[0];
    orchCommand(cmdText).then((reply) => {
      log(`/orch ${cmdText} -> ${reply.split('\n')[0]}`);
      notify(reply);
    });
    return false;
  }

  const textMatch = l.match(/^WHATSAPP \d\d:\d\d:\s*(.*)$/);
  const rawMsg = textMatch ? textMatch[1] : l;
  const voiceMatch = rawMsg.match(/\[voice note transcribed:\s*"([^"]+)"\]/);
  const snippet = voiceMatch
    ? (voiceMatch[1].slice(0, 65) + ' (🎙️ Voice Note)')
    : rawMsg.trim().replace(/\s+/g, ' ').slice(0, 80);
  const currentDuty = (order().find(healthy) ?? 'Gemini').replace('@', ' \u{2022} ');

  let preemptionOccurred = false;
  let runningAgent = '';
  let runningElapsed = 0;

  if (currentTurn && !currentTurn.isUser) {
    preemptionOccurred = true;
    runningAgent = currentTurn.agent.replace('@', ' \u{2022} ');
    runningElapsed = Math.round((Date.now() - currentTurn.startedAt) / 1000);
    log(`[PREEMPT] Incoming user instruction. Aborting background turn (${currentTurn.agent}, ${runningElapsed}s elapsed) to yield priority!`);
    currentTurn.abort('user priority steering instruction received');
  }

  let ack = '';
  if (preemptionOccurred) {
    ack = [
      `*${ICONS.alarm} Priority Steering Engaged*`,
      `${ICONS.bullet} *Instruction:* "_${snippet}${snippet.length >= 80 ? '...' : ''}_"`,
      `${ICONS.bullet} *Coordinator:* ${currentDuty}`,
      `${ICONS.bullet} *Action:* Preempted background task (${runningAgent}, ${runningElapsed}s elapsed).`,
      `${ICONS.bullet} *Status:* Orchestrator addressing your directive right now...`
    ].join('\n');
  } else if (currentTurn && currentTurn.isUser) {
    ack = [
      `*${ICONS.eye} Message Received*`,
      `${ICONS.bullet} *Instruction:* "_${snippet}${snippet.length >= 80 ? '...' : ''}_"`,
      `${ICONS.bullet} *Coordinator:* ${currentDuty}`,
      `${ICONS.bullet} *Status:* ${ICONS.hourglass} User turn currently active; your instruction is queued as top priority!`
    ].join('\n');
  } else {
    ack = [
      `*${ICONS.eye} Message Received*`,
      `${ICONS.bullet} *Instruction:* "_${snippet}${snippet.length >= 80 ? '...' : ''}_"`,
      `${ICONS.bullet} *Coordinator:* ${currentDuty}`,
      `${ICONS.bullet} *Status:* ${ICONS.lightning} Active. Orchestrator processing your directive now...`
    ].join('\n');
  }

  log(`ACK sent to WhatsApp: "${snippet.slice(0, 30)}..."`);
  notify(ack);

  lastEvent = Date.now();
  queue.unshift(`whatsapp: ${l}`);
  
  setImmediate(flush);
  setTimeout(flush, 400);

  return false;
});

push('START: the driver just started. Load context, post one short WhatsApp status line, then continue.');

const REPORTER = path.join(os.homedir(), '.local', 'bin', 'orch-report-15m.mjs');
if (fs.existsSync(REPORTER)) {
  setInterval(() => {
    try {
      spawn(process.execPath, [REPORTER, ROOT], { stdio: 'ignore', windowsHide: true, detached: true });
    } catch {}
  }, 15 * 60_000);
}
