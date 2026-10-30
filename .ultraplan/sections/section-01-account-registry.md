# Section 01: Account registry and quota source

## Overview
One list of every AI account the fleet can use (role, family, cost class, on/off), one machine-readable
quota source for all of them, and one command to add a new account. The driver (section 06) and the
dashboard (section 11) read only these.

## Risk: [yellow] - Provider quota APIs differ and change; the CLIProxyAPI management calls must be mapped carefully.

## Dependencies
- Depends on: none
- Blocks: section-06, section-11
- Parallel batch: 1

## TDD Test Stubs
- Test: `accounts.mjs list --json` returns every entry with id, family, roles, cost, enabled.
- Test: an entry with `"cost": "paid", "enabled": false` is excluded from `accounts.mjs pick`.
- Test: `quota.mjs --json` returns numeric `remaining` (0–1) and ISO `resetAt` (or null) per entry.
- Test: `accounts.mjs pick --role orchestrator` orders by remaining quota, own Claude account last.
- Test: `devbox lanes add` writes a new disabled entry and prints the next login step.

## Tasks

<task type="auto" id="01-01">
  <name>Define the accounts registry file and loader</name>
  <files>engine/accounts.mjs, engine/accounts.example.json</files>
  <action>
    Create `engine/accounts.mjs` (ESM, no deps) exporting `loadAccounts(hubDir)` that reads `<hub>/accounts.json`
    (fallback `~/.config/agent-hub/accounts.json`). Entry schema: `{ id, command, model?, family: "claude"|"codex"|"opencode"|"cursor"|"api",
    roles: ["orchestrator"|"builder"|"reviewer"|"responder"], cost: "free"|"plan"|"paid", owner: "fleet"|"user",
    enabled, quotaKey }`. Validate with a small hand-written check (throw with the entry id on errors).
    Add `engine/accounts.example.json` with: 15-account Gemini pool via `claude-ag2@gemini-3-flash` (free; roles orchestrator, builder, reviewer, responder),
    `codex` (plan, orchestrator+builder+reviewer), each extra CLIProxyAPI Codex account (plan), `opencode@opencode-go/glm-5.3-flash`
    (plan, builder+reviewer), `cursor` (plan, builder), `claude-ds1..3` (paid, disabled), `claude-or` (paid, disabled),
    `claude-glm` (paid, disabled), user's own Claude `claude-sonnet` (owner "user", orchestrator only), second Claude account
    (owner "fleet", roles orchestrator+responder only, never builder).
  </action>
  <verify>`node -e "import('./engine/accounts.mjs').then(m=>console.log(m.loadAccounts('engine').length))"` prints the entry count; a malformed entry throws with its id.</verify>
  <done>The fleet has one validated account list with roles, cost class and on/off per account.</done>
</task>

<task type="auto" id="01-02">
  <name>Make quota.mjs output structured numbers</name>
  <files>engine/quota.mjs</files>
  <action>
    Extend `--json` output: each row keeps `provider, account, flag, detail` and adds `remaining` (0–1 number, lowest
    window that applies), `resetAt` (ISO string or null), `models` (map model → {remaining, resetAt}) when the provider
    reports per model (Antigravity). Parse the numbers from the existing upstream responses instead of the text detail.
    Add `--entry <accounts.json id>` to query only the accounts behind one registry entry. Keep text output unchanged.
  </action>
  <verify>`node engine/quota.mjs --json | node -e "…every row has typeof remaining==='number' or null"`; run on the server where CLIProxyAPI runs.</verify>
  <done>Quota is machine readable per account and model, with reset times.</done>
</task>

<task type="auto" id="01-03">
  <name>Quota-ranked picker with role and cost rules</name>
  <files>engine/accounts.mjs</files>
  <action>
    Add `pick({ role, exclude=[], hubDir })`: enabled entries with that role, quota from `quota.mjs --json` cached 2 min in
    `<hub>/runs/quota-cache.json`, sorted by remaining desc; entries with remaining < 0.05 or a future resetAt go last;
    `owner: "user"` Claude always last and only if every other is down; prefer the healthy free Gemini manager, then Codex, as
    the tie-break order. `cost: "paid"` only when enabled. Return the ordered
    list with the reason per entry (`"remaining 0.62"`, `"down until 14:10"`). CLI: `node engine/accounts.mjs pick --role orchestrator --json`.
  </action>
  <verify>With a fake quota cache file (fixture), `pick --role orchestrator` returns the expected order (fixture test printed by the command).</verify>
  <done>Any component can ask "who should go next for role X" and get a ranked, explained list.</done>
</task>

<task type="auto" id="01-04">
  <name>Drain explainer for the out-of-quota message</name>
  <files>engine/accounts.mjs</files>
  <action>
    Add `explainDrain(hubDir, hours=6)`: from `<hub>/runs/jobs.jsonl` and the orchestrator ledger (`<hub>/runs/orch-ledger.jsonl`,
    written by section 06), summarize per account: jobs/turns in the window, tokens if known, and whether usage looks normal
    (≤ the account's 7-day hourly average × 2) or abnormal (name the top task or lane). Return plain lines for WhatsApp:
    "codex: 14 turns in 3 h (normal)", "gemini pool: 41 jobs, P-finance retried 9 times (abnormal)".
  </action>
  <verify>Run against a fixture jobs.jsonl and ledger; output names the retried task as abnormal.</verify>
  <done>The fleet can say why allowance drained and whether it was reasonable.</done>
</task>

<task type="auto" id="01-05">
  <name>One command to add an account</name>
  <files>devbox: bin/devbox (new `lanes` subcommand)</files>
  <action>
    Add `devbox lanes list|add|enable|disable <id>`. `add` asks family (codex-proxy / opencode / cursor / api-key / claude-profile),
    writes a disabled entry to `~/.config/agent-hub/accounts.json`, prints the single login step for that family
    (CLIProxyAPI login URL, `cursor-agent login`, `devbox secrets edit` for an API key, `claude setup-token` for a Claude profile),
    then `enable` runs a one-prompt ping and turns it on only if it answers. Treat provider errors such as `Free usage limit
    reached` as quota exhaustion: do not retry the same model in a loop; cool it down and fall back to the next enabled entry.
    `list` prints id, roles, cost, enabled, remaining.
    Add `.config/agent-hub/accounts.json` to the vault capture list (`AGENT_EXTRA`).
  </action>
  <verify>`devbox lanes add` (family api-key, fake id) then `devbox lanes list` shows it disabled; `devbox lanes enable` on a dead key refuses.</verify>
  <done>Adding an account is one guided command and travels to every machine through the vault.</done>
</task>

<task type="auto" id="01-06">
  <name>Builders and reviewers picked by remaining allowance</name>
  <files>engine/autoloop.mjs (pickBuilder / nextHealthy / reviewer choice), engine/dispatch.mjs (executor resolution only)</files>
  <action>
    Replace "try the fallback list until one fails" with `accounts.pick({role: "builder"|"reviewer", exclude})`: the autoloop asks
    for the ranked list before each build/review dispatch and takes the first entry that also has a free lane and is not the
    task's builder (for reviews). Resolve lanes from configured `lanes` first, then the actual project tsconfig location; if
    neither yields IDs, use the documented `builder-1` through `builder-6` fallback. Never silently return an empty lane set.
    Keep the existing cooldown on real failures. Executors without a registry entry keep today's
    fallback order (backward compatible).
  </action>
  <verify>Fixture quota cache where the first fallback lane is at 2% → the autoloop dry run dispatches to the lane with the most remaining.</verify>
  <done>Every job, not just the manager, goes to the account with the most allowance left.</done>
</task>
