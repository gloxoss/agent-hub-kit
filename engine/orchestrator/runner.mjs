// runner.mjs: Turn runner supporting Claude, Codex, and OpenCode families with hard limits, sandboxing, and session resumption
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveConfig } from './config.mjs';
import { parseTelemetryEvent } from './telemetry.mjs';
import { isOrchestratorWrite } from './guard.mjs';
import { loadState, saveState } from './state.mjs';

const SECRET_READ_DENIALS = [
  'Read(./.env*)',
  'Read(~/.config/devbox/**)',
  'Read(~/.cli-proxy-api/**)',
  'Read(~/.config/waha/.env)',
  'Read(~/.ssh/**)'
];

const COSTLY_TOOL_DENIALS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'Agent'
];

export function buildClaudeCommand(entry, prompt, session = {}) {
  const bin = entry.buildCmd || entry.name || 'claude';
  const args = [];

  const sid = session.sid || session.sessionId;
  if (sid) {
    args.push('--resume', sid);
  } else {
    args.push('--session-id', session.id || crypto.randomUUID());
  }

  args.push('-p', prompt);
  args.push('--permission-mode', 'auto');
  args.push('--output-format', 'stream-json');
  args.push('--verbose');
  args.push('--max-turns', '25');

  const model = entry.model || (bin.includes('gemini') ? 'gemini-3-flash' : 'sonnet');
  args.push('--model', model);

  if (entry.strictMcpConfig || entry.name?.includes('gemini')) {
    args.push('--strict-mcp-config');
  }

  const isCheap = entry.cost === 'free' || entry.tier >= 3;
  const denials = [...SECRET_READ_DENIALS];
  if (!isCheap) {
    denials.push(...COSTLY_TOOL_DENIALS);
  }

  if (denials.length > 0) {
    args.push('--disallowedTools', denials.join(','));
  }

  return { file: bin, args };
}

export function buildCodexCommand(entry, prompt, session = {}) {
  const bin = entry.buildCmd || 'codex';
  const args = [];
  const sid = session.sid || session.sessionId;
  const cfg = resolveConfig();

  if (sid) {
    args.push('exec', 'resume', sid, '-c', 'sandbox_mode="workspace-write"');
  } else {
    args.push('exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true');
    if (entry.model) {
      args.push('-m', entry.model);
    }
    args.push('-C', cfg.root);
  }
  args.push(prompt);

  return { file: bin, args };
}

export function buildOpenCodeCommand(entry, prompt, session = {}) {
  const bin = entry.buildCmd || 'opencode';
  const args = ['run', '--format', 'json'];

  const model = entry.model || 'opencode/deepseek-v4.1-flash-free';
  args.push('-m', model);

  const sid = session.sid || session.sessionId;
  if (sid) {
    args.push('-s', sid);
  }

  const isCostly = entry.cost === 'plan' || entry.cost === 'user' || entry.cost === 'costly';
  if (isCostly) {
    args.push('--agent', 'plan');
  }

  args.push(prompt);

  return { file: bin, args };
}

