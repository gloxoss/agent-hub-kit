# Section 06: Orchestrator driver v2

## Overview
Replace the 1,104-line driver with a small set of modules that: wake only for real events, pick the
manager by remaining quota, enforce "costly managers never code", count tokens correctly, explain quota
drains, and keep the features the owner wants (reports, screenshots, session refresh, quota status, /orch).

## Risk: [red] - Live system, critical path; rollout straight to live with `.prev` rollback.

## Dependencies
- Depends on: section-01 (accounts.mjs pick/explainDrain, quota.mjs --json), section-02 (wa --auto/--reply-to, format.mjs)
- Blocks: section-09, section-10, section-11, section-12
- Parallel batch: 2

## TDD Test Stubs
- Test: replaying 30 lines of yesterday's autoloop output wakes ≤ 5 turns (only DECIDE/QUOTA/FAIL/WHATSAPP/SYNC-problem/START).
- Test: `isOrchestratorWrite()` blocks `sed -i lango-app/x`, `cat > src/a.ts`, `git commit -am`, `cp a lango-app/b`; allows writes under the hub, `docs/`, `~/.devbox-brain/`.
- Test: a cheap-cost manager (Gemini pool) is allowed edits; a costly one (Claude, Codex) gets tool denial.
- Test: two cumulative usage samples 1,000,000 → 1,020,000 give a turn delta of 20,000 and no rotation.
- Test: when every orchestrator entry is down, exactly one WhatsApp alert with the drain explanation is sent.
- Test: no project-specific path or person name appears in engine/ (grep check).

## Tasks

<task type="auto" id="06-01">
  <name>Module skeleton and config</name>
  <files>engine/orchestrator/config.mjs, engine/orchestrator/state.mjs (new)</files>
  <action>
    `config.mjs`: resolve ROOT and hub dir (`.hub` first, then `.agent-hub-orch`, `.agent-hub`), node name, project name,
    and read `config.json` → `orchestrator` block with defaults: `maxTurnsPerHour: 6`, `silenceMinutes: 5`,
    `turnMinutes: 20`, `rotate: { contextTokens: 75000, turns: 8 }`, `quietHours: "23:00-08:00"`, `screenshotCommand: null`,
    `reportEveryMinutes: 15`, `heartbeatMinutes: 60`. No hardcoded project paths or names anywhere.
    `state.mjs`: load/save `<hub>/orch-driver.json` atomically (write `.tmp` then rename): sessions, until, current,
    ledger pointer, lastAlertKey, turnsThisHour.
  </action>
  <verify>`node -e` importing both prints the resolved config for the lango folder; state round-trips through a temp dir.</verify>
  <done>The driver has clean, project-neutral configuration and crash-safe state.</done>
</task>

<task type="auto" id="06-02">
  <name>Event intake with a wake filter</name>
  <files>engine/orchestrator/events.mjs (new)</files>
  <action>
    Follow `autoloop.mjs` and `wa inbox` (from section 02) as child processes; parse lines into events. Wake classes:
    `user` (WHATSAPP lines, terminal), `decide` (DECIDE), `quota` (QUOTA when the lane has no fallback), `fail` (GATE FAIL twice,
    rework DECIDE), `sync` (SYNC … diverged|conflict), `start`. Everything else (DIGEST, MOVED, ACCEPTED, routine SYNC) goes to
    the report buffer only. Export `classify(line)` for tests. Restart a child after 10 s if it exits.
  </action>
  <verify>Replay fixture (30 real lines from `.agent-hub-orch/runs/orchestrator.log` and autoloop output) → printed wake count ≤ 5.</verify>
  <done>The manager is woken only when a decision is needed.</done>
</task>

<task type="auto" id="06-03">
  <name>Turn runner per agent family with hard limits</name>
  <files>engine/orchestrator/runner.mjs (new)</files>
  <action>
    `runTurn(entry, prompt, session)`: Claude family → `-p --permission-mode auto --output-format stream-json --verbose
    --max-turns 25 --model <entry model or sonnet>` plus, for cost "plan"/"user"/costly entries,
    `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Task,Agent`; resume with `--resume <sid>` else `--session-id <uuid>`.
    Codex → `codex exec --json --sandbox workspace-write -c sandbox_workspace_write.network_access=true [-m model] -C ROOT`,
    resume `codex exec resume <sid>` (no `--sandbox` on resume; use `-c sandbox_mode="workspace-write"`). OpenCode →
    `opencode run --format json [--agent plan] [-m model] [-s sid]`. stdin ignored; PATH includes `~/.claude-launchers` and
    `~/.local/bin`; silence watchdog and turn timeout from config; kill the process tree (POSIX `kill -TERM -pgid`, Windows `taskkill /T`).
    Cheap entries (cost "free", e.g. Gemini pool) may edit: no edit-tool denial. Every entry (cheap or costly) also gets read
    denials for secrets: `Read(./.env*)`, `Read(~/.config/devbox/**)`, `Read(~/.cli-proxy-api/**)`, `Read(~/.config/waha/.env)`,
    `Read(~/.ssh/**)` (Claude family via `--disallowedTools`; others via the guard in 06-04).
  </action>
  <verify>Dry-run mode (`ORCH_DRY=1`) prints the exact command line per family for a fixture entry list; matches expected.</verify>
  <done>Every manager turn runs with the right caps, session handling and permissions for its cost class.</done>
</task>

