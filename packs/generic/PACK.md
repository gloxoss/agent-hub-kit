# Generic pack

Pipeline: `plan` → `build` → `review`

Unit of work: a **task** (one self-contained deliverable per brief).

## Gates
- All new .mjs files pass `node --check`.
- `git status --short` shows nothing outside the claimed files.
- No project names from other workspaces in shared files.

## What init adds
No extra skills or agents beyond the hub engine.
