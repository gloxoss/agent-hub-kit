# R-session-report · chore · Full session report and project documentation

> Read-only on source and hub files; write only the files in scope. No browser, no code changes.

Allowed scope: `docs/reports/<date>-session-report.md`, `docs/reports/PROJECT-OVERVIEW.md`.

## Goal
The user is pausing this project. Write the documents they and any future agent need to understand everything that exists and what remains, without reading the chat.

## Load (just in time, nothing else)
- The hub: `.agent-hub/events.jsonl` (every task added, claimed, done, accepted, rejected, with timestamps), `.agent-hub/CHANGELOG.md` (worker reports), `.agent-hub/runs/jobs.jsonl` and the `.agent-hub/runs/*.log` tails (which executor ran which job, and token/cost figures where the logs carry them).
- Git: `git log --stat --since=<start date>` (commits).
- Project docs: `AGENTS.md`, the system docs, the migration/decisions ledger and handoff, the plans, the verify reports.
- Quota: run `node .agent-hub/quota.mjs` once for the current snapshot (copy status lines only; never a key).

## Steps
1. Write `docs/reports/PROJECT-OVERVIEW.md`, the stable map: purpose, project tree with one line per folder, how the system works, routes or entry points, and the agent workflow (orchestrator, hub, dispatcher, autoloop, reviewer chain, stop rule, executors, quota audit).
2. Write `docs/reports/<date>-session-report.md`, what happened:
   1. TL;DR (three lines).
   2. Targets: what the user asked for, and where that came from.
   3. Timeline: per day or phase, with task counts from the events.
   4. Results per area: what exists, what passes, what is open.
   5. Findings: problems met and how they were fixed.
   6. Effort: tasks added / accepted / reworked / cancelled, commits, jobs per executor, wall-clock span.
   7. Quota and cost: sum what the logs report; write "not reported by this CLI" where they do not (never invent a number). Add the quota snapshot.
   8. What remains: open tasks, the backlog, the next planned batch, anything waiting on the user.
   9. How to resume: exact commands and where to look first.
3. Rewrite `docs/NEXT-SESSION.md` from section 8 and 9.

## Out of scope
Source files, task briefs, the hub engine, commits. Report a deviation instead of fixing it.

## Done when
Every file in scope exists, every number cites its source in a short parenthesis, and nothing claims a result the sources do not show.

## Report back
`done --summary` names the three files and the resume command. If a section cites a source that is missing, say so in `--verify` rather than guessing.
