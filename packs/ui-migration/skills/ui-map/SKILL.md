---
name: ui-map
description: Phase 3 of a UI migration workspace, the dedupe gate. Compares each audited source section against the section registry and existing atoms and blocks, and decides REUSE, EXTEND, NEW-VARIANT, NEW-TYPE, or SKIP so the library never duplicates a section. Produces the build plan for a page and gets user confirmation. Use after a page is audited, or when the user says "map this page", "what can we reuse", or "plan the sections".
---

# ui-map

This is the step that enforces "no repetition". Skipping it is how libraries end up with five near-identical heroes.

## Inputs

The page audit doc, the `src/sections/*/index.ts` entry files (if any), the file list of `src/components/ui` and `src/components/blocks`, and previous map decisions in the ledger.

## Decision rules (apply in order, first match wins)

1. **SKIP**: template-only content (style guide, licences, Webflow badges, "buy this template") or something the merge target will never use. Reason required.
2. **REUSE `type:variant`**: an existing variant renders this section with different prop values only. Content length, item count, and colors differ; layout fingerprint matches.
3. **EXTEND `type:variant` +prop**: an existing variant matches except for one optional element (an eyebrow, a second CTA, a badge). The new prop must be optional so existing fixtures keep rendering.
4. **NEW-VARIANT `type:variant`**: same purpose as an existing type, different layout fingerprint (grid, media position, overlap structure).
5. **NEW-TYPE `type:variant`**: a purpose no type covers yet. Pick a generic type name (`logo-strip`, not `<site>-brands`).

Also decide, per section, which repeated units become **blocks** and which **atoms** it needs. An atom or block that appears in two or more sections, or in two or more sites, must be shared. Name new ones in the plan.

## Naming

Type: purpose noun (`hero`, `product-grid`, `testimonials`, `faq`, `cta-banner`, `logo-strip`, `features`, `newsletter`, `story`, `stats`, `gallery`, `header`, `footer`). Variant: layout description (`split-media`, `stacked-center`, `bento-3`, `carousel`). Never a brand or site name.

## Output

1. Fill the map decision and registry key for each section row in the ledger, status `mapped`.
2. Show the user a short plan: one line per section (`source id -> decision`), plus new atoms and blocks. Ask for confirmation once per page. This is the only planned stop in the pipeline.
3. After confirmation, set the build order: atoms and blocks first, then sections in page order.
