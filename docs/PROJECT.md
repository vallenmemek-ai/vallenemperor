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
| 6b | Artifacts | `agent/artifact_store.ts` | writes the reviewable turn record (`walkthrough.md`, screenshots) and exposes its directory |
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

## 5b. Turn artifacts

Every turn that produced something reviewable writes a directory:

```text
~/.vallenemperor/artifacts/<sha256(sessionId)[0:16]>/turn-<n>/
  index.json        manifest: kind, name, path, bytes, createdAt per entry
  walkthrough.md    request + result + created/changed/saved + verification
  screenshot-*.png  captured by browser_screenshot
  plan-*.md         written by planning flows
  *.patch           diffs attached to a turn
```

- `artifact_store.ts` is synchronous by design (a few small files per turn) and hashes the session
  id, so no user-controlled string ever becomes a path segment.
- Artifact names are validated (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, `index.json` reserved), so
  traversal and manifest clobbering are rejected.
- `AgentResponse.artifacts.dir` carries the directory to the CLI, which prints it after the summary;
  `/artifacts` lists this session's entries newest-first.
- `browser_screenshot` writes straight into the current turn directory and returns the path, so the
  model can cite a real file and the user can open it.

## 5c. Plan mode and milestone steering

`/plan <task>` runs a planning turn (read-only) whose deliverable is a markdown plan saved by the
agent to `.vallenemperor/plans/YYYY-MM-DD_HHMMSS-<slug>.md`. The CLI then copies that file into the
artifact store as `plan-<slug>.md`.

Execution is a state machine in `agent/plan_mode.ts` (pure logic, no I/O):

| Command | Effect |
| --- | --- |
| `/plan go` | load the newest plan, parse its steps, run **step 1 only** |
| `/plan next` | mark the current step done, run the next one |
| `/plan edit <feedback>` | record a steering note and re-run the current step with it |
| `/plan skip` | mark the current step skipped, move on |
| `/plan stop` | freeze the run (resume later with `/plan next`) |
| `/plan status` | progress, per-step markers (`✓` done, `→` current, `–` skipped) |

