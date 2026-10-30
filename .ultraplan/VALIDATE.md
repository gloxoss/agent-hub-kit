# Traceability Matrix

## Summary
- Total requirements from discovery + PRD changes: 46
- Total tasks in plan: 63
- Requirements fully covered: 46
- Requirements partially covered: 0
- Requirements excluded (user choice): 3 (A7 app fixes, A47 server upgrade, paid lanes enabled)
- Tasks added beyond requirements (approved): 4 (04-04 log compaction, 07-06 worktree sweeper, 03-05 read-only reviewers, 13-01 metrics script)

## Requirement-to-Task Mapping

| # | Requirement | PRD | Section | Task IDs | Status |
|---|---|---|---|---|---|
| 1 | Stop quota drain first (A1) | 2, 4.1–4.3 | 00, 06 | 00-01, 06-02..06-06 | Covered |
| 2 | Runs all day; asks with drain reason when out (A2 + PRD change) | 1, 4.4 | 01, 06 | 01-04, 06-06 | Covered |
| 3 | Costly managers never code; cheap may edit (A3, A31 + PRD change) | 4.1 | 06 | 06-03, 06-04 | Covered |
| 4 | Pilot on SchoolOS (A4) | 8 | 12, 13 | 12-01..12-04, 13-02 | Covered |
| 5 | Fix WhatsApp noise / lost replies (A5) | 4.7 | 02 | 02-01, 02-02 | Covered |
| 6 | Fix stalls and crashes (A5) | 4.9 | 05, 06 | 05-01, 05-05, 05-06, 06-06 | Covered |
| 7 | Worktree per worker (A6) | 4.10 | 07 | 07-01..07-06 | Covered |
| 8 | Driver rewrite (A6, A40) | 4.14 | 06 | 06-01..06-08 | Covered |
| 9 | Migration lock (A6) | 4.11 | 08 | 08-01..08-03 | Covered |
| 10 | Fleet only, no app fixes (A7) | 7 | – | – | Excluded (user choice) |
| 11 | Several executors in parallel, 4–5 (A8, A12) | 3 | index | batches 1–4 | Covered |
| 12 | No Claude for execution (A9) | 3, 7 | 01, 06 | 01-01 roles, 06-03 | Covered |
| 13 | Phone and laptop both (A10) | 5 | 02, 11 | 02-*, 11-* | Covered |
| 14 | Short messages + task IDs + explanation (A11) | 5 | 02 | 02-03 | Covered |
| 15 | Full report as WhatsApp document (A13) | 5 | 02 | 02-05 | Covered |
| 16 | Rotate managers by remaining quota (A14) | 4.3 | 01, 06 | 01-03, 06-06 | Covered |
| 17 | Claude last resort, hourly cap (A15) | 4.3 | 01, 06 | 01-03, 06-06 | Covered |
| 18 | Ask the proxies before choosing (A16) | 4.3 | 01 | 01-02, 01-03, 01-06 | Covered (gap resolved) |
| 19 | PC + server together (A17) | 1, 4.12 | 05, 06, 10 | 05-06, 06-03 (Windows kill), 10-* | Covered (gap resolved) |
| 20 | Split by area + cross-review, lead (A18–A19) | 4.12 | 10 | 10-01..10-05 | Covered |
| 21 | Area handover via board note, owner decides (A20) | 4.12 | 10 | 10-02 | Covered |
| 22 | Keep GitHub board (A21) | 6 | 04, 10 | 04-03, 10-01 | Covered |
| 23 | One WhatsApp group per project (A22) | 6 | 02 | 02-04 | Covered |
| 24 | All down: pause, one message, resume alone (A23) | 4.4 | 06 | 06-06 | Covered |
| 25 | Broken build → rework on other lane, owner after 2 (A24) | 4.5 | 03 | 03-02, 03-04 | Covered |
| 26 | Restart alone and resume (A25) | 4.9 | 05 | 05-01, 05-06 | Covered |
| 27 | Re-run checks before accepting (A26) | 4.5 | 03 | 03-01, 03-02 | Covered |
| 28 | Same file: both work, merge later; merge-fixer task (A27 + Review 1) | 4.10 | 07 | 07-05 | Covered |
| 29 | Instant "got it" + answer later (A28) | 4.6 | 09 | 09-02 | Covered |
| 30 | Stop worker after 2x normal time (A29) | 4.9 | 05 | 05-05 | Covered |
| 31 | 4–6 manager turns/hour (A30) | 4.2, 8 | 06 | 06-02, 06-06 | Covered |
| 32 | Checks + different-agent review (A32) | 4.5 | 03 | 03-02, 03-03, 03-05 | Covered |
| 33 | Pause new work below 2 GB RAM / 5 GB disk (A33) | – | 05 | 05-03 | Covered |
| 34 | Secrets only through approved commands (A34) | – | 06 | 06-03, 06-04 | Covered |
| 35 | 12-hour proof run with numbers (A35) | 8 | 13 | 13-01..13-03 | Covered |
| 36 | Logs 7 days compressed (A36) | – | 05 | 05-02 | Covered |
| 37 | Keep reports, screenshots, rotation, quota status (A37) | 4.14 | 06 | 06-05, 06-07 | Covered |
| 38 | Merge SchoolOS hubs into .hub (A38) | – | 12 | 12-02 | Covered |
| 39 | Promote good project rules to kit (A39) | – | 12 | 12-03 | Covered |
| 40 | Live rollout with quick rollback (A41) | – | 06, PLAN | 06-08 | Covered |
| 41 | Keep features, document well (A42) | – | 13 | 13-04 | Covered |
| 42 | Grow disk + worktree cleanup (A43) | 9 | 05, 07 | 05-04, 07-05, 07-06 | Covered |
| 43 | Free lanes only, paid off but switchable (A45) | 9 | 01 | 01-01, 01-05 | Covered |
| 44 | Track spend, no cap (A46) | 9 | 06, 11 | 06-05, 11-01 | Covered |
| 45 | Message shape, numbered decisions, hourly heartbeat, dashboard, night rules (A48–A53 + PRD change) | 5, 4.7–4.8 | 02, 06, 11 | 02-03, 02-04, 06-07, 11-01..11-03 | Covered |
| 46 | Account registry + one-command onboarding; Claude #2 manager-only; side responder (PRD changes) | 6, 4.6 | 01, 09 | 01-01, 01-05, 09-01..09-03 | Covered |

