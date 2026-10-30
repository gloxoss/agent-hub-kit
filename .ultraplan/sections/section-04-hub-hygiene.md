# Section 04: Hub hygiene

## Overview
Keep the task hub clean so it never blocks itself: prune dead helpers, keep shared files unclaimable,
one task-state logic shared by hub and board, and a compact log.

## Risk: [green] - Contained to hub.mjs/board.mjs, covered by selftest.

## Dependencies
- Depends on: none
- Blocks: section-10
- Parallel batch: 1

## TDD Test Stubs
- Test: `hub gc --stale-min 120` emits `leave` for stale agents without claims and keeps those with claims.
- Test: claiming `FIXES.md` is refused with a pointer to `tools/fixes-add.mjs`.
- Test: board.mjs and hub.mjs fold the same event file to the same task statuses.
- Test: `hub compact` keeps the folded state identical.

## Tasks

<task type="auto" id="04-01">
  <name>Garbage-collect stale helpers</name>
  <files>engine/hub.mjs, engine/autoloop.mjs (one hourly call)</files>
  <action>
    Add `hub gc [--stale-min 120]`: for agents stale longer than N minutes with no live claim, emit `leave` with
    `by: "gc"`. Call it from the autoloop once per hour.
  </action>
  <verify>On a copy of lango's `.agent-hub-orch/events.jsonl`, `gc` reduces the STALE count from 29 to the number with live claims (print both).</verify>
  <done>The board shows only helpers that are actually alive.</done>
</task>

<task type="auto" id="04-02">
  <name>Shared files cannot be claimed</name>
  <files>engine/hub.mjs, engine/config.json</files>
  <action>
    Config `"unclaimable": ["FIXES.md", "locales/*.json", "docs/BACKLOG.md"]` (glob, simple `*` match). `claim` and
    `files --add` reject matches: "shared file: use tools/fixes-add.mjs (or the locale tool)".
  </action>
  <verify>`hub claim … --files FIXES.md` exits non-zero with the message; selftest passes.</verify>
  <done>No helper can lock the whole fleet out of a shared file.</done>
</task>

<task type="auto" id="04-03">
  <name>One shared fold for hub and board</name>
  <files>engine/fold.mjs (new), engine/hub.mjs, engine/board.mjs</files>
  <action>
    Move `fold()` from hub.mjs into `engine/fold.mjs` (export `fold(events)`), import it in hub.mjs and board.mjs, delete
    board.mjs's own copy (its `release` → OPEN drift disappears). Keep board-specific fields (node per task) computed after
    the shared fold.
  </action>
  <verify>Fold lango's events with both entry points; statuses identical (diff printed empty); selftest passes.</verify>
  <done>Task status means the same thing everywhere.</done>
</task>

<task type="auto" id="04-04">
  <name>Compact the event log</name>
  <files>engine/hub.mjs</files>
  <action>
    `hub compact`: write a snapshot event (`type: "snapshot"`, folded state) plus the last 500 events to a new file,
    keep the old file as `events.<date>.jsonl.gz` (zlib). fold() starts from the latest snapshot. Run weekly from the autoloop.
  </action>
  <verify>Fold before and after compact on a copy → identical state; file size drops.</verify>
  <done>The hub stays fast and small over months.</done>
</task>
