# CLAUDE-CODE.md — Claude Code (Anthropic) inventory vs VallenEmperor

Source: `https://code.claude.com/docs/en/hooks`, `/docs/en/sub-agents` (read 2026-11).

## 1. Hooks (the big idea we lack)

Hooks are **user-defined handlers that fire at fixed lifecycle points**, configured outside the agent
core. Handler types: **shell command, HTTP endpoint, MCP tool call, LLM prompt, subagent**. Input
arrives as JSON on stdin (command hooks) or as a POST body (HTTP hooks); the handler can return a
decision that changes what happens next. Async hooks are supported.

Lifecycle events:

| Cadence | Events |
| --- | --- |
| per session | `SessionStart`, `SessionEnd` |
| per turn | `UserPromptSubmit`, `Stop`, `StopFailure` |
| per tool call | `PreToolUse`, `PostToolUse` |

| Ours | Verdict |
| --- | --- |
| Approval gate + `/auto` modes; no event system | **adopt** a minimal hook system: `session_start`, `user_prompt`, `pre_tool`, `post_tool`, `turn_end`, `session_end` with a shell command + JSON I/O. Roadmap **R29**. |

Why it matters: policy, formatting, audit logging, notifications, and "block this tool" rules can be
added by users without patching our core — and every peer we studied has some version of it.

## 2. Subagents

- Each subagent has its **own context window, custom system prompt, specific tool access, and
  independent permissions**.
- The model **delegates automatically when a task matches the subagent's description** (same planner
  idea we implemented).
- Separate concepts above that: **background agents** (many independent sessions, monitored from one
  place), **agent teams** (spawned and supervised), **cross-session messaging**.

| Ours | Verdict |
| --- | --- |
| `delegate_task` foreground/background, `workspace` inherit/branch/share, `.agents/agents/*.md`, planner, `/agents` | parity on subagents; **gap** on a monitoring view for many runs → Roadmap **R32**. |

## 3. Permissions

Claude Code ships permission modes plus per-tool rules, editable in-session. We have `/auto`
(dangerous/all/off), `/sandbox`, and the approval box. Gap: one reviewable **panel** that shows the
effective rule per tool/path → Roadmap **R22/R31**.

## 4. What to copy

1. **Hooks** (R29) — highest value, lowest coupling.
2. **Permissions panel** (R31) — consolidate `/auto` + `/sandbox` + tool rules.
3. **Background agent view** (R32) — we already have the registry; this is presentation.

## 5. What not to copy

Cloud sessions, desktop app, agent teams as a hosted product, mods/JS plugin runtime.
