# Worktree Per Task Design Note

## Overview
To prevent multiple agents in parallel from colliding in the same working tree, we introduce isolated git worktrees per task.

## Key Decisions
1. **Layout**: Worktrees are placed at `../<repo>-wt/<task-id>`.
2. **Branch**: Each task operates on branch `task/<id>` branched from the integration branch (current HEAD branch).
3. **Hub Resolution**: Environment variable `HUB_ROOT` points to the main checkout so all hub events and states are centralized.
4. **Install Strategy**: pnpm uses its global virtual store; npm projects use `npm ci` per worktree, cached by `~/.npm`.
5. **Build Directory**: Isolated per worktree (`.next`, `dist`, etc. remain local to each worktree).
6. **Cleanup Rules**: On successful acceptance, the worktree and branch are removed and pruned (`git worktree remove`, `git branch -d`, `git worktree prune`). Stale worktrees are cleaned up hourly by the autoloop sweeper.