## Gap Resolution Log
| # | Gap Type | Description | Resolution | Date |
|---|---|---|---|---|
| 1 | Missing requirement | Builders/reviewers not chosen by remaining quota (A16) | Added 01-06 to section 01 | 2026-10-30 |
| 2 | Missing requirement | PC manager had no auto-restart (A17) | Added 05-06 (Windows Task Scheduler supervisor) | 2026-10-30 |
| 3 | Scope creep | 04-04 weekly history compaction | Kept (user approved) | 2026-10-30 |

## Follow-up Audit Finding Traceability

| Finding | Planned resolution | Task |
|---|---|---|
| Informal operator questions lacked live fleet state; Markdown/HANDOFF parsers did not match real files | Digest every operator message from event/job records and documented headings, with populated fixtures | 06-07 |
| Reporter expected nonexistent job fields and repeated idle updates | Reconstruct active jobs from launch records and liveness; suppress unchanged idle pulses | 06-07 |
| Invalid accept/dispatch command examples | Verify exact legacy bridge command syntax against shipped entry points | 06-07 |
| Wrong model health probe and cold proxy false lockout | Remove billable pings; quota-only check, correct Gemini model, cold proxy is not down | 06-03, 06-06 |
| Cumulative token counts treated as per-turn usage | Store cumulative readings and compute session deltas | 06-05 |
| WhatsApp reply dedupe, including idle report repetition | Replies bypass dedupe; auto reports only on state change | 02-01, 06-07 |
| OpenCode DeepSeek free allowance exhausted on both test machines | Classify as quota exhaustion, stop retries, cool down, and fall back to the next enabled account | 01-05, 06-06 |
| SchoolOS lane discovery returned no lanes | Resolve configured and nested tsconfig lanes, then use documented fallback | 01-06 |
| Deferred review failures were cached as handled | Retry until a real dispatch job exists | 03-04 |
| Port 3401 died on transient PostgreSQL disconnect | Catch/log schedule query failures and run Next under systemd | 05-01 |
| Outgoing commits were not safely synchronized | Build/check, inspect exact outgoing commits, push verified branch and record SHA | 12-04 |
| Screenshot locale/redirect/memory failures | Add `/en`, authorization redirect and Chromium resource smoke cases | 13-02 |
