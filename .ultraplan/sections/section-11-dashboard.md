# Section 11: Live terminal dashboard

## Overview
`devbox orch attach <project>` shows a live screen: running workers and their tasks, allowance per
account, the review and accept queue, and the manager's turns and spend today.

## Risk: [green] - Read-only, no dependencies, plain ANSI.

## Dependencies
- Depends on: section-06 (state + ledger), section-01 (quota source)
- Blocks: section-13
- Parallel batch: 3

## TDD Test Stubs
- Test: `dashboard.mjs --once` prints one frame with the four panels from fixture files.
- Test: frame width adapts to 80 and 160 columns without breaking lines.
- Test: Ctrl-C restores the normal screen and cursor.
- Test: not a TTY → plain text output, no escape codes.

## Tasks

<task type="auto" id="11-01">
  <name>Data collector</name>
  <files>engine/tools/dashboard.mjs (new)</files>
  <action>
    `collect(hubDir)`: running jobs from `runs/jobs.jsonl` (lane, executor, task, minutes), review queue and last 5 accepts from
    the hub fold, allowance per account from `runs/quota-cache.json`, manager turns/tokens/cost today from `runs/orch-ledger.jsonl`, builder usage per lane today (jobs count, and tokens when the
    job log contains a usage event),
    who is on duty from `orch-driver.json`. Pure function over files.
  </action>
  <verify>Fixture hub folder → JSON printed with all four sections filled.</verify>
  <done>All dashboard numbers come from one tested collector.</done>
</task>

<task type="auto" id="11-02">
  <name>Live renderer</name>
  <files>engine/tools/dashboard.mjs</files>
  <action>
    Alternate screen (`\x1b[?1049h`), hidden cursor, redraw every 2 s as one write, `resize` handler using `process.stdout.columns`,
    16 basic colors (green ok, yellow low, red out), restore screen on SIGINT/SIGTERM/exit, `--once` and non-TTY plain mode.
  </action>
  <verify>`--once` at COLUMNS=80 and 160 renders without wrapping; manual run in tmux redraws and exits cleanly.</verify>
  <done>The owner can watch the fleet at a glance.</done>
</task>

<task type="auto" id="11-03">
  <name>Hook into devbox orch attach</name>
  <files>devbox: bin/devbox</files>
  <action>`devbox orch attach <p>` runs the dashboard for that project; `devbox orch log <p>` keeps the raw log tail.</action>
  <verify>`devbox orch attach lango…` shows the dashboard; `devbox orch log lango…` tails the log.</verify>
  <done>One command opens the live view.</done>
</task>
