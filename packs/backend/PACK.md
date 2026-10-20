# Backend pack

Use this pack when the deliverable is a server: a data model, services, an HTTP (or RPC) API, and tests. It assumes the hub rules from `SKILL.md` (one orchestrator, file-scoped claims, optimistic dependencies, one rework round, the autoloop) and the launch/routing facts in `references/executors.md`.

The pipeline replaces the UI pack's visual phases with correctness phases. There is no browser pass; every gate is a command whose output can be pasted into the verify line.

---

## 1. Pipeline

```
spec -> schema & migrations -> services -> API -> tests -> integrate
```

| Phase | Unit of work | Output | Gate before the next phase |
|---|---|---|---|
| `spec` | one feature or resource | `docs/specs/<feature>.md` | every endpoint, field, error and permission listed; no open question |
| `schema` | one migration | migration file + model types | applies, rolls back, is idempotent, and no existing row is lost |
| `build` (services) | one service module per task | service code + unit tests | unit tests pass; errors are typed; transactions and concurrency are explicit |
| `build` (API) | one resource route group per task | routes/handlers + contract tests | contract tests pass; validation, authz, status codes and pagination are covered |
| `test` | one suite per resource | integration tests | happy path and every failure path run offline, deterministically |
| `integrate` | one consumer or deployment target | wiring + config docs | the end-to-end flow runs from a clean checkout; no secret in the repo |

Phases map onto the hub's `PHASES` list at `init` time. Keep the unit of work small enough that one executor finishes one task in one session.

---

## 2. Gates per phase

Run these in order. A later phase never starts on an earlier gate that has not been proven.

**B1 · Spec**
- The spec names every entity, field, type, nullability and default.
- Every endpoint has method, path, request shape, response shape, status codes and auth requirement.
- Every user-visible error has a code and a message.
- Anything undecided is written as a question with an owner, not left silent.

**B2 · Schema and migrations**
- Migration applies to the current baseline and rolls back cleanly.
- Running it twice is a no-op (idempotent) or fails loudly; never half-applies.
- New columns that the old code still reads are nullable or defaulted.
- Foreign keys, uniqueness and the indexes the queries need are present.
- No destructive change without a backfill step and a separate task for it.

**B3 · Services**
- Type-check/lint pass for the whole repo (`npm run typecheck`, `npm run lint`, or the project equivalents).
- Unit tests cover the happy path and at least one failure per public function.
- Transactions wrap multi-write operations; a failure leaves no partial state.
- Errors are typed domain errors, not string throws.
- No N+1 loop over a collection that the API returns.

**B4 · API**
- Request validation rejects unknown and malformed fields before the handler runs.
- Authorization is checked per route, not only per application.
- Status codes match the spec (400 vs 401 vs 403 vs 404 vs 409 vs 422).
- Pagination, sorting and filtering have documented defaults and a maximum page size.
- Contract tests run without a network dependency.

**B5 · Tests**
- The suite is deterministic: fixed clock/seeds, no real network, no order dependency.
- A failing test names the behavior, not the implementation.
- Coverage includes the permission boundaries (who may and may not call it).

**B6 · Integrate**
- A clean checkout can start the service and run one end-to-end request.
- Config is documented and read from the environment; no secret is committed.
- Timeouts, retries and graceful shutdown exist for every outbound call.
- The migration runs from the baseline on a fresh database, not just on the dev one.

---

## 3. Typical task list

One task per row. `S` = spec, `H` = schema, `V` = service, `A` = API, `T` = tests, `I` = integrate.

| Id | Phase | Title | Scope |
|---|---|---|---|
| `S-<feature>-spec` | spec | Specify `<feature>` | `docs/specs/<feature>.md` |
| `H-<feature>-model` | schema | `<feature>` model and migration | `db/migrations/*`, model types |
| `V-<feature>-service` | build | `<feature>` service | `src/services/<feature>.*`, unit tests |
| `A-<feature>-routes` | build | `<feature>` HTTP routes | `src/routes/<feature>.*`, contract tests |
| `T-<feature>-integration` | test | `<feature>` integration suite | `tests/<feature>.*` |
| `I-<feature>-wire` | integrate | Wire `<feature>` into `<consumer>` | the consumer's files only |

Chaining rules:

- The spec has no dependency and blocks everything below it.
- Model before service, service before routes. Optimistic deps: a task may start once its dependency is built (REVIEW), not only when accepted.
- Two tasks that would edit the same file are chained, never dispatched side by side (`lessons.md` 3.4).
- The integration task owns the consumer's files; the feature tasks never touch them.

---

## 4. Proof lines for workers

Every `done` carries the command and its result. Use the project's real scripts; the shapes below are the defaults to adapt at `init`.

| Check | Command shape | Expected |
|---|---|---|
| Type-check | `npm run typecheck` (or `tsc --noEmit`, `mypy`, `cargo check`) | exit 0 |
| Lint | `npm run lint` | exit 0, no new warnings |
| Unit tests | `npm test -- --run <suite>` | exit 0, N passed |
| Migration up/down | `npm run migrate` then `npm run migrate:rollback` on a scratch DB | both exit 0, schema returns to baseline |
| Contract/integration | `npm test -- --run tests/<feature>` | exit 0, no network calls |
| Clean scope | `git status --short` | only claimed files |
| Secrets | `git grep -nE '(password|secret|token|api[_-]?key)\s*='` on claimed files | no new hardcoded values |

Write the verify line as `command -> result`, one per check, including the counts. A cross-repo failure in a file you do not own is reported as `cross-lane break in <file:error>` and does not block; the orchestrator re-runs the full suite before accepting (`lessons.md` 3.5).

---

## 5. Review for this pack

The reviewer checks the spec first, then the diff:

1. Does every item in the spec exist in the code, and nothing extra?
2. Are validation, authz and error codes what the spec says?
3. Are the tests real (they would fail if the behavior were removed), or do they assert the implementation?
4. Any secret, any unrestricted outbound call, any migration that cannot roll back?

Stop rule: after one rework round, FAIL only for a correctness or security bug, or an unrun gate. Style, naming and micro-optimizations go on `BACKLOG:` lines and the verdict is PASS.

---

## 6. What init adds to AGENTS.md

- The phase list and the unit of work per phase.
- The gate table above, reduced to the commands this project actually has.
- The "start here" block: main session is the orchestrator; workers read `PROTOCOL.md` and their brief.
- The decisions file path and the rule that workers report deviations instead of editing it.
- The page-set equivalent: the endpoints/resources this first iteration must deliver.

Replace `{{PROJECT}}` with the workspace name at init. `{{MERGE_TARGET}}` and `{{SITES}}` are unused in this pack.
