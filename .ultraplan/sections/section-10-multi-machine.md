# Section 10: Multi-machine areas and lead

## Overview
Several machines (PC, servers) run one project together: each claims areas of the project, plans and
builds only there, and reviews the other machines' finished work. One lead (held by a lease that fails
over) writes the single combined reply to untagged owner messages and settles cross-area work.

## Risk: [red] - Distributed coordination over GitHub; eventual consistency and rate limits.

## Dependencies
- Depends on: section-06 (driver), section-04 (shared fold)
- Blocks: section-13
- Parallel batch: 3

## TDD Test Stubs
- Test: `board.mjs area claim lango-app/src/features/finance/` succeeds once; a second machine gets "owned by <node>".
- Test: dispatch refuses a task whose scope is inside another machine's area (unless handed over).
- Test: the lead lease moves to another machine within 5 min when the lead stops renewing.
- Test: an untagged owner message gets exactly one reply (from the lead), and every machine logs it.
- Test: a review job is dispatched to another machine's reviewer when one is available.

## Tasks

<task type="auto" id="10-01">
  <name>Area claims on the board</name>
  <files>engine/board.mjs</files>
  <action>
    Add `area claim|release|list <path-prefix>`: one pinned issue per project "[areas]" holding comments
    `CLAIM-AREA node=X area=<prefix>` / `RELEASE-AREA`; first claim wins (same replay rule as task claims); label `area:<slug>`.
    `area list --json` returns `{prefix, node, since}`. Cache 2 min to respect GitHub limits (5,000 req/h, writes 80/min).
  </action>
  <verify>Two simulated node names claim the same prefix: one wins, the other sees the owner; release frees it.</verify>
  <done>Machines can own parts of a project visibly.</done>
</task>

<task type="auto" id="10-02">
  <name>Dispatch respects areas</name>
  <files>engine/dispatch.mjs (run gate next to the board claim hook ~355)</files>
  <action>
    Before dispatch: if any task scope path falls inside an area owned by another node, print
    `not dispatched: <id> is in <node>'s area <prefix>` and leave a board note asking for a handover. Tasks with no area owner
    are free for anyone (current behavior).
  </action>
  <verify>Fixture area list + task scopes → expected dispatch/refusal lines.</verify>
  <done>Machines stay in their own areas unless the owner of an area hands it over.</done>
</task>

<task type="auto" id="10-03">
  <name>Lead lease with compare-and-swap</name>
  <files>engine/orchestrator/lead.mjs (new)</files>
  <action>
    Lease stored as a file `lead.json` on a dedicated ref `refs/heads/fleet-lease` via the GitHub contents API with the current
    `sha` (update fails if someone else changed it): `{node, term, expiresAt}`; TTL 5 min, renew every 90 s; time from GitHub's
    `Date` header; re-read after acquiring; `term` increments on each takeover and is attached to lead-only actions.
  </action>
  <verify>Two simulated nodes racing: exactly one holds the lease; stop renewing → the other takes it after expiry.</verify>
  <done>There is always one lead, and it fails over safely.</done>
</task>

<task type="auto" id="10-04">
  <name>Untagged messages: everyone hears, the lead answers</name>
  <files>engine/orchestrator/events.mjs, engine/orchestrator/lead.mjs</files>
  <action>
    Every machine receives untagged owner messages (section 02). Non-lead machines act within their areas and post a board
    note "re: <msg id>: <what I did>"; only the lead replies on WhatsApp, after collecting notes for up to 60 s, with one combined
    answer. Tagged messages are answered by the tagged machine only.
  </action>
  <verify>Two-node dry harness: one reply sent (lead), both log the message, the reply includes the other node's note.</verify>
  <done>The owner can talk to all machines at once and gets one clear answer.</done>
</task>

<task type="auto" id="10-05">
  <name>Cross-machine review</name>
  <files>engine/autoloop.mjs (reviewer choice ~121–128)</files>
  <action>
    When choosing a reviewer, prefer a reviewer lane on another machine (board note "review request <task>" picked up by that
    machine's autoloop) if one has claimed the "reviews" role in the areas list within the last hour; else local reviewer.
  </action>
  <verify>Dry fixture with two nodes: the build from node A is reviewed by node B's lane.</verify>
  <done>Machines check each other's work.</done>
</task>
