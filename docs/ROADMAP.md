# ROADMAP.md — work plan until VallenEmperor is peer-level

> **Ringkasan untuk owner (Bahasa Indonesia).**
> Dokumen ini adalah daftar pekerjaan yang **belum** dikerjakan, diurutkan berdasarkan prioritas.
> Setiap item punya: alasan, file yang disentuh, kriteria selesai (acceptance), perkiraan effort, dan
> risiko. AI mana pun yang membuka sesi baru cukup baca `AGENTS.md` → `RULES.md` → **dokumen ini**,
> lalu kerjakan item paling atas yang statusnya belum `[x]`. Jangan mengerjakan item P2 sebelum P0/P1
> selesai tanpa izin owner. Setiap item selesai: centang di sini, tambah catatan bukti (angka test),
> dan ikuti alur rilis di `docs/RELEASING.md` (owner yang menekan tombol publish).

Companion documents (read before designing anything new) — index: **[REFERENCES.md](REFERENCES.md)**:

- **[REFERENCE-HERMES.md](REFERENCE-HERMES.md)** — Hermes Agent: ≈70 CLI commands, ≈90 slash commands,
  35 toolsets, mapped to us with adopt/adapt/ignore verdicts.
- **[REFERENCE-ANTIGRAVITY.md](REFERENCE-ANTIGRAVITY.md)** — Antigravity CLI: full slash-command
  inventory, subagents, artifacts, permissions/sandbox.
- **[COMPARE-HERMES-CORE.md](COMPARE-HERMES-CORE.md)** — deep dive on file tools (read/write/patch/
  search) and the self-improvement review: why Hermes is more mature, gap by gap.
- **[REFERENCE-OPENCODE.md](REFERENCE-OPENCODE.md)** — opencode: config-surface inventory plus a
  cross-reference table of where all three peers agree (the strongest ordering signal).

Purpose: the single source of truth for **what to build next** and **how we know it is done**. Status
snapshots live in `docs/PROJECT.md`; rules live in `RULES.md`; this file is the backlog.

---

## 1. North star

Be the terminal agent a developer keeps open all day, with the discipline of Antigravity (plan →
review → execute → prove) and the portability of Hermes/opencode (any provider, any platform, any
surface) — without pretending to be an IDE.

Positioning, in one line:

> **Plan-first, artifact-proven, sandboxed terminal agent with parallel subagents and live model routing.**

Three properties we refuse to trade away:

1. **Evidence over claims** — every turn that changes something leaves a reviewable artifact.
2. **Owner-gated releases** — nothing ships without explicit approval.
3. **Honest limits** — if something is not sandboxed, the docs say so.

---

## 2. Where we are (shipped)

| Version | Milestone |
| --- | --- |
| `999.999.1004` | public baseline: model picker with live gateway fetch, cache + timeout |
| `999.999.1006` | turn artifacts (`walkthrough.md`, `index.json`) + `browser_screenshot` |
| `999.999.1007` | plan mode with milestone steering (`/plan go|next|edit|skip|stop|status`) |
| `999.999.1008` | background subagents, git worktree isolation, `/agents` panel |
| `999.999.1009` | custom agents + planner routing, on-demand browser gate, delegation triggers in the system prompt |
| `999.999.1010` | filesystem sandbox (subagents always confined, main agent opt-in) |
| `999.999.1012` | `/artifact` review panel, `/btw` side questions, `/fork` session cloning |

Legend for the matrix: ✅ shipped · 🟡 partial · ❌ missing.

