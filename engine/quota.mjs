#!/usr/bin/env node
// Quota audit for every account in the local CLIProxyAPI (the same data as its dashboard's
// "Refresh Quota"). One line per account, flags LOW (<20%), OUT (0%), AUTH (login revoked), DOWN.
//
//   node .agent-hub/quota.mjs            all accounts
//   node .agent-hub/quota.mjs --json     machine-readable
//   node .agent-hub/quota.mjs --entry id single registry entry
//
// Config: CLIPROXY_DIR (folder with cli-proxy-api.exe), CLIPROXY_URL (default http://127.0.0.1:8317),
// CLIPROXY_KEY (management key; if unset it is read from CLIPROXY_DIR/README_SETUP.md). The key is
// never printed.
import fs from 'node:fs';
import { CFG, help } from './tools/runtime.mjs';
help('usage: quota.mjs [--json] [--entry <id>]; CLIPROXY_DIR / CLIPROXY_URL / CLIPROXY_KEY override config.quota');
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { loadAccounts } from './accounts.mjs';

const DIR = process.env.CLIPROXY_DIR ?? CFG.quota?.dir ?? '';
const BASE = process.env.CLIPROXY_URL ?? CFG.quota?.url ?? 'http://127.0.0.1:8317';
const asJson = process.argv.includes('--json');
const entryIndex = process.argv.indexOf('--entry');
const entryId = entryIndex !== -1 ? process.argv[entryIndex + 1] : null;

function managementKey() {
  if (process.env.CLIPROXY_KEY) return process.env.CLIPROXY_KEY;
  if (!DIR) throw new Error('no management key: set CLIPROXY_KEY or CLIPROXY_DIR env var');
  const readme = path.join(DIR, 'README_SETUP.md');
  const m = fs.existsSync(readme) && fs.readFileSync(readme, 'utf8').match(/Management Password \/ Secret\*\*: `([^`]+)`/);
  if (!m) throw new Error(`no management key: set CLIPROXY_KEY or add it to ${readme}`);
  return m[1];
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.end(); resolve(true); });
  s.once('error', () => resolve(false));
});

async function ensureServer() {
  const port = Number(new URL(BASE).port || 80);
  if (await portOpen(port)) return;
  if (!DIR) throw new Error(`CLIProxyAPI is not running on ${BASE}. Set CLIPROXY_DIR to the folder with cli-proxy-api.exe to auto-start it.`);
  const exe = path.join(DIR, 'cli-proxy-api.exe');
  if (!fs.existsSync(exe)) throw new Error(`CLIProxyAPI is not running on ${BASE} and ${exe} was not found`);
  const logDir = path.join(DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'hub-start.log'), 'a');
  spawn(exe, ['-config', 'config.yaml'], { cwd: DIR, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 40 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await portOpen(port))) throw new Error(`started CLIProxyAPI but ${BASE} is not answering`);
}

const KEY = managementKey();
const mgmt = async (p, init = {}) => {
  const r = await fetch(`${BASE}/v0/management/${p}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`management ${p}: HTTP ${r.status}`);
  return r.json();
};

async function upstream(authIndex, method, url, header, data) {
  const res = await mgmt('api-call', { method: 'POST', body: JSON.stringify({ authIndex, method, url, header, ...(data ? { data } : {}) }) });
  let body = res.body;
  try { body = JSON.parse(res.body); } catch {}
  return { status: res.status_code, body };
}

