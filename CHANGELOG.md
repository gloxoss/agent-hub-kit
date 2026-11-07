# Changelog

## 2.4.0 (2026-11-07)
- **Finished windows are handled after 5 quiet minutes.** `herdr-bridge.mjs reap`: a finished window the owner did not touch for `reap.autoActionMinutes` (default 5, 0 turns it off) is closed when the task is done in the hub (session kept in the history library), or asked to continue in its own session when the task is still ASSIGNED, REWORK, OPEN or CLAIMED. After `reap.maxContinues` (default 2) attempts it closes and the keeper takes over.
- **"Untouched" ignores timers.** The idle check hashes the window text without digits and spinner characters; a ticking clock no longer makes a finished window look busy.
- **One launcher only.** When the reaper closes a failed window it records the reason and frees the builder; the keeper alone restarts the task. Two launchers racing for one task made a second agent start, find the claim held, and quit.
- **Reaper patterns:** credit-balance-too-low and sign-in messages (`please sign in`, `not signed in`) count as quota/login failures; failed windows are retired after 1 quiet minute (was 2).
- **`tools/lane-watch.mjs`:** every 30 seconds prints one line only when a window finished, an agent looks stuck (log unchanged 10 min), a task reached REVIEW, or fewer than `--min` (default 6) agents run. Run it with the Monitor tool; each line is an event for the orchestrator.
- **`tools/container-check.mjs`:** `tsc` or `jest <pattern>` inside the backend container, so a brief can name a proof the accept gate can run (the gate only runs lines that start with node, npm, npx, pnpm, git diff or bash). Exit 2 means the container is not running and the proof was NOT run.
- **A moving screen cannot keep a finished window open.** After twice `autoActionMinutes` (10 min) a finished window is closed or asked to continue even if its screen still changes.
- **Keeper:** `keeper.startChores` (default true in the kit config) lets it start `chore` / `D-` tasks too; before, they never started on their own. It now prints `KEEPER-SKIP <task>: its files overlap a running task` instead of skipping silently.
- **Orchestrator duty (SKILL.md):** on every lane-watch line, close or hand out the next task in the same turn; never wait for the owner to ask for the next plan. When no task is ready, write the next tasks from the last reviews' findings.
- **Existing workspaces:** `kit-sync pull` keeps a `config.json` you edited, so copy `reap` and `keeper.startChores` from the kit `engine/config.json` by hand.
- Source: MoreneParfums hub, 2026-11-07.

## 2.3.0 (2026-11-07)
- **Default way of working: Herdr.** The hub shows its agents in Herdr (terminal workspace manager). One workspace per project, a `board` tab (live hub status) and one tab per agent job. New engine tools: `herdr-bridge.mjs` (ensure, watch, run, prune, status), `interactive-run.mjs`, `job-view.mjs`, `hub-board.mjs`.
- **One grid, not many tabs.** Agent jobs are placed as panes in an `agents` tab (4 per tab, then `agents 2`); `herdr-bridge.mjs gather` merges older per-job tabs. Config: `herdr.panesPerTab`, `herdr.layout`.
- **Failed agent windows are closed and the task restarted; finished ones wait for the owner.** `herdr-bridge.mjs reap` closes a failed window (quota, login, crash), saves its session, marks the executor down and restarts the task on the next healthy executor; it only notifies about windows that finished well or sit idle, and `close` is on request. The bridge state file is protected by a lock and merge-on-write. **Agent history library**: `agent-history.mjs` (backfill, discover, list, show, html), `herdr-bridge.mjs reopen` and `tell` (follow-up into the exact session). The keeper runs `reap` every minute and `discover` every fifth.
- **Account rotation for Codex, Claude Code and agy.** New executors `codex-rot`, `claude-rot`, `agy-rot` (off by default, `maxSessions: 0`) run the real program through the separate project [agent-accounts](https://github.com/gloxoss/agent-accounts): a usage limit on one account moves the call to the next account, with the reset time remembered. Its Claude Code skill (`agent-accounts`) lists which accounts have quota and switches the default login.
- **Interactive agent windows.** With `config.herdr.interactive: true`, builders of executors that define `interactiveArgs` (agy, opencode, opencode-ds, codex) start as a normal session in their own tab with the task as first message: the owner reads the agent and talks to it. The hub counts the job finished on the builder's `leave`; the window stays open. Reviews stay headless.
- `init.mjs` writes a Claude Code SessionStart hook in `.claude/settings.json` that runs `herdr-bridge.mjs ensure --open --soft`, so Herdr opens when a session starts. `--soft` never reports a failure.
- **Fix:** the autoloop no longer relaunches a build on the executor that just ran out of quota when no other builder is up (message `HOLD`). With a cursor-only build order this loop relaunched about 35 times and drained a paid plan.
- dispatch.mjs: `openInHerdr` (log tab for headless jobs) and `launchInteractive`; falls back to the hidden headless runner when Herdr is off or unreachable.
- Source: MoreneParfums hub, tested with a real opencode session on 2026-11-07.

## 2.2.0 (2026-11-06)
- Engine: `manualAccept` list in config (autoloop stops at review passed for sensitive tasks); `save()` retries on sync-folder locks and never throws; `skillRoots` includes `.agents/skills`.
- lessons.md: opencode sandbox limits, skills staging, OneDrive locks, first-tick behaviour, image tag checks.
- opencode defaults to the Go subscription: `opencode-go/glm-5.3-flash`. New `opencode-ds` lane on `opencode-go/deepseek-v4.1-flash`.
- cursor pinned to `grok-4.7-medium-fast` for build and review (it used Composer by default).
- buildOrder: cursor, opencode, opencode-ds, agy, claude-ag2-gemini, codex. claude-ds1 dropped (DeepSeek balance empty). claude-grok no longer selected anywhere.
- New rule in SKILL.md and PROTOCOL.md: no Opus subagents; every Agent call sets `model` to sonnet or haiku.
- Source: MoreneParfums hub, all lanes pinged OK on 2026-11-06.

## 2.1.0 (2026-11-04)
- New tools: agy-profiles.ps1, agy-rotate.mjs (streaming + heartbeat), accounts-status.mjs, accounts-quota.mjs.
- Prompt templates: HEARTBEAT RULE in worker.md and review.md.
- executors.json: agy is now builder + read-only reviewer; note on account rotation.
- references/executors.md section 6 (routing rules, OpenCode flash-only, account rotation); lessons.md +6 entries.
- Source: ParaLoca store hub, applied by hand (additive, generic only). Not applied on purpose: project config, project executor table, tasks-today.json, template diffs that would have removed newer master text.
