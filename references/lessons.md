# Lessons

Every failure this workflow has already paid for, with the fix that stuck. Read this before adding an executor, changing the dispatcher, or planning a parallel batch.

Format: symptom, cause, fix. Entries are grouped by the part of the loop they come from. Nothing here is project-specific on purpose; `{{PROJECT}}` stands for whatever workspace the hub was installed into.

---

## 1. Launching executor CLIs (Windows)

### 1.1 A detached CLI writes nothing to an attached log file
**Symptom.** The job log stays empty while the job runs; `dispatch list` says RUNNING with no output, then the whole transcript appears at exit, or never.
**Cause.** On Windows these CLIs detect that stdout is a file handle and skip writing; they write fine to a pipe.
**Fix.** Launch a detached `_runner` that owns a pipe (`stdio: ['ignore', 'pipe', 'pipe']`) and appends both streams to the log as they arrive. Never attach the log directly as the child's stdout.

### 1.2 `cmd` splits a multi-line or spaced prompt into separate arguments
**Symptom.** The executor starts, then fails or answers the first word of the prompt; the log shows the prompt truncated at a space.
**Cause.** `.cmd` launchers run through a shell and the shell does not re-quote arguments, so `-p "do the thing"` arrives as three arguments.
**Fix.** Build one quoted command line yourself (`cmd + args.map(quote).join(' ')`) and keep the prompt a short single line pointing at a prompt file (`Read the file .agent-hub/runs/<job>.prompt.md`). Never pass prompt text as a multi-line argument.

### 1.3 The executor hangs with stdin open
**Symptom.** The process sits at RUNNING forever with no output and no exit; killing it produces no useful error.
**Cause.** codex, opencode and several Claude launchers wait for piped stdin when they detect a non-tty.
**Fix.** Spawn with stdin `ignore` (and `</dev/null` in a shell wrapper). If a CLI still blocks, close stdin explicitly before the first prompt.

### 1.4 A failed job reports QUOTA when it was not
**Symptom.** A job exits non-zero with an ordinary error, `dispatch list` prints `ACTION FOR YOU (QUOTA)`, and the account is skipped for an hour for no reason.
**Cause.** Success JSON events carry field names like `rate_limits`, and the agent's own output may quote words like "quota" or "authentication" mid-task.
**Fix.** Judge a problem only when the process is not running and its exit code is not 0. Scan only error-like lines in the tail, and order the rules DOWN, then QUOTA, then AUTH, so a refused connection wins over a quoted limit.

### 1.5 Gemini through Claude Code rejects tool schemas
**Symptom.** Every job on the Gemini launcher fails on the first tool call with a schema or validation error, or produces no tool calls at all.
**Cause.** Gemini validates Claude Code's built-in tool schemas strictly and rejects some of them.
**Fix.** Run it with `--strict-mcp-config --tools Bash,Read,Edit,Write,Glob,Grep` (six tools, no MCP). The first call after a cold proxy start can take minutes; if it fails, run the launcher once by hand to boot the proxy.

### 1.6 A stopped job leaves its dev server listening
**Symptom.** A new lane cannot start on its port, or a later build binds an old server's state.
**Cause.** Stopping the background job on Windows does not kill the process tree it started.
**Fix.** Each agent claims `port:<n>` in its hub claim, and stops the server by PID (netstat to find it), then proves the port is free before reporting `done`.

### 1.7 A job exits without running `done`
**Symptom.** The task stays CLAIMED with no changelog entry; the transcript ends cleanly.
**Cause.** The executor finished its turn without executing the final hub command (token cut, confusion, a silent tool failure).
**Fix.** The autoloop resumes the same job once (same prompt, same lane). If it exits without `done` a second time, print `DECIDE <task>` with the log path and stop retrying; a human or the orchestrator must look.

### 1.8 An executor dies and the task waits
**Symptom.** A build job fails with QUOTA/AUTH/DOWN and the task sits CLAIMED until a human notices.
**Cause.** Nothing re-dispatches a failed job by itself.
**Fix.** Move the task to the next healthy executor in the build fallback order and print `MOVED <task>`; skip an executor for one hour after a QUOTA/AUTH/DOWN signal.

---

## 2. Health detection and routing

