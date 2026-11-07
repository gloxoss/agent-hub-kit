---
name: agent-hub-orchestrator
description: Runs a multi-agent build where this Claude session only plans, decides and commits, while external executor CLIs (agy, opencode, opencode-ds, claude-ds1/2/3, claude-ag2-sonnet/gemini, cursor, codex) build and review through a file-based task hub with an autoloop (review, accept, rework, retry, queue). Covers installing it into any workspace (init.mjs with ui-migration, backend, ai or generic packs), writing briefs, the planner-to-gen-tasks pattern, quota audits, reviewer fallback, pausing and resuming a project. Use when the user says "set up the agent hub", "you orchestrate, other agents execute", "use my other agents", "dispatch this to agy/opencode/codex/cursor", or starts a new multi-agent project.
---

# agent-hub-orchestrator

A file-based multi-agent build system. One Claude session orchestrates; background executors build and review through a hub; the autoloop handles the routine review cycle so the orchestrator's token quota is spent only on decisions.

## When to use
Load this skill at the start of any orchestrator session. Workers and verifiers do not load it.

## Roles
| Role | Who | Does | Never |
|---|---|---|---|
| **Orchestrator** | Main Claude session | Plans, writes briefs, queues, reviews diffs, accepts, commits | Edits source files |
| **Worker** | External executor (Codex, opencode, agy, non-Opus Claude subagent) | Claims, builds, proves, reports | Commits, verifies own work |
| **Verifier** | Separate executor (optional) | Runs proof, runs gates, writes report | Fixes code |
| **Autoloop** | `autoloop.mjs` process | Starts reviews, accepts passes, sends back fails, retries | Makes judgement calls |

**Orchestrator never does worker work.** Workers run on external quota (Codex, opencode, agy, DeepSeek slots, Cursor). Spending orchestrator tokens on building or routine review burns the plan quota instead.

**No Opus subagents, ever.** The orchestrator never spawns a subagent on an Opus model. Omitting `model` inherits the session model, so every Agent call sets `model` explicitly to `sonnet` or `haiku`, or the work goes to an external executor through the hub. The same holds for skills that spawn subagents, such as ultraplan. The `claude` executor runs on Opus: keep it out of `buildOrder` and `reviewOrder`.

## The loop
```
plan → brief → queue → autoloop (review → accept / rework / retry / resume / queue fallback)
                                  ↓
              orchestrator wakes only on DECIDE · QUOTA · MOVED · DIGEST
```

1. **Plan**: `hub.mjs add <TASK> --phase <phase> --title <T> --deps <a,b> --scope <paths>`. Write the brief.
2. **Brief** (`templates/brief.md`): scope, deps, Done when (exact commands), Load list. Load list = minimum files to read. Done when = exact proof commands + expected output. Every brief carries the proof block for the project (for example the no-browser rule) at the top.
3. **Queue**: put the task in `.agent-hub/autoloop-queue.json` as `{"<TASK>": "<executor>"}`. The autoloop dispatches it once its deps are built. A task absent from the queue is only run by hand.
4. **Autoloop**: `node .agent-hub/autoloop.mjs` runs in the background (Monitor tool or OS task):
   - task built (REVIEW) -> start a read-only review;
   - review PASS -> accept + commit the task's files;
   - first review FAIL -> append the findings to the brief as a `## Rework` section, reject, re-dispatch the builder;
   - later review FAIL -> `DECIDE`, stop touching it;
   - job failed on QUOTA/AUTH/DOWN -> move the task to the next healthy builder (`MOVED`), skip that executor for an hour;
   - job exited cleanly without `done` -> retire the stale lane, resume the same job once; a second exit prints `DECIDE`;
   - queued task whose deps are built -> dispatch it (queue fallback).
5. **Decide**: on `DECIDE`, read the verdict, apply the stop rule, then `hub.mjs accept` or `hub.mjs reject`.

The autoloop is the only routine reader of verdicts. If you find yourself opening every diff and verdict, the autoloop is not running or not doing its job.

