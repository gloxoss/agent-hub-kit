# Fleet hardening plan (orchestrator driver, hub, WhatsApp, SchoolOS infra)
n> **Superseded by `.ultraplan/` (UltraPlan, 2026-10-30): 14 sections, 63 tasks. Start at `.ultraplan/SUMMARY.md`.**

Owner: orchestrator (plans, reviews, accepts). Executor: one coding agent, task by task.
Date: 2026-10-30. Repos: `agent-hub-kit` (this repo, the engine), `gloxoss/devbox` (server kit,
WhatsApp), `lango-english-center-project-fully` (SchoolOS app + its hub `.agent-hub-orch/`).

---

## 0. Rules for the executor (read first, they save your quota)

1. **One task at a time, in the order below.** Do not start the next task before the current one's
   "Done when" passes. Stop and report after each task.
2. **Read only the files a task lists.** `orch-driver.mjs` is ~1,100 lines: read the named
   functions with line ranges, never the whole file. No repo-wide search unless a task says so.
3. **No refactors beyond the task.** Fix what is named; note other problems in your report.
4. **Every change is verified by running commands, not by reading.** Paste the real output.
5. **Engine changes go to `agent-hub-kit` only** (never edit `~/.claude/skills/...` or a project's
   copy). Ship flow for every engine task:
   ```bash
   node --check engine/tools/orch-driver.mjs            # or the file you changed
   cd /tmp && node <kit>/engine/selftest.mjs             # must print 8/8 steps passed
   git commit && git push                                # in agent-hub-kit
   ssh vps-dev 'git -C ~/.local/share/agent-hub-kit pull -q --ff-only && node ~/.local/share/agent-hub-kit/install.mjs'
   ssh vps-dev 'node --check ~/.claude/skills/agent-hub-orchestrator/engine/tools/orch-driver.mjs'
   ```
   Only after `node --check` passes on the server, restart the orchestrator:
   `ssh vps-dev 'bash -lc "devbox orch stop lango-english-center-project-fully; devbox orch start lango-english-center-project-fully"'`
   **Never restart with a file that fails `node --check`** (a syntax error in commit a633b28 left the
   driver unable to start; it only survived because it had started before that commit).
6. **No sudo, no deploy, no pushing app code** unless the task says so. Server-admin steps are
   marked **[USER]**: write the command in your report and stop.
7. Use cheap models for this work (Sonnet/Gemini/Codex low effort). Nothing here needs Opus.

---

## 1. Verified facts (2026-10-30 audit, measured on vps-dev)

| # | Fact | Evidence |
|---|---|---|
| F1 | The orchestrator writes code itself | its turns in `.agent-hub-orch/runs/orchestrator.log`: Edit 282, Write 197, Bash 3,435 tool calls |
| F2 | App changes bypass review | 11 app commits in 3 days, 0 with "autoloop accept" |
| F3 | The orchestrator runs on the user's own Claude subscription first | `orch-control.json` order: claude-sonnet → claude-ag2@gemini-3-flash → codex; Claude turns compete with the user's interactive sessions |
| F4 | Claude is retried every ~15 min and locked out only ~2 min each time | log: "claude-sonnet unavailable (rate_limit) until 09:35" at 09:33 |
| F5 | Session rotation is triggered by cumulative, not per-session tokens | log: "Auto-rotating … 1,101,343 in / 1,102,228 total" |
| F6 | Pause notices repeated every ~15 min | dedupe key contained the retry time (fixed in d73520e) |
| F7 | Driver could not start after a633b28 | nested backticks, `SyntaxError` line 779 (fixed in d73520e) |
| F8 | All builders and the orchestrator edit the same working tree | `git worktree list` shows only the main tree + brain |
| F9 | `wa.mjs` drops any message identical to one sent in the last 10 min | `sent-cache.json` hash gate; direct replies are not exempt |
| F10 | 29 STALE agents on `.agent-hub-orch/BOARD.md` | `grep -c STALE` |
| F11 | Reviewer lane `claude-oc3` runs OpenCode with write access | `executors.json` reviewExtraArgs: `opencode run … --variant max` (no read-only) |
| F12 | autoloop already accepts on `VERDICT: PASS` | `autoloop.mjs` line ~149/162; F2 happens because the orchestrator commits first |
| F13 | Driver is 1,101 lines of regex "steering" (status/action/screenshot detection) | `buildSteerPrompt`, `isStatusQuery`, `isActionDirective` |

**Claims from the external audits that are NOT verified yet** (verify inside the task before fixing):
freemem 2500 MB gate (not found in `autoloop.mjs`/`config.json`; search `dispatch.mjs`, `accept.mjs`,
`tools/heavy.mjs`), missing Chromium libraries (no Playwright Chromium in `~/.cache/ms-playwright`),
executors.json drift between two copies, FIXES.md lock deadlocks, snap-route `/en` and login-redirect
bugs, pg pool crash on port 3401.

---

