# AGENTS.md — read this before touching the code

**VallenEmperor** is an autonomous coding agent for the terminal. Two workspace packages
(`vallenagent` = engine, `vallencli` = terminal UI) ship as one npm package, `vallenemperor`.

If you are an AI starting a fresh session (new model, cleared context, different tool), read in this
order — do not guess the architecture:

1. **AGENTS.md** (this file) — entry point, invariants, definition of done
2. **[RULES.md](RULES.md)** — binding rules: owner gate, versioning, evidence, secrets, git
3. **[docs/PROJECT.md](docs/PROJECT.md)** — architecture map and where code belongs
4. **[docs/TESTING.md](docs/TESTING.md)** — how to test and what must stay covered
5. **[docs/RELEASING.md](docs/RELEASING.md)** — release pipeline and owner approval
6. **[docs/DECISIONS.md](docs/DECISIONS.md)** — why the code looks the way it does (do not undo these casually)

## The eight invariants

1. **Owner gate.** Never publish a release without the owner explicitly saying go. Prepare, test,
   report, wait. The owner decides whether to release or to add features first.
2. **One change, one version.** Every update bumps the patch version, then that version is installed
   as the primary app (`npm install -g .`) and tested — not the previous build.
3. **Evidence, not claims.** `npm run build`, `npm run typecheck`, `npm test` must actually run and
   pass. New behavior needs a test that fails before the fix and passes after it.
4. **Secrets stay untouched.** Never open, read, print, or commit `.env`, tokens, or API keys. Never
   ask for credentials in chat.
5. **Read before you write.** Read a file completely before `patch`/`write_file`. If a patch fails,
   do not resend the same payload — re-read the file and rebuild the change.
6. **No unprompted commits or pushes.** When the owner asks, use `./update.sh` (token comes from
   `.env`; it is never written to git config).
7. **Artifacts are the proof.** A turn that changed files or verified work must leave a reviewable
   record under `~/.vallenemperor/artifacts/` (walkthrough + screenshots). Do not break that store.
8. **Docs move with the code.** New flags, commands, or behavior require updating `README.md`,
   `HELP` in `vallencli/src/cli-ui.mjs`, the command registry in `vallencli/src/cli-suggest.mjs`,
   and the relevant file under `docs/`.

## Daily commands

```bash
npm install                 # once per clone
npm run build               # compile core (tsc) + syntax-check the CLI
npm run typecheck           # tsc --noEmit
npm test                    # vallenagent + vallencli (node --test, no network)
npm install -g .            # make this repo the primary vallenemperor binary
./scripts/release.sh current    # publish the current version (owner approval required)
./update.sh                     # commit + push (owner approval required)
```

## Fast map

```text
vallenagent/src/
  agent/       turn loop split by stage: setup → provider call → verification gate → tool dispatch → finalize
  providers/   OpenAI-compatible, Anthropic, router with failover
  tools/       registry + builtin tools (file, terminal, web, mcp, media, state)
  skills/      SKILL.md loading, relevance scoring, preload budget
  skills_hub/  catalog search, quarantine, install, lock file
  memory/      MEMORY.md + deep memory with source quoting
  session/     sessions, checkpoints, todo, SQLite search index
  gateway/     Telegram adapter (pairing, allowlist, approvals, daemon)
  core/        config, approval policy, project context, cron, display
  agent/artifact_store.ts   turn artifacts: walkthrough.md, screenshots, index.json manifest
  agent/plan_mode.ts        plan parsing + step-by-step run state machine (pure logic)
  agent/subagent_registry.ts background subagent state behind /agents
  agent/worktree.ts         git worktree isolation for workspace="branch"
  agent/custom_agents.ts    .agents/agents/*.md discovery + planner routing
  core/browser_gate.ts      browser tools are locked until /browser <task>

vallencli/src/
  cli.mjs              REPL, argument parsing, one-shot mode, config commands, model picker glue
  cli-model-picker.mjs two-level picker (provider → model) over a live gateway
  cli-ui.mjs           cards, status bar, approval boxes, diffs, themes
  cli-markdown.mjs     markdown + code-fence renderer
  cli-commands.mjs     local slash commands
  cli-files.mjs        @path mentions and completion
  cli-suggest.mjs      command registry + fuzzy suggestions
  cli-theme.mjs        color levels and gradients
```

Full detail: **[docs/PROJECT.md](docs/PROJECT.md)**.

## Definition of Done

Work is done only when **all** of these are true:

- [ ] Code change has a test that failed before the fix and passes after it (or a written reason why
      no test is possible).
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass; the exact numbers are recorded.
- [ ] Version bumped by one patch and `npm install -g .` was run; smoke test used the installed
      binary (`vallenemperor --version`, `--help`, plus the command that touches the changed feature).
- [ ] Docs/HELP updated for any new surface.
- [ ] Report to the owner: what changed, test evidence, risks, and an explicit request to confirm the
      next step (commit/publish).

## When in doubt

- Read `docs/PROJECT.md` (architecture), `docs/TESTING.md` (how to prove it), `docs/RELEASING.md`
  (how to ship it).
- If a decision changes user-visible behavior (approval defaults, output format, removing a feature),
  **ask the owner** — one concise question, no guessing.
- Never claim something works without showing the real output.
- If you find a bug outside the requested scope, report it; do not fix it silently.
