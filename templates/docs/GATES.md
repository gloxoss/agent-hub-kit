# Gates

Quality gates that every worker runs before reporting done. The orchestrator spot-checks these during review.

## G1 — Syntax
All new/changed files pass `node --check` (for .mjs) or the project's type-checker.

## G2 — No project names in kit files
Build the pattern from the workspace's own source names (the `name` values in `docs/migration/sources.json`) and grep `kit/` with it. Zero hits outside this checklist file. No brand, client name or account email belongs in kit code or prompts.

## G3 — No hardcoded secrets
No API keys, passwords, or tokens in any committed file.

## G4 — Clean git status
`git status --short` shows nothing outside the worker's claimed files.

## G5 — No new unclaimed files
All new files were claimed before they were written.

<!-- Add pack-specific gates in the pack's PACK.md -->
