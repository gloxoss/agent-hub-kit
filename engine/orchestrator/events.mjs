// events.mjs: what the manager listens to, and which lines are worth waking it for.
// Sources: the project's own autoloop (its hub) and the owner's WhatsApp replies for THIS project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Wake classes: user, decide, sync, start (always wake); quota (wakes only in a burst, see the driver);
// fail (the autoloop already reworks on its own; report buffer only). Everything else is report-only (null).
export function classify(line) {
  const t = String(line ?? '').trim();
  if (!t) return null;
  if (/^WHATSAPP\b/i.test(t)) return 'user';
  if (/^DECIDE\b/.test(t)) return 'decide';
  if (/^QUOTA\b/.test(t)) return 'quota';
  if (/\bGATE FAIL\b/.test(t)) return 'fail';
  if (/^SYNC\b.*\b(diverged|conflict|failed)\b/i.test(t)) return 'sync';
  if (/^START\b/.test(t)) return 'start';
  return null;
}

// "WHATSAPP 10:12: text [structured answers: ...]" -> "text [structured answers: ...]"
export const ownerText = (line) => String(line).replace(/^WHATSAPP\s+\d\d:\d\d:\s*/i, '').trim();

export class EventIntake extends EventEmitter {
  constructor(cfg, { autoloop = true, whatsapp = true } = {}) {
    super();
    this.cfg = cfg;
    this.useAutoloop = autoloop;
    this.useWhatsapp = whatsapp;
    this.children = new Set();
    this.stopped = false;
  }

  start({ holdAutoloop = false } = {}) {
    this.stopped = false;
    this.autoloopHeld = holdAutoloop;   // the quota-burn breaker keeps dispatching off across restarts
    if (this.useAutoloop) this.spawnAutoloop();
    if (this.useWhatsapp) this.spawnInbox();
    return this;
  }

  spawnAutoloop() {
    const file = path.join(this.cfg.hubPath, 'autoloop.mjs');
    if (this.stopped || this.autoloopHeld || this.autoloopChild || !fs.existsSync(file)) return;
    const child = spawn(process.execPath, [file], { cwd: this.cfg.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.autoloopChild = child;
    child.on('exit', () => { if (this.autoloopChild === child) this.autoloopChild = null; });
    this.watch(child, 'autoloop', () => this.spawnAutoloop());
  }

  // Stop dispatching (the autoloop is what starts workers); running workers are not touched.
  pauseAutoloop() {
    this.autoloopHeld = true;
    const c = this.autoloopChild;
    this.autoloopChild = null;
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }

  resumeAutoloop() {
    this.autoloopHeld = false;
    if (this.useAutoloop) this.spawnAutoloop();
  }

  spawnInbox() {
    const wa = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');
    if (this.stopped || !fs.existsSync(wa)) return;
    const env = { ...process.env, AGENT_PROJECT: this.cfg.projectName };
    this.watch(spawn(process.execPath, [wa, 'inbox'], { cwd: this.cfg.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), 'wa', () => this.spawnInbox());
  }

  watch(child, source, restart) {
    this.children.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (raw) => {
        const line = raw.trim();
        if (!line) return;
        const wakeClass = source === 'wa' && !/^WHATSAPP\b/i.test(line) ? null : classify(line);
        this.emit(wakeClass ? 'wake' : 'report', { source, line, wakeClass, at: Date.now() });
      });
    }
    child.on('exit', () => {
      this.children.delete(child);
      if (!this.stopped) setTimeout(restart, 10_000);   // restart a dead source after 10 s
    });
    child.on('error', () => {});
  }

  // Terminal input (--say) enters the same path as a WhatsApp message.
  injectUser(text) { this.emit('wake', { source: 'terminal', line: `WHATSAPP 00:00: ${text}`, wakeClass: 'user', at: Date.now() }); }

  stop() {
    this.stopped = true;
    for (const c of this.children) { try { c.kill(); } catch { /* already gone */ } }
    this.children.clear();
  }
}

export function runSelfTest() {
  const cases = [
    ['DIGEST REVIEW 2 | running: none', null],
    ['ACCEPTED P-y', null],
    ['MOVED T-1: codex failed (QUOTA), now on x', null],
    ['DECIDE P-x: FAIL after 2 reworks', 'decide'],
    ['QUOTA codex: QUOTA (build P-z)', 'quota'],
    ['GATE FAIL P-q: self-review', 'fail'],
    ['SYNC dev-box: diverged (1 local, 2 remote)', 'sync'],
    ['SYNC dev-box: pulled 3 commit(s)', null],
    ['WHATSAPP 10:01: hello there, user of the project', 'user'],
    ['the user said start now', null],
    ['START: the driver just started', 'start'],
  ];
  let ok = true;
  for (const [line, want] of cases) {
    const got = classify(line);
    const pass = got === want;
    ok = ok && pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} events: ${line.slice(0, 40)} -> ${got}`);
  }
  const t = ownerText('WHATSAPP 10:12: status? [structured answers: []]') === 'status? [structured answers: []]';
  console.log(`${t ? 'PASS' : 'FAIL'} events: ownerText`);
  return ok && t;
}
