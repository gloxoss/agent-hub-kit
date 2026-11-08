# ui-migration pack

Turns Webflow ecommerce templates into one unified Next.js section library (atoms, blocks, sections, pages) driven by CMS-shaped data, then hands that library to the merge target. It builds the look, never the store.

This pack is installed by `init.mjs --pack ui-migration --name {{PROJECT}}`. It adds five skills, four agents, and the system docs listed at the end of this file.

## Placeholders

| Placeholder | Filled by init with |
|---|---|
| `{{PROJECT}}` | the workspace name |
| `{{MERGE_TARGET}}` | the app or repository the library merges into, or `none` when the workspace is standalone |
| `{{SITES}}` | the source sites from `docs/migration/sources.json` |

## Pipeline

One unit of work at a time. State lives on disk: hub events and `CHANGELOG.md` for work, `LEDGER.md` for source inventory, `DECISIONS.md` for deviations, `HANDOFF.md` for the orchestrator's session memory.

| Phase | Unit of work | Task id | Agent | Gate |
|---|---|---|---|---|
| localize | a site | `L-<site>` | `ui-site-localizer` | offline gate: no request leaves localhost except listed leftovers; raw folder unchanged |
| audit | a page | `A-<site>-<page>` | `ui-source-auditor` | every body section in DOM order, decoded motion, token sheet on the first page |
| map | a page | `M-<site>-<page>` | orchestrator plus user | every section has REUSE, EXTEND, NEW-VARIANT, NEW-TYPE, or SKIP; user confirms |
| scaffold | workspace | `S-app` | `ui-section-builder` | app builds once before the first section |
| tokens | a site | `T-<site>` | `ui-section-builder` | audit palette mapped onto the 19 contract tokens and the `[data-theme]` preset |
| build | a section | `B-<type>-<variant>` | `ui-section-builder` | G1 to G9; builder self-proof |
| assemble | a page | `P-<site>-<page>` | `ui-section-builder` | page renders from registry blocks, G1 to G9 |
| parity | a template | `V-<site>-parity` | `ui-parity-verifier` | V1 to V7, screenshots, REPORT.md |
| register | after accept | orchestrator | ledger row, changelog, commit | scope and diff audit |

Rules that hold across every phase:

1. **Raw sources are read-only.** Localization writes to `localized/<site>/` only.
2. **Rebuild, never paste.** Webflow HTML and CSS are visual reference. No `.w-*` classes, no `data-w-id`, no Webflow CSS or JS in `src/`.
3. **No repetition.** Before creating any atom, block, or section variant, search the registry and `src/components`. The map phase records the decision for every source section.
4. **No hardcoding.** Section copy, images, and links arrive as props from page documents. UI microcopy comes from `src/content/ui-strings/<namespace>.ts`. JSX text literals in `src/sections` and `src/components/blocks` are a lint error.
5. **CMS-shaped props.** Section props are plain serializable JSON. No ReactNode, no functions, no product objects; product sections take a query or slugs and resolve through `getEngine()`.
6. **Variants are named by layout, not by source brand.** `hero/split-media`, never `hero/<site>`. Provenance goes in the registry `sources` field.
7. **Tokens only.** Raw colors exist only in `src/app/globals.css` (the 19 contract tokens, plus per-brand `[data-theme]` presets). No hex, no palette utilities, no inline color styles.
8. **Server first.** Pages and sections are Server Components. `'use client'` only in leaf islands (`*-client.tsx`) for GSAP, state, or browser APIs.
9. **Motion ports what the source does.** GSAP via `useGSAP` with a scoped ref, transform and opacity only, `prefers-reduced-motion` respected. Invent nothing, drop nothing silently: unported motion is logged in the audit doc.
10. **RTL-ready.** Logical utilities (`ms-`, `pe-`, `text-start`), directional icons get `rtl:rotate-180`.
11. **Dependencies.** Next 16 App Router, React 19, TS strict, Tailwind v4, Zustand (cart only), GSAP + `@gsap/react`, lucide-react. Anything else needs user approval first.
12. **Next 16 differs from training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code.
13. **No network at runtime.** No `fetch()` outside `src/lib/engine.ts` and `src/content/adapter.ts`, both mocks.
14. **Independent from the original.** `src/` never imports, fetches, or links anything under `*.webflow.io/`, `localized/`, or `docs/`. Every asset a page needs is copied into `public/media/<site>/` with a kebab-case name.

