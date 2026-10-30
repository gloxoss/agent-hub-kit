# Section Index

## Overview
Total sections: 14
Total tasks: 63
Parallel batches: 5 (Batch 0 = interim switch)

## Rules for every executor (read once, apply to every task)
- **Executors are non-Claude lanes** (Codex, Gemini via Antigravity, OpenCode, Cursor). Never Claude.
- **Read only the files a task lists**, with the line ranges given. `orch-driver.mjs` is 1,104 lines:
  never read it whole. Use RESEARCH.md for context instead of re-exploring.
- **Repos and paths** (always use absolute paths in task briefs and commands)
  - Kit: /home/dev/.local/share/agent-hub-kit on the VPS (pushed to gloxoss/agent-hub-kit); use <kit-root>/engine/….
  - Devbox: /home/dev/devbox (gloxoss/devbox); use <devbox-root>/services/whatsapp/wa.mjs, bin/devbox, and modules/*.sh.
  - SchoolOS pilot: /home/dev/projects/lango-english-center-project-fully; hub .agent-hub-orch/ (becomes .hub/ in section 12).
  - From the PC, ssh vps-dev reaches the agents user; ssh vps reaches the admin account.
  - **Never interpret a path relative to whichever hub happens to be active.** Put the owning repo root in every brief and run each command from that root.
- **Zero new dependencies.** Node ESM, built-ins only; bash for devbox.
- **Ship flow for kit changes:** `node --check <file>` → `cd /tmp && node <kit>/engine/selftest.mjs` (all steps pass) →
  commit + push in the kit → on the server `git -C ~/.local/share/agent-hub-kit pull --ff-only && node ~/.local/share/agent-hub-kit/install.mjs`
  → `node --check` the installed file on the server. **Never restart an orchestrator with a file that fails `node --check`.**
- **Rollout:** straight to live with a quick rollback: before replacing a live file, keep `<file>.prev`; rollback = copy back + restart.
- **Audit and continue automatically:** after each worker finishes, check its non-empty absolute scope against the plan and exact changed-file list, inspect the diff, run the task verification in the owning repo, and accept or rework. Record the result in PLAN.md, then dispatch the next dependency-ready task without waiting for an operator message. Keep independent safe lanes busy and obey shared-file order.
- **Acceptance is not a Git merge:** call work merged only after the accepted task files are committed in the owning repository; report the commit SHA.
- **Pause only** for a task explicitly marked type=checkpoint, a genuine safety/scope blocker, or the consolidated final report after Section 13. Do not pause after routine audits or task completions.
- Tasks marked `type="checkpoint"` need the owner: stop and send the stated message.

## Batch Execution Order

### Batch 0 (do first, one command)
- Section 00: Interim safety switch [green]

### Batch 1 (parallel, no dependencies)
- Section 01: Account registry and quota source [yellow]
- Section 02: WhatsApp messaging v2 [yellow]
- Section 03: Acceptance gates [yellow]
- Section 04: Hub hygiene [green]
- Section 05: Runtime and ops [yellow]

### Batch 2 (depends on Batch 1)
- Section 06: Orchestrator driver v2 [red]   (needs 01, 02)
- Section 07: Worktree per task [red]        (needs 03)
- Section 08: Database change lock [green]   (needs 07; same file, run after it)

### Batch 3 (depends on Batch 2)
- Section 09: Side responder [yellow]        (needs 06, 02)
- Section 10: Multi-machine areas and lead [red] (needs 06, 04)
- Section 11: Live terminal dashboard [green] (needs 06, 01)

### Batch 4 (depends on everything above)
- Section 12: SchoolOS migration [yellow]    (needs 06, 07, 08)
- Section 13: 12-hour proof run and docs [green] (needs all)

## Section Manifest

| # | Section | Risk | Batch | Depends On | Blocks |
|---|---------|------|-------|------------|--------|
| 00 | interim-switch | green | 0 | none | none |
| 01 | account-registry | yellow | 1 | none | 06, 11 |
| 02 | whatsapp-v2 | yellow | 1 | none | 06, 09 |
| 03 | acceptance-gates | yellow | 1 | none | 07 |
| 04 | hub-hygiene | green | 1 | none | 10 |
| 05 | runtime-ops | yellow | 1 | none | 13 |
| 06 | driver-v2 | red | 2 | 01, 02 | 09, 10, 11, 12 |
| 07 | worktrees | red | 2 | 03 | 08, 12 |
| 08 | migration-lock | green | 2 | 07 | 12 |
| 09 | side-responder | yellow | 3 | 06, 02 | 13 |
| 10 | multi-machine | red | 3 | 06, 04 | 13 |
| 11 | dashboard | green | 3 | 06, 01 | 13 |
| 12 | schoolos-migration | yellow | 4 | 06, 07, 08 | 13 |
| 13 | proof-run-docs | green | 4 | all | none |

## File ownership per batch (prevents collisions between parallel executors)
- Batch 1: S01 `engine/quota.mjs`, new `engine/accounts.mjs`, devbox `bin/devbox` (lanes subcommand only) · S02 devbox `services/whatsapp/wa.mjs` · S03 `engine/accept.mjs`, `engine/autoloop.mjs` (accept call only) · S04 `engine/hub.mjs`, `engine/board.mjs` · S05 devbox `modules/90-services.sh`, new devbox `services/orch/`, `engine/dispatch.mjs` (resource gate only).
- Batch 2: S06 new `engine/orchestrator/*` + `engine/tools/orch-driver.mjs` · S07 `engine/dispatch.mjs`, `engine/accept.mjs` · S08 after S07 on `engine/dispatch.mjs`.
- Batch 3: S09 `engine/orchestrator/responder.mjs` · S10 `engine/board.mjs`, new `engine/orchestrator/lead.mjs` · S11 new `engine/tools/dashboard.mjs`.

### Shared-file order inside Batch 1
`engine/autoloop.mjs` is touched by three Batch 1 tasks in separate regions. Apply them in this order, each
starting from the previous commit: 03-04 (accept/rework branch) → 04-01 (hourly gc hook) → 05-05 (slow-job check) → 01-06 (quota-ranked builder/reviewer choice).
`engine/dispatch.mjs`: 05-03 (resource gate) and 05-05 (duration history) are in the same section, same executor.
