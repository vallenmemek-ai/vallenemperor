# REFERENCE-ANTIGRAVITY.md — Antigravity CLI inventory vs VallenEmperor

Source: `https://antigravity.google/docs/cli/reference` and the per-command pages
(`/docs/cli/commands/*`, `/docs/subagents`, `/docs/commands/browser`, `/docs/artifact*`), read
2026-11. Antigravity is Google's agent-first IDE **and** CLI; this document covers the CLI only,
because that is our shape.

Legend: ✅ we have it · 🟡 partial · ❌ missing · 🚫 out of scope.

## 1. Slash commands

| Command | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/agents` | Agent Manager: switch custom agents, monitor/terminate background subagents | ✅ `/agents` (list/show/stop/clean) | parity |
| `/artifact` | Artifact review panel (plans, diffs, screenshots, recordings) | 🟡 `/artifact` list + text preview | **upgrade to a panel** (P1.3-style) |
| `/boost <task>` | On-demand multi-agent deep-reasoning loop | ❌ | adapt later (multi-agent reasoning) |
| `/browser <task>` | Delegate to the hidden browser subagent | ✅ `/browser` (gate + task) | parity |
| `/btw <query>` | Side question without interrupting | ✅ `/btw` | parity |
| `/changelog` | Interactive release notes | ❌ | adopt (cheap, we have git log) |
| `/clear`, `/new` | Reset conversation | ✅ | — |
| `/codesearch <q>` (`/cs`, `/search`) | Interactive code search panel | ❌ | **adopt** (P1.1) |
| `/config` (`/settings`) | Interactive settings editor | 🟡 `config show/set` | adapt |
| `/context` | Context usage visualization panel | 🟡 `/context` numbers | adapt (per-file breakdown, see R8) |
| `/copy [n\|btw]` | Copy last/n-th answer | ❌ | adopt (P1.4) |
| `/credits` | Remaining quota | ❌ | 🚫 (vendor-specific) |
| `/diff` | Interactive diff viewer (turns/commits) | 🟡 text `/diff` | **adopt** interactive (P1.3) |
| `/effort [level]` | Reasoning effort (low…max) | ❌ | **adopt** (P1.2) |
| `/fork` (`/branch`) | Clone conversation into a parallel session | ✅ `/fork` | parity |
| `/goal <objective>` | Autonomous run until the goal is verified complete | ❌ | **adopt** (R6) |
| `/grill-me [task]` | Interview the user one question at a time before starting | ❌ | adapt (cheap, fits our clarify policy) |
| `/hooks` | Browse pre/post hooks | ❌ | adapt later |
| `/keybindings` | Keyboard shortcut editor | ❌ | 🚫 |
| `/learn [instruction]` | Turn session corrections into rules/skills (reviewable) | 🟡 background review + skills | **adopt** the proposal flow (R19) |
| `/logout` | Purge credentials | ❌ | adopt (with auth) |
| `/mcp` | MCP server manager | ✅ `/mcp` | parity |
| `/model` | Choose model (persists) | ✅ `/model` (live picker) | parity |
| `/open <path>` | Open path in the system editor | ❌ | adopt (tiny) |
| `/permissions` | Interactive tool permission manager | 🟡 `/auto`, `/sandbox` | adapt into one panel |
| `/plan [task]` | Draft a reviewable implementation plan | ✅ `/plan` (+ step execution) | **we are ahead** |
| `/plugin` | Plugin manager (install/enable/disable) | 🟡 MCP + deferred tools | adapt later |
| `/rename` | Rename session | ❌ | adopt (R4, with `/title`) |
| `/remote-control` | Drive the session from a browser | 🟡 Telegram gateway | adapt later |
| `/resume` | Conversation picker | ✅ `/resume` | parity |
| `/rewind` (`/undo`) | Roll back conversation to a previous message | 🟡 `/undo` (last exchange only) | **adopt** (R2) |
| `/schedule <when> <task>` | One-shot timer or cron | 🟡 `/schedule` | parity |
| `/skills` | Browse/reload skills | ✅ `/skills` | parity |
| `/statusline` | Status bar customization | 🟡 `/theme` | adapt |
| `/tasks` | Task Manager: background shell logs | 🟡 `process_manage` + `/output` | adapt |
| `/teamwork <task>` | Collaborative multi-agent teams | ❌ | 🚫 (paid vendor feature) |
| `/title [on/off]` | Window title | ❌ | adopt (R4) |
| `/usage` (`/quota`) | Quota usage | 🟡 `/stats` | adapt |
| `/voice` | Voice input / live mode | ❌ | 🚫 for now |

## 2. Tools & orchestration

| Capability | Antigravity | Ours | Verdict |
| --- | --- | --- | --- |
| `invoke_subagent` | workspace `inherit`/`branch`/`share`, clean context, monitoring | ✅ `delegate_task` (`workspace`, `background`) | parity |
| Custom agents | `.agents/agents/<name>.md` with `description`, `tools`, `model` | ✅ same layout + planner | parity |
| Agent Manager | `/agents` panel | ✅ `/agents` | parity |
| Artifacts | plans, diffs, diagrams, screenshots, browser **recordings** | 🟡 plans/diffs/screenshots (no recordings) | adopt recordings (P2.1) |
| Planning mode | plan artifact + pause for review | ✅ `/plan` + step steering | **we are ahead** |
| Browser control | hidden `browser` subagent, Chrome DevTools MCP, WebM recordings | 🟡 on-demand gate + screenshots | adopt recordings |
| Permissions & sandbox | OS-level sandbox presets (Auto/Turbo), bounded read/write | 🟡 file-write sandbox; terminal unconfined | adopt terminal sandbox (P2.5) |
| Remote control | drive desktop/CLI from a browser | 🟡 Telegram | adapt later |
| SDK | Python agents + hooks | ❌ | 🚫 |

## 3. What to copy, in order

1. `/codesearch` panel (P1.1) — the biggest daily-use gap.
2. `/effort` (P1.2) — cost/quality control.
3. Interactive `/diff` (P1.3) and `/artifact` panel upgrade.
4. `/goal` (R6) — long-horizon autonomy with verification.
5. `/rewind` (R2) — rollback/branch from a past message.
6. `/grill-me` — interview-first for underspecified tasks (fits our clarify policy).
7. `/learn` proposal flow (R19) — corrections become skills/rules with review.
8. Browser session recordings (P2.1) — only after the rest.

## 4. What not to copy

`/credits`, `/teamwork`, `/keybindings`, `/voice`, SDK, vendor-specific quota UI. They are tied to
Google's account/product model and add maintenance without portability.
