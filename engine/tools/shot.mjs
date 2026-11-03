#!/usr/bin/env node
// shot.mjs: screenshot a page with the headless Chromium that Playwright already cached on the machine. No new install.
//   node shot.mjs <route-or-url> <out.png> [--width 390] [--height 844] [--full]
// A route (/dashboard/students) is joined to SHOT_BASE_URL (default http://localhost:3401).
// Exit 2 with a plain sentence when the page is not reachable, so the manager can tell the owner why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { help } from './runtime.mjs';

help('usage: shot.mjs <route-or-url> <out.png> [--width 390] [--height 844] [--full]');

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--full'));
const [target, out] = pos;
if (!target || !out) { console.error('usage: shot.mjs <route-or-url> <out.png>'); process.exit(1); }

const base = (process.env.SHOT_BASE_URL || 'http://localhost:3401').replace(/\/$/, '');
const url = /^https?:\/\//.test(target) ? target : `${base}${target.startsWith('/') ? '' : '/'}${target}`;
const width = Number(flag('--width', 1280));
const height = Number(flag('--height', args.includes('--full') ? 3000 : 800));

const find = () => {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(cache).filter((d) => /^chromium_headless_shell-/.test(d)).sort().reverse()) {
      const sub = fs.readdirSync(path.join(cache, dir)).find((d) => d.startsWith('chrome-'));
      const bin = sub && path.join(cache, dir, sub, os.platform() === 'win32' ? 'headless_shell.exe' : 'headless_shell');
      if (bin && fs.existsSync(bin)) return bin;
    }
  } catch { /* no cache */ }
  return null;
};

const bin = find();
if (!bin) { console.error('No headless browser is installed on this machine (Playwright chromium_headless_shell missing).'); process.exit(2); }

// Is the page up? Fail with a clear sentence instead of saving a picture of an error page.
const probe = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.status<500?0:3)).catch(()=>process.exit(4))`]);
if (probe.status !== 0) { console.error(`The page ${url} is not reachable from this machine (the app is not running there).`); process.exit(2); }

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const r = spawnSync(bin, ['--no-sandbox', '--disable-gpu', '--headless', '--hide-scrollbars', '--virtual-time-budget=6000', `--window-size=${width},${height}`, `--screenshot=${path.resolve(out)}`, url], { encoding: 'utf8', timeout: 60_000 });
if (r.status !== 0 || !fs.existsSync(out)) { console.error(`Screenshot failed: ${String(r.stderr ?? '').trim().slice(-200)}`); process.exit(1); }
console.log(`saved ${out}`);
