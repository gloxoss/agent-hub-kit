# UltraPlan Research: Fleet hardening

Date: 2026-10-30. Sources: codebase analysis of `agent-hub-kit` (engine + tools), web/docs research
(Claude Code, Codex, OpenCode, git worktrees, systemd, WAHA, GitHub API, Oracle). Items marked
UNVERIFIED are inference, not read in docs, and must be checked by the task that relies on them.

## Research Topics

1. Claude Code headless controls (tool blocking, step caps, budget caps, sessions, token accounting) - Why: orchestrator never codes, 4–6 turns/h, Claude last resort (Q3, Q15, Q30, Q31)
2. Codex `exec` headless (sandbox, resume, JSON usage) - Why: non-Claude executors and orchestrators (Q9, Q14)
3. OpenCode read-only agents - Why: reviewers must not write (audit F11, Q32)
4. Git worktrees for parallel agents - Why: 4–5 workers, each in its own folder, merge later (Q6, Q12, Q27)
5. Quota-aware rotation - Why: "whoever has the most quota left", proxies asked first (Q14, Q16)
6. Multi-machine coordination over GitHub (area claims, lead lease) - Why: PC + server, split by area (Q17–Q20)
7. WhatsApp (WAHA Core) limits and UX - Why: updates, numbered decisions, files, quiet hours (Q48–Q53)
8. Terminal live dashboard without dependencies - Why: `orch attach` dashboard (Q51–Q52)
9. Process supervision (systemd user units, logs) - Why: restart alone and resume, 7-day logs (Q25, Q36)
10. Disk growth on Oracle - Why: worktrees + 66% disk (Q43)

## Codebase Analysis

### Existing Codebase Findings (agent-hub-kit/engine)

**orch-driver.mjs (1,104 lines)**: any-agent orchestrator with failover.
- Setup 1–103 (vault env, hub detection `.agent-hub-orch` → `.agent-hub` → `.hub`, `DEFAULT_ORDER` 8 lanes, control file, state `orch-driver.json`).
- `checkProxyQuota` 108–157 (CPA: 1-token POST to :8317; AG: `GET :8080/account-limits`), `pingAgent` 160–256 (duplicates the CPA probe), `downFor` 258–281 (429 → 2 min; non-quota 3 min; quota → parse "resets …" else 2 h).
- `command()` 283–339 per family; **codex resume uses `--resume <sid>` (wrong; real form `codex exec resume <id>`)**; `st.pending = randomUUID()` set as a side effect inside the args.
- `orchCommand` 373–432 (`/orch quotas` shells to `~/.local/bin/check-quotas.mjs`, outside the repo, hardcoded labels).
- `turn()` 434–533 (cwd ROOT, 30-min hard cap, 3-min silence watchdog, POSIX-only `pkill`).
- Rotation in `handle` 899–923: input ≥ 75k or total ≥ 90k or 4 turns; reads cumulative usage (audit F5).
- `buildFleetContext` 558–602: **`execSync` used but never imported**, so the commit is always "HEAD".
- `bootstrap` 605–669 and `buildSteerPrompt` 750–823 (regex detectors: name, details, screenshots, action, status) contain **hardcoded lango absolute paths, `snap-route.cjs`, and the operator name "Ossama (Epioso)"** inside the shared kit.
- `extractReply` 671–748 convoluted; `handle` 829–974 (ping → turn → failover → pause note); queue/flush/push 976–996 (TICK after 60 min, flush every 20 s); `follow` 998–1007 (autoloop + WhatsApp inbox); ACK variants 1058–1084; 15-min reporter hook 1097–1104 (script outside repo).
- No worktree or per-task logic; always runs in ROOT.

**hub.mjs (427 lines)**: append-only `events.jsonl`, events stamped with agent + node; `fold()` 59–88; TTL 45 min marks agents stale (they stop blocking claims) but **no GC**, dead agents never pruned, log never compacted. Claims: assignee/holder/status/deps/`--files` required/`outOfScope`/`fileConflicts` (path prefix overlap, local only). `kick` retires an agent manually. Accept requires VERIFIED for build-type phases.