## How to write a brief
```
# <ID> · <phase> · <title>
Depends on: <deps>. Allowed scope: <paths>.
## Goal
## Load (just in time, nothing else)
## Scope
## Out of scope
## Steps
## Done when    ← exact commands + expected output; workers must quote real output
## Report back
```
- Scope = exact file paths or folders the worker may create or edit. Anything else needs a `say` first.
- **File-scope rule:** the scope lists *every* file the task touches, including assets, microcopy/strings files, generated fixtures, and shared helpers. A fixed task that "needs one more image" outside its scope stalls the lane. Plan the asset, the strings file, and the helper into the same task or a dependency.
- Done when: each check must be a command the worker can copy-paste. No vague "works correctly".
- Load list: minimum set. Every extra file burns executor tokens and risks drift.
- A cross-lane build failure is not a blocker. The brief says so explicitly: prove your own files statically, finish, and write `cross-lane build break in <file:error>` in the verify line. The orchestrator re-runs the full build before accepting.

## Planning rules
- One task = one claim = one coherent unit (one section, one page, one script).
- Set `--deps` correctly. A dependency counts as met once the task is built (REVIEW or later) unless the task is `--strict on`.
- Set `--scope` to prevent cross-lane conflicts. Omit only for tasks that touch nothing shared.
- Prefer one owner per file. If two tasks must touch one file, chain them or move the shared part into one task.
- Independent verification is optional: small blocks are accepted on the builder's proof plus a spot-check; sections and page assembly may keep a separate verifier. Pick the cheapest model that still catches real bugs.

## Planner → tasks (`gen-tasks.mjs` pattern)
For a batch bigger than three or four tasks, do not hand-write briefs. Write a plan first.

1. A planner task reads the sources and writes `docs/migration/plans/<plan>.md` with a **task table**: one row per task, columns `ID | files | deps | brief`.
2. The table is the contract: the ID, every file, the dependencies, and one line per build step.
3. One command turns the table into hub tasks and queue entries:
   ```bash
   node .agent-hub/tools/gen-tasks.mjs docs/migration/plans/<plan>.md "<ID prefix regex>" --after "### Task table"
   ```
   It writes `.agent-hub/tasks/<ID>.md`, calls `hub.mjs add` and `edit --verify off`, and fills `autoloop-queue.json`. Existing IDs are skipped, so it is safe to re-run.
4. The autoloop picks the generated tasks up on its next tick. No dispatch command, no hand-written brief.

The script lives in `.agent-hub/tools/`. Copy the pattern into a new workspace, not the tool itself, when the table format differs.

## Running fixed lanes next to the autoloop
The autoloop owns the queue, not every lane. When you dispatch a lane by hand at the same time:

- Give each hand-run lane a fixed, unique name (`builder-1`, `builder-2`, ...) and keep the same lane on the same task through rework.
- Never hand-dispatch a task that is already in `autoloop-queue.json`. Remove it from the queue first, or let the autoloop run it.
- Give every lane its own build dir and port, and list both in the brief (`NEXT_DIST_DIR` or the project equivalent). Two lanes sharing a build dir corrupt each other's output.
- Claim `port:<n>` in the hub claim. Stop the server by PID before reporting done.
- A task you run by hand must be out of `autoloop-queue.json`. The autoloop also watches CLAIMED tasks whose job is no longer running: a lane that stalls without `done` is retired and re-dispatched, which would fight your hand-run lane.

## Stop rule
First FAIL -> rework round: the blocking findings are appended to the brief as `## Rework 1`, the task is rejected, and the builder is re-dispatched. The reviewer applies the stop rule itself, so round 2 only reports functional bugs, accessibility failures, or visible layout breaks.
Second FAIL -> `DECIDE`: the autoloop stops and hands it to the orchestrator, which either accepts (the remaining items are non-blocking) or sends back only those three categories. Everything else goes to the backlog file. No third rework, and the orchestrator does not re-litigate the reviewer's `BACKLOG:` lines.

## Reading autoloop output
- `DECIDE <task>`: the task failed twice or exited without `done` twice. Read the verdict, apply the stop rule.
- `QUOTA <executor>`: an executor hit its quota/auth limit. Check `dispatch.mjs ping <executor>` or `quota.mjs`.
- `MOVED <task>`: the build executor switched. No action unless it keeps moving.
- `DIGEST <counts>`: periodic summary. No action unless the counts look wrong.

## Watch commands per executor
Shown by `dispatch.mjs list`:
- `Get-Content -Wait .agent-hub/runs/<job>.log` (all executors, live stream; `tail -f` on POSIX)
- `opencode attach http://127.0.0.1:4096` (opencode)
- `claude --resume <sessionId>` (Claude-family)
- `codex resume <sessionId>` (Codex)

Treat a job as live if its log changed in the last two minutes, even when the recorded PID looks dead (wrapper launchers).