### 2.1 A free opencode model quits mid-task near ~140k tokens, or typos a path
**Symptom.** The job ends abruptly with a truncated answer, or edits a path that does not exist and reports success.
**Cause.** Free models have a small effective context and weaker tool discipline than the paid ones; long briefs, whole-file reads and large diffs overflow or distract them.
**Fix.** Give opencode only small tasks: one file or a narrow section, a short brief, and a proof it can run in a few commands. Never a whole page or a multi-file refactor.

### 2.2 Gemini runs away past ~32k output tokens
**Symptom.** A job on the Gemini launcher streams output for a very long time, then hits the cap with a partial result.
**Cause.** It re-reads and re-explains instead of acting when the task is broad.
**Fix.** Small tasks only, explicit "do not restate the brief" wording, and a hard stop in the brief ("your final message is the report, nothing else").

### 2.3 codex at high reasoning drains its 5-hour window in a few reviews
**Symptom.** `quota.mjs` shows the Codex window nearly empty after two or three review jobs.
**Cause.** `model_reasoning_effort="high"` spends the window on deliberation the review does not need.
**Fix.** Reviews always run at `model_reasoning_effort="low"`, read-only sandbox, a 12-tool-call budget, and caveman-review output (one line per finding). Reserve high effort for a human decision, not a routine review.

### 2.4 The right executor for a role is chosen by chance
**Symptom.** A build lands on a reviewer-first executor and a review lands on a builder with weak code-reading.
**Cause.** Dispatch order was ad hoc.
**Fix.** Two fixed orders. Builds: strong first (`claude-ag2-sonnet`, `claude-ds2`, `claude-ds3`, `claude-ds1`, `agy`, `opencode`, `cursor`). Reviews: healthy first (`codex`, `claude-ag2-sonnet`, `claude-grok` when its launcher exists, `cursor`, `claude`). Load the orders from `executors.json` so they are data, not code.

### 2.5 Never print a key while auditing quota
**Symptom.** A quota command or its log leaks the management key.
**Cause.** The key was interpolated into a debug print or a URL that gets echoed.
**Fix.** Read the key from `CLIPROXY_KEY` or the proxy's setup file, use it only in the Authorization header, and never print it, not even masked, in normal output or error text.

---

## 3. Parallel lanes and the shared tree

### 3.1 Next.js rewrites `tsconfig.json` for an unlisted build dir
**Symptom.** Every build changes `tsconfig.json`; parallel agents see each other's files and CI reports a dirty tree.
**Cause.** Next writes an include entry for any `NEXT_DIST_DIR` it has not seen literally listed, and two agents race on that write.
**Fix.** List every lane's build dir as a literal pair in `tsconfig.json` include, and refuse to dispatch to a lane whose dir is not listed. Proof: two builds with different dirs leave `tsconfig.json` byte-identical.

### 3.2 Next 16 rewrites the agent instruction file during `next dev`
**Symptom.** `AGENTS.md` changes on its own while a dev server runs.
**Cause.** Next's `agentRules` feature is on by default and writes agent instructions.
**Fix.** Set `agentRules: false` in the Next config and keep the instruction file hand-written.

### 3.3 One hot file serializes every lane
**Symptom.** Lanes idle waiting on each other, or two agents corrupt the same registry/strings/index file.
**Cause.** All work funnels through one registry, one strings file, or one barrel file.
**Fix.** Make shared indexes generated and gitignored, one microcopy file per namespace, and per-agent build dirs. The generator is the only writer; nobody claims the generated file.

### 3.4 Two tasks that touch one file collide
**Symptom.** One task's edits vanish or the tree fails to compile because two lanes wrote the same component.
**Cause.** Both were dispatched side by side with overlapping scope.
**Fix.** Chain them with a dependency, or move the shared part into one task and give the second task the rest. The rule: one owner per file, enforced by the claim.

### 3.5 A cross-lane build break blocks everyone
**Symptom.** A worker's `npm run build` fails in a file it does not own, typically because another lane is mid-edit.
**Cause.** Shared tree, parallel lanes, no isolation.
**Fix.** The worker proves its own files statically (lint, gates, type-check with `--noEmit`, scoped checks), reports `cross-lane build break in <file:error>` in its verify line, and finishes. The orchestrator re-runs the full build before accepting. Never block, never fix another lane's file.