| Capability | VallenEmperor | Antigravity CLI | Hermes | opencode |
| --- | --- | --- | --- | --- |
| Plan mode + artifact review | ✅ `/plan`, `/artifact` | ✅ planning mode + artifact panel | 🟡 plan prompts | 🟡 |
| Parallel subagents | ✅ background + worktree + `/agents` | ✅ agent manager, `invoke_subagent` | ✅ spawning | 🟡 |
| Custom agent definitions | ✅ `.agents/agents/*.md` + planner | ✅ `.agents/agents/*.md` + planner | ✅ profiles/skills | ✅ agents |
| On-demand browser | ✅ `/browser` gate | ✅ `/browser` hidden subagent | ✅ browser tools | 🟡 |
| Browser session recording | ❌ | ✅ WebM recordings | ❌ | ❌ |
| Filesystem sandbox | 🟡 file writes; terminal NOT sandboxed | ✅ OS sandbox presets | 🟡 approvals | 🟡 |
| First-run setup wizard | ❌ | ✅ (app install flow) | ✅ `hermes setup` | ✅ |
| Health check / diagnostics | ❌ | 🟡 | ✅ `hermes doctor` | 🟡 |
| Update notifier | ❌ | ✅ | ✅ | ✅ |
| Code search panel | ❌ | ✅ `/codesearch` | ✅ `search_files` + web UI | ✅ LSP + search |
| Reasoning effort control | ❌ | ✅ `/effort` | ✅ per-model | ✅ |
| Session fork / side question | ✅ `/fork`, `/btw` | ✅ `/fork`, `/btw` | ✅ | ✅ |
| Diff viewer | 🟡 text `/diff` | ✅ interactive | 🟡 | ✅ |
| Multi-platform gateway | ✅ Telegram | ❌ | ✅ 12+ platforms | ❌ |
| Skills + memory | ✅ skills, MEMORY.md, deep memory | ✅ skills/rules | ✅ skills hub + curator | 🟡 |
| Profiles (isolated instances) | ❌ | 🟡 workspaces | ✅ profiles | 🟡 |
| IDE/ACP integration | ❌ | ✅ IDE + SDK | ✅ ACP server | ✅ |
| Plugins / custom tools | 🟡 MCP + deferred tools | ✅ | ✅ plugins | ✅ plugins |

---

## 3. Backlog

Format per item: **why**, **scope**, **acceptance**, **effort** (S ≤ 1 session, M = 2–3, L = 4+),
**risk**. Items are ordered; do not skip ahead without owner approval.

### P0 — First-run experience (do first)

#### P0.1 `vallenemperor setup` wizard — ✅
- **Why.** A new user installs the package and lands in a REPL with no provider configured. That is
  the single biggest drop-off point, and Hermes/opencode both solve it with a wizard.
- **Scope.** `vallencli/src/cli-setup.mjs` (new), `vallencli/src/cli.mjs` (dispatch before REPL),
  `vallenagent/src/core/config.ts` (reuse `PROVIDER_PRESETS`), reuse `cli-model-picker.mjs` to fetch
  the live model list.
- **Flow.** pick preset → base_url (prefilled) → fetch `/models` → pick model → paste API key
  (hidden input, never echoed, never written to logs) → pick approval mode → write `config.json` →
  offer a smoke prompt.
- **Acceptance.**
  - `vallenemperor setup` on a clean `VALLENEMPEROR_HOME` produces a valid config that `config show`
    accepts, with the key stored only in the env-var slot the preset names.
  - Non-TTY: refuses with a clear message listing the flags/commands to use instead.
  - Unit tests: preset → config mapping, invalid input re-prompt, key never persisted.
- **Effort.** M · **Risk.** medium (interactive input on Windows; test with injected streams).

#### P0.2 `vallenemperor doctor` — ✅
- **Why.** Support load. When something breaks, users cannot tell whether it is Node, config, network,
  provider, skills, or MCP.
- **Scope.** `vallencli/src/cli-doctor.mjs` (new), reuse `collectHealthChecks` in `cli.mjs`.
- **Checks.** Node version ≥ 20 · config parse + `providers.active` resolvable · provider `/models`
  reachable with latency · API key present (presence only, never the value) · skills dir readable ·
  MCP servers status · write access to `~/.vallenemperor` · disk space · git available · optional
  `--json` output for bug reports.
- **Acceptance.** Every check returns `OK|WARN|FAIL` with a one-line fix hint; `--json` parses;
  exit code 1 when any FAIL; tests cover each branch with injected probes.
- **Effort.** S · **Risk.** low.