const pct = (fraction) => `${Math.round(fraction * 100)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?');
const flagFor = (fraction) => (fraction <= 0 ? 'OUT' : fraction < 0.2 ? 'LOW' : 'OK');

async function antigravity(a) {
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64' };
  const r = await upstream(a.auth_index, 'POST', 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', header, '{}');
  if (r.status === 401 || r.status === 403) return { flag: 'AUTH', detail: 'login revoked or expired: re-login this account in CLIProxyAPI', remaining: null, resetAt: null, models: null };
  if (r.status !== 200) return { flag: 'DOWN', detail: `quota call HTTP ${r.status}`, remaining: null, resetAt: null, models: null };
  const parts = [];
  let worst = 1;
  let worstReset = null;
  const models = {};
  for (const g of r.body.groups ?? []) {
    const modelName = (g.displayName ?? '').replace(' Models', '');
    let mWorst = 1;
    let mReset = null;
    for (const b of g.buckets ?? []) {
      const frac = b.remainingFraction ?? 1;
      if (frac < worst) {
        worst = frac;
        worstReset = b.resetTime ?? null;
      }
      if (frac < mWorst) {
        mWorst = frac;
        mReset = b.resetTime ?? null;
      }
      parts.push(`${modelName} ${b.window} ${pct(frac)} (resets ${when(b.resetTime)})`);
    }
    models[modelName] = { remaining: mWorst, resetAt: mReset };
  }
  return { flag: flagFor(worst), detail: parts.join(' · '), remaining: worst, resetAt: worstReset, models };
}

async function claude(a) {
  const r = await upstream(a.auth_index, 'GET', 'https://api.anthropic.com/api/oauth/usage', { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' });
  if (r.status === 401 || r.status === 403) return { flag: 'AUTH', detail: `${r.body?.error?.message ?? 'unauthorized'}: re-login the Claude account in CLIProxyAPI`, remaining: null, resetAt: null, models: null };
  if (r.status !== 200) return { flag: 'DOWN', detail: `usage call HTTP ${r.status}`, remaining: null, resetAt: null, models: null };
  const parts = [];
  let worst = 1;
  let worstReset = null;
  for (const [k, v] of Object.entries(r.body ?? {})) {
    if (v && typeof v.utilization === 'number') {
      const left = 1 - v.utilization / 100;
      if (left < worst) {
        worst = left;
        worstReset = v.resets_at ?? null;
      }
      parts.push(`${k} ${pct(left)} left (resets ${when(v.resets_at)})`);
    }
  }
  return { flag: flagFor(worst), detail: parts.join(' · ') || 'no usage windows reported', remaining: parts.length ? worst : null, resetAt: worstReset, models: null };
}

async function codex(a) {
  const r = await upstream(a.auth_index, 'GET', 'https://chatgpt.com/backend-api/wham/usage', { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' });
  if (r.status === 401 || r.status === 403) return { flag: 'AUTH', detail: 'login revoked or expired: re-login the Codex account in CLIProxyAPI', remaining: null, resetAt: null, models: null };
  if (r.status !== 200) return { flag: 'DOWN', detail: `usage call HTTP ${r.status}`, remaining: null, resetAt: null, models: null };
  const rl = r.body?.rate_limit ?? r.body ?? {};
  const parts = [];
  let worst = 1;
  let worstReset = null;
  for (const [k, w] of Object.entries(rl)) {
    if (w && typeof w.used_percent === 'number') {
      const left = 1 - w.used_percent / 100;
      const resetIso = w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null;
      if (left < worst) {
        worst = left;
        worstReset = resetIso;
      }
      parts.push(`${k.replace('_window', '')} ${pct(left)} left${w.reset_at ? ` (resets ${when(resetIso)})` : ''}`);
    }
  }
  return { flag: flagFor(worst), detail: parts.join(' · ') || 'no usage windows reported', remaining: parts.length ? worst : null, resetAt: worstReset, models: null };
}

const PROVIDERS = { antigravity, claude, codex };

async function main() {
  await ensureServer();
  const list = await mgmt('auth-files');
  let accounts = list.files ?? list;

  if (entryId) {
    const registryEntries = loadAccounts();
    const entry = registryEntries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`account entry [${entryId}] not found in accounts.json`);

    let matched = accounts.filter((a) =>
      a.name === entry.quotaKey ||
      a.account === entry.quotaKey ||
      a.label === entry.quotaKey ||
      a.name?.includes(entry.quotaKey) ||
      a.account?.includes(entry.quotaKey) ||
      a.name?.includes(entry.id)
    );

    if (matched.length === 0) {
      const parts = entry.id.split('-');
      const num = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(num)) {
        const familyMap = { gemini: 'antigravity', codex: 'codex', claude: 'claude', opencode: 'opencode', cursor: 'cursor' };
        const providerTarget = familyMap[entry.family] ?? entry.family;
        const familyAccounts = accounts.filter((a) => a.name.split('-')[0] === providerTarget);
        if (familyAccounts[num - 1]) {
          matched = [familyAccounts[num - 1]];
        }
      }
    }
    accounts = matched;
  }

  const rows = await Promise.all(accounts.map(async (a) => {
    const provider = a.name.split('-')[0];
    const base = { provider, account: a.label ?? a.account ?? a.name };
    if (a.disabled) return { ...base, flag: 'OFF', detail: 'disabled in CLIProxyAPI', remaining: null, resetAt: null, models: null };
    const cooldowns = typeof a.cooldowns === 'string' ? JSON.parse(a.cooldowns || '[]') : a.cooldowns ?? [];
    if (cooldowns.length) return { ...base, flag: 'COOLDOWN', detail: `in cooldown (${JSON.stringify(cooldowns).slice(0, 80)})`, remaining: null, resetAt: null, models: null };
    const check = PROVIDERS[provider];
    if (!check) return { ...base, flag: 'n/a', detail: `no quota endpoint for ${provider}; ${a.failed ? `${a.failed} recent failures` : 'healthy'}`, remaining: null, resetAt: null, models: null };
    try { return { ...base, ...(await check(a)) }; } catch (e) { return { ...base, flag: 'DOWN', detail: e.message, remaining: null, resetAt: null, models: null }; }
  }));
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  const order = { AUTH: 0, OUT: 1, DOWN: 2, COOLDOWN: 3, LOW: 4, OFF: 5, OK: 6, 'n/a': 7 };
  rows.sort((x, y) => (order[x.flag] ?? 9) - (order[y.flag] ?? 9) || x.provider.localeCompare(y.provider));
  for (const r of rows) console.log(`${r.flag.padEnd(8)} ${r.provider.padEnd(12)} ${r.account.padEnd(28)} ${r.detail}`);
  const bad = rows.filter((r) => ['AUTH', 'OUT', 'DOWN', 'COOLDOWN'].includes(r.flag));
  console.log(`\n${rows.length} accounts, ${rows.filter((r) => r.flag === 'OK').length} OK, ${bad.length} need you`);
}

main().catch((e) => { console.error(`quota: ${e.message}`); process.exit(1); });
