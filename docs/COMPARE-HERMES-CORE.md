# COMPARE-HERMES-CORE.md — why Hermes' file tools and self-improvement are more mature

Scope: the two areas the owner called out — **(A) read / write / patch / search** and
**(B) self-improvement review & learning across sessions**. Every claim below is backed by a file in
`/home/vallenganteng/Destop/hermes-agent-main` (line counts as read) or by our own source.

This document exists to answer *why Hermes feels mature*, not to copy blindly. Each gap gets a
verdict: **adopt**, **adapt**, or **skip**.

---

## Part A — File tools

### A.1 What Hermes actually has

| Module | Size | Responsibility |
| --- | --- | --- |
| `tools/file_tools.py` | 1435 | the four tools; delegates to the companions below |
| `tools/file_tools_read_tracking.py` | 427 | per-task read/search bookkeeping (dedup, loop detection, staleness, coverage) |
| `tools/file_tools_write_guards.py` | 649 | six write-side guards applied in a fixed order |
| `tools/file_tools_paths.py` | — | task-aware path resolution |
| `tools/patch_parser.py` | — | patch format parsing (V4A-style hunks) |
| `tools/working_diff.py` | 122 | git diff collection shared by CLI and gateway |
| `tools/write_approval.py` | 413 | pending store for memory/skill writes |

**Read tracking state (per `task_id`)** — from the module docstring, verbatim concepts:

- `last_key` / `consecutive` → **loop detection**; any *other* tool call resets it.
- `read_history` → diagnostics.
- `dedup` → key → file metadata; **survives context compression**.
- `dedup_generation_reads` → keys served in full since the last compaction boundary; cleared on
  compression so one recovery read returns full content.
- `dedup_hits` → **stub-loop breaker**.
- `read_timestamps` → **staleness warnings**.
- `read_coverage` → per resolved path, the **line ranges** paged through at one file version;
  contiguous pages reaching the last line count as a whole-file read.
- `full_write_baselines` → resolved paths whose whole content this task actually saw, required
  before `write_file`.

**Write guards (fixed order)** — from `file_tools_write_guards.py`:

1. `_check_sensitive_path` — hard deny (credentials, keys).
2. `_check_binary_document_write` — refuse writing binaries as text.
3. `_check_protected_instruction_write` — **ALWAYS ask** (instruction files like AGENTS.md).
4. `_check_approval_required_write` — the normal approval gate.
5. `_check_cross_profile_path` — sandbox-mirror lost-work protection.
6. `_is_internal_file_tool_content` — don't let tool output be written back verbatim.
7. `_stale_overwrite_blocker` — under a **per-path lock**, refuses a whole-file overwrite of content
   the task never saw, or that changed since it was read.

**Diff** — `working_diff.py` supports `working` (unstaged + untracked), `staged`, `all`; untracked
files are folded in with `git diff --no-index /dev/null <file>` so new files show as additions;
15 s timeout and a 50-file cap so a `node_modules` explosion cannot hang the UI.

### A.2 What we have

| Ours | Size | Has |
| --- | --- | --- |
| `vallenagent/src/tools/builtin_tools/file_tools.ts` | ~900 | read-before-write, partial-read acceptance for a unique `old_string`, sha256 `expected_hash` check, atomic write (temp + rename), diff returned to the model, sandbox roots (new) |
| `vallenagent/src/core/patch_engine.ts` | — | fuzzy replacement + unified diff generation |
| `vallenagent/src/tools/builtin_tools/file_tools.ts` (`search_files`) | — | regex content search + glob file search, `limit`/`offset` pagination |

### A.3 Gap table (A)

