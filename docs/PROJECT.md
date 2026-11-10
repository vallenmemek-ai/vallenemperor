# PROJECT.md — VallenEmperor architecture map

Purpose: let a new agent understand the repository without reading a 1,200-line `agent.ts`. Read
this before changing code; it tells you **what exists, where it lives, and where new code belongs**.

## 1. Product shape

| Package | Role | Published |
| --- | --- | --- |
| `vallenagent` | Engine: turn loop, providers, tools, skills, memory, sessions, gateway | no (workspace) |
| `vallencli` | Terminal UI: REPL, rendering, approvals, slash commands, config surface | no (workspace) |
| root `vallenemperor` | The npm package users install; ships `vallencli/src`, `vallenagent/dist`, skills, banner | **yes** |

`npm install -g vallenemperor` exposes `vallenemperor` and `vallenemperorcli`. The root package uses
a `files` whitelist; `vallenagent/dist` is git-ignored but included in the tarball via `files`.

Dependency direction is one-way: **CLI → core**. `vallenagent` must never import `vallencli`.

## 2. One turn, stage by stage

`AIAgent.runTurn()` wraps `chat()` → `_chatImpl()` (the loop). Each stage is a module with explicit
dependencies, pinned by tests:

| # | Stage | Module | Responsibility |
| --- | --- | --- | --- |
| 1 | Setup | `agent/turn_setup_phase.ts` | `/plan` rewrite, append user message, auto-checklist item, skill preload, deep-memory block |
| 2 | Provider call | `agent/turn_provider_call.ts` | cache-marker retry, one compaction retry on overflow, continuation of `finish_reason: length` answers (max 2, budget-aware) |
| 3 | Verification gate | `agent/turn_verification_gate.ts` | pure decision: `allow` / `nudge` once / `block` before a final answer |
| 4 | Tool dispatch | `agent/turn_tool_batch.ts` | `parallelSafe` groups (max 4) then ordered execution; appends `tool` messages; detects checklist changes |
| 5 | Tool context | `agent/tool_context.ts` | assembles `ToolContext` (paths, coverage, provider info, subagent factory, stream callbacks) |
| 6 | Bookkeeping | `agent/tool_result_evidence.ts` | verification evidence groups, turn artifacts, explicit-skill marker |
| 7 | Finalize | `agent/turn_finalize.ts` | checkpoint, session save, counters, skill stats, background review, result object |

Supporting modules: `turn_setup.ts` (skill selection + preload cap), `turn_artifacts.ts`,
`verification.ts` (ledger, command classification), `tool_evidence.ts`, `request_messages.ts`,
`conversation_compaction.ts`, `context_window.ts`, `token_budget.ts`, `failure_classification.ts`,
`turn_recovery.ts`, `clarify_policy.ts`, `mcp_wiring.ts`, `prompt_cache.ts`, `summarizer.ts`.

**Rule:** stage-level logic goes into a stage module. Do not grow `agent.ts`.

## 3. Folder map

```text
vallenagent/src/
  index.ts        public surface; re-exports folder barrels only
  agent/          turn loop + the stages above
  providers/      OpenAI-compatible, Anthropic, router + failover
  tools/          global registry + builtin_tools/{file,terminal,web,media,state,session,skills,integration}
  skills/         SKILL.md loader, relevance scoring, preload budget, bundled sync
  skills_hub/     catalog search, quarantine, install, lock file
  memory/         MEMORY.md, USER.md, deep memory with source quoting
  session/        session store, checkpoints, todo, SQLite search
  gateway/        Telegram: manager, router, store, daemon, cli
  mcp/            MCP client manager, tool conversion, project config
  core/           config, approval policy, project context, cron, display, plan prompt, model eval

vallencli/src/
  cli.mjs              REPL, argument parsing, one-shot, config commands, model picker glue
  cli-model-picker.mjs two-level picker state machine + gateway fetch
  cli-ui.mjs           cards, status bar, approval boxes, diffs, themes
  cli-markdown.mjs     markdown + code-fence renderer
  cli-commands.mjs     local slash commands
  cli-files.mjs        @path mentions and completion
  cli-suggest.mjs      command registry + fuzzy suggestions
  cli-theme.mjs        color levels and gradients
```

