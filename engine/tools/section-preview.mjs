// After a section task is accepted: takes the original-versus-rebuild pictures of that section at three widths and adds it to
// the rolling page docs/preview/sections/index.html, so the owner can open one page and see every accepted section.
//
//   node MORENE/ops/e2e/section-preview.mjs <site> <section-id> [--orig "<selector>"]
//
// The original's selector is read from the audit (docs/audits/<site>/home.md, the line "Root selector:" under "### <site>/home#<id>")
// unless --orig is given. The rebuilt root must carry data-section="<site>-<section-id>".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.length < 4) {
  console.log('usage: section-preview.mjs <site> <section-id> [--orig "<selector>"]');
  process.exit(process.argv.length < 4 ? 2 : 0);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const [site, id] = process.argv.slice(2, 4);
const oi = process.argv.indexOf('--orig');
let orig = oi > 0 ? process.argv[oi + 1] : null;

if (!orig) {
  try {
    const audit = fs.readFileSync(path.join(ROOT, 'docs/audits', site, 'home.md'), 'utf8');
    const head = audit.split('\n').findIndex((l) => l.startsWith('### ') && l.includes(`home#${id}`));
    if (head >= 0) {
      const lines = audit.split('\n').slice(head, head + 12);
      const m = lines.map((l) => l.match(/\*\*Root selector:\*\*\s*`([^`]+)`/)).find(Boolean);
      if (m) orig = m[1];
    }
  } catch { /* fall through */ }
}
if (!orig) { console.error(`no original selector for ${site}#${id}: pass --orig "<selector>"`); process.exit(2); }

const outRoot = path.join(ROOT, 'docs', 'preview', 'sections');
const siteDir = path.join(outRoot, site);
fs.mkdirSync(siteDir, { recursive: true });
const tmp = path.join(HERE, 'out', 'section');
const results = [];
for (const w of [1440, 768, 390]) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'section-compare.mjs'), site, '--orig', orig, '--rebuild', `[data-section="${site}-${id}"]`, '--width', String(w), '--out', tmp], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  const text = `${r.stdout}${r.stderr}`;
  const diff = (text.match(/difference: width (-?[\d.]+)%\s+height (-?[\d.]+)%/) || []);
  const name = String(`[data-section="${site}-${id}"]`).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
  const src = path.join(tmp, `${site}-${name}-${w}-side.png`);
  let file = null;
  if (fs.existsSync(src)) { file = `${site}/${id}-${w}.png`; fs.copyFileSync(src, path.join(outRoot, file)); }
  results.push({ w, file, dw: diff[1] ?? null, dh: diff[2] ?? null, error: /ERROR/.test(text) ? (text.match(/ERROR[^\n]*/) || [''])[0] : null });
}

const dataFile = path.join(outRoot, 'accepted.json');
let all = [];
try { all = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { /* first one */ }
all = all.filter((s) => !(s.site === site && s.id === id));
all.push({ site, id, at: new Date().toISOString(), results });
fs.writeFileSync(dataFile, JSON.stringify(all, null, 1));

const badge = (v) => (v == null ? '<span class="off">n/a</span>' : Math.abs(Number(v)) <= 2 ? `<span class="good">${v}%</span>` : Math.abs(Number(v)) <= 10 ? `<span class="mid">${v}%</span>` : `<span class="off">${v}%</span>`);
const cards = all.sort((a, b) => b.at.localeCompare(a.at)).map((s) => `
  <section class="card" id="${s.site}-${s.id}">
    <h2>${s.site} &middot; ${s.id} <small>accepted ${s.at.slice(0, 16).replace('T', ' ')} UTC</small></h2>
    <p class="muted">Live: <a href="http://localhost:3001/showcase/${s.site}">localhost:3001/showcase/${s.site}</a> (scroll to the <b>${s.id}</b> section)</p>
    <table><tr><th>Width</th><th>Section width gap</th><th>Section height gap</th></tr>${s.results.map((r) => `<tr><td>${r.w}</td><td>${badge(r.dw)}</td><td>${badge(r.dh)}</td></tr>`).join('')}</table>
    <div class="tabs">${s.results.map((r) => `<details ${r.w === 1440 ? 'open' : ''}><summary>${r.w} px: original left, rebuild right</summary>${r.file ? `<img loading="lazy" src="${r.file}" alt="${s.site} ${s.id} ${r.w}">` : `<p class="off">${r.error ?? 'no picture'}</p>`}</details>`).join('')}</div>
  </section>`).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accepted Sections</title>
<style>
:root{--bg:#f7f6f2;--ink:#1c262c;--muted:#5b6870;--card:#fff;--line:#dedbd0;--accent:#0b4a5a;--ok:#1f7a4d;--warn:#b26a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#12171a;--ink:#e8ecee;--muted:#9aa8b0;--card:#1b2226;--line:#2b363c;--accent:#6cc4d8;--ok:#5bd08f;--warn:#e8a23a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:1500px;margin:0 auto;padding:16px 16px 80px}
h1{font-size:24px}h2{font-size:20px;margin:0 0 4px}h2 small{font-weight:400;color:var(--muted);font-size:13px;margin-left:8px}.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:18px 0}
table{border-collapse:collapse;font-size:14px;margin:8px 0}th,td{padding:5px 12px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}
.good{color:var(--ok);font-weight:600}.mid{color:var(--warn);font-weight:600}.off{color:var(--bad);font-weight:600}
details{margin:6px 0}summary{cursor:pointer;font-weight:600;padding:4px 0}img{max-width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px}a{color:var(--accent)}
</style></head><body><main>
<h1>Accepted sections: original (left) against our rebuild (right)</h1>
<p class="muted">Newest first. A gap within 2% means the section box matches the original; still look at the picture for colours, fonts and layout. Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Pictures are local; live links need the dev server on this PC.</p>
${cards}
</main></body></html>`;
fs.writeFileSync(path.join(outRoot, 'index.html'), html);
console.log(`preview updated: ${path.join('docs', 'preview', 'sections', 'index.html')}`);
for (const r of results) console.log(`${r.w}px  width ${r.dw ?? 'n/a'}%  height ${r.dh ?? 'n/a'}%${r.error ? '  ' + r.error : ''}`);
