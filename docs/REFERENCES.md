# REFERENCES.md — the reference library (read this first)

Everything we compare against, in one place. Goal: **never redesign a solved problem from memory.**

## 1. The index

| Peer | Document | What it covers | Depth |
| --- | --- | --- | --- |
| **Hermes Agent** (Nous Research) | [REFERENCE-HERMES.md](REFERENCE-HERMES.md) · [COMPARE-HERMES-CORE.md](COMPARE-HERMES-CORE.md) | ≈70 CLI commands, ≈90 slash commands, 35 toolsets; deep dive on file tools + self-improvement review | ★★★ read from local source (`/home/vallenganteng/Destop/hermes-agent-main`) |
| **Antigravity CLI** (Google) | [REFERENCE-ANTIGRAVITY.md](REFERENCE-ANTIGRAVITY.md) | full slash-command inventory, subagents, artifacts, permissions/sandbox | ★★★ official docs |
| **opencode** | [REFERENCE-OPENCODE.md](REFERENCE-OPENCODE.md) | config-surface inventory + cross-peer agreement table | ★★ docs (config reference) |
| **Claude Code** (Anthropic) | [references/CLAUDE-CODE.md](references/CLAUDE-CODE.md) | hooks lifecycle, subagents, permissions, skills | ★★★ official docs |
| **Codex CLI** (OpenAI) | [references/CODEX-CLI.md](references/CODEX-CLI.md) | sandbox/approvals model, `codex exec`, `/permissions`, reasoning effort | ★★ official docs |
| **Gemini CLI** (Google) | [references/GEMINI-CLI.md](references/GEMINI-CLI.md) | extensions, checkpointing, MCP, non-interactive mode | ★★ repo + docs |
| **Aider** | [references/AIDER.md](references/AIDER.md) | repository map (tree-sitter symbol map), edit formats, git-native workflow | ★★ docs |

## 2. How to use this library

1. Before designing a feature, find the same feature in at least two peers above.
2. If **two or more peers ship it**, it is table stakes → it belongs in `ROADMAP.md` P0/P1.
3. If **one peer ships it** and it does not fit a terminal-first agent, put it in P2 or write it into
   the "deliberately not copied" list.
4. Record the verdict in the peer document (✅ / 🟡 / ❌ / 🚫) and add the roadmap ID next to it.
5. Never copy code. Copy **the reason** the feature exists, then implement it in our architecture
   (`docs/PROJECT.md`).

## 3. Cross-peer adoption matrix (the short list)

Only capabilities that at least two peers ship. "ID" points at `ROADMAP.md`.

| Capability | Hermes | Antigravity | opencode | Claude Code | Codex | Gemini | ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Setup / doctor / update | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P0.1–P0.3 |
| Code search panel | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P1.1 |
| Reasoning effort | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | P1.2 |
| Interactive diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P1.3 |
| Custom slash commands | ✅ | 🟡 | ✅ | ✅ | 🟡 | ✅ | R21 |
| Subagents / delegation | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | done (P1b next) |
| Plan mode | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | done |
| Checkpoints / rollback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | done |
| Permissions panel / policies | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | R22, R31 |
| Hooks (lifecycle automation) | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | **R29 (new)** |
| Repo map / code graph | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | **R30 (new)** |
| Long-horizon goals | ✅ | ✅ | ❌ | 🟡 | 🟡 | 🟡 | R6 |
| Rewind / branch history | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ | R2 |
| LSP integration | ✅ | ❌ | ✅ | ✅ | ❌ | 🟡 | R14 |
| Worktrees | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 | R9 |
| Formatter after edits | 🟡 | ❌ | ✅ | ✅ | 🟡 | 🟡 | R23 |
| `/learn` → skill | ✅ | ✅ | 🟡 | ✅ | ❌ | 🟡 | P1b.9 |
| Background agent dashboard | ✅ | ✅ | 🟡 | ✅ | 🟡 | ❌ | **R32 (new)** |

## 4. Peer-specific differentiators worth stealing (single-source, high value)

| Capability | Who | Why it matters to us | ID |
| --- | --- | --- | --- |
| Repository map (symbol signatures, token-budgeted) | Aider | the agent stops grepping blind on big repos; complements `search_files` | R30 |
| Hooks with JSON I/O (shell/HTTP/MCP/prompt handlers) | Claude Code | policy, formatting, audit, notifications without touching core code | R29 |
| `codex exec`-style scriptable non-interactive mode | Codex | CI and pipeline usage (we have `-p`; needs exit codes + JSON output) | R33 |
| Permission presets + `/permissions` panel | Codex, Gemini | we have `/auto` + `/sandbox`; consolidate into one reviewable panel | R31 |
| Extension manifest (bundle tools+commands+skills) | Gemini CLI | one installable unit instead of three separate mechanisms | R34 |
| `AGENTS.md` `/init` generator | Codex, Claude Code | we have `/init`; needs to read the repo and propose rules | done / polish |

## 5. Deliberately not copied (recorded so nobody re-proposes it)

- Desktop/web apps, pets, skins, voice/wake-word, video generation (Hermes, Antigravity, opencode).
- 20+ messaging platforms; hosted connectors; kanban board (Hermes).
- Vendor-specific quota/credits UI (Antigravity, Codex).
- Cloud sessions / agent teams as a hosted product (Claude Code) — we do local background subagents.
- `watcher`-based context (opencode) and egress proxies (Hermes): infrastructure we cannot test.

## 6. Maintenance

When a peer ships something new and relevant:

1. Update that peer's document (inventory row + verdict).
2. If two peers now ship it, add a row to §3 and an item to `ROADMAP.md`.
3. Keep the docs factual: cite the page/source and the date read. No "I think it does X".
