# Section 12: SchoolOS migration

## Overview
Move SchoolOS onto the new system: one hub folder `.hub`, the good project rules promoted into the kit,
the account registry and orchestrator order set, worktrees on, and the new driver running.

## Risk: [yellow] - Live project state is moved; must be done when no job runs, with a backup.

## Dependencies
- Depends on: section-06, section-07, section-08
- Blocks: section-13
- Parallel batch: 4

## TDD Test Stubs
- Test: after the merge, `node .hub/hub.mjs status` shows the same task counts as before.
- Test: no file outside `.hub` references `.agent-hub-orch` or `.agent-hub` (grep).
- Test: the orchestrator starts on `.hub` and runs a START turn.

## Tasks

<task type="checkpoint" id="12-01">
  <name>Owner: confirm a quiet window</name>
  <files>none</files>
  <action>Send: "SchoolOS migration needs no running jobs for ~20 min. Reply 'go' when OK." Wait for "go".</action>
  <verify>Owner replied go.</verify>
  <done>The migration runs at an agreed moment.</done>
</task>

<task type="auto" id="12-02">
  <name>Merge the three hub folders into .hub</name>
  <files>lango repo: .hub/, .agent-hub/, .agent-hub-orch/, docs/archive/hubs/ (new)</files>
  <action>
    Stop the orchestrator and autoloop; tar the three folders to `~/backups/lango-hubs-<date>.tgz`. Live state = `.agent-hub-orch`:
    move its events.jsonl, tasks/, runs/, templates/, executors.json, config.json values into `.hub/` (engine files from the kit);
    set `hubDir: ".hub"`, locales `["fr","en","ar"]`. Move the other two folders to `docs/archive/hubs/`. Update `CLAUDE.md`/`AGENTS.md`
    references.
  </action>
  <verify>Task counts from `hub.mjs status` equal the pre-migration counts (print both); grep finds no stale hub paths outside the archive.</verify>
  <done>SchoolOS has one hub in the standard place, with history archived.</done>
</task>

<task type="auto" id="12-03">
  <name>Promote good project rules into the kit</name>
  <files>agent-hub-kit: templates/prompts/*.md, engine/ORCHESTRATOR.md; lango: .hub/templates/*</files>
  <action>
    Diff lango's templates (worker.md, review.md, page brief) and ORCHESTRATOR rules against the kit. Move rules that are
    general (scope discipline, skill binding, evidence quoting, vitest unit-only verification) into the kit templates; keep
    SchoolOS-specific ones (roles, logins, routes) in the project. List each moved rule in the report.
  </action>
  <verify>Kit selftest passes; the report lists moved vs kept rules.</verify>
  <done>Every project benefits from what SchoolOS learned.</done>
</task>

<task type="auto" id="12-04">
  <name>Accounts, order and worktrees on; start</name>
  <files>lango: .hub/accounts.json, .hub/config.json</files>
  <action>
    Write accounts.json from the example with the owner's real entries (paid disabled); `orchestrator` block per section 06;
    `worktrees.enabled: true`; `resources` gates; `screenshotCommand` pointing at the project's own screenshot script if present.
    Re-enable the reviewer list without write-capable OpenCode (use an `audit` agent with edit/bash denied, per RESEARCH.md).
    Before sync, record branch/upstream divergence, run the project build and required checks, inspect the exact outgoing commits
    for secrets and unintended files, and push only the verified target branch. Record the pushed SHA. Start: `devbox orch enable` + `start`.
  </action>
  <verify>`devbox orch status` active; the log shows a START turn by the top-ranked manager; `/orch status` in the group lists the new order.</verify>
  <done>SchoolOS runs fully on the new fleet.</done>
</task>
