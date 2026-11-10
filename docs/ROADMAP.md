# ROADMAP.md — work plan until VallenEmperor is peer-level

> **Ringkasan untuk owner (Bahasa Indonesia).**
> Dokumen ini adalah daftar pekerjaan yang **belum** dikerjakan, diurutkan berdasarkan prioritas.
> Setiap item punya: alasan, file yang disentuh, kriteria selesai (acceptance), perkiraan effort, dan
> risiko. AI mana pun yang membuka sesi baru cukup baca `AGENTS.md` → `RULES.md` → **dokumen ini**,
> lalu kerjakan item paling atas yang statusnya belum `[x]`. Jangan mengerjakan item P2 sebelum P0/P1
> selesai tanpa izin owner. Setiap item selesai: centang di sini, tambah catatan bukti (angka test),
> dan ikuti alur rilis di `docs/RELEASING.md` (owner yang menekan tombol publish).

Companion documents (read before designing anything new):

- **[REFERENCE-HERMES.md](REFERENCE-HERMES.md)** — Hermes Agent: ≈70 CLI commands, ≈90 slash commands,
  35 toolsets, mapped to us with adopt/adapt/ignore verdicts.
- **[REFERENCE-ANTIGRAVITY.md](REFERENCE-ANTIGRAVITY.md)** — Antigravity CLI: full slash-command
  inventory, subagents, artifacts, permissions/sandbox.
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

#### P0.1 `vallenemperor setup` wizard — ❌
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

#### P0.2 `vallenemperor doctor` — ❌
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

#### P0.3 Update notifier — ❌
- **Why.** Users stay on old versions (we shipped 7 versions in a day and the public one lagged).
- **Scope.** `vallencli/src/cli-update-check.mjs` (new), called once per day from `cli.mjs`.
- **Behaviour.** Compare `package.json` version with `npm view vallenemperor version` (cached 24 h in
  `~/.vallenemperor/update-check.json`), print one dim line when newer: `update available: x.y.z →
  npm i -g vallenemperor`. Never blocks startup, never fails loudly, respects
  `VALLENEMPEROR_NO_UPDATE_CHECK=1`.
- **Acceptance.** Cache hit makes zero network calls; offline is silent; tests with injected fetcher
  and clock.
- **Effort.** S · **Risk.** low.

### P1 — Parity with Antigravity CLI

#### P1.1 `/codesearch <query>` — ❌
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

#### P1.2 `/effort <low|medium|high>` — ❌
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

#### P1.4 `/copy [n]` — ❌
- **Why.** Copying the last answer is the most-used utility in every peer CLI.
- **Scope.** `cli-commands.mjs` + clipboard helper (OSC 52 fallback, `pbcopy`/`clip`/`xclip`).
- **Acceptance.** Works over SSH via OSC 52; reports which mechanism was used; tests with an injected
  clipboard writer.
- **Effort.** S · **Risk.** low.

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
| R1 | `/steer <text>` — inject a note after the next tool call, no interrupt | mid-turn control is the top ergonomic gap | M | `[ ]` |
| R2 | `/rewind [fork N]` — transcript browser: edit a past prompt or branch before it | fixes wrong turns without losing work | M | `[ ]` |
| R3 | `/save md\|json [redact]` — export the transcript | sharing, bug reports, redaction | S | `[ ]` |
| R4 | `/title`, `/history`, `/prompt` (`$EDITOR` compose) | tiny QoL wins | S | `[ ]` |
| R5 | `/<skill-name>` — invoke a skill directly as a command | skills become first-class commands | S | `[ ]` |
| R6 | `/goal` + `/subgoal` with an auxiliary judge loop | long-horizon autonomy with a stop condition | M | `[ ]` |
| R7 | `/queue` management (list/edit/rm/move/clear) | multi-prompt workflow while a turn runs | S | `[ ]` |
| R8 | `/context all` per-file context breakdown | answers "why is my AGENTS.md ignored?" | S | `[ ]` |
| R9 | `/worktree new\|list` for the main session | parallel human work without stashing | M | `[ ]` |
| R10 | `vallenemperor sessions` (browse/export/prune) + `/autoprune` | session hygiene | S | `[ ]` |
| R11 | `prompt-size`, `insights`, `logs`, `dump` diagnostics | support and cost visibility | S–M | `[ ]` |
| R12 | `vallenemperor completion` (bash/zsh/fish) | terminal ergonomics | S | `[ ]` |
| R13 | `vallenemperor update` (+ `/update`) | self-update without npm knowledge | S | `[ ]` |
| R14 | LSP tool (semantic diagnostics beyond tsc) | non-TypeScript projects | L | `[ ]` |
| R15 | Curator — auto-archive stale skills | keeps the skill index lean | M | `[ ]` |
| R16 | Profiles (`--profile`) | isolated config/sessions/skills | M | `[ ]` |
| R17 | ACP server for editors | editor integration | L | `[ ]` |
| R18 | `x_search` + `/fast` provider flags | extra sources / latency control | S | `[ ]` |
| R19 | Approval mining (propose allowlist from history) | fewer prompts over time | M | `[ ]` |
| R20 | `/handoff <platform>` | move a CLI session to Telegram | M | `[ ]` |
| R21 | User-defined slash commands (`.vallenemperor/commands/*.md` → `/name`) | all three peers ship it; cheapest workflow win | S | `[ ]` |
| R22 | Rule-based tool policies (allow/ask/deny per tool or path) | replaces today's global modes with per-tool rules | M | `[ ]` |
| R23 | Formatter hook after edits (respect the project's formatter) | keeps diffs clean without manual runs | S | `[ ]` |
| R24 | `/grill-me` — interview the user one question at a time before starting | fits our clarify policy; prevents wrong builds | S | `[ ]` |
| R25 | `/learn` — turn corrections into skills/rules through a reviewable proposal | closes the self-improvement loop | M | `[ ]` |

Deliberately not on this list (see `REFERENCE-HERMES.md` §6): desktop app, web dashboard, pets,
skins, voice/wake word, video generation, 20+ messaging platforms, Python library, API server,
kanban board, egress proxy.

## 4. Release plan

| Package | Contents | Target |
| --- | --- | --- |
| **A** | P0.1 setup · P0.2 doctor · P0.3 update notifier · R3 `/save` · R4 `/title`,`/history`,`/prompt` · R12 completion | next release |
| **B** | P1.1 codesearch · P1.2 effort · P1.3 diff viewer · P1.4 copy · R1 `/steer` · R5 `/<skill>` · R8 `/context all` · R10 sessions | after A |
| **C** | P2.1 recording · P2.2 nested · P2.3 profiles · P2.4 ACP · P2.5 terminal sandbox · R2 `/rewind` · R6 `/goal` · R9 `/worktree` | after B |
| **D** | R11 diagnostics · R13 update · R14 LSP · R15 curator · R17 ACP · R19 approval mining · R20 handoff · R21 custom commands · R22 tool policies · R23 formatter · R24 grill-me · R25 learn | later |

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
