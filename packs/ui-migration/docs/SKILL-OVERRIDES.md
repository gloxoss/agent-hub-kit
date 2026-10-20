# Global skill overrides

The global skills below were written for other projects. Several contradict the UI sandbox contract. This table says exactly which parts to use here. When a global skill and this table disagree, this table wins.

| Global skill | Use it for | Ignore or override |
|---|---|---|
| `web-localizer` | Steps 1 to 4 and 7: dependency discovery, recursive asset download, relinking, webfont localization, completeness scan | Steps 5, 6, 8 to 11 (content rewrite, packaging, deploy, root hub, decommission). Output goes to `localized/<site>/`, never into the raw folder. |
| `webflow-to-react-gsap` | Phase 1 analysis checklist (container hierarchy, `data-w-id` inventory, IX2 extraction via `Webflow.require('ix2').store.getState()`), Webflow-to-Tailwind layout mapping table, `isolate` stacking fix, verification ideas (transform sampling at t1/t2) | Any other project's theme and colors (use contract tokens). `gsap.context` in `useEffect` (use `useGSAP` with scope). "Ambient loops forced" (port only loops the source has). Per-locale `en.ts/fr.ts/ar.ts` folders (copy lives in page documents). `features/<section-name>/` layout (sections live in `src/sections/<type>/`). |
| `webflow-nextjs-migration` | Phase 0 question list, asset inventory, Lottie and Swiper detection, form inventory | Keeping Webflow CSS, "no Tailwind", pasting raw class names into JSX, `components/sections` flat layout, analytics and waitlist API scaffolding, auto-loading a skill whose path points to another machine. |
| HTML-to-React migration skills | Five-phase discipline (localize, audit, deconstruct, reconstruct, animate, validate), anti-copy rule, Webflow runtime stripping list, decision tree | That skill's design tokens, component paths, display font, inline `style` color usage. |
| `html-nextjs` | "Plan the decomposition before writing code" checkpoint, server/client boundary rule, content extraction step | That skill's variable mapping and `features/[feature]/data/*.json` location. |
| `nextjs-app-structure` | Server-first rules, `next/image` and `next/link` rules, import order, strict-types payload rule, audit grading idea | Its directory tree where it differs from the contract (contract wins), Jest and Semgrep install (not without approval), generating six agents (this workspace uses four). |
| `app-design-prompt-factory` | Later merge-target adaptation phase: product context, page inventory, page prompts and asset prompts | Not used during source migration. Never runs paid generation without explicit approval. |
| `gsap-*` skills | API reference for timelines, ScrollTrigger, React integration, performance | None, they are reference only. |
| `context-fundamentals`, `context-compression` | Already applied: progressive disclosure, just-in-time file loading, anchored `HANDOFF.md`, subagent isolation for heavy reads | Nothing to run per unit. |
| `skill-master` / `skill-creator` | Creating or checking new `ui-*` skills: kebab-case name, description with WHAT and WHEN, body under 2,000 words, long material in `references/` | Installing skills globally. Project skills stay in `.claude/skills/`. |