**dispatch.mjs (456 lines)**: executors from `executors.json`; lanes `builder-N` (also Next build dir names); run mode rejects Claude executors (line 348); optional board claim (355–363); `dailyJobLimit`; `checkHealthBeforeDispatch` makes a real model call (cached 10/5 min); **RAM gate `buildMinFreeMB` defaults to 0 (off); no disk check anywhere**; every run spawns with `cwd: ROOT` (`launch()` 194–206, `runner()` 213). Worktree insertion point: before `launch()` (~406), pass a `cwd` through `launch`/`_runner`, rewrite the prompt root (266); hub CLI must keep resolving to the main checkout.

**autoloop.mjs (262 lines)**: 60 s tick; REVIEW → `dispatch review`; `VERDICT: PASS` → `accept.mjs … (autoloop accept)`; FAIL → rework, `DECIDE` after 2 reworks; QUOTA/AUTH/DOWN → `QUOTA` line + executor cooldown 60 min + retry; build failure → `MOVED`; exit without done twice → `DECIDE`; `DIGEST` every 20 min; board sync every 3 min; `sync.mjs run` every 5 min (prints only failures).

**accept.mjs (47 lines)**: **does NOT re-run any checks** (trusts the verdict); records verify, accepts, `git add` + `git commit` in ROOT; commit includes anything already staged; never pushes (sync.mjs pushes).

**quota.mjs (142 lines)**: audits every CLIProxyAPI account via the management API (antigravity, claude, codex usage endpoints); flags OK/LOW/OUT/AUTH/DOWN/COOLDOWN; `--json` gives `{provider, account, flag, detail}` with **detail as free text** (reset times/fractions not machine readable); **incompatible** with the driver's `/orch quotas` script.

**board.mjs / sync.mjs**: per-task, per-machine claims via first `CLAIM node=` comment; no area claims (extension point: new comment kind `CLAIM-AREA`, label `area:*`); board keeps its own fold copy that drifts from hub.mjs (e.g. `release` → OPEN vs ASSIGNED). sync.mjs already uses `git worktree add` (brain only).

**selftest.mjs**: 8 steps; **no coverage** of orch-driver, accept, board, sync, quota, verify/rework, conflicts, failover, rotation, worktrees.

### Tech Stack Comparison
Not applicable (existing stack kept): Node ESM, zero dependencies, bash for devbox, git + gh CLI.

## Web Research

### Best Practices Found

**Claude Code headless** (code.claude.com/docs: headless, permissions, cli-reference, agent-sdk/cost-tracking)
- `--disallowedTools` is a CLI deny rule; precedence deny → ask → allow, first match wins; a narrower allow cannot carve out of a deny.
- Path rules: use `Edit(...)` for all writes (Write/NotebookEdit path rules never match); `Edit(/src/**)` is project-root relative, `//abs` absolute, `~/` home.
- **Bash deny is not a sandbox**: `Bash(rm *)` does not stop `/bin/rm` or `bash -c`. Compound commands are split on `&& || ; |`. Real enforcement = deny rules + `--permission-mode dontAsk` + output monitoring.
- `--max-turns` (print mode only, errors at the limit), **`--max-budget-usd`** (stops the run at the cap), `--permission-prompts none` (denies prompts, reports `permission_denials`).
- Since v2.1.302, `-p` starts in Manual mode when no mode is set (approval-needing calls denied).
- `--bare` skips hooks/skills/MCP/memory/CLAUDE.md (needs API key; not usable with the subscription token).
- Tokens: per-assistant-event usage repeats for parallel tool calls (dedupe by message id); per-step output tokens are placeholders; **the final `result` event carries cumulative `usage`, `total_cost_usd`, `modelUsage`**; on resume (v2.1.277+) `result` includes earlier spend, so read the latest result and never sum across resumes.