#### P0.3 Update notifier — ✅
- **Why.** Users stay on old versions (we shipped 7 versions in a day and the public one lagged).
- **Scope.** `vallencli/src/cli-update-check.mjs` (new), called once per day from `cli.mjs`.
- **Behaviour.** Compare `package.json` version with `npm view vallenemperor version` (cached 24 h in
  `~/.vallenemperor/update-check.json`), print one dim line when newer: `update available: x.y.z →
  npm i -g vallenemperor`. Never blocks startup, never fails loudly, respects
  `VALLENEMPEROR_NO_UPDATE_CHECK=1`.
- **Acceptance.** Cache hit makes zero network calls; offline is silent; tests with injected fetcher
  and clock.
- **Effort.** S · **Risk.** low.

**Evidence (P0.1–P0.3 — done).** `vallencli/tests/setup_doctor_update.test.mjs` (8 tests): the wizard
walks preset → base URL → model (live list with a manual fallback when the endpoint is offline) →
approval and writes a valid config patch; non-TTY refuses with the `config set` alternative; doctor
reports FAIL/WARN/OK per check with fixes and a JSON mode; the update check caches for 24 h (second
call makes no network request), formats `update available: x → y`, honours
`VALLENEMPEROR_NO_UPDATE_CHECK=1`, and `update --check` / install paths both work. Suite at the time:
**365/365 + 131/131**.

### P1 — Parity with Antigravity CLI

#### P1.1 `/codesearch <query>` — ✅
- **Why.** `search_files` exists for the agent, but the user has no fast way to search the workspace
  from inside the REPL.
- **Scope.** `vallencli/src/cli-codesearch.mjs` (new), command registration in
  `vallenagent/src/core/commands.ts`, reuse `search_files` internals.
- **Behaviour.** ripgrep-style search across the workspace, grouped by file, `↑/↓` to move, `Enter`
  opens the hit in a preview pane (with line numbers), `Esc` closes; non-TTY prints the flat result
  list.
- **Acceptance.** Respects `.gitignore`; binary files skipped; preview shows ±3 lines of context;
  tests cover grouping, preview extraction, and non-TTY output.
- **Effort.** M · **Risk.** medium (TUI key handling).

#### P1.2 `/effort <low|medium|high>` — ✅
- **Why.** Reasoning budget is the biggest cost/quality lever, and every peer CLI exposes it.
- **Scope.** `vallenagent/src/core/types.ts` (`reasoning_effort`), `providers/providers.ts` (pass
  `reasoning_effort` in the OpenAI-compatible payload when set), command in `core/commands.ts`,
  status-bar hint in `cli.mjs`.
- **Acceptance.** Value reaches the provider request (asserted on a captured payload); unsupported
  providers ignore it without error; `/effort` with no argument prints the current level; config
  persists.
- **Effort.** S · **Risk.** low-medium (provider variance).

#### P1.3 Interactive `/diff` viewer — 🟡
- **Why.** `/diff` currently prints text; checkpoints already exist, so this is presentation work.
- **Scope.** `vallencli/src/cli-diff-viewer.mjs` (new), wire from `/diff`.
- **Behaviour.** Per-turn file list → per-file unified diff with syntax colouring → `n`/`p` to move
  between files, `u` to undo that file (existing checkpoint API), `Esc` to exit.
- **Acceptance.** Undo restores exactly the checkpointed content; tests cover navigation state and
  undo call; non-TTY keeps the current text output.
- **Effort.** M · **Risk.** medium (undo must not be reachable by accident).

#### P1.4 `/copy [n]` — ✅
- **Why.** Copying the last answer is the most-used utility in every peer CLI.
- **Scope.** `cli-commands.mjs` + clipboard helper (OSC 52 fallback, `pbcopy`/`clip`/`xclip`).
- **Acceptance.** Works over SSH via OSC 52; reports which mechanism was used; tests with an injected
  clipboard writer.
- **Effort.** S · **Risk.** low.

### P1b — Core tool maturity (Hermes-informed, see COMPARE-HERMES-CORE.md)

