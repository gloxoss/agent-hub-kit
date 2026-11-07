// agy-rotate (Windows): run agy with the first saved account profile that still has quota.
// Same logic as ~/.local/bin/agy-rotate on the VPS, but the login swap goes through Windows Credential Manager
// (agy-profiles.ps1). A profile that reports a limit or a signed-out state is skipped for 30 minutes.
// Output is STREAMED live (the hub watches the log to see that the job is alive). Rotation to the next account only
// happens when the limit shows up before any real output was produced (limit errors come at the start of a call).
// Usage: agy-rotate <any agy arguments>     |  env AGY_ROTATE_VERBOSE=1 prints which profile is used (stderr)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { console.log('Usage: agy-rotate <any agy arguments>\nRuns agy with the next saved Google profile (see agy-profiles.ps1) and skips one for 30 minutes when a limit or sign-in error appears before real output. Streams output and prints a heartbeat every 60 s. Env AGY_ROTATE_VERBOSE=1 prints the profile used.'); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, 'agy-profiles.ps1');
const coolDir = path.join(os.homedir(), '.agy-profiles');
const COOL_MS = 30 * 60 * 1000;
const LIMIT = /quota|rate.?limit|resource.?exhausted|usage limit|please sign in|not signed in|429/i;
const EARLY_BYTES = 4000; // a limit message with less output than this means "nothing useful was produced yet"
fs.mkdirSync(coolDir, { recursive: true });

const ps = (...a) => spawnSync('powershell', ['-NoProfile', '-File', tool, ...a], { encoding: 'utf8' });
const names = ps('names').stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const args = process.argv.slice(2);

if (!names.length) { // no saved profiles: behave exactly like plain agy
  const r = spawnSync('agy', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// Start from the profile after the one used last, so load spreads across accounts.
const lastFile = path.join(coolDir, '.last');
const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '';
const start = (names.indexOf(last) + 1) % names.length;
const order = names.map((_, i) => names[(start + i) % names.length]);

function runOnce(profile) {
  return new Promise((resolve) => {
    const child = spawn('agy', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const t0 = Date.now();
    // Heartbeat every 60 s as a JSON line: the hub log then shows the job is alive even while agy is silent.
    const beat = setInterval(() => {
      process.stdout.write(JSON.stringify({ type: 'heartbeat', source: 'agy-rotate', profile, elapsed_s: Math.round((Date.now() - t0) / 1000), agy_bytes: bytes, at: new Date().toISOString().slice(11, 16) }) + '\n');
    }, 60000);
    child.on('close', () => clearInterval(beat));
    let bytes = 0;
    let tail = '';
    let held = []; // chunks held back while we are still unsure whether this is a limit message
    let released = false;
    const release = () => { if (released) return; released = true; for (const c of held) c.out.write(c.d); held = []; };
    const onData = (out) => (d) => {
      bytes += d.length;
      tail = (tail + d.toString('utf8')).slice(-6000);
      if (released) { out.write(d); return; }
      held.push({ out, d });
      if (bytes > EARLY_BYTES) release(); // real output is flowing: stream it from now on
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    child.on('close', (code) => resolve({ code: code ?? 0, bytes, tail, released, release }));
  });
}

let lastMsg = '';
for (const name of order) {
  const mark = path.join(coolDir, `.cool-${name}`);
  if (fs.existsSync(mark) && Date.now() - fs.statSync(mark).mtimeMs < COOL_MS) continue;
  const sw = ps('use', name);
  if (sw.status !== 0) { fs.writeFileSync(mark, ''); lastMsg = (sw.stderr || '').slice(0, 160); continue; }
  if (process.env.AGY_ROTATE_VERBOSE) console.error(`agy-rotate: using profile ${name}`);
  const r = await runOnce(name);
  if (!r.released && LIMIT.test(r.tail) && (r.code !== 0 || r.bytes < EARLY_BYTES)) { // limit before real output: try the next account
    fs.writeFileSync(mark, '');
    lastMsg = r.tail.slice(0, 200);
    continue;
  }
  r.release(); // flush anything still held (short successful outputs)
  fs.writeFileSync(lastFile, name);
  process.exit(r.code);
}
console.error(`agy-rotate: every saved agy account is at its limit or signed out. Last message: ${lastMsg}`);
process.exit(75);
