# AI pack

Use this pack when the deliverable is a model-powered feature: an agent, a prompt pipeline, a classifier, or an LLM call inside a product. The defining property is that "it works" is not a compile error. Every phase therefore produces an artifact you can score, and the score is the gate.

It assumes the hub rules from `SKILL.md` and the launch/routing facts in `references/executors.md`.

---

## 1. Pipeline

```
data / eval set -> prompt & agent design -> tools -> eval loop -> integrate
```

| Phase | Unit of work | Output | Gate before the next phase |
|---|---|---|---|
| `spec` | one feature or agent | `docs/specs/<feature>.md` | task, inputs, outputs, failure modes and a measurable success bar |
| `evaldata` | one eval case group | `evals/<feature>/cases.*` | at least 20 cases, labeled, no leakage from the prompt, versioned |
| `build` (prompt) | one prompt or agent definition | prompt file + version | runs on every eval case; parameters, model and cost budget fixed |
| `build` (tools) | one tool | tool module + schema | schema validated; errors returned to the model, not thrown; permissions scoped |
| `test` (eval loop) | one experiment | eval run + transcript | score beats or matches the baseline; every regression is explained |
| `integrate` | one call site | wiring + config | timeout, retry, fallback and a cost cap exist; no secret in the repo |

Phases map onto the hub's `PHASES` list at `init` time. An eval case group, a prompt and a tool are each small enough for one executor session; a full eval sweep is not.

---

## 2. Gates per phase

**A1 · Spec**
- The success metric is written as a number ("≥ 90% exact match on the eval set"), not an adjective.
- Inputs, outputs and the refusal/unknown behavior are defined.
- The failure modes that matter (wrong answer, unsafe answer, timeout, cost blow-up) are listed.
- The model and the cost/latency ceiling are named.

**A2 · Eval set**
- At least 20 cases for the first iteration, including the obvious, the ambiguous and the adversarial.
- Each case has an expected output or a rubric for scoring it.
- The eval set is not copied from the prompt examples (leakage makes the score meaningless).
- The set is versioned; adding a case is a visible diff.

**A3 · Prompt / agent design**
- The prompt is a file, not a string buried in code.
- Model, temperature, max output tokens and tool list are explicit and versioned.
- A prompt change ships with the before/after score in the same report.
- No instruction in the prompt asks the model to do what a tool or the code should do.

**A4 · Tools**
- Each tool has a JSON-schema-validated input and a documented output.
- Tool failures are returned to the model as data, so it can recover; they are not thrown past it.
- Tools run against a local mock or fixture in evals, never a live network call; determinism is what makes a score comparable.
- Permissions are scoped: a read tool cannot write, a search tool cannot run arbitrary code.
- Every tool call is logged with its arguments and duration.

**A5 · Eval loop**
- The run uses a fixed seed and a fixed eval version.
- The report states baseline score, new score, delta and the cases that changed.
- Every regression has a one-line cause; unexplained regressions block.
- Cost and latency per case are reported alongside accuracy.
- Transcripts are saved so a later reader can see why a case failed.

**A6 · Integrate**
- The call site has a timeout, one retry policy and a user-visible fallback.
- A per-request and per-day cost cap exists, or the brief says why not.
- Prompts and secrets are read from config; nothing sensitive is committed.
- Logging records request id, model, token counts and outcome, never the raw private data by default.

---

## 3. Typical task list

| Id | Phase | Title | Scope |
|---|---|---|---|
| `S-<feature>-spec` | spec | Specify `<feature>` and its success bar | `docs/specs/<feature>.md` |
| `A-<feature>-evalset` | evaldata | Build the eval set | `evals/<feature>/` |
| `A-<feature>-prompt` | build | Prompt v1 + agent definition | `src/ai/prompts/<feature>.*` |
| `A-<feature>-tool-<name>` | build | Tool `<name>` | `src/ai/tools/<name>.*`, its tests |
| `A-<feature>-eval-<n>` | test | Eval run `<n>` against baseline | `reports/<feature>/<n>.md` |
| `A-<feature>-integrate` | integrate | Wire `<feature>` into `<call site>` | the call site's files only |

Chaining rules:

- The eval set blocks every prompt and tool task; there is nothing to score without it.
- Prompt and tools are independent, so they run in parallel, unless both edit the same registry/definition file (`lessons.md` 3.4).
- The eval run depends on prompt and tools being built; it is strict (wait for accept), because scoring half-built inputs produces noise.
- Integration runs last and owns only the call-site files.

---

## 4. Proof lines for workers

Every `done` carries the command and its result, with numbers. Adapt the commands at `init`.

| Check | Command shape | Expected |
|---|---|---|
| Eval set shape | `node scripts/eval-check.mjs <feature>` | ≥ 20 cases, every case labeled |
| Prompt/tool type-check | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Tool unit tests | `npm test -- --run <tool>` | exit 0, deterministic, no network |
| Eval run | `npm run eval -- --feature <feature>` | prints baseline, new score, delta, cost per case |
| Determinism | run the eval twice | same score both runs |
| Clean scope | `git status --short` | only claimed files |
| Secrets | `git grep -nE '(sk-|api[_-]?key|token)\s*='` on claimed files | no hardcoded value |

The worker reports the eval numbers verbatim. Never "the eval passes"; write `18/20, baseline 14/20, delta +4, cost $0.0031/case`.

A cross-lane break is reported as `cross-lane break in <file:error>`; it does not block.

---

## 5. Review for this pack

1. Does the diff change behavior a case covers, and is the case's expected output still correct?
2. Is the score reproducible from the saved transcript and seed?
3. Does any tool have broader permissions than the task needs?
4. Is the cost/latency budget still inside the spec?
5. Is the prompt change accompanied by a before/after number?

Stop rule: after one rework round, FAIL only for a correctness, safety or cost regression, or a missing eval run. Prompt wording preferences go on `BACKLOG:` lines and the verdict is PASS.

---

## 6. What init adds to AGENTS.md

- The phase list, the unit of work, and the eval gate ("a feature is done when its eval run beats the baseline and the run is saved").
- The eval command and the report path.
- The secrets rule and the mock-only rule for tools during evals.
- The "start here" block and the decisions-file rule.

Replace `{{PROJECT}}` with the workspace name at init. `{{MERGE_TARGET}}` and `{{SITES}}` are unused in this pack.
