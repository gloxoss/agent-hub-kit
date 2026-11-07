# agent-hub-orchestrator · kit

A portable version of the hub workflow: one orchestrator session plans and reviews, background executors build, and an autoloop runs the routine cycle.

## Install

```bash
node kit/install.mjs
```

The installer copies the kit to `~/.claude/skills/agent-hub-orchestrator/`, backs up an existing folder to `agent-hub-orchestrator.bak-<date>` first, and prints the first-run commands. `node kit/install.mjs --dry` prints the plan and changes nothing.

By hand, if needed:

```bash
cp -r kit/ ~/.claude/skills/agent-hub-orchestrator/
```

Windows (PowerShell):
```powershell
Copy-Item -Recurse kit/ "$env:USERPROFILE\.claude\skills\agent-hub-orchestrator\"
```

## First run in a new workspace

1. **Scaffold** the hub in your project:
   ```bash
   cd /path/to/your/project
   node ~/.claude/skills/agent-hub-orchestrator/engine/init.mjs \
     --pack generic \
     --name "My Project"
   ```
   Replace `generic` with a pack name (e.g. `ui-migration`) if you have a pack for your domain. `init` never overwrites an existing file; it prints `SKIP` instead.

2. **Join** as orchestrator (run from your project root):
   ```bash
   node .agent-hub/hub.mjs join --agent orchestrator --role orchestrator --tool claude
   node .agent-hub/hub.mjs status
   ```

3. **Load the skill** in your Claude Code session and start planning:
   ```
   /agent-hub-orchestrator
   ```

4. **Fill the first briefs** from `.agent-hub/templates/brief.md`. For a batch, have a planner write a task table and use the `gen-tasks.mjs` pattern in `SKILL.md`.

## Self-test

Check the engine without touching a workspace:

```bash
node engine/selftest.mjs
```

Run it from the installed skill folder (`~/.claude/skills/agent-hub-orchestrator/`). It checks that the engine files parse, the executor table loads, and the hub and autoloop start in `--dry` mode. Every line should say `PASS`.

## Ping executors

Check which executors are reachable before dispatching:
```bash
node .agent-hub/dispatch.mjs ping all
```
An answer that names a model is healthy. An echoed prompt means the binary is missing or the shell failed to quote it. See `references/executors.md` for restore steps.

## Start the autoloop

Run this in a background terminal, or under the Monitor tool in Claude Code so its lines are delivered to the session:

```bash
node .agent-hub/autoloop.mjs
```

Only lines worth waking the orchestrator appear on stdout: `DECIDE`, `QUOTA`, `MOVED`, `DIGEST`. The autoloop starts reviews, accepts passes, appends rework findings to briefs, retries failed jobs, and dispatches queued tasks once their deps are built.

One tick only (cron or a Monitor interval):
```bash
node .agent-hub/autoloop.mjs --once
```

Queue a task for the autoloop by adding it to `.agent-hub/autoloop-queue.json`:
```json
{ "T-01": "claude-ds2", "T-02": "claude-ds2" }
```

## Pause the project

1. Stop the autoloop and confirm no job is still writing (`.agent-hub/runs/jobs.jsonl`).
2. Run the report task (`templates/report-task.md`): session report plus project overview.
3. Rewrite `docs/HANDOFF.md` and `docs/NEXT-SESSION.md`.
4. Commit, then `node .agent-hub/hub.mjs leave --agent orchestrator`.

The pause is complete when a new session can start from `docs/NEXT-SESSION.md` alone.

## Resume the project

Say "continue from NEXT-SESSION". Then:

```bash
node .agent-hub/hub.mjs join --agent orchestrator --role orchestrator --tool claude
node .agent-hub/hub.mjs status
node .agent-hub/quota.mjs
node .agent-hub/dispatch.mjs ping all
node .agent-hub/autoloop.mjs
```

Read `NEXT-SESSION.md` for the order, `HANDOFF.md` for the last session's state, and do not re-plan tasks the queue already holds.

## Packs

| Pack | Use case |
|---|---|
| `generic` | Any project: plan → build → review |
| `ui-migration` | Webflow → Next.js section library, faithful per-template storefronts |
| `backend` | API / service migration |
| `ai` | LLM pipeline / agent project |

Add a pack by creating `kit/packs/<name>/PACK.md` (and optionally `skills/`, `agents/`, `docs/`). Packs may override any file in `docs/`; `init` prints every file it writes.

## Kit sync

Workspaces that install the kit often improve it. Differences flow **upstream only after the user says yes**.

Master kit repo (default): `C:/Users/OMEN/OneDrive/Documents/projects/agent-hub-kit`. The installer writes `KIT-SOURCE` and stamps `kit.version` / `kit.source` into `engine/config.json`.

```bash
node .agent-hub/tools/kit-sync.mjs check [--quiet]
node .agent-hub/tools/kit-sync.mjs propose
node .agent-hub/tools/kit-sync.mjs apply <proposal> --yes   # only after user agreement; proposal-listed files only
node .agent-hub/tools/kit-sync.mjs pull --yes               # MASTER-NEWER → instance (config: kit metadata only)
```

Orchestrator: run `check` at session start, after tool fixes, and when a DIGEST shows `KIT-UPGRADE`. Then `propose`, ask once, and only on yes `apply --yes` (then commit in the master repo with the printed commands). `MASTER-NEWER` includes master-only files. See `templates/KIT-SYNC.md`.

## Herdr (default)
Agent jobs open as real interactive sessions in Herdr tabs, with a live board tab, started by a Claude Code session hook. See SKILL.md, section "Default way of working: Herdr".
