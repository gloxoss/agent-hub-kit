#!/usr/bin/env node
// Serialize memory-heavy commands across agents. Run: node <hub>/tools/heavy.mjs <command> [args...].
import { spawn } from 'node:child_process';
import { ROOT, lock, help } from './runtime.mjs';

help('usage: heavy.mjs <command> [args...] (one command at a time per hub)');
const args = process.argv.slice(2);
if (!args.length) { console.error('usage: heavy.mjs <command> [args...]'); process.exit(1); }
const release = lock('heavy', 45 * 60_000);
// cmd launchers need a shell on Windows; quote every argument and suppress expansion.
const quote = (s) => {
  if (/[\r\n"%]/.test(s)) throw new Error('heavy: Windows arguments cannot contain quotes, newlines or percent expansion');
  return `"${s}"`;
};
const windows = process.platform === 'win32';
const child = spawn(windows ? args.map(quote).join(' ') : args[0], windows ? [] : args.slice(1), { cwd: ROOT, stdio: 'inherit', shell: windows, windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('error', (error) => { console.error(error.message); release(); process.exitCode = 1; });
child.on('exit', (code) => { release(); process.exitCode = code ?? 1; });
