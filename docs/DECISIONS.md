# DECISIONS.md — architecture decision records

Short records of choices that shape the code. **Read before changing the area.** Each entry: what was
decided, why, and what breaks if you undo it. If you believe a decision is wrong, raise it with the
owner — do not silently reverse it.

---

## D1 — The turn loop is split into stage modules

**Decision.** `agent/agent.ts` keeps only the loop skeleton. Stages live in `turn_setup_phase.ts`,
`turn_provider_call.ts`, `turn_verification_gate.ts`, `turn_tool_batch.ts`, `tool_context.ts`,
`tool_result_evidence.ts`, `turn_finalize.ts`, each with an explicit dependency object.

**Why.** A single 1,300-line function could not be reviewed or tested per behavior; a bad replace
once cut 350 lines and only the test suite caught it.

**Consequence.** New stage-level logic goes into a stage module. `turn_event_order.test.mjs` pins the
observable order (`thinking → telemetry per response → tool_start → tool_end → chunk → final telemetry`).

---

## D2 — Verification is grouped and blocking

**Decision.** Edits dirty evidence groups: `.ts` → typecheck, test files → test run, build config →
build. A successful matching command proves the group. A dirty group triggers one nudge, then blocks
the final answer with `completionStatus: 'incomplete'`. Read-only commands never count.

**Why.** The old gate only covered TypeScript and only scolded *after* the model claimed "done".

**Consequence.** `verification.ts` classifies commands; `turn_verification_gate.ts` decides. Adding a
new file class means updating `tool_evidence.ts` and the gate tests.

---

## D3 — Auto-checklist is bookkeeping, not user intent

**Decision.** The runtime-created `request-*` checklist item is bookkeeping. Once the model answers
in text with no pending tool call, the answer is accepted (after one nudge) and the item is marked
completed. A checklist the **model** created still blocks.

**Why.** Meta questions ("ini pertanyaan jujur kah bang, biar enak gw update") were classified as
tasks, then closed with a false "Task incomplete" footer.

**Consequence.** Interrogative Indonesian markers (`kah`, `apa`, `kenapa`, `gimana`, `saran`,
`pendapat`, `menurut lu`) are not execution requests. See `agent_task_intent.ts`.

---

## D4 — Clarify is a gate, not a form

**Decision.** `clarify` only accepts blocking decisions. Permission-to-continue questions and
preference polls are rejected with `proceed: true` + advice. Limits: 5 questions, 4 choices.

**Why.** The runtime cannot collect structured answers; asking for style or "should I continue?"
wasted a whole turn.

**Consequence.** `clarify_policy.ts` owns the rules and is unit-tested. The system prompt has a
`# When to Ask (clarify)` section that must stay consistent with it.

---

## D5 — Skills: per-turn auto-load, explicit stickiness

**Decision.** Relevance scoring uses **distinct** words (a repeated word counts once). Auto-matched
skills apply only to the current turn; only `skill_view` (explicit) is stored in `activeSkill` and
stays until `/new`.

**Why.** A skill loaded once (e.g. "email") was injected on every later turn, and repeated words
passed the "two matching words" threshold.

**Consequence.** `skills.ts` dedupes before slicing; `agent.ts` never stores auto-matches. Tests:
`skills_relevance.test.mjs`, `turn_loop.behaviour.test.mjs` (skill release).

---

## D6 — The root package is CommonJS-typed on purpose

**Decision.** The root `package.json` must **not** set `"type": "module"`.

**Why.** `vallenagent/dist/*.js` is compiled as CommonJS. Adding `"type": "module"` made every import
fail with `exports is not defined in ES module scope` (`config show` broke immediately).

**Consequence.** CLI sources use `.mjs`. Converting to full ESM requires changing the TypeScript
module target first — a separate, larger change.

---

## D7 — One publishable package, workspace for development

**Decision.** `vallenagent` and `vallencli` stay private workspaces. The root package is the only
thing published, shipping `vallencli/src`, `vallenagent/dist`, `banner.txt`, and
`.vallenemperor/skills` via a `files` whitelist.

**Why.** The CLI resolves the core by relative path (`ROOT/vallenagent/dist/index.js`). Shipping the
same layout keeps every runtime path valid without a rewrite.

**Consequence.** Runtime dependencies must be declared on the **root** package. `prepack`/`prepare`
must build `dist`. `files` overrides `.gitignore`, so gitignored `dist/` still ships.

---

