#!/usr/bin/env node
// Compare an installed hub instance against the master kit; propose and apply upgrades upstream.
//
//   node .agent-hub/tools/kit-sync.mjs check [--quiet]
//   node .agent-hub/tools/kit-sync.mjs propose
//   node .agent-hub/tools/kit-sync.mjs apply <proposal> [--yes]
//   node .agent-hub/tools/kit-sync.mjs pull [--yes]
//
// Master path: instance config.json kit.source, else ~/.claude/skills/agent-hub-orchestrator/KIT-SOURCE.
// Never commits or pushes. apply requires --yes after the user agrees.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HUB = path.resolve(HERE, '..'); // .agent-hub/ when installed via init
const ROOT = path.resolve(HUB, '..');
const DEFAULT_MASTER = 'C:/Users/OMEN/OneDrive/Documents/projects/agent-hub-kit';
const SKILL_KIT_SOURCE = path.join(os.homedir(), '.claude', 'skills', 'agent-hub-orchestrator', 'KIT-SOURCE');

const RUNTIME_NAMES = new Set([
  'events.jsonl', 'BOARD.md', 'CHANGELOG.md', 'autoloop-state.json', 'autoloop-queue.json',
  'jobs.jsonl', 'agents.json', 'PROTOCOL.md', 'PACK.md', 'STYLE.md',
]);
const RUNTIME_DIRS = new Set(['runs', 'tasks', 'state', 'queue', 'kit-proposals']);

const args = process.argv.slice(2);
const cmd = args[0];
const quiet = args.includes('--quiet');
const yes = args.includes('--yes');

