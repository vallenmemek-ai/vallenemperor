# REFERENCE-HERMES.md — what Hermes Agent ships, and what we should copy

Reference source: `/home/vallenganteng/Destop/hermes-agent-main` (Hermes Agent, Nous Research,
Python, ~297 MB working tree). Read for this document: `README.md`, the full `website/docs` tree
(≈220 pages), `website/docs/reference/cli-commands.md`, `website/docs/reference/slash-commands.md`,
`website/docs/reference/toolsets-reference.md`, `tools/`, `agent/`, `hermes_cli/`, `gateway/`.

Purpose: stop guessing. This is the inventory of what a mature peer agent ships, mapped against
VallenEmperor, with a verdict per area: **adopt**, **adapt**, or **ignore**.

Legend: ✅ we have it · 🟡 partial · ❌ missing · 🚫 deliberately out of scope.

---

## 1. Surfaces

| Hermes surface | VallenEmperor | Verdict |
| --- | --- | --- |
| Classic CLI REPL (`hermes chat`) | ✅ `vallenemperor` | — |
| Ink TUI (`display.interface: tui`) | ❌ (our REPL is a rich line UI) | 🚫 for now; polish REPL instead |
| Desktop app (Electron) | ❌ | 🚫 out of scope |
| Web dashboard (`hermes dashboard`) | ❌ | 🚫 |
| ACP server for editors (`hermes acp`) | ❌ | **adopt later** (P2.4) |
| API server (`hermes serve`) | ❌ | 🚫 |
| Messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email, IRC, LINE, Feishu, DingTalk, Teams, Google Chat, Mattermost, ntfy, QQ, SimpleX, Photon, Buzz, A2A, Relay…) | 🟡 Telegram only | **adapt**: 1–2 more platforms max (Discord, Slack) |
| Batch runner | ❌ | adapt if users ask |
| Python library / programmatic API | ❌ | 🚫 |

**Takeaway:** Hermes optimises breadth of surfaces. We optimise the terminal. The only surface worth
adding is **ACP** (editor integration), because it changes how the tool is used, not just where.

---

## 2. CLI command surface (top level)

Hermes ships ~70 subcommands. Grouped by function, with our status:

| Area | Hermes commands | Ours | Verdict |
| --- | --- | --- | --- |
| Chat / one-shot | `chat` | ✅ `-p`, REPL | — |
| Setup / config | `setup`, `model`, `config`, `auth`, `secrets`, `migrate`, `doctor`, `dump` | 🟡 `config show/set`, `/model`, `/token` | **adopt** `setup`, `doctor`, `dump` |
| Models | `model`, `moa`, `fallback`, `proxy` | 🟡 `/model`, provider presets | adapt `fallback` (we have router failover) |
| Sessions | `sessions`, `checkpoints`, `backup`, `import`, `logs` | 🟡 `/sessions`, `/checkpoints`, `/undo` | **adopt** `sessions` (browse/export/prune), `logs` |
| Autonomy | `cron`, `pause`, `resume`, `kanban`, `webhook`, `hooks` | 🟡 cron scheduler, `/schedule` | adapt `pause/resume` (emergency stop) |
| Skills | `skills`, `bundles`, `curator`, `journey` | 🟡 skills + hub + `/skills` | **adopt** `curator` (auto-archive stale skills) |
| Memory | `memory`, `journey` | ✅ MEMORY.md + deep memory | adapt providers later |
| Gateway | `gateway`, `pairing`, `send`, `peer`, `whatsapp*`, `slack` | 🟡 Telegram gateway | adapt `pairing`, `send` |
| Tools | `tools`, `toolsets` | ✅ registry + `/tools` | — |
| Extensibility | `plugins`, `blueprints`, `mcp`, `connectors` | 🟡 MCP, deferred tools | adapt plugins (P2) |
| Diagnostics | `doctor`, `status`, `usage`, `insights`, `prompt-size`, `debug`, `security audit` | 🟡 `/health`, `/stats` | **adopt** `doctor`, `insights`, `prompt-size` |
| Environment | `completion`, `update`, `uninstall`, `profile`, `project` | ❌ | **adopt** `completion`, `update`, `profile` |
| Other surfaces | `acp`, `serve`, `dashboard`, `desktop`, `webapp`, `computer-use`, `pets`, `skin`, `console` | ❌ | 🚫 except `acp` |

**Highest value for us (small effort, immediate payoff):** `setup`, `doctor`, `update`, `completion`,
`sessions` (export/prune), `prompt-size`, `insights`.

---

## 3. In-REPL slash commands (the real differentiator)

Hermes has ~90 slash commands. Mapped to us:

### 3.1 Session & context