## 4. Request assembly (how a turn reaches the model)

1. Stage 1 appends the user message and prepares skill/deep-memory text.
2. `request_messages.ts` (`prepareRequestMessages`) builds the payload: history, preloaded skill
   text, deep memory, todo snapshot, verification evidence block, premature-attempt note.
3. History is compacted when it exceeds `MAX_HISTORY_MESSAGES` or the token budget
   (`conversation_compaction.ts`), then the request is re-estimated.
4. `prompt_cache.ts` marks the stable prefix when the provider supports it.
5. `turn_provider_call.ts` sends it and handles the retries described above.

## 5. Verification model

- Editing a file **dirties** an evidence group:
  - `.ts/.tsx/.mts/.cts` → `typecheck`
  - `*.test.*`, `*.spec.*`, `tests/`, `__tests__/` → `test`
  - `package.json`, `tsconfig*.json`, `*.config.*`, `Makefile`, `Dockerfile` → `build`
- A successful command **proves** the groups it satisfies (`verification.ts` →
  `verificationGroupsForCommand`). Generic verification commands count as `build`.
- Before a final answer: a dirty group triggers **one nudge**, then **blocks** with
  `completionStatus: 'incomplete'`. Read-only commands (`ls`, `git status`) never count.
- Skill stats record `verified` / `failed` / `unknown` from the last verification entry.

## 6. Clarify policy

`agent/clarify_policy.ts` decides whether asking is allowed at all:

- accepted only for a **blocking decision** (changes what gets built/run, cannot be resolved from the
  repo/context/convention, guessing wrong is expensive),
- rejected: permission-to-continue questions, preference polls (style/naming/layout/format),
  duplicate questions, >5 questions, >4 choices, empty text.
- The tool returns `proceed: true` + advice when the model should act instead of asking.

## 7. Skills lifecycle

- Sources: `~/.vallenemperor/skills` + bundled catalog in the package (`.vallenemperor/skills`).
- `skills.ts` scores relevance using **distinct** words (repeats do not count twice).
- Auto-loaded skill applies to the current turn only; `skill_view` makes it sticky until `/new`
  (`activeSkill` holds only explicit loads).
- `turn_setup.ts` caps preloaded body at `MAX_SKILL_PRELOAD_CHARS` (16 KB) and a share of the window.

## 8. Model picker (`/model`)

- `cli-model-picker.mjs` is pure logic + `fetchGatewayModels()`:
  - `GET {base_url}/models`, grouped by `owned_by` (`ag` → antigravity, `kc` → kiro, others as-is).
  - Navigation: ↑/↓ wraps, Enter descends/selects, Esc goes back one level, typing filters
    (provider label, account id, model id), Backspace removes a character.
  - Non-TTY: prints a catalog instead of taking over the keyboard.
  - 15 s timeout, 5-minute session cache per `base_url`.
- `cli.mjs` owns the terminal rendering and applies the choice with `agent.setModel(id, false)`
  (session-only; `/model save <name>` persists).
- `/model <name>` still switches directly; `/model save <name>` writes config.

## 9. Configuration and data

`~/.vallenemperor/` (override with `VALLENEMPEROR_HOME`):

```text
config.json            providers.active + provider entries, approval mode, limits
sessions/              persisted sessions and checkpoints
session-search.sqlite  session search index
memories/              MEMORY.md, USER.md, deep memory
skills/                user skills (bundled catalog is copied here on first run)
checkpoints/           file snapshots taken before edits
gateway/               telegram.json, downloaded media
logs/
skills_hub/            lock file, quarantine, audit log
```

