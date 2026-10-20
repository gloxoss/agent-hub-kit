# {{ID}} · build · Page audit + UI rework: {{ROUTE}}
Depends on: none. Allowed scope: {{SCOPE}}. Report: `{{REPORT}}` (create).

> Read `{{HUB_DIR}}/pages/README.md` first: it holds the project rules for page work.
> Never start, stop or restart a shared dev server if one is configured.
> Never emojis. Never invented options or numbers. Never claim a check passed without command output.
> ORDER: write `{{REPORT}}` (Phase A) and save it BEFORE any code edit. If your session restarts, read your own report first and continue from it; do not redo the audit.

## Goal
The page {{URL}} is audited, all data sources and connections verified, and laid out following the project design system.

## What the owner sent
{{OWNER}}

## Load (just in time)
- `{{HUB_DIR}}/pages/README.md` (page rules)
- `{{PAGE_FILE}}`, then the components and services it imports

## Skills
{{SKILLS}}

## Phase A: audit (write the report before changing code)
Answer each with evidence (file:line, command output):
1. **What the page is for**, in plain sentences without unnecessary jargon.
2. **Where data comes from.** Trace each metric, option, list to its source.
3. **Connections to other modules.** What does this page configure, create, or consume?
4. **UX and UI.** Check against the design system and tokens.
5. **Code quality and performance.** Structure, dead code, data-fetching, bundle size.

## Phase B: rework
1. Fix issues found in scope. Anything out of scope: report under "Not fixed (outside scope)".
2. Reshape to project conventions and design system.
3. Clean user feedback and states (loading, empty, error).

## Phase C: proof
{{PROOF}}

## Report format (`{{REPORT}}`)
```markdown
# <page title> ({{ROUTE}})
## How this page works
## Data sources
## Connections
## UX and UI
## Scorecard
## Findings
## What changed
## Not fixed (outside scope)
## Proof
```

## Done when
- Report written with every section filled.
- Proof commands run and outputs quoted.
