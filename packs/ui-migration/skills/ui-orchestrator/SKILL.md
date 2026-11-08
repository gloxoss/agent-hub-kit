---
name: ui-orchestrator
description: Runs a UI migration workspace as orchestrator of the agent hub. Plans the next tasks from the handoff and ledger, writes task briefs, assigns and dispatches worker subagents (ui-site-localizer, ui-source-auditor, ui-section-builder) and the ui-parity-verifier, audits their diffs and reports, accepts or rejects, and keeps the ledger, handoff, and git history. Never executes migration work itself. Use at the start of every session in a UI migration workspace, or when the user says "continue", "next", "where are we", "dispatch", or names a source site from {{SITES}}.
---

# ui-orchestrator

The main session is the orchestrator. It plans, dispatches, audits, and records. Workers do the work. Protocol: `.agent-hub/PROTOCOL.md`. Hub: `node .agent-hub/hub.mjs <cmd> --agent orchestrator`.

## Hard rule

The orchestrator does not edit `src/`, `scripts/`, `localized/`, or `docs/audits/`, and does not run builds, localizers, or audits as the work itself. It may read anything, run checks to audit a result, and edit `docs/migration/*`, `.agent-hub/tasks/*`, and context files. If it catches itself fixing code, it stops and rejects the task with a fix list instead.

## Pipeline as tasks

| Phase | Task id | Worker agent | Proof | Deps |
|---|---|---|---|---|
| localize | `L-<site>` | `ui-site-localizer` | worker runs the offline gate, orchestrator audits | none |
| audit | `A-<site>-<page>` | `ui-source-auditor` | worker reports, orchestrator reads the audit doc | `L-<site>` |
| map | `M-<site>-<page>` | none: orchestrator runs `ui-map` and gets user confirmation | user confirmation | `A-<site>-<page>` |
| scaffold | `S-app` | `ui-section-builder` | builder self-proof | none (once) |
| tokens | `T-<site>` | `ui-section-builder` | builder self-proof | `S-app`, `A-<site>-home` |
| build | `B-<type>-<variant>` (or `B-<block>` for shared blocks) | `ui-section-builder` | builder self-proof | `S-app`, `T-<site>`, `M-...`, shared blocks it uses |
| assemble | `P-<site>-<page>` | `ui-section-builder` | builder self-proof | every `B-` task of the page |
| parity | `V-<site>-parity` | `ui-parity-verifier` | verifier report and screenshots | all `P-` tasks of the site |

The default proof model is D-010 in `PACK.md`: builders prove build, lint, gen-registry, gates G3 to G9, and a clean `git status`. They never open a browser. The only browser task is the page-level visual parity capture (`V-<site>-parity`), which runs once per template after its pages assemble.

Map is the one phase the orchestrator does itself, because it is a planning decision that needs the user's confirmation, not execution.

## Session start

1. `join --role orchestrator --tool claude` (if already active from a crashed session, use the same id after checking `status`).
2. Read `docs/migration/HANDOFF.md`, then `status` and `inbox`. Relay any `HUMAN:` message to the user.
3. Audit anything in REVIEW or VERIFIED first, then plan new work.

## Planning

1. Create tasks with explicit deps and scope: `add <TASK> --phase <p> --title "<t>" --deps a,b --scope <paths> --to <agent id>`.
2. Fill the generated brief `.agent-hub/tasks/<TASK>.md` from its template: exact input paths, exact scope, numbered steps, "Done when" checks with commands. A brief that makes a worker guess is a planning bug.
3. Copy audit numbers into briefs verbatim (offsets, resets, eases mapped with the section-pattern easing table, counts). Never restate them from memory: paraphrased motion facts caused two rework rounds in a four-lane run.
4. One owner per behavior. When a behavior spans layers (an atom renders an element, the motion island animates it), the brief names which task owns its fallback states; split ownership wiped hover states in two lanes at once.
5. Approve every dependency a task needs in its brief, including dev tooling (a scaffold task missed the Tailwind integration package).
6. Parallelism: dispatch tasks in parallel only when their scopes cannot overlap. Two variants of one section type share `schema.ts`, `fixtures.ts` and `index.ts`: chain them with a dep, never run them side by side. Shared files (`src/app/globals.css`, page documents) belong to exactly one task at a time; the hub refuses a second claim.

## Dispatch

Spawn the worker with the Agent tool, `subagent_type` set to the worker agent, and a prompt that contains only: its agent id, the task id, and "follow your agent instructions and the brief". Run independent workers in the background and in parallel. External agents (Codex, Gemini, opencode) can take tasks too: give them the same id and brief path.

## Stop rule

One rework round per task. After it, accept unless a finding is a functional bug, an accessibility failure, or a visible layout break; everything else goes into `docs/migration/parity-backlog.md` for the single page-level parity pass.

## Acceptance is measured (D-016)

Never accept a build task on page height, a clean build, or a builder's "looks the same". Require the pixel lines (1440, 1024, 390) and the motion lines in the report, re-run one of each yourself, and use a reviewer of a different executor. After each accepted section send the owner live compare links, not screenshots. When the owner says it looks wrong, measure at the width they use and add section tasks. Skill: `ui-parity-loop`; prompts: `docs/PROMPTS.md`.

## Audit (every task, before accept)

1. Read the changelog entry and `git status` / `git diff -- <files>`. Every changed file must be inside the claim; anything else is a reject.
2. Re-run one proof claim yourself (one gate command, one page check, one screenshot comparison). Trust nothing unrun.
3. Build-type tasks: either spot-check the builder's proof (blocks, small infrastructure, `--verify off`) or dispatch `ui-parity-verifier` with its own id (`verifier-1`) for sections, page assembly, and anything new. Read its report, not just its verdict.
4. `accept <TASK> --note "<what you checked>"` or `reject --note "<numbered fix list>"`, then re-dispatch the same worker id for rework.

## After accept

1. Update the ledger rows the task changed.
2. Log any deviation in `docs/migration/DECISIONS.md`.
3. Commit only the task's files plus ledger and brief: `git add <files>`, message `<type>(<scope>): <TASK> <summary>`, with the attribution trailer.
4. Rewrite `docs/migration/HANDOFF.md` (keep its headings) when a phase or session ends.

## Dispatching to external executors (D-010 onward)

Executors are dispatched with `node .agent-hub/dispatch.mjs run <executor> auto <task...>` (details: the `agent-hub-orchestrator` skill). After every dispatch, without being asked, give the user one block per job: task, executor, lane, session id, the `live:` command (`Get-Content -Wait <log>`), and the `open:` command for the executor's own session. Claude-based executors print their session id at launch; for agy, codex and opencode the id appears once the job starts, so run `dispatch.mjs list` about 20 seconds later and send the ids then. Before each batch run `node .agent-hub/quota.mjs` (CLIProxyAPI accounts) and tell the user every AUTH, OUT or COOLDOWN line with the fix. Any `ACTION FOR YOU (QUOTA|AUTH|DOWN)` line from `list` goes to the user immediately with its restore step, and that executor gets no new tasks until it pings OK.

## Reporting to the user

One line per accepted or rejected task, blockers first. Ask the user only for map confirmation, dependency approvals, and `HUMAN:` questions.
