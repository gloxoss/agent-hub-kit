// Add the shared-board and multi-machine sync hooks to an existing hub folder without overwriting its local edits.
// Usage: node board-upgrade.mjs <hubDir> <engineDir> [--enable]
import fs from 'node:fs';
import path from 'node:path';

const [hub, engine] = process.argv.slice(2);
if (!hub || !engine || process.argv.includes('--help')) {
  console.log('usage: node board-upgrade.mjs <hubDir> <engineDir> [--enable]');
  console.log('Adds the shared GitHub board (board.mjs) and multi-machine sync (sync.mjs) hooks to an existing hub.');
  process.exit(0);
}
const enable = process.argv.includes('--enable');
const patch = (file, pairs) => {
  const f = path.join(hub, file);
  let s = fs.readFileSync(f, 'utf8');
  for (const [marker, from, to] of pairs) {
    if (s.includes(marker)) continue;
    if (!s.includes(from)) throw new Error(`${file}: anchor not found: ${from.slice(0, 70)}`);
    s = s.replace(from, () => to);
  }
  fs.writeFileSync(f, s);
  console.log(`patched ${file}`);
};
const eng = (file) => fs.readFileSync(path.join(engine, file), 'utf8');
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)) + b.length);

for (const f of ['board.mjs', 'sync.mjs']) fs.copyFileSync(path.join(engine, f), path.join(hub, f));

const hubEng = eng('hub.mjs');
patch('hub.mjs', [
  ["import os from 'node:os'", "import fs from 'node:fs';\n", "import fs from 'node:fs';\nimport os from 'node:os';\n"],
  ['const NODE = (process.env.DEVBOX_NODE', 'function emit(type, data) {\n  const ev = { t: now(), type, agent: me ?? null, ...data };',
    between(hubEng, '// Every event names the machine', 'node: NODE, ...data };')],
]);

const dEng = eng('dispatch.mjs');
const claimBlock = between(dEng, '  // Shared board: when several machines', "    if (!taskIds.length) process.exit(0);\n  }");
patch('dispatch.mjs', [
  ['board.mjs\'), \'claim\'', "  if (laneArg !== 'auto' && taskIds.length > 1) throw new Error('a fixed lane takes one task; use auto for several');",
    "  if (laneArg !== 'auto' && taskIds.length > 1) throw new Error('a fixed lane takes one task; use auto for several');\n" + claimBlock],
]);

const aEng = eng('autoloop.mjs');
// Two independent blocks, each guarded by its own marker, so re-running the tool never duplicates one.
const boardBlock = between(aEng, '  // Shared board: mirror', '.unref();\n  }\n');
const syncBlock = between(aEng, '  // Multi-machine sync:', '.test(line)) say(line);\n  }\n');
const digest = '  if (Date.now() - st.lastDigest > DIGEST_MS) {';
patch('autoloop.mjs', [
  ['{ execFileSync, spawn, spawnSync }', "import { execFileSync, spawnSync } from 'node:child_process';", "import { execFileSync, spawn, spawnSync } from 'node:child_process';"],
  ['lastBoardSync', digest, boardBlock + '\n' + digest],
  ['st.lastSync = Date.now()', digest, syncBlock + '\n' + digest],
]);

const cfgFile = path.join(hub, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.board = { syncMinutes: 3, ...cfg.board, enabled: enable || !!cfg.board?.enabled };
cfg.sync = { minutes: 5, ...cfg.sync, enabled: enable || !!cfg.sync?.enabled };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
console.log(`board ${cfg.board.enabled ? 'enabled' : 'installed (off)'} in ${hub}`);
