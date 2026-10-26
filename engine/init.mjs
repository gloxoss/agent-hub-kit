#!/usr/bin/env node
// Scaffold without replacing files. Run: node init.mjs --pack generic --name Project [--target dir] [--dir .agent-hub].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);
const opt = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help' || key === '-h') { console.log('usage: init.mjs --pack <name> --name <project> [--target dir] [--dir .agent-hub]'); process.exit(0); }
  if (!['--pack', '--name', '--target', '--dir'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('invalid option: ' + key);
  opt[key.slice(2)] = process.argv[++i];
}
if (!opt.pack || !opt.name) throw new Error('usage: init.mjs --pack <name> --name <project> [--target dir] [--dir .agent-hub]');
const defaults = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const HUB_DIR = opt.dir ?? defaults.hubDir ?? '.agent-hub';
if (!/^[A-Za-z0-9._-]+$/.test(HUB_DIR) || ['.', '..'].includes(HUB_DIR)) throw new Error('--dir must be one directory inside the target');
if (!/^[A-Za-z0-9_-]+$/.test(opt.pack)) throw new Error('invalid pack name');
const PACK_DIR = path.join(KIT, 'packs', opt.pack);
if (!fs.existsSync(path.join(PACK_DIR, 'PACK.md'))) throw new Error('unknown pack: ' + opt.pack);
const TARGET = path.resolve(opt.target ?? process.cwd());
const HUB = path.join(TARGET, HUB_DIR);
const TMPL = path.join(KIT, 'templates');
const vars = { PROJECT: opt.name, ROOT: TARGET.replace(/\\/g, '/'), PACK: opt.pack, HUB_DIR, MERGE_TARGET: 'main' };
const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
function write(file, text) {
  if (fs.existsSync(file)) { console.log('SKIP  ' + path.relative(TARGET, file)); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log('OK    ' + path.relative(TARGET, file));
}
function tree(src, dest, template = false) {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name), to = path.join(dest, entry.name.replace(/\.tmpl$/, ''));
    if (entry.isDirectory()) tree(from, to, template);
    else write(to, template ? fill(fs.readFileSync(from, 'utf8')) : fs.readFileSync(from));
  }
}
console.log('Scaffolding ' + opt.name + ' (pack: ' + opt.pack + ') in ' + TARGET);
for (const name of ['hub.mjs', 'dispatch.mjs', 'autoloop.mjs', 'quota.mjs', 'accept.mjs', 'board.mjs', 'sync.mjs', 'executors.json']) write(path.join(HUB, name), fs.readFileSync(path.join(HERE, name)));
write(path.join(HUB, 'config.json'), JSON.stringify({ ...defaults, hubDir: HUB_DIR }, null, 2) + '\n');
tree(path.join(HERE, 'tools'), path.join(HUB, 'tools'));
write(path.join(HUB, 'events.jsonl'), '');
write(path.join(HUB, 'autoloop-queue.json'), '{}\n');
for (const name of ['tasks', 'runs', 'skills', 'skills-cache', 'pages']) fs.mkdirSync(path.join(HUB, name), { recursive: true });
for (const name of ['PROTOCOL.md', 'STYLE.md']) write(path.join(HUB, name), fill(fs.readFileSync(path.join(TMPL, name), 'utf8')));
for (const name of ['brief.md', 'report-task.md', 'page-brief.md', 'findings-page.html']) write(path.join(HUB, 'templates', name), fill(fs.readFileSync(path.join(TMPL, name), 'utf8')));
tree(path.join(TMPL, 'prompts'), path.join(HUB, 'templates', 'prompts'), true);
tree(path.join(TMPL, 'pages'), path.join(HUB, 'pages'), true);
tree(path.join(TMPL, 'tutor'), path.join(HUB, 'tutor'), true);
for (const name of ['AGENTS', 'CLAUDE']) write(path.join(TARGET, name + '.md'), fill(fs.readFileSync(path.join(TMPL, name + '.md.tmpl'), 'utf8')));
tree(path.join(TMPL, 'docs'), path.join(TARGET, 'docs'), true);
tree(path.join(PACK_DIR, 'docs'), path.join(TARGET, 'docs'), true);
tree(path.join(PACK_DIR, 'skills'), path.join(TARGET, '.claude', 'skills'), true);
tree(path.join(PACK_DIR, 'agents'), path.join(TARGET, '.claude', 'agents'), true);
write(path.join(HUB, 'PACK.md'), fill(fs.readFileSync(path.join(PACK_DIR, 'PACK.md'), 'utf8')));
// Init never replaces an existing index. Rescan explicitly after changing skillRoots.
if (!['index.json', 'INDEX.md', 'STARTER.md'].some((name) => fs.existsSync(path.join(HUB, 'skills', name)))) {
  const result = spawnSync(process.execPath, [path.join(HUB, 'tools', 'skills.mjs'), 'build'], { cwd: TARGET, encoding: 'utf8', windowsHide: true });
  if (result.status === 0) console.log(result.stdout.trim());
  else console.log('Skill index not built. Configure skillRoots, then run skills.mjs build.');
}
console.log('\nDone. Next:\n  cd "' + TARGET + '"\n  node ' + HUB_DIR + '/hub.mjs join --agent orchestrator --role orchestrator --tool claude\n  node ' + HUB_DIR + '/hub.mjs status\n  node ' + HUB_DIR + '/tools/skills.mjs build\nConfigure ' + HUB_DIR + '/config.json paths and executors before dispatch. Tutor: ' + HUB_DIR + '/tutor/TUTOR.md');
