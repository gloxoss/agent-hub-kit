# {{id}} · {{phase}} · {{title}}

Depends on: {{deps}}. Allowed scope: {{scope}}.

## Goal
One or two sentences: what exists when this is done.

## Skills
2 to 4 skills from the library that fit this task, one per line as `name`: why. `node {{HUB_DIR}}/tools/skills.mjs check <TASK>` must pass before dispatch, and the done summary ends with "skills used: ...".

## Load (just in time, nothing else)
- `{{HUB_DIR}}/PROTOCOL.md` (if not read this session)
- Inputs: exact paths (audit doc section, existing files to reuse)

## Scope
Files and folders you may create or edit. Claim exactly these. Anything else: `say` to the orchestrator first.

## Out of scope
What not to touch, even if it looks wrong. Report it instead.

## Steps
Numbered, specific to this task.

## Done when
Exact checks, each with the command to run. `done --verify` must quote the real output.

## Report back
What to put in `done --summary`, and any file the orchestrator needs.
