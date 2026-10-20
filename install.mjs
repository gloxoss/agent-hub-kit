#!/usr/bin/env node
// Install the kit as a global Claude skill, so any workspace can scaffold an agent hub from it.
//
//   node install.mjs [--dry]
//
// Copies this folder to ~/.claude/skills/agent-hub-orchestrator/, backing up an existing installation
// to ~/.claude/skill-backups/agent-hub-orchestrator.bak-<date> first, then stamps KIT-SOURCE and
// engine/config.json kit.version + kit.source, and prints the first-run commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SKILLS = path.join(os.homedir(), '.claude', 'skills');
const DEST = path.join(SKILLS, 'agent-hub-orchestrator');
const DRY = process.argv.includes('--dry');
const stamp = new Date().toISOString().slice(0, 10);

// Master kit git repo (separate from any workspace that installs a copy).
const DEFAULT_MASTER = 'C:/Users/OMEN/OneDrive/Documents/projects/agent-hub-kit';

// Backups live outside ~/.claude/skills, or Claude Code loads them as a second skill with the same triggers.
const BACKUPS = path.join(os.homedir(), '.claude', 'skill-backups');

function backupName() {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const base = path.join(BACKUPS, `agent-hub-orchestrator.bak-${stamp}`);
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

function count(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? count(path.join(dir, entry.name)) : 1;
  }
  return n;
}

function show(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Resolve the master kit path and write KIT-SOURCE + config stamp into DEST. */
function stampInstall(dest) {
  // Prefer an existing master repo; fall back to the folder we just installed from (dev / dry-test).
  const master = fs.existsSync(DEFAULT_MASTER) ? DEFAULT_MASTER : show(SRC);
  const kitSourcePath = path.join(dest, 'KIT-SOURCE');
  fs.writeFileSync(kitSourcePath, `${show(master)}\n`);

  const cfgPath = path.join(dest, 'engine', 'config.json');
  const cfg = readJson(cfgPath, {});
  const version = cfg.kit?.version ?? '0.1.0';
  cfg.kit = {
    ...(cfg.kit || {}),
    version,
    source: show(master),
  };
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { master: show(master), version };
}

const exists = fs.existsSync(DEST);
const backup = exists ? backupName() : null;
const files = count(SRC);

console.log(`agent-hub kit installer`);
console.log(`  source: ${show(SRC)} (${files} files)`);
console.log(`  target: ${show(DEST)}`);
console.log(`  backup: ${backup ? show(backup) : 'none (no existing install)'}`);
console.log(`  master: ${show(DEFAULT_MASTER)} (KIT-SOURCE; falls back to source if missing)`);

if (DRY) {
  console.log(`\nDRY RUN - nothing written. Would ${exists ? 'back up the old copy, then ' : ''}copy ${files} files, write KIT-SOURCE, and stamp engine/config.json kit.version + kit.source.`);
} else {
  fs.mkdirSync(SKILLS, { recursive: true });
  if (exists) {
    fs.renameSync(DEST, backup);
    console.log(`\nbacked up the previous install to ${show(backup)}`);
  }
  fs.cpSync(SRC, DEST, { recursive: true });
  const stamped = stampInstall(DEST);
  console.log(`\ninstalled ${files} files to ${show(DEST)}`);
  console.log(`KIT-SOURCE → ${stamped.master}`);
  console.log(`kit.version=${stamped.version} kit.source=${stamped.master}`);
}

console.log('\nFirst run (in the workspace to set up):');
console.log(`  1. node ${show(path.join(DEST, 'engine', 'init.mjs'))} --pack generic --name <project>`);
console.log(`  2. node .agent-hub/hub.mjs join --agent orchestrator --role orchestrator --tool claude`);
console.log(`  3. node .agent-hub/hub.mjs status`);