## 2. Phase P0: stop the quota drain (do these first, in order)

### T1 · Orchestrator cannot write code (driver)
- **Goal:** an orchestrator turn can read, run hub/git/wa commands and write briefs/handoff, but cannot edit app code or spawn sub-agents.
- **Files:** `engine/tools/orch-driver.mjs`: `command()` (~line 283) and `turn()` (~line 436) only.
- **Steps:**
  1. Claude-family entries (claude, claude-sonnet, claude-*): add
     `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Task,Agent` and `--max-turns 25`.
  2. In `turn()`, parse stream-json `tool_use` events with `name:"Bash"`. If the command writes to a
     path outside the allow-list (`<hub>/`, `docs/`, `~/.devbox-brain/`) using `>`, `>>`, `tee`,
     `sed -i`, `cp`, `mv`, `git commit`, `git apply`, kill the turn, log `VIOLATION <agent> <cmd>`, and
     mark that entry down for 2 h. Allow-list check is a pure function `isOrchestratorWrite(cmd)`.
  3. Codex entries: keep the workspace sandbox, add the same violation check on its streamed commands
     if its output exposes them; otherwise rely on the playbook rule (note it in the report).
- **Done when:** unit check `node -e` calling `isOrchestratorWrite` on 8 samples (4 allowed: brief,
  HANDOFF, `hub.mjs task-add`, `wa send`; 4 blocked: `sed -i` on `lango-app/…`, `cat > src/x.ts`,
  `git commit -am`, `cp a lango-app/b`) prints the expected booleans; `node --check` and selftest pass.

### T2 · Orchestrator budget: fewer, cheaper turns (driver)
- **Goal:** the orchestrator wakes only when a decision is needed and never burns the user's Claude subscription first.
- **Files:** `orch-driver.mjs` (event intake `follow(...)` filter, `setInterval` loop, `DEFAULT_ORDER`),
  `.agent-hub-orch/orch-control.json`.
- **Steps:**
  1. Event filter: only these wake a turn: `WHATSAPP` (user), `DECIDE`, `QUOTA`, review `FAIL`/rework,
     `SYNC … diverged|conflict`, `START`. Drop `DIGEST`, `MOVED`, routine accept lines (log them only).
  2. Remove the hourly `TICK` turn (or make it every 6 h and only if the board has READY tasks and no job runs).
  3. Per-entry cap: at most `CFG.maxTurnsPerHour` (default 6) turns per entry; over the cap the entry
     is skipped (not marked down, no alert).
  4. Default order: `codex → claude-ag2@gemini-3-flash → claude-or → claude-sonnet` (user's
     subscription last). Write the same order to lango's `orch-control.json`.
  5. Claude orchestrator model pinned to Sonnet (`--model sonnet`), never Opus.
- **Done when:** a dry run `node orch-driver.mjs . --cmd status` shows the new order; a 30-line
  replay of yesterday's log lines through the filter function wakes ≤ 5 turns (print the count).

### T3 · Token telemetry and rotation (driver)
- **Files:** `extractTurnTokens()` (~536), the rotation check that uses it.
- **Steps:** keep `st.tokens[sessionId] = lastCumulative`; turn cost = current − previous. Rotate on
  the session's context size (latest `input_tokens` of the last message, not the sum) ≥ 75k, or turn
  count ≥ 8. Log both numbers.
- **Done when:** feeding two consecutive stream samples (cumulative 1,000,000 then 1,020,000) yields
  turn delta 20,000 and no rotation; a sample with context 80,000 triggers rotation.

### T4 · WhatsApp never drops a reply to the user (wa.mjs, devbox repo)
- **Files:** `services/whatsapp/wa.mjs` in `gloxoss/devbox` (send path, anti-spam + `sent-cache.json`).
- **Steps:** add `--auto` flag. Dedupe and the tick regex apply only to `--auto` sends. The driver
  passes `--auto` for its own notices (pause/switch/report) and never for replies to user messages.
- **Done when:** sending the same text twice without `--auto` delivers twice (check WAHA messages
  API), with `--auto` the second is dropped.

### T5 · Alerts only on state change (driver)
- **Files:** `orch-driver.mjs` `handle()` failover/pause branch (~829–970).
- **Steps:** no WhatsApp line for a single failover that succeeded on the next entry (log + include in
  the 15-min report). WhatsApp only when: every entry is down (once per distinct down-set, already
  fixed), or the on-duty agent changes for longer than 1 h. Lockout after `rate_limit` without a
  reset time: 60 min + jitter (not 2 min).
- **Done when:** replay of the 09:33–09:50 log sequence produces 0 WhatsApp sends.

**After P0: restart, watch 2 hours.** Expected: orchestrator turns ≤ 6/h, 0 VIOLATION lines, app commits
only via "autoloop accept".

---

## 3. Phase P1: correctness of the hub

