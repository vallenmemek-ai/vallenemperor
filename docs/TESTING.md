# TESTING.md — how to prove a change works

All tests use the built-in `node --test` runner and **never touch the network**. Tests run against
compiled output (`dist/`), so build first.

## Commands

```bash
npm run build        # tsc (core) + node --check (CLI)
npm run typecheck    # tsc --noEmit
npm test             # vallenagent, then vallencli
```

Per package / single file:

```bash
npm -w vallenagent run test              # build + scripts/run-tests.mjs tests
npm -w vallencli run test
node --test tests/model_picker.test.mjs   # from inside the package
```

`scripts/run-tests.mjs` enumerates `*.test.mjs` files itself so the run is deterministic on
Linux, macOS, Windows, and Termux (shell globs are not expanded by `cmd.exe`; Node 24 treats a bare
directory differently).

## Layout

```text
vallenagent/tests/*.test.mjs     engine suites
vallencli/tests/*.test.mjs       CLI suites
vallenagent/tests/fixtures/      stdio MCP server used by the end-to-end MCP test
```

## Rules for writing tests

1. **Write the test first.** It must fail against the old code, then pass after the fix. A test that
   passes before the change proves nothing — rewrite it, never delete the assertion.
2. **Deterministic.** No network, no real clock if avoidable, no machine-specific absolute paths.
   Use `mkdtempSync(join(tmpdir(), ...))` and a temporary `VALLENEMPEROR_HOME`.
3. **Isolated.** Set environment variables at the top of the file and clean up in `test.after` /
   `t.after`.
4. **Never wait for real input.** For TUI code, inject dependencies (`fetchModels`, `http`) or run
   in non-TTY mode.
5. **Assert meaning, not just absence of throw.** Check message content, status values, ordering,
   side effects.
6. **Cross-platform.** No `/bin/bash`, `/tmp`, permission bits, or platform-specific signals without
   a `process.platform` guard.
7. **One behavior per test.** A failure should point at exactly one broken rule.

## Reference patterns

| Need | Existing example |
| --- | --- |
| Real agent + scripted provider | `vallenagent/tests/turn_loop.behaviour.test.mjs` |
| Turn event ordering | `vallenagent/tests/turn_event_order.test.mjs` |
| Provider retries / truncated answers | `vallenagent/tests/turn_provider_call.test.mjs` |
| Patch safety & read tracking | `vallenagent/tests/patch_engine.test.mjs` |
| Pure policy logic | `vallenagent/tests/clarify_policy.test.mjs` |
| Gateway without network | `vallenagent/tests/telegram_gateway.test.mjs` (injects `http`) |
| CLI end-to-end with streams | `vallencli/tests/cli.test.mjs` (`runCli` + `PassThrough`) |
| Two-level model picker | `vallencli/tests/model_picker.test.mjs` |
| Bin invoked through a symlink | `vallencli/tests/cli.test.mjs` (spawn `node <symlink> --version`) |
| Turn artifacts summary | `vallenagent/tests/turn_artifacts.test.mjs` |
| Artifact store (paths, manifest, traversal) | `vallenagent/tests/artifact_store.test.mjs` |
| Screenshot tool validation | `vallenagent/tests/browser_screenshot.test.mjs` |
| Plan parsing / state machine | `vallenagent/tests/plan_mode.test.mjs` |
| /plan commands end-to-end | `vallencli/tests/plan_commands.test.mjs` |
| Subagent registry + worktrees | `vallenagent/tests/subagent_registry.test.mjs` |
| Background delegation tool | `vallenagent/tests/delegate_background.test.mjs` |
| /agents panel | `vallencli/tests/agents_command.test.mjs` |
| Custom agents + planner | `vallenagent/tests/custom_agents.test.mjs` |
| Browser gate + prompt triggers | `vallenagent/tests/browser_gate.test.mjs` |
| /browser command | `vallencli/tests/browser_command.test.mjs` |
| Sandbox policy + write guards | `vallenagent/tests/sandbox.test.mjs` |
| Read dedup / loop / path policy / stale patch / review prompt | `vallenagent/tests/tool_maturity.test.mjs` |
| Git diff modes | `vallenagent/tests/working_diff.test.mjs` |
| Per-path write lock + `/learn` prompt | `vallenagent/tests/path_lock_learn.test.mjs` |
| `/learn` command wiring | `vallencli/tests/learn_command.test.mjs` |
| setup / doctor / update | `vallencli/tests/setup_doctor_update.test.mjs` |
| /sandbox command | `vallencli/tests/sandbox_command.test.mjs` |
| /artifact panel, /btw, /fork | `vallencli/tests/artifact_panel_btw.test.mjs` |
| Engine session fork | `vallenagent/tests/fork_session.test.mjs` |

## Coverage that must never regress

- **Turn loop**: event order, tool execution, approvals, truncation/continuation, verification gate.
- **Sessions**: resume, checkpoints, compaction, search.
- **Skills**: distinct-word relevance, preload budget, release when the topic changes, explicit stickiness.
- **Tools**: file/patch read-before-write rules, partial-read safety, process manager across sessions,
  deferred tools (`tool_search` returns `parameters`), `browser_screenshot` rejects non-http URLs.
- **Artifacts**: manifest round-trip, name validation/traversal rejection, session isolation,
  walkthrough contents, corrupt-manifest recovery.
- **Plan mode**: step parsing (heading/numbered/bullet), one-step-per-turn execution, steering notes,
  skip/stop semantics, plan saved as an artifact.
- **Subagents**: registry lifecycle, concurrency cap, pruning, cancellation handle, foreground vs
  background contract, worktree creation/removal (skips cleanly when git is unavailable).
- **Routing**: frontmatter parsing, workspace-over-global precedence, planner threshold, agent tools
  and model applied, explicit agent name beating routing.
- **Browser gate**: locked by default, per-session unlock with ttl, expiry, locked message instructing
  the model to ask the user.
- **Sandbox**: root containment (no `..`, no prefix siblings), subagents always confined, main agent
  opt-in, write_file/patch/patch_batch denials, reads still allowed.
- **Review surfaces**: artifact list/preview, `/btw` never starting a main turn, `/fork` persisting
  both sessions and refusing to fork a subagent.
- **Tool economy**: duplicate read stub + `force`, loop threshold, streak reset by other tools,
  credential/instruction deny lists, stale-baseline refusal, review prompt contracts.
- **CLI**: argument parsing, config subcommands, `/model` picker, renderer, installer, symlink bin.
- **Gateway**: pairing (single use, attempts), allowlist, rate limit, approve/deny callbacks.
- **Config**: provider presets valid, missing `active`/`base_url` reported clearly.

## CI

`.github/workflows/test.yml`:

- matrix `ubuntu-latest`, `windows-latest`, `macos-latest` → `npm ci`, `build`, `typecheck`, `test`,
  then a **global install smoke test**: `npm install -g .` + `--version` + `--help` + `config show`;
- a `termux-shape` job (Linux arm64 container) that installs without native build tooling.

A red CI is a real failure. Do not disable steps to make it green; fix the cause.

## Adding a test — step by step

1. Find the closest existing suite and copy its setup style.
2. Reproduce the bug or missing behavior in the smallest possible test.
3. Run it and **confirm it fails** (record the failure).
4. Implement the fix.
5. Run the suite; then run the full `npm test` and record both counts.
6. If the change is user-visible, also add/extend a CLI-level test.

## Reporting numbers

Always quote the real totals from `npm test`, e.g.:

```text
vallenagent 297/297, vallencli 101/101
```

Never round, never invent, never omit a failing suite.
