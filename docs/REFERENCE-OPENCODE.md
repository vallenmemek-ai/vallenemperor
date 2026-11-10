# REFERENCE-OPENCODE.md — opencode inventory vs VallenEmperor

Source: `https://opencode.ai/docs/` and `https://opencode.ai/docs/config/`, read 2026-11. opencode is
an open-source coding agent with CLI, desktop and web surfaces; this document covers the CLI shape.

Confidence note: the Antigravity and Hermes inventories were built from their full command references;
for opencode we read the intro + the configuration reference (which enumerates feature areas), so
individual slash commands are inferred from those areas. Verify against `opencode --help` before
copying a detail.

Legend: ✅ we have it · 🟡 partial · ❌ missing · 🚫 out of scope.

## 1. Feature areas (from the config reference)

| Config area | What it implies | Ours | Verdict |
| --- | --- | --- | --- |
| `shell` | default shell + args for terminal tool | 🟡 terminal tool | adapt (explicit shell config) |
| `model` / `providers` | provider-agnostic models, per-agent model | ✅ presets + `/model` picker | parity |
| `agent` / `agents` | named agents with their own prompt/tools/model | ✅ `.agents/agents/*.md` + planner | parity |
| `subagent depth` | nested delegation depth limit | ❌ (we cap at one level) | adopt (P2.2) |
| `permissions` / `policies` | per-tool allow/ask/deny rules | 🟡 approval modes + sandbox | **adopt** rule-based policies |
| `snapshots` | file snapshots for rollback | ✅ checkpoints + `/undo` | parity (ours is per-turn) |
| `worktrees` | git worktree workflow | 🟡 subagent worktrees only | adopt for main session (R9) |
| `skills` | skill loading | ✅ skills + hub | parity |
| `commands` | user-defined slash commands | ❌ | **adopt** — cheap, high value |
| `instructions` / `references` | context files (AGENTS.md etc.) + extra references | ✅ AGENTS.md chain, project context | parity |
| `mcp` | MCP servers | ✅ `/mcp` | parity |
| `compaction` / `background compaction` | context compaction (foreground + background) | 🟡 compaction exists, no background pass | adapt |
| `warming` | prompt-cache warming | ❌ | adapt later |
| `formatter` | auto-format after edits | ❌ | **adopt** (run project formatter post-edit) |
| `watcher` | file watcher for context | ❌ | 🚫 |
| `plugins` | plugin system | 🟡 MCP + deferred tools | adapt later |
| `search` | code search settings | 🟡 `search_files` | adopt panel (P1.1) |
| `todos` | todo list tool | ✅ `todo_list` | parity |
| `files` | file include/exclude rules | 🟡 `.gitignore` respected | adapt |
| `image generation` | image gen provider | 🟡 media tools | parity |
| `output` | output formatting | ✅ markdown renderer | parity |
| `updates` | self-update | ❌ | adopt (P0.3/R13) |
| `username` | identity for sharing | ❌ | 🚫 |
| `media` | media handling | 🟡 vision/image | parity |

## 2. Surfaces

| opencode | Ours | Verdict |
| --- | --- | --- |
| Terminal TUI | ✅ REPL (rich line UI) | parity |
| Desktop app | ❌ | 🚫 |
| Web app | ❌ | 🚫 |
| LSP integration | ❌ | adopt (R14) |
| Session share links | ❌ | adapt (`/save` + optional upload) |

## 3. What to copy, in order

1. **User-defined slash commands** (`.vallenemperor/commands/*.md` → `/name`) — cheapest big win.
2. **Rule-based tool policies** (allow/ask/deny per tool or path) — we only have global modes.
3. **Formatter hook** after edits (respect the project's own formatter).
4. **`/codesearch`** panel (shared with the Antigravity shortlist).
5. **Subagent depth** (shared with P2.2).
6. **Worktrees for the main session** (R9).

## 4. What not to copy

Desktop/web apps, watcher-based context, share-link upload (privacy + infra), username identity.

## 5. Cross-reference: where the three peers agree

The same gaps show up in all three references — that is the strongest signal for ordering:

| Gap | Antigravity | Hermes | opencode | Our plan |
| --- | --- | --- | --- | --- |
| Code search panel | ✅ | ✅ | ✅ | P1.1 |
| Reasoning effort | ✅ | ✅ | 🟡 | P1.2 |
| Interactive diff | ✅ | ✅ | ✅ | P1.3 |
| Setup/doctor/update | ✅ | ✅ | ✅ | P0.1–P0.3 |
| Long-horizon goals | ✅ | ✅ | ❌ | R6 |
| Rewind/branch history | ✅ | ✅ | 🟡 | R2 |
| Custom slash commands | 🟡 | ✅ | ✅ | **new: R21** |
| Tool policies (allow/ask/deny) | ✅ | ✅ | ✅ | **new: R22** |
| Formatter after edits | ❌ | 🟡 | ✅ | **new: R23** |
| LSP | ❌ | ✅ | ✅ | R14 |
| Worktrees (main session) | 🟡 | ✅ | ✅ | R9 |
| Subagent depth > 1 | ✅ | ✅ | ✅ | P2.2 |
