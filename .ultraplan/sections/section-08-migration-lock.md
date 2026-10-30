# Section 08: Database change lock

## Overview
Tasks that change the database schema run alone: nothing else is dispatched while one runs, and it waits
until running builds finish before starting.

## Risk: [green] - Small change in dispatch, clear rule.

## Dependencies
- Depends on: section-07 (same file, run after it)
- Blocks: section-12
- Parallel batch: 2

## TDD Test Stubs
- Test: a task with phase "migration" is not dispatched while another build runs.
- Test: while a migration task runs, other dispatches print "not dispatched: migration lock".
- Test: a task touching `drizzle/` or `**/migrations/**` is treated as a migration even without the phase.

## Tasks

<task type="auto" id="08-01">
  <name>Detect database-change tasks</name>
  <files>engine/dispatch.mjs, engine/config.json</files>
  <action>
    `isMigration(task)`: phase `migration`, or any scope path matching `config.migrationPaths`
    (default `["drizzle/", "migrations/", "prisma/migrations/", "db/migrations/"]`). Add `migration` to the hub's known phases.
  </action>
  <verify>Fixture tasks classify as expected (printed).</verify>
  <done>The fleet knows which tasks change the database.</done>
</task>

<task type="auto" id="08-02">
  <name>Exclusive lock in dispatch</name>
  <files>engine/dispatch.mjs (run mode gates, after the resource gate)</files>
  <action>
    Lock file `<hub>/runs/migration.lock` `{task, pid, t}`. A migration dispatch requires zero running builds, then writes the
    lock; any dispatch while the lock's job is alive prints `not dispatched: migration lock (<task>)`. The lock is removed when
    the job ends (jobStatus not RUNNING) or its pid is dead.
  </action>
  <verify>Scratch hub: start a fake long migration job → a build dispatch is refused; job ends → dispatch proceeds.</verify>
  <done>Only one database change runs at a time, alone.</done>
</task>

<task type="auto" id="08-03">
  <name>Selftest coverage</name>
  <files>engine/selftest.mjs</files>
  <action>Add a step that exercises the lock with a fake running job record and checks both refusal and release.</action>
  <verify>`node engine/selftest.mjs` passes with the new step.</verify>
  <done>The lock stays correct in future changes.</done>
</task>