## D8 — Bin invocation compares real paths

**Decision.** The CLI entry guard uses `realpathSync` on both `process.argv[1]` and
`import.meta.url`.

**Why.** npm installs `node_modules/.bin/vallenemperor` as a symlink. Comparing a resolved symlink
path with a real file path never matched, so the global binary exited 0 and printed nothing.

**Consequence.** `cli.test.mjs` spawns `node <symlink> --version`; keep that test.

---

## D9 — Staged publishing is accepted, approval is manual

**Decision.** Releases may land in npm staging (the token may be stage-only). The release script
detects this and prints the approval instructions instead of claiming success.

**Why.** The npm account enforces 2FA; direct publishes with a staging token create the
`0.0.0-stage` placeholder.

**Consequence.** `scripts/release.sh` checks `npm view` after publishing. Approval happens on
npmjs.com → Staged Packages (or `npm stage approve` with npm ≥ 11.15 / Node ≥ 22.14).

---

## D10 — `/model` is a live two-level picker

**Decision.** `/model` without an argument fetches `GET {base_url}/models`, groups by `owned_by`
(`ag` → antigravity, `kc` → kiro), and offers provider → model selection. 15 s timeout, 5-minute
session cache, non-TTY catalog fallback. `/model <name>` still switches directly.

**Why.** Users could not see which providers/accounts were connected, and had to guess model ids.

**Consequence.** `cli-model-picker.mjs` is pure logic + fetch (unit-tested); `cli.mjs` owns terminal
rendering. Keys are claimed immediately while loading, so early keystrokes cannot leak into the REPL.

---

## D11 — Large edits always show their diff

**Decision.** Edits changing more than 20 lines show a diff in the approval box even in `dangerous`
mode, and cannot use an "always allow" session grant.

**Why.** Silent large writes are the most expensive mistake a terminal agent can make.

**Consequence.** `bigEditPreview()` in `cli.mjs`; non-interactive runs never block on it.

---

## D12 — Partial reads are allowed only for a unique target

**Decision.** `patch` accepts a partial read (hash still matching) only when `old_string` occurs
exactly once (or `replace_all` is set). `write_file` accepts a partial read for a full overwrite
because the hash proves the content is unchanged. `unread`/`stale` are always refused.

**Why.** Editing one line in a 2,000-line file should not require pulling the whole file into context.

**Consequence.** `file_tools.ts` keeps both guards; tests in `patch_engine.test.mjs` cover unique,
ambiguous, stale, and unread cases.

---

## D13 — External services are injected, not mocked at the module level

**Decision.** The Telegram adapter takes an `http` option and the model picker takes `fetchModels`.

**Why.** Gateway behavior (pairing, allowlist, rate limits, approvals) must be testable without a
network and without monkey-patching globals.

**Consequence.** Keep new adapters injectable. Tests construct them with stubs and assert on calls.

---

## D14 — The test suite is cross-platform

**Decision.** Tests must pass on Linux, macOS, and Windows. `scripts/run-tests.mjs` enumerates test
files; no POSIX-only assumptions are allowed without a platform guard.

**Why.** CI runs a 3-OS matrix plus a Termux-shaped (arm64, no native build) job.

**Consequence.** Use `node:path`, `node:os.tmpdir()`, and Node APIs instead of shell commands.

---

## D15 — Artifacts are files on disk with a manifest, not chat text

**Decision.** A turn's deliverables are written to
`<home>/artifacts/<sha256(sessionId)[0:16]>/turn-<n>/` with an `index.json` manifest. The CLI prints
the directory and `/artifacts` lists entries. `browser_screenshot` writes PNGs into the same turn
directory.

**Why.** "What did the agent actually produce?" should be answerable by opening a folder — not by
scrolling a transcript. This is the Antigravity artifact model applied to a terminal agent.

**Consequence.** The store is synchronous (small files, once per turn) and hashes the session id, so
user-controlled strings never become path segments. Artifact names are validated and `index.json` is
reserved. Adding a new artifact kind means extending `KIND_EXT` and `ArtifactKind`.

---

## D16 — Plan execution is a command-driven state machine, not a hidden loop

**Decision.** `/plan go` parses the saved plan into steps and runs exactly one step per turn. Between
steps the user drives the next action with `/plan next`, `/plan edit <feedback>`, `/plan skip`,
`/plan stop`, or `/plan status`. The state machine (`agent/plan_mode.ts`) is pure and lives in core;
the CLI only wires it to `runTurn`.

