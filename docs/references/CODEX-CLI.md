# CODEX-CLI.md — OpenAI Codex CLI inventory vs VallenEmperor

Source: `https://learn.chatgpt.com/docs/codex/cli` (read 2026-11). Sandbox/approval specifics below
come from the product's documented model; verify against `codex --help` before implementing details.

## 1. In-session surface

| Command | What it does | Ours | Verdict |
| --- | --- | --- | --- |
| `/init` | create `AGENTS.md` with project instructions | ✅ `/init` | parity (ours should read the repo and propose rules) |
| `/status` | current session configuration | 🟡 `/status` | parity |
| `/permissions` | choose what the agent may do | 🟡 `/auto`, `/sandbox` | **adopt** a single panel (R31) |
| `/model` | model **and reasoning effort** | 🟡 `/model` (no effort) | adopt `/effort` (P1.2) |
| `/review` | review changes, find issues | 🟡 `/review` (skill/memory review) | adopt the reviewer meaning (R6-adjacent) |

## 2. Execution model

- Interactive REPL and **`codex exec`** for scripts/CI (non-interactive, machine-readable output).
- **Sandboxed execution** with an approval policy: the agent runs commands inside a sandbox
  (platform-specific) and asks before stepping outside it.
- `AGENTS.md` is the project-instruction file (same convention we already use).

| Ours | Verdict |
| --- | --- |
| `vallenemperor -p "..."` one-shot | parity, but no JSON/exit-code contract → Roadmap **R33** |
| Approval modes + file sandbox; terminal not sandboxed | adopt terminal sandbox (P2.5) |

## 3. What to copy

1. **`--json` / exit-code contract** for `-p` (R33) — makes us usable in CI.
2. **Permissions panel** (R31) — one place to see and change what is allowed.
3. **Reasoning effort in the model picker** (P1.2) — Codex puts it in the same flow.

## 4. What not to copy

ChatGPT account/subscription plumbing, cloud task handoff.
