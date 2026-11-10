# GEMINI-CLI.md — Gemini CLI inventory vs VallenEmperor

Source: `https://geminicli.com/docs/` (read 2026-11) and the repository README.

## 1. Feature list (as documented)

| Feature | What it is | Ours | Verdict |
| --- | --- | --- | --- |
| Extensions | installable bundles that add tools/capabilities | 🟡 MCP + skills + deferred tools (three mechanisms) | **adopt** one manifest (R34) |
| Agent Skills | specialized expertise loaded on demand | ✅ skills + relevance | parity |
| Checkpointing | automatic session snapshots | ✅ checkpoints + `/undo` | parity |
| Headless mode | programmatic/scripting interface | 🟡 `-p` | adopt JSON contract (R33) |
| Hooks | scripts at lifecycle points | ❌ | adopt (R29) |
| IDE integration | editor surface | ❌ | R17 (ACP) |
| MCP servers | remote agents/tools | ✅ `/mcp` | parity |
| Model routing | automatic fallback resilience | ✅ router/failover | parity |
| Model selection | pick model | ✅ `/model` picker | parity |
| Plan mode | read-only planning | ✅ `/plan` (+ step execution) | **we are ahead** |
| Subagents / remote subagents | specialized agents | ✅ local; ❌ remote | local parity; remote = skip |
| Rewind | rewind and replay sessions | 🟡 `/undo` only | adopt (R2) |
| Sandbox | isolated execution | 🟡 file writes only | adopt terminal sandbox (P2.5) |
| Context/memory management | persistent instructions + facts | ✅ MEMORY.md + deep memory | parity |
| Todos | task list | ✅ `todo_list` | parity |

## 2. What to copy

1. **Hooks** (R29) — same conclusion as Claude Code: two peers, table stakes.
2. **Extension manifest** (R34) — one installable unit that can carry tools, commands, and skills.
3. **Rewind/replay** (R2) — they expose it as a first-class session feature.
4. **Headless JSON** (R33).

## 3. What not to copy

Google-account auth, enterprise license gating, remote subagents.
