# Executors

Who does what, what each one is bad at, the session cap, how to watch a running job, and what to do when it breaks. The live table lives in `.agent-hub/executors.json`; this file is the reasoning behind it. Add or change an executor in both places.

All commands below are the shapes `dispatch.mjs` builds for each entry. Placeholders: `{msg}` the short prompt line, `{sid}` the generated session UUID, `{job}` the job title, `{outFile}` the verdict file.

---

## 1. Routing

Two fixed orders, loaded from `executors.json`:

- **Builds, strong first.** `claude-ag2-sonnet` → `claude-ds2` → `claude-ds3` → `claude-ds1` → `agy` → `opencode` → `cursor`. Start at the top; move a failed task down one entry.
- **Reviews, healthy first.** `codex` → `claude-ag2-sonnet` → `claude-grok` (only when its launcher file exists) → `cursor` → `claude`. Always start with codex at low reasoning.

An executor that reports QUOTA, AUTH or DOWN is skipped for one hour; the autoloop prints `MOVED` or `QUOTA` so the human sees the restore step.

**Quota cascades.** One provider window can back several executors. The Antigravity Claude window backs the Sonnet launcher and, on the same accounts, the agy launcher; a DeepSeek balance family can back several Claude Code slots unless each is configured with its own key. When a window empties, mark every executor on it down together and move work to an independent provider. Do not "spread the load" across executors that share the same window, and never drop to `claude` (the orchestrator's own plan) to keep a queue moving. Reviews that can only run on `claude` should park with `QUOTA`, not spend the user's plan silently.

Give a small-context executor a small task. One file, one narrow section, or one review. Never a whole page, a whole pack, or a wide refactor. See `lessons.md` §2.1 and §2.3.

---

## 2. The table

| Executor | Backend / model | Strengths | Limits | Max sessions | Role |
|---|---|---|---|---|---|
| `claude-ag2-sonnet` | Claude Sonnet via an Antigravity proxy (shared weekly quota) | Best all-round builder; reads a long brief and holds the file map; dependable reviewer | The Antigravity Claude window is shared with every other Antigravity Claude executor (and counts against the agy lane on the same accounts); proxy must be up on 8080 | 4 | builder, reviewer |
| `claude-ds2` | DeepSeek through the Claude Code CLI | Fast, cheap, good at mechanical multi-file changes | Weaker judgement on ambiguous specs; API balance can run out | 3 | builder |
| `claude-ds3` | DeepSeek through the Claude Code CLI (second slot) | Same as ds2, extra parallelism | Same as ds2; same balance family as ds2 unless configured separately | 3 | builder |
| `claude-ds1` | DeepSeek through the Claude Code CLI (first slot) | Builder plus acceptable reviewer; long-running lane | Same as ds2 | 3 | builder, reviewer |
| `agy` | Gemini Flash on Antigravity | Fast and cheap; handles several small UI tasks in parallel | No review sandbox; less reliable on long instruction chains | 5 | builder |
| `opencode` | Free model, `opencode/beam-free` unless `OPENCODE_MODEL` overrides (e.g. a DeepSeek or LongCat free model) | Many parallel sessions through one shared server; near-zero cost | Free models quit near ~140k tokens (the DeepSeek one often around 200k) and sometimes mistype paths (LongCat is the worst); small tasks only | 6 | builder |
| `claude-ag2-gemini` | Gemini through the Claude Code CLI | Cheap builder and reviewer for one-file tasks | Gemini rejects some Claude Code tool schemas; needs `--strict-mcp-config --tools`; cold proxy start is slow | 5 | both (small tasks) |
| `codex` | GPT on a ChatGPT plan | Best reviewer: read-only sandbox, precise findings, writes its own verdict file | A 5-hour usage window; high reasoning drains it; build args exist but it is not in the build fallback | 2 | reviewer (builder only by choice) |
| `claude-grok` | Claude Code on Grok through CLIProxyAPI | Useful reviewer and builder when Grok quota is healthy | Needs a user-made launcher; xAI account must stay authenticated | 2 | builder, reviewer |
| `cursor` | Cursor "Auto" | Builder and last-resort reviewer; one interactive setup | No session id to resume; reviews run with `--trust` so it cannot apply edits, builds with `--force`; the PowerShell wrapper makes a live job look dead | 3 | builder, reviewer |
| `claude` | Claude via the Claude Code CLI (your own account) | Universal fallback; any task | Burns the orchestrator's own quota; one session only | 1 | last-resort builder or reviewer |

`claude-ag2-opus`, if the user has an Opus launcher, is the same row shape as `claude-ag2-sonnet` with its own account and quota. Add it to `executors.json`; do not special-case it in code.

Context, in practice: the advertised window is printed by `opencode models` and by each provider, but the number that matters is the one you observe. Free opencode models have been reliable only up to roughly 140k tokens of a session; treat that as the ceiling. Paid Claude and Codex backends hold a full task brief plus the files they read.

---

## 3. Watch and restore

| Executor | Watch command | Restore step |
|---|---|---|
| `claude-ag2-sonnet` | `claude-ag2-sonnet --resume <sid>` | Run the quota audit (`node .agent-hub/quota.mjs`). If the Claude weekly window is out, wait for the reset or move the lane. The launcher starts its proxy on 8080; if the proxy is down, run the launcher once by hand. |
| `claude-ds1` | `claude-ds1 --resume <sid>` | Top up the DeepSeek API balance used by that launcher, then `ping` it. |
| `claude-ds2` | `claude-ds2 --resume <sid>` | Same as ds1, for ds2's key. |
| `claude-ds3` | `claude-ds3 --resume <sid>` | Same as ds1, for ds3's key. |
| `agy` | `agy --conversation <conversation id from the log>` | Check the Antigravity/Gemini quota; if the model is busy, switch model with `--model` or route the task elsewhere. |
| `opencode` | `opencode attach http://127.0.0.1:4096` (shows all instances), or `opencode -s <sid>` | `opencode auth list`; check the provider key and balance. Start the shared server with `dispatch opencode-server` if port 4096 is closed. |
| `claude-ag2-gemini` | `claude-ag2-gemini --resume <sid>` | Cold proxy: the first call can take minutes. Run the launcher once by hand to boot the proxy on 8080, then retry. |
| `codex` | `codex resume <thread id from the log>` | Wait for the 5-hour window to reset, or `codex login` with another account. Reviews already run at low effort; do not raise it to "finish faster". |
| `claude-grok` | `claude-grok --resume <sid>` | Create or repair the launcher (Claude Code pointed at CLIProxyAPI on 8317, model grok), and check the xAI account in the proxy. |
| `cursor` | none: read `.agent-hub/runs/<job>.log` | Run `cursor agent` once interactively to install and log in. |
| `claude` | `claude --resume <sid>` | Wait for the plan reset or switch to another account. Because this is the orchestrator's own account, dispatch here only when the others are out. |

Jobs also stream to `.agent-hub/runs/<job>.log`. On Windows the follower is `Get-Content -Wait <log>`; on POSIX, `tail -f <log>`. Read the log, not the hub, when a job looks stuck.

---

## 4. Adding an executor

1. Add one entry to `executors.json` with: `name`, `kind` (`builder` | `reviewer` | `both`), `maxSessions`, `buildCmd` and `buildExtraArgs`, `reviewCmd` and `reviewExtraArgs` (null when it cannot review), `watch`, `restore`, and `model` when the launcher takes one.
2. Write the args as data, using `{msg}`, `{sid}`, `{job}` and `{outFile}` placeholders. Only the ordering of the array and the placeholders matter; the dispatcher builds the command line. If the launcher is a Windows `.cmd`, it already runs through one quoted command line.
   - **Review flags are not the build flags.** A review must be unable to edit: drop edit tools (`--disallowedTools Edit,Write,NotebookEdit`), or use the CLI's own read-only switch. Cursor is the odd one: build uses `--force`, review uses `--trust`. Codex reviews always add `-c model_reasoning_effort="low"` with `--sandbox read-only`; its build args exist but it is not in the build fallback.
   - **Model selection is data.** opencode reads `OPENCODE_MODEL` with a `beam-free` default; a launcher that takes a model gets a `model` field, not a special case in code.
3. Run `dispatch ping <name>`. A real answer names a model; an echoed prompt means the binary is missing or the shell failed.
4. Give it one small task first. Promotion goes by evidence, not by hope.
5. Add its row here and, if its quota lives in CLIProxyAPI, confirm `quota.mjs` knows the provider.

---

## 5. Never

- Do not attach a log directly as the CLI's stdout on Windows (`lessons.md` 1.1).
- Do not pass a multi-line prompt as an argument (`lessons.md` 1.2).
- Do not leave stdin open (`lessons.md` 1.3).
- Do not judge an outage from words in a successful transcript (`lessons.md` 1.4).
- Do not print the proxy management key, even in an error (`lessons.md` 2.5).
- Do not run a reviewer with edit tools enabled, or a builder with a read-only sandbox.
