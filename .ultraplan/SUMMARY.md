# UltraPlan Summary: Fleet hardening

## What We're Building
An upgraded team of AI helpers that builds software all day on its own without draining the owner's Claude
time: a manager plans and checks (never coding on costly models), 4–5 non-Claude builders work in their own
copies, and the PC and every server share projects by area. The owner steers from WhatsApp (plain, numbered
messages) or a live terminal dashboard, and is told clearly why when allowances run out.

## Key Features
- Costly managers (Claude, Codex) can't write code; cheap ones (Gemini pool) may; violations stop the turn
- Manager wakes only for decisions, owner messages and problems (about 4–6 turns per hour)
- Every manager, builder and reviewer is picked by remaining allowance; owner's Claude last, with a notice
- Out of allowance: one message with why it drained and how to fix it (`devbox lanes add`)
- Acceptance re-runs the task's checks and needs a review by a different helper
- Side responder answers instantly while the manager is busy, then hands the conversation over
- WhatsApp: replies never dropped, automatic messages ≤ 4/hour merged, numbered decisions, reports as files
- Worktree per task with a merge-fixer task on clashes; one database change at a time
- PC + servers: area claims, a lead with a failover lease, cross-machine reviews
- Auto-restart on Linux (systemd) and Windows (Task Scheduler), 7-day logs, RAM/disk gates, live dashboard
- Audit hardening: truthful fleet digests/reporter, retryable deferred reviews, lane fallback, resilient port 3401, and guarded branch sync

## Tech Stack
- Node ESM (built-ins only) for the engine; bash for devbox
- git worktrees, gh CLI + GitHub contents API (lease), WAHA Core
- systemd user units (Linux), Task Scheduler (Windows)
- CLIProxyAPI + Antigravity proxy for quota data
- Agent CLIs: codex, opencode, cursor-agent; Claude Code launchers for manager/responder roles only

## Risk Areas
- [red] Section 06 driver v2: live critical path (rollback with `.prev`)
- [red] Section 07 worktrees: changes dispatch/accept core flow; disk use
- [red] Section 10 multi-machine: distributed coordination over GitHub
- [yellow] Section 02 WhatsApp: ban risk if budgets are wrong
- [yellow] Section 05 runtime: systemd delegation, owner disk resize

## Plan Structure
- 14 sections, 63 total tasks (59 auto, 4 owner checkpoints)
- 5 batches: 0 (interim switch), 1 (5 in parallel), 2, 3, 4
- Hard dependencies: S01+S02 → S06; S03 → S07 → S08; S06 → S09/S10/S11; S06+S07+S08 → S12; all → S13

## How to Execute This Plan
1. Run Section 00 first (one command, stops the Claude drain on SchoolOS today).
2. Give each executor (Codex, Gemini lanes, OpenCode, Cursor; never Claude) this message:
   "Read `.ultraplan/sections/index.md` (rules + your batch), then execute section NN task by task.
   After each task, report in the PLAN.md §Reporting format and stop."
3. Batch 1: five executors take sections 01–05 in parallel (respect the autoloop.mjs order in the index).
4. After each batch, the orchestrator reviews reports, then starts the next batch.
5. Section 13 runs the 12-hour proof and updates the guides.

## How to Update This Plan
Run: /ultraplan update
Describe what changed, and only affected sections will be regenerated.
