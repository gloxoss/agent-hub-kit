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

  step('orchestrator modules pass their own checks', () => {
    const code = `
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const dir = process.argv[1];
      let ok = true;
      for (const m of ['reply', 'select', 'prompt', 'commands', 'report', 'events', 'telemetry', 'burn','jobs-view', '../accounts']) {
        const mod = await import(pathToFileURL(path.join(dir, 'orchestrator', m + '.mjs')).href);
        const fn = mod.runSelfTest ?? mod.runFixtureTest;
        if (!fn) { console.error('NO TEST ' + m); ok = false; continue; }
        const quiet = console.log; console.log = () => {};
        let r; try { r = await fn(); } catch (e) { r = false; }
        console.log = quiet;
        if (r === false) { console.error('FAILED ' + m); ok = false; }
      }
      process.exit(ok ? 0 : 1);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, HERE], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`module self-tests failed: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  });

  step('driver v2 dry cycle picks a manager and builds its command', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-dry-'));
    try {
      fs.mkdirSync(path.join(work, '.hub', 'runs'), { recursive: true });
      fs.writeFileSync(path.join(work, '.hub', 'config.json'), JSON.stringify({ name: 'dry-demo' }));
      fs.copyFileSync(path.join(HERE, 'accounts.example.json'), path.join(work, '.hub', 'accounts.json'));
      const r = spawnSync(process.execPath, [path.join(HERE, 'tools', 'orch-driver.mjs'), work, '--say', 'status?', '--no-wa'], { encoding: 'utf8', env: { ...process.env, ORCH_DRY: '1' } });
      const out = `${r.stdout}${r.stderr}`;
      if (!/\[ORCH_DRY\] runTurn command: /.test(out)) throw new Error(`no dry command printed: ${out.slice(0, 200)}`);
      if (!/claude-ag2[\s\S]*--model gemini-3-flash/.test(out) && !/codex exec|claude[\s\S]*--model sonnet|claude-ag2[\s\S]*--model claude-sonnet/.test(out)) throw new Error(`unexpected manager: ${out.slice(0, 200)}`);
      const cmd = spawnSync(process.execPath, [path.join(HERE, 'tools', 'orch-driver.mjs'), work, '--cmd', 'status', '--no-wa'], { encoding: 'utf8', env: { ...process.env, ORCH_DRY: '1' } });
      if (!/On duty:/.test(cmd.stdout)) throw new Error(`/orch status failed: ${cmd.stdout}${cmd.stderr}`.slice(0, 200));
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  });

  step('migration lock refusal and release', () => {
    const isMigOut = node(path.join(tmp, '.agent-hub', 'dispatch.mjs'), ['is-migration'], tmp);
    expect(isMigOut, /F1.*isMigration: true/, 'F1 phase migration');
    expect(isMigOut, /F2.*isMigration: true/, 'F2 drizzle/ scope');
    expect(isMigOut, /F3.*isMigration: false/, 'F3 normal scope');

    const runsDir = path.join(tmp, '.agent-hub', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const logPath = path.join(runsDir, 'fake-migration.log');
    fs.writeFileSync(logPath, 'running\n');

    const jobsFile = path.join(runsDir, 'jobs.jsonl');
    const fakeJob = {
      id: 'fake-job-1',
      t: new Date().toISOString(),
      mode: 'run',
      executor: 'opencode',
      agentId: 'builder-1',
      taskId: 'M-test',
      pid: process.pid,
      log: 'runs/fake-migration.log'
    };
    fs.writeFileSync(jobsFile, JSON.stringify(fakeJob) + '\n');

    const lockFile = path.join(runsDir, 'migration.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ task: 'M-test', pid: process.pid, t: new Date().toISOString() }));

    hubCmd('orchestrator', 'add', 'K-normal', '--phase', 'build', '--title', 'normal task', '--scope', 'src/demo.ts');

    const r1 = spawnSync(process.execPath, [path.join(tmp, '.agent-hub', 'dispatch.mjs'), 'run', 'opencode', 'builder-1', 'K-normal'], { cwd: tmp, encoding: 'utf8' });
    const out1 = `${r1.stdout ?? ''}${r1.stderr ?? ''}`;
    if (!out1.includes('not dispatched: migration lock (M-test)')) {
      throw new Error(`expected migration lock refusal, got: ${out1}`);
    }

    fs.writeFileSync(logPath, 'running\n[dispatch] exit 0\n');
    try { fs.unlinkSync(lockFile); } catch {}

    const r2 = spawnSync(process.execPath, [path.join(tmp, '.agent-hub', 'dispatch.mjs'), 'run', 'opencode', 'builder-1', 'K-normal'], { cwd: tmp, encoding: 'utf8' });
    const out2 = `${r2.stdout ?? ''}${r2.stderr ?? ''}`;
    if (out2.includes('not dispatched: migration lock')) {
      throw new Error(`expected migration lock release, but got refusal: ${out2}`);
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} steps passed`);
process.exit(failed ? 1 : 0);
