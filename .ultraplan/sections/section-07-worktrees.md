# Section 07: Worktree per task

## Overview
Each builder works in its own lightweight copy of the repo (git worktree) on its own branch; acceptance
re-runs checks there and merges it back; the copy is removed afterwards. Hub state stays in the main checkout.

## Risk: [red] - Touches dispatch and accept (core path); disk use; merge conflicts move from "while editing" to "at merge".

## Dependencies
- Depends on: section-03 (gates run in the task's folder)
- Blocks: section-08, section-12
- Parallel batch: 2

## TDD Test Stubs
- Test: dispatch creates `../<repo>-wt/<task-id>` on branch `task/<id>` and the worker's cwd is that folder.
- Test: hub commands from inside a worktree still read and write the main checkout's hub.
- Test: accept runs checks in the worktree, merges into the integration branch, removes the worktree.
- Test: a merge conflict creates an `F-merge-<id>` fixer task on another builder; nothing is half-merged.
- Test: `config.worktrees: false` keeps today's behavior.

## Tasks

<task type="auto" id="07-01">
  <name>Design note and config switch</name>
  <files>docs/plans/worktrees.md (new), engine/config.json</files>
  <action>
    Write a one-page note: layout `../<repo>-wt/<task-id>`, branch `task/<id>` from the integration branch (current HEAD branch),
    hub resolution (env `HUB_ROOT` pointing at the main checkout), install strategy (pnpm with global virtual store when the
    project uses pnpm; npm projects: `npm ci` per worktree, cached by `~/.npm`), build dir per worktree, cleanup rules.
    Config `"worktrees": { "enabled": false, "base": "../{repo}-wt", "install": "auto" }`.
  </action>
  <verify>Note exists and lists the 6 decisions; config default keeps current behavior (selftest passes).</verify>
  <done>The approach is written down and switchable.</done>
</task>

<task type="checkpoint" id="07-02">
  <name>Orchestrator approves the design</name>
  <files>docs/plans/worktrees.md</files>
  <action>Send the note to the orchestrator for approval before writing code. Stop until "approved".</action>
  <verify>Approval recorded in the note's last line.</verify>
  <done>The worktree design is approved.</done>
</task>

<task type="auto" id="07-03">
  <name>Dispatch runs builders in their worktree</name>
  <files>engine/dispatch.mjs (launch ~194–206, runner ~213, prompt root ~266, run mode before launch ~406)</files>
  <action>
    When enabled: before `launch()`, `git worktree add <base>/<id> -b task/<id>` (reuse if it exists), run the install step,
    pass `cwd` through `launch` and `_runner`, set env `HUB_ROOT=<main checkout>`, and rewrite the prompt's root path to the
    worktree. Review jobs run read-only in the same worktree.
  </action>
  <verify>On a scratch repo with `worktrees.enabled: true`, `dispatch run` creates the worktree and the job's log shows it as cwd.</verify>
  <done>Builders can no longer break each other's half-done work.</done>
</task>

<task type="auto" id="07-04">
  <name>Hub tools find the main checkout from a worktree</name>
  <files>engine/hub.mjs, engine/dispatch.mjs (ROOT/HUB resolution only)</files>
  <action>
    Resolve ROOT as `process.env.HUB_ROOT` if set, else `git rev-parse --path-format=absolute --git-common-dir` parent, so
    `node <hub>/hub.mjs …` run inside a worktree updates the one shared event log.
  </action>
  <verify>From inside a worktree, `hub.mjs claim` updates the main checkout's events.jsonl.</verify>
  <done>All builders report to the same hub, wherever they work.</done>
</task>

<task type="auto" id="07-05">
  <name>Accept merges and cleans up</name>
  <files>engine/accept.mjs</files>
  <action>
    With worktrees: run the gate checks (section 03) in the worktree; commit there; `git merge --no-ff task/<id>` into the
    integration branch in the main checkout (or rebase first if `config.worktrees.linear`); on conflict abort the merge, keep the worktree, and create a dedicated merge-fixer task `F-merge-<id>` (phase `chore`,
    scope = the conflicting files, brief: "rebase task/<id> on <branch>, resolve conflicts keeping both intents, re-run the
    original checks") dispatched to a builder other than the original; the original task waits on it (dep) and is accepted
    when the fixer is accepted. On success `git worktree remove` + delete
    the branch, `git worktree prune`.
  </action>
  <verify>Scratch repo: two tasks editing different files both merge; two editing the same line → an `F-merge-…` fixer task is created and, once accepted, the second task merges.</verify>
  <done>Accepted work lands cleanly and copies don't pile up.</done>
</task>

<task type="auto" id="07-06">
  <name>Stale worktree sweeper</name>
  <files>engine/autoloop.mjs (hourly hook next to gc)</files>
  <action>
    Hourly: remove worktrees whose task is ACCEPTED or CANCELLED, and report (not delete) worktrees older than 24 h with
    no running job. Respect the disk gate from section 05.
  </action>
  <verify>Scratch run leaves no worktree for accepted tasks; an old orphan is listed in the report buffer.</verify>
  <done>Disk stays under control automatically.</done>
</task>