### 3.6 A generated file's type error looks like your bug
**Symptom.** The build fails in `*.generated.ts`; the worker's own files are clean.
**Cause.** The generator emitted a shape the consumer does not accept, or another lane's entry broke it.
**Fix.** Identify whether the failing file is generated and gitignored. If you own the generator, fix it; otherwise treat it as a cross-lane break and say so. Never hand-edit a generated file.

### 3.7 A per-page island strips a global class on navigation
**Symptom.** After client-side navigation, content that depends on a class set by the motion island (for example `js-enabled`) stays hidden or stops animating on pages that do not mount a second island.
**Cause.** The island was mounted per page; its cleanup removed the root class, and no other instance re-added it.
**Fix.** Mount the island once in the root layout and remove the per-page mounts. If two instances must coexist, make the class ref-counted (first install, last restore), never owned by whichever instance unmounted last.

### 3.8 A motion setup that runs before hydration flashes
**Symptom.** Elements render visible, then jump to their hidden start state, then animate.
**Cause.** The class or style that hides them is added after hydration.
**Fix.** Set the pre-paint class from a tiny inline head script that mirrors the island's media queries, mark the root element `suppressHydrationWarning`, and keep everything visible when JS is off or reduced motion is on.

---

## 4. Proof, review and the stop rule

### 4.1 Browser verification in every worker was the slowest part of the loop
**Symptom.** Builders spend long turns on Playwright, screenshot comparisons and dev servers; actual build time is a fraction of the session.
**Cause.** Every task was proving the same visual behavior that only changes once, at page assembly.
**Fix.** Builders prove statically: build, lint, generator, project gates, clean `git status`. No browser, no dev server. Visual parity is one dedicated pass on the assembled page.

### 4.2 An audit number disagrees with the real asset
**Symptom.** An image renders at the wrong intrinsic size, or a spacing value produces a layout that does not match the source.
**Cause.** The audit was written from a screenshot or a stale measurement.
**Fix.** When markup and audit disagree, verify against the localized CSS and the real file dimensions, build from the verified value, and correct the audit in the same task (an audit doc is a worker-editable artifact where the pack allows it). Never ship a number the source does not support.

### 4.3 Two pages carry two different values for one record
**Symptom.** A product shows one price on a card and another on its detail page; the same entity has two names.
**Cause.** Each page's fixture copied what its own source page showed.
**Fix.** One record per entity, from one source of truth (the engine/mock adapter), and every page reads it. Log the choice in the decisions file so a future agent does not "fix" it back.

### 4.4 Endless rework rounds
**Symptom.** A task is sent back three, four, five times; each round produces new small layout findings and the lane never frees.
**Cause.** The reviewer keeps grading the same non-blocking details instead of moving them forward.
**Fix.** Stop rule: after the first rework round, FAIL only for a functional bug, an accessibility failure, or a visible layout break. Everything else goes on `BACKLOG:` lines and the verdict is PASS. The reviewer applies the rule itself; the orchestrator does not re-litigate it.

### 4.5 A reviewer writes essays
**Symptom.** A review costs more tokens than the build and buries the one blocking finding.
**Cause.** No output contract.
**Fix.** The review prompt fixes the shape: first line `VERDICT: PASS` or `VERDICT: FAIL`, at most 10 numbered blocking findings, then `BACKLOG:` lines, no praise, no summary, at most 12 tool calls, caveman-review style.

### 4.6 A worker cannot edit the decisions log, so a deviation disappears
**Symptom.** A build deliberately differs from the source; weeks later nobody knows why; someone "fixes" it back.
**Cause.** The worker's scope excludes the decisions file, and the deviation was only mentioned in a changelog line.
**Fix.** Workers report the deviation through the hub (`say ... "log decision: <what, why, scope>"`); the orchestrator writes it with an id. A task whose only remaining work is documentation is still a task, never a silent skip.

### 4.7 The orchestrator reading every verdict and diff burns its quota
**Symptom.** The orchestrator session is slow and expensive, and most of its context is other agents' output.
**Cause.** It reviewed every result by hand while the jobs ran.
**Fix.** Run the autoloop: it reads verdicts and job exits itself, applies the stop rule, moves failed jobs, and notifies the orchestrator only on `DECIDE`, `QUOTA`, `MOVED`, and `DIGEST`. The orchestrator reads the diff only when it accepts, and spot-checks one claim per task instead of re-running everything.

---

## 5. Queue and dependency mechanics

