import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function validateAccountEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Account entry must be an object, got ${typeof entry}`);
  }
  const id = entry.id;
  if (!id || typeof id !== 'string') {
    throw new Error(`Account entry missing required string field 'id': ${JSON.stringify(entry)}`);
  }
  if (!entry.command || typeof entry.command !== 'string') {
    throw new Error(`Account [${id}] missing required string field 'command'`);
  }
  if (!entry.family || typeof entry.family !== 'string') {
    throw new Error(`Account [${id}] missing required string field 'family'`);
  }
  if (!Array.isArray(entry.roles)) {
    throw new Error(`Account [${id}] missing required array field 'roles'`);
  }
  const costOk = (typeof entry.cost === 'number' && !Number.isNaN(entry.cost)) || ['free', 'plan', 'paid'].includes(entry.cost);
  if (!costOk) {
    throw new Error(`Account [${id}] field 'cost' must be a number or one of free|plan|paid`);
  }
  if (!entry.owner || typeof entry.owner !== 'string') {
    throw new Error(`Account [${id}] missing required string field 'owner'`);
  }
  if (typeof entry.enabled !== 'boolean') {
    throw new Error(`Account [${id}] missing required boolean field 'enabled'`);
  }
  if (entry.quotaKey !== null && typeof entry.quotaKey !== 'string') {
    throw new Error(`Account [${id}] field 'quotaKey' must be string or null`);
  }
  if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
    throw new Error(`Account [${id}] field 'model' must be a string if present`);
  }
  return true;
}

// Role vocabulary: plan roles are orchestrator|builder|reviewer|responder; older registries said worker|verifier.
const ROLE_ALIASES = { worker: 'builder', verifier: 'reviewer' };
export function rolesOf(entry) {
  const out = new Set();
  for (const r of entry.roles ?? []) { out.add(r); if (ROLE_ALIASES[r]) out.add(ROLE_ALIASES[r]); }
  return out;
}
// Cheap = free (cost "free" or 0): may edit when managing. Plan/paid accounts are "costly": they never write code.
export function isCheap(entry) { return entry.cost === 'free' || entry.cost === 0; }
export function costRank(entry) {
  if (isCheap(entry)) return 0;
  if (entry.cost === 'paid' || (typeof entry.cost === 'number' && entry.cost >= 0.1)) return 2;
  return 1;
}

// The hub folder of the project in the current directory (.hub first), so callers need not pass it.
export function resolveHubDir(startDir = process.cwd()) {
  for (const d of ['.hub', '.agent-hub-orch', '.agent-hub']) {
    const p = path.resolve(startDir, d);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(startDir, '.hub');
}

// quota.mjs needs the CLIProxyAPI management key; read it from the vault env without printing it.
function loadVaultEnv() {
  if (process.env.CLIPROXY_KEY) return;
  const f = path.join(os.homedir(), '.config', 'devbox', 'vault', 'env');
  try {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^(CLIPROXY_KEY|CLIPROXY_URL|CLIPROXY_DIR)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no vault here */ }
}

// Allowance for one registry entry out of the quota rows. Pools (several accounts behind one key) report their BEST
// usable account. "quotaModel" picks one model's number (Antigravity rows hold Gemini and Claude pools separately,
// and a row's overall "remaining" is the lowest of them, so it would hide a healthy Gemini pool).
function quotaFor(entry, rows) {
  if (!Array.isArray(rows) || !entry.quotaKey) return null;
  const key = String(entry.quotaKey).toLowerCase();
  const matched = rows.filter((r) => String(r.provider ?? '').toLowerCase() === key || String(r.account ?? '').toLowerCase().includes(key));
  if (!matched.length) return null;
  const modelOf = (r) => (entry.quotaModel && r.models ? r.models[entry.quotaModel] : undefined);
  const rem = (r) => {
    const m = modelOf(r);
    if (m !== undefined && m !== null) return Number(typeof m === 'object' ? m.remaining : m);
    return r.remaining === null || r.remaining === undefined ? 1 : Number(r.remaining);
  };
  const resetOf = (r) => {
    const m = modelOf(r);
    return (m && typeof m === 'object' ? m.resetAt : null) ?? r.resetAt ?? null;
  };
  const blocked = (r) => (entry.quotaModel ? ['AUTH', 'DOWN', 'OFF'] : ['AUTH', 'OUT', 'DOWN', 'OFF', 'COOLDOWN']).includes(r.flag);
  const usable = matched.filter((r) => !blocked(r) && rem(r) >= 0.05);
  if (usable.length) {
    const best = Math.max(...usable.map(rem));
    return { remaining: best, resetAt: null, flag: 'OK', detail: `${usable.length}/${matched.length} accounts usable, best ${best.toFixed(2)}` };
  }
  const resets = matched.map(resetOf).filter(Boolean).sort();
  return { remaining: Math.max(0, ...matched.map(rem)), resetAt: resets[0] ?? null, flag: 'OUT', detail: `all ${matched.length} accounts exhausted` };
}

export function loadAccounts(hubDir = resolveHubDir()) {
  let filePath = path.resolve(hubDir, 'accounts.json');
  if (!fs.existsSync(filePath)) {
    filePath = path.join(os.homedir(), '.config', 'agent-hub', 'accounts.json');
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'accounts.example.json');
  }
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid JSON in accounts file ${filePath}: ${e.message}`);
  }
  const entries = Array.isArray(raw) ? raw : (raw.accounts ?? []);
  const validated = [];
  for (const entry of entries) {
    validateAccountEntry(entry);
    validated.push(entry);
  }
  return validated;
}

