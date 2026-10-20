# Remaining work — {{PROJECT}}

Written at pause. The next session starts from this file alone. Rule: every item names the file, plan or verify report that holds the detail; do not restate it here.

## State at pause

<!-- Two lines: last accepted task, what is queued, what is half-done. -->

- Last accepted: `<TASK>` on `<date>`
- Queued for the autoloop: `<n>` tasks (`{{HUB_DIR}}/autoloop-queue.json`)
- Half-done: `<path or none>`

## Remaining work

### <Area 1>

1. <What remains>. Detail: `<path>`.
2. <What remains>. Detail: `<path>`.

### <Area 2>

1. <What remains>. Detail: `<path>`.

## Cross-cutting

1. <Repo hygiene, ledger freshness, dependency upgrades, open questions for the user.>

## Suggested order next session

1. <Biggest visible gap or blocking item first.>
2. <Next.>
3. <Last.>

## Fast start

1. Check quota: `node {{HUB_DIR}}/quota.mjs`
2. Check executors: `node {{HUB_DIR}}/dispatch.mjs ping all`
3. Join: `node {{HUB_DIR}}/hub.mjs join --agent orchestrator --role orchestrator --tool claude`
4. Start the autoloop under a Monitor: `node {{HUB_DIR}}/autoloop.mjs`
5. <First task to dispatch or accept.>

## For the user

<!-- What waits on a human decision, and what is paused on purpose. -->
