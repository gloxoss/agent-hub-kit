# Section 02: WhatsApp messaging v2

## Overview
Readable plain messages, no lost replies, no repeats, a safe send budget, numbered decisions, untagged
messages to every orchestrator on the project, and full reports as files.

## Risk: [yellow] - Ban risk if the budget logic is wrong; replies must never be throttled.

## Dependencies
- Depends on: none
- Blocks: section-06, section-09
- Parallel batch: 1

## TDD Test Stubs
- Test: two identical `wa send --reply-to <id>` both deliver.
- Test: the 5th `--auto` message in an hour is merged into a digest, not sent.
- Test: `formatStatus()` output has no emoji and fits the template.
- Test: "1 yes 2 no" parses to `[{n:1,answer:"yes"},{n:2,answer:"no"}]`.
- Test: an untagged message is printed by `wa inbox` on every machine of the project.

## Tasks

<task type="auto" id="02-01">
  <name>Split send paths: reply vs automatic</name>
  <files>devbox: services/whatsapp/wa.mjs</files>
  <action>
    Add `--auto` and `--reply-to <messageId>` to `send|image|file`. Replies (`--reply-to` or no `--auto`) bypass every
    filter and cache and use WAHA `reply_to`. Only `--auto` messages go through the anti-spam regex and the duplicate cache.
    Remove the current 10-minute cache from the reply path. Keep backward compatibility: plain `send` = reply path. If WAHA is unreachable or returns 5xx, spool the message to
    `~/.config/waha/outbox/` and retry with backoff (1, 2, 5, 10 min) from `wa flush` / the next send; replies keep their order.
  </action>
  <verify>Send the same text twice without `--auto`: both appear in the group (check `/api/{session}/chats/{id}/messages`); twice with `--auto`: one.</verify>
  <done>A reply to the owner can never be dropped.</done>
</task>

<task type="auto" id="02-02">
  <name>Automatic message budget and merging</name>
  <files>devbox: services/whatsapp/wa.mjs</files>
  <action>
    For `--auto` sends keep `~/.config/waha/budget-<project>.json`: max 4 automatic messages per rolling hour per group
    (config `WA_AUTO_PER_HOUR`). Over budget: append the text to a pending digest file; the next allowed automatic send
    (or `wa flush`) sends "N updates since HH:MM" with the merged lines (deduplicated). Add 30–60 s random delay between
    consecutive automatic sends and the WAHA seen/typing calls before sending (anti-ban guidance in RESEARCH.md).
  </action>
  <verify>Fire 7 `--auto` sends in a loop: 4 delivered, then `wa flush` delivers one merged message containing the other 3.</verify>
  <done>Automatic traffic stays within WhatsApp's safe volume without losing information.</done>
</task>

<task type="auto" id="02-03">
  <name>Plain message templates</name>
  <files>devbox: services/whatsapp/format.mjs (new), services/whatsapp/wa.mjs</files>
  <action>
    New `format.mjs` exporting `status({headline, items:[{id,task,who,minutes,state}], decisions:[text]})`, `alert({what, why, action})`,
    `report({title, lines})`. Output: header line `PROJECT · machine` (plain, no emoji), headline, numbered items
    "1. P-finance-receipts | codex | 12 min | building", then "Decide:" with numbered questions ending "Reply: 1 yes 2 no".
    `wa send --format status --json <file>` renders from JSON. Strip emoji from automatic messages.
  </action>
  <verify>Render a fixture; output matches the expected text exactly (snapshot printed by a small check script).</verify>
  <done>Every automatic message has one readable, numbered shape.</done>
</task>

<task type="auto" id="02-04">
  <name>Numbered answers and addressing</name>
  <files>devbox: services/whatsapp/wa.mjs</files>
  <action>
    In `inbox`, parse "1 yes 2 no" / "1y 2n" / "1: yes" into structured answers and print
    `WHATSAPP hh:mm [id=<msgId>] answers=1:yes,2:no text=…`. Addressing: untagged → printed on EVERY machine of the project
    (remove the lead filter here); `@machine`/`@all` as today. Include the message id so replies can use `--reply-to`.
  </action>
  <verify>Feed fixture messages through the parser function; untagged prints on two simulated machine names.</verify>
  <done>Orchestrators get structured answers and every machine hears untagged messages.</done>
</task>

<task type="auto" id="02-05">
  <name>Full report as a file</name>
  <files>devbox: services/whatsapp/wa.mjs</files>
  <action>
    `wa report <markdown-file> "short headline"`: sends the headline as a reply-path message and the file as a document
    (sendFile, `.md` as text/markdown; if over 1 MB, gzip is NOT used: split into parts). Used by orchestrators when the
    owner asks for details.
  </action>
  <verify>Send a 3 KB fixture report; the group shows the headline and an openable document.</verify>
  <done>Detailed reports reach the phone as one readable file.</done>
</task>
