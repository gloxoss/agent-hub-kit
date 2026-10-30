# Section 09: Side responder

## Overview
When the manager is busy, a separate quick helper answers the owner at once and can keep the
conversation going. When the manager is free, it takes over the conversation (with the transcript), or
the side helper finishes the owner's topic and closes.

## Risk: [yellow] - Two sessions must not give conflicting instructions to the fleet; the responder is read-mostly.

## Dependencies
- Depends on: section-06 (driver events/runner), section-02 (reply path)
- Blocks: section-13
- Parallel batch: 3

## TDD Test Stubs
- Test: an owner message during a running manager turn gets a responder reply within 60 s.
- Test: the responder cannot dispatch, accept or edit; it can read the hub, run status commands and write a handoff note.
- Test: when the manager turn ends, the conversation transcript is handed to it and the responder session closes.
- Test: "keep talking" mode keeps the responder until the owner says "done" or 10 min of silence.

## Tasks

<task type="auto" id="09-01">
  <name>Responder role and permissions</name>
  <files>engine/orchestrator/responder.mjs (new), engine/accounts.example.json</files>
  <action>
    Responder runs on entries with role `responder`, picked by `accounts.pick({role: "responder"})` (cheap first; second
    Claude account allowed). Claude family: `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Task,Agent` plus guard from
    section 06 forbidding `dispatch.mjs run`, `accept.mjs`, `hub.mjs accept|reject|assign|cancel`. Prompt: owner text + fleet
    digest + "answer now; if an action is needed, write it to <hub>/runs/responder-handoff.md for the manager".
  </action>
  <verify>Dry-run prints the responder command line with the denials; guard fixture blocks `node .hub/dispatch.mjs run …`.</verify>
  <done>There is a safe, cheap helper that can answer while the manager works.</done>
</task>

<task type="auto" id="09-02">
  <name>Route owner messages when the manager is busy</name>
  <files>engine/orchestrator/events.mjs, engine/tools/orch-driver.mjs</files>
  <action>
    If a `user` event arrives while a manager turn runs: start (or continue) a responder session and reply via `wa send --reply-to`.
    Further owner messages in the same thread go to the responder until handover. Never interrupt the manager mid-turn.
  </action>
  <verify>Dry harness: simulated long manager turn + owner message → responder reply logged within 60 s, manager turn unaffected.</verify>
  <done>The owner always gets a fast answer.</done>
</task>

<task type="auto" id="09-03">
  <name>Handover and close</name>
  <files>engine/orchestrator/responder.mjs</files>
  <action>
    When the manager turn ends: if the owner is still mid-topic (last message < 3 min ago and not "done"), let the responder
    finish, then hand over; else hand over now. Handover = append the transcript and `responder-handoff.md` as a `user` event
    for the manager's next turn, tell the owner "Manager is back, continuing from here", close the responder session. The manager's first message after handover checks the responder's answers against
    live hub state and sends a short correction if any differed ("Update: P-x started at 14:02; earlier answer had older info").
  </action>
  <verify>Dry harness covers both branches; the manager's next prompt contains the transcript.</verify>
  <done>Conversations move between helpers without losing context.</done>
</task>