## Quota audit and cascades
`node .agent-hub/quota.mjs` shows every account with a flag: OK / LOW / OUT / AUTH / DOWN. It never prints keys.

**Cascade rule:** one provider window can back several executors. When it empties, mark all of them down together and move work to an independent provider. Example shape: one Claude window backs a Sonnet launcher and a Gemini/other launcher; the DeepSeek slots share a balance family unless configured separately. Never "fix" a quota problem by dropping to the orchestrator's own account.

**Review fallback must stay external.** `claude` (the orchestrator's own plan) is the last row for emergencies only. Keep it out of the review fallback order, or gate it behind an explicit request. If every external reviewer is down, the autoloop should print `QUOTA` and park the reviews, not silently spend the user's Claude quota. Same for builds: never let a failing chain quietly land several lanes on `claude`.

## Pause a project
Pausing means: nothing is running, and the next session can start without the chat.

1. Stop the autoloop. Confirm no job is still writing (`.agent-hub/runs/jobs.jsonl`, log tails).
2. Write the pause report (`templates/report-task.md`): a session report and a project overview, from hub events, changelog, git log, and the current quota status.
3. Rewrite `docs/HANDOFF.md` (where we are, open tasks, blockers, next action).
4. Rewrite `docs/NEXT-SESSION.md` (remaining work per area, suggested order, fast start with the exact commands).
5. Update the ledger/decisions for anything that changed.
6. Commit, then `hub.mjs leave`.
7. Tell the user what is paused and what the first command next session is.

## Resume a project
Open `docs/NEXT-SESSION.md` and follow its fast start. Then `HANDOFF.md`, `hub.mjs status`, `quota.mjs`, `dispatch.mjs ping all`, and start the autoloop under a Monitor. Re-read the pause state before creating new tasks; do not re-plan work the queue already holds. "Continue from NEXT-SESSION" is the standard resume phrase and must be enough.

## Adding an executor
1. Add an entry to `.agent-hub/executors.json` (name, kind, maxSessions, buildCmd, buildExtraArgs, reviewCmd, reviewExtraArgs, watch, restore).
2. `dispatch.mjs ping <name>` to verify. An echoed prompt means the binary is missing.
3. Array order sets the fallback order; the autoloop reads it.
4. Give it one small task first. Promote by evidence.

## Commit (accept flow)
```
hub.mjs accept <TASK> --note "<why>"
accept.mjs <TASK> "<note>" "<media>" "feat: <TASK> (accept)"
```
`accept.mjs` calls `hub.mjs accept`, then `git add` only the task's `changed` files, then commits. Never `git add -A`. The autoloop uses the same path.

## Kit sync
Installed workspaces improve the kit (new tools, fixes, templates). When an instance has something the master lacks or does better, notice it and **ask the user** before upgrading the master. Nothing is pushed upstream without a yes.

Master kit source (default): `C:/Users/OMEN/OneDrive/Documents/projects/agent-hub-kit`. `install.mjs` writes that path to `KIT-SOURCE` and stamps `engine/config.json` with `kit.version` + `kit.source`; `init.mjs` copies the stamped config into each workspace.

Commands (`node .agent-hub/tools/kit-sync.mjs`):
- `check [--quiet]` — compare instance engine / `tools/` / `templates/` to the master. Lines are `NEW`, `CHANGED`, or `MASTER-NEWER` (includes files that exist only on the master). `--quiet` prints one `KIT-UPGRADE <n> new, <m> changed` line (or nothing).
- `propose` — write `.agent-hub/kit-proposals/<date>-<n>.md` with reasons, unified diffs, snapshot hashes, and generic-ness flags.
- `apply <proposal> [--yes]` — only with `--yes` after the user agrees. Applies **only** files listed in that proposal whose instance content still matches the reviewed snapshot. Refuses project-specific leftovers. Bumps `kit.version` minor, appends `CHANGELOG.md`, prints git commit commands. Never commits or pushes.
- `pull [--yes]` — bring `MASTER-NEWER` files into the instance (backup first; creates missing files). For `engine/config.json`, updates only `kit.version` / `kit.source` and preserves the rest of the workspace config.

**When to run `check`:** at session start; after adding or fixing any hub tool; whenever a DIGEST line contains `KIT-UPGRADE`. If anything is listed, run `propose`, then ask the user one question summarizing the items. Only on yes run `apply --yes` and show the commit commands. If `MASTER-NEWER` items exist, ask whether to `pull --yes`.

**Autoloop hook (document only; engine owns autoloop):** the digest tick can call `kit-sync.mjs check --quiet` and print its line. DIGEST output containing `KIT-UPGRADE` wakes the orchestrator the same way other digest signals do.

**Keep up to 5 agents busy (user rule, 2026-10-25), always inside the resource gates:** do not leave capacity idle while dispatchable work exists, but never bypass the free-RAM floor (resources.buildMinFreeMB) or the quota-burn breaker to reach 5. On a small host fewer than 5 is correct. Keep ≥5 dispatchable OPEN tasks queued beyond the running ones (write the next briefs from the plan before the queue drains; audits/QA passes are fillers). On every accept/done/fail/exit event, count running jobs across active hubs and dispatch the next task immediately until ≥5 run. After a restart, restore infrastructure, then bring the count to ≥5 first.

## Default way of working: Herdr
This is how the owner works with the hub, on every project scaffolded from this kit.
1. **Session start.** `init.mjs` installs a SessionStart hook in the project's `.claude/settings.json`. It runs `node <hub>/tools/herdr-bridge.mjs ensure --open --soft`, which opens Herdr in Windows Terminal when it is not running and prepares one workspace (`<project> hub`) with a `board` tab (live task counts, running jobs, last events).
2. **Every agent job gets its own pane, all in one grid view.** Panes are tiled in an `agents` tab (4 per tab; an `agents 2` tab opens only when the first is full), so several agents are visible at once. `herdr-bridge.mjs gather` moves older per-job tabs into the grid without restarting the agents. (`herdr.layout: "tabs"` restores one tab per job.) `dispatch.mjs` starts builders of executors that define `interactiveArgs` (agy, opencode, opencode-ds, codex) as a normal interactive session with the task as first message (`tools/interactive-run.mjs`). The owner reads the agent and talks to it. Reviews and other executors run headless and get a readable log tab (`tools/job-view.mjs`).
3. **The hub still knows when a job is done**: heartbeat lines keep it alive, the builder's `leave` event closes it, and the window stays open for the owner.
4. **Switches** in `config.json`: `herdr.enabled`, `herdr.interactive` (false = hidden headless runs with log tabs), `herdr.workspaceLabel`, `herdr.maxTabs`. If Herdr is missing or unreachable, jobs fall back to headless and nothing breaks.
5. **Commands:** `node <hub>/tools/herdr-bridge.mjs status | ensure | prune`.
6. Orchestrator duty: when you start jobs, tell the owner which tabs to look at; do not close interactive tabs; keep at least two build executors in `buildOrder` so a quota stop never relaunches the same executor.

### Windows, history and follow-ups (part of the Herdr way of working)
- **Failed windows are closed and restarted; finished windows wait for the owner.** `herdr-bridge.mjs reap` (run every minute by the keeper) watches the agent windows. When an agent FAILED (a quota or login error on screen and no activity for 2 minutes, or its process ended with an error) the watcher saves its session id in the history library, marks the executor down in `runs/health.json`, closes the window, adds a note to the task ("continue from the files already changed") and restarts the task on the next healthy executor of `buildOrder`, then sends a notification. When an agent FINISHED WELL the watcher never closes the window: the owner reads the output first. A finished window left open for 10 minutes, or an agent idle for 30, produces a notification (Herdr toast and `runs/notifications.log`), and the board lists the windows waiting to be read. The owner closes them, or asks: `herdr-bridge.mjs close --finished | --task <id> | --pane <id>`.
- **Agent history library.** Every agent session is recorded in `.agent-hub/history/agents.jsonl` (`agent-history.mjs backfill | discover | list | show <id> | html`; page: `docs/agents/index.html`). It keeps the session id of each agent (known for the Claude family; found for codex, opencode and agy) and the exact resume command. `herdr-bridge.mjs reopen <job id | task id>` brings a closed agent back into the grid.
- **Follow-ups go into the same session.** `herdr-bridge.mjs tell <task id> "<message>"` types the message into that agent's live window (reopening it first if it was closed), so it answers with its full context: no new run, no context injection. The note is recorded on the task. The agent must claim and report done again if it changes files; the orchestrator checks the result before accepting.

### Account rotation (Codex, Claude Code, agy)
When one login of an agent runs out of quota, the call should move to another login instead of failing the task. The kit does this through the separate project **agent-accounts** (https://github.com/gloxoss/agent-accounts): one settings folder per account (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), agy accounts as saved Windows logins, a round-robin that skips accounts in cooldown, and a cooldown that remembers the reset time named in the limit message.
- Executors `codex-rot`, `claude-rot`, `agy-rot` are in `executors.json` with `maxSessions: 0`. To use them: install agent-accounts, save accounts (`agent-accounts import codex main`, `agent-accounts add codex second`), then raise `maxSessions` and put the executor in `buildOrder`.
- `agent-accounts status` tells which accounts are free or full. `agent-accounts check` does a live test (one tiny call per account). Its Claude Code skill `agent-accounts` answers "which accounts have quota" and switches for the owner.
- A session belongs to the account that created it: the hub's resume template is `agent-accounts resume <provider> <session id>`.
- The watcher treats a quota error as a failed agent either way, so a task is never stuck on a full account; rotation just makes it happen inside one call.

### Keeping the lanes full (orchestrator loop)
- **Start the lane watch** at the beginning of a session with the Monitor tool: `node <hub>/tools/lane-watch.mjs --every 30 --min 6` (timeout 30 min, re-arm on expiry). It prints a line only when a window finished, an agent is stuck, a task reached REVIEW, or fewer than 6 agents run. On each line: review the finished work, accept or reject, and add the next task from the project plan. If no task is ready, write one from the findings of the last reviews (bugs found, gaps noted) and tell the owner.
- **Finished windows.** The reaper closes a finished window after 5 quiet minutes when the task is done in the hub, or asks the same session to continue when it is not (`reap.autoActionMinutes`, `reap.maxContinues`). The session stays in the history library.
- **One launcher.** Only the keeper starts builds. Never also run `dispatch.mjs run` for a task the keeper can see, and never `tell` a finished window for a task in REWORK; both start two agents on one task.
- **Reviewer must not use the builder's executor.** `accept.mjs` refuses it. `dispatch.mjs review <task> <executor>` runs only on the review order (codex, claude-ag2-sonnet, claude-ag2-gemini): start a Claude review for codex-built tasks.
- **Every brief needs a runnable proof line.** The accept gate runs only backticked lines that start with `node`, `npm`, `npx`, `pnpm`, `git diff` or `bash`, from the repo root. A line like "tsc exit 0 in the container" gives "no runnable check" and the task goes back to REWORK. For backend checks use `node <hub>/tools/container-check.mjs tsc` or `... jest <pattern>`. For a sub-folder app use `node "<app>/node_modules/typescript/bin/tsc" --noEmit -p "<app>"`; a leading `cd` is not accepted. When the brief scope changes in the hub (`hub edit --scope`), change the brief text too, or builders stop on the conflict.
- **Memory.** The dispatcher refuses launches below the free-memory floor (`resources.buildMinFreeMB` and `resources.reviewMinFreeMB`, default 2048 MB). If the keeper shows `none startable` with ready candidates, check free RAM first and close finished windows.
- **Never let the lanes run dry.** On every lane-watch line (FINISHED, REVIEW, LOW LANES) do the next step in the same turn: review or accept the finished task, close the window, and start new work. If no task is ready, write the next tasks yourself from the findings of the last reviews and the project plan, then tell the owner what you added. Do not wait to be asked "what next".
- **Ending a session's watch.** The Monitor stops after 30 minutes; re-arm it at once.

### Perch CLI and free models
- `npm install -g perchai-cli` gives the `perch` command. Executors `perch` and `perch-rot` are in `executors.json` with `maxSessions: 0`. Sign in once (`perch login`, browser), check with `perch status`, then `node <hub>/dispatch.mjs ping perch` and raise `maxSessions`. For several logins use `agent-accounts add perch <name>` and the `perch-rot` executor.
- When every paid subscription of one vendor is out (the OpenCode Go plan ran out for a whole month on 2026-11-07, which also took down its DeepSeek and GLM models), keep one free executor healthy: `opencode-free`. Use it for docs and checks first.
- **Check that agents are really working every 30 s, and restart what stopped.** The lane watch prints `NO AGENT on <task>` for unfinished tasks without a window. When the line names a quota or login stop: switch the login (agent-accounts) or move the task to a healthy executor, clear the keeper counters (`runs/keeper-reset.json`), start it, and tell the owner. Do not wait for the owner to notice. A cheap `ping` is not proof an account has credits (agy answered a ping but ran out as soon as real builds started): a build that dies within a minute with `Out of credits` means that account is out.
