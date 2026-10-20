#!/usr/bin/env node
// Live progress per running agent job, estimated from evidence on disk (not from the agent's word).
//   node .agent-hub/tools/progress.mjs
import { fileURLToPath } from 'node:url';
import { help, auditPath, CFG as CONFIG, hubDir, projectPath } from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

help("usage: progress.mjs [--detail]");

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(HUB);
const rd = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } };
const alive = new Set((process.platform === 'win32' ? execSync('tasklist /FO CSV /NH', { encoding: 'utf8' }).split('\n').map((l) => l.split(',')[1]?.replace(/"/g, '')) : execSync('ps -e -o pid=', { encoding: 'utf8' }).split('\n').map((l) => l.trim())).filter(Boolean));
const jobs = (rd(`${hubDir}/runs/jobs.jsonl`) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fixes = rd(path.relative(ROOT, auditPath('fixes'))) ?? '';

function steps(job) {
  const t = rd(`${hubDir}/runs/${job.id}.log`) ?? '';
  return (t.match(/"type":"tool_use"|"tool_use"|"tool_call"/g) ?? []).length;
}
function estimate(job) {
  const brief = rd(`${hubDir}/tasks/${job.taskId}.md`) ?? '';
  const title = (brief.split('\n')[0] ?? '').split(' · ').pop();
  const n = steps(job);
  if (/^E-/.test(job.taskId)) {
    const file = brief.match(/Allowed scope: `([^`]+\.html)`/)?.[1];
    const html = file ? rd(file) : null;
    if (!html) return [Math.min(25, n), title, `reading sources (${n} steps), doc not written yet`];
    const words = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const svgs = (html.match(/<svg/g) ?? []).length;
    return [Math.min(95, Math.round(30 + 60 * Math.min(1, words / 4500) + (svgs >= 3 ? 5 : 0))), title, `${words} words, ${svgs} diagrams written`];
  }
  if (/^P-/.test(job.taskId)) {
    const rep = brief.match(/Report: `([^`]+)`/)?.[1];
    const r = rep ? rd(rep) : null;
    if (!r) return [Math.min(30, Math.round(n / 2)), title, `Phase A: reading the page and its code (${n} steps)`];
    const changed = /## What changed\s*\n+(?!\(|none|##)/i.test(r);
    const proof = /## Proof\s*\n+(?!\(|##)[\s\S]*?(exit 0|passed|ratchet)/i.test(r);
    if (proof) return [92, title, 'Phase C: proof checks written, finishing'];
    if (changed) return [70, title, 'Phase B: UI and logic rework in progress'];
    return [40, title, 'Phase A done: audit report written, starting the rework'];
  }
  if (/^X-/.test(job.taskId)) {
    const ids = [...brief.matchAll(/^- `(A-[a-z-]+-\d+)`/gm)].map((m) => m[1]);
    const done = ids.filter((id) => new RegExp(`^${id} \\|`, 'm').test(fixes)).length;
    return [ids.length ? Math.min(95, Math.round(10 + 85 * done / ids.length)) : Math.min(80, n), title, `${done}/${ids.length} findings logged as fixed or checked`];
  }
  return [Math.min(85, n * 2), title, `${n} steps so far`];
}

// Windows reuses process ids, so a job older than 12h whose pid is "alive" is another program, not the agent.
const live = jobs.filter((j) => Date.now() - new Date(j.t).getTime() < 12 * 3600_000 && alive.has(String(j.pid)) && !(rd(`${hubDir}/runs/${j.id}.log`) ?? '').includes('[dispatch] exit'));
const rows = live.map((j) => {
  const [pct, title, what] = j.mode === 'review' ? [50, 'review', 'reviewing the finished work'] : estimate(j);
  const mins = Math.round((Date.now() - new Date(j.t).getTime()) / 60000);
  return { agent: j.executor, task: j.taskId, pct, title, what, mins, mode: j.mode };
}).sort((a, b) => a.agent.localeCompare(b.agent) || b.pct - a.pct);
const bar = (p) => '#'.repeat(Math.round(p / 10)).padEnd(10, '.');
for (const r of rows) console.log(`${r.agent.padEnd(18)} [${bar(r.pct)}] ${String(r.pct).padStart(3)}%  ${r.task.padEnd(30)} ${String(r.mins).padStart(4)}m  ${r.title}  ->  ${r.what}`);
console.log(`${rows.length} jobs running (percentages are estimates)`);

// --detail: for each running build job, exactly what it is fixing or writing, in plain words.
if (process.argv.includes('--detail')) {
  const index = rd(path.relative(ROOT, auditPath('index'))) ?? '';
  const problemOf = (id) => {
    const line = index.split('\n').find((l) => l.startsWith(`| [${id}]`));
    return line ? line.split('|')[4]?.trim().slice(0, 220) ?? '?' : '?';
  };
  const statusOf = (id) => fixes.split('\n').find((l) => l.startsWith(`${id} |`))?.split('|')[1]?.trim() ?? 'open';
  const section = (text, name) => {
    const i = text.indexOf(`## ${name}`);
    if (i < 0) return '';
    const rest = text.slice(text.indexOf('\n', i) + 1);
    const end = rest.search(/\n## /);
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').trim();
  };
  for (const r of rows.filter((x) => x.mode === 'run')) {
    const brief = rd(`${hubDir}/tasks/${r.task}.md`) ?? '';
    console.log(`\n=== ${r.task} (${r.agent}, ${r.pct}%) ${r.title}`);
    const ids = [...brief.matchAll(/^- `(A-[a-z-]+-\d+)`/gm)].map((m) => m[1]);
    for (const id of ids) console.log(`  - ${id} [${statusOf(id)}] ${problemOf(id)}`);
    const rep = brief.match(/Report: `([^`]+)`/)?.[1];
    const report = rep ? rd(rep) : null;
    if (report) {
      const how = section(report, 'How this page works');
      const found = section(report, 'Findings');
      const changed = section(report, 'What changed');
      if (how) console.log(`  How the page works: ${how.slice(0, 400)}`);
      if (found) console.log(`  Found so far: ${found.slice(0, 600)}`);
      if (changed && !/^\(/.test(changed)) console.log(`  Changed: ${changed.slice(0, 400)}`);
    } else if (/^P-/.test(r.task)) console.log('  Audit report not written yet.');
    if (/^E-/.test(r.task)) console.log(`  Lessons: ${brief.match(/covering ([^,]+) of/)?.[1] ?? '?'}; grounded in: ${(brief.match(/- The real files: (.*)/)?.[1] ?? '').slice(0, 200)}`);
    if (!ids.length && !report && !/^E-/.test(r.task)) console.log(`  Goal: ${(brief.match(/## Goal\n([^\n]+)/)?.[1] ?? '').slice(0, 300)}`);
  }
}
