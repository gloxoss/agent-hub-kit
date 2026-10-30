# Section 03: Acceptance gates

## Overview
Work is accepted only when its stated checks pass when re-run by the acceptance step, and a different
helper reviewed it. Claims in a report never count by themselves.

## Risk: [yellow] - Check commands come from briefs; they must be run safely (timeouts, no network surprises).

## Dependencies
- Depends on: none
- Blocks: section-07
- Parallel batch: 1

## TDD Test Stubs
- Test: a task whose brief check exits 1 is rejected, not accepted, even with `VERDICT: PASS`.
- Test: a task reviewed by the same executor that built it is refused.
- Test: a check that runs longer than its timeout fails the gate.
- Test: tasks with no stated check are accepted only for non-code phases (chore/audit).

## Tasks

<task type="auto" id="03-01">
  <name>Read the check commands from the brief</name>
  <files>engine/accept.mjs</files>
  <action>
    Add `checksFor(taskId)`: read `<hub>/tasks/<id>.md`, take the fenced block under a "Done when" / "Verify" heading,
    keep lines that look like commands (start with `node `, `npm `, `npx `, `pnpm `, `git diff`, `bash `). Reject
    anything containing `rm -rf`, `curl … | sh`, `sudo`, `git push`. Return the list.
  </action>
  <verify>Unit fixture brief → expected command list; a brief with `sudo` returns that line rejected.</verify>
  <done>Acceptance knows exactly which checks to re-run for a task.</done>
</task>

<task type="auto" id="03-02">
  <name>Re-run checks before committing</name>
  <files>engine/accept.mjs</files>
  <action>
    Before `hub accept`, run each check with `spawnSync` (cwd = the task's working folder, which is ROOT until section 07),
    timeout `config.acceptCheckTimeoutSec` (default 600), capture the last 40 lines. Any non-zero exit: do not accept;
    run `hub reject <id> --note "gate: <cmd> exit N"` and write `<hub>/runs/<id>.gate.log`; print `GATE FAIL <id>`.
    Code phases (build/assemble/scaffold/tokens) with no checks: reject with "no runnable check in brief".
  </action>
  <verify>Fixture hub with two tasks (passing and failing check) → one ACCEPTED, one REWORK with gate log.</verify>
  <done>Accepted work has passed its own checks on this machine, just now.</done>
</task>

<task type="auto" id="03-03">
  <name>Different-agent review rule</name>
  <files>engine/accept.mjs</files>
  <action>
    Read the review job record from `runs/jobs.jsonl`; refuse acceptance if the reviewer executor equals the builder
    executor (same account id), printing `GATE FAIL <id>: self-review`. Record `gate: pass, checks: N, reviewer: X` in
    the accept note.
  </action>
  <verify>Fixture where reviewer = builder → refused; different → accepted with the note.</verify>
  <done>No helper ever approves its own work.</done>
</task>

<task type="auto" id="03-04">
  <name>Autoloop surfaces gate failures</name>
  <files>engine/autoloop.mjs (accept call ~162 and rework branch only)</files>
  <action>
    When `accept.mjs` prints `GATE FAIL`, treat it like a review FAIL: rework on a different builder; after 2 gate
    failures print `DECIDE <id>: gate failed twice (<cmd>)` so the orchestrator wakes. Add a selftest step: a task whose
    brief check is `node -e "process.exit(1)"` ends in REWORK.
  </action>
  <verify>`node engine/selftest.mjs` passes including the new gate step.</verify>
  <done>Broken work goes back to a builder automatically and the owner hears only after two failures.</done>
</task>

<task type="auto" id="03-05">
  <name>Reviewers are read-only in every family</name>
  <files>engine/executors.json (kit default), templates/opencode/audit.md (new)</files>
  <action>
    Add an OpenCode agent file `audit.md` (frontmatter `permission: { edit: deny, bash: { "*": deny, "git diff *": allow,
    "git status *": allow, "node *test*": allow, "npx vitest *": allow } }`) that init/agentify copies to `.opencode/agents/`.
    Kit default reviewer commands: Claude family `--disallowedTools Edit,Write,MultiEdit,NotebookEdit`, Codex
    `--sandbox read-only` (or `codex review --uncommitted`), OpenCode `--agent audit` and never `--auto`. A review job that
    changes any tracked file (git status before/after) is marked FAILED with "reviewer modified files".
  </action>
  <verify>Scratch repo: an OpenCode review asked to edit a file leaves git status clean; a fake reviewer that edits is marked FAILED.</verify>
  <done>No reviewer can change the code it is reviewing.</done>
</task>