export function pick({ role, exclude = [], hubDir = resolveHubDir() } = {}) {
  loadVaultEnv();
  const accounts = loadAccounts(hubDir);
  const runsDir = path.resolve(hubDir, 'runs');
  const cachePath = path.join(runsDir, 'quota-cache.json');

  let quotaCache = [];
  let cacheStale = true;
  try {
    if (fs.existsSync(cachePath)) {
      const stats = fs.statSync(cachePath);
      if (Date.now() - stats.mtimeMs < 2 * 60 * 1000) {
        cacheStale = false;
      }
      const rawCache = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(rawCache);
      quotaCache = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.accounts ?? []);
    }
  } catch (e) {
    // ignore
  }

  if (cacheStale) {
    try {
      const quotaScript = path.join(__dirname, 'quota.mjs');
      if (fs.existsSync(quotaScript)) {
        const output = execSync(`node "${quotaScript}" --json`, { timeout: 10000, encoding: 'utf8' });
        const parsed = JSON.parse(output);
        quotaCache = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.accounts ?? []);
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(quotaCache, null, 2), 'utf8');
      }
    } catch (e) {
      // fallback to existing cache or empty
    }
  }

  const excludeIds = new Set(exclude.map(ex => typeof ex === 'string' ? ex : ex?.id));
  const excludeObjs = new Set(exclude.filter(ex => typeof ex === 'object' && ex !== null));

  const filtered = accounts.filter(entry => {
    if (!entry.enabled) return false;
    if (role && !rolesOf(entry).has(role)) return false;
    if (excludeIds.has(entry.id)) return false;
    if (excludeObjs.has(entry)) return false;
    return true;
  });

  const enriched = filtered.map(entry => {
    const q = quotaFor(entry, quotaCache);

    let remaining = 1;
    let resetAt = null;
    let flag = 'OK';
    let reason = 'no quota data (assumed healthy)';

    if (q) {
      remaining = q.remaining !== null && q.remaining !== undefined ? Number(q.remaining) : 1;
      resetAt = q.resetAt || null;
      flag = q.flag || 'OK';

      if (['AUTH', 'OUT', 'DOWN', 'COOLDOWN'].includes(flag)) {
        reason = q.detail || flag;
      } else if (resetAt && new Date(resetAt).getTime() > Date.now()) {
        const timeStr = new Date(resetAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        reason = `down until ${timeStr}`;
      } else if (remaining < 0.05) {
        reason = `exhausted (remaining ${Math.round(remaining * 100)}%)`;
      } else {
        reason = `remaining ${typeof remaining === 'number' ? remaining.toFixed(2) : remaining}`;
      }
    }

    return {
      ...entry,
      remaining,
      resetAt,
      flag,
      reason: q?.detail ?? reason
    };
  });

  const familyRank = (fam) => {
    const map = { gemini: 1, antigravity: 1, codex: 2, opencode: 3, cursor: 4, claude: 5 };
    return map[fam] ?? 6;
  };

  const isExhausted = (item) => {
    return item.remaining < 0.05 ||
      (item.resetAt && new Date(item.resetAt).getTime() > Date.now()) ||
      ['AUTH', 'OUT', 'DOWN', 'COOLDOWN', 'OFF'].includes(item.flag);
  };

  enriched.sort((a, b) => {
    const aUser = a.owner === 'user' ? 1 : 0;
    const bUser = b.owner === 'user' ? 1 : 0;
    if (aUser !== bUser) return aUser - bUser;

    const aExh = isExhausted(a) ? 1 : 0;
    const bExh = isExhausted(b) ? 1 : 0;
    if (aExh !== bExh) return aExh - bExh;

    if (costRank(a) !== costRank(b)) return costRank(a) - costRank(b);

    const remDiff = (b.remaining ?? 1) - (a.remaining ?? 1);
    if (Math.abs(remDiff) > 0.001) return remDiff;

    const famDiff = familyRank(a.family) - familyRank(b.family);
    if (famDiff !== 0) return famDiff;

    const costA = typeof a.cost === 'number' ? a.cost : (a.cost === 'paid' ? 1 : 0);
    const costB = typeof b.cost === 'number' ? b.cost : (b.cost === 'paid' ? 1 : 0);
    if (costA !== costB) return costA - costB;

    return a.id.localeCompare(b.id);
  });

  return enriched;
}

