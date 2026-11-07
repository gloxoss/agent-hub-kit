#!/usr/bin/env node
// Live, readable view of one agent job log, meant for a Herdr pane (or any terminal).
//
//   node .agent-hub/tools/job-view.mjs <log file> [title]
//
// The agents write raw JSON events (cursor, agy, codex, opencode). This follows the file and prints one
// short line per thing the agent says or does, hides the known noise, and stops when the runner writes
// its "[dispatch] exit" marker. It only reads the log. No emojis, plain ASCII markers.

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("usage: job-view.mjs <log file> [title]  (live readable view of one agent job log)"); process.exit(0); }

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const title = process.argv.slice(3).join(' ') || (file ? path.basename(file) : '');
if (!file) {
  console.error('usage: job-view.mjs <log file> [title]');
  process.exit(2);
}

const C = process.stdout.isTTY === false ? {} : { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' };
const c = (name, s) => `${C[name] ?? ''}${s}${C.off ?? ''}`;

// Lines that are never useful to a human watching.
const NOISE = /skills scan reached|failed to load skill|invalid YAML|Exceeded skills context budget|Reading additional input from stdin|unrecognized_model|^\s*$/;

const short = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};
const stamp = (ms) => new Date(ms || Date.now()).toLocaleTimeString('fr-FR', { hour12: false });

let thinking = false;
let finished = false;
let counts = { tools: 0, messages: 0 };

function out(kind, text, ms) {
  const t = c('dim', stamp(ms));
  const tag = { say: c('cyan', 'say '), tool: c('yellow', 'tool'), ok: c('green', 'ok  '), err: c('red', 'FAIL'), info: c('dim', '    '), end: c('bold', 'END ') }[kind] ?? '    ';
  console.log(`${t} ${tag} ${text}`);
}

