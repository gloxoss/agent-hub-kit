# UltraPlan Discovery

## Project Idea
Fleet hardening: make the multi-agent fleet (orchestrator driver, hub, WhatsApp bridge, server
runtime) stop draining quota and work reliably for hours, across SchoolOS (lango) and ParaLoca.

## Codebase Context
Existing code in three repos:
- `agent-hub-kit` (this repo): the orchestration engine. Node ESM scripts: `engine/hub.mjs` (event-log
  task state), `dispatch.mjs` (runs worker CLIs per lane), `autoloop.mjs` (dispatch → review → accept),
  `accept.mjs`, `board.mjs` (GitHub issues board), `sync.mjs` (brain branch + code sync),
  `tools/orch-driver.mjs` (~1,100 lines, any-agent orchestrator with failover), `ORCHESTRATOR.md`.
  Installed as the `agent-hub-orchestrator` skill; servers pull it from GitHub on `devbox update`.
- `gloxoss/devbox`: server kit (bash). `services/whatsapp/wa.mjs` (WAHA bridge, one group per project),
  `devbox orch …` commands, vault, proxies (Antigravity :8080, CLIProxyAPI :8317).
- `lango-english-center-project-fully` (SchoolOS): Next.js 16 app in `lango-app/`, hub in `.agent-hub-orch/`,
  dev servers on ports 3401/3402 started by hand with nohup.

Audit facts (measured 2026-10-30) are in `docs/plans/FLEET-HARDENING-PLAN.md` §1 (F1–F13).

## Discovery Q&A

<!-- Categories: 9 total -->

### Category 1: Core Requirements

**Q1:** What matters most for the first version?
**A1:** Stop the quota drain (orchestrator stops coding and burning Claude sessions; workers build).

**Q2:** How long should the fleet run alone before needing the user?
**A2:** Half a day (4–8 hours), pinging only for decisions.

**Q3:** When the orchestrator wants to change code itself?
**A3:** Never. Even a one-line fix becomes a worker task.

**Q4:** Pilot project?
**A4:** SchoolOS / lango first.

**Q5:** Must-fix before "done"?
**A5:** Quota drain; WhatsApp noise / missed replies; stalls and crashes. (Unpushed work NOT selected as must-fix.)

**Q6:** Bigger changes in this plan?
**A6:** All three: separate folder (worktree) per worker; simpler driver rewrite; database migration lock.

**Q7:** Fix SchoolOS app problems too (dev server crash, screenshot tool)?
**A7:** No, fleet only. App issues go to the project's own task board.

### Category 2: Users & Context

**Q8:** Who carries out the plan?
**A8:** Several agents in parallel (orchestrated; I review as orchestrator).

**Q9:** Which agent executes?
**A9:** First answered "Claude Sonnet", then corrected: **NO Claude for execution at all.** Executors are non-Claude lanes (Codex, Antigravity/Gemini, OpenCode, etc.).

**Q10:** Where does the user watch/steer from?
**A10:** Both equally: WhatsApp on phone and laptop terminal / VS Code.

**Q11:** Message style?
**A11:** Short, with task IDs, plus a clear explanation; a detailed full report available when needed.

**Q12:** How many executors at once?
**A12:** 4–5 in parallel.

**Q13:** Where does the detailed report live?
**A13:** A doc file sent on WhatsApp (short message + full report file).

### Category 3: Integration Points

**Q14:** Default orchestrator agent?
**A14:** Rotate automatically: whoever has the most quota left goes first (never codes).

**Q15:** Claude in the orchestrator order?
**A15:** Last resort only, with a small hourly cap.

**Q16:** How does the fleet learn remaining quota?
**A16:** Ask the proxies before choosing (quota check before each dispatch / orchestrator turn; skip lanes near empty).

**Q17:** Other machines in scope?
**A17:** Server AND PC together from the start.

**Q18:** Who plans when PC and server share a project?
**A18:** User was unsure, asked for advice: separate orchestrators that agree "I work on this part, don't touch it", take turns planning, help and review each other, regardless of how many servers. Recommendation offered and accepted (Q19).

**Q19:** How several orchestrators share one project?
**A19:** Split by area + cross-review. Each machine claims areas on the GitHub board, plans/builds only there, and reviews the OTHER machine's finished work. One lead only for cross-area decisions and untagged user messages; lead fails over to the next machine.

**Q20:** One machine wants an area another owns?
**A20:** Note on the board issue; the owner decides (hands over or does it).

**Q21:** GitHub board?
**A21:** Keep it (issues per task).

**Q22:** WhatsApp groups?
**A22:** One group per project (tags pick the machine).

### Category 4: Edge Cases

**Q23:** Every agent out of quota at once?
**A23:** Pause, send one message with the earliest retry time, resume alone.

**Q24:** A worker breaks the build / a passing test?
**A24:** Reject + rework automatically on a different lane; user hears only after 2 failures.

**Q25:** Server reboot or orchestrator crash mid-task?
**A25:** Restart alone and resume; half-done tasks re-checked and continued.

**Q26:** Agent claims tests passed but they didn't?
**A26:** Acceptance re-runs the stated check commands itself; claims alone never count.

**Q27:** Two workers need the same file at once?
**A27:** Both work (each in its own folder), merge later; conflicts fixed at merge time.

