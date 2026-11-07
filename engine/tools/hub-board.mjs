#!/usr/bin/env node
// Live board of the hub for one Herdr pane: task counts, what is running, what waits for the orchestrator,
// and the last events. Read only. Refreshes every few seconds.
//
//   node .agent-hub/tools/hub-board.mjs

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log("usage: hub-board.mjs  (live hub board, refreshes every 5 seconds, Ctrl+C to stop)"); process.exit(0); }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from '../fold.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');

const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' };
const jsonl = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
};

function frame() {
  const events = jsonl(path.join(HUB, 'events.jsonl'));
  const state = fold(events);
  const T = state.tasks || state;
  const by = {};
  for (const [id, t] of Object.entries(T)) (by[t.status] ??= []).push(id);

  const jobs = new Map();
  for (const j of jsonl(path.join(HUB, 'runs', 'jobs.jsonl'))) jobs.set(j.id, { ...(jobs.get(j.id) || {}), ...j });
  const now = Date.now();
  // A job runs when its log has no exit marker and was written to in the last 15 minutes.
  const running = [...jobs.values()].filter((j) => {
    if (!j.log) return false;
    try {
      const file = path.resolve(HUB, '..', j.log);
      if (Date.now() - fs.statSync(file).mtimeMs > 15 * 60000) return false;
      return !/^\[dispatch\] exit/m.test(fs.readFileSync(file, 'utf8'));
    } catch { return false; }
  });

  const out = [];
  out.push(`${C.bold}MORENE hub board${C.off}   ${new Date().toLocaleTimeString('fr-FR', { hour12: false })}   ${C.dim}refresh 5s, Ctrl+C to stop${C.off}`);
  out.push('');
  out.push(['ACCEPTED', 'REVIEW', 'REWORK', 'CLAIMED', 'ASSIGNED', 'OPEN', 'BLOCKED']
    .map((s) => `${s} ${C.bold}${(by[s] || []).length}${C.off}`).join('   '));
  out.push('');
  out.push(`${C.cyan}Running now (${running.length})${C.off}`);
  if (!running.length) out.push(`  ${C.dim}nobody${C.off}`);
  for (const j of running.slice(0, 12)) {
    const t = Date.parse(j.t) || j.started || now;
    out.push(`  ${String(j.executor || '?').padEnd(18)} ${String(j.taskId || j.task || '?').padEnd(28)} ${Math.round((now - t) / 60000)} min`);
  }
  for (const [label, key, color] of [['Waiting for the orchestrator', 'REVIEW', 'yellow'], ['Sent back', 'REWORK', 'red'], ['Blocked', 'BLOCKED', 'red']]) {
    if ((by[key] || []).length) {
      out.push('');
      out.push(`${C[color]}${label} (${by[key].length})${C.off}`);
      out.push(`  ${by[key].join(', ')}`);
    }
  }
  out.push('');
  out.push(`${C.cyan}Last events${C.off}`);
  for (const e of events.slice(-9)) {
    const when = e.t ? new Date(e.t).toLocaleTimeString('fr-FR', { hour12: false }) : '        ';
    const what = [e.type, e.id || '', e.agent || ''].filter(Boolean).join(' ');
    out.push(`  ${C.dim}${when}${C.off} ${what}${e.note ? `  ${C.dim}${String(e.note).replace(/\s+/g, ' ').slice(0, 90)}${C.off}` : ''}`);
  }
  process.stdout.write(`\x1b[2J\x1b[H${out.join('\n')}\n`);
}

frame();
setInterval(frame, 5000);
