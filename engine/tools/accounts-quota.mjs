// Live quota per account and model, from the Antigravity proxy (http://localhost:8080/account-limits). Never prints tokens.
// Usage: agys quota [model-filter]     e.g.  agys quota   |  agys quota claude   |  agys quota gemini-3.8
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("Usage: node accounts-quota.mjs [model-filter]\nLive quota per Antigravity proxy account and model (needs the proxy on http://localhost:8080). Example: accounts-quota.mjs claude"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = (process.argv[2] || '').toLowerCase();
const DEFAULT = ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];

let data;
try {
  const res = await fetch('http://localhost:8080/account-limits?format=json', { signal: AbortSignal.timeout(45000) });
  data = await res.json();
} catch {
  console.log('The Antigravity proxy does not answer on port 8080. Start it with:  acc start');
  process.exit(1);
}

// Which accounts agy has saved (name<TAB>email from agys emails)
const emails = spawnSync('powershell', ['-NoProfile', '-File', path.join(here, 'agy-profiles.ps1'), 'emails'], { encoding: 'utf8' }).stdout;
const saved = new Map(emails.split(/\r?\n/).filter(Boolean).map((l) => { const [n, e] = l.split('\t'); return [(e || '').toLowerCase(), n]; }));

const allModels = [...new Set(data.accounts.flatMap((a) => Object.keys(a.limits || {})))].sort();
const cols = filter ? allModels.filter((m) => m.toLowerCase().includes(filter)) : DEFAULT.filter((m) => allModels.includes(m));
if (!cols.length) { console.log(`no model matches "${filter}". Models: ${allModels.join(', ')}`); process.exit(0); }

const short = (m) => m.replace('gemini-', 'gem-').replace('-thinking', '-think').replace('claude-', 'cl-').slice(0, 17);
const pct = (l) => (l && typeof l.remainingFraction === 'number' ? Math.round(l.remainingFraction * 100) + '%' : '-');
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
const bar = (f) => (typeof f === 'number' ? '█'.repeat(Math.round(f * 5)).padEnd(5, '░') : '     ');

console.log(`quota now ${hhmm(new Date().toISOString())} | proxy ${data.totalAccounts} accounts | [agy] = also saved in agy`);
console.log(`${'#'.padEnd(3)}${'account'.padEnd(32)}${'tier'.padEnd(6)}${'state'.padEnd(9)}` + cols.map((m) => short(m).padEnd(20)).join(''));
const totals = Object.fromEntries(cols.map((m) => [m, 0]));
data.accounts.forEach((a, i) => {
  const state = !a.enabled ? 'disabled' : a.isInvalid ? 'invalid' : Object.values(a.modelRateLimits || {}).some((r) => r && r.isRateLimited) ? 'limited' : 'ready';
  const tag = saved.has((a.email || '').toLowerCase()) ? ' [agy]' : '';
  const cells = cols.map((m) => {
    const l = a.limits?.[m];
    if (l && typeof l.remainingFraction === 'number') totals[m] += l.remainingFraction;
    return `${bar(l?.remainingFraction)} ${pct(l).padStart(4)} ${l?.resetTime ? 'r' + hhmm(l.resetTime) : ''}`.padEnd(20);
  });
  console.log(`${String(i + 1).padEnd(3)}${((a.email || '') + tag).padEnd(32)}${String(a.subscription?.tier || '?').padEnd(6)}${state.padEnd(9)}${cells.join('')}`);
});
console.log('');
console.log('sum of remaining (1.0 = one full account): ' + cols.map((m) => `${short(m)} ${totals[m].toFixed(1)}`).join(' | '));
console.log('r14:30 = quota refills at that time. Other models: agys quota <filter>, e.g. agys quota gpt');
