# Kit sync

Installed hubs may gain tools, fixes, or templates the master kit lacks. Offer those improvements upstream; never push without an explicit yes from the user.

## Master

Default master kit path: `C:/Users/OMEN/OneDrive/Documents/projects/agent-hub-kit`.

Resolution order for sync commands:

1. Workspace `.agent-hub/config.json` → `kit.source` (and `kit.version`)
2. `~/.claude/skills/agent-hub-orchestrator/KIT-SOURCE` (written by `install.mjs`)

`install.mjs` stamps both. `init.mjs` copies `config.json` into each new workspace.

## Commands

Run from the workspace root:

```bash
node .agent-hub/tools/kit-sync.mjs check [--quiet]
node .agent-hub/tools/kit-sync.mjs propose
node .agent-hub/tools/kit-sync.mjs apply <proposal> [--yes]
node .agent-hub/tools/kit-sync.mjs pull [--yes]
```

| Command | Effect |
|---|---|
| `check` | Compare instance engine files, `tools/`, and `templates/` to the master. Prints `NEW`, `CHANGED`, or `MASTER-NEWER` per file (master-only files are `MASTER-NEWER` pull candidates). Ignores runtime files (events, runs, tasks, state, queue, BOARD, CHANGELOG, generated indexes). Exit 0 always. |
| `check --quiet` | One line `KIT-UPGRADE <n> new, <m> changed`, or silence. |
| `propose` | Write `.agent-hub/kit-proposals/<date>-<n>.md` with reasons, unified diffs, `snapshot-sha256` markers, and generic-ness flags (project names, absolute paths, emails). |
| `apply <proposal> --yes` | Copy **only** NEW/CHANGED items listed in that proposal, and only if instance content still matches the reviewed snapshot. Refuses items that stay project-specific after safe generalize. Bumps `kit.version` minor, appends master `CHANGELOG.md`, prints git commit commands. **Requires `--yes`.** Never commits or pushes. |
| `pull --yes` | Copy MASTER-NEWER files into the instance (backup under `kit-proposals/` first; creates files that do not exist yet). For `engine/config.json`, updates only kit metadata and preserves workspace settings. **Requires `--yes`.** |

## Orchestrator rules

1. Run `check` at session start, after adding or fixing any hub tool, and whenever a DIGEST line contains `KIT-UPGRADE`.
2. If anything is listed, run `propose`.
3. Ask the user **one** question summarizing the items (upgrade vs pull).
4. Only on yes: `apply --yes` and/or `pull --yes`. Then show the printed commit commands for the master repo.
5. Without a yes: leave the proposal on disk; do not apply.

## Autoloop hook

The digest tick may call `kit-sync.mjs check --quiet` and print its output. Lines containing `KIT-UPGRADE` wake the orchestrator (same as other DIGEST signals). The engine owns autoloop wiring; this doc only defines the contract.
