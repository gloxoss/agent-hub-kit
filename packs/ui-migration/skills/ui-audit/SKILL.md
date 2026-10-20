---
name: ui-audit
description: Phase 2 of a UI migration workspace. Compresses one localized source page into a structured audit doc (sections, layout, content shape, tokens, Webflow IX2 motion, assets) so later phases never re-read the raw HTML. Delegates the heavy reading to the ui-source-auditor agent. Use when a page row is todo and its site is localized, or when the user says "audit <site> home" or "analyze this page".
---

# ui-audit

## Why an agent does the reading

A Webflow page plus its CSS is often 150 KB or more. Reading it in the main thread crowds out everything else. The `ui-source-auditor` agent reads it in its own context and returns only the audit doc.

## Steps (orchestrator side)

1. Create task `A-<site>-<page>` with dep `L-<site>` and scope `docs/audits/<site>`.
2. The brief gives: site id, page id, localized page path (from `sources.json`), output path `docs/audits/<site>/<page>.md`, and the template path `packs/ui-migration/docs/audit-template.md` (installed copy: `.claude/skills/ui-audit/references/audit-template.md` when the installer copies it there).
3. For the first page of each site, the brief also asks for the **site token sheet** at `docs/audits/<site>/_tokens.md` (colors with suggested contract token, fonts and weights, type scale, radius, shadows, spacing, container widths, breakpoints).
4. Dispatch `ui-source-auditor`. When it reports, read the audit doc (not the HTML) and check it against the gate below. Reject with the specific gap if it fails.
5. After accept, add one ledger row per section found, status `audited`, map decision empty.

## Gate

1. Every top-level section of the page body appears, in DOM order, with a stable id (`<site>/<page>#<slug>`).
2. Each section has: layout summary, content shape (fields and list lengths), interactive behavior, motion entries, assets, and a layout fingerprint.
3. Motion entries come from the decoded IX2 data, not guesses. Any animation the agent could not decode is listed as `UNDECODED` with the element.
4. Navbar and footer are audited once per site (first page), later pages reference them.

## Close

Ledger page row to `audited`. Next phase: `ui-map`.