**Why.** A plan that executes end-to-end unattended is exactly the failure mode Antigravity's
milestone review exists to prevent. Command-driven steering also works in a pipe and over the
gateway, and it is testable without a terminal.

**Consequence.** Each step is a normal turn, so verification gates, artifacts, and approvals still
apply. Adding a new steering action means extending `plan_mode.ts` plus the `/plan` subcommand
switch; do not add hidden auto-advance.

---

## D17 — Background subagents are registry-tracked and worktree-isolated

**Decision.** `delegate_task` keeps its synchronous contract by default and adds
`background: true`, which registers the run in `SubagentRegistry` and returns an id immediately.
`workspace: 'branch'` creates a git worktree under `<home>/worktrees/<repo-hash>/<id>` and runs the
subagent with `terminal.cwd` set to it. Worktrees are removed only by `/agents clean`.

**Why.** Antigravity's agent manager works because parallel agents are visible and isolated. Running
two agents in one tree corrupts edits; running them invisibly makes the user lose track.

**Consequence.** Cancellation must go through the handle the factory exposes (`onHandle`), because the
subagent owns its own turn. Never auto-delete a worktree: the branch is the reviewable output.

---

## D18 — Tool choice is routed, and browser access is on demand

**Decision.** Custom agents are markdown files with a `description` used by a planner
(`selectAgentForTask`) that requires two distinct word matches or a name hit. `delegate_task` applies
the matched agent's instructions, tool whitelist and model. Browser tools are locked behind
`/browser <task>` (30-minute unlock per session).

**Why.** Antigravity does exactly this: its planner routes by agent `description`, and its browser
subagent is "on demand only — hidden from the agent's normal subagent list". Relying on model
judgement alone produces silent under-use (never delegating) and unsafe over-use (browsing on its own).

**Consequence.** `browser_exec` / `browser_screenshot` return a clear locked message that tells the
model to ask the user instead of retrying. Adding a new browser tool means adding the same gate.

---

## D19 — File writes are bounded; the terminal is not

**Decision.** Subagents always get `sandboxRoots` = their working directory. The main agent is bounded
only when `security.filesystem: "workspace"` is set (default: unrestricted). Guards apply to
`write_file`, `patch`, `patch_batch`, `apply_patch`. Reads are not blocked. The terminal tool is
explicitly **not** sandboxed.

**Why.** A `workspace: "branch"` subagent that can be pointed at an absolute path is not isolated at
all — the worktree would be decoration. Bounding the main agent by default would break existing
workflows (writing outside the project, `/tmp` scratch files), so it is opt-in.

**Consequence.** New write tools must call `checkPathAllowed` with `context.sandboxRoots`. Claiming
full sandboxing would be dishonest while the terminal is unconfined; the approval gate is the control
for shell commands.

---

## D20 — Review surfaces read the artifact store; side questions never pollute history

**Decision.** `/artifact` renders from the artifact store (list + preview of one entry) instead of
re-running the model. `/btw` creates an isolated lightweight agent, asks once, and shuts it down. `/fork`
copies the current conversation into a new session id and switches to it, leaving the original intact.

**Why.** Reviewing work should not cost tokens or risk changing state, and a side question must not
appear in the main conversation (which would confuse compaction and the verification gate). Forking
gives a safe branch to experiment in without losing the original thread.

**Consequence.** `/btw` uses the same provider config as the main agent — if the model is broken, the
side question fails too, and it must report that instead of guessing. `forkSession()` throws for
subagents because a subagent has no user-facing session.

---

## D21 — Reads are deduplicated; credentials and instruction files are write-protected

**Decision.** `read_file` keeps per-session state: an unchanged range read twice returns a stub
(`duplicate: true`, `sha256` kept, body omitted, `force: true` escapes), and three identical reads in
a row are a loop. Any other tool call resets the streak. Writes are classified by
`core/path_policy.ts`: credential material is a hard deny with no override, instruction files
(`AGENTS.md`, `RULES.md`, …) are denied unless `VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS=1`.

**Why.** Hermes demonstrated both: dedup is the difference between a 3-hour session and a session
that drowns in repeated file bodies, and an agent that can silently rewrite its own rules is one
prompt injection away from removing its guardrails. Staleness blocking already existed; a test now
pins it.

**Consequence.** The stub is a *success* result, not an error — the model must learn to act on what it
already has. Never widen the deny list by default; adding a path class means adding a test.