Environment: `VALLENEMPEROR_HOME`, `VALLENEMPEROR_APPROVAL`, `VALLENEMPEROR_SKILLS_CATALOG`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`.

Provider presets live in `core/config.ts` (`PROVIDER_PRESETS`): `openrouter`, `openai`, `anthropic`,
`deepseek`, `9router`, `ollama`. API keys are read from the environment and never written to
`config.json`.

## 10. Tool surface

- **Files**: `read_file`, `patch`, `patch_batch`, `apply_patch`, `write_file` — read-before-write
  tracking, partial reads allowed only for a unique target, atomic writes, diff returned to the model.
- **Execution**: `terminal` (foreground/background), `process_manage` (list/poll/wait/kill, including
  other sessions with `confirm: true`), `execute_code`.
- **Web**: `web_search`, `web_extract`, `browser_exec`.
- **MCP**: project servers, tool names prefixed `mcp__<server>__<tool>`.
- **State**: `todo_list`, `memory`, `deep_memory`, `clarify`, `skill_view`, `skill_manage`,
  `tool_search` / `tool_call` (deferred tools), `session_view`.

## 11. CLI surface

```bash
vallenemperor                     # REPL
vallenemperor -p "prompt"         # one-shot; no approval prompt, risky tools refused
vallenemperor --resume [id]       # resume last / given session
vallenemperor --approval dangerous|all|off
vallenemperor --model <name>
vallenemperor config show|set provider|set model|set approval
```

Slash commands live in `vallencli/src/cli-commands.mjs` (local) and `vallenagent/src/core/commands.ts`
(shared across surfaces). The registry for autocomplete is `cli-suggest.mjs`; `HELP` is in
`cli-ui.mjs`.

## 12. Invariants covered by tests (do not change without a test)

- Event order per turn: `thinking → telemetry (per provider response) → tool_start → tool_end →
  chunk → final telemetry`; a failed turn ends with `error` and no telemetry.
- Verification groups (typecheck/test/build) block or nudge exactly as described in §5.
- `clarify` rejects permission/preference questions and enforces payload limits.
- Skills: distinct-word relevance, per-turn auto-load, explicit `skill_view` stays sticky.
- `/model` picker: grouping, navigation, filtering, Esc levels, non-TTY fallback, cache.
- Approvals: edits over 20 changed lines always show a diff; `/auto on` disables every gate.
- Telegram: single-use pairing code, allowlist, rate limit, approve/deny callbacks.
- Patch safety: unread/stale files refused; partial read accepted only for a unique `old_string`.

## 13. Where to add things

| Task | Touch |
| --- | --- |
| New tool | `tools/builtin_tools/*.ts` + register + schema + test |
| New local slash command | `cli-commands.mjs` + `cli-suggest.mjs` + `HELP` in `cli-ui.mjs` |
| New shared command | `vallenagent/src/core/commands.ts` |
| New provider preset | `core/config.ts` (`PROVIDER_PRESETS`), plus `providers/` if the API differs |
| New turn stage | `agent/turn_*.ts`, call it from `agent.ts`, add an event-order test |
| New bundled skill | `.vallenemperor/skills/<category>/<name>/SKILL.md` with `name` + `description` frontmatter |
| New config key | `core/types.ts`, `core/config.ts` (default + validation), docs |

## 14. Troubleshooting map

| Symptom | Look at |
| --- | --- |
| `Task incomplete: ... lack a typecheck/test run` | verification gate + which file was edited |
| Turn keeps nudging "checklist still open" | auto-checklist logic in `turn_setup_phase.ts` / `agent.ts` |
| `/model` prints the old text | you are running an old global install → `npm install -g .` |
| `/model` times out | gateway latency; timeout is 15 s, cache 5 min (`cli-model-picker.mjs`) |
| Bin prints nothing after global install | symlink guard in `cli.mjs` (`realpathSync` comparison) |
| `exports is not defined in ES module scope` | root `package.json` must not set `"type": "module"` (dist is CommonJS) |
| Skill feels sticky | auto-match must not be stored in `activeSkill`; only `skill_view` sets it |
| Gateway/Telegram auth errors | `gateway/store.ts` config + `telegram.ts` pairing logic |
