// Shared paths and locks for hub tools. Import from a tool; paths follow the installed engine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.dirname(HUB);
export const hubDir = path.basename(HUB);
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export const CFG = readJson(path.join(HUB, 'config.json'));
export function projectPath(value) {
  const resolved = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`path outside project: ${value}`);
  return resolved;
}
export const auditPath = (name) => projectPath(CFG.audit?.[name] ?? ({ dir: 'docs/audit', index: 'docs/audit/INDEX.md', fixes: 'docs/audit/FIXES.md', pageReports: 'docs/audit/pages', plans: 'docs/plans' })[name]);
export function help(text) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(text); process.exit(0); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A live holder never expires: a long check must not let another worker through.
export function lock(name, waitMs = 300_000) {
  const runs = path.join(HUB, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, `${name}.lock`);
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!alive(holder.pid)) { fs.unlinkSync(file); continue; }
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        // The creator may still be writing its metadata; never remove a fresh lock.
        try { if (Date.now() - fs.statSync(file).mtimeMs > 60_000) { fs.unlinkSync(file); continue; } } catch {}
      }
      if (Date.now() - start > waitMs) throw new Error(`${name}: lock busy for ${Math.round(waitMs / 1000)}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  const release = () => {
    try { if (readJson(file).token === token) fs.unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return release;
}
