#!/usr/bin/env bash
# Upgrade a hub's engine files from the kit. Usage: hub-upgrade.sh <hubDir> [--apply]
# Without --apply it only prints what it would do. Keeps the hub's data, config, executors, templates and tools;
# replaces the engine scripts and merges the new config keys. Backs up every replaced file to <hub>/engine.prev/.
set -euo pipefail
HUB="$(cd "${1:?hub dir}" && pwd)"
APPLY="${2:-}"
KIT="${KIT:-$HOME/.local/share/agent-hub-kit/engine}"
FILES="hub.mjs dispatch.mjs autoloop.mjs accept.mjs quota.mjs board.mjs sync.mjs fold.mjs accounts.mjs"
echo "hub: $HUB   kit: $KIT"
for f in $FILES; do
  if cmp -s "$HUB/$f" "$KIT/$f" 2>/dev/null; then echo "  same    $f"; else echo "  replace $f ($(wc -l < "$HUB/$f" 2>/dev/null || echo 0) -> $(wc -l < "$KIT/$f") lines)"; fi
done
[ "$APPLY" = "--apply" ] || { echo "(dry: nothing written; add --apply)"; exit 0; }
PREV="$HUB/engine.prev/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$PREV"
for f in $FILES config.json; do [ -f "$HUB/$f" ] && cp "$HUB/$f" "$PREV/$f"; done
for f in $FILES; do cp "$KIT/$f" "$HUB/$f"; done
# helper modules the engine imports; the hub keeps every tool it already has
mkdir -p "$HUB/tools"; for t in runtime.mjs; do [ -f "$HUB/tools/$t" ] || cp "$KIT/tools/$t" "$HUB/tools/$t"; done
# Settings that keep the project's own rules: values already in the hub's config always win; only missing keys are added.
node - "$HUB/config.json" "$KIT/config.json" <<'JS'
const fs = require('fs');
const [live, kit] = process.argv.slice(2);
const l = JSON.parse(fs.readFileSync(live, 'utf8'));
const k = JSON.parse(fs.readFileSync(kit, 'utf8'));
const merge = (a, b) => { for (const key of Object.keys(b)) { if (a[key] === undefined) a[key] = b[key]; else if (a[key] && b[key] && typeof a[key] === 'object' && !Array.isArray(a[key]) && typeof b[key] === 'object' && !Array.isArray(b[key])) merge(a[key], b[key]); } return a; };
merge(l, k);
// Rules the owner set on the old engine, carried over as config:
l.checkHealthBeforeDispatch = true;      // "check quota/health before running agents"
l.resources = { ...(l.resources ?? {}), buildMinFreeMB: 3000, reviewMinFreeMB: 1500, minFreeDiskGB: 3 };   // old hard floor: 3000 MB
l.cooldownMinutes = l.cooldownMinutes ?? 20;                             // rotating Gemini accounts: one QUOTA hit = one account
l.acceptGate = l.acceptGate ?? 'warn';                                   // record failing checks, do not bounce work back until the machine can run them
if (!l.orchestratorAgent) l.orchestratorAgent = process.env.ORCH_AGENT || l.orchestratorAgent;
l.worktrees = { ...(l.worktrees ?? {}), enabled: false };                // needs the bigger disk first
l.board = { ...(l.board ?? {}), enabled: false };
l.sync = { ...(l.sync ?? {}), enabled: false };
fs.writeFileSync(live, JSON.stringify(l, null, 2) + '\n');
console.log('config merged: gate=' + l.acceptGate + ' worktrees=' + l.worktrees.enabled + ' ram floor=' + l.resources.buildMinFreeMB + ' cooldown=' + l.cooldownMinutes + 'm health-check=' + l.checkHealthBeforeDispatch);
JS
echo "upgraded; previous files in $PREV"
