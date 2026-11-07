// Read-only view of the Antigravity proxy accounts: who is usable, limited, invalid, and quota left.
// Never prints tokens. Usage: node .hub/tools/accounts-status.mjs [--json] [--model gemini-3.8-flash-high]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("Usage: node accounts-status.mjs [--json] [--model <model>]\nRead-only view of the Antigravity proxy accounts: ready, limited, invalid, quota. Never prints tokens."); process.exit(0); }

const file = path.join(os.homedir(), '.config', 'antigravity-proxy', 'accounts.json');
const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'gemini-3.8-flash-high';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = Date.now();

const rows = data.accounts.map((a, i) => {
  const limits = a.modelRateLimits || {};
  const lim = limits[model];
  const resetAt = lim && (lim.resetTime || lim.resetAt || lim.until);
  const limitedMs = resetAt ? new Date(resetAt).getTime() - now : lim?.isRateLimited ? 1 : 0;
  const q = a.quota?.models?.[model] ?? a.quota?.[model];
  const frac = q && typeof q === 'object' ? q.remainingFraction ?? q.fraction : typeof q === 'number' ? q : null;
  const status = !a.enabled ? 'disabled' : a.isInvalid ? 'invalid' : limitedMs > 0 ? 'limited' : 'ready';
  return {
    n: i + 1,
    email: a.email.replace(/(.{3}).*(@.*)/, '$1***$2'),
    status,
    freeInMin: limitedMs > 1 ? Math.ceil(limitedMs / 60000) : 0,
    quota: frac == null ? '?' : Math.round(frac * 100) + '%',
    lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString().slice(11, 16) : '-',
    why: a.isInvalid ? String(a.invalidReason || '').slice(0, 40) : '',
  };
});

if (args.includes('--json')) { console.log(JSON.stringify(rows)); process.exit(0); }
console.log(`model ${model}`);
for (const r of rows) console.log(`${String(r.n).padStart(2)} ${r.email.padEnd(26)} ${r.status.padEnd(9)} quota ${String(r.quota).padStart(4)}  free in ${String(r.freeInMin).padStart(3)} min  used ${r.lastUsed}  ${r.why}`);
const c = (s) => rows.filter((r) => r.status === s).length;
console.log(`ready ${c('ready')} | limited ${c('limited')} | invalid ${c('invalid')} | disabled ${c('disabled')} | total ${rows.length}`);
