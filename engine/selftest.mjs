#!/usr/bin/env node
// Self-test for the agent-hub kit. Scaffolds a throwaway workspace in the OS temp dir, then exercises
// the hub, dispatch, autoloop and gen-tasks without network access or real executor launches.
// Usage: node selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ENGINE = HERE;
let failed = 0;
let ran = 0;

function step(name, fn) {
  ran++;
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${String(e.message ?? e).split('\n')[0]}`); }
}

function node(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`${path.basename(script)} ${args.join(' ')} exit ${r.status}: ${out.trim().split('\n')[0]}`);
  return out;
}

function expect(text, re, what) {
  if (!re.test(text)) throw new Error(`expected ${what}, got: ${text.trim().split('\n').slice(-1)[0] || '(empty)'}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-selftest-'));
const hub = path.join(tmp, '.agent-hub', 'hub.mjs');
const hubCmd = (agent, ...a) => node(hub, [...a, '--agent', agent], tmp);

try {
  step('init scaffolds a generic workspace', () => {
    const out = node(path.join(ENGINE, 'init.mjs'), ['--pack', 'generic', '--name', 'selftest', '--target', tmp], tmp);
    expect(out, /Done\./, 'the init summary');
    for (const f of ['hub.mjs', 'dispatch.mjs', 'autoloop.mjs', 'accept.mjs', 'executors.json', 'config.json', 'PROTOCOL.md', 'tools/gen-tasks.mjs']) {
      if (!fs.existsSync(path.join(tmp, '.agent-hub', f))) throw new Error(`missing .agent-hub/${f}`);
    }
    if (!fs.existsSync(path.join(tmp, 'AGENTS.md'))) throw new Error('missing AGENTS.md');
  });

  step('hub join/add/claim/done/accept', () => {
    hubCmd('orchestrator', 'join', '--role', 'orchestrator', '--tool', 'cli');
    hubCmd('orchestrator', 'add', 'K-selftest', '--phase', 'chore', '--title', 'selftest task', '--scope', 'src/');
    hubCmd('worker-1', 'join', '--role', 'worker', '--tool', 'cli');
    hubCmd('worker-1', 'claim', 'K-selftest', '--files', 'src/demo.ts');
    hubCmd('worker-1', 'done', 'K-selftest', '--summary', 'selftest delivered', '--files', 'src/demo.ts', '--verify', 'node selftest -> PASS');
    hubCmd('orchestrator', 'accept', 'K-selftest', '--note', 'selftest accept');
    const shown = hubCmd('orchestrator', 'show', 'K-selftest');
    expect(shown, /"status": "ACCEPTED"/, 'the task to be ACCEPTED');
  });

  step('dispatch list --all', () => {
    const out = node(path.join(tmp, '.agent-hub', 'dispatch.mjs'), ['list', '--all'], tmp);
    if (!/no jobs yet|RUNNING|DONE/.test(out)) throw new Error(`unexpected output: ${out.trim()}`);
  });

  step('autoloop --once --dry', () => {
    const out = node(path.join(tmp, '.agent-hub', 'autoloop.mjs'), ['--once', '--dry'], tmp);
    expect(out, /DIGEST/, 'a digest line');
  });

  step('gen-tasks on a 2-row sample plan', () => {
    const plan = path.join(tmp, 'plan.md');
    fs.writeFileSync(plan, [
      '# Sample plan', '',
      '| Task | Files | Deps | Brief |',
      '|---|---|---|---|',
      '| `S-sample-one` | `src/one.ts` | — | first sample task |',
      '| `S-sample-two` | `src/two.ts` | `S-sample-one` | second sample task |', '',
    ].join('\n'));
    const out = node(path.join(tmp, '.agent-hub', 'tools', 'gen-tasks.mjs'), ['plan.md', 'S-', '--exec', 'demo-builder', '--light', 'demo-builder'], tmp);
    expect(out, /2 tasks added/, 'two generated tasks');
    const queue = JSON.parse(fs.readFileSync(path.join(tmp, '.agent-hub', 'autoloop-queue.json'), 'utf8'));
    if (queue['S-sample-one'] !== 'demo-builder' || queue['S-sample-two'] !== 'demo-builder') throw new Error('queue entries missing');
    const brief = fs.readFileSync(path.join(tmp, '.agent-hub', 'tasks', 'S-sample-two.md'), 'utf8');
    expect(brief, /Allowed scope: .*src\/two\.ts/, 'the scope line in the brief');
    expect(brief, /S-sample-one/, 'the dependency in the brief');
  });

  step('init with --dir .agent-hub-orch', () => {
    const orchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-orch-'));
    try {
      const out = node(path.join(ENGINE, 'init.mjs'), ['--pack', 'generic', '--name', 'orch-test', '--dir', '.agent-hub-orch', '--target', orchTmp], orchTmp);
      expect(out, /Done\./, 'init summary with custom dir');
      if (!fs.existsSync(path.join(orchTmp, '.agent-hub-orch', 'hub.mjs'))) throw new Error('missing .agent-hub-orch/hub.mjs');
      const cfg = JSON.parse(fs.readFileSync(path.join(orchTmp, '.agent-hub-orch', 'config.json'), 'utf8'));
      if (cfg.hubDir !== '.agent-hub-orch') throw new Error('hubDir not updated in config.json');
    } finally {
      fs.rmSync(orchTmp, { recursive: true, force: true });
    }
  });

  step('non-overwriting scaffold', () => {
    const sentinel = path.join(tmp, 'AGENTS.md');
    fs.writeFileSync(sentinel, '# Custom AGENTS\n');
    const out = node(path.join(ENGINE, 'init.mjs'), ['--pack', 'generic', '--name', 'selftest', '--target', tmp], tmp);
    const content = fs.readFileSync(sentinel, 'utf8');
    if (content !== '# Custom AGENTS\n') throw new Error('existing AGENTS.md was overwritten');
    expect(out, /SKIP\s+AGENTS\.md/, 'skip logged for existing file');
  });

  step('each tool supports --help', () => {
    const toolsDir = path.join(tmp, '.agent-hub', 'tools');
    for (const f of fs.readdirSync(toolsDir)) {
      if (!f.endsWith('.mjs') || f === 'runtime.mjs') continue;
      const out = node(path.join(toolsDir, f), ['--help'], tmp);
      expect(out, /usage:/i, `${f} --help output`);
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} steps passed`);
process.exit(failed ? 1 : 0);