| # | Gap | Why it matters | Effort | Verdict |
| --- | --- | --- | --- | --- |
| C1 | **No read dedup** — re-reading an unchanged file returns the whole file again | burns context every loop; Hermes returns a stub after the first full read and survives compaction | M | **adopt** |
| C2 | **No loop detection** — nothing notices `read A → read A → read A` | silent token burn, the classic agent failure | S | **adopt** |
| C3 | **No staleness warning** — `patch` only refuses when the caller passes `expected_hash` | stale edits are our most expensive failure mode | S | **adopt** |
| C4 | **No sensitive-path deny list** — `.ssh/`, `.env`, `*.pem`, keychains | a prompt-injected page could exfiltrate credentials | S | **adopt** |
| C5 | **No "protected instruction file always asks"** — we can rewrite `AGENTS.md`/`RULES.md` like any file | the agent can silently edit its own rules | S | **adopt** |
| C6 | **No per-path write lock** — parallel subagents can interleave writes to one file | worktree isolation does not protect a shared file | S–M | **adopt** |
| C7 | **Diff is checkpoint-based only** — no `staged`/`all`/`session` git modes | users want `git diff` semantics | S | **adopt** |
| C8 | Binary-document write guard | partial: we refuse files containing NUL bytes, but not by extension/type | S | adapt |
| C9 | Read coverage is coarse (whole-file vs not) | Hermes tracks **line ranges**, so a paged read can count as complete | S | adapt |
| C10 | Desktop-specific readers (`read_terminal`, `read_preview`, `read_window`) | we are terminal-only | — | skip |
| C11 | `write_approval` pending store | only relevant once we gate memory/skill writes (see B) | — | see B4 |

**Why Hermes feels more mature here:** it treats the file tools as a *stateful protocol* with the
model (dedup, staleness, coverage, locks) instead of stateless functions. Ours are careful about
*correctness* (atomic writes, hash checks) but not about *conversation economy* and *concurrency*.

---

## Part B — Self-improvement review and learning across sessions

### B.1 What Hermes actually has

| Module | Size | Responsibility |
| --- | --- | --- |
| `agent/background_review.py` | 1392 | fork the agent after a turn, ask "should any skill/memory be saved or updated?" |
| `agent/review_engine.py` | — | review orchestration |
| `agent/review_idle_queue.py` | — | run reviews when the session is idle |
| `agent/learn_prompt.py` | 197 | `/learn`: turn sources into a reusable skill with authoring standards |
| `agent/curator.py` + `curator_backup.py` | — | skill lifecycle: usage, staleness, archive, LLM review, backups |
| `agent/learning_graph.py` (+ render, mutations) | — | "journey" timeline of learned skills + memories |
| `tools/skill_provenance.py` | — | where a skill came from |
| `agent/skills_index_delta.py` | — | incremental skill-index updates |
| `tools/write_approval.py` | 413 | gates memory/skill writes; stages them under `pending/{memory,skills}/` |

**Mechanics of the review** (from the module docstring):

- Runs as a **daemon thread** that replays a conversation snapshot in a **forked `AIAgent`**.
- The fork **inherits the parent's live runtime** — provider, model, credentials, **cached system
  prompt** — so it hits the same prefix cache instead of re-paying for the prompt.
- Runs under a **dispatch-side tool whitelist** (it cannot roam).
- Writes go **straight to the memory + skill stores**, and the main conversation and prompt cache are
  never touched.
- Has a cancellation/completion handshake (`begin_request`, `cancel_requested`, `request_done`).

**The prompts are the real asset.** Hermes encodes what *not* to save
(`_DO_NOT_CAPTURE_BLOCK`):

- environment-dependent failures (missing binaries, unconfigured credentials, "command not found"),
- **negative claims about tools** ("X is broken") — these harden into self-citations for months,
- session-specific transient errors that resolved (capture the retry pattern instead),
- one-off task narratives,
- **unresolved failures** — never dress a failed attempt up as a "reliable workflow"; if nothing
  worked, say "Nothing to save".

And the skill shape contract (`_LESSON_LAYER_BLOCK`):

- procedure first (steps, commands, decision points), pitfalls attach to the step they affect,
- a pitfall = generalizable rule + one clause of *why*, imperative, no incident narration,
- no PR/issue numbers, dates, or quoted user text as content,
- the same lesson twice is **one** rule — search first, strengthen rather than append,
- don't duplicate what AGENTS.md or tool schemas already teach,
- always-on rules live in SKILL.md whole; `references/` is for occasional depth,
- fix a wrong sentence in place; never append "UPDATE: actually…".

Plus `write_approval`: when enabled, memory/skill writes are **staged** (`pending/memory/<id>.json`)
for out-of-band review instead of committed immediately.