## Page set per template (the deliverable)

Each source template becomes a complete storefront built only from the shared library, so it can be reshaped into the merge target.

| Page | Route | Source |
|---|---|---|
| Home | `(shop)/page.tsx` | audited source page |
| Shop / catalog | `(shop)/catalog`, `catalog/[categorySlug]` | source shop/category page |
| Product | `(shop)/product/[slug]` | source product page |
| About | `(shop)/about` | source about page |
| Contact | `(shop)/contact` | source contact page |
| Search | `(shop)/search` | derived: built from the template's blocks and tokens |
| Cart | `(shop)/cart` plus cart drawer | derived (Webflow cart is not portable) |
| Checkout | `(checkout)/checkout` plus success | derived: contract three-step flow, mock actions |

"Derived" pages have no source page: they reuse the template's atoms, blocks, and tokens and follow the contract's commerce flow, never invent a new visual language. Pages are `PageDoc`s of registry sections where possible; commerce pages (cart, checkout, search results) are feature UI under `src/features/<feature>/ui` fed by the mock engine. A template is done when every row above renders from the library with fixture content, mobile to desktop, and passes the one visual parity pass against its source pages.

Route prefixes (D-014): one template owns the root (`/`); every other template gets the same full route set under its own prefix (`/<template>/...`) with a layout that sets its `data-theme`. A single base-path helper resolves internal links, so a page renders correctly under any prefix and the merge target can relocate a template without editing sections. Shared commerce UI is themed by that wrapper; per-template commerce *presentation* is D-015. Tests or screens can catch hardcoded `href="/..."` quickly; that is the symptom of a missing helper call.

## Defaults worth keeping

The full set of deviations from the merge contract, kept as defaults. Each one exists because ignoring it cost time or produced a wrong result.

| # | Default | Why (one line) |
|---|---|---|
| D-001 | Sections live in `src/sections/<type>/`, not `features/<feature>/ui` | Feature folders tie a section to one page; the registry maps 1:1 to theme `templates` entries. Functional commerce UI (cart drawer, checkout, account) still uses `features/<feature>/ui`. |
| D-002 | Microcopy goes in `src/content/ui-strings/<namespace>.ts`, stricter than the contract | The contract allows inline microcopy; CMS readiness and no-hardcoding need one source. Applies to sections, blocks, and feature UI. |
| D-003 | Port source loops, invent none | A loop is ported only if the source has it, it pauses offscreen, and it is disabled under `prefers-reduced-motion`. Invented ambient loops break parity and cost review time. |
| D-004 | Per-brand theme presets via `[data-theme]` in `globals.css` | One section can be checked against its source look and the merge target without code changes, and raw colors stay in one file. |
| D-005 | Parallel-safe layout: generated registries, per-namespace strings, per-agent build dirs | A single hot file (registry, one strings file, one `.next` folder) serializes builders or corrupts builds. Each lane uses `NEXT_DIST_DIR=.next-<agent>` and its own port. |
| D-006 | Next config: `agentRules: false`, no `cacheComponents` / `partialPrefetching` | `agentRules` rewrites agent instruction files on `next dev`; the merge target does not use the other two, and matching it keeps the merge mechanical. |
| D-007 | Approved dev dependencies: `@tailwindcss/postcss`, `eslint-plugin-react` | Tailwind v4 needs an integration package, and the ESLint config imports the React plugin directly. Any other new dependency still needs approval. |
| D-008 | Parallel builder lanes, each with its own port and build dir | Lane count follows workload; disjoint ports and build folders are what keep lanes from blocking or corrupting each other. |
| D-009 | Optimistic deps, tiered verification, external verifier | A dependency counts as met once built (REVIEW or later); small blocks are accepted on builder proof plus a spot-check. `--strict on` restores wait-for-accept. D-010 supersedes its verifier point. |
| D-010 | Builders build, the orchestrator reviews | Builders prove build, lint, gen-registry, G3 to G9, and a clean `git status`, and never run a browser. The orchestrator reviews code, runs the static gates, and accepts or sends back a fix list. Visual parity runs once on the assembled page. This is the default proof model of the pack. |
| D-011 | Endless marquees use a CSS keyframe island, not a GSAP timeline | Reveal cannot express an endless loop; a keyframe on a doubled track travels one item width in the audited duration, pauses offscreen, and is static under reduced motion. Scope: announcement marquees only. |
| D-012 | One price per product, from the engine | A template can show two prices for one product across pages; fixtures copy neither. Every page reads one `Money` per product from the mock engine; real prices come from the commerce provider at merge. |
| D-013 | Optional display-only compare-at price | Some sources show a line-through list price. `compareAtPrice` is display-only; cart, checkout and totals use `price`. Flag it at merge so the merge target's `Product` type carries the same optional field or the UI hides the branch. |
| D-014 | Each template is a faithful storefront of its own | Snapping source values to shared tokens (radius, spacing, container width, star color) short of parity. Exact source values live as tokens in that template's `[data-theme]` block; no component hardcodes them. Every template gets the full route set under its own prefix, and every link goes through one base-path helper. |
| D-016 | Acceptance is per section and measured | Supersedes D-010 for build tasks. A section is accepted only with pixel score under 8% average and 15% differing at 1440, 1024 and 390, box within 2%, and `motion-compare` passing per animation (skill `ui-parity-loop`). Page height or a clean build proves nothing (failed run, Nov 2026). |
| D-017 | One task, one root, one scope per section | The section root carries `id` and `data-section="<site>-<section>"`; data, styles and hook files are per section; a file another file imports is never deleted before its replacement exists. |
| D-015 | Commerce pages follow each template's own style | Reusing one template's cart, checkout, search and catalog under another theme is visible and wrong. Logic stays shared; presentation becomes layout-named variants chosen per template route config. Where the original has the page, rebuild it faithfully (D-014); where it does not, derive it from that template's own blocks and tokens. |