**Q28:** User messages while the orchestrator is busy?
**A28:** Instant "got it", real answer when the current step ends safely (no hard interrupt).

**Q29:** A worker runs far longer than normal?
**A29:** Stop after 2x its normal time; re-queue to another lane with a note.

### Category 5: Quality Attributes

**Q30:** Orchestrator budget per hour?
**A30:** About 4–6 short turns/hour; wakes for decisions, user messages, problems.

**Q31:** "Never codes" guard strictness?
**A31:** Block + stop the turn: edit tools removed; a code-writing shell command ends the turn and is logged.

**Q32:** Acceptance bar?
**A32:** Stated checks re-run by acceptance + review by a different agent.

**Q33:** Server safety margin?
**A33:** Pause new work below 2 GB free RAM or 5 GB free disk; running work finishes.

**Q34:** Secrets?
**A34:** Only through approved commands: agents may run tools that use keys, never read keys/.env directly.

**Q35:** Proof the fixes worked?
**A35:** A 12-hour test run with numbers (turns/hour, Claude usage, messages sent, tasks accepted, crashes) compared to today.

**Q36:** Log retention?
**A36:** Keep 7 days, compress older (disk is at 66%).

### Category 6: Existing Patterns

**Q37:** What should the driver rewrite keep from the other agent's additions?
**A37:** All four: 15-minute progress report (only when something changed); screenshots on request; session rotation; live quota check in /orch status. (Smart regex message detection NOT selected.)

**Q38:** SchoolOS's three hub folders (.hub, .agent-hub, .agent-hub-orch)?
**A38:** Merge into `.hub` (the standard kit name); move the live state there.

**Q39:** Project-specific tweaks (task templates, skill rules)?
**A39:** Move the good ones into the kit so every project gets them.

### Category 7: Preferences & Tradeoffs

**Q40:** Rewrite vs patch the driver first?
**A40:** Rewrite straight away (no interim patch round).

**Q41:** Rollout speed vs safety on the live SchoolOS fleet?
**A41:** Straight to live with quick rollback (keep the previous version ready to restore).

**Q42:** Simplicity vs features?
**A42:** Keep features, document them well.

**Q43:** Worker folders vs disk (66% used)?
**A43:** Both: grow the Oracle boot volume AND use lightweight worktrees cleaned up after each task.

### Category 8: Cost & Budget (replaces "Monetization": internal tool, not sold)

**Q44:** Paid accounts OK to top up?
**A44:** Selected all of DeepSeek, OpenRouter, GLM AND "free only". Clarified (Q45).

**Q45:** Which was meant?
**A45:** **Free lanes only for now.** Paid lanes (DeepSeek, OpenRouter/claude-or, GLM) stay off until the user tops them up later; the plan must make them easy to switch on.

**Q46:** Track spending per lane / daily cap?
**A46:** Track only, no cap (report in the daily/periodic summary).

**Q47:** Upgrade Oracle server to 4 cores / 24 GB?
**A47:** Later (not in this plan). Disk growth from Q43 still applies.

### Category 9: Visual & UX Vision

**Q48:** Normal WhatsApp progress update?
**A48:** Headline + 3 bullets + what the user must decide (e.g. "✅ 2 accepted · 3 running", task IDs, "Decide: X? yes/no").

**Q49:** Decision questions?
**A49:** Numbered, answered with numbers ("1 yes 2 no").

**Q50:** Report when nothing is new?
**A50:** Once an hour (heartbeat) instead of every 15 minutes; 15-min report only when something changed.

**Q51:** Terminal view (`devbox orch attach`)?
**A51:** Live dashboard view (refreshing panel).

**Q52:** Dashboard must show?
**A52:** All four: running workers + task + minutes; quota per account (color coded); review & accept queue + last accepts; orchestrator turns, agent on duty, tokens/cost today.

**Q53:** Night quiet hours?
**A53:** Yes, quiet 23:00–08:00: only real problems or decisions at night.

## Discovery Summary
- Total questions asked: 53
- Categories fully covered: 1 Core, 2 Users & Context, 3 Integration, 4 Edge Cases, 5 Quality, 6 Existing Patterns, 7 Tradeoffs, 8 Cost & Budget (adapted from Monetization), 9 UX
- Categories partially covered: none
- Categories skipped: none
- Key themes identified:
  - Orchestrator never codes; enforced by tool removal + shell-write guard; 4–6 turns/hour
  - Claude is reserved for the user: never an executor, last-resort orchestrator only, hourly cap
  - Quota-aware rotation across free lanes (paid lanes off for now, easy to enable)
  - Rewrite the driver now (keep: 15-min/hourly report, screenshots, rotation, quota status), live rollout with quick rollback
  - Multi-machine: split by area + cross-review, lead only for cross-area/untagged; PC and server both in scope
  - Isolation: one worktree per worker, merge later; migration lock; acceptance re-runs checks + different-agent review
  - Ops: pause below 2 GB RAM / 5 GB disk, 7-day logs, crash-resume, 2x-time worker cutoff, grow disk
  - UX: short WhatsApp updates with numbered decisions, hourly heartbeat, quiet 23–08, doc-file full reports, live terminal dashboard
  - Merge SchoolOS hub folders into `.hub`; promote good project rules into the kit
