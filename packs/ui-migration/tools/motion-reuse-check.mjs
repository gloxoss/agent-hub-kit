#!/usr/bin/env node
// motion-reuse-check.mjs : gate P4 (reuse). Section files must use the shared motion library, not raw GSAP.
//
//   node tools/motion-reuse-check.mjs <site> [--task <TASK>] [--src "<ui src dir>"] [--lib "@/libs/motion"] [--report]
//
// - Scans <src>/features/<site>/ (hooks, ui) and styles for raw GSAP use: `from 'gsap'`, `from 'gsap/...'`,
//   `gsap.` calls, `ScrollTrigger.` calls. Imports of the shared library (default "@/libs/motion") are fine.
// - With --task, only the files in that hub task's scope are checked (legacy files do not block a new task).
//   Without --task it checks the whole site folder; with --report it prints counts and always exits 0.
// - Exit 1 = at least one violation. Exit 0 = clean.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const site = args[0];
if (!site || site.startsWith('--')) {
  console.log('usage: motion-reuse-check.mjs <site> [--task <TASK>] [--src <ui src dir>] [--lib "@/libs/motion"] [--report]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SRC = path.resolve(opt('--src', 'MORENE UI/src'));
const LIB = opt('--lib', '@/libs/motion');
const task = opt('--task', null);
const report = args.includes('--report');

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
}) : []);

let files;
if (task) {
  const hub = path.resolve('.agent-hub/hub.mjs');
  const out = execFileSync('node', [hub, 'show', task, '--agent', 'orchestrator'], { encoding: 'utf8' });
  const t = JSON.parse(out);
  const scope = (t.scope || t.files || []).map((s) => path.resolve(s));
  files = scope.flatMap((s) => (fs.existsSync(s) && fs.statSync(s).isDirectory() ? walk(s) : [s]));
} else {
  files = walk(path.join(SRC, 'features', site));
}
files = files.filter((f) => /\.(ts|tsx)$/.test(f) && fs.existsSync(f));

const RAW = [
  [/from\s+['"]gsap(\/[^'"]*)?['"]/, "imports gsap directly (use the shared library: " + LIB + ")"],
  [/\bgsap\.(to|from|fromTo|set|timeline|registerPlugin|context|quickTo|utils)\s*\(/, 'calls gsap.* directly'],
  [/\bScrollTrigger\.(create|batch|refresh|matchMedia)\s*\(/, 'calls ScrollTrigger.* directly'],
];
const bad = [];
for (const f of files) {
  // the library itself and its tests are allowed to touch gsap
  if (f.replace(/\\/g, '/').includes('/libs/motion/')) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;
    for (const [re, why] of RAW) if (re.test(ln)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${why}`);
  });
}
console.log(`motion-reuse-check ${site}${task ? ' task ' + task : ''}: ${files.length} file(s), ${bad.length} raw-GSAP use(s)`);
bad.slice(0, 40).forEach((b) => console.log('  ' + b));
if (report) process.exit(0);
process.exit(bad.length ? 1 : 0);