---

## D22 — Writes serialise per path; `/learn` is a prompt, not an engine

**Decision.** `write_file` and `patch` run under `withPathLock(path)` (in-process mutex, keyed by the
canonical path). `/learn` is a prompt builder (`agent/learn_prompt.ts`) that the live agent executes
with its normal tools, exactly like `/plan`.

**Why.** Subagents share a process and can target the same file; last-writer-wins silently destroys a
diff. And every special-purpose engine we add is another surface to test — a prompt reuses the tool
loop, the skill authoring path, and the verification gate for free.

**Consequence.** The lock is in-process only: cross-process safety is the worktree/sandbox story.
`/learn` must keep its standards text in sync with the bundled skill authoring rules; if those diverge,
the skills it produces get rejected by review.

---

## D23 — First-run experience is three commands, all injectable

**Decision.** `setup`, `doctor`, and `update` live in the CLI (`cli-setup.mjs`, `cli-doctor.mjs`,
`cli-update-check.mjs`) and take every side effect as an injected dependency (prompting, model fetch,
config write, probes, fetcher, installer). The daily update check is fire-and-forget with a 24-hour
cache.

**Why.** The biggest drop-off is a fresh install with no provider, and the biggest support cost is
"it does not work" with no diagnosis. Injection keeps both testable without a terminal or network.

**Consequence.** `setup` refuses non-TTY and prints the `config set` alternative — never attempt an
interactive prompt in a pipe. `doctor` must never print a key value, only its presence.

---

## D24 — The learning loop can be staged, and the review fork reuses the parent provider

**Decision.** `write_approval: { memory: true }` makes the memory tool stage writes in
`<home>/pending/memory/` instead of committing; the owner applies them with `/memory approve <id>`.
The background review agent is constructed with the parent's provider instance.

**Why.** A single turn (or a bad review) must not be able to rewrite long-term memory silently — the
same reason Hermes ships a pending store. Reusing the provider keeps the model, credentials and
connection identical, so the review request hits the same prefix cache instead of paying full price.

**Consequence.** Staged writes must still be visible to the review prompt (it reads memory, not the
pending queue) — the agent is told it was staged. Skill staging needs a skill authoring tool first
(skills are plain files today), tracked as P1b.10.

---

## D25 — Hooks are shell commands with a JSON contract; the repo map is regex-based

**Decision.** Hooks run as shell commands with a JSON payload on stdin and an optional
`{"decision":"block"}` on stdout; only `pre_tool` and `user_prompt` can block. The repository map uses
per-language regex extractors instead of tree-sitter, cached for 60 s and budgeted in characters.

**Why.** A JSON shell contract gives policy, audit, formatting and notifications without a plugin
runtime (Claude Code, Gemini and Hermes all converge on it). Regex extraction keeps the feature
dependency-free and cross-platform — no native builds, which is what breaks Termux/Windows installs;
it is less precise than tree-sitter, and that is an accepted trade-off for now.

**Consequence.** A blocking hook must be fast (<10 s default) because it sits in the tool path. The
repo map is *data* in the prompt, never instructions. If precision matters later, swap the extractor
behind `buildRepoMap` without touching callers.

---

## D26 — Session UX is files and templates, not new engines

**Decision.** `/save` builds the transcript from `AIAgent.exportTranscript()` with a regex redactor;
custom commands are markdown files with a `description` and a body where `$ARGUMENTS` is substituted;
completion scripts are static strings.

**Why.** These are all "read state and render" features. Adding an engine for each one would multiply
the test surface for no benefit, and the file-based layout (`.vallenemperor/commands/*.md`) lets users
add workflows without touching code.

**Consequence.** Redaction is best-effort by shape (well-known token prefixes), not a guarantee —
`/save` prints whether redaction was applied. Custom commands must never shadow built-ins: built-in
handlers run first.

---

## D27 — Diagnostics are offline; the formatter is best-effort

**Decision.** `prompt-size`, `insights`, `logs` and `dump` read local files and the tool registry only —
no model calls, no network. `dump` redacts api keys to `***set***`. The post-edit formatter runs the
project's own command (`{file}` substituted) and only reports failures.

**Why.** Support diagnostics must work when the provider is down — that is exactly when users run them.
A formatter that blocks or fails a turn would be worse than no formatter.

**Consequence.** Diagnostics must never print secrets; `dump` is the canonical example. Formatter output
is truncated and surfaced as a thinking note, never as a tool error.
