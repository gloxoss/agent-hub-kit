#!/usr/bin/env node
// Keeps several machines working on one repo in step. Never touches files agents are editing.
//   node .hub/sync.mjs brain-init      one time per repo: put this machine's Claude memory on an
//                                      orphan branch "brain" (or join it if it already exists)
//   node .hub/sync.mjs brain-link      on every other machine: check out "brain" and link Claude's
//                                      memory folder for this repo to it
//   node .hub/sync.mjs run             brain: commit + pull --rebase + push (its own worktree only)
//                                      code: fetch; fast-forward when safe; push local commits;
//                                      rebase only when the tree is clean. Prints one line per action.
// The autoloop calls `run` every config.sync.minutes when config.sync.enabled is true.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HUB = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.dirname(HUB);
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
const REPO = path.basename(ROOT);
const BRAIN = path.join(os.homedir(), '.devbox-brain', REPO);
const BRANCH = 'brain';

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const tryGit = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };

// Claude keeps per-project memory in ~/.claude/projects/<path with every non-alphanumeric as ->/memory.
// Windows drive letters show up in either case, so every matching folder is linked.
function memoryDirs() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const slug = ROOT.replace(/[^A-Za-z0-9]/g, '-');
  const found = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.toLowerCase() === slug.toLowerCase()) : [];
  return (found.length ? found : [slug]).map((d) => path.join(base, d, 'memory'));
}
function link(dir) {
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
  if (real && path.resolve(real) === path.resolve(BRAIN)) return;
  if (real) {
    // Fold existing memory files into the brain before replacing the folder with a link.
    for (const f of fs.readdirSync(dir)) if (!fs.existsSync(path.join(BRAIN, f))) fs.copyFileSync(path.join(dir, f), path.join(BRAIN, f));
    fs.renameSync(dir, `${dir}.bak-${Date.now()}`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(BRAIN, dir, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`linked ${dir} -> ${BRAIN}`);
}
function brainCommit(msg) {
  git(['add', '-A'], BRAIN);
  if (tryGit(['diff', '--cached', '--quiet'], BRAIN) === null) git(['commit', '-q', '-m', msg], BRAIN);
}

const cmd = process.argv[2];
if (cmd === 'brain-init' || cmd === 'brain-link') {
  git(['fetch', '-q', 'origin']);
  const remote = tryGit(['rev-parse', '--verify', `origin/${BRANCH}`]);
  if (!fs.existsSync(BRAIN)) {
    fs.mkdirSync(path.dirname(BRAIN), { recursive: true });
    if (remote) git(['worktree', 'add', '-q', BRAIN, '-B', BRANCH, `origin/${BRANCH}`]);
    else if (cmd === 'brain-init') {
      git(['worktree', 'add', '-q', '--detach', BRAIN]);
      git(['checkout', '-q', '--orphan', BRANCH], BRAIN);
      git(['rm', '-rq', '--cached', '.'], BRAIN);
      for (const f of fs.readdirSync(BRAIN)) if (f !== '.git') fs.rmSync(path.join(BRAIN, f), { recursive: true, force: true });
    } else throw new Error('no brain branch on origin yet: run brain-init on the machine that has the memory');
  }
  // Two machines appending to the index at once merge cleanly instead of conflicting.
  fs.writeFileSync(path.join(BRAIN, '.gitattributes'), 'MEMORY.md merge=union\n');
  for (const d of memoryDirs()) link(d);
  brainCommit(`brain: ${cmd === 'brain-init' ? 'start' : 'join'} from ${NODE}`);
  git(['push', '-q', '-u', 'origin', BRANCH], BRAIN);
  console.log(`brain ready at ${BRAIN} (${fs.readdirSync(BRAIN).filter((f) => f.endsWith('.md')).length} memory files)`);
} else if (cmd === 'run') {
  const say = (s) => console.log(`SYNC ${NODE}: ${s}`);
  if (fs.existsSync(path.join(BRAIN, '.git'))) {
    try {
      brainCommit(`brain: update from ${NODE}`);
      git(['pull', '-q', '--rebase', 'origin', BRANCH], BRAIN);
      if (git(['rev-list', '--count', `origin/${BRANCH}..HEAD`], BRAIN) !== '0') { git(['push', '-q', 'origin', BRANCH], BRAIN); say('brain pushed'); }
    } catch (e) { tryGit(['rebase', '--abort'], BRAIN); say(`brain sync failed: ${String(e.stderr || e.message).split('\n')[0]}`); }
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const up = tryGit(['rev-parse', '--abbrev-ref', '@{u}']) ?? `origin/${branch}`;
  if (tryGit(['fetch', '-q', 'origin', branch]) === null) { say(`fetch of ${branch} failed`); process.exit(0); }
  const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...${up}`]).split(/\s+/).map(Number);
  const clean = git(['status', '--porcelain', '--untracked-files=no']) === '';
  if (behind && !ahead) {
    // Fast-forward keeps uncommitted agent edits; git refuses only if an incoming change touches one.
    say(tryGit(['merge', '-q', '--ff-only', up]) === null ? `behind ${behind}: fast-forward blocked by local edits, will retry` : `pulled ${behind} commit(s)`);
  } else if (behind && ahead) {
    if (!clean) say(`diverged (${ahead} local, ${behind} remote): waiting for a clean tree to rebase`);
    else if (tryGit(['rebase', '-q', up]) === null) { tryGit(['rebase', '--abort']); say(`diverged: rebase conflicts, needs the orchestrator`); }
    else say(`rebased ${ahead} local commit(s) onto ${behind} remote`);
  }
  const [aheadNow] = git(['rev-list', '--left-right', '--count', `HEAD...${up}`]).split(/\s+/).map(Number);
  if (aheadNow && tryGit(['rev-list', '--count', `${up}..HEAD`]) && (behind === 0 || clean)) {
    say(tryGit(['push', '-q', 'origin', `HEAD:${branch}`]) === null ? 'push failed' : `pushed ${aheadNow} commit(s)`);
  }
} else {
  console.log('usage: sync.mjs brain-init | brain-link | run   (see the header of this file)');
}