## Visual parity capture (the only browser task)

`V-<site>-parity`, owned by `ui-parity-verifier`, runs once per template after every page assembles. It is the only task in this pipeline allowed to start a browser or dev server.

1. Run `docs/system/GATES.md` V1 to V7 against the assembled pages, plus G1 to G11.
2. For each page and each section id, capture the source side (`localized/<site>/`) and the built side (`/sources/<site>/<page>#<id>`) at 375, 768, and 1280 px.
3. Name each shot `<gate>-<width>-<side>.png` (`side` = `source` or `build`) and store it in `docs/verify/<site>/<page>/<section-id>/`.
4. Write `REPORT.md` in the same folder: verdict, a gate table with PASS, FAIL, or N/A and evidence, a screenshot index per section, and a numbered fix list (file, what is wrong, what parity requires).
5. Verdict is PASS only when G1 to G9 pass and V1 to V7 have no FAIL. Token-mapping differences in exact hex are not failures. Missing layout, hierarchy, spacing rhythm, elements, or motion are.

Rework is one round per finding; after that, functional, accessibility, and visible layout bugs are fixed now, everything else goes to `docs/migration/parity-backlog.md`.

### The parity loop

One capture pass per template is the start, not the end. After a capture:

1. **Capture** (`V-<template>-parity`): report plus screenshots for every page and section.
2. **Fix planner** (`M-<template>-fixes`): turns the report into a task table. Scope rule applies hard here: every fix row lists the asset, strings file and shared helper it touches, or a later task stalls.
3. **Generate** the tasks with the `gen-tasks.mjs` pattern from the plan table and let the autoloop run them.
4. **Recapture** (`V-<template>-parity-2`) into a second folder, and write a report that marks each prior finding FIXED or STILL OPEN instead of repeating the whole list.
5. Stop after two rounds per template. Anything still open goes to the backlog and moves with the merge, with a line in the decisions file.

The second capture folder is what proves the fix, not a second opinion on the first report.

## Missing pages from the live site

A page in the deliverable set may have no localized clone (it was skipped, or the source navigation did not reach it). Do not derive it from another template and do not skip it silently.

