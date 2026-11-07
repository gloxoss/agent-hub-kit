# Changelog

## 2.3.0 (2026-11-07)
- **Default way of working: Herdr.** The hub shows its agents in Herdr (terminal workspace manager). One workspace per project, a `board` tab (live hub status) and one tab per agent job. New engine tools: `herdr-bridge.mjs` (ensure, watch, run, prune, status), `interactive-run.mjs`, `job-view.mjs`, `hub-board.mjs`.
- **One grid, not many tabs.** Agent jobs are placed as panes in an `agents` tab (4 per tab, then `agents 2`); `herdr-bridge.mjs gather` merges older per-job tabs. Config: `herdr.panesPerTab`, `herdr.layout`.
- **Windows are never closed without the owner.** `herdr-bridge.mjs reap` retires blocked agents in the hub (window stays open), notifies about finished or idle windows; `close` only on request. **Agent history library**: `agent-history.mjs` (backfill, discover, list, show, html), `herdr-bridge.mjs reopen` and `tell` (follow-up into the exact session). The keeper runs `reap` every minute and `discover` every fifth.
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
