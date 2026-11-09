---
name: ui-parity-loop
description: Measured fidelity loop for rebuilding a template section as React + Tailwind + GSAP. One section at a time, compared with the original by pixel score, by box, and by motion curve at 1440, 1024 and 390 px. Use for every section build, every rework, and every acceptance. Page height or "it looks close" is never proof. Triggers - "make it like the original", "section does not match", "animations are not good enough", "audit the micro-interactions", starting any new template migration.
---

# ui-parity-loop

Born from a failed run (Morene, Nov 2026): five templates were accepted on total page height, and the owner saw wrong headers, cards and animations. Page height proves nothing. Only a section measured against the original proves anything.

## The six rules

1. **One section = one task = one root.** The rebuilt root carries `id="<section>"` and `data-section="<site>-<section>"`. The original root selector comes from the audit ("Root selector"). Never build a whole page in one task.
2. **Three widths, always:** 1440 (desktop, >= 1440), 1024 (tablet, 810 to 1439), 390 (phone, < 810). The tablet band is where owners look (a 850 px preview frame lands there). A run that tests 1440 and 768 misses it.
3. **Measure, never guess.** Before writing a line, read the original's computed layout (`getBoundingClientRect`, `getComputedStyle`) for each child at the three widths. Build from numbers, not from audit prose.
4. **Pixel score gates acceptance.** `section-compare.mjs <site> --orig <sel> --rebuild '[data-section="<site>-<id>"]' --width <w>` prints "visual difference: X% average, Y% of the pixels clearly different". Pass: under 8% and 15% at all three widths, section box within 2% (width and height). Look at the `-side.png` too: score does not see wrong fonts on empty areas.
5. **Motion is measured, not described.** For every animation line in the audit run `motion-compare.mjs <site> --orig <sel> --rebuild <sel> --trigger load|scroll|hover [--target <child>] --width 1440`. Pass: starts within 120 ms, duration within 25 percent, peak strength within 40 percent, plus the hover and click states. "MOTION DIFFERS" is a reject. Entrance choreography (hero load, stagger, word reveal) is where weaker builders fail most: the Chalant hero lasted 120 ms against 1380 ms.
6. **Never break the shared page.** Before deleting or renaming a file another file imports, create its replacement first. Leave the shared dev server compiling at all times. A section that breaks `/showcase/<site>` is rejected whatever its score.

## Loop for a builder

1. Read the audit entry, then measure the original (rule 3). Write the numbers in a short comment at the top of the data file.
2. Build the section from atoms: data in `data/<section>.ts`, tokens in the centralized CSS, animation in a reusable hook under `hooks/` that takes a scope ref and options (not hard-coded selectors), markup in `ui/`.
3. Run section-compare at 1440, 1024, 390. Fix the largest area first. Repeat until pass.
4. Run motion-compare per animation. Fix timing, easing, start and end values. Repeat until pass.
5. Run gates G1 to G11 plus the coupling check, then report with the numbers (not "looks the same").

## Loop for the orchestrator

1. A task is accepted only with the three pixel lines and the motion lines in the builder's report, and the orchestrator re-runs one of each itself.
2. After acceptance run `section-preview.mjs <site> <id>` and send the owner the LIVE links: `http://localhost:4190/compare/<site>/<id>` (compare page) and the rebuild `http://localhost:3001/showcase/<site>#<id>`. Links, not screenshots.
3. Reviewers must not be the same executor as the builder.
4. If the owner says a section "looks wrong", do not argue from a score: open the compare page at the width they use, measure that width, and add a task.

## After the build: motion audit

Run one docs-only audit task per template (`tools/make-motion-tasks.mjs`): it measures every animation and hover and writes `docs/audits/<site>/motion-qa.md` with a verdict per line and a prioritized fix list. Turn each "different" or "absent" line into a rework task.

## Tools (in `packs/ui-migration/tools/`)

- `section-compare.mjs`: box, styles, side-by-side picture, pixel score.
- `motion-compare.mjs`: start, duration, strength of hover, scroll and load motion on both sides.
- `compare-server.mjs`: live pages on http://localhost:4190 with width buttons 1440/1024/390 (originals served on 4181 to 4185).
- `compare-template.mjs`: whole-page screenshots at three widths (a smoke test, not a proof).
- `section-preview.mjs`: rolling gallery of accepted sections.
- `make-section-tasks.mjs`: writes one `S-sec-<site>-<section>` brief per audited section.
- `make-motion-tasks.mjs`: writes one `M-motion-qa-<site>` audit task per template.
Copy them to `ops/e2e/` of the project (Playwright installed in that folder).

## Rule 7: fonts are part of parity (added 2026-11-08)
The pixel score barely sees a wrong font (Arial instead of Inter Tight looks "close" in the numbers and wrong to the eye). Before any section is accepted, check that every font family of the original is DECLARED in the app (local `.woff2` under `public/media/<site>/fonts/`, `@font-face` in `src/styles/<site>/fonts.css`, no external URL) and that the computed `font-family` of headings, paragraphs, buttons and small text is the same in the original and the rebuild (`document.fonts.check`, list of loaded faces). Do this FIRST for every template: fonts are a one-time task per site, and every section inherits it.

## Rule 8: never hide content by default (added 2026-11-09)
A builder that adds a scroll reveal often leaves the element at `opacity: 0` until the animation fires. When the trigger does not fire (fast scroll, screenshot tool, no JS, reduced motion) the section stays blank: a 600 px empty area and a 1300 px empty testimonial band were seen this way. The initial state must be visible in CSS; the animation is a progressive enhancement that starts only when JS runs and the element is really in view, and every element must end visible. Check by loading the page, scrolling with real steps, and by taking the section screenshot: nothing may be missing that the original shows. Also compare the page at `scrollY = 0` (use `section-compare --top`), because a section scrolled into view hides offsets that the first screen shows.
