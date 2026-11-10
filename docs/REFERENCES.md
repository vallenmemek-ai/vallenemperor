# REFERENCES.md — the peer research, consolidated

This file is the **whole** research record. The long-form peer inventories
(`REFERENCE-HERMES.md`, `REFERENCE-ANTIGRAVITY.md`, `REFERENCE-OPENCODE.md`,
`COMPARE-HERMES-CORE.md`, `references/*.md`) were deleted once every item they proposed was implemented;
their full text remains in git history (`git log --diff-filter=D -- docs/`).

Rule that still applies: **never redesign a solved problem from memory.** Before adding a capability,
check whether two or more peers already ship it, and copy the *reason*, not the code.

## 1. Peers read, and what they were read for

| Peer | Read from | What it covered | Verdict |
| --- | --- | --- | --- |
| **Hermes Agent** (Nous Research) | local source `/home/vallenganteng/Destop/hermes-agent-main` | ≈70 CLI commands, ≈90 slash commands, 35 toolsets; deep dive on file tools (read/write/patch/search) and the self-improvement review loop | adopted the file-tool maturity work (P1b) and the skill/review loop (R15, R19, R25–R28) |
| **Antigravity CLI** (Google) | official docs | slash-command inventory, subagents, artifacts, permissions/sandbox | adopted agent manager + worktrees (R9, R32), artifacts, on-demand `/browser` |
| **opencode** | config reference | config surface inventory + cross-peer agreement table | used mainly as the ordering signal |
| **Claude Code** (Anthropic) | official docs | hooks lifecycle, subagents, permissions, skills | adopted hooks with JSON decisions (R29) |
| **Codex CLI** (OpenAI) | official docs | sandbox/approvals model, `codex exec`, `/permissions`, reasoning effort | adopted scriptable `-p` + JSON output, permission presets (R31), `/fast` (R18) |
| **Gemini CLI** (Google) | repo + docs | extensions, checkpointing, MCP, non-interactive mode | adopted extension packs (R34) |
| **Aider** | docs | repository map (symbol signatures), edit formats, git-native workflow | adopted the budgeted repo map (R30) |

## 2. Cross-peer adoption matrix — all implemented

Every row below is shipped and covered by a test. "ID" points at `ROADMAP.md`; `done` means the
capability existed before the R-numbering.

| Capability | Hermes | Antigravity | opencode | Claude Code | Codex | Gemini | ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Setup / doctor / update | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P0.1–P0.3 |
| Code search panel | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P1.1 |
| Reasoning effort + `/fast` | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | P1.2, R18 |
| Interactive diff review | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | P1.3 |
| Custom slash commands | ✅ | 🟡 | ✅ | ✅ | 🟡 | ✅ | R21 |
| Subagents / delegation (nested) | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | P2.2 |
| Plan mode | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | done |
| Checkpoints / rollback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | done |
| Permissions panel / tool policy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | R22, R31 |
| Lifecycle hooks (JSON decisions) | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | R29 |
| Repo map / symbol graph | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | R30 |
| Long-horizon goals | ✅ | ✅ | ❌ | 🟡 | 🟡 | 🟡 | R6 |
| Rewind / branch history | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ | R2 |
| LSP integration | ✅ | ❌ | ✅ | ✅ | ❌ | 🟡 | R14 |
| Worktrees | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 | R9 |
| Formatter after edits | 🟡 | ❌ | ✅ | ✅ | 🟡 | 🟡 | R23 |
| `/learn` → skill | ✅ | ✅ | 🟡 | ✅ | ❌ | 🟡 | P1b.9 |
| Background agent dashboard | ✅ | ✅ | 🟡 | ✅ | 🟡 | ❌ | R32 |
| Terminal sandbox | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | P2.5 |
| Editor protocol (ACP) | ❌ | ✅ | 🟡 | ✅ | ❌ | 🟡 | P2.4 / R17 |
| Browser session recording | ✅ | ✅ | ❌ | 🟡 | ❌ | ❌ | P2.1 |
| Extension packs (tools+commands+skills) | ✅ | 🟡 | ✅ | 🟡 | ❌ | ✅ | R34 |

## 3. Deliberately not copied (recorded so nobody re-proposes it)

- Desktop/web apps, pets, skins, voice/wake-word, video generation.
- 20+ messaging platforms, hosted connectors, kanban boards.
- Vendor-specific quota/credit UI.
- Cloud sessions / hosted agent teams — we do local background subagents instead.
- Watcher-based context and egress proxies: infrastructure we cannot test here.

## 4. Maintenance

1. When a peer ships something relevant, add a row here with the date read and the source.
2. If two peers ship it, it is table stakes: add an item to `ROADMAP.md` with acceptance criteria.
3. Keep it factual — cite the page/source. No "I think it does X".
4. Do not recreate per-peer files unless a new deep comparison is genuinely needed; keep one record.
