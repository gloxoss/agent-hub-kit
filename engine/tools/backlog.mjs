#!/usr/bin/env node
// Cross-checks BACKLOG.md against the audit index, FIXES.md, page reports, plan task
// tables and the hub, then prints what nobody is tracking. Read-only.
// Task status comes from `hub.mjs show`, which refreshes BOARD.md as a side effect.
// Usage: node .agent-hub/tools/backlog.mjs [--json]   (Node 20+, no dependencies)

import { fileURLToPath } from 'node:url';
import { help, auditPath, CFG as CONFIG, hubDir, projectPath } from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

help("usage: backlog.mjs [--json]");

const jsonMode = process.argv.includes('--json');

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = path.dirname(TOOLS_DIR);
const ROOT_DIR = path.dirname(HUB_DIR);
const AUDIT_DIR = auditPath('dir');
const SEVERITIES = ['p0', 'p1', 'p2', 'p3', 'enhancements'];
const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'CLAIMED', 'REVIEW', 'VERIFIED', 'BLOCKED', 'REWORK', 'UNKNOWN'];

const PATHS = {
  backlog: projectPath(CONFIG.backlogPath ?? 'docs/BACKLOG.md'),
  events: path.join(HUB_DIR, 'events.jsonl'),
  hub: path.join(HUB_DIR, 'hub.mjs'),
  tasks: path.join(HUB_DIR, 'tasks'),
  index: auditPath('index'),
  fixes: auditPath('fixes'),
  pageReports: auditPath('pageReports'),
  plans: auditPath('plans'),
};

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function listMarkdown(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const stripMarks = (s) => s.replace(/[`*]/g, '');
const cut = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() : s);

// Table rows escape inner pipes as \|, so a plain split('|') would shift every cell.
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// ---------- sources ----------

function readAuditIndex() {
  const buckets = new Map();
  let bucket = null;
  for (const raw of readText(PATHS.index).split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^##\s+(P0|P1|P2|P3|Enhancements)\s*$/i);
    if (heading) {
      bucket = heading[1].toLowerCase();
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      continue;
    }
    if (line.startsWith('#')) { bucket = null; continue; }
    if (!bucket || !line.startsWith('|')) continue;
    const cells = splitRow(line);
    const link = cells[0] && cells[0].match(/^\[([^\]]+)\]\(/);
    if (!link || cells.length < 5) continue; // skips the header and separator rows
    buckets.get(bucket).push({ id: link[1], problem: stripMarks(cells[3]) });
  }
  return buckets;
}

function readFixes() {
  const out = new Map();
  for (const line of readText(PATHS.fixes).split('\n')) {
    if (!line.includes('|')) continue;
    const [rawId, rawVerdict] = line.split('|').map((s) => s.trim());
    const id = stripMarks(rawId ?? '');
    const verdict = (rawVerdict ?? '').toLowerCase();
    if (!id || !/^[A-Z]-[a-z0-9-]*\d$/.test(id)) continue;
    if (verdict.startsWith('false')) out.set(id, 'falseAlarm');
    else if (verdict.startsWith('fixed')) out.set(id, 'fixed');
  }
  return out;
}

// A finding is claimed by a task when the brief lists it under "## Findings in this batch".
function readBatchFindings() {
  const byFinding = new Map();
  for (const name of listMarkdown(PATHS.tasks)) {
    const taskId = name.replace(/\.md$/, '');
    let inside = false;
    for (const raw of readText(path.join(PATHS.tasks, name)).split('\n')) {
      const line = raw.trimEnd();
      if (/^##\s+Findings in this batch\s*$/i.test(line)) { inside = true; continue; }
      if (inside && line.startsWith('#')) break;
      if (!inside) continue;
      for (const m of line.matchAll(/`([A-Z][A-Za-z0-9-]*)`/g)) {
        if (!/^[A-Z][A-Za-z0-9-]*\d$/.test(m[1])) continue;
        const hits = byFinding.get(m[1]) ?? [];
        if (!hits.includes(taskId)) hits.push(taskId);
        byFinding.set(m[1], hits);
      }
    }
  }
  return byFinding;
}

function readHubTasks() {
  const created = new Map();
  for (const line of readText(PATHS.events).split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'task-add' && event.id && !created.has(event.id)) created.set(event.id, event.t);
  }
  const tasks = [];
  for (const [id, createdAt] of created) {
    const shown = spawnSync(process.execPath, [PATHS.hub, 'show', id], { cwd: ROOT_DIR, encoding: 'utf8' });
    let status = 'UNKNOWN';
    let title = '';
    if (shown.status === 0) {
      try {
        const parsed = JSON.parse(shown.stdout);
        status = parsed.status ?? 'UNKNOWN';
        title = parsed.title ?? '';
      } catch { /* hub answered something that is not JSON; keep UNKNOWN */ }
    }
    tasks.push({
      id,
      status,
      title,
      createdAt,
      ageMinutes: Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 60000)),
    });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

function readPageReports() {
  const bullets = [];
  for (const name of listMarkdown(PATHS.pageReports)) {
    let inside = false;
    for (const raw of readText(path.join(PATHS.pageReports, name)).split('\n')) {
      const line = raw.trimEnd();
      if (/^##\s+Not fixed \(outside scope\)\s*$/i.test(line)) { inside = true; continue; }
      if (inside && line.startsWith('#')) break;
      if (!inside) continue;
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) bullets.push({ file: name, text: stripMarks(bullet[1]) });
    }
  }
  return bullets;
}

function readPlans(backlogLower) {
  const plans = [];
  for (const name of listMarkdown(PATHS.plans)) {
    const text = readText(path.join(PATHS.plans, name));
    const ids = [];
    let inside = false;
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      const heading = line.match(/^(#+)\s+(.*)$/);
      if (heading) { inside = /build\s*tasks|task\s+table/i.test(heading[2]); continue; }
      if (!inside || !line.startsWith('|')) continue;
      const cells = splitRow(line);
      const cell = stripMarks(cells[0] ?? '');
      if (!/^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+$/.test(cell)) continue;
      if (!ids.includes(cell)) ids.push(cell);
    }
    plans.push({ file: name, mentioned: backlogLower.includes(name.toLowerCase()), ids });
  }
  return plans;
}

// ---------- report ----------

function buildReport() {
  const backlogLower = squash(stripMarks(readText(PATHS.backlog))).toLowerCase();
  const index = readAuditIndex();
  const fixes = readFixes();
  const batchFindings = readBatchFindings();
  const hubTasks = readHubTasks();
  const pageBullets = readPageReports();
  const plans = readPlans(backlogLower);

  const coverage = [];
  const untrackedP0P1 = [];
  for (const severity of SEVERITIES) {
    const rows = index.get(severity) ?? [];
    const row = { severity, total: rows.length, fixed: 0, falseAlarm: 0, inHubTask: 0, untracked: 0 };
    for (const finding of rows) {
      const verdict = fixes.get(finding.id);
      if (verdict === 'fixed') { row.fixed++; continue; }
      if (verdict === 'falseAlarm') { row.falseAlarm++; continue; }
      if (batchFindings.has(finding.id)) { row.inHubTask++; continue; }
      row.untracked++;
      if (severity === 'p0' || severity === 'p1') {
        untrackedP0P1.push({ id: finding.id, severity, problem: cut(finding.problem, 100) });
      }
    }
    coverage.push(row);
  }

  const byStatus = {};
  for (const task of hubTasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const unfinished = hubTasks
    .filter((t) => t.status !== 'ACCEPTED' && t.status !== 'CANCELLED')
    .map(({ id, status, title, ageMinutes }) => ({ id, status, title, ageMinutes }));

  const untrackedPages = pageBullets
    .filter((b) => !backlogLower.includes(squash(b.text).toLowerCase().slice(0, 40)))
    .map((b) => ({ file: b.file, text: b.text }));

  const planFiles = plans.filter((p) => !p.mentioned).map((p) => p.file);
  const knownTasks = new Set(hubTasks.map((t) => t.id));
  const missingPlanTasks = [];
  for (const plan of plans) {
    for (const id of plan.ids) if (!knownTasks.has(id)) missingPlanTasks.push({ file: plan.file, id });
  }

  const auditUntracked = coverage.reduce((n, row) => n + row.untracked, 0);
  const untracked = auditUntracked + untrackedPages.length + planFiles.length + missingPlanTasks.length;

  return {
    generatedAt: new Date().toISOString(),
    audit: { total: coverage.reduce((n, row) => n + row.total, 0), coverage, untrackedP0P1 },
    hub: { total: hubTasks.length, byStatus, unfinished },
    pages: { checked: pageBullets.length, untracked: untrackedPages },
    plans: { checked: plans.length, unmentionedFiles: planFiles, missingTaskIds: missingPlanTasks },
    untracked,
  };
}

function printText(report) {
  const out = [];

  out.push(`== 1. Audit coverage (${report.audit.total} findings) ==`);
  for (const row of report.audit.coverage) {
    out.push(
      `${row.severity.toUpperCase().padEnd(12)} total ${String(row.total).padStart(3)}` +
      ` · fixed ${row.fixed} · false alarm ${row.falseAlarm} · in a hub task ${row.inHubTask} · untracked ${row.untracked}`,
    );
  }
  out.push(`untracked P0 and P1 (${report.audit.untrackedP0P1.length}):`);
  if (!report.audit.untrackedP0P1.length) out.push('  (none)');
  for (const f of report.audit.untrackedP0P1) out.push(`  ${f.id} (${f.severity.toUpperCase()}): ${f.problem}`);

  out.push('');
  out.push(`== 2. Hub tasks (${report.hub.total}) ==`);
  const statuses = [...OPEN_STATUSES, 'ACCEPTED', 'CANCELLED'].filter((s) => report.hub.byStatus[s]);
  out.push(`by status: ${statuses.map((s) => `${s} ${report.hub.byStatus[s]}`).join(', ') || '(none)'}`);
  out.push(`not accepted or cancelled (${report.hub.unfinished.length}):`);
  if (!report.hub.unfinished.length) out.push('  (none)');
  for (const t of report.hub.unfinished) {
    out.push(`  ${t.id.padEnd(32)} ${t.status.padEnd(9)} ${String(t.ageMinutes).padStart(5)} min  ${t.title}`);
  }

  out.push('');
  out.push('== 3. Page reports: not-fixed bullets whose first 40 chars are absent from BACKLOG.md ==');
  if (!report.pages.untracked.length) out.push('  (none)');
  for (const b of report.pages.untracked) out.push(`  ${b.file}: ${b.text}`);

  out.push('');
  out.push('== 4. Plans ==');
  out.push(`plan files not mentioned in BACKLOG.md (${report.plans.unmentionedFiles.length}):`);
  if (!report.plans.unmentionedFiles.length) out.push('  (none)');
  for (const file of report.plans.unmentionedFiles) out.push(`  ${file}`);
  out.push(`build-table task IDs with no hub task (${report.plans.missingTaskIds.length}):`);
  if (!report.plans.missingTaskIds.length) out.push('  (none)');
  for (const m of report.plans.missingTaskIds) out.push(`  ${m.file}: ${m.id}`);

  out.push('');
  out.push(`untracked: ${report.untracked}`);
  console.log(out.join('\n'));
}

try {
  const report = buildReport();
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else printText(report);
} catch (error) {
  process.exitCode = 1;
  console.error(`backlog: ${error instanceof Error ? error.message : String(error)}`);
}

