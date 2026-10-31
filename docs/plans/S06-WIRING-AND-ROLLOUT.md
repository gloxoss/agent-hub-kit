# S06 wiring and rollout: finish the fleet hardening (executor brief)

Written 2026-10-31 by the orchestrator after the delivery audit (`docs/reports/fleet-audit-2026-10-31.md`).
Executor: a non-Claude lane (Codex or Gemini). One task at a time; report in the PLAN.md format and stop.

## State right now (verified on dev-box)
- Kit `agent-hub-kit` and `devbox` are committed and pushed (kit `2c1bd61`, devbox `e501b56`). Selftest 9/9, every `.mjs` passes `node --check`.
- Modules exist and pass their own fixture tests: `engine/orchestrator/{config,state,events,guard,telemetry,runner,lead,responder}.mjs`, `engine/accounts.mjs`, `engine/fold.mjs`.
- **NOT wired:** `engine/tools/orch-driver.mjs` is still the old 1,123-line file; it imports only `responder.mjs`.
  Missing modules from section 06: `select.mjs`, `prompt.mjs`, `commands.mjs`, `report.mjs`.
- **NOT installed:** `~/.claude/skills/agent-hub-orchestrator` is the old copy (no `accounts.mjs`, `orchestrator/`, `dashboard.mjs`).
- **SchoolOS hub (`~/projects/lango-english-center-project-fully/.hub`) runs the old engine:** none of acceptance re-runs, worktrees,
  migration lock, disk gate, slow-worker stop, agent GC are present in its `*.mjs`.
- One orchestrator now runs (systemd `orch@lango-english-center-project-fully`); order is `claude-ag2@gemini-3-flash, codex`.
  The tmux copy, the stray `--dry` autoloop and the redundant watchdog service were stopped on 2026-10-31.

## Problems found that this work must fix (in addition to plan section 06)
1. **Registry mismatch (blocks everything).** `lango/.hub/accounts.json` uses `roles: ["worker","verifier"]` for the Gemini/Codex/Cursor
   entries, numeric `cost`, and owner `pool`. The plan and `accounts.mjs pick` use roles `orchestrator|builder|reviewer|responder`.
   Result today: `pick --role orchestrator` returns only the owner's Claude account. Decide one vocabulary (the plan's), update
   `accounts.example.json`, `validateAccountEntry`, and migrate lango's file. Keep `cost` as `free|plan|paid` strings OR numbers, but
   make it one choice documented in `accounts.example.json`.
2. **`accounts.mjs pick` ignores `--hub <dir>`** (it falls back to `.agent-hub`). Add the flag and default to the resolved hub (`.hub` first).
3. **`quota.mjs --json` needs the CLIProxyAPI key** (`CLIPROXY_KEY` in the vault env). The picker must load `~/.config/devbox/vault/env` itself
   or fail loudly, not silently treat accounts as "assumed healthy".
4. **Project text in the shared kit:** `engine/tools/orch-driver.mjs` lines ~759 ("Ossama (Epioso)") and ~771 (lango `NODE_PATH`);
   fixture strings with `lango-app/` in `engine/orchestrator/guard.mjs` (use `app/`). `grep -rn "lango\|Ossama\|/home/dev/projects" engine/` must return nothing.
5. **Live order still allows Kie and the owner's Claude** in some entries; enforce in `select.mjs`: never `claude-kie`/`codex-kie` for any
   role; owner-owned Claude last and only when every other entry is down, with the one-line notice from plan 06-06.
6. **The proof report is a placeholder** (`fleet-proof-<date>.md`, no measurements). It was moved to
   `~/backups/kit-leaks-20261031-1028/`. Task 13-02 must be redone with real numbers from `fleet-metrics.mjs`.
7. **Owner checkpoints were self-accepted** (`S-13-03`). The orchestrator must reopen `S-13-03`, `S-05-04`, `S-05-01` and `S-00-01` and leave them
   open until the owner confirms.

## Tasks (in order; each ends with real command output in the report)