**Codex** (learn.chatgpt.com docs)
- Default sandbox read-only; `--sandbox read-only|workspace-write|danger-full-access`; `--full-auto` removed.
- `--json` events: `thread.started`, `turn.started/completed/failed`, `item.*`, `error`; `turn.completed.usage` = input, cached input, output, reasoning tokens (per-turn vs cumulative not documented: UNVERIFIED, test).
- Resume: `codex exec resume <SESSION_ID>` / `--last`; `-o <file>` writes the final message; `codex review --uncommitted|--base <b>|--commit <sha>` is a built-in read-only reviewer.

**OpenCode** (opencode.ai/docs)
- `permission` in `opencode.json`: allow/ask/deny, last matching rule wins; `edit` covers write/patch; per-agent overrides under `agent.<name>.permission`.
- Built-in `plan` agent blocks edits but not bash; define a custom `audit` agent (`.opencode/agents/audit.md`, `edit: deny`, `bash: deny`) and call `opencode run --agent audit --format json`; never pass `--auto` to read-only roles.

**Git worktrees for parallel agents** (claude worktrees doc, pnpm.io/git-worktrees, agent-worktree, community guides)
- Short-lived worktree per task: create → run agent → deterministic gates → merge → `git worktree remove` + `prune`.
- Layout outside the repo folder (e.g. `../<repo>-wt/<task-id>`, branch `task/<id>`), created from the integration branch.
- node_modules: pnpm global virtual store makes per-worktree installs mostly symlinks; npm duplicates (disk heavy). Never share one writable store between untrusted agents.
- Known pitfall: dev-server/DB port collisions across worktrees.
- Merge back: `--no-ff` merge or rebase; cherry-pick for single-commit tasks (preference, UNVERIFIED).

**Budget control patterns**
- Thin event-driven orchestrator: wake on child exit / real events, never poll with LLM turns.
- Hard caps per run (`--max-turns`, `--max-budget-usd`) + a self-built rolling-hour ledger from each run's final usage event.
- Deterministic gates (typecheck, lint, tests, scope checks) **before** any paid review; review only gate-passing work.

### Current Approaches
The current kit already has the right skeleton (event-log hub, autoloop accept on PASS, board, sync). The
drain comes from: the orchestrator doing builder work (F1), heavy context per turn, polling-style ticks,
Claude first in the order, and acceptance trusting verdicts without re-running checks.

### Ecosystem State
Claude Code and Codex both now ship first-class headless controls (budget caps, permission denials in
output, JSON events with usage), so enforcement no longer needs prompt-only rules.

## Competitor Analysis
Internal tool; comparable open tools: `nekocode/agent-worktree` (worktree per agent + pre-merge checks),
Claude Code `--worktree` / subagent `isolation: worktree`.

### Key Differentiators for Our Project
Multi-provider quota rotation across free accounts, WhatsApp-first steering, multi-machine area ownership.

## Library Documentation

### Libraries Investigated
None to add (zero-dependency rule kept). Platform docs: systemd, journald/logrotate, WAHA, GitHub REST, Oracle block volumes.

### Key Findings
- **systemd user units**: `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=300` + `StartLimitBurst=5` in `[Unit]`; `MemoryHigh` (main) below `MemoryMax` (backstop); user units only get delegated controllers (memory/pids usually); linger required. journald: `SystemMaxUse=200M`, `MaxRetentionSec=7day`; logrotate `daily rotate 7 compress delaycompress missingok notifempty copytruncate` for app log files.
- **Terminal dashboard (plain Node)**: alternate screen `\x1b[?1049h/l`, hide cursor `\x1b[?25l/h`, home `\x1b[H`, one write per frame every 1–2 s, `process.stdout.on('resize')`, fall back to 80x24 when not a TTY, restore on SIGINT/SIGTERM/exit; works inside tmux.
- **WAHA Core**: `sendText` (supports `reply_to`), `sendImage` (base64 or URL), `sendFile`; incoming `hasMedia` + `media.url` (can be null; fetch with `downloadMedia=true`). **Anti-ban guidance: reply rather than initiate, ≤ 4 messages per contact per hour then rest, random 30–60 s gaps, vary wording, seen/typing before sending; 5–10 spam reports can ban the number.**
- **GitHub as coordination store**: 5,000 req/h; writes cost 5 points (900 points/min secondary limit); content creation ~80/min, 500/h; honor `retry-after`. **Lease/lock: use ref or contents API compare-and-swap (sha) with TTL ~5 min, renew every ~90 s, GitHub `Date` header as clock, re-read after acquiring, fencing term**. Issue comments have no atomic compare (weaker; current board claims use them).
- **Oracle boot volume**: online resize (increase only), then `growpart` + `resize2fs` (check `lsblk` for device names); usually no reboot (UNVERIFIED); back up first.