| Hermes | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/rewind [N \| fork N]` | interactive transcript browser; edit a past prompt, truncating later messages, or fork before it | ❌ | **adopt** — our `/fork` is whole-session only |
| `/undo` | drop last exchange | ✅ | — |
| `/save <json\|md\|html>` | export transcript, with `redact` | ❌ | **adopt** — cheap, high value for sharing/debugging |
| `/snapshot create\|restore\|prune` | snapshot config/state DB | ❌ | adapt later |
| `/title` | name the session | ❌ | **adopt** (tiny) |
| `/compress [here [N] \| focus]` | manual compaction with a boundary | 🟡 `/compact` | adapt `here N` |
| `/context [all]` | visual context breakdown + per-file context listing | 🟡 `/context` (numbers only) | **adopt** the per-file breakdown ("why is my AGENTS.md ignored?") |
| `/status` + recap | session info + local recap (top tools, files touched) | 🟡 `/status` | adapt recap block |
| `/autoprune` | auto-delete old ended sessions | ❌ | adapt |
| `/history` | show transcript | ❌ | adopt (tiny) |
| `/prompt` (`$EDITOR` compose) | long prompts | ❌ | **adopt** (tiny, big UX win) |

### 3.2 Mid-turn control (we have almost none)

| Hermes | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/steer <text>` | inject a note that arrives after the next tool call, no interrupt | ❌ | **adopt** — high value, fits our turn loop |
| `/queue <prompt>` (+ list/edit/rm/move/clear) | queue prompts while a turn runs | 🟡 input queue exists, no management | **adopt** management |
| `/bg <prompt>` | run a prompt in a separate background session | 🟡 `delegate_task background` | adapt as `/bg` sugar |
| `/btw <q>` | side question from a read-only snapshot | ✅ | — |
| `/stop` | kill background processes | ✅ | — |
| `/busy [queue\|steer\|interrupt]` | what happens when you type while working | ❌ | **adopt** (tiny) |

### 3.3 Autonomy / long-running work

| Hermes | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/goal <text>` + `/subgoal` | standing goal; auxiliary judge decides DONE/CONTINUE, auto-continues up to N turns | ❌ | **adopt** — this is the "Ralph loop" pattern, natural fit for our verification gate |
| `/loop [interval] <prompt>` | re-run a prompt on a cadence until a condition | ❌ | adapt after `/goal` |
| `/heartbeat every <i> <prompt>` | recurring prompt into an idle session | 🟡 cron exists | adapt |
| `/plan` | plan mode | ✅ (ours is stronger: step execution) | — |
| `/review` | independent reviewer subagent over the last 10 messages | 🟡 `/review` = skill/memory review | **adopt** the reviewer-subagent meaning |
| `/refine` | run memory/skill self-improvement now | 🟡 background review | adapt |

### 3.4 Work & workspace

| Hermes | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/worktree new\|list` | create/switch git worktrees mid-session, retarget tools | 🟡 subagent worktrees only | **adopt** for the main session |
| `/handoff <platform>` | move a CLI session to a messaging platform | ❌ | adapt after gateway work |
| `/agents` (`/tasks`) | active agents/tasks | ✅ | — |
| `/branch` (`/fork`) | branch session | ✅ | — |
| `/init` | write project instructions | ✅ | — |
| `/commands [page]` | paginated command list | 🟡 `/help` | adapt pagination |
| `/<skill-name>` | invoke a skill directly as a command | ❌ | **adopt** — trivial and very useful |
| `/bundles` | group skills under one slash command | ❌ | adapt later |

### 3.5 Presentation & misc

| Hermes | Ours | Verdict |
| --- | --- | --- |
| `/verbose`, `/focus` | 🟡 verbose only | adapt `/focus` (reduced output) |
| `/reasoning [level]`, `/model --reasoning` | ❌ | **adopt** (`/effort`) |
| `/fast [normal\|fast\|auto]` | ❌ | ignore (provider-specific) |
| `/yolo`, `/approvals [manual\|smart\|off]` | 🟡 `/auto` | adapt naming only |
| `/skin`, `/theme`, `/timestamps`, `/indicator`, `/battery`, `/footer` | 🟡 `/theme` | adapt `/timestamps`, `/footer` |
| `/voice`, `/wake`, `/tts` | ❌ | 🚫 for now |
| `/pets` | ❌ | 🚫 |
| `/update`, `/restart`, `/debug` | ❌ | **adopt** `/update` (see update notifier) |
| `/suggestions` | ❌ | adapt later |
| `/journey` (learning timeline) | ❌ | adapt later (we have skill stats) |

---

## 4. Toolsets (Hermes) vs our tools

Hermes toolsets: `browser, clarify, code_execution, connections, coding, cronjob, debugging,
delegation, discord, discord_admin, feishu_doc, feishu_drive, file, computer_use, context_engine,
image_gen, video_gen, kanban, memory, desktop_ui, project, catalog, safe, search, session_search,
skills, terminal, todo, tts, vision, video, web, x_search`.