### 5.1 Retry keys that never expire park tasks forever
**Symptom.** A task sits in the queue and nothing happens; a retry was already "used" days ago.
**Cause.** One-shot keys (retry, queue, rework, resume, review) were stored without a lifetime.
**Fix.** Expire those keys after 30 minutes. Only decisions and accepted facts are durable; operational keys are not.

### 5.2 A dependency edit that fails silently blocks a whole fan-out
**Symptom.** Five tasks wait on one dependency that looks correct on the board.
**Cause.** The edit command no-oped (wrong id, wrong flag, stale state) and the tool did not report the failure.
**Fix.** Editing a dependency is a state change: re-read the board after every edit and assert the new value. If the edit did not land, stop and say so before dispatching anything that depends on it.

### 5.3 Optimistic dependencies idle lanes
**Symptom.** Builders wait hours for a sibling task to be accepted, even though its output is on disk.
**Cause.** Dependencies were resolved only on ACCEPTED.
**Fix.** A dependency counts as met once the task is built (REVIEW or later); mark a task strict only when its base is risky. If the base is later sent back, the dependent takes a small rework; that is cheaper than idle lanes.

### 5.4 One probe run does not prove a fix
**Symptom.** A fix passes once, then fails on a second run with a different width or a reload.
**Cause.** Timing, caching or a stale build dir made the first run lucky.
**Fix.** Prove the failure and the fix in the same report: reproduce the bug on the old tree (or with a control), then show the fix on the same input. Delete the probe code afterwards; it is evidence, not a feature.

## Added at pause (2026-10-17)
- **Cursor looks dead while working.** Symptom: cursor jobs marked FAILED and retried on another executor while the original still writes. Cause: cursor-agent runs via a PowerShell wrapper, so the recorded PID is not the worker. Fix: treat a job as live if its log changed in the last 2 minutes.
- **Stale hub session blocks a lane.** Symptom: "exited twice without done"; the worker refuses to join because the lane id is still active. Cause: a killed job never ran `leave`. Fix: the dispatcher retires the lane session when no live job holds the lane.
- **Fix planners under-scope tasks.** Symptom: fix tasks block on an image, strings file or shared helper outside scope. Fix: planner briefs must list every asset, ui-strings file and helper a fix touches.
- **Quota cascades.** One provider window (Antigravity Claude) backs several executors (Sonnet, agy). When it empties, mark all of them down together and move work to independent providers (DeepSeek slots).

- **opencode cannot read outside the workspace.** Symptom: "user rejected permission" on reads of a sibling folder (specs in ../). Cause: opencode external_directory permission in headless runs. Fix: keep tasks that read outside the repo off opencode, or copy the inputs into the repo first.

- **Shared opencode server is a single point of failure.** Symptom: every attached opencode job fails at once with ECONNRESET, misread as QUOTA, and opencode gets parked. Cause: the `opencode serve` window was interrupted. Fix: run opencode jobs standalone by default; use the server only for watching, and never classify ECONNRESET as quota.

- **Tailwind arbitrary selectors with an escaped slash break the whole CSS build.** Symptom: "Parsing CSS source code failed ... Unexpected token Delim(/)" on every page. Cause: a class like `[&_.group\/media]:h-[240px]` in a JS string (Tailwind scans the raw source). Fix: target a data attribute instead (`[&_[data-media]]`), and restart the dev server with a clean cache because the error stays cached.


---

## Added in 2.1.0 (from a long multi-agent session)

### A wrapper that buffers output makes healthy jobs look dead
**Symptom.** A job's log stays at 0 KB for 15+ minutes although the agent is editing files.
**Cause.** A launcher wrapper (account rotation) collected the agent's output and printed it only at exit.
**Fix.** Wrapper output must be streamed. Hold back only the first few KB to decide whether a limit error appeared before real output, then stream. Emit a periodic heartbeat line. Require `[WORKING]` lines in the worker and review prompts (templates now include a HEARTBEAT RULE).

### A reviewer-accepted task can still be wrong
**Symptom.** A task passes review and is committed, but the result is a simplified copy of an approved design, or six items "done" in 13 minutes.
**Cause.** The reviewer checks the brief's wording and the diff, not the approved artifact or the running page.
**Fix.** Verify user-visible work in a real browser against the approved artifact, and run read-only verification tasks that mark each brief item DONE / PARTIAL / MISSING with file:line and run the real linters and tests.