### Integration Notes
- Quota rotation needs **structured** quota data: extend `quota.mjs --json` with numeric `remainingFraction` and `resetAt` per account/model, and make the driver use it (drop `check-quotas.mjs`).
- Worktrees need a shared hub dir (events, runs) resolved to the main checkout, and per-worktree build dirs.
- Acceptance must re-run the task's stated checks inside the task's worktree before merging.

## Conflicts Found
1. **WhatsApp volume vs WAHA anti-ban guidance.** Discovery wants 15-min change reports + hourly
   heartbeat + switch/pause notices + replies; guidance is ≤ 4 messages per contact per hour.
   Resolution: see "Conflict resolutions" (asked in Phase 2 review).
2. **Lead election via issue comments** (current board mechanism) vs research recommending ref-based
   compare-and-swap leases. Technical only (no user preference involved): use a ref-based lease for the
   lead role; keep issue comments for task notes.
3. **Codex per-turn vs cumulative usage** undocumented: the telemetry task must verify empirically before
   rotation rules depend on it.

## Summary and Recommendations

### Recommended Tech Stack
Keep: Node ESM zero-dependency engine, bash devbox, git + gh, WAHA Core, systemd user units.
Add: git worktrees per task, `--max-turns`/`--max-budget-usd`/`--disallowedTools` for Claude-family
orchestrator turns, `codex exec --sandbox` + `codex review` for Codex roles, OpenCode `audit` agent for
read-only reviews, ref-based lease for the lead, structured `quota.mjs --json`.

### Key Architecture Decisions
1. Thin, event-driven driver (rewrite): wakes only for user messages, DECIDE/QUOTA/FAIL, sync problems; no LLM polling.
2. Hard enforcement for the orchestrator: tool denial + caps + stream monitoring of shell writes.
3. Deterministic gates in acceptance (re-run checks in the task worktree) before review results count.
4. Worktree per task, merged by acceptance, cleaned up after; hub state stays in the main checkout.
5. Area ownership on the GitHub board + ref lease for the lead; cross-machine review.
6. Quota-ranked rotation from one structured quota source; Claude last with an hourly cap; paid lanes off but switchable.
7. WhatsApp budget-aware messaging (coalesced, ≤ 4/h per group by default) with numbered decisions and file reports.

### Libraries and Tools
None new. Platform features only.

### Risks Identified in Research
- Bash write blocking is best-effort (not a sandbox) → monitoring + violation lockout needed.
- npm-based app (lango uses `npm exec next`) makes per-worktree node_modules disk heavy → disk growth + cleanup required.
- Port collisions if verifiers start dev servers per worktree.
- WhatsApp number ban risk if message volume is high.
- `--bare` unusable with the subscription token; Claude turns still load hooks/CLAUDE.md (context cost).

### Unanswered Questions
- Codex usage semantics (per-turn vs cumulative): verify in the telemetry task.
- Whether OpenCode `run` without `--auto` blocks or proceeds on prompts: verify in the reviewer task.
- Whether Oracle growpart needs a reboot on this image: verify during the disk task.

## Conflict resolutions (user, 2026-10-30)
1. WhatsApp volume: **respect the limit, combine messages.** Max ~4 bot messages per group per hour;
   extra updates are merged into the next one. Direct replies to the user always go out (never dropped,
   never counted against the merge window).
2. Lead lease: ref-based compare-and-swap (technical decision, no user preference involved).
3. Codex usage semantics: verified empirically inside the telemetry task.

User review of research: "Looks good, plan it."
