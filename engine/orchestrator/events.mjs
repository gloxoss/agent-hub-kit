// events.mjs: Event intake and wake classification for orchestrator v2
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { handleUntaggedMessage } from './lead.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KIT_ROOT = path.resolve(__dirname, '..', '..');

export function classify(line) {
  if (!line || typeof line !== 'string') return null;
  const upper = line.toUpperCase();

  // 1. user: WHATSAPP lines, terminal
  if (upper.includes('WHATSAPP') || upper.includes('TERMINAL') || upper.includes('USER')) {
    return 'user';
  }

  // 2. decide: DECIDE
  if (upper.includes('DECIDE')) {
    return 'decide';
  }

  // 3. quota: QUOTA (when lane has no fallback / quota)
  if (upper.includes('QUOTA')) {
    return 'quota';
  }

  // 4. fail: GATE FAIL twice, rework DECIDE
  if (upper.includes('GATE FAIL') || upper.includes('REWORK DECIDE') || (upper.includes('FAIL') && (upper.includes('GATE') || upper.includes('REWORK')))) {
    return 'fail';
  }

  // 5. sync: SYNC … diverged|conflict
  if (upper.includes('SYNC') && (upper.includes('DIVERGED') || upper.includes('CONFLICT') || upper.includes('DIVERGE') || upper.includes('DIFFER'))) {
    return 'sync';
  }

  // 6. start
  if (upper.includes('START') || upper.includes('STARTED')) {
    return 'start';
  }

  return null; // report buffer only
}

export class EventIntake extends EventEmitter {
  constructor(options = {}) {
    super();
    this.kitRoot = options.kitRoot || KIT_ROOT;
    this.children = [];
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.spawnAutoloop();
    this.spawnWaInbox();
  }

  spawnAutoloop() {
    if (this.stopped) return;
    const autoloopPath = path.join(this.kitRoot, 'engine', 'autoloop.mjs');
    if (!fs.existsSync(autoloopPath)) return;

    const child = spawn(process.execPath, [autoloopPath], {
      cwd: this.kitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.handleChild(child, 'autoloop', () => this.spawnAutoloop());
  }

  spawnWaInbox() {
    if (this.stopped) return;
    const waPath = path.join(process.env.HOME || '/home/dev', '.local', 'bin', 'wa');
    const execCmd = fs.existsSync(waPath) ? waPath : 'wa';

    const child = spawn(execCmd, ['inbox'], {
      cwd: this.kitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true
    });

    this.handleChild(child, 'wa-inbox', () => this.spawnWaInbox());
  }

  async handleMessageEvent(eventObj) {
    try {
      await handleUntaggedMessage(eventObj, process.env.DEVBOX_NODE || os.hostname(), { dry: process.env.ORCH_DRY === '1' });
    } catch {}
  }

  handleChild(child, name, restartFn) {
    this.children.push(child);

    const processStream = (stream) => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const wakeClass = classify(trimmed);
        const eventObj = {
          source: name,
          line: trimmed,
          wakeClass,
          timestamp: Date.now()
        };
        this.emit('event', eventObj);
        if (wakeClass) {
          this.emit('wake', wakeClass, eventObj);
          if (wakeClass === 'user') {
            this.handleMessageEvent(eventObj);
          }
        } else {
          this.emit('report', eventObj);
        }
      });
    };

    processStream(child.stdout);
    processStream(child.stderr);

    child.on('exit', () => {
      this.children = this.children.filter((c) => c !== child);
      if (this.stopped) return;
      // Restart after 10 seconds on exit
      setTimeout(() => {
        if (!this.stopped) {
          restartFn();
        }
      }, 10000);
    });

    child.on('error', () => {});
  }

  stop() {
    this.stopped = true;
    for (const child of this.children) {
      try {
        child.kill();
      } catch {}
    }
    this.children = [];
  }
}

export function startEventIntake(options) {
  const intake = new EventIntake(options);
  intake.start();
  return intake;
}
