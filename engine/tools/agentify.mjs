#!/usr/bin/env node
// One command to put a repo under multi-machine agents, or to join a machine to one already set up.
//
//   node agentify.mjs [repoDir] [--lead <machine>] [--group "WhatsApp group name"] [--no-push]
//
// Idempotent; every step is skipped when already done:
//   1. hub        reuse .hub/ (or a kit .agent-hub/), else install the kit into .hub/
//   2. lanes      executors.json from ~/.config/agent-hub/executors.json when present (your routing)
//   3. board+sync tools/board-upgrade.mjs --enable (GitHub board, multi-machine sync)
//   4. brain      sync.mjs brain-link when origin has a brain branch, else brain-init
//   5. WhatsApp   project group with you in it (wa.mjs), lead machine = --lead
//   6. commit     the hub files, then push the current branch (unless --no-push)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('usage: node agentify.mjs [repoDir] [--lead <machine>] [--group "WhatsApp group name"] [--no-push]');
  process.exit(0);
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const lead = opt('--lead');
const groupName = opt('--group');
const push = !args.includes('--no-push');
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...o }).trim();
const node = (a) => run(process.execPath, a);
const step = (n, s) => console.log(`${n}. ${s}`);

run('git', ['rev-parse', '--show-toplevel']);
const repo = path.basename(ROOT);

// 1. hub
const isKitHub = (d) => fs.existsSync(path.join(ROOT, d, 'dispatch.mjs')) && fs.existsSync(path.join(ROOT, d, 'config.json'));
let HUB = ['.hub', '.agent-hub'].find(isKitHub);
const created = [];
if (HUB) step(1, `hub found in ${HUB}/`);
else {
  HUB = '.hub';   // an older hub in .agent-hub/ stays untouched as history
  const before = new Set(run('git', ['status', '--porcelain', '--untracked-files=all']).split('\n'));
  node([path.join(ENGINE, 'init.mjs'), '--pack', 'generic', '--name', repo, '--dir', HUB]);
  for (const l of run('git', ['status', '--porcelain', '--untracked-files=all']).split('\n')) if (l && !before.has(l)) created.push(l.slice(3));
  // Instruction files the kit wrote must point at the hub folder actually used.
  for (const f of created.filter((f) => /^(CLAUDE|AGENTS|GEMINI)\.md$/.test(f))) {
    const p = path.join(ROOT, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('.agent-hub/', `${HUB}/`));
  }
  step(1, `hub installed in ${HUB}/ (${created.length} new files)`);
}

// 2. lanes
const routing = path.join(os.homedir(), '.config', 'agent-hub', 'executors.json');
if (fs.existsSync(routing) && created.some((f) => f.startsWith(`${HUB}/`))) {
  fs.copyFileSync(routing, path.join(ROOT, HUB, 'executors.json'));
  step(2, `lanes from ${routing}`);
} else step(2, 'lanes kept as they are');

// 3. board + sync
node([path.join(ENGINE, 'tools', 'board-upgrade.mjs'), path.join(ROOT, HUB), ENGINE, '--enable']);
step(3, 'board + multi-machine sync enabled');

// 4. brain
try {
  spawnSync('git', ['fetch', '-q', 'origin'], { cwd: ROOT, windowsHide: true });
  const hasBrain = spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/brain'], { cwd: ROOT, windowsHide: true }).status === 0;
  const brain = node([path.join(ROOT, HUB, 'sync.mjs'), hasBrain ? 'brain-link' : 'brain-init']).split('\n').pop();
  step(4, `${hasBrain ? 'joined' : 'started'} the shared brain: ${brain}`);
} catch (e) {
  step(4, `shared brain initialization deferred (${e.message.split('\n')[0]})`);
}

// 5. WhatsApp
const wa = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');
const key = repo.toLowerCase();
if (!fs.existsSync(wa)) step(5, 'WhatsApp skipped (no ~/.config/waha/wa.mjs on this machine)');
else {
  const projects = path.join(os.homedir(), '.config', 'waha', 'projects.json');
  const have = fs.existsSync(projects) && JSON.parse(fs.readFileSync(projects, 'utf8'))[key];
  if (have) step(5, `WhatsApp group already set for ${key}`);
  else step(5, run(process.execPath, [wa, 'group', key, groupName ?? `🤖 ${repo} · agents`, ...(lead ? ['--lead', lead] : [])]));
}

// 6. commit + push
const paths = [HUB, ...created.filter((f) => !f.startsWith(`${HUB}/`))];
run('git', ['add', '--', ...paths]);
if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT, windowsHide: true }).status !== 0) {
  run('git', ['commit', '-q', '-m', 'chore(hub): agents setup (hub kit, shared board, multi-machine sync)']);
  step(6, `committed ${run('git', ['log', '--oneline', '-1'])}`);
} else step(6, 'nothing new to commit');
if (push) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const r = spawnSync('git', ['push', '-q', 'origin', `HEAD:${branch}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  console.log(r.status === 0 ? `   pushed ${branch}` : `   push failed: ${r.stderr.trim().split('\n')[0]}`);
}
console.log(`\nDone. Other machines: clone the repo, then run this same command there to join.`);
