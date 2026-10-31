# Gates

Shared by `ui-build` (self-check) and the `ui-parity-verifier` agent (independent check). A gate passes only when its command was actually run and its output shown.

## Build-phase gates (static)

| # | Check | Command (from the workspace root) | Pass |
|---|---|---|---|
| G1 | Type check | `npx tsc --noEmit` (a production `next build` only when the config sets resources.allowNextBuild) | exit 0 |
| G2 | Lint, incl. `react/jsx-no-literals` on sections and blocks | `npx eslint src` | exit 0 |
| G3 | No raw colors outside globals.css | `grep -rnE "#[0-9a-fA-F]{3,8}\b\|rgba?\(\|hsl\(" src --include=*.tsx --include=*.ts` | no hits |
| G4 | No palette utility colors | `grep -rnE "(bg\|text\|border\|ring\|fill\|stroke)-(white\|black\|slate\|gray\|zinc\|neutral\|red\|blue\|sky\|green\|amber)-?" src --include=*.tsx` | no hits |
| G5 | No network outside mocks | `grep -rn "fetch(" src \| grep -v "src/lib/engine.ts" \| grep -v "src/content/adapter.ts"` | no hits |
| G6 | No raw img or internal anchors | `grep -rnE "<img\|<a href=\"/" src --include=*.tsx` | no hits |
| G7 | No Webflow leftovers | `grep -rnE "data-w-id\|w-layout\|w-inline-block\|w-nav\|webflow" src` | no hits |
| G8 | Client boundary | `grep -rln "'use client'" src` | every hit ends in `-client.tsx`, lives in `components/motion`, or is a store |
| G9 | Physical direction utilities | `grep -rnE "\b(ml\|mr\|pl\|pr\|left\|right)-[0-9]\|text-(left\|right)\b" src --include=*.tsx` | no hits, or justified in a code comment |
| G10 | Registry sync | every registry key has a fixture and a ledger row | manual |
| G11 | Independent from the source | `grep -rnE "webflow\.io\|localized/\|docs/" src --include=*.ts --include=*.tsx`, ignoring comment lines | no hits outside comments |

## Verify-phase gates (runtime, run by the verifier)

| # | Check | How | Pass |
|---|---|---|---|
| V1 | Renders in lab | open `/sections?key=<type:variant>` | no console errors, no hydration warnings |
| V2 | Source parity | screenshot `/sources/<site>/<page>#<id>` under the source preset vs the same section in `localized/<site>/`, at 375, 768, 1280 | layout, hierarchy, spacing rhythm, and imagery match; differences listed |
| V3 | Motion parity | for each audit motion line, observe the target at two times | matches trigger and direction; deliberate gaps logged |
| V4 | Reduced motion | emulate `prefers-reduced-motion: reduce` | content visible, no animation |
| V5 | Merge-target fit | same section under `data-theme="<merge-target>"` | readable, no broken contrast, no source-brand leftovers |
| V6 | RTL sanity | set `dir="rtl"` on the section | layout mirrors, no overlaps |
| V7 | Accessibility floor | heading order, alt text, focus ring visible, touch targets 40px or more | no failures |

Screenshots go to `docs/verify/<site>/<page>/<section-id>/`.
