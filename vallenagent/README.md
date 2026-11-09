<p align="center">
  <img src="https://raw.githubusercontent.com/vallenmemek-ai/vallenemperor/main/icon/vallenemperor-192.png" width="120" alt="VallenEmperor" />
</p>

<h1 align="center">vallenagent</h1>

<p align="center"><strong>Agent core: turn loop, providers, tools, skills, memory, sessions, gateway.</strong></p>

<p align="center">
  <a href="../README.md">← Back to VallenEmperor</a>
</p>

---

`vallenagent` is the engine behind the `vallenemperor` CLI. It is a workspace package in this repo
(not published standalone); the CLI ships its compiled output as part of the `vallenemperor` npm
package.

## The turn, stage by stage

`AIAgent` runs one user message through explicit stages, each in its own module:

| Stage | Module | Responsibility |
| --- | --- | --- |
| Setup | `agent/turn_setup_phase.ts` | `/plan` rewrite, user message, auto-checklist, skill + deep-memory preload |
| Provider call | `agent/turn_provider_call.ts` | cache-marker retry, one compaction retry on overflow, truncated-answer continuation |
| Verification gate | `agent/turn_verification_gate.ts` | allow / nudge once / block a final answer until proof exists |
| Tool dispatch | `agent/turn_tool_batch.ts` | parallel-safe reads (max 4) and ordered writes |
| Tool context | `agent/tool_context.ts` | paths, coverage, provider info, subagent factory, stream callbacks |
| Bookkeeping | `agent/tool_result_evidence.ts` | verification evidence, turn artifacts, explicit-skill marker |
| Finalize | `agent/turn_finalize.ts` | checkpoint, session save, counters, skill stats, background review |

`agent/agent.ts` keeps the loop skeleton and delegates to those stages.

## Tools

Registered in `tools/` and available to the model:

- **Files** — `read_file`, `patch`, `patch_batch`, `apply_patch`, `write_file` (read-before-write
  tracking, unique-target partial patches, atomic writes, diffs returned to the model).
- **Execution** — `terminal` (foreground/background, `process_manage` to poll/wait/kill across
  sessions), `execute_code`.
- **Web** — `web_search`, `web_extract`, `browser_exec`.
- **MCP** — project servers from config, tool names prefixed `mcp__<server>__<tool>`.
- **State** — `todo_list`, `memory`, `deep_memory`, `clarify`, `skill_view`, `skill_manage`,
  `tool_search`/`tool_call` for deferred tools.

## Verification model

Edits dirty evidence groups: `.ts` → typecheck, test files → test run, build config → build. A
successful matching command clears the group. Before a final answer, a dirty group either triggers
one nudge or blocks the turn with `completionStatus: 'incomplete'` — read-only commands never count.

## Sessions, skills, memory

- Sessions persist under `~/.vallenemperor/sessions`, with per-turn checkpoints and compaction.
- Skills load from `~/.vallenemperor/skills` plus the bundled catalog; relevance scoring uses
  distinct words (repeats do not count twice), and auto-loaded skills are released when the topic
  changes — only an explicit `skill_view` stays sticky.
- `MEMORY.md` (notes) and `USER.md` (profile) survive across sessions; deep memory quotes sources.

## Gateway

`gateway/` ships a Telegram adapter with pairing (hashed single-use codes), allowlist enforcement,
rate limiting, inline approve/deny, and a daemon for scheduled jobs. Behaviour is covered by tests
that inject a fake HTTP client — no network required.

## Development

```bash
npm run build       # tsc
npm run typecheck   # tsc --noEmit
npm test            # build + node --test tests/*.test.mjs
```

Tests run against `dist/`, so `npm test` builds first. Suites cover the turn loop and event order,
provider retries/continuation, verification gates, skills relevance/release, patch engine, process
manager, deferred tools, clarify policy, provider presets, MCP end-to-end (real stdio fixture),
session search, cron, and the Telegram gateway.