export function explainDrain(hubDir = '.agent-hub', hours = 6) {
  const runsDir = path.resolve(hubDir, 'runs');
  const jobsPath = path.join(runsDir, 'jobs.jsonl');
  const ledgerPath = path.join(runsDir, 'orch-ledger.jsonl');

  const now = Date.now();
  const windowMs = hours * 3600 * 1000;
  const cutoff = now - windowMs;

  const jobs = [];
  if (fs.existsSync(jobsPath)) {
    try {
      const lines = fs.readFileSync(jobsPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const t = obj.t || obj.timestamp || obj.createdAt || now;
          if (t >= cutoff) jobs.push(obj);
        } catch {}
      }
    } catch {}
  }

  const ledger = [];
  if (fs.existsSync(ledgerPath)) {
    try {
      const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const t = obj.t || obj.timestamp || now;
          if (t >= cutoff) ledger.push(obj);
        } catch {}
      }
    } catch {}
  }

  const stats = {};

  for (const job of jobs) {
    const key = job.executor || job.account || job.agent || job.entry || 'codex';
    if (!stats[key]) {
      stats[key] = { turns: 0, jobs: 0, tokens: 0, tasks: {}, failures: 0, retries: 0 };
    }
    stats[key].jobs++;
    const taskId = job.taskId || job.id;
    if (taskId) {
      stats[key].tasks[taskId] = (stats[key].tasks[taskId] || 0) + 1;
    }
    if (job.status && /fail|error|retry|retried/i.test(job.status)) {
      stats[key].retries++;
      stats[key].failures++;
    }
  }

  for (const entry of ledger) {
    const key = entry.entry || entry.account || 'gemini pool';
    if (!stats[key]) {
      stats[key] = { turns: 0, jobs: 0, tokens: 0, tasks: {}, failures: 0, retries: 0 };
    }
    stats[key].turns++;
    stats[key].tokens += (Number(entry.inTok) || 0) + (Number(entry.outTok) || 0);
    const taskId = entry.taskId || entry.task;
    if (taskId) {
      stats[key].tasks[taskId] = (stats[key].tasks[taskId] || 0) + 1;
    }
  }

  const lines = [];
  for (const [key, data] of Object.entries(stats)) {
    const totalJobs = data.jobs;
    const totalTurns = data.turns;
    const totalActivity = totalJobs + totalTurns;

    let topTask = null;
    let maxTaskCount = 0;
    for (const [task, count] of Object.entries(data.tasks)) {
      if (count > maxTaskCount) {
        maxTaskCount = count;
        topTask = task;
      }
    }

    const isAbnormal = data.retries > 2 || maxTaskCount > 3 || data.failures > 2 || (totalActivity > 30 && maxTaskCount > 2);

    if (isAbnormal) {
      if (topTask && maxTaskCount > 1) {
        lines.push(`${key}: ${totalActivity} ${totalTurns > 0 ? 'turns' : 'jobs'}, ${topTask} retried ${maxTaskCount} times (abnormal)`);
      } else {
        lines.push(`${key}: ${totalActivity} jobs, ${data.retries} retries (abnormal)`);
      }
    } else {
      if (totalActivity > 0) {
        const unit = totalTurns > 0 ? 'turns' : 'jobs';
        lines.push(`${key}: ${totalActivity} ${unit} in ${hours} h (normal)`);
      }
    }
  }

  if (lines.length === 0) {
    lines.push(`no usage recorded in the last ${hours} h`);
  }

  return lines;
}