The file tools and the self-improvement loop are where Hermes is clearly ahead. These items make our
tools stateful (dedup/staleness/locks) and make the learning loop trustworthy.

| # | Item | Why | Effort | Status |
| --- | --- | --- | --- | --- |
| P1b.1 | Read dedup + loop detection: re-reading an unchanged file returns a stub; `read → read → read` is detected | stops silent context burn; Hermes keeps this state across compaction | M | `[x]` |
| P1b.2 | Staleness warning on every patch (not only when `expected_hash` is passed) | stale edits are our most expensive failure | S | `[x]` |
| P1b.3 | Sensitive-path deny list (`.ssh`, `.env`, `*.pem`, keychains) + protected instruction files always ask | blocks credential exfiltration and self-rewriting of `AGENTS.md`/`RULES.md` | S | `[x]` |
| P1b.4 | Per-path write lock for concurrent subagents | worktree isolation does not protect a shared file | S–M | `[x]` |
| P1b.5 | Git diff modes for `/diff` (`working` / `staged` / `all` / `session`, untracked folded in) | users expect `git diff` semantics | S | `[x]` |
| P1b.6 | Review prompt: DO-NOT-CAPTURE list + lesson-layer contract (procedure-first, pitfall = rule + why, no PR numbers, one rule per lesson, fix in place) | this is why Hermes skills read like a handbook and ours drift into logs | S | `[x]` |
| P1b.7 | Cache-aware review fork (inherit provider/model/cached system prompt) | makes frequent reviews affordable | M | `[x]` |
| P1b.8 | Pending/staged **memory** writes (`pending/memory/<id>.json`, `/memory pending|approve|reject`) | review before a lesson becomes permanent | M | `[x]` |
| P1b.10 | Staged **skill** writes (needs a skill authoring tool first: today skills are plain files) | same checkpoint for skills | M | `[ ]` |
| P1b.9 | `/learn <source>` — capture a session/doc/dir as a reusable skill | the highest-intent learning request has no path today | S | `[x]` |

**Evidence (P1b.1–P1b.9 — done; P1b.10 open).** `vallenagent/tests/tool_maturity.test.mjs` (6 tests):
duplicate read returns a stub (`content` omitted, `sha256` kept) and `force: true` re-reads; three
identical reads in a row are flagged as a loop while a different tool resets the streak; `.env`,
`.ssh/*`, `*.pem`, `.npmrc` are hard-denied; `AGENTS.md`/`RULES.md`/`CLAUDE.md`/`GEMINI.md`/`SOUL.md`
are denied unless `VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS=1`; a patch against externally changed
content is refused with "changed since read_file"; the review prompt contains the DO-NOT-CAPTURE and
SKILL SHAPE contracts. `vallenagent/tests/working_diff.test.mjs` (3 tests) covers `/diff working|staged|all`:
modified + untracked files, staged-only, and a clean failure outside a git repo.
`tests/path_lock_learn.test.mjs` (5 tests) proves the per-path lock: same path serialises in order,
different paths do not block, a failed write does not block the next, locks are released, and the
`/learn` prompt carries the authoring standards. `/learn` wiring is covered by
`vallencli/tests/learn_command.test.mjs`. `tests/pending_writes.test.mjs` (4 tests) covers staged memory
writes: staging records/list/read/remove, the memory tool stages instead of writing when
`write_approval.memory` is on, `/memory pending|approve|reject` apply and discard end to end, and the
review fork reuses the parent provider instance (cache-aware). Suite at the time: **374/374 + 131/131**.

Acceptance for the whole package: a scripted session that re-reads a file twice must produce a stub on
the second read; a patch against externally changed content must be refused with a staleness message;
a write to `.ssh/id_rsa` must be denied; two concurrent subagents writing one file must serialize; a
review run must produce zero writes when only environment failures occurred.

### P1c — Cross-peer table stakes (see docs/REFERENCES.md §3)

Capabilities that at least two of Hermes / Antigravity / opencode / Claude Code / Codex / Gemini /
Aider ship. They are not differentiators — they are the price of entry.