Ours: file, terminal/execute_code, web (search/extract/browser), mcp, state (todo/memory/deep
memory/clarify/skills/session), delegation, media (image/vision), integration.

| Gap | Verdict |
| --- | --- |
| `lsp` (semantic diagnostics) | **adopt** — we only have `tsc`; LSP would cover Python/Go/Rust |
| `computer_use` (desktop automation) | ignore (we are a terminal agent) |
| `x_search` | adapt (cheap: one more web source) |
| `image_gen`, `video_gen`, `tts` | 🟡 we have image/vision; TTS later |
| `kanban` (multi-profile board) | ignore for now |
| `project` (named multi-folder workspaces) | **adopt later** (fits `/cd` evolution) |
| `connections` (hosted connector accounts) | ignore |
| `cronjob` tool | 🟡 we have a scheduler; expose as a tool |

---

## 5. Architecture ideas worth copying

| Hermes mechanism | Why it matters | Verdict |
| --- | --- | --- |
| **Session state in SQLite** with FTS search, rewind, lineage | our sessions are JSON files; search exists but no rewind/lineage | **adopt** the rewind/lineage concept; SQLite migration only if needed |
| **Context compression pipeline** (micro-compaction, trajectory compression) | we have compaction, theirs is finer-grained | adapt micro-compaction |
| **Prompt-size breakdown** (`hermes prompt-size`) | answers "why is my prompt huge" offline | **adopt** (small) |
| **Credential pools + vault** | rotate multiple keys per provider | adapt (pools) |
| **Provider fallback chain** | we have a router; explicit chain config is clearer | adapt |
| **Profiles** | isolated instances (config/sessions/skills) | **adopt** (P2.3) |
| **Curator** (auto-archive stale skills) | keeps the skill index lean | **adopt** |
| **Approval mining** (`hermes approvals`) | turns approval history into allowlist proposals | adapt later |
| **Egress proxy / network isolation** | sandbox egress, credential injection | ignore (needs infra) |
| **Hooks / webhooks / blueprints** | event-driven automation | adapt later |
| **ACP server** | editor integration | **adopt** (P2.4) |
| **`/steer` mid-turn injection** | most requested ergonomic feature in agent CLIs | **adopt** |
| **`/goal` judge loop** | long-horizon autonomy with a stop condition | **adopt** |

---

## 6. What we deliberately do NOT copy

- Desktop app, web dashboard, pets, skins, voice/wake word, video generation.
- 20+ messaging platforms (Telegram + maybe Discord/Slack is enough).
- Python library surface, API server, kanban board, hosted connectors.
- Egress proxy / Docker network isolation (infrastructure-heavy, wrong shape for an npm CLI).

Rationale: each of those adds a surface to maintain and test. Our advantage is depth on the terminal
(turn loop discipline, artifacts, plan mode, sandboxed subagents), not breadth.

---

## 7. Adoption shortlist (feeds `docs/ROADMAP.md`)

Ordered by value ÷ effort. All are terminal-native.

| # | Item | Why | Effort |
| --- | --- | --- | --- |
| 1 | `vallenemperor setup` | first-run drop-off | M |
| 2 | `vallenemperor doctor` | support load | S |
| 3 | `vallenemperor update` + notifier | users lag versions | S |
| 4 | `/steer <text>` | mid-turn control, no interrupt | M |
| 5 | `/rewind [fork N]` | edit a past prompt / branch from it | M |
| 6 | `/save md\|json [redact]` | share/debug transcripts | S |
| 7 | `/title`, `/history`, `/prompt` | tiny QoL wins | S |
| 8 | `/<skill-name>` direct invocation | skills become commands | S |
| 9 | `/goal` + judge loop | long-horizon autonomy | M |
| 10 | `/codesearch` | parity search panel | M |
| 11 | `/effort` + `/reasoning` display | cost/quality control | S |
| 12 | `/context all` per-file breakdown | answers "why is my AGENTS.md ignored" | S |
| 13 | `/queue` management | multi-prompt workflow | S |
| 14 | `/worktree` for the main session | parallel human work | M |
| 15 | LSP tool | non-TS projects | L |
| 16 | Profiles | isolated instances | M |
| 17 | Curator | skill hygiene | M |
| 18 | ACP server | editor integration | L |
| 19 | `prompt-size`, `insights`, `logs`, `dump` | diagnostics suite | S–M |
| 20 | Shell completion (`completion`) | terminal ergonomics | S |

These are merged into the prioritized backlog in `docs/ROADMAP.md` (section "Reference-informed
backlog"), which remains the single source of truth for ordering.
