#!/usr/bin/env node
// Build one readable HTML page of all audit findings with their fix status, for the owner.
//   node .agent-hub/tools/findings-page.mjs [out.html]
// Sources: config.audit.dir (finding blocks) and config.audit.fixes (status).
// Re-run after fixes land; output stays local.
import { fileURLToPath } from 'node:url';
import { help, auditPath, CFG as CONFIG, hubDir, projectPath } from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';

help("usage: findings-page.mjs [out.html]");

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = auditPath('dir');
const out = process.argv[2] ?? path.join(HUB, 'runs', 'findings.html');

const HIDDEN = new Set(CONFIG.audit?.hiddenLanes ?? []);
const LANE_NAME = CONFIG.audit?.laneNames ?? {};

const status = {};
for (const line of (fs.existsSync(auditPath('fixes')) ? fs.readFileSync(auditPath('fixes'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^(A-[a-z-]+-\d+) \|([^|]*)\|([^|]*)\|?(.*)$/);
  if (!m) continue;
  const s = m[2].trim();
  const kind = /^false alarm$/i.test(s) ? 'false' : /^blocked/i.test(s) ? 'blocked'
    : /^fixed/i.test(s) && /blocked|outside (task )?scope|needs|follow-up|still/i.test(s) ? 'partial'
    : /^fixed/i.test(s) ? 'fixed' : 'open';
  status[m[1]] = { kind, note: s.replace(/^fixed\s*/i, '').replace(/^\(|\)$/g, '').trim(), files: m[3].trim(), test: m[4].trim() };
}

const rows = [];
for (const f of (fs.existsSync(AUDIT) ? fs.readdirSync(AUDIT) : []).filter((x) => /^A-.+\.md$/.test(x)).sort()) {
  const lane = f.slice(2, -3);
  const blocks = fs.readFileSync(path.join(AUDIT, f), 'utf8').split(/\r?\n(?=### A-)/).slice(1);
  for (const b of blocks) {
    const head = b.match(/^### (A-[a-z-]+-\d+) · (P\d) · (.+)/);
    if (!head) continue;
    const field = (name) => (b.match(new RegExp(`^- ${name}: ([^\\n]*)`, 'm'))?.[1] ?? '').trim();
    const quote = (b.match(/^\s+> (.*)$/m)?.[1] ?? '').trim();
    rows.push({
      id: head[1], p: head[2], cat: head[3].trim(), lane, module: LANE_NAME[lane] ?? lane, v1: !HIDDEN.has(lane),
      where: field('Where'), evidence: field('Evidence'), quote, problem: field('Problem'), impact: field('Impact'), fix: field('Fix'), known: field('Known'),
      st: status[head[1]]?.kind ?? 'open', stNote: status[head[1]]?.note ?? '', stFiles: status[head[1]]?.files ?? '',
    });
  }
}
rows.sort((a, b) => a.p.localeCompare(b.p) || a.lane.localeCompare(b.lane) || Number(a.id.split('-').pop()) - Number(b.id.split('-').pop()));

const generated = new Date().toISOString().slice(0, 16).replace('T', ' ');
const tmpl = fs.readFileSync(path.join(HUB, 'templates', 'findings-page.html'), 'utf8');
// JSON inside a <script>: escape "<" so a quoted "</script>" in evidence cannot end the block.
const data = JSON.stringify(rows).replace(/</g, '\\u003c');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, tmpl.replace('__DATA__', data).replace('__GENERATED__', generated));
const c = (k) => rows.filter((r) => r.st === k).length;
console.log(`${rows.length} findings -> ${out}  (fixed ${c('fixed')}, partly ${c('partial')}, false alarm ${c('false')}, blocked ${c('blocked')}, open ${c('open')})`);
