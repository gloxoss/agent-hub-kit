#!/usr/bin/env node
// Turns a plan's task table into hub tasks + autoloop queue entries.
// Usage: node .agent-hub/tools/gen-tasks.mjs <plan.md> <id-prefix-regex> [--after "<heading>"] [--exec a,b,c] [--light x,y] [--note "<extra brief line>"] [--phase name]
// Table rows: | `ID` | `file`, `file` (or <br>-separated) | `DEP`, `DEP` or — | brief<br>brief |
// Deps are any backticked ids that exist in the hub or in the same table; other text in the cell is ignored.
// Existing task ids are skipped, so the script is safe to re-run.
import fs from 'node:fs';
import { HUB, ROOT, hubDir, help } from './runtime.mjs';
help('usage: gen-tasks.mjs <plan.md> <id-prefix-regex> [--exec a,b] [--light a,b] [--phase name]');
process.chdir(ROOT);
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [plan, prefix, ...rest] = process.argv.slice(2);
if (!plan || !prefix) throw new Error('usage: gen-tasks.mjs <plan.md> <id-prefix-regex> [--after heading] [--exec a,b] [--light x,y] [--note text] [--phase name]');
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const CFG = readJson(path.join(HUB, 'config.json'), {});
const GT = CFG.genTasks ?? {};

const exec = (opt('--exec') ?? (GT.exec ?? ['claude-ds2', 'claude-ds3', 'claude-ds1', 'claude-ag2-sonnet']).join(',')).split(',');
const light = (opt('--light') ?? (GT.light ?? ['agy', 'opencode']).join(',')).split(',');
const note = opt('--note', '');
const fixedPhase = opt('--phase');
const phaseMap = GT.phaseMap ?? {};
const PROOF = GT.proof ?? 'Proof: the build and lint commands exit 0, the gates pass in your files, and `git status --short` shows nothing outside your claim. No browser checks unless the brief says otherwise.';
const DONE = GT.done ?? 'Build and lint exit 0; gates clean in your files; git status clean outside the claim.';
const hub = (...a) => execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), ...a, '--agent', 'orchestrator'], { encoding: 'utf8' });

const planPath = path.isAbsolute(plan) ? plan : path.resolve(ROOT, plan);
let text = fs.readFileSync(planPath, 'utf8');
const after = opt('--after');
if (after) text = text.slice(text.lastIndexOf(after));
const rowRe = new RegExp('^\\| `((?:' + prefix + ')[a-z0-9-]*)`');
const rows = text.split('\n').filter((l) => rowRe.test(l));
const events = fs.readFileSync(path.join(HUB, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const known = new Set(events.filter((e) => e.type === 'task-add').map((e) => e.id));
const tableIds = rows.map((r) => r.match(rowRe)[1]);
const strip = (s) => s.replace(/`/g, '').replace(/\(new\)|\(\d+\)/g, '').trim();
const queuePath = path.join(HUB, 'autoloop-queue.json');
const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : {};
let si = 0, li = 0, made = 0;

for (const row of rows) {
  const cells = row.split(/(?<!\\)\|/).map((c) => c.trim());
  const [, idCell, filesCell, depsCell, briefCell = ''] = cells;
  const id = strip(idCell);
  if (known.has(id)) continue;
  let dir = '';
  const scope = filesCell.split(/<br>|,/).map(strip).filter(Boolean).map((f) => {
    if (f.includes('/')) { dir = f.slice(0, f.lastIndexOf('/') + 1); return f.replace(/\/\*\*?(\/\*)?(\.\w+)?$/, ''); } // folder globs (/*, /**, /**/*.png) become the folder: the hub matches paths and folder prefixes only
    return dir + f;
  });
  const deps = [...depsCell.matchAll(/`([A-Za-z0-9-]+)`/g)].map((m) => m[1]).filter((d) => d !== id && (known.has(d) || tableIds.includes(d)));
  const phase = fixedPhase ?? Object.entries(phaseMap).find(([p]) => id.startsWith(p))?.[1] ?? GT.phase ?? 'build';
  const body = [`# ${id} · ${phase} · from ${plan}`, '', `> ${PROOF}`, '',
    `Allowed scope: ${scope.map((s) => '`' + s + '`').join(', ')}. If a fix needs an asset, string file or helper outside this list, report it with say instead of stopping silently.`, '',
    ...(deps.length ? [`Dependencies: ${deps.map((d) => '`' + d + '`').join(', ')}.`, ''] : []),
    '## Brief', ...briefCell.split('<br>').map((b, i) => `${i + 1}. ${b.replace(/\\\|/g, '|')}`), '',
    '## Load', `- Your row and the sections it cites in \`${plan}\`.`, '- The existing files in your scope.', ...(note ? [`- ${note}`] : []), '',
    '## Skills', ...(GT.skills?.length ? GT.skills.map((entry) => '- ' + entry) : ['- none']), '', '## Done when', DONE, ''].join('\n');
  fs.mkdirSync(path.join(HUB, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(HUB, 'tasks', `${id}.md`), body);
  hub('add', id, '--phase', phase, '--title', id, '--deps', deps.join(','), '--scope', scope.join(','));
  hub('edit', id, '--verify', 'off');
  known.add(id);
  queue[id] = phase === 'build' ? exec[si++ % exec.length] : light[li++ % light.length];
  made++;
}
fs.mkdirSync(path.dirname(queuePath), { recursive: true });
fs.writeFileSync(queuePath, JSON.stringify(queue, null, 1));
console.log(`${made} tasks added (${rows.length} rows, ${rows.length - made} already existed)`);
