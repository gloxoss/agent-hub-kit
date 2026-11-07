#!/usr/bin/env node
// Runs the zero-template-coupling verifier and fails ONLY for violations inside this task's own files.
// The plain verifier scans the whole feature folder, so one old file would fail every task of a program.
//
//   node .agent-hub/tools/coupling-check.mjs <site> --task <TASK-ID>     files = the task's hub scope
//   node .agent-hub/tools/coupling-check.mjs <site> --files "a,b,c"      files given by hand (substring match)
//
// Exit 0 = no violation in the task's files (violations elsewhere are listed as "outside this task"). Exit 1 = violation in the task's files.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length < 4) {
  console.log('usage: coupling-check.mjs <site> --task <TASK-ID> | --files "a,b"   (fails only for violations in the task\'s own files)');
  process.exit(process.argv.length < 4 ? 2 : 0);
}

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HUB, '..');
const site = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };

let mine = [];
if (arg('task')) {
  const out = execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), 'show', arg('task')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENT_ID: 'orchestrator' } });
  mine = JSON.parse(out).scope ?? [];
} else if (arg('files')) {
  mine = arg('files').split(',').map((s) => s.trim()).filter(Boolean);
} else { console.error('give --task or --files'); process.exit(2); }
const norm = (p) => p.replace(/\\/g, '/');
const inMine = (file) => mine.some((m) => norm(file).includes(norm(m).replace(/\/$/, '')));

let report;
try {
  const verifier = path.join(ROOT, '.agents/skills/template-to-atomic-react-gsap/scripts/verify-zero-template-coupling.mjs');
  let text;
  try { text = execFileSync(process.execPath, [verifier, site], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); }
  catch (e) { text = String(e.stdout ?? ''); }
  report = JSON.parse(text);
} catch (e) { console.error('could not read the verifier output: ' + e.message); process.exit(2); }

const mineHits = [];
const otherHits = [];
const add = (kind, item) => {
  const file = typeof item === 'string' ? item : item.file;
  (file && inMine(file) ? mineHits : otherHits).push(`${kind}: ${file ?? JSON.stringify(item)}${item.matches ? ' ' + item.matches.join(' ') : ''}`);
};
for (const [kind, list] of [...Object.entries(report.couplingChecks ?? {}), ...Object.entries(report.architectureGates ?? {})]) {
  if (Array.isArray(list)) for (const item of list) add(kind, item);
}
console.log(`task files checked: ${mine.length}`);
console.log(`violations outside this task (not blamed): ${otherHits.length}`);
if (mineHits.length) { console.log('VIOLATIONS IN THIS TASK\'S FILES:'); for (const h of mineHits) console.log('  ' + h); process.exit(1); }
console.log('no violation in this task\'s files');
