// proxy-health.mjs: the Antigravity proxy (port 8080) knows the real quota. A manager turn that failed is only "down"
// when the proxy says it has nothing to give; otherwise the failure is transient (one rate-limited account, a slow turn).
const PORT = process.env.ANTIGRAVITY_PROXY_PORT || 8080;

export async function proxyStatus(timeoutMs = 4000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const c = j.counts ?? {};
    return { up: true, total: c.total ?? 0, available: c.available ?? 0, rateLimited: c.rateLimited ?? 0 };
  } catch { return { up: false, total: 0, available: 0, rateLimited: 0 }; }
}

// Entries that go through the proxy.
export const usesProxy = (entry) => /claude-ag2/.test(String(entry.command ?? '')) || /antigravity/i.test(String(entry.quotaKey ?? ''));

// Soften a failure when the proxy still has accounts: short pause, not 30 to 60 minutes.
export function softenFailure(fail, status, entry = {}) {
  if (!fail || !status.up) return fail;
  const gemini = /gemini/i.test(String(entry.model ?? entry.id ?? 'gemini'));   // the Claude pool has its own quota; account counts say nothing about it
  if (!(['silent', 'timeout', 'error'].includes(fail.kind) || (fail.kind === 'quota' && gemini))) return fail;
  if (status.available <= 0) return fail;
  return { ...fail, soft: true, downMs: 2 * 60_000, reason: `${fail.reason}; proxy still has ${status.available} usable accounts` };
}

export function runSelfTest() {
  const checks = [
    ['soft when proxy has accounts', softenFailure({ kind: 'silent', reason: 'x', downMs: 1800000 }, { up: true, available: 5 }).downMs === 120000],
    ['hard when proxy has none', softenFailure({ kind: 'quota', reason: 'x', downMs: 3600000 }, { up: true, available: 0 }).downMs === 3600000],
    ['auth stays hard', softenFailure({ kind: 'auth', reason: 'x', downMs: 21600000 }, { up: true, available: 5 }).downMs === 21600000],
    ['proxy down keeps original', softenFailure({ kind: 'error', reason: 'x', downMs: 600000 }, { up: false }).downMs === 600000],
    ['usesProxy', usesProxy({ command: 'claude-ag2' }) && !usesProxy({ command: 'codex' })],
  ];
  let ok = true;
  for (const [n, p] of checks) { console.log(`${p ? 'PASS' : 'FAIL'} proxy-health: ${n}`); ok = ok && p; }
  return ok;
}