1. Add a localizer task for the missing page (or a `...-extra` localization of the whole site) with an offline gate of its own.
2. Audit and map it like any other page, then build.
3. Record in the ledger why it was missing, so the next capture does not treat it as new work.

## Commerce pages in a template's own style (D-015)

Logic stays shared: one cart store, one mock-action layer, one engine query layer, one validation layer. Presentation becomes layout-named variants, chosen by each template's route or page config.

- Name variants by layout: `cart-lines:card-rows`, `checkout:accordion-steps`, `search:inline-header`. Never by template.
- Where the source has the page, rebuild it faithfully (D-014) and add it to that template's route set.
- Where it does not, derive it from that template's own blocks, tokens, radii, type scale and spacing. Never from the template that happened to own the page first.
- The route wrapper sets `data-theme`; the shared feature UI reads tokens only, so the same component can be wrapped by any template.

## After the template library: client spec phase

The library is the means, not the deliverable. Once a template is faithful and has its full storefront, the next phase builds a product UI from the client's material:

- **Inputs:** a folder of screen-spec JSON (one per screen: regions, copy, components, states) plus the matching images. The images are the visual truth; the JSON is the structure.
- **Method:** map every screen region to an existing section, block or atom first. Record REUSE, EXTEND, NEW-VARIANT, NEW-TYPE exactly as in the map phase. New types are allowed here because the client's spec, not a source template, defines them.
- **Output:** a client `PageDoc` set and the few new variants, built under the same hard rules (tokens, no hardcoded copy, server first, RTL-ready).
- **Merge:** the merge into the real app happens under the *target's* contract, not this one. Diff the two contracts before starting, confirm which governs, and log the differences in the decisions file. Everything the sandbox built is reference and fixtures at merge time; the target's types and providers win.
- **When to start:** only on the user's explicit go. The template work is a prerequisite for it, not a substitute.

Capture the client screens at the same three widths as template parity. A client page is done when it renders from the library with its spec content and passes the same static gates plus one screenshot comparison against the spec image.

## What init adds to AGENTS.md

`init.mjs` installs this pack and appends a short section to the workspace `AGENTS.md`. Keep it short; the detail lives in this pack.

```markdown
## UI migration pack

This workspace rebuilds Webflow source sites into one Next.js section library.

- Sources: `docs/migration/sources.json` (copy of `sources.example.json`). Raw folders are read-only.
- Pipeline: localize -> audit -> map -> build -> assemble -> parity -> register. Unit of work: a site for localize, a page for audit and map, a section for build and assemble, a template for parity.
- Skills: `.claude/skills/ui-{orchestrator,localize,audit,map,build}`. Agents: `.claude/agents/ui-{site-localizer,source-auditor,section-builder,parity-verifier}`.
- System docs: `docs/system/{ARCHITECTURE,GATES,SKILL-OVERRIDES}.md`.
- Hard rules: rebuild never paste; no repetition; no hardcoded copy; CMS-shaped props; tokens only; server first; port source motion only; RTL-ready; no runtime network.
- Proof: builders run build, lint, gen-registry, G3 to G9, and a clean `git status`. One browser pass per template in the parity task.
- Merge target: {{MERGE_TARGET}}.
```

## Install layout

```
.claude/skills/ui-orchestrator/SKILL.md
.claude/skills/ui-localize/SKILL.md
.claude/skills/ui-audit/SKILL.md
.claude/skills/ui-map/SKILL.md
.claude/skills/ui-build/SKILL.md
.claude/skills/ui-build/references/section-pattern.md
.claude/agents/ui-parity-verifier.md
.claude/agents/ui-section-builder.md
.claude/agents/ui-site-localizer.md
.claude/agents/ui-source-auditor.md
docs/system/ARCHITECTURE.md
docs/system/GATES.md
docs/system/SKILL-OVERRIDES.md
docs/migration/sources.example.json
docs/migration/DECISIONS.md          (created by init from the pack defaults)
docs/migration/LEDGER.md             (created by init, empty table)
docs/migration/HANDOFF.md            (created by init, empty headings)
```
