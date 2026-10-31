// guard.mjs: Security guard for orchestrator writes and secret reads
import path from 'node:path';
import os from 'node:os';

export function isOrchestratorWrite(cmd, options = {}) {
  if (!cmd) return false;

  let cmdStr = '';

  if (typeof cmd === 'string') {
    cmdStr = cmd;
  } else if (typeof cmd === 'object') {
    if (cmd.name || cmd.type === 'tool_use' || cmd.content_block?.type === 'tool_use') {
      const toolName = cmd.name || cmd.content_block?.name;
      const input = cmd.input || cmd.content_block?.input || {};

      const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent'];
      if (writeTools.includes(toolName)) {
        const filePath = input.file_path || input.path || input.file || '';
        if (filePath) {
          if (isOutsideAllowedPaths(filePath, options)) {
            return true;
          }
        }
      }

      const readTools = ['Read'];
      if (readTools.includes(toolName)) {
        const filePath = input.file_path || input.path || input.file || '';
        if (filePath && isSecretPath(filePath)) {
          return true;
        }
      }
    }

    if (cmd.command || cmd.cmd) {
      cmdStr = cmd.command || cmd.cmd;
    } else {
      cmdStr = JSON.stringify(cmd);
    }
  }

  if (!cmdStr) return false;

  const subcommands = cmdStr.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);

  for (const sub of subcommands) {
    if (hasSecretRead(sub)) {
      return true;
    }

    if (hasUnauthorizedWrite(sub, options)) {
      return true;
    }
  }

  return false;
}

function isSecretPath(filePath) {
  if (!filePath) return false;
  const p = filePath.toLowerCase();
  const home = os.homedir().toLowerCase();
  const normalized = p.startsWith('~/') ? path.join(home, p.slice(2)) : p;

  if (
    normalized.includes('.env') ||
    normalized.includes('.ssh') ||
    normalized.includes('.cli-proxy-api') ||
    normalized.includes('.config/devbox') ||
    normalized.includes('.config/waha') ||
    normalized.includes('id_rsa') ||
    normalized.includes('credentials')
  ) {
    return true;
  }
  return false;
}

function hasSecretRead(sub) {
  const lower = sub.toLowerCase();
  const isReadCmd = /\b(cat|less|head|tail|grep|awk|sed|more|read|strings)\b/.test(lower);
  if (isReadCmd && isSecretPath(sub)) {
    return true;
  }
  if (/\bcat\b.*\.env/.test(lower) || /\bgrep\b.*\.env/.test(lower)) {
    return true;
  }
  return false;
}

function hasUnauthorizedWrite(sub, options = {}) {
  const lower = sub.toLowerCase();
  const tokens = sub.split(/\s+/).filter(Boolean);

  // Check write operator: >, >>, tee
  const opIdx = tokens.findIndex(t => t === '>' || t === '>>' || t === 'tee');
  if (opIdx !== -1 && opIdx + 1 < tokens.length) {
    const target = tokens[opIdx + 1];
    if (isOutsideAllowedPaths(target, options)) {
      return true;
    }
  }

  // Check sed -i
  if (/\bsed\s+-i\b/.test(lower)) {
    const fileToken = tokens[tokens.length - 1];
    if (fileToken && !fileToken.startsWith('-')) {
      if (isOutsideAllowedPaths(fileToken, options)) {
        return true;
      }
    }
    return true;
  }

  // Check cp src dest
  if (/\bcp\b/.test(lower)) {
    const dest = tokens[tokens.length - 1];
    if (dest && isOutsideAllowedPaths(dest, options)) {
      return true;
    }
  }

  // Check mv src dest
  if (/\bmv\b/.test(lower)) {
    const dest = tokens[tokens.length - 1];
    if (dest && isOutsideAllowedPaths(dest, options)) {
      return true;
    }
  }

  // Check rm file
  if (/\brm\b/.test(lower)) {
    for (const t of tokens) {
      if (!t.startsWith('-') && t !== 'rm') {
        if (isOutsideAllowedPaths(t, options)) {
          return true;
        }
      }
    }
  }

  const hasGitMutation = /\bgit\s+(commit|apply|checkout\s+--|merge|rebase|reset)\b/.test(lower);
  const hasInstall = /\b(npm|pnpm|yarn)\s+install\b/.test(lower);
  const hasNodeWrite = /\bnode\s+-e\b/.test(lower) && (lower.includes('writefile') || lower.includes('writefilesync'));

  if (hasGitMutation || hasInstall || hasNodeWrite) {
    return true;
  }

  return false;
}

function isOutsideAllowedPaths(filePath, options = {}) {
  if (!filePath) return false;
  const home = os.homedir();
  let resolved = filePath;
  if (filePath.startsWith('~/')) {
    resolved = path.join(home, filePath.slice(2));
  } else if (!path.isAbsolute(filePath)) {
    resolved = path.resolve(options.root || process.cwd(), filePath);
  } else {
    resolved = path.resolve(filePath);
  }

  // Compare with forward slashes and lower case so the same rules hold on Linux and Windows.
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const normalized = norm(resolved);
  const homeLower = norm(home);

  const hubPath = options.hub ? norm(path.resolve(options.hub)) : null;
  if (hubPath && (normalized === hubPath || normalized.startsWith(hubPath + '/'))) return false;
  if (/\/\.(hub|agent-hub[\w-]*)(\/|$)/.test(normalized)) return false;

  if (normalized.includes('/docs/') || normalized.endsWith('/docs')) return false;

  const devboxBrain = `${homeLower}/.devbox-brain`;
  if (normalized === devboxBrain || normalized.startsWith(devboxBrain + '/')) return false;

  const tmp = norm(os.tmpdir());
  if (normalized.startsWith('/tmp/') || /^[a-z]:\/tmp\//.test(normalized) || normalized.startsWith(tmp + '/')) return false;

  return true;
}

export function runFixtureTest() {
  console.log('Running guard fixture tests...');

  const fixtures = [
    { cmd: 'echo "test" > .agent-hub-orch/runs/test.txt', expected: false },
    { cmd: 'cp file.txt /tmp/backup.txt', expected: false },
    { cmd: 'mkdir -p ~/.devbox-brain/logs', expected: false },
    { cmd: 'node hub.mjs status', expected: false },
    { cmd: 'sed -i "s/a/b/" app/x', expected: true },
    { cmd: 'cat > src/a.ts', expected: true },
    { cmd: 'git commit -am "fix"', expected: true },
    { cmd: 'cat .env', expected: true }
  ];

  for (const [i, f] of fixtures.entries()) {
    const result = isOrchestratorWrite(f.cmd);
    console.log(`Fixture ${i + 1} (${f.cmd}): result=${result}, expected=${f.expected}`);
    if (result !== f.expected) {
      throw new Error(`Guard fixture test failed for command "${f.cmd}": got ${result}, expected ${f.expected}`);
    }
  }

  console.log('All guard fixture tests passed successfully.');
  return true;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFixtureTest();
}