### Flash models given long briefs read and quit
**Symptom.** An OpenCode flash run makes ~20 read calls, then exits with no edits.
**Fix.** Give flash models direct, single-area tasks with exact files and steps; split or reroute anything open-ended (see references/executors.md section 6).

### Single-login CLIs ignore HOME isolation on Windows
**Symptom.** A fresh HOME folder is still signed in as the same Google account.
**Cause.** The CLI keeps its login in the Windows Credential Manager, not in its home folder.
**Fix.** Swap the credential entry (engine/tools/agy-profiles.ps1) or run the agent on Linux with per-profile HOME.

### Untrusted workspace can stall a headless agent
**Symptom.** A job sits with almost no CPU and no edits.
**Fix.** Add the project folder to the CLI's trusted workspaces before dispatching; verify with a heartbeat or log growth within 2 minutes.

### Everything dies on reboot
**Fix.** Keep a restart checklist: proxy, dev server, database/CMS app (the user presses Start), container runtime then notifier, autoloop, watchers; remove stale locks; redispatch each unfinished task with a RESUME note (see skill hub-kit-operate).

## Lessons from MoreneParfums (2026-11-06)

- **Skills outside the workspace kill opencode lanes.** opencode auto-rejects any read or write outside the repo (`external_directory`) and ends the whole turn with exit 0, so the job shows DONE while nothing was done. Workers must read skills from `skills-cache/` (staged inside the repo by `dispatch`), never from `~/.claude/skills` or a skills library. The worker prompt needs the `{{skills}}` block and the "4b. Read every skill file listed above" step, and each brief needs a real `## Skills` section with lines like `- \`name\`: why`. A "Skills: a, b" line inside the brief body stages nothing.
- **Add the repo's own skill folder to `skillRoots`** (`.agents/skills`). Project-specific skills such as the Medusa set live there and are invisible to the index otherwise.
- **opencode lanes also cannot read `.env*`** and cannot write to `/tmp`. Do not put `.env*` files in the scope of an opencode task and do not ask it to query the network.
- **A job that exits 0 without `done` is not a success.** Check the task state, the diff and the log before trusting `DONE`.
- **Synced folders (OneDrive) can lock `autoloop-state.json`.** The write failed with `UNKNOWN` and killed the loop while detached jobs kept running. `save()` now retries and never throws. Prefer keeping `.agent-hub` outside a synced folder.
- **Per-task manual acceptance.** `config.manualAccept` lists task ids for which the autoloop stops at "review passed" (`MANUAL-ACCEPT` line) so the orchestrator accepts by hand: money, stock, security, deploy.
- **The first autoloop tick re-tries every task whose last job failed and marks those executors down for `cooldownMinutes`.** After a model or executor change, old failed jobs can mark a healthy lane down for an hour.
- **An empty `.agent-hub/accounts.json` (`[]`)** is required when `accounts.example.json` ships with the engine, otherwise the picker can route to an executor you excluded.
- **Verify image tags before briefing a task.** `docker manifest inspect <image>` (control with a known image first). `minio/minio` is no longer pullable from Docker Hub or quay.io.
- **Start the autoloop detached from the orchestrator session.** Run through a tool-managed background task it was stopped silently (exit 1, no error) while its detached jobs kept running. On Windows use `Start-Process node ... -WindowStyle Hidden` with stdout and stderr redirected to separate files.
- **Dev-mode backend restarts on every saved file.** With several builders editing `src/`, `/health` is down for about a minute after each save and builder proofs can fail for nothing. Retry before treating it as a break.
- **The autoloop kills jobs it calls slow (> 2x median, minimum 20 min) and its medians can be garbage.** After a long pause the stats held 28,000-minute medians, and with one sample per executor every build over 20 minutes was killed and re-dispatched in a loop. Now `slowJobFloorMinutes` (90) sets a floor and a median above `maxJobMinutes` is ignored. A mass drop in memory use plus several `MOVED ...: slow` lines means this rule fired. The engine has TWO copies of this rule (one on `j.started`, one on `j.t` near the end of `tick`): patch both, then restart the autoloop, because a running process keeps the old code. Check the effective floor with a job that is killed at exactly 20 minutes.
- **Medusa integration tests in a container: use a DB host that contains `localhost`** (for example `postgres.localhost`, aliased to the postgres service). Medusa test-utils forces SSL otherwise and the run fails with `The server does not support SSL connections` or hangs for the 300 s hook timeout.
- **Builders improvise credentials.** One created a secret admin API key to get past the 2FA guard (it revoked it). State in the brief: never create keys, users or test records without deleting them, never bypass 2FA.
- **Freeing a lane by killing a job**: the hub keeps showing the job RUNNING until its log has a `[dispatch] exit` line or goes quiet for `RECENT_MS`. After `taskkill /T /F` on the job's tree, append `[dispatch] exit 143` to its log, then `hub kick <lane>`. Otherwise supervisors think the lane is still busy.
- **A rework that needs a new file needs a wider scope first.** Workers claim only the files in the task scope and stop (correctly) when the orchestrator's rework asks for a test or helper outside it. Widen with `hub edit TASK --scope a,b` before sending a rework that creates files. Never put helper files in `src/jobs/` (Medusa loads each one as a job).
- **Another session can overwrite `.agent-hub/config.json` with an old copy.** It once dropped `manualAccept`, `keeper` and `slowJobFloorMinutes`, and the autoloop then tried to accept sensitive tasks alone. Keep `config.good.json`, make `config.json` read-only, and let `keeper.mjs` restore missing keys (`KEEPER-CONFIG-LOST`).
- **Agents restart shared containers.** An agent ran `docker restart medusa_backend` to load new routes and killed another agent's (and the orchestrator's) integration test (exit 137, no error text). The dev server hot-reloads, so the prompt now forbids restart/stop/recreate of any shared container; if a run dies with 137, check `docker events --since 15m --filter container=<name>` before blaming memory.
- **`cat file | docker exec -i ... pg_restore --list` under `set -o pipefail` fails at random.** pg_restore stops reading after the table of contents, `cat` gets SIGPIPE and the pipeline counts as failed depending on timing (2 of 4 runs deleted a good backup). Read with a redirection (`< file`) instead of a pipe into docker, and never delete a dump pg_dump produced successfully. A backup task is only proven by several consecutive runs plus a restore that compares every table, not by one lucky run.

