#!/usr/bin/env node
// Runs a backend check inside the medusa_backend container, so a task brief can name it as a runnable proof
// (the accept gate only runs commands that start with node, npm, npx, pnpm, git diff or bash).
//
//   node .agent-hub/tools/container-check.mjs tsc
//   node .agent-hub/tools/container-check.mjs jest <path-or-pattern> [more patterns]
//
// Exit code is the check's own. Exit 2 means Docker or the container is not running (the proof was NOT run).
import { execFileSync, spawnSync } from 'node:child_process';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: container-check.mjs tsc | jest <pattern...>   (runs inside the medusa_backend container)');
  process.exit(0);
}

const CONTAINER = process.env.BACKEND_CONTAINER || 'medusa_backend';
const [kind, ...patterns] = process.argv.slice(2);

try {
  const running = execFileSync('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!running.split('\n').includes(CONTAINER)) throw new Error('not running');
} catch {
  console.error(`container-check: ${CONTAINER} is not running (start Docker Desktop and the stack). The check was NOT run.`);
  process.exit(2);
}

let inner;
if (kind === 'tsc') inner = 'cd /server && npx tsc --noEmit -p .';
else if (kind === 'jest' && patterns.length && patterns.every((p) => /^[\w./\\[\]@-]+$/.test(p))) inner = `cd /server && npx jest ${patterns.join(' ')}`;
else {
  console.error('usage: container-check.mjs tsc | jest <pattern...>');
  process.exit(2);
}

const r = spawnSync('docker', ['exec', CONTAINER, 'sh', '-c', inner], { stdio: 'inherit' });
process.exit(r.status ?? 1);
