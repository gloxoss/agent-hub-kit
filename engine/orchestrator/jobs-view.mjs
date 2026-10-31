// jobs-view.mjs: what is running right now, in words the owner can read: goal, lane, minutes, tokens, required skills.
// Reads only files the hub already writes (runs/jobs.jsonl, the job logs, tasks/<id>.md); starts nothing.
import fs from 'node:fs';
import path from 'node:path';

const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

const readTail = (file, maxBytes = 4_000_000) => {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
};

// Tokens and cost from a stream-json job log: the final result line when the run ended, else the sum over distinct messages.
export function usageFromLog(text) {
  let cost = null, total = 0;
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'result' && o.usage) {
      cost = o.total_cost_usd ?? cost;
      return { tokens: (o.usage.input_tokens ?? 0) + (o.usage.output_tokens ?? 0) + (o.usage.cache_read_input_tokens ?? 0), cost };
    }
    const m = o.message;
    if (o.type === 'assistant' && m?.usage && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      total += (m.usage.input_tokens ?? 0) + (m.usage.output_tokens ?? 0);
    }
  }
  return { tokens: seen.size ? total : null, cost };
}

const fmtTokens = (n) => (n == null ? 'tokens n/a' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : `${Math.round(n / 1000)}k tokens`);

// Goal = the brief's title line; skills = every skill the brief names.
export function briefFacts(hubDir, taskId) {
  let text = '';
  try { text = fs.readFileSync(path.join(hubDir, 'tasks', `${taskId}.md`), 'utf8'); } catch { return { goal: taskId, skills: [] }; }
  const title = (text.split('\n')[0] || '').replace(/^#\s*/, '');
  const goal = title.split(' · ').slice(2).join(' · ') || title.replace(taskId, '').replace(/^[\s·-]+/, '') || taskId;
  const skills = new Set();
  for (const m of text.matchAll(/skills\/([\w.-]+)\/SKILL\.md/g)) skills.add(m[1]);
  const sec = text.match(/## Skills\n([\s\S]*?)(\n## |$)/);
  if (sec) for (const m of sec[1].matchAll(/`([\w:.-]+)`/g)) if (!m[1].includes('--')) skills.add(m[1]);
  return { goal: goal.slice(0, 90), skills: [...skills].slice(0, 5) };
}

export function runningJobs(hubDir, root) {
  const file = path.join(hubDir, 'runs', 'jobs.jsonl');
  let rows = [];
  try { rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-60).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  return [...latest.values()].filter((r) => r.pid && alive(r.pid)).map((r) => {
    const facts = briefFacts(hubDir, r.taskId);
    const logAbs = r.log ? path.resolve(root, r.log) : null;
    const u = logAbs ? usageFromLog(readTail(logAbs)) : { tokens: null, cost: null };
    return { ...r, ...facts, minutes: Math.max(0, Math.round((Date.now() - Date.parse(r.t)) / 60000)), tokens: u.tokens, cost: u.cost };
  });
}

// One readable block per running job.
export function runningLines(hubDir, root, max = 8) {
  const jobs = runningJobs(hubDir, root);
  if (!jobs.length) return [];
  return jobs.slice(0, max).map((j, i) => {
    const kind = j.mode === 'review' ? 'review' : 'build';
    const spent = `${fmtTokens(j.tokens)}${j.cost ? `, $${Number(j.cost).toFixed(2)}` : ''}`;
    const sk = j.skills.length ? `skills required: ${j.skills.join(', ')}` : 'skills: none named in brief';
    return `${i + 1}. ${j.taskId} (${kind}) on ${j.executor}${j.agentId ? ` as ${j.agentId}` : ''}, ${j.minutes} min\n   goal: ${j.goal}\n   spent: ${spent}; ${sk}`;
  });
}

export function runSelfTest() {
  const u = usageFromLog('{"type":"assistant","message":{"id":"a","usage":{"input_tokens":10,"output_tokens":5}}}\n{"type":"assistant","message":{"id":"a","usage":{"input_tokens":10,"output_tokens":5}}}\n{"type":"assistant","message":{"id":"b","usage":{"input_tokens":20,"output_tokens":1}}}');
  const done = usageFromLog('{"type":"result","total_cost_usd":1.5,"usage":{"input_tokens":100,"output_tokens":50}}');
  return [
    ['sums distinct messages', u.tokens === 36],
    ['result line wins', done.tokens === 150 && done.cost === 1.5],
    ['no usage gives null', usageFromLog('').tokens === null],
    ['token format', fmtTokens(2_500_000) === '2.5M tokens' && fmtTokens(null) === 'tokens n/a'],
  ];
}
