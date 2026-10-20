# Page loop: audit and reshape page by page

Audit and rework pages systematically with scoped tasks and evidence-backed reports.

## The loop
1. **Pick a page.** Note URL/route and focus areas.
2. **Make the task:** `node {{HUB_DIR}}/tools/page-task.mjs <route>`
3. **Audit (Phase A):** Inspect the page, verify data sources, write report.
4. **Rework (Phase B):** Apply design system and fixes within scope.
5. **Proof (Phase C):** Run validation commands.
6. **Accept:** Verify report and diff, update ledger.

## Rules
- Real data only: never invent mock options or unverified statistics.
- No overclaiming: quote real command output.
- Keep scope tight: report out-of-scope issues rather than widening without review.