### B.2 What we have

`vallenagent/src/agent/background_review.ts` — **169 lines**:

- `shouldRunBackgroundReview(userMessage, turns, toolCalls, interval, repeatableErrors)` triggers on a
  correction signal, ≥8 tool calls, repeated tool errors, or every N turns.
- `createReviewSnapshot()` keeps the last 12 user/assistant messages, ≤5 000 chars each, ≤20 000 total.
- A whitelist: `skill_view, skills_list, skill_manage, memory, deep_memory, read_file, search_files`.
- A solid but compact prompt: no paraphrasing from tool/web output, deep memory needs an exact user
  quote + source session, read before editing a skill, don't duplicate, don't record completed tasks,
  distinguish transient from reproducible failures, answer `No updates needed` when nothing qualifies,
  return JSON of what changed.
- Telemetry from `skills/skill_stats.ts` and `skills/skill_history.ts` feeds prioritisation.

### B.3 Gap table (B)

| # | Gap | Why it matters | Effort | Verdict |
| --- | --- | --- | --- | --- |
| S1 | **Prompt lacks an explicit DO-NOT-CAPTURE list** | without it, reviews hoard environment failures and "tool is broken" claims into permanent rules | S | **adopt** |
| S2 | **No lesson-layer contract** (procedure-first, pitfall = rule + why, no PR numbers, one rule per lesson, fix in place) | this is why Hermes skills read like a handbook and ours drift into logs | S | **adopt** |
| S3 | **Review fork does not inherit the prompt cache** | every review re-pays for the system prompt; on long sessions this is the dominant cost | M | **adopt** |
| S4 | **No pending/staged review** — writes commit immediately | no out-of-band approval; a bad review silently edits skills | M | **adopt** |
| S5 | **No provenance** for skills (who/when/why) | impossible to audit or roll back a bad lesson | M | adapt |
| S6 | **No curator** — stale skills are never archived | the index grows forever and dilutes relevance | M | adapt |
| S7 | **No `/learn`** — no way to say "capture this as a skill" | the highest-intent learning request has no path | S | **adopt** |
| S8 | **No learning timeline** (`/journey`) | users cannot see what the agent learned | S | adapt |
| S9 | Review scheduling is turn-count based only | Hermes also runs when idle (`review_idle_queue`) | S | adapt |
| S10 | No skill-index delta / budget tracking | index growth silently eats the context window | S | adapt |

**Why Hermes feels more mature here:** three things, in order of impact — (1) the prompts encode
years of failure modes about *what not to learn*; (2) the review is a cache-aware fork, so it is cheap
enough to run often; (3) writes can be staged for review, so the loop is trustworthy.

---

## Part C — What this changes in our roadmap

New items (added to `docs/ROADMAP.md` as `P1b` and `R26–R35`):

| ID | Item | Source | Effort |
| --- | --- | --- | --- |
| P1b.1 | Read dedup + loop detection (stub repeats, survive compaction) | A1 | M |
| P1b.2 | Staleness warning on every patch (not just `expected_hash`) | A3 | S |
| P1b.3 | Sensitive-path deny list + protected instruction files always ask | A4/A5 | S |
| P1b.4 | Per-path write lock for concurrent subagents | A6 | S–M |
| P1b.5 | Git diff modes (`working`/`staged`/`all`/`session`) | A7 | S |
| P1b.6 | DO-NOT-CAPTURE + lesson-layer contract in the review prompt | B1/B2 | S |
| P1b.7 | Cache-aware review fork | B3 | M |
| P1b.8 | Pending/staged memory & skill writes | B4 | M |
| P1b.9 | `/learn <source>` | B7 | S |
| R26 | Skill provenance + `/journey` timeline | B5/B8 | M |
| R27 | Curator (stale skill archive) | B6 | M |
| R28 | Skill-index budget/delta tracking | B10 | S |

Ordering rationale: P1b.1–P1b.6 are cheap and remove the most common "the agent wasted my context /
learned something dumb" complaints. P1b.7–P1b.9 and R26–R28 are the structural pieces that make the
learning loop trustworthy.