Step prompts are built by `buildStepPrompt()` and explicitly scope the turn to one step ("Implement
ONLY this step"), so each milestone ends with a review point instead of a long unattended run. The
run state lives in the CLI (`state.planRun`); progress is also written to the artifact store as
`plan-progress.md` after every step.

Parser shapes accepted: `### Step 1 — title`, `1. title`, `- Step 1: title`. The step body is kept
verbatim (file paths, commands, expected output), because that is what makes a plan executable.

## 5d. Subagents and the agent manager

`delegate_task` has two modes:

| Mode | Behaviour |
| --- | --- |
| foreground (default) | waits for the result, batches three at a time, returns summaries in the tool result |
| `background: true` | registers the run, returns an id immediately, keeps working after the tool call |

Workspace isolation (`workspace`):

- `inherit` (default) — same tree as the parent;
- `branch` — a git worktree under `<home>/worktrees/<repo-hash>/<id>` on branch
  `vallen/subagent-<id>`, and the subagent's `terminal.cwd` is set to it, so it cannot fight the
  parent over the same files;
- `share` — same directory, no isolation (useful for read-only research).

State lives in `agent/subagent_registry.ts` (`SubagentRegistry` + a process-wide
`subagentRegistry`): status (`queued → running → completed|failed|cancelled`), capped progress log,
concurrency limit (default 4), and pruning of finished runs (default keep 20). Cancellation calls the
handle the factory exposes (`onHandle({ interrupt })`), which aborts the subagent's turn.

`/agents` is the manager panel (shared command handler, so the gateway sees it too):

| Command | Effect |
| --- | --- |
| `/agents` | list runs: status icon, id, elapsed, workspace, goal |
| `/agents show <id>` | detail: status, workspace path, goal, summary/error, last 10 progress events |
| `/agents stop <id>` | cancel and interrupt the run |
| `/agents clean` | remove worktrees of finished runs (branch + checkout) |

Worktrees are intentionally **not** deleted automatically on completion: the user reviews the branch
first. `/agents clean` is the explicit cleanup step.

## 5e. Routing: custom agents, planner, on-demand browser

Three mechanisms keep tool choice from being pure model whim:

**1. Custom agents** (`agent/custom_agents.ts`) — Antigravity-compatible definitions:

```text
<workspace>/.agents/agents/<name>.md        (or <name>/agent.md)
~/.vallenemperor/agents/<name>.md
---
name: code-reviewer
description: Reviews diffs for edge cases and security before merging.
tools: [read_file, search_files, patch]
model: gpt-4o            # optional
---
You are a rigorous reviewer...
```

Workspace definitions override global ones with the same name. `/agents available` lists them.

**2. Planner routing** — `delegate_task` accepts `agent: "<name>"`. When omitted,
`selectAgentForTask()` scores the goal against each agent's `description` using **distinct words**
(same rule as skills) and only routes on a strong match (two words or a name hit, score ≥ 3). A routed
agent contributes its instruction block, its `tools` (becomes the subagent's tool whitelist) and its
`model` override.

**3. On-demand browser** (`core/browser_gate.ts`) — browser tools refuse to run until the session is
unlocked. `/browser <task>` unlocks for 30 minutes and runs the task; `/browser off` locks again. This
mirrors Antigravity hiding its browser subagent from the normal tool list: the model cannot decide on
its own to browse the web.

The system prompt (`# Delegation, Artifacts and Plan Mode`) states the triggers: background/branch
delegation, screenshot proof for UI work, and plan-first for changes touching more than five files.

## 5f. Filesystem sandbox

`core/sandbox.ts` bounds file **writes** (reads stay allowed):

| Context | Roots | Notes |
| --- | --- | --- |
| subagent | its working directory (worktree for `workspace: "branch"`) | always on — this is what makes branch isolation real |
| main agent, `security.filesystem: "unrestricted"` (default) | none | current behaviour, nothing breaks |
| main agent, `security.filesystem: "workspace"` | the working directory | Antigravity-style bounded mode |

- Paths are canonicalized (`realpath` of the deepest existing ancestor) before comparison, so `..`
  escapes and symlinked parents are resolved first.
- Guards live in `write_file`, `patch`, `patch_batch`, and `apply_patch`; a denial returns an
  actionable message naming the allowed root and the `security.filesystem` knob.
- `/sandbox` shows the policy; `/sandbox workspace` / `/sandbox off` change it and persist to
  `config.json`.
- The **terminal tool is not sandboxed** — without an OS container a shell can do anything. That is
  documented rather than pretended; the terminal approval gate remains the control there.

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
- **Delegation**: `delegate_task` (foreground batches or `background: true`, `workspace:`
  `inherit|branch|share`, `agent:` custom definition) — see §5d and §5e.
- **Web**: `web_search`, `web_extract` (always available), and `browser_exec` /
  `browser_screenshot` which are **on demand** — locked until `/browser <task>` unlocks the session.
  Screenshots save into the current turn's artifact directory (http/https only).
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

`/artifacts` lives in the shared command handler (`vallenagent/src/core/commands.ts`), so the
terminal and the Telegram gateway behave the same. `/plan` (including `go/next/edit/skip/stop/status`)
is terminal-local because it drives the REPL's turn loop; the pure state machine it uses lives in
`vallenagent/src/agent/plan_mode.ts`. The registry for autocomplete is `cli-suggest.mjs`; `HELP` is in
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
| Plan-mode behavior | `agent/plan_mode.ts` (pure) + `cli-commands.mjs` wiring + tests |
| Subagent behaviour | `agent/subagent_registry.ts` (state) + `agent/worktree.ts` (isolation) |
| Agent routing | `agent/custom_agents.ts` (definitions + planner) |
| Browser gating | `core/browser_gate.ts` + `/browser` command |
| Sandbox behaviour | `core/sandbox.ts` + guards in `file_tools.ts` |
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
| `/artifacts` says "No artifacts yet" | the turn changed no files, ran no verification, and captured no screenshot — nothing to record |
| Screenshot tool fails | playwright missing (`pip install playwright && playwright install chromium`) or the page did not load |
| `/agents` is empty after a delegation | the subagent ran in the foreground (no `background: true`) — those are not registered |
| `workspace="branch"` fails | the working directory is not a git repository, or `git worktree add` failed (dirty index, branch exists) |
| A worktree keeps the branch after a run | by design; `/agents clean` removes finished worktrees |
| Browser tool says "on demand and currently locked" | run `/browser <task>`; use `web_search`/`web_extract` for read-only research |
| A custom agent never gets picked | its `description` must contain the words the task uses; two distinct matches are required |
| A routed agent cannot use a tool | its `tools:` list becomes the subagent whitelist — add the tool name there |
| "Path is outside the sandbox" | a subagent tried to write outside its worktree, or `/sandbox workspace` is on; write inside the root or run `/sandbox off` |
| Writes to `/tmp` fail after enabling the sandbox | expected — add the path to the workspace or turn the sandbox off |