| # | Item | Why | Effort | Status |
| --- | --- | --- | --- | --- |
| R29 | **Hooks**: `session_start`, `user_prompt`, `pre_tool`, `post_tool`, `turn_end`, `session_end`; handler = shell command with JSON stdin/stdout; can block or rewrite | policy, formatting, audit, notifications without patching core; shipped by Claude Code, Gemini, Hermes, Antigravity | M | `[x]` |
| R30 | **Repo map**: regex symbol map (classes, functions, signatures) ranked by relevance and token-budgeted, injected per request + `repo_map` tool | the agent stops grepping blind on large repos; Aider's biggest quality lever | L | `[x]` |
| R31 | **Permissions panel**: one reviewable place showing the effective rule per tool/path, replacing the `/auto` + `/sandbox` split | Codex, Claude Code, Gemini, opencode all expose this | M | `[x]` |
| R33 | **Headless contract**: `-p --json` with stable exit codes (0 ok, 1 agent error, 2 usage) | CI/pipeline use; Codex `exec`, Gemini headless | S | `[x]` |

**Evidence (P1.1, P1.2, P1.4 — done).** `vallenagent/tests/p1_features.test.mjs` (5 tests): workspace
search groups hits by file with line numbers and context, skips `node_modules`/binary files, respects
the limit and marks truncation; `/codesearch` and `/effort` work through the shared handler and the
effort value is persisted; a captured provider payload proves `reasoning_effort` reaches the request;
clipboard prefers the platform tool and falls back to OSC 52 (encoded sequence asserted). Suite at the
time: **370/370 + 131/131**. `/diff` interactive viewer (P1.3) is still open.

**Evidence (R31, R33 — done).** `/permissions` prints approval, filesystem mode + roots, subagent
confinement, browser gate, credential/instruction rules and staged-write status in one block.
`-p --json` emits `{ok, response, completionStatus, iterations, toolCalls, tokens, artifacts}` with
exit 1 on `incomplete` or a denied tool; the shape is asserted by
`vallencli/tests/setup_doctor_update.test.mjs`. Suite at the time: **374/374 + 133/133**.

**Evidence (R29, R30 — done).** `vallenagent/tests/hooks.test.mjs` (5 tests): hooks receive a JSON
payload, a `{"decision":"block"}` stops the tool (integration test proves the file is never written),
matchers filter by tool name, non-zero exits are reported not thrown, timeouts never block.
`vallenagent/tests/repo_map.test.mjs` (4 tests): per-language symbol extraction (TS/JS/Python),
ignored dirs skipped, budget truncation, relevance ranking, the `repo_map` tool payload, and the
system-prompt injection when `repo_map.enabled` is on. Suite at the time: **383/383 + 133/133**.

**Evidence (R3, R4, R12, R13, R21, R25 — done).** `/save md|json [file] [redact]` exports the
transcript (secrets scrubbed: `sk-`, `ghp_`, `npm_`, `AKIA`, `Bearer`), `/title` names the session,
`/history` shows recent messages, `/prompt` composes in `$EDITOR` and sends the buffer, `/<name>`
runs a `.vallenemperor/commands/*.md` template with `$ARGUMENTS`, and `vallenemperor completion
bash|zsh|fish` prints a script. Tests: `vallenagent/tests/session_ux.test.mjs` (2),
`vallencli/tests/session_commands.test.mjs` (4). `vallenemperor update` and `/learn` were shipped in
earlier batches and are ticked here for accuracy. Suite at the time: **385/385 + 137/137**.

**Evidence (R1, R5, R8 — done).** `/steer <note>` queues a mid-turn note that is injected as a
`system` message right after the next tool batch (proved by a captured second request); `/<skill-name>`
runs a loaded skill with `Task: <args>`; `/context all` reports window usage, system/history tokens,
skills index cost, tool-schema cost and every context file with a token estimate (walks up the tree,
includes `.cursor/rules/*.mdc`). Tests: `vallenagent/tests/steer_context.test.mjs` (3) and
`vallencli/tests/session_commands.test.mjs` (5). Suite at the time: **388/388 + 138/138**.