### T6 · Reviewers are read-only; executor table cleanup (lango hub)
- **Files:** `.agent-hub-orch/executors.json` (lango repo).
- **Steps:** remove `claude-oc3` from `reviewOrder` unless OpenCode can run read-only (check
  `opencode run --help` for an agent/permission flag; if it exists, use it). Verify the claim that
  `oc-nemo-*`, `oc-mimo`, `oc-bunny` are enabled; disable any lane with a recorded hallucination.
- **Done when:** `node .agent-hub-orch/dispatch.mjs lanes` lists only intended reviewers; diff shown.

### T7 · Prune stale agents (hub kit)
- **Files:** `engine/hub.mjs` (fold + a new `gc` command).
- **Steps:** `hub.mjs gc --stale-min 120`: emit `leave` for agents STALE > 120 min with no claim.
  autoloop calls it once per hour.
- **Done when:** on a copy of lango's events, `gc` drops the STALE count from 29 to the number with live claims (print both).

### T8 · Shared files are never claimable (hub kit)
- **Files:** `engine/hub.mjs` `claim` path; `config.json` gets `"unclaimable": ["FIXES.md", "locales/*.json"]`.
- **Steps:** first verify the FIXES.md deadlock in lango's events (`grep FIXES.md .agent-hub-orch/events.jsonl`);
  then reject claims that match `unclaimable` with a message pointing to `tools/fixes-add.mjs`.
- **Done when:** selftest + a manual `hub.mjs claim … --files FIXES.md` is rejected.

### T9 · Accepted work reaches GitHub (hub kit)
- **Files:** `engine/accept.mjs` (end of a successful accept).
- **Steps:** after the commit, non-blocking `git push origin HEAD:<branch>` (spawn, ignore failure,
  log it). Config switch `"pushOnAccept": true`.
- **Done when:** on a scratch repo with a bare remote, accept pushes; with the remote unreachable, accept still succeeds.

### T10 · App commits only through accept (lango repo)
- **Files:** `lango-app` git hooks via `lefthook.yml` (already present) or `.git/hooks/pre-commit`.
- **Steps:** reject commits touching `lango-app/` unless env `HUB_ACCEPT=1` (set by `accept.mjs`).
- **Done when:** a manual commit to `lango-app/x` is rejected; an accept commit passes.

---

## 4. Phase P2: isolation and runtime (bigger; plan each with the orchestrator before starting)

### T11 · One worktree per builder lane (hub kit `dispatch.mjs`, `accept.mjs`)
Builders run in `git worktree add ../.lanes/<lane> <branch>`; accept merges the lane's commit back.
Removes the shared-tree races (F8). Large: write a design note first (`docs/plans/worktrees.md`), get
orchestrator approval, then implement.

### T12 · Exclusive lock for schema/migration tasks (hub kit)
Tasks with `phase: "migration"` (or scope under `drizzle/`) run alone: dispatch waits until no other
build runs, and nothing else dispatches while it runs.

### T13 · SchoolOS dev servers as services (lango + devbox)
1. Verify the crash first: `journalctl` / `/tmp/server-3401.log` for the pg idle error.
2. Attach `pool.on('error', …)` in the DB init file (find it under `lango-app/src/**/db*`), plus
   try/catch in `schedule-worker.ts` `runDueSchedules()`.
3. Run 3401/3402 as user systemd units (`devbox` style, `Restart=always`, `MemoryMax=1500M`); remove
   every `nohup next dev` recipe from docs.
- **Done when:** `kill -9` of the 3401 process → it is back within 15 s; `curl -I localhost:3401/fr/login` 200.

### T14 · snap-route.cjs evidence is trustworthy (devbox or lango scripts)
Verify then fix: accept `/en` prefixes; fail (exit 2) when the final URL contains `/login` or
`access-denied`; launch Chromium with `--no-sandbox --disable-dev-shm-usage --disable-gpu`; always close the browser in `finally`.

### T15 · Playwright system libraries **[USER]**
Verify: `npx playwright install chromium && ldd ~/.cache/ms-playwright/chromium*/chrome-linux*/chrome | grep 'not found'`.
If libraries are missing, the user runs `sudo npx playwright install-deps chromium`.
Also make unit verification not launch the browser project (`vitest run --project unit` if configured).

### T16 · Shrink the driver (after P0–P1 are stable)
Replace regex steering (`buildSteerPrompt` branches) with one prompt: user text + a 15-line fleet
digest (running jobs, review queue, last 3 accepts, dev-server health) + "answer with task IDs and
commit hashes, no pleasantries". Target < 600 lines. Keep `/orch` commands unchanged.

### T17 · Docs
Update `devbox/ORCHESTRATOR-CONTROL.md` (new order, budget rules, alerts) and the operational
manual §7.2/§7.3 (remove `nohup` recipe and the Claude-first order).

---

## 5. Reporting format (after every task)

```
TASK Tn · <title>
Changed: <files with line ranges>
Commands run + real output: <…>
Done when: PASS | FAIL (<why>)
Noticed, not fixed: <list>
```

The orchestrator reviews each report, then says "next".