## Herdr interactive mode (2026-11-07)
- The owner wants to SEE and TALK to each agent, not read a log. Reading a log tab was the first attempt and was rejected. The accepted design is a real interactive session per job in its own Herdr tab.
- An interactive agent never exits by itself, so the hub cannot rely on the process ending. The wrapper writes a heartbeat to the log and writes the "[dispatch] exit" marker when the builder writes its `leave` event. The window stays open after that.
- The session screen is not captured: quota or login problems appear in the pane but not in the hub's diagnosis. Headless mode (`herdr.interactive: false`) keeps the diagnosis.
- Never let the bridge auto-close an interactive tab: it would kill a conversation the owner may be in.
- Herdr CLI: `workspace create`, `tab create --workspace --label --cwd`, `pane run <pane> <command>`, `pane read`. Its own skill says to control it only from inside a Herdr pane; the hub bridge is the owner's explicit integration, started by the owner's session hook.
- On Windows, start it in Windows Terminal with a plain title (`--title MoreneHub`): a title with spaces or brackets is split into arguments and the launch fails.

## Quota loop with a single builder (2026-11-07)
- With `buildOrder: [cursor]` and the weekly limit reached, the autoloop logged "cursor failed (QUOTA), now on cursor" about 35 times, relaunching a paid executor each time. Rule: when the next healthy executor is the one that just failed on QUOTA, AUTH or DOWN, hold the task and say so. Keep at least two build executors in `buildOrder`.

## Tool escaping of backslashes (2026-11-07)
- When a command string is passed through the agent shell tool, a double backslash can collapse to one and a single one can vanish. A regex written as `/^(builder-\\d+)-/` ended up as `/^(builder-d+)-/` and matched nothing. Build such patterns with `String.fromCharCode(92)` or put the code in a file written with the Write tool, then test the regex on a sample value.

## Config files rewritten behind your back (2026-11-07)
- config.json and executors.json were rewritten by something outside the hub (another editor or session) a few minutes after a commit and lost the new interactive settings. The first Codex job then fell back to hidden mode. Rule: put new behaviour that must survive in code defaults (here DEFAULT_INTERACTIVE_ARGS, and only an explicit false turns Herdr or interactive mode off), not only in the JSON config. After any config change, verify with git diff and with one real job.
