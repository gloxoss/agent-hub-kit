---
name: ui-build
description: Phase 4 of a UI migration workspace. Builds one mapped source section as a CMS-shaped React section variant (schema, server component, optional GSAP client island, fixture, registry entry, page doc entry) on shared atoms, blocks, and contract tokens. Also scaffolds the Next.js app on the first build. Use when a ledger section row is mapped, or when the user says "build the hero", "convert this section", or "next section".
---

# ui-build

Code patterns for every file below are in `references/section-pattern.md`. Read it on the first build of a session.

## First build only: scaffold

If `package.json` does not exist: follow the merge contract's scaffold section ({{MERGE_TARGET}}; when the workspace has no external merge target, `docs/system/ARCHITECTURE.md` is the contract: `create-next-app` with TypeScript, Tailwind, App Router, `src/`), install `zustand gsap @gsap/react lucide-react`, copy the contract's commerce files (`ecom-types.ts`, mock `engine.ts`, `mock-actions.ts`), create the layer folders from `docs/system/ARCHITECTURE.md`, the content types, the empty registry, `PageRenderer`, the `(lab)` routes, and enable the `react/jsx-no-literals` lint rule for `src/sections/**` and `src/components/blocks/**`. Read `node_modules/next/dist/docs/` for anything framework-level before writing it. Run the build once before the first section.

## Steps per section

1. **Read inputs:** the brief, the section entry in the audit doc, its ledger row (map decision, registry key), and the existing files the decision points at. Nothing else.
2. **Tokens:** use only existing token classes. `globals.css` belongs to the `T-<site>` task, which maps `docs/audits/<site>/_tokens.md` onto the 19 tokens and the `[data-theme]` preset. If a section needs a token that does not exist, `block` the task instead of adding one.
3. **Atoms and blocks first:** create or extend only the ones named in the map plan. Search `src/components` before creating anything.
4. **Schema:** add or extend types in `src/sections/<type>/schema.ts`. Props are plain JSON (see ARCHITECTURE section 3). EXTEND means optional props only.
5. **Server component:** `src/sections/<type>/<variant>.tsx`. Markup from atoms and blocks, Tailwind token classes, logical properties, `next/image`, `next/link`. All visible strings come from props or `src/content/ui-strings/<namespace>.ts`.
6. **Motion:** shared `Reveal` data attributes first. A bespoke `<variant>-client.tsx` island only for motion `Reveal` cannot express or for interaction state. Port each motion line from the audit; log any that cannot be ported in the audit doc under "Not portable".
7. **Fixture:** `src/sections/<type>/fixtures.ts` with the source copy and local image paths (copy needed assets from `localized/<site>/` into `public/media/<site>/`).
8. **Register:** add the entry to `src/sections/<type>/index.ts` with `sources`. Never edit `src/sections/registry.generated.ts`; run `node scripts/gen-registry.mjs` to refresh it. Page documents are not yours: the `P-<site>-<page>` assemble task adds blocks to pages.
9. **Self-check:** run the build-phase gates in `docs/system/GATES.md`. Fix every hit before reporting.
10. **Parity (D-016, supersedes D-010):** load `ui-parity-loop`. Run P1 (pixel score at 1440, 1024, 390), P2 (motion-compare per animation) and P3 (shared page compiles). Paste the numbers in your report; a report without them is rejected. Measure the original's computed layout before step 5, not after.

## Hand off

Report with hub `done` (see `agents/ui-section-builder.md`). The orchestrator reviews the diff and spot-checks one proof line; visual parity runs once at page level. Workers never edit `docs/migration/*`.

## Assemble tasks (`P-<site>-<page>`)

Create or update `src/content/pages/<site>/<page>.ts` with the blocks in source order, using the registry keys from the ledger, and make `/sources/<site>/<page>` render it. Gate: the whole page renders in the lab with no console errors, plus G1 to G9.

## Derived pages and functional commerce

Pages with no source page (search, cart, checkout) are feature UI under `src/features/<feature>/ui`, fed by the mock engine through `getEngine()`. They reuse the template's atoms, blocks, and tokens, never invent a visual language, and are built from the same page documents where the page is a list of sections.