**Evidence (R2, R6, R7 — done).** `/rewind` lists user prompts and cuts the conversation back to
before prompt *n* (`AIAgent.rewindToPrompt`), `/rewind fork n` forks first so the original survives;
`/goal` keeps a standing objective, and after each turn an auxiliary judge (`agent/goal.ts`) answers
DONE/CONTINUE — a broken judge fails safe to DONE, and the continuation prompt caps at `maxTurns`
(default 20). `/queue add|list|rm|clear` feeds a prompt queue that drains after the current turn.
Tests: `vallenagent/tests/goal_rewind.test.mjs` (3) and `vallencli/tests/session_commands.test.mjs`
(6). Suite at the time: **391/391 + 139/139**.

**Evidence (R10, R11, R23, R24 — done).** `vallenemperor sessions list|show|export|prune` browses and
exports saved sessions (redacted). `prompt-size` reports system/schema/skill token costs, `insights`
summarises activity, `logs` lists log files, `dump` prints a paste-safe config summary with keys
redacted. `formatter.command` + `formatter.extensions` runs the project formatter after each edit
(best-effort, never fatal). `/grill-me` interviews one question at a time with a recommended answer.
Tests: `vallenagent/tests/formatter_grill.test.mjs` (2), `vallencli/tests/diagnostics_sessions.test.mjs`
(4). Suite at the time: **393/393 + 143/143**.

**Evidence (R9, R22 — done).** `tool_policy` maps a tool name to `allow|ask|deny`; `deny` blocks before
anything runs (proved by a file that never appears), `ask` forces the approval bridge *and* sequential
execution so parallel batches cannot bypass it, and `/policy` views/sets/clears rules (persisted).
`/worktree new [name]` creates a git worktree, retargets the session cwd and lists worktrees.
Tests: `vallenagent/tests/policy_worktree.test.mjs` (4). Suite at the time: **397/397 + 143/143**.

### P2 — Differentiators (only after P0/P1)

#### P2.1 Browser session recording (WebM) — ❌
- **Why.** Antigravity records browser subagent actions; screenshots alone cannot show a flow.
- **Scope.** `browser_tools.ts` (record via Playwright `record_video_dir`), artifact kind `recording`,
  ffmpeg presence check, `/artifact` playback hint.
- **Acceptance.** Recording saved into the turn artifact dir, listed by `/artifact`, skipped cleanly
  with a hint when ffmpeg is missing.
- **Effort.** M · **Risk.** high (codec/platform variance, storage size).

#### P2.2 Nested agents (depth > 1) — ❌
- **Why.** Antigravity allows subagents that spawn their own subagents; ours is capped at one level.
- **Scope.** `integration_tools.ts` (allow `delegate_task` when `isSubagent` and depth < 2),
  registry depth field, `/agents` indentation.
- **Acceptance.** Depth limit enforced and reported; cancellation cascades; no runaway spawn (hard cap
  on total active runs).
- **Effort.** M · **Risk.** high (runaway cost, deadlocks).

#### P2.3 Profiles (isolated instances) — ❌
- **Why.** Hermes profiles let one machine run separate configs/sessions/skills per project or client.
- **Scope.** `core/config.ts` (`--profile <name>` → `<home>/profiles/<name>/`), CLI flag, docs.
- **Acceptance.** Two profiles never share sessions, skills, memory, or config; `--profile` respected
  by every command; migration path for the default profile.
- **Effort.** M · **Risk.** medium (path plumbing everywhere).

#### P2.4 ACP / IDE bridge — ❌
- **Why.** Hermes and opencode both expose an IDE surface; this is the difference between "terminal
  tool" and "tool I use inside my editor".
- **Scope.** new `vallenagent/src/acp/` server (JSON-RPC over stdio), docs for VS Code/Zed wiring.
- **Acceptance.** An editor session can open, send a prompt, receive streaming text + tool events,
  and approve a tool call; tests drive the protocol with a fake client.
- **Effort.** L · **Risk.** high (protocol surface, long-term maintenance).

