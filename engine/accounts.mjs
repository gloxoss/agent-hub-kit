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
  if (typeof entry.cost !== 'number' || Number.isNaN(entry.cost)) {
    throw new Error(`Account [${id}] missing required number field 'cost'`);
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

export function loadAccounts(hubDir = '.agent-hub') {
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

export function pick({ role, exclude = [], hubDir = '.agent-hub' } = {}) {
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
    if (role && (!Array.isArray(entry.roles) || !entry.roles.includes(role))) return false;
    if (excludeIds.has(entry.id)) return false;
    if (excludeObjs.has(entry)) return false;
    return true;
  });

  const enriched = filtered.map(entry => {
    let q = null;
    if (Array.isArray(quotaCache)) {
      q = quotaCache.find(item =>
        item.account === entry.quotaKey ||
        item.account === entry.id ||
        item.provider === entry.quotaKey ||
        item.provider === entry.id ||
        (item.account && entry.quotaKey && item.account.includes(entry.quotaKey)) ||
        (item.account && entry.id && item.account.includes(entry.id))
      );
      if (!q) {
        const parts = entry.id.split('-');
        const num = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(num)) {
          const familyMap = { gemini: 'antigravity', codex: 'codex', claude: 'claude', opencode: 'opencode', cursor: 'cursor' };
          const providerTarget = familyMap[entry.family] ?? entry.family;
          const familyItems = quotaCache.filter(item => item.provider === providerTarget || item.account?.startsWith(providerTarget));
          if (familyItems[num - 1]) {
            q = familyItems[num - 1];
          }
        }
      }
    }

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
      reason
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
    let hubDir = '.agent-hub';
    const hubIdx = args.indexOf('--hubDir');
    if (hubIdx !== -1 && args[hubIdx + 1]) {
      hubDir = args[hubIdx + 1];
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