### T1 · Registry vocabulary and picker fixes (problems 1–3)
Files: `engine/accounts.mjs`, `engine/accounts.example.json`, `lango/.hub/accounts.json` (on the server, via `devbox`/ssh).
Done when (run on the server with the vault env loaded):
`node engine/accounts.mjs pick --role orchestrator --hub ~/projects/lango-english-center-project-fully/.hub --json`
returns the Gemini pool entries first (Claude user account last or absent), each with a numeric `remaining` and a reason; and
`pick --role builder` returns builders without any Claude entry.

### T2 · Missing modules: select, prompt, commands, report (plan 06-06, 06-07)
Files (new): `engine/orchestrator/{select,prompt,commands,report}.mjs`. Use the existing modules' exports (listed in the plan section 06).
Rules to honor: Kie never; paid lanes only when `enabled`; owner Claude last with notice; one alert per down-set with
`explainDrain()` lines; quiet hours 23:00–08:00 (no routine, but one "nothing running" notice and replies always); numbered decisions
re-sent hourly, day and night; `/orch status|quotas|use|order|pause|resume|reset|models`; screenshot command from config only.
Done when each module has a fixture test (`node -e` or `--selftest`) printing PASS and the selftest still passes.

### T3 · Thin `orch-driver.mjs` entry (plan 06-08)
Replace the 1,123-line file with a thin entry (< 200 lines) wiring config → state → events → select → runner → telemetry → report → responder → lead.
Keep `--help`, `--cmd`, `--say`, `ORCH_DRY=1`. Remove problem-4 strings. Keep the old file as `engine/tools/orch-driver.legacy.mjs.prev` OUTSIDE the repo (backup folder), not committed.
Done when: `node --check`; `ORCH_DRY=1 node engine/tools/orch-driver.mjs <selftest workspace>` completes one wake cycle printing the chosen entry and the exact command line; `grep` check from problem 4 is empty; selftest 9/9 (add a step for the dry cycle).

### T4 · Ship: commit, install, upgrade SchoolOS hub (rollout, plan 12-02/12-04)
1. Commit T1–T3 in the kit (conventional messages, co-author trailer), push.
2. On dev-box: `git -C ~/.local/share/agent-hub-kit pull --ff-only && node ~/.local/share/agent-hub-kit/install.mjs`; `node --check` the installed driver.
3. **Only when `dispatch.mjs list` shows no RUNNING job:** back up `lango/.hub/*.mjs` to `~/backups/lango-hub-engine-<date>/`, then copy the kit engine files
   (`hub, dispatch, autoloop, accept, quota, board, sync, fold, accounts` + `orchestrator/`) into `.hub/` (keep `config.json`, `executors.json`, `accounts.json`, `events.jsonl`, `tasks/`, `runs/`). Merge new config keys (`worktrees`, `resources`, `board`, `sync`, `orchestrator`, `unclaimable`) without losing existing ones.
4. Restart only the service: `systemctl --user restart orch@lango-english-center-project-fully`. Watch 30 minutes: exactly one driver process, one autoloop, `driver up` then a START turn, no VIOLATION, no duplicate WhatsApp.
5. Rollback (if anything is off): restore the backup folder, `systemctl --user restart orch@lango…`, report.
Done when `ps` shows one driver + one autoloop, `/orch status` in the group shows the new format, and the log has no errors for 30 minutes.

### T5 · Verify the other sections against the live hub (re-open any that fail)
On the server, one command per claim, paste output:
acceptance re-run (a task with a failing check ends REWORK), worktree created for a dispatched task (`git worktree list`), migration lock refuses a parallel build,
disk/RAM gate message, slow-worker stop (fixture), `hub gc` reduces STALE count, `board.mjs area claim` works, dashboard `--once` renders, WhatsApp: same text twice with reply path delivers twice and `--auto` merges after 4/hour.
Any failure: create a follow-up task, do not mark the section done.

### T6 · Owner steps (stop and ask; do not self-accept)
- Disk: Oracle Console → boot volume 100 GB; then `growpart` + `resize2fs` (plan 05-04). Current: 32/45 GB used (71%).
- Worktree design approval (07-02) and quiet-window confirmation (12-01) if not recorded.
- Real 12-hour proof (13-02) with `fleet-metrics.mjs` numbers, then the owner reviews (13-03).

## Constraints (unchanged)
Non-Claude executors only. Zero new dependencies. Read only the files a task lists, with line ranges. Never restart a live process with a file that
fails `node --check`. No secrets in output or commits.