<task type="auto" id="06-04">
  <name>Code-write guard for costly managers</name>
  <files>engine/orchestrator/guard.mjs (new), engine/orchestrator/runner.mjs</files>
  <action>
    `isOrchestratorWrite(cmd, {root, hub})`: split on `&& || ; |`, flag writes (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`,
    `git commit`, `git apply`, `git checkout --`, `npm/pnpm install`, `node -e` with `writeFile`) whose targets are outside
    `<hub>/`, `docs/`, `~/.devbox-brain/`, `/tmp/`; also flag direct secret reads (`cat|less|head|grep` on `.env*`,
    `~/.config/devbox/`, `~/.cli-proxy-api/`, `~/.config/waha/.env`, `~/.ssh/`) for every entry. The runner reads stream-json `tool_use` (Claude) / `item.*` command events
    (Codex) live; on a flagged command for a costly entry: kill the turn, log `VIOLATION <entry> <cmd>`, mark the entry down 2 h,
    and queue a note for the next report.
  </action>
  <verify>Fixture of 8 commands (4 allowed, 4 blocked) prints the expected booleans; a recorded stream with a blocked Bash call ends the dry turn with VIOLATION.</verify>
  <done>Costly managers cannot quietly do builder work.</done>
</task>

<task type="auto" id="06-05">
  <name>Telemetry ledger and session refresh</name>
  <files>engine/orchestrator/telemetry.mjs (new)</files>
  <action>
    Claude: read only the final `result` event (`usage`, `total_cost_usd`, `modelUsage`); per-session keep the last cumulative
    value and record the delta. Codex: sum `turn.completed.usage` within one run and verify empirically whether values are
    cumulative across `exec resume` (log both readings on first use; store the finding in the ledger header). Append one line per
    turn to `<hub>/runs/orch-ledger.jsonl` `{t, entry, session, inTok, outTok, costUsd, contextTok, wake}`. Rotate a session when the
    latest context size ≥ `rotate.contextTokens` or its turn count ≥ `rotate.turns` (never because of cumulative totals).
  </action>
  <verify>Fixture streams: 1,000,000 → 1,020,000 cumulative gives delta 20,000 and no rotation; context 80,000 triggers rotation.</verify>
  <done>Cost numbers are correct and sessions refresh only when their context is really full.</done>
</task>

<task type="auto" id="06-06">
  <name>Selection, failover and the drain message</name>
  <files>engine/orchestrator/select.mjs (new)</files>
  <action>
    Each wake: `accounts.pick({role: "orchestrator"})` (section 01), skip entries over `maxTurnsPerHour` or down. On failure set
    `until` from the provider reset time if known, else 60 min + random 0–15 min jitter; try the next entry silently (log only).
    WhatsApp alert (`--auto`, `format.alert`) only when: every entry is down (one alert per distinct down-set, with
    `explainDrain()` lines and "add or top up an account: devbox lanes add"), or the manager on duty changed for over 1 h. Whenever the owner's own Claude account (owner "user") takes a turn, send one
    line first: "Using your Claude account: <other managers> down until HH:MM." (once per episode).
  </action>
  <verify>Replay of the 2026-10-30 09:33–09:50 log sequence produces 0 alerts; an all-down fixture produces exactly 1 with drain lines.</verify>
  <done>The best available manager is used, failovers are quiet, and an outage comes with a reason.</done>
</task>

<task type="auto" id="06-07">
  <name>Prompts, reports, screenshots and /orch commands</name>
  <files>engine/orchestrator/prompt.mjs, engine/orchestrator/commands.mjs, engine/orchestrator/report.mjs (new)</files>
  <action>
    `prompt.mjs`: bootstrap = playbook path (`engine/ORCHESTRATOR.md`) + a 15-line fleet digest (running jobs, review queue, last 3
    accepts with commit hash, dev health from config) + events; steer prompt = owner text + digest + "answer with task IDs and
    numbers, no filler"; no regex intent detection. `report.mjs`: every `reportEveryMinutes` send `format.status` only if the board
    changed; hourly heartbeat when idle; in quiet hours no routine messages except one "nothing running, reply to start work". Unanswered numbered questions are
    re-sent every hour, day and night (quiet hours do not apply to them), while other tasks keep running.
    Screenshots: if `screenshotCommand` is set, `/orch shot <route>` runs it and sends `wa image`. `commands.mjs`: keep
    `/orch status|quotas|use|order|pause|resume|reset|models` (quotas from `quota.mjs --json`, not `check-quotas.mjs`).
  </action>
  <verify>`grep -rn "lango\|Ossama\|/home/dev/projects" engine/` returns nothing; `--cmd status` and `--cmd quotas` render plain text from fixtures.</verify>
  <done>The owner keeps every feature they asked for, without project leaks in the kit.</done>
</task>

<task type="auto" id="06-08">
  <name>New entry point, rollout and rollback</name>
  <files>engine/tools/orch-driver.mjs</files>
  <action>
    Replace the file with a thin entry (< 150 lines) wiring config → state → events → select → runner → telemetry → report,
    plus `--cmd`, `--say`, `--help`. Add a selftest step: `orch-driver.mjs --help` and a dry wake cycle (`ORCH_DRY=1`) on the
    selftest workspace. Rollout: on the server keep `orch-driver.mjs.prev`, install, `node --check`, restart the lango orchestrator,
    watch 30 min; rollback = restore `.prev` + reinstall + restart.
  </action>
  <verify>Selftest passes with the new steps; on the server `devbox orch status lango…` active and the log shows `driver up` then a START turn.</verify>
  <done>The live orchestrator runs the new driver, with a one-command way back.</done>
</task>