function cmdOf(raw) {
  // Codex wraps commands in pwsh -Command '...'; show only the inner command.
  const s = String(raw ?? '');
  const m = s.match(/-Command\s+(['"])([\s\S]*)\1\s*$/);
  return m ? m[2] : s;
}

function handle(o) {
  const ms = o.timestamp_ms ?? o.timestamp;

  // ---- codex exec --json
  if (o.type === 'thread.started') return out('info', 'codex session started', ms);
  if (o.type === 'turn.completed') return out('info', `turn done${o.usage ? `, ${o.usage.output_tokens ?? ''} output tokens` : ''}`, ms);
  if (typeof o.type === 'string' && o.type.startsWith('item.') && o.item) {
    const it = o.item;
    if (it.type === 'agent_message' && o.type === 'item.completed') {
      counts.messages++;
      return out('say', short(it.text, 400), ms);
    }
    if (it.type === 'command_execution') {
      if (o.type === 'item.started') {
        counts.tools++;
        return out('tool', short(cmdOf(it.command), 220), ms);
      }
      const code = it.exit_code ?? it.exitCode;
      const first = String(it.aggregated_output ?? '').split('\n').filter((l) => l.trim()).slice(0, 2).join(' | ');
      return out(code === 0 || code == null ? 'ok' : 'err', `exit ${code ?? '?'}${first ? `  ${short(first, 160)}` : ''}`, ms);
    }
    if (it.type === 'file_change') return out('tool', `edit ${short((it.changes ?? []).map((x) => x.path).join(', '), 200)}`, ms);
    if (it.type === 'reasoning') return;
    if (it.type === 'error') {
      // Codex reports its own startup warnings as "error" items. These are not failures of the job.
      if (/skills context budget|skills scan|failed to load skill/i.test(String(it.message))) return out('info', 'note: Codex dropped the skill descriptions (too many skills installed). Harmless.', ms);
      return out('err', short(it.message, 240), ms);
    }
    return;
  }

  // ---- agy (antigravity) --output-format stream-json
  if (o.event === 'init') return out('info', 'agy session started', ms);
  if (o.event === 'step_update' && o.step_update) {
    const s = o.step_update;
    if (s.state && s.state !== 'DONE') return; // print finished steps only
    if (s.step_type === 'user_input') return;
    counts.tools++;
    return out('tool', `step ${s.step_index}: ${String(s.step_type ?? '').toLowerCase()} (${String(s.state ?? '').toLowerCase()})`, ms);
  }
  if (o.event && o.event !== 'step_update') {
    const t = o.text ?? o.message ?? o.content;
    if (t) return out('say', short(typeof t === 'string' ? t : JSON.stringify(t), 400), ms);
    return;
  }

  // ---- cursor-agent stream-json
  if (o.type === 'system' && o.subtype === 'init') return out('info', `cursor session, model ${o.model ?? '?'}`, ms);
  if (o.type === 'thinking') {
    if (!thinking) out('info', 'thinking...', ms);
    thinking = true;
    return;
  }
  if (o.type === 'assistant' && o.message?.content) {
    thinking = false;
    const text = o.message.content.map((p) => p.text ?? '').join(' ');
    if (text.trim()) {
      counts.messages++;
      return out('say', short(text, 400), ms);
    }
    return;
  }
  if (o.type === 'tool_call') {
    thinking = false;
    const tc = o.tool_call ?? {};
    const name = Object.keys(tc).find((k) => /ToolCall$/.test(k)) ?? 'tool';
    const body = tc[name] ?? {};
    if (o.subtype === 'started') {
      counts.tools++;
      const a = body.args ?? {};
      const what = a.command ?? a.path ?? a.pattern ?? a.query ?? a.description ?? '';
      return out('tool', `${name.replace(/ToolCall$/, '')} ${short(what, 190)}`, ms);
    }
    const bad = body.result?.error || body.result?.rejected || body.result?.failure;
    return bad ? out('err', `${name.replace(/ToolCall$/, '')} failed`, ms) : undefined;
  }
  if (o.type === 'result') return out(o.is_error ? 'err' : 'ok', `result: ${short(o.result, 300)}`, ms);

  // ---- opencode --format json
  if (o.part?.type === 'tool' || o.type === 'tool_use') {
    const p = o.part ?? {};
    if (p.state?.status && p.state.status !== 'completed') return;
    counts.tools++;
    const inp = p.state?.input ?? {};
    return out('tool', `${p.tool ?? 'tool'} ${short(inp.command ?? inp.filePath ?? inp.pattern ?? inp.path ?? JSON.stringify(inp), 190)}`, ms);
  }
  if (o.type === 'text' && o.part?.text) {
    counts.messages++;
    return out('say', short(o.part.text, 400), ms);
  }
  if (o.type === 'error') return out('err', short(o.error?.message ?? JSON.stringify(o.error ?? o), 240), ms);
}

function line(l) {
  if (!l) return;
  const exit = l.match(/^\[dispatch\] exit (-?\d+|null)/);
  if (exit) {
    finished = true;
    return out('end', `${exit[1] === '0' ? 'finished' : `ended with exit code ${exit[1]}`}  (${counts.tools} tool steps, ${counts.messages} messages)`);
  }
  if (l.startsWith('{')) {
    try {
      return handle(JSON.parse(l));
    } catch {
      return;
    }
  }
  if (NOISE.test(l)) return;
  out('info', short(l, 220));
}

console.log(c('bold', `== ${title} ==`));
console.log(c('dim', `log: ${file}`));

let pos = 0;
let buf = '';
function poll() {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return; // not created yet
  }
  if (st.size < pos) pos = 0;
  if (st.size === pos) return;
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(st.size - pos);
  fs.readSync(fd, chunk, 0, chunk.length, pos);
  fs.closeSync(fd);
  pos = st.size;
  buf += chunk.toString('utf8');
  const parts = buf.split('\n');
  buf = parts.pop() ?? '';
  for (const p of parts) line(p.replace(/\r$/, ''));
}

const timer = setInterval(() => {
  poll();
  if (finished) {
    clearInterval(timer);
    out('info', 'log complete. This pane stays open; close the tab when you are done reading.');
    process.exit(0);
  }
}, 500);
