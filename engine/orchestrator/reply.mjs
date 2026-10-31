// reply.mjs: read what an agent CLI printed. Final reply text, session id, context size, spend, and why a turn failed.
// Pure functions over the raw stdout/stderr of one turn (Claude stream-json, Codex --json, OpenCode --format json).

function parseLines(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* not JSON */ }
  }
  return out;
}

const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

// The agent's final answer for the owner.
export function extractReply(stdout, family = 'claude') {
  const events = parseLines(stdout);
  if (family.includes('codex')) {
    const msgs = events.filter((e) => e.type === 'item.completed' && (e.item?.type === 'agent_message' || e.item?.type === 'assistant_message'));
    if (msgs.length) return String(msgs[msgs.length - 1].item.text ?? '').trim();
  } else if (family.includes('opencode')) {
    const texts = events.filter((e) => e.type === 'text' && (e.part?.text || e.text));
    if (texts.length) return String(texts[texts.length - 1].part?.text ?? texts[texts.length - 1].text).trim();
  } else {
    const result = [...events].reverse().find((e) => e.type === 'result' && typeof e.result === 'string');
    if (result) return result.result.trim();
    const assistant = [...events].reverse().find((e) => e.type === 'assistant' && textOf(e.message?.content));
    if (assistant) return textOf(assistant.message.content).trim();
  }
  // Plain-text fallback: the last paragraph that is not a JSON event line.
  const plain = String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('{'));
  return plain.slice(-8).join('\n').trim();
}

// Session id to resume next time.
export function extractSessionId(stdout, family = 'claude') {
  const events = parseLines(stdout);
  if (family.includes('codex')) {
    const started = events.find((e) => e.type === 'thread.started' && e.thread_id);
    if (started) return started.thread_id;
    return String(stdout).match(/session id:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
  }
  if (family.includes('opencode')) {
    const e = events.find((x) => x.sessionID || x.part?.sessionID);
    return e?.sessionID ?? e?.part?.sessionID ?? null;
  }
  return events.find((e) => e.session_id)?.session_id ?? null;   // Claude: we choose it with --session-id, but echo confirms
}

// Context size of the LAST model call (what the next turn must carry), and the turn's spend.
export function turnStats(stdout, family = 'claude') {
  const events = parseLines(stdout);
  let contextTokens = 0;
  let costUsd = null;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (family.includes('codex')) {
    const done = [...events].reverse().find((e) => e.type === 'turn.completed' && e.usage);
    if (done) {
      contextTokens = Number(done.usage.input_tokens ?? 0);
      usage = { input_tokens: contextTokens, output_tokens: Number(done.usage.output_tokens ?? 0), total_tokens: contextTokens + Number(done.usage.output_tokens ?? 0) };
    }
  } else {
    const last = [...events].reverse().find((e) => e.type === 'assistant' && e.message?.usage);
    if (last) {
      const u = last.message.usage;
      contextTokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    }
    const result = [...events].reverse().find((e) => e.type === 'result');
    if (result) {
      if (typeof result.total_cost_usd === 'number') costUsd = result.total_cost_usd;
      const u = result.usage ?? {};
      usage = { input_tokens: Number(u.input_tokens ?? 0), output_tokens: Number(u.output_tokens ?? 0), total_tokens: Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0) };
    }
  }
  return { contextTokens, costUsd, usage };
}

const LIMIT = /usage limit|session limit|rate.?limit|quota|exhausted|insufficient balance|credit balance|\b402\b|\b429\b|overloaded|plan.*expired|expired/i;
const AUTH = /unauthori[sz]ed|invalid bearer|invalid api key|not logged in|authentication|\b401\b|api key (?:has )?expired/i;

// Next local occurrence of a clock time like "resets 11:10pm" (Claude prints these), in ms from now.
function msUntilClock(text, now = Date.now()) {
  const m = String(text).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)/i);
  if (!m) return null;
  const d = new Date(now);
  d.setHours((Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0), Number(m[2] ?? 0), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return Math.max(d.getTime() - now, 60_000);
}

// null when the turn worked; otherwise { kind, reason, downMs }.
export function failureOf(res, now = Date.now()) {
  const jitter = () => Math.floor(Math.random() * 15 * 60_000);
  if (res.violation) return { kind: 'violation', reason: 'tried to write code (guard stopped the turn)', downMs: 2 * 3600_000 };
  if (res.error === 'silence_watchdog_exceeded') return { kind: 'silent', reason: 'no output for too long (rate limit or hang)', downMs: 30 * 60_000 + jitter() };
  if (res.error === 'turn_timeout_exceeded') return { kind: 'timeout', reason: 'turn took too long', downMs: 30 * 60_000 };
  const events = parseLines(res.stdout);
  const result = [...events].reverse().find((e) => e.type === 'result');
  const blob = [res.error, res.stderr, result?.is_error ? result.result : '', res.success ? '' : String(res.stdout ?? '').slice(-1500)].filter(Boolean).join('\n');
  const bad = !res.success || result?.is_error;
  if (!bad) return null;
  if (/ENOENT|not found|command not found/i.test(blob)) return { kind: 'missing', reason: 'command not installed here', downMs: 24 * 3600_000 };
  if (AUTH.test(blob)) return { kind: 'auth', reason: 'login or key rejected', downMs: 6 * 3600_000 };
  if (LIMIT.test(blob)) {
    const clock = msUntilClock(blob, now);
    return { kind: 'quota', reason: (blob.match(LIMIT)?.[0] ?? 'limit reached').slice(0, 60), downMs: clock ?? (60 * 60_000 + jitter()) };
  }
  return { kind: 'error', reason: `failed (exit ${res.exitCode ?? '?'})`, downMs: 10 * 60_000 };
}

export function runSelfTest() {
  const claudeOut = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500 }, content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'result', result: '1. P-x | codex | 4 min | building', total_cost_usd: 0.02, usage: { input_tokens: 12, output_tokens: 80 }, session_id: 'abc' }),
  ].join('\n');
  const codexOut = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok codex' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9000, output_tokens: 50 } }),
  ].join('\n');
  const checks = [
    ['claude reply', extractReply(claudeOut, 'claude') === '1. P-x | codex | 4 min | building'],
    ['claude context', turnStats(claudeOut).contextTokens === 40510],
    ['claude cost', turnStats(claudeOut).costUsd === 0.02],
    ['codex reply', extractReply(codexOut, 'codex') === 'ok codex'],
    ['codex session', extractSessionId(codexOut, 'codex') === 'th-1'],
    ['quota clock', failureOf({ success: false, exitCode: 1, stdout: "You've hit your session limit. resets 11:10pm" }, new Date('2026-10-31T10:00:00').getTime()).downMs > 3600_000],
    ['auth', failureOf({ success: false, exitCode: 1, stderr: 'API key has expired' }).kind === 'auth'],
    ['missing', failureOf({ success: false, exitCode: -1, error: 'spawn x ENOENT' }).kind === 'missing'],
    ['ok turn', failureOf({ success: true, exitCode: 0, stdout: claudeOut }) === null],
    ['claude is_error', failureOf({ success: true, exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429 rate limit' }) })?.kind === 'quota'],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} reply: ${name}`); ok = ok && pass; }
  return ok;
}