function usage() {
  console.log('usage: kit-sync.mjs check [--quiet] | propose | apply <proposal> [--yes] | pull [--yes]');
}
if (args.includes('--help') || args.includes('-h') || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}
if (!cmd || !['check', 'propose', 'apply', 'pull'].includes(cmd)) {
  usage();
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function show(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function loadConfig() {
  return readJson(path.join(HUB, 'config.json'), {});
}

function resolveMaster(cfg) {
  if (cfg.kit?.source) return path.resolve(cfg.kit.source);
  if (fs.existsSync(SKILL_KIT_SOURCE)) {
    const p = fs.readFileSync(SKILL_KIT_SOURCE, 'utf8').trim();
    if (p) return path.resolve(p);
  }
  return path.resolve(DEFAULT_MASTER);
}

function walkFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (RUNTIME_DIRS.has(entry.name)) continue;
      walkFiles(full, base, out);
    } else {
      if (RUNTIME_NAMES.has(entry.name)) continue;
      if (/\.generated\./.test(entry.name)) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

/** Build maps of syncable relative keys → absolute paths for instance and master. */
function inventory(hubDir, masterDir) {
  const instance = new Map();
  const master = new Map();

  // Engine top-level files (hub.mjs, config.json, …) live at hub root; in master under engine/.
  for (const entry of fs.readdirSync(hubDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (RUNTIME_NAMES.has(entry.name)) continue;
    if (/\.generated\./.test(entry.name)) continue;
    const key = `engine/${entry.name}`;
    instance.set(key, path.join(hubDir, entry.name));
  }
  const masterEngine = path.join(masterDir, 'engine');
  if (fs.existsSync(masterEngine)) {
    for (const entry of fs.readdirSync(masterEngine, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      master.set(`engine/${entry.name}`, path.join(masterEngine, entry.name));
    }
  }

  // tools/
  for (const f of walkFiles(path.join(hubDir, 'tools'))) {
    instance.set(`engine/tools/${f.rel}`, f.full);
  }
  for (const f of walkFiles(path.join(masterDir, 'engine', 'tools'))) {
    master.set(`engine/tools/${f.rel}`, f.full);
  }

  // templates/ (instance templates/ ↔ master templates/)
  for (const f of walkFiles(path.join(hubDir, 'templates'))) {
    instance.set(`templates/${f.rel}`, f.full);
  }
  for (const f of walkFiles(path.join(masterDir, 'templates'))) {
    master.set(`templates/${f.rel}`, f.full);
  }

  return { instance, master };
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function mtime(file) {
  return fs.statSync(file).mtimeMs;
}

function instancePathFor(key, hubDir) {
  if (key.startsWith('engine/tools/')) return path.join(hubDir, 'tools', key.slice('engine/tools/'.length));
  if (key.startsWith('engine/')) return path.join(hubDir, key.slice('engine/'.length));
  if (key.startsWith('templates/')) return path.join(hubDir, key);
  return path.join(hubDir, key);
}

function contentSha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function classify(instanceMap, masterMap) {
  const items = [];
  const keys = new Set([...instanceMap.keys(), ...masterMap.keys()]);
  for (const key of [...keys].sort()) {
    const iPath = instanceMap.get(key);
    const mPath = masterMap.get(key);
    if (iPath && !mPath) {
      items.push({ key, kind: 'NEW', instance: iPath, master: null });
      continue;
    }
    // Master-only: pull candidate (new tools/templates added upstream).
    if (!iPath && mPath) {
      items.push({ key, kind: 'MASTER-NEWER', instance: null, master: mPath });
      continue;
    }
    if (!iPath || !mPath) continue;
    const iText = read(iPath);
    const mText = read(mPath);
    if (iText === mText) continue;
    const iMt = mtime(iPath);
    const mMt = mtime(mPath);
    if (iMt >= mMt) {
      items.push({ key, kind: 'CHANGED', instance: iPath, master: mPath });
    } else {
      items.push({ key, kind: 'MASTER-NEWER', instance: iPath, master: mPath });
    }
  }
  return items;
}

function unifiedDiff(aLabel, aText, bLabel, bText) {
  // Prefer system diff when available; fall back to a simple line diff.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-sync-'));
  const aFile = path.join(tmp, 'a');
  const bFile = path.join(tmp, 'b');
  fs.writeFileSync(aFile, aText);
  fs.writeFileSync(bFile, bText);
  try {
    const { execFileSync } = require('node:child_process');
    try {
      return execFileSync('git', ['diff', '--no-index', '--', aFile, bFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // git diff --no-index exits 1 when files differ
      if (e.status === 1 && e.stdout) {
        return String(e.stdout)
          .replace(aFile.replace(/\\/g, '/'), aLabel)
          .replace(bFile.replace(/\\/g, '/'), bLabel)
          .replace(aFile, aLabel)
          .replace(bFile, bLabel);
      }
    }
  } catch { /* ignore */ }

  const aLines = aText.split('\n');
  const bLines = bText.split('\n');
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`-${a}`);
    if (b !== undefined) out.push(`+${b}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return out.join('\n');
}

const DEFAULT_PRIVATE_NAMES = [
  'paraloca',
  'havinic',
  'snikei',
  'velora',
  'veloraskin',
  'ecom-os',
  'ParaLoca',
];

function getPrivateNames(cfg = {}) {
  if (Array.isArray(cfg.kit?.privateNames) && cfg.kit.privateNames.length > 0) {
    return cfg.kit.privateNames;
  }
  return DEFAULT_PRIVATE_NAMES;
}

function genericnessFlags(text, _key, cfg = {}) {
  const flags = [];
  // Windows drive paths, or Unix home/mnt paths (not the "/Users/" inside "C:/Users/...").
  const winPath = /[A-Za-z]:[\\/][^\s"'`,}]+/g;
  const unixPath = /(?<![A-Za-z:])\/(?:Users|home|mnt)\/[^\s"'`,}]+/g;
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // Project-ish names that often leak from a workspace into a shared kit.
  const names = getPrivateNames(cfg);
  if (names.length) {
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const projects = new RegExp(`\\b(${escaped})\\b`, 'gi');
    for (const m of text.match(projects) || []) flags.push(`project-name: ${m}`);
  }
  for (const m of text.match(winPath) || []) flags.push(`absolute-path: ${m}`);
  for (const m of text.match(unixPath) || []) flags.push(`absolute-path: ${m}`);
  for (const m of text.match(email) || []) flags.push(`email: ${m}`);
  return flags;
}

function reasonFor(item) {
  if (item.kind === 'NEW') return 'Present only in the instance; master has no copy.';
  if (item.kind === 'CHANGED') return 'Instance content differs and is newer by mtime.';
  if (!item.instance) return 'Present only in the master; pull to copy into the instance.';
  return 'Master content differs and is newer by mtime; consider pulling.';
}

/** Parse upgrade keys + reviewed content snapshots from a proposal markdown file. */
function parseProposal(proposalText) {
  const listed = [];
  const re = /^## (NEW|CHANGED): `([^`]+)`\s*$/gm;
  let m;
  while ((m = re.exec(proposalText)) !== null) {
    listed.push({ kind: m[1], key: m[2], index: m.index });
  }
  const out = [];
  for (let i = 0; i < listed.length; i++) {
    const start = listed[i].index;
    const end = i + 1 < listed.length ? listed[i + 1].index : proposalText.length;
    const block = proposalText.slice(start, end);
    const shaMatch = block.match(/<!--\s*snapshot-sha256:\s*([a-f0-9]{64})\s*-->/i);
    out.push({
      kind: listed[i].kind,
      key: listed[i].key,
      snapshotSha: shaMatch ? shaMatch[1].toLowerCase() : null,
    });
  }
  return out;
}

/** Merge master kit metadata into an existing workspace config.json without clobbering settings. */
function mergeKitMetadata(instanceText, masterText) {
  const existing = (() => { try { return JSON.parse(instanceText); } catch { return {}; } })();
  const masterCfg = (() => { try { return JSON.parse(masterText); } catch { return {}; } })();
  const next = { ...existing };
  next.kit = {
    ...(existing.kit || {}),
  };
  if (masterCfg.kit?.version != null) next.kit.version = masterCfg.kit.version;
  if (masterCfg.kit?.source != null) next.kit.source = masterCfg.kit.source;
  return `${JSON.stringify(next, null, 2)}\n`;
}

function bumpMinor(version) {
  const parts = String(version || '0.1.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[1] += 1;
  parts[2] = 0;
  return parts.join('.');
}

function generalize(text, cfg = {}) {
  // Safe, obvious substitutions only. Refuse items that still look project-specific after this.
  const names = getPrivateNames(cfg);
  let res = text;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    res = res.replace(new RegExp(`\\b${escaped}(?:-UI)?\\b`, 'gi'), '{{PROJECT}}');
  }
  return res;
}

function stillUnsafe(text, cfg = {}) {
  return genericnessFlags(text, '', cfg).length > 0;
}

function nextProposalPath(hubDir) {
  const dir = path.join(hubDir, 'kit-proposals');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  let n = 1;
  while (fs.existsSync(path.join(dir, `${stamp}-${n}.md`))) n += 1;
  return path.join(dir, `${stamp}-${n}.md`);
}

function masterDestFor(key, masterDir) {
  return path.join(masterDir, key);
}

// ---------- commands ----------

const cfg = loadConfig();
const masterDir = resolveMaster(cfg);

if (!fs.existsSync(masterDir)) {
  console.error(`master kit not found: ${show(masterDir)}`);
  console.error('Set config.json kit.source or write KIT-SOURCE, then retry.');
  process.exit(1);
}

const { instance, master } = inventory(HUB, masterDir);
const items = classify(instance, master);

if (cmd === 'check') {
  const neu = items.filter((i) => i.kind === 'NEW').length;
  const changed = items.filter((i) => i.kind === 'CHANGED').length;
  const masterNewer = items.filter((i) => i.kind === 'MASTER-NEWER').length;
  if (quiet) {
    if (neu || changed) console.log(`KIT-UPGRADE ${neu} new, ${changed} changed`);
    // MASTER-NEWER alone is a pull offer, not an upgrade line; still exit 0.
    process.exit(0);
  }
  if (!items.length) {
    console.log('kit-sync: instance matches master (no differences).');
    process.exit(0);
  }
  for (const it of items) {
    console.log(`${it.kind}\t${it.key}`);
  }
  if (masterNewer) console.log(`# ${masterNewer} MASTER-NEWER (offer pull)`);
  if (neu || changed) console.log(`# upgrade candidates: ${neu} new, ${changed} changed`);
  process.exit(0);
}

if (cmd === 'propose') {
  const upgrade = items.filter((i) => i.kind === 'NEW' || i.kind === 'CHANGED');
  const pulls = items.filter((i) => i.kind === 'MASTER-NEWER');
  if (!upgrade.length && !pulls.length) {
    console.log('kit-sync propose: nothing to propose.');
    process.exit(0);
  }
  const outPath = nextProposalPath(HUB);
  const lines = [
    `# Kit sync proposal`,
    ``,
    `- Instance: \`${show(HUB)}\``,
    `- Master: \`${show(masterDir)}\``,
    `- Created: ${new Date().toISOString()}`,
    `- kit.version (instance): ${cfg.kit?.version ?? '(unset)'}`,
    ``,
    `Ask the user before running \`apply --yes\`. Nothing is pushed without a yes.`,
    ``,
  ];
  for (const it of upgrade) {
    const iText = read(it.instance);
    const mText = it.master ? read(it.master) : '';
    const flags = genericnessFlags(iText, it.key, cfg);
    const diff = unifiedDiff(`master/${it.key}`, mText, `instance/${it.key}`, iText);
    const sha = contentSha(iText);
    lines.push(`## ${it.kind}: \`${it.key}\``);
    lines.push(``);
    lines.push(`Reason: ${reasonFor(it)}`);
    lines.push(``);
    lines.push(`<!-- snapshot-sha256: ${sha} -->`);
    lines.push(``);
    if (flags.length) {
      lines.push(`**Generic-ness flags (generalize before apply):**`);
      for (const f of flags) lines.push(`- ${f}`);
      lines.push(``);
    } else {
      lines.push(`Generic-ness: clean (no project names, absolute paths, or emails detected).`);
      lines.push(``);
    }
    lines.push('```diff');
    lines.push(diff.trimEnd());
    lines.push('```');
    lines.push(``);
  }
  if (pulls.length) {
    lines.push(`## MASTER-NEWER (pull candidates)`);
    lines.push(``);
    lines.push(`Ask whether to run \`kit-sync.mjs pull --yes\` for these:`);
    lines.push(``);
    for (const it of pulls) lines.push(`- \`${it.key}\` — ${reasonFor(it)}`);
    lines.push(``);
  }
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`wrote ${show(outPath)}`);
  process.exit(0);
}

if (cmd === 'apply') {
  const proposalArg = args.find((a, i) => i > 0 && !a.startsWith('--'));
  if (!proposalArg) {
    console.error('usage: kit-sync.mjs apply <proposal> [--yes]');
    process.exit(1);
  }
  if (!yes) {
    console.error('refusing: apply requires --yes after the user agrees to upgrade the master.');
    process.exit(1);
  }
  const proposalPath = path.resolve(ROOT, proposalArg);
  if (!fs.existsSync(proposalPath)) {
    // also try relative to hub / kit-proposals
    const alt = path.isAbsolute(proposalArg) ? proposalArg : path.join(HUB, 'kit-proposals', path.basename(proposalArg));
    if (!fs.existsSync(alt)) {
      console.error(`proposal not found: ${proposalArg}`);
      process.exit(1);
    }
  }
  const resolvedProposal = fs.existsSync(proposalPath)
    ? proposalPath
    : path.join(HUB, 'kit-proposals', path.basename(proposalArg));

  const proposalText = read(resolvedProposal);
  const proposed = parseProposal(proposalText);
  if (!proposed.length) {
    console.error('apply: proposal lists no NEW/CHANGED items.');
    process.exit(1);
  }

  const byKey = new Map(items.map((i) => [i.key, i]));
  const applied = [];
  const refused = [];
  for (const entry of proposed) {
    const it = byKey.get(entry.key);
    if (!it || (it.kind !== 'NEW' && it.kind !== 'CHANGED')) {
      refused.push({ key: entry.key, reason: 'not a current NEW/CHANGED upgrade candidate' });
      continue;
    }
    if (!it.instance || !fs.existsSync(it.instance)) {
      refused.push({ key: entry.key, reason: 'instance file missing' });
      continue;
    }
    let text = read(it.instance);
    const liveSha = contentSha(text);
    if (!entry.snapshotSha) {
      refused.push({ key: entry.key, reason: 'proposal missing snapshot-sha256 for reviewed content' });
      continue;
    }
    if (liveSha !== entry.snapshotSha) {
      refused.push({
        key: entry.key,
        reason: 'instance content changed since proposal (snapshot mismatch); re-run propose',
      });
      continue;
    }
    const flags = genericnessFlags(text, it.key, cfg);
    if (flags.length) {
      text = generalize(text, cfg);
      if (stillUnsafe(text, cfg)) {
        refused.push({ key: it.key, reason: `still project-specific after safe generalize: ${flags.join('; ')}` });
        continue;
      }
    }
    const dest = masterDestFor(it.key, masterDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    applied.push(it.key);
  }

  if (!applied.length) {
    console.error('apply: nothing applied.');
    for (const r of refused) console.error(`  REFUSE  ${r.key} (${r.reason})`);
    process.exit(1);
  }

  // Bump master kit.version and append CHANGELOG.
  const masterCfgPath = path.join(masterDir, 'engine', 'config.json');
  const masterCfg = readJson(masterCfgPath, {});
  const prev = masterCfg.kit?.version ?? cfg.kit?.version ?? '0.1.0';
  const next = bumpMinor(prev);
  masterCfg.kit = {
    ...(masterCfg.kit || {}),
    version: next,
    source: masterCfg.kit?.source ?? show(masterDir),
  };
  fs.writeFileSync(masterCfgPath, `${JSON.stringify(masterCfg, null, 2)}\n`);

  const clPath = path.join(masterDir, 'CHANGELOG.md');
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = [
    ``,
    `## ${next} — ${stamp}`,
    ``,
    `Upstream sync from instance \`${show(HUB)}\` (proposal \`${path.basename(resolvedProposal)}\`).`,
    ``,
    ...applied.map((k) => `- Applied \`${k}\``),
    ...refused.map((r) => `- Refused \`${r.key}\`: ${r.reason}`),
    ``,
  ].join('\n');
  if (fs.existsSync(clPath)) fs.appendFileSync(clPath, entry);
  else fs.writeFileSync(clPath, `# Changelog\n${entry}`);

  console.log(`applied ${applied.length} item(s) to ${show(masterDir)}`);
  for (const k of applied) console.log(`  OK  ${k}`);
  for (const r of refused) console.log(`  REFUSE  ${r.key} (${r.reason})`);
  console.log(`kit.version ${prev} → ${next}`);
  console.log('');
  console.log('Commit in the master kit repo (not run automatically):');
  console.log(`  cd ${show(masterDir)}`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "kit ${next}: sync from instance"`);
  process.exit(refused.length && !applied.length ? 1 : 0);
}

if (cmd === 'pull') {
  const pulls = items.filter((i) => i.kind === 'MASTER-NEWER');
  if (!pulls.length) {
    console.log('pull: no MASTER-NEWER items.');
    process.exit(0);
  }
  if (!yes) {
    console.error('refusing: pull requires --yes after the user agrees.');
    for (const it of pulls) console.error(`  ${it.key}`);
    process.exit(1);
  }
  const bakRoot = path.join(HUB, 'kit-proposals', `pull-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(bakRoot, { recursive: true });
  for (const it of pulls) {
    const dest = it.instance || instancePathFor(it.key, HUB);
    if (it.instance && fs.existsSync(it.instance)) {
      const bak = path.join(bakRoot, it.key.replace(/\//g, '__'));
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(it.instance, bak);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (it.key === 'engine/config.json' && fs.existsSync(dest)) {
      // Preserve workspace settings; update only kit.version / kit.source from master.
      const merged = mergeKitMetadata(read(dest), read(it.master));
      fs.writeFileSync(dest, merged);
      console.log(`pulled ${it.key} (kit metadata only; workspace config preserved)`);
    } else {
      fs.copyFileSync(it.master, dest);
      console.log(`pulled ${it.key}`);
    }
  }
  console.log(`backups in ${show(bakRoot)}`);
  process.exit(0);
}
