# Section 13: 12-hour proof run and docs

## Overview
Measure the new fleet for 12 hours against today's numbers, then update the guides so any future
project and machine uses the same setup.

## Risk: [green] - Measurement and documentation.

## Dependencies
- Depends on: all previous sections
- Blocks: none
- Parallel batch: 4

## TDD Test Stubs
- Test: the metrics script produces all 7 numbers from the ledger, jobs and WhatsApp history.
- Test: docs mention no removed commands (grep for `nohup next dev`, `check-quotas.mjs`, `.agent-hub-orch`).

## Tasks

<task type="auto" id="13-01">
  <name>Metrics script</name>
  <files>engine/tools/fleet-metrics.mjs (new)</files>
  <action>
    For a time window: manager turns/hour, Claude turns and cost, VIOLATION count, WhatsApp automatic vs reply messages and
    duplicates, owner questions and time to first reply, tasks accepted with gate+review evidence, crashes/restarts (from
    `journalctl --user -u orch@…`), all-down episodes with/without a drain message. Output plain text + JSON.
  </action>
  <verify>Run on the last 24 h of today's logs → baseline numbers printed (the "before").</verify>
  <done>Success can be measured, not guessed.</done>
</task>

<task type="auto" id="13-02">
  <name>Baseline, then 12-hour run</name>
  <files>docs/reports/fleet-proof-<date>.md (new)</files>
  <action>
    Record the baseline from 13-01. Run the new fleet on SchoolOS for 12 hours with normal work. Produce the report with
    before/after per PRD §8 criterion (PASS/FAIL each) and send it with `wa report`.
  </action>
  <verify>Report exists, every PRD §8 criterion has a number and PASS/FAIL.</verify>
  <done>The owner has proof the fleet works, or a precise list of what doesn't.</done>
</task>

<task type="checkpoint" id="13-03">
  <name>Owner reviews the proof report</name>
  <files>docs/reports/fleet-proof-<date>.md</files>
  <action>Send the report summary; ask "1 accept 2 fix the FAIL items first". Stop until answered.</action>
  <verify>Owner answer recorded.</verify>
  <done>The owner decided on the result.</done>
</task>

<task type="auto" id="13-04">
  <name>Update the guides</name>
  <files>devbox: GUIDE.md, CHECKLIST.md, ORCHESTRATOR-CONTROL.md; kit: engine/ORCHESTRATOR.md, docs/plans/FLEET-HARDENING-PLAN.md (mark superseded)</files>
  <action>
    Document: account registry and `devbox lanes`, orchestrator service commands and dashboard, WhatsApp format/budget/numbered
    answers/quiet hours, side responder, areas and lead, worktrees and migration lock, acceptance gates. Remove `nohup` dev-server
    recipes, `check-quotas.mjs`, Claude-first orders. Add "new project" and "new machine" steps that use these features.
  </action>
  <verify>grep for removed items returns nothing; checklist steps run end-to-end on a scratch project.</verify>
  <done>Anyone (human or agent) can run the fleet from the docs alone.</done>
</task>
