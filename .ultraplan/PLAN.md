# Technical Plan: Fleet hardening

## Architecture overview
```
                 owner (WhatsApp group per project / terminal dashboard)
                        │ replies always · automatic ≤ 4/h merged · numbered decisions
             ┌──────────┴──────────┐
        wa.mjs v2 (S02)        dashboard (S11)
             │                      │ reads files only
   ┌─────────┴─────────────────────────────────────────────┐
   │ orchestrator driver v2 (S06)  [one per machine/project] │
   │  events → wake filter → select (accounts.pick, S01)    │
   │  runner (caps, tool denial for costly) + guard         │
   │  telemetry ledger · reports · /orch · side responder (S09)
   │  lead lease + area claims (S10)                         │
   └─────────┬──────────────────────────────────────────────┘
             │ hub CLI (events.jsonl, shared fold S04)
   autoloop → dispatch (resource gate S05, migration lock S08, area gate S10)
             → builders in worktrees (S07) → review (different agent)
             → accept: re-run checks (S03) → merge → cleanup → sync push
   runtime: systemd user units, logrotate, disk growth (S05)
```

## Tech stack
Node ESM (built-ins only), bash (devbox), git worktrees, gh CLI / GitHub contents API (lease), WAHA Core,
systemd user units, CLIProxyAPI + Antigravity proxy for quota data. Agent CLIs: codex, opencode, cursor-agent,
Claude Code launchers (manager/responder roles only).

## Sections
See `sections/index.md` (14 sections, 63 tasks, 4 batches, file ownership per batch).

## Dependency graph
```
S01 ──┬──> S06 ──┬──> S09
S02 ──┘          ├──> S10 <── S04
                 ├──> S11 <── S01
                 └──> S12 <── S07 <── S03, S08 <── S07
S05 ─────────────────────────────────────────────> S13 <── all
```

## Parallel batch execution order
0. Batch 0: S00 interim switch (one command, before anything else)
1. Batch 1 (5 executors in parallel): S01, S02, S03, S04, S05
2. Batch 2: S06 ∥ S07, then S08 (after S07, same file)
3. Batch 3: S09 ∥ S10 ∥ S11
4. Batch 4: S12, then S13

Totals: 14 sections, 63 tasks (59 auto, 4 owner checkpoints: 05-04 disk, 07-02 worktree design approval, 12-01 quiet window, 13-03 proof review).

## Reporting (every task)
```
TASK <id> · <name>
Changed: <files with line ranges>
Commands run + real output: <…>
Verify: PASS | FAIL (<why>)
Noticed, not fixed: <list>
```
The orchestrator reviews each report and answers "next" or a fix list.

## Rollout and rollback
Straight to live (owner choice). Before replacing a live engine file on the server keep `<file>.prev`;
rollback = restore `.prev`, `node install.mjs`, restart the orchestrator. Never restart with a file that
fails `node --check`.

## Review Notes

### Review Date: 2026-10-30

### Self-Review Results
- Total issues found: 8
- Auto-fixed: 8
- User decisions: 0 (blocking) + 7 refinement answers

### Category Results
| Category | Result |
|---|---|
| Completeness | WARN, 2 auto-fixed (05-05 slow-worker cutoff; per-lane usage in 11-01) |
| Consistency | WARN, 3 auto-fixed (Gemini roles text, service wording, autoloop.mjs edit order in Batch 1) |
| Feasibility | PASS (note: Codex command events for the guard are "if exposed") |
| Security | WARN, 2 auto-fixed (secret-read denials in 06-03/06-04; reviewers read-only, new 03-05) |
| Scalability | PASS |
| Edge Cases | WARN, 1 auto-fixed (WhatsApp outbox + retry in 02-01) |
| User Experience | PASS |
| Cost & Complexity | PASS (large by choice; 5 batches) |

### Refinement Questions Asked
1. Merge clash after acceptance → dedicated merge-fixer task `F-merge-<id>` on another builder (07-05).
2. SchoolOS during the rebuild → keep building normally.
3. Interim protection → yes, one switch: remove the owner's Claude from the live order (new section 00).
4. Unanswered numbered questions → remind every hour, day and night (06-07).
5. Owner's Claude used → one line with the reason (06-06).
6. Night reminders → not paused (same as 4).
7. Responder vs manager mismatch → manager corrects in its next message (09-03).

### Sections Modified
00 (new), 01, 02, 03 (+03-05), 05 (+05-05), 06, 07, 09, 11, index, PLAN totals (14 sections, 61 tasks).

### Follow-up audit findings folded into existing tasks
- S06-03/06-05/06-07: no paid model pings; correct Gemini probe/default; cumulative token deltas; real event/job schemas and handoff headings; valid bridge CLI examples; live digest on every operator message; active-job and duplicate-idle reporting.
- S01-05/01-06/S03-04: explicit free-quota exhaustion triggers cooldown and fallback; configured/project-relative lane resolution has a non-empty fallback; deferred reviews remain retryable until a dispatch is actually recorded.
- S02-01: duplicate suppression stays on automatic messages, never owner replies.
- S05-01/S12-04: persist port 3401 and isolate transient PostgreSQL idle failures; verify outgoing branch contents and checks before sync.
- S13-02: exercise locale, unauthorized redirect, and memory-safe browser capture cases.
- Task count is unchanged; each finding is attached to an existing task and gate.
