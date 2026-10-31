// select.mjs: who takes the next manager turn. Ranked by remaining allowance (free first, owner's Claude last),
// minus entries that are down or over their hourly cap. Failovers are silent; only an all-down outage is announced.
import { pick, explainDrain, isCheap } from '../accounts.mjs';

const HOUR = 3600_000;
const FORBIDDEN = /(^|[-_ ])kie($|[-_ ])/i;   // owner rule: Kie lanes are for images only, never manager/builder/reviewer

export const isDown = (st, id, now = Date.now()) => (st.down?.[id] ?? 0) > now || (st.sessions?.[id]?.downUntil ?? 0) > now;
export function markDown(st, id, ms, reason, now = Date.now()) {
  st.down = { ...(st.down ?? {}), [id]: now + ms };
  st.downWhy = { ...(st.downWhy ?? {}), [id]: reason };
}
export function recordTurn(st, id, now = Date.now()) {
  st.turns = [...(st.turns ?? []).filter((t) => now - t.t < HOUR), { t: now, id }];
}
export const turnsInLastHour = (st, now = Date.now()) => (st.turns ?? []).filter((t) => now - t.t < HOUR).length;

// Ranked usable entries for a role. `control.order` (from /orch use|order) puts chosen ids first, in that order.
export function candidates({ role = 'orchestrator', st, hubDir, control = {}, exclude = [] }) {
  const ranked = pick({ role, hubDir, exclude }).filter((e) => !FORBIDDEN.test(`${e.id} ${e.command}`));
  // Skip entries the quota data says are empty; if that leaves nobody, try them anyway (the data can be stale).
  const exhausted = (e) => ['AUTH', 'OUT', 'DOWN', 'COOLDOWN', 'OFF'].includes(e.flag) || e.remaining < 0.05;
  const healthy = ranked.filter((e) => !isDown(st, e.id));
  const usable = healthy.some((e) => !exhausted(e)) ? healthy.filter((e) => !exhausted(e)) : healthy;
  const pinned = (control.order ?? []).map((id) => usable.find((e) => e.id === id)).filter(Boolean);
  const rest = usable.filter((e) => !pinned.includes(e));
  const list = [...pinned, ...rest];
  // Owner's own account only when nobody else is available.
  const fleet = list.filter((e) => e.owner !== 'user');
  return fleet.length ? [...fleet, ...list.filter((e) => e.owner === 'user' && control.order?.includes(e.id))] : list;
}

// One-line notice when the owner's own account has to take over.
export const ownerClaudeNotice = (entry, st, now = Date.now()) => {
  if (entry.owner !== 'user') return null;
  const down = Object.entries(st.down ?? {}).filter(([, t]) => t > now).map(([id, t]) => `${id} until ${new Date(t).toTimeString().slice(0, 5)}`);
  return `Using your Claude account (${entry.id}): other managers are down${down.length ? ` (${down.join(', ')})` : ''}.`;
};

// Plain message when every manager is down: who, why, until when, why allowance drained, and what to do.
export function outageMessage({ st, hubDir, now = Date.now() }) {
  const lines = Object.entries(st.down ?? {}).filter(([, t]) => t > now).sort((a, b) => a[1] - b[1])
    .map(([id, t], i) => `${i + 1}. ${id}: ${st.downWhy?.[id] ?? 'unavailable'} (until ${new Date(t).toTimeString().slice(0, 5)})`);
  let why = [];
  try { why = explainDrain(hubDir, 6); } catch { /* no ledger yet */ }
  const next = Math.min(...Object.values(st.down ?? {}).filter((t) => t > now), Infinity);
  return [
    `No manager available${Number.isFinite(next) ? `; next retry ${new Date(next).toTimeString().slice(0, 5)}` : ''}.`,
    ...lines,
    why.length ? 'Recent usage:' : null,
    ...why.map((w, i) => `${i + 1}. ${w}`),
    'To add or top up an account: devbox lanes add. Work in progress keeps running; new decisions wait.',
  ].filter(Boolean).join('\n');
}

// Stable key of the current down-set, so the same outage is announced once.
export const downKey = (st, now = Date.now()) => Object.entries(st.down ?? {}).filter(([, t]) => t > now).map(([id]) => id).sort().join('|');

export function runSelfTest() {
  const now = Date.now();
  const st = { down: { a: now + 60_000 }, downWhy: { a: 'quota' }, turns: [{ t: now - 10, id: 'x' }, { t: now - 2 * HOUR, id: 'x' }] };
  const checks = [
    ['isDown', isDown(st, 'a', now) && !isDown(st, 'b', now)],
    ['turns/hour', turnsInLastHour(st, now) === 1],
    ['kie forbidden', FORBIDDEN.test('claude-kie') && FORBIDDEN.test('codex-kie') && !FORBIDDEN.test('claude-ds1')],
    ['downKey', downKey(st, now) === 'a'],
    ['owner notice', ownerClaudeNotice({ owner: 'user', id: 'c' }, st, now)?.includes('other managers are down')],
    ['fleet no notice', ownerClaudeNotice({ owner: 'fleet', id: 'g' }, st, now) === null],
    ['outage text', outageMessage({ st, hubDir: '/nonexistent', now }).includes('1. a: quota')],
    ['cheap', isCheap({ cost: 'free' }) && isCheap({ cost: 0 }) && !isCheap({ cost: 'plan' })],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} select: ${name}`); ok = ok && pass; }
  return ok;
}
