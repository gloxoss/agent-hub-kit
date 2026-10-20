#!/usr/bin/env node
// Follow an agent's work as readable lines instead of raw JSON.
//
//   node .agent-hub/tools/watch.mjs <TASK-ID or job id>      e.g. P-settings-entitlements
//
// Shows each step: READ file, RUN command (+ last output line), EDIT/WRITE file (+ first changed lines), SAYS text.
// Works for opencode (part events) and Claude-family (message content) logs. Ctrl+C to stop.
import { fileURLToPath } from 'node:url';
import { help, auditPath, CFG as CONFIG, hubDir, projectPath } from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';

help("usage: watch.mjs <TASK-ID or job id> [--once]");

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(HUB, 'runs');
const ROOT = path.dirname(HUB).replace(/\\/g, '/');
const arg = process.argv[2];
if (!arg) { console.error('usage: watch.mjs <TASK-ID or job id>'); process.exit(1); }

// Newest build log for the task (review logs start with "review-").
const logs = fs.readdirSync(RUNS).filter((f) => f.endsWith('.log') && f.includes(arg) && !f.startsWith('review-'))
  .map((f) => ({ f, t: fs.statSync(path.join(RUNS, f)).mtimeMs })).sort((a, b) => b.t - a.t);
if (!logs.length) { console.error(`no log for ${arg} in ${RUNS}`); process.exit(1); }
const file = path.join(RUNS, logs[0].f);

const short = (s) => String(s ?? '').replace(/\\/g, '/').replace(ROOT + '/', '').replace(/\s+/g, ' ').trim();
const time = () => new Date().toTimeString().slice(0, 8);
const seen = new Set();

function show(line) {
  let j; try { j = JSON.parse(line); } catch { return; }
  const p = j.part;
  if (p) {
    if (p.type === 'text' && p.text?.trim() && !seen.has(p.id)) { seen.add(p.id); console.log(`${time()}  SAYS   ${short(p.text).slice(0, 400)}`); }
    if (p.type === 'tool' && p.state?.status === 'completed' && !seen.has(p.id)) {
      seen.add(p.id);
      const i = p.state.input ?? {};
      const out = short(p.state.output);
      if (p.tool === 'read') console.log(`${time()}  READ   ${short(i.filePath)}`);
      else if (p.tool === 'bash') console.log(`${time()}  RUN    ${short(i.command).slice(0, 160)}\n           -> ${out.slice(-160)}`);
      else if (p.tool === 'write') console.log(`${time()}  WRITE  ${short(i.filePath)} (${String(i.content ?? '').split('\n').length} lines)\n           ${short(String(i.content ?? '').split('\n').slice(0, 3).join(' | ')).slice(0, 200)}`);
      else if (p.tool === 'edit') console.log(`${time()}  EDIT   ${short(i.filePath)}\n           - ${short(i.oldString).slice(0, 140)}\n           + ${short(i.newString).slice(0, 140)}`);
      else console.log(`${time()}  ${p.tool.toUpperCase().padEnd(6)} ${short(i.pattern ?? i.path ?? i.filePath ?? JSON.stringify(i)).slice(0, 160)}`);
    }
    return;
  }
  for (const b of j.message?.content ?? []) {
    if (b.type === 'text' && b.text?.trim()) console.log(`${time()}  SAYS   ${short(b.text).slice(0, 400)}`);
    if (b.type === 'tool_use') {
      const i = b.input ?? {};
      if (/Write/.test(b.name)) console.log(`${time()}  WRITE  ${short(i.file_path)} (${String(i.content ?? '').split('\n').length} lines)`);
      else if (/Edit/.test(b.name)) console.log(`${time()}  EDIT   ${short(i.file_path)}\n           - ${short(i.old_string).slice(0, 140)}\n           + ${short(i.new_string).slice(0, 140)}`);
      else if (/Read/.test(b.name)) console.log(`${time()}  READ   ${short(i.file_path)}`);
      else if (/Bash/.test(b.name)) console.log(`${time()}  RUN    ${short(i.command).slice(0, 160)}`);
      else console.log(`${time()}  ${b.name.toUpperCase().padEnd(6)} ${short(JSON.stringify(i)).slice(0, 160)}`);
    }
  }
}

console.log(`watching ${short(file)}  (last 15 steps, then live; Ctrl+C to stop)\n`);
let text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');
// Replay only the tail so the screen starts with recent context.
const before = console.log; const buf = []; console.log = (s) => buf.push(s);
lines.forEach(show); console.log = before; buf.slice(-15).forEach((s) => console.log(s));
if (process.argv.includes('--once') || text.includes('[dispatch] exit')) process.exit(0);
let size = Buffer.byteLength(text);
let partial = '';
setInterval(() => {
  const st = fs.statSync(file);
  if (st.size <= size) return;
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(st.size - size); fs.readSync(fd, b, 0, b.length, size); fs.closeSync(fd);
  size = st.size;
  const chunk = partial + b.toString('utf8'); const parts = chunk.split('\n'); partial = parts.pop();
  parts.forEach(show);
  if (chunk.includes('[dispatch] exit')) { console.log(`${time()}  -- job finished --`); process.exit(0); }
}, 1000);