export async function runTurn(entry, prompt, session = {}) {
  const cfg = resolveConfig();
  const dry = process.env.ORCH_DRY === '1';

  const family = (entry.family || entry.name || 'claude').toLowerCase();
  let commandInfo;

  if (family.includes('codex')) {
    commandInfo = buildCodexCommand(entry, prompt, session);
  } else if (family.includes('opencode')) {
    commandInfo = buildOpenCodeCommand(entry, prompt, session);
  } else {
    commandInfo = buildClaudeCommand(entry, prompt, session);
  }

  const { file: bin, args } = commandInfo;
  const fullCommandString = [bin, ...args].join(' ');

  if (dry) {
    console.log(`[ORCH_DRY] runTurn command: ${fullCommandString}`);
    return {
      success: true,
      dry: true,
      command: [bin, ...args],
      commandString: fullCommandString,
      events: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      sessionId: session.sid || session.sessionId || 'dry-session-id'
    };
  }

  const home = os.homedir();
  const claudeLaunchers = path.join(home, '.claude-launchers');
  const localBin = path.join(home, '.local', 'bin');
  const currentPath = process.env.PATH || '';
  const extendedPath = `${claudeLaunchers}:${localBin}:${currentPath}`;

  const turnMinutes = cfg.orchestrator?.turnMinutes || 20;
  const silenceMinutes = cfg.orchestrator?.silenceMinutes || 5;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: cfg.root,
        env: { ...process.env, PATH: extendedPath },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true
      });
    } catch (err) {
      return resolve({
        success: false,
        exitCode: -1,
        error: err.message,
        events: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      });
    }

    const events = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let latestUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let killed = false;

    const killProcessTree = () => {
      if (killed) return;
      killed = true;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
        } else {
          process.kill(-child.pid, 'SIGTERM');
          setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }, 3000);
        }
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    };

    const turnTimeoutMs = turnMinutes * 60 * 1000;
    const silenceTimeoutMs = silenceMinutes * 60 * 1000;

    let turnTimer = setTimeout(() => {
      killProcessTree();
      resolve({
        success: false,
        exitCode: -999,
        error: 'turn_timeout_exceeded',
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        events,
        usage: latestUsage
      });
    }, turnTimeoutMs);

    let silenceTimer = setTimeout(() => {
      killProcessTree();
      resolve({
        success: false,
        exitCode: -998,
        error: 'silence_watchdog_exceeded',
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        events,
        usage: latestUsage
      });
    }, silenceTimeoutMs);

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        killProcessTree();
        resolve({
          success: false,
          exitCode: -998,
          error: 'silence_watchdog_exceeded',
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          events,
          usage: latestUsage
        });
      }, silenceTimeoutMs);
    };

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      resetSilenceTimer();
      stdoutBuffer += line + '\n';
      const trimmed = line.trim();
      if (!trimmed) return;

      let obj = null;
      try {
        obj = JSON.parse(trimmed);
      } catch {}

      const isCostly = !(entry.cost === 'free' || entry.tier >= 3);
      if (isCostly) {
        let checkTarget = obj || trimmed;
        if (obj) {
          if (obj.type === 'tool_use' || obj.content_block?.type === 'tool_use' || obj.type === 'item.command' || obj.command || obj.tool) {
            checkTarget = obj;
          }
        }

        if (isOrchestratorWrite(checkTarget, { root: cfg.root, hub: cfg.hubPath })) {
          const entryName = entry.name || entry.id || 'costly-manager';
          const cmdDesc = typeof checkTarget === 'string' ? checkTarget : (checkTarget.command || checkTarget.name || JSON.stringify(checkTarget));
          console.error(`VIOLATION ${entryName} ${cmdDesc}`);

          try {
            const state = loadState(cfg.hubPath);
            state.sessions = state.sessions || {};
            state.sessions[entryName] = {
              ...(state.sessions[entryName] || {}),
              downUntil: Date.now() + 2 * 3600 * 1000,
              lastViolation: new Date().toISOString()
            };
            state.notes = state.notes || [];
            state.notes.push(`VIOLATION ${entryName}: ${cmdDesc}`);
            saveState(cfg.hubPath, state);
          } catch {}

          killProcessTree();
          resolve({
            success: false,
            exitCode: -997,
            error: 'orchestrator_write_violation',
            violation: true,
            stdout: stdoutBuffer,
            stderr: stderrBuffer,
            events,
            usage: latestUsage
          });
          return;
        }
      }

      const parsed = parseTelemetryEvent(trimmed);
      if (parsed) {
        events.push(parsed);
        latestUsage = {
          inputTokens: Math.max(latestUsage.inputTokens, parsed.inputTokens),
          outputTokens: Math.max(latestUsage.outputTokens, parsed.outputTokens),
          totalTokens: Math.max(latestUsage.totalTokens, parsed.totalTokens)
        };
      }
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        resetSilenceTimer();
        stderrBuffer += chunk.toString();
      });
    }

    child.on('exit', (code) => {
      if (turnTimer) clearTimeout(turnTimer);
      if (silenceTimer) clearTimeout(silenceTimer);

      resolve({
        success: code === 0,
        exitCode: code ?? 0,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        events,
        usage: latestUsage
      });
    });

    child.on('error', (err) => {
      if (turnTimer) clearTimeout(turnTimer);
      if (silenceTimer) clearTimeout(silenceTimer);

      resolve({
        success: false,
        exitCode: -1,
        error: err.message,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        events,
        usage: latestUsage
      });
    });
  });
}
