#!/usr/bin/env node
// Queue a page audit and scoped rework. Run: node <hub>/tools/page-task.mjs <url-or-route> [--file path] [--scope a,b] [--notes text] [--paste file] [--exec name] [--no-queue].
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HUB, ROOT, CFG, hubDir, auditPath, projectPath, help, lock } from './runtime.mjs';
import { briefSkills } from './skills.mjs';

help('usage: page-task.mjs <url-or-route> [--file path] [--scope a,b] [--notes text] [--paste file] [--exec name] [--skills a,b] [--no-queue]');
const args = process.argv.slice(2), opt = {}, positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-queue') opt.noQueue = true;
  else if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    if (!['file', 'scope', 'notes', 'paste', 'exec', 'skills'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option: ${args[i]}`);
    opt[key] = args[++i];
  } else positional.push(args[i]);
}
const input = positional[0];
if (!input || positional.length !== 1) throw new Error('supply one URL or route; run --help');
const url = new URL(input, CFG.pages?.baseUrl ?? 'http://localhost');
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('expected an HTTP URL or route');
let route = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
const locales = CFG.pages?.locales ?? [];
const segments = route.split('/').filter(Boolean);
if (locales.includes(segments[0])) segments.shift();
route = '/' + segments.join('/');
const prefix = CFG.pages?.routePrefix ?? '';
if (prefix && route !== prefix && !route.startsWith(prefix + '/')) throw new Error(`route must be under ${prefix}`);
const routesDir = projectPath(path.join(CFG.pages?.appRoot ?? '.', CFG.pages?.routesDir ?? 'src/app'));
const matches = [];
function scan(dir, parts = []) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith('_') || e.name.startsWith('@')) continue;
      scan(path.join(dir, e.name), /^\(.*\)$/.test(e.name) || (e.name === '[locale]' && locales.length) ? parts : [...parts, e.name]);
    } else if (/^page\.(tsx|jsx|ts|js|mdx)$/.test(e.name) && parts.length === segments.length && parts.every((p, i) => p === segments[i] || /^\[[^\]]+\]$/.test(p))) matches.push(path.join(dir, e.name));
  }
}
if (!opt.file) scan(routesDir);
if (!opt.file && matches.length !== 1) throw new Error(`found ${matches.length} matching pages; supply --file`);
const page = opt.file ? projectPath(opt.file) : matches[0];
if (!fs.existsSync(page) || !fs.statSync(page).isFile()) throw new Error(`no page: ${page}`);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const slug = segments.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
const id = 'P-' + slug;
const report = rel(projectPath(path.join(CFG.pages?.reports ?? rel(auditPath('pageReports')), slug + '.md')));
const scope = [...new Set([...(opt.scope ? opt.scope.split(',').map((p) => rel(projectPath(p.trim()))) : [rel(path.dirname(page)) + '/']), report])];
const skills = (opt.skills ? opt.skills.split(',').filter(Boolean) : CFG.pages?.skills ?? []).map((name) => '- `' + name + '`: selected for this page by the orchestrator');
const vars = { ID: id, ROUTE: route, URL: url.href, SCOPE: scope.map((p) => '`' + p + '`').join(', '), REPORT: report, OWNER: [opt.notes, opt.paste && fs.readFileSync(projectPath(opt.paste), 'utf8')].filter(Boolean).join('\n\n') || 'Audit the page and follow the project design system.', PAGE_FILE: rel(page), SKILLS: skills.length ? skills.join('\n') : '- none', HUB_DIR: hubDir, PROOF: CFG.pages?.proof ?? 'Run the project gates and checks for the changed files. Serialize memory-heavy commands through tools/heavy.mjs. Quote actual command results, including failures.' };
const tmpl = fs.readFileSync(path.join(HUB, 'templates', 'page-brief.md'), 'utf8');
const brief = tmpl.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
const executor = opt.exec ?? CFG.pages?.executor ?? 'opencode';
const table = JSON.parse(fs.readFileSync(path.join(HUB, 'executors.json'), 'utf8'));
const definitions = Array.isArray(table) ? table : table.executors;
if (!opt.noQueue && !definitions.some((e) => e.name === executor && !e.disabled && ['builder', 'both'].includes(e.kind))) throw new Error(`unavailable page builder: ${executor}`);
const release = lock('page-task');
try {
  const briefPath = path.join(HUB, 'tasks', id + '.md');
  if (fs.existsSync(briefPath)) throw new Error(`${id} already has a brief; use the hub rework workflow`);
  fs.writeFileSync(briefPath, brief, { flag: 'wx' });
  try { briefSkills(id); } catch (error) { fs.unlinkSync(briefPath); throw error; }
  const hub = (...a) => execFileSync(process.execPath, [path.join(HUB, 'hub.mjs'), ...a, '--agent', 'orchestrator'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  hub('add', id, '--phase', 'build', '--title', `Page ${route}`, '--scope', scope.join(','));
  if (!opt.noQueue) {
    const qp = path.join(HUB, 'autoloop-queue.json');
    const queue = JSON.parse(fs.readFileSync(qp, 'utf8'));
    queue[id] = executor;
    fs.writeFileSync(qp, JSON.stringify(queue, null, 2) + '\n');
  }
  const ledger = path.join(HUB, 'pages', 'LEDGER.md');
  fs.appendFileSync(ledger, `| ${route} | ${id} | ${opt.noQueue ? 'todo' : 'queued'} | [report](../../${report}) |\n`);
  console.log(`created ${id}; page ${rel(page)}; report ${report}; ${opt.noQueue ? 'not queued' : 'queued on ' + executor}`);
} finally { release(); }
