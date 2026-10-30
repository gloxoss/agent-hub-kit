# PRD: Fleet hardening

Approved section by section by the owner on 2026-10-30.

## 1. What We're Building
We're upgrading your team of AI helpers so it builds software all day on its own. A "manager" AI plans
the work and checks results; if the manager runs on a cheap model (your Gemini accounts) it may also make
edits, but on costly ones (Claude, Codex) it never writes code. Several "builder" AIs do the coding, each
in its own copy of the project. Your PC and every server can work on the same project side by side, split
by area. When allowances run out, it tells you why they drained (and whether that was normal) so you can
fix it or add accounts. You steer from WhatsApp, talking to all managers at once or one by tag, or from a
live terminal screen.

## 2. The Problem
Today the manager does the building itself and burns your Claude sessions in minutes. When it's busy,
your questions wait. WhatsApp messages repeat, some replies get lost, and the messages are hard to read
(emoji clutter, vague text). When every helper hits its limit the system stalls for hours without telling
you why. Builders share one folder and can break each other's work, and finished work is accepted without
re-running its tests. Other problems will be handled as they come up.

## 3. Who It's For
You: the owner, steering several projects (SchoolOS first, then ParaLoca) from your phone and laptop. You
want short updates with task names, clear yes/no decisions you can answer with numbers, and a full report
file when you ask for one.
The AI helpers themselves: a manager that plans and checks, and 4–5 builders (Codex, Gemini accounts,
OpenCode and others; never Claude) that write the code.
Future you: adding a new server, project or account should feel like one command.

## 4. What It Does
**Must have**
1. Costly managers (Claude, Codex) never write code; a cheap manager (Gemini) may make small edits.
2. The manager wakes only for decisions, your messages and problems.
3. It picks the helper with the most allowance left; your own Claude account last.
4. When allowance runs out: one message explaining why it drained and what you can do.
5. Work accepted only after its tests are re-run and a different helper reviewed it.
6. Quick answers: if the manager is busy, a side helper answers you at once and can keep talking; when the
   manager is free it takes over the conversation, or the side helper finishes your topic and closes.
7. WhatsApp: plain readable messages (numbered tasks, helper names, numbers, no emoji clutter), no repeats,
   replies always arrive, routine updates combined (about 4 per hour).
8. Never silent: replies any time; at night, if nothing runs, it tells you once so you can start new work.
9. Restarts alone after a crash or reboot and continues.

**Should have**
10. Each builder works in its own copy; work is merged after acceptance.
11. Only one database change runs at a time.
12. PC and servers split each project by area and review each other's work.
13. A live dashboard in the terminal.
14. A rewritten, simpler manager program that keeps reports, screenshots, session refresh and quota checks.

## 5. How It Should Feel
Calm and dependable, like a good team lead texting you. Messages read like a short status note: a one-line
headline, a numbered list (task, who is doing it, how long), then numbered questions you answer like
"1 yes 2 no". No decoration, no filler, understandable even if you've been away all day. Long details come
as a file you can open. In the terminal, a live screen shows at a glance: who is working on what,
allowance left per account, what waits for review, and what the manager spent today.

## 6. What It Connects To
- Every AI account you have, kept in one account list the fleet reads: Gemini accounts (Antigravity), extra
  Codex accounts on the proxy (CLIProxyAPI), the Codex plan, OpenCode, Cursor, API keys like DeepSeek, and
  your Claude Code accounts (your own: last-resort manager only; the second one: manager only, never builder).
- Adding a new account or helper is one guided command (log in once, it appears in the list, rotation
  starts using it). Paid ones stay switched off until you turn them on.
- The allowance checker covering all of them.
- GitHub (task board + code), WhatsApp (one group per project, bot number 0854), your servers and PC over
  the private network.

## 7. What It Does NOT Do
- It does not fix SchoolOS's own app problems (dev server crash, screenshot tool bugs); those go on the
  project's own task board.
- It does not upgrade the server to 4 cores now (later).
- It does not top up or pay for any account; it only tells you when to.
- It does not use Claude to build code, ever.
- It does not deploy anything to the public.

## 8. How We'll Know It Works
A 12-hour test run on SchoolOS, compared with today:
- Manager turns: about 4–6 per hour (not dozens).
- Claude: used only when every other helper is down; 0 code edits by a costly manager.
- WhatsApp: no repeated messages; every question answered (side helper replies within about a minute).
- Accepted work: every accept shows its tests re-run and a review by a different helper.
- No crash left unattended: any stop recovers on its own within minutes.
- If allowance ran out, you got one clear message with the reason.

## 9. Costs
Free first: Gemini accounts, your Codex and OpenCode plans. Paid lanes stay off for now. The fleet tracks
how much each helper uses and shows it in reports and the dashboard, without a hard spending cap. The
server stays on Oracle's free tier; its disk is enlarged within the free 200 GB.

## 10. Risks & Concerns
1. Shell tricks: an AI could still try to write code through command-line tricks; the guard watches for
   them, but it isn't perfect.
2. Disk: separate builder copies use space (the app re-downloads its packages per copy); the disk must be
   enlarged and copies cleaned up.
3. WhatsApp ban: too many bot messages could get the 0854 number blocked; messages are combined.
4. Allowance changes: providers change limits without notice; the fleet may misjudge what's left.
5. Two machines can still clash on files outside their declared areas; reviews catch most of it.

## Changes from discovery (owner decisions during PRD review)
- Runs all day (not half a day); asks the owner with the drain reason when quota is exhausted (supersedes A2).
- Cheap-model managers (Gemini pool) may edit; costly ones (Claude, Codex) never (refines A3/A31).
- Untagged WhatsApp messages reach every orchestrator on the project; `@machine` targets one (refines A18–A19: the lead still writes the single combined reply).
- Side responder session for quick answers while the manager is busy (new).
- WhatsApp: plain format, no emoji clutter; replies never suppressed; night = no routine noise, but one "nothing running" notice when idle (refines A50, A53).
- Account registry + one-command onboarding for all accounts (extra Codex on CLIProxyAPI, Cursor, DeepSeek API, second Claude Code account as manager-only) (new).
