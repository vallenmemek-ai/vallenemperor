---
name: vallenemperor
description: "Use, configure, debug, and extend VallenEmperor."
version: 2.0.0
author: Vallen + VallenEmperor Team
license: MIT
metadata:
  category: autonomous-ai-agents
  triggers: [VallenEmperor, vallenemperor, vallenagent, vallencli, AI agent, terminal agent]
  compatibility: [linux, macos, windows]
  vallenemperor:
    category: autonomous-ai-agents
---

# VallenEmperor Skill

VallenEmperor is a terminal coding agent: a TypeScript core (`vallenagent`) plus a
TypeScript CLI (`vallencli`) published as one package, `vallenemperor`. There is no
Electron app and no `vallenterminal` workspace any more — if a document mentions them,
the document is stale.

## When to Use

- Run, configure, debug, or extend VallenEmperor.
- Change `vallenagent/`, `vallencli/`, agent tools, commands, or bundled skills.
- Check whether a VallenEmperor feature actually exists before promising it.

Load `hermes-agent` instead when the question is about Hermes Agent itself; the two
runtimes share ideas but not paths or commands.

## Prerequisites

- Node.js ≥ 20, npm, and installed dependencies (`npm ci`).
- Default provider is `9router` at `http://127.0.0.1:20128/v1`, default model
  `ag/gemini-3.8-flash-medium`, env key `NINE_ROUTER_API_KEY`. `config set provider`
  switches presets (`openrouter`, `openai`, `anthropic`, `deepseek`, `9router`, `ollama`).
- Runtime data lives in `~/.vallenemperor/`; `VALLENEMPEROR_HOME` overrides the root.
  Layout: `config.json`, `sessions/`, `memories/`, `checkpoints/`, `skills/`,
  `scratch/`, `artifacts/`, `gateway/`, `cron/`, `logs/`.
- Provider credentials sit in `config.json` or the environment. Never print them, put
  them in shell commands, or commit them.

## How to Run

From the repository root:

```bash
npm run build      # vallenagent tsc + vallencli tsc (dist/ is what ships)
npm run typecheck  # both workspaces
npm test           # vallenagent then vallencli suites
npm run cli        # build, then start the REPL from source
node bin/vallenemperor --version   # the packaged launcher
```

Installed usage: `vallenemperor` (REPL), `vallenemperor -p "prompt"` (one-shot),
`vallenemperor --json -p "/status"` (machine-readable), `vallenemperor --help`.
`install.sh` / `install.ps1` only create launchers; `--purge` deletes config, keys,
sessions and memories, so never run it without explicit approval.

## Quick Reference

| Area | Path |
|---|---|
| Core barrel (public API) | `vallenagent/src/index.ts` → `dist/index.js` |
| Turn loop / agent | `vallenagent/src/agent/agent.ts`, `agent_types.ts` |
| System prompt | `vallenagent/src/agent/agent_system_prompt.ts` |
| Background self-review | `vallenagent/src/agent/background_review.ts` |
| Clarify policy + answers | `vallenagent/src/agent/clarify_policy.ts` |
| Tool registry | `vallenagent/src/tools/tools.ts` |
| Tool handlers | `vallenagent/src/tools/builtin_tools/*.ts` |
| Shared commands (all surfaces) | `vallenagent/src/core/commands.ts` + `core/commands/` |
| CLI-only commands | `vallencli/src/cli-commands.ts` |
| Command dropdown | `vallencli/src/cli-suggest.ts` |
| Help reference | `COMMAND_REFERENCE` in `core/commands.ts` |
| Rendering | `vallencli/src/cli-ui.ts`, `cli-reasoning.ts`, `cli-markdown.ts` |
| REPL / arg parsing | `vallencli/src/cli.ts` (builds to `vallencli/dist/cli.js`) |
| Platform adapter | `vallenagent/src/core/platform.ts` |
| Gateway (Telegram) | `vallenagent/src/gateway/` |
| Cron pipeline | `vallenagent/src/core/cron_scheduler.ts`, `gateway/cron_actions.ts` |

Surface facts worth remembering:

- 40 tools are registered; `COMMAND_REFERENCE` documents 75 commands. The registry is:
  `read_file write_file patch patch_batch apply_patch search_files list_dir repo_map
  typecheck lsp_diagnostics lsp_servers terminal process_manage execute_code checkpoint
  schedule session_search session_view clarify memory deep_memory todo_list
  image_generate vision_analyze browser_exec browser_screenshot browser_record
  manage_connections delegate_task skills_list skill_view skill_manage tool_search
  tool_describe tool_call web_search web_extract x_search set_theme text_to_speech`.
  There is **no** `computer_use` tool — desktop automation is not part of this runtime.
- Commands that change session/model/state live in **core** so CLI, `-p`, gateway and
  scheduled jobs behave the same. Only commands that need REPL state stay in the CLI.
- `terminal` accepts `pty: true` (Linux/macOS) so TUI apps see a real terminal;
  Windows returns a clear error instead of pretending.
- `clarify` blocks on a real prompt in the CLI (numbered choices, multi-select, free
  text, empty = skip, `batal` = cancel, 5 min timeout). Headless runs still get the
  "ask in prose" fallback.
- Background review reports `💾 review: <reason>` when it finishes without a change;
  its budget counts context *growth*, and hitting it is a skip, not an error.
- `/auto on` maps to approval mode `off` and disables every gate, including the
  big-edit preview. `-p` refuses risky tools unless `--approval off` is passed.
- Scheduled jobs: `local` jobs run in the daemon and write to
  `~/.vallenemperor/gateway/cron-local.log`; `telegram` jobs need an allowlisted owner.
  There is no WhatsApp adapter — that delivery is rejected at creation.

## Procedure

1. `git status --short` first; preserve unrelated work and never touch `.env`.
2. Read root `AGENTS.md`, `RULES.md`, and the relevant `docs/` page before editing.
3. Trace the whole path: input → command/tool dispatch → core → renderer. A tool trace
   in the terminal is not evidence that another surface behaves the same.
4. Make the smallest change that meets the request, reusing existing helpers instead of
   copying Hermes code, commands, or guarantees.
5. Add or update a test that asserts behaviour, not source text.
6. Run the narrow test, then `npm run typecheck`, `npm run build`, `npm test`.
7. Report changed files, exact numbers, and what you could not verify.

## Pitfalls

- **Stale docs are the main trap.** `vallenterminal`, Electron, `npm run dev`,
  `src/agent.ts`, `builtin_tools.ts` and `cli*.mjs` are all gone. Verify paths against
  the tree before quoting them.
- `-p` has no approval UI: risky tools are refused and the run exits non-zero.
- `/skills` (and other REPL-only commands) answer "hanya tersedia di REPL interaktif"
  under `-p` — that is correct, not a bug.
- Editing `vallenagent/src` requires a rebuild; the CLI loads `vallenagent/dist`.
- `bin/vallenemperor` must point at `vallencli/dist/cli.js`; pointing at `src/*.ts`
  breaks the launcher after a clean build.
- Do not overwrite `~/.vallenemperor/skills/custom/`, user sessions, or `update.sh`
  unless explicitly asked.

## Verification

- `git diff --check` exits 0.
- `npm run typecheck`, `npm run build`, `npm test` exit 0; quote the real totals
  (currently 444 agent + 166 CLI).
- `node bin/vallenemperor --version` and `node bin/vallenemperor -p "/status"` work
  after a build — that is the packaged path, not just the source path.
- For cross-platform claims, say plainly when only Linux was exercised.
