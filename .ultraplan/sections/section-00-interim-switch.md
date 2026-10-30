# Section 00: Interim safety switch (do first)

## Overview
SchoolOS keeps building normally on the current fleet while the new one is built. To stop the Claude drain
meanwhile, take the owner's own Claude account out of the current orchestrator order. Nothing else changes.

## Risk: [green] - One settings change, reversible with one command.

## Dependencies
- Depends on: none
- Blocks: none (do before Batch 1)
- Parallel batch: 0

## TDD Test Stubs
- Test: `/orch status` in the SchoolOS group no longer lists `claude-sonnet`.
- Test: the orchestrator log shows the next turn on a non-Claude entry.

## Tasks

<task type="auto" id="00-01">
  <name>Remove the owner's Claude from the live order</name>
  <files>server: ~/projects/lango-english-center-project-fully/.agent-hub-orch/orch-control.json (via the driver command)</files>
  <action>
    On the server run `devbox orch order lango-english-center-project-fully claude-ag2@gemini-3-flash,codex`
    (no file editing by hand). Do not restart anything. Rollback: `devbox orch order lango-english-center-project-fully default`.
  </action>
  <verify>`devbox orch status lango-english-center-project-fully` prints an order without `claude-sonnet`.</verify>
  <done>The current fleet no longer uses the owner's Claude account while the rebuild happens.</done>
</task>