#### P2.5 Terminal sandbox — ❌
- **Why.** The only honest way to close the sandbox gap; today the terminal can do anything.
- **Scope.** platform-specific execution wrapper (bubblewrap on Linux, sandbox-exec on macOS,
  job objects on Windows) behind `security.terminal: 'sandbox'`, with a clear fallback.
- **Acceptance.** Writes outside the workspace fail inside the sandbox; fallback path is explicit in
  `doctor`; tests gated per platform.
- **Effort.** L · **Risk.** high (OS variance; must never silently weaken).

---

### P3 — Reference-informed backlog (from Hermes)

Merged from `docs/REFERENCE-HERMES.md`. Each item is terminal-native and independently shippable.
The owner may promote any of these into P1 by saying so; otherwise they follow the order below.

| # | Item | Why it matters | Effort | Status |
| --- | --- | --- | --- | --- |
| R1 | `/steer <text>` — inject a note after the next tool call, no interrupt | mid-turn control is the top ergonomic gap | M | `[x]` |
| R2 | `/rewind [fork N]` — transcript browser: edit a past prompt or branch before it | fixes wrong turns without losing work | M | `[x]` |
| R3 | `/save md\|json [redact]` — export the transcript | sharing, bug reports, redaction | S | `[x]` |
| R4 | `/title`, `/history`, `/prompt` (`$EDITOR` compose) | tiny QoL wins | S | `[x]` |
| R5 | `/<skill-name>` — invoke a skill directly as a command | skills become first-class commands | S | `[x]` |
| R6 | `/goal` + `/subgoal` with an auxiliary judge loop | long-horizon autonomy with a stop condition | M | `[x]` |
| R7 | `/queue` management (list/edit/rm/move/clear) | multi-prompt workflow while a turn runs | S | `[x]` |
| R8 | `/context all` per-file context breakdown | answers "why is my AGENTS.md ignored?" | S | `[x]` |
| R9 | `/worktree new\|list` for the main session | parallel human work without stashing | M | `[x]` |
| R10 | `vallenemperor sessions` (browse/export/prune) | session hygiene | S | `[x]` |
| R11 | `prompt-size`, `insights`, `logs`, `dump` diagnostics | support and cost visibility | S–M | `[x]` |
| R12 | `vallenemperor completion` (bash/zsh/fish) | terminal ergonomics | S | `[x]` |
| R13 | `vallenemperor update` (+ `/update`) | self-update without npm knowledge | S | `[x]` |
| R14 | LSP tool (semantic diagnostics beyond tsc) | non-TypeScript projects | L | `[ ]` |
| R15 | Curator — auto-archive stale skills | keeps the skill index lean | M | `[ ]` |
| R16 | Profiles (`--profile`) | isolated config/sessions/skills | M | `[ ]` |
| R17 | ACP server for editors | editor integration | L | `[ ]` |
| R18 | `x_search` + `/fast` provider flags | extra sources / latency control | S | `[ ]` |
| R19 | Approval mining (propose allowlist from history) | fewer prompts over time | M | `[ ]` |
| R20 | `/handoff <platform>` | move a CLI session to Telegram | M | `[ ]` |
| R21 | User-defined slash commands (`.vallenemperor/commands/*.md` → `/name`) | all three peers ship it; cheapest workflow win | S | `[x]` |
| R22 | Rule-based tool policies (allow/ask/deny per tool or path) | replaces today's global modes with per-tool rules | M | `[x]` |
| R23 | Formatter hook after edits (respect the project's formatter) | keeps diffs clean without manual runs | S | `[x]` |
| R24 | `/grill-me` — interview the user one question at a time before starting | fits our clarify policy; prevents wrong builds | S | `[x]` |
| R25 | `/learn` — turn corrections into skills/rules through a reviewable proposal | closes the self-improvement loop | M | `[x]` |
| R26 | Skill provenance (who/when/why) + `/journey` learning timeline | audit and roll back a bad lesson | M | `[ ]` |
| R27 | Curator — archive stale skills by usage | keeps the skill index lean | M | `[ ]` |
| R28 | Skill-index budget/delta tracking | index growth silently eats the context window | S | `[ ]` |
| R32 | Background agent view (dashboard over the existing subagent registry) | Claude Code, Hermes, Antigravity all expose a monitor | M | `[ ]` |
| R34 | Extension manifest: one installable unit carrying tools + commands + skills | Gemini extensions, Hermes plugins, opencode plugins | M | `[ ]` |

Deliberately not on this list (see `REFERENCE-HERMES.md` §6): desktop app, web dashboard, pets,
skins, voice/wake word, video generation, 20+ messaging platforms, Python library, API server,
kanban board, egress proxy.

## 4. Release plan

| Package | Contents | Target |
| --- | --- | --- |
| **A** | P0.1 setup · P0.2 doctor · P0.3 update notifier · R3 `/save` · R4 `/title`,`/history`,`/prompt` · R12 completion | next release |
| **B** | **P1b.1–P1b.6 (tool maturity)** · P1.1 codesearch · P1.2 effort · P1.3 diff viewer · P1.4 copy · R1 `/steer` · R5 `/<skill>` · R8 `/context all` · R10 sessions · R33 headless | after A |
| **C** | **P1b.7–P1b.9 (learning loop)** · **R29 hooks** · **R31 permissions panel** · P2.1 recording · P2.2 nested · P2.3 profiles · P2.4 ACP · P2.5 terminal sandbox · R2 `/rewind` · R6 `/goal` · R9 `/worktree` · R26–R28 | after B |
| **D** | R11 diagnostics · R13 update · R14 LSP · R15 curator · R17 ACP · R19 approval mining · R20 handoff · R21 custom commands · R22 tool policies · R23 formatter · R24 grill-me · R25 learn · **R30 repo map** · R32 agent view · R34 extension manifest | later |

Each package: build → typecheck → tests → version bump → `npm install -g .` → smoke test → **owner
approval** → commit/push → publish → approve staging → verify from the registry
(`docs/RELEASING.md`).

---

## 5. Non-goals (do not build without a new decision)

- A full GUI/desktop app. The terminal is the product; artifacts are the interface.
- Bundling an LLM. Provider-agnostic is the moat.
- Auto-publishing releases. The owner gate stays.
- Replacing git. Checkpoints complement git, they do not replace commits.
- Multi-tenant hosting. Single-user local tool.

---

## 6. Open questions for the owner

1. Should `security.filesystem` default to `workspace` for new installs (Antigravity-style), keeping
   existing configs unrestricted? Trade-off: safer by default vs. surprise for scripts writing to
   `/tmp`.
2. Do we keep the `999.999.x` test series, or move to semver `0.2.0` for the first "real" release
   once package A ships?
3. Is a Hermes-style multi-platform gateway (Discord/Slack) in scope, or is Telegram enough?
4. Should `/codesearch` use ripgrep when available and fall back to a JS walker, or stay JS-only for
   determinism?

---

## 6b. Cross-reference check (why this order)

When Antigravity, Hermes, and opencode all ship the same capability, that capability is table stakes,
not a differentiator. The three references agree on: code search panel, reasoning effort, interactive
diff, setup/doctor/update, long-horizon goals, rewind/branch, custom slash commands, tool policies,
LSP, worktrees, and subagent depth > 1. Those are ordered first (P0/P1/R1–R9, R21–R23).

Things only one peer ships (browser recordings, pets, voice, desktop app, hosted connectors) stay in
P2 or are explicitly ignored — they are not what makes the tool trustworthy.

## 7. How to pick up work (for the next AI session)

1. Read `AGENTS.md`, `RULES.md`, then this file.
2. Take the top unchecked item in P0 → P1 → P2 order (unless the owner says otherwise).
3. Write the failing test first, then the implementation (`docs/TESTING.md`).
4. Update this file: tick the checkbox, add a one-line evidence note with real test numbers.
5. Update `docs/PROJECT.md` if a module/command was added.
6. Report using the R12 template in `RULES.md` and **wait for approval** before publishing.

Checklist state lives here — never in chat history.
