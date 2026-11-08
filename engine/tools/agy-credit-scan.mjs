#!/usr/bin/env node
// Reads the REAL credit state of each saved agy account. A ping cannot show it: an account can answer a tiny
// call and still be "Out of credits" for real work. The agy status bar prints "AI: <state>", so this opens agy in a
// Herdr pane for each account, waits for the bar, reads it and closes the pane.
//
//   node .agent-hub/tools/agy-credit-scan.mjs [--accounts a,b,c] [--wait 16] [--pick]
//
//   --pick   switch agy to the first account whose bar is not "Out of credits", and print its name
//
// It switches the machine-wide agy login while it runs, so no agy agent should start during the scan (the keeper
// is paused for agy automatically while recent agy jobs are marked QUOTA). The original login is put back if --pick is not given.
// Needs: agent-accounts (use / list) and the herdr CLI. Prints one line per account:  name  <bar text>  CREDITS|OUT|UNKNOWN
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: agy-credit-scan.mjs [--accounts a,b] [--wait 16] [--pick]   reads the agy status bar of each saved account (AI: credits state)');
  process.exit(0);
}

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HUB, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const WAIT = Number(arg('wait', 16)) * 1000;
const PICK = process.argv.includes('--pick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AA = process.env.AGENT_ACCOUNTS_BIN || 'agent-accounts';
const aa = (...a) => execFileSync(AA, a, { encoding: 'utf8', timeout: 90000, shell: process.platform === 'win32', windowsHide: true });
const herdr = (a, t = 20000) => { const raw = execFileSync('herdr', a, { encoding: 'utf8', timeout: t, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); try { return JSON.parse(raw); } catch { return { raw }; } };

let names = (arg('accounts', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!names.length) {
  const out = aa('list', 'agy');
  names = out.split(/\r?\n/).map((l) => l.match(/^\s{2}(\S+)\s/)).filter(Boolean).map((m) => m[1]);
}
let ws = null;
try { ws = JSON.parse(execFileSync(process.execPath, ['-e', 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(s.workspace_id))', path.join(HUB, 'runs', 'herdr-state.json')], { encoding: 'utf8' })); } catch {}
if (!ws) { console.error('no Herdr workspace in .agent-hub/runs/herdr-state.json: start Herdr first'); process.exit(2); }

const results = [];
let original = null;
try { original = (execFileSync('powershell', ['-NoProfile', '-File', path.join(HUB, 'tools', 'agy-profiles.ps1')], { encoding: 'utf8', timeout: 60000 }).match(/signed in as:\s*(\S+)/) || [])[1] ?? null; } catch {}

for (const name of names) {
  let tab = null;
  try {
    aa('use', 'agy', name);
    const r = herdr(['tab', 'create', '--workspace', ws, '--label', `credits-${name}`, '--cwd', ROOT]).result;
    tab = r.tab.tab_id;
    herdr(['pane', 'run', r.root_pane.pane_id, 'agy']);
    await sleep(WAIT);
    const text = String(herdr(['pane', 'read', r.root_pane.pane_id, '--lines', '60'])?.raw ?? '');
    const bar = (text.match(/AI:\s*([^\n\r│|]{1,40})/) || [])[1]?.trim() ?? '';
    const state = /out of credits/i.test(bar) ? 'OUT' : bar ? 'CREDITS' : 'UNKNOWN';
    results.push({ name, bar, state });
    console.log(`${name.padEnd(14)} ${(bar || '(no AI: line seen)').padEnd(30)} ${state}`);
  } catch (e) {
    results.push({ name, bar: '', state: 'ERROR' });
    console.log(`${name.padEnd(14)} ERROR ${String(e.message).split('\n')[0].slice(0, 80)}`);
  } finally {
    if (tab) { try { herdr(['tab', 'close', tab]); } catch {} }
  }
}

const best = results.find((r) => r.state === 'CREDITS');
if (PICK && best) { aa('use', 'agy', best.name); console.log(`PICKED ${best.name}`); }
else if (!PICK) console.log(`agy login left on the last account scanned (it was ${original ?? 'unknown'} before): run agent-accounts use agy <name> to choose`);
console.log(best ? `first account with credits: ${best.name}` : 'no account with credits');