if (process.argv[1] && __filename === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'pick') {
    let role = null;
    const roleIdx = args.indexOf('--role');
    if (roleIdx !== -1 && args[roleIdx + 1]) {
      role = args[roleIdx + 1];
    }
    let hubDir = resolveHubDir();
    const hubIdx = Math.max(args.indexOf('--hubDir'), args.indexOf('--hub'));
    if (hubIdx !== -1 && args[hubIdx + 1]) {
      hubDir = path.resolve(args[hubIdx + 1]);
    }
    const asJson = args.includes('--json');

    try {
      const results = pick({ role, hubDir });
      if (asJson) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) {
          console.log(`${r.id.padEnd(16)} ${r.family.padEnd(10)} ${String(r.remaining ?? '?').padEnd(6)} ${r.reason}`);
        }
      }
    } catch (e) {
      console.error(`accounts pick: ${e.message}`);
      process.exit(1);
    }
  } else {
    try {
      console.log(JSON.stringify(loadAccounts(), null, 2));
    } catch (e) {
      console.error(`accounts load: ${e.message}`);
      process.exit(1);
    }
  }
}

// Picker checks on a throwaway hub: per-model quota in both shapes, free first, exhausted last, owner's account last.
export function runSelfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-selftest-'));
  try {
    fs.mkdirSync(path.join(dir, 'runs'));
    fs.copyFileSync(path.join(__dirname, 'accounts.example.json'), path.join(dir, 'accounts.json'));
    const rows = [
      { provider: 'antigravity', account: 'a@x', flag: 'OUT', remaining: 0, models: { Gemini: { remaining: 0.6, resetAt: null }, 'Claude and GPT models': 0 } },
      { provider: 'antigravity', account: 'b@x', flag: 'OUT', remaining: 0, models: { Gemini: 0, 'Claude and GPT models': { remaining: 0, resetAt: '2999-01-01T00:00:00Z' } } },
      { provider: 'codex', account: 'c@x', flag: 'OK', remaining: 0.8 },
      { provider: 'claude', account: 'd@x', flag: 'OK', remaining: 0.84 },
    ];
    fs.writeFileSync(path.join(dir, 'runs', 'quota-cache.json'), JSON.stringify(rows));
    const ids = (role) => pick({ role, hubDir: dir }).map((e) => e.id);
    const orch = pick({ role: 'orchestrator', hubDir: dir });
    const checks = [
      ['free pool first, via per-model quota', orch[0].id === 'ag2-gemini' && orch[0].remaining === 0.6],
      ['plan account second', orch[1].id === 'codex'],
      ['exhausted pool flagged', orch.find((e) => e.id === 'ag2-sonnet').flag === 'OUT'],
      ["owner's account last", orch[orch.length - 1].id === 'claude-user'],
      ['responders are claude-family only', ids('responder').every((id) => id !== 'codex')],
      ['old role names still match', rolesOf({ roles: ['worker', 'verifier'] }).has('builder') && rolesOf({ roles: ['worker', 'verifier'] }).has('reviewer')],
      ['disabled and paid entries excluded', !ids('builder').includes('ds1') && !ids('builder').includes('cursor')],
      ['cheap definition', isCheap({ cost: 'free' }) && isCheap({ cost: 0 }) && !isCheap({ cost: 'plan' })],
    ];
    let ok = true;
    for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} accounts: ${name}`); ok = ok && pass; }
    return ok;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
