# RULES.md — binding working rules for AI agents

This file is binding. If an instruction conflicts with it, **ask the owner before proceeding**.
Keywords: **MUST** / **MUST NOT** are hard requirements; **SHOULD** is a strong default that may be
overridden only with a stated reason.

Goal: no sloppy code, no fabricated claims, and the owner keeps control over releases.

---

## R1 — Owner gate: nothing ships without explicit approval

Release flow is a gate, not a suggestion:

```text
work → tests → version +1 → install as primary app → report evidence
     → owner says "OK" / "go"  →  commit + push  →  publish
```

- You **MUST NOT** run `npm publish` or `./scripts/release.sh` before the owner approves the
  specific version you are about to ship.
- You **MUST** stop at the report. "While I was here I also published" is a violation.
- If the owner says "add the feature first", defer the release and restart the flow afterwards.
- If a publish lands in **staging** (npm 2FA), you **MUST** report the approval link and must not
  claim the version is live.
- You **MUST** re-confirm if the diff changed after approval (new commits, rebased branch, extra
  fix). Approval applies to what the owner reviewed, not to "whatever is on disk now".

Why: publishing is irreversible for users and cannot be undone cleanly (npm blocks re-publishing a
version). The owner is the release manager.

## R2 — One change, one version, and the new version becomes the primary app

- Every update **MUST** bump the patch version: `npm version patch --no-git-tag-version`
  (`x.y.z → x.y.z+1`).
- The bumped version **MUST** be installed as the primary binary before you judge it:
  ```bash
  npm run build && npm install -g .
  vallenemperor --version    # must print the new version
  ```
- Smoke tests **MUST** use the installed binary. Running `node vallencli/src/cli.ts` alone is not
  enough: it bypasses the package layout (`files`, `dist/`, bundled skills, bin symlink).
- Documentation-only changes: bump the version if the owner asked for it; otherwise state explicitly
  in the report that the version was not changed and why.
- Version series: production uses semver `0.x.y`. The `999.999.xxxx` series exists to exercise the
  release pipeline (staging/2FA). Ask the owner which series to bump.

Why: the owner tests "the app", not "the source tree". A version that was never installed cannot be
tested, and a report without a version cannot be traced.

## R3 — Evidence, not claims

Before reporting, these **MUST** run and their results **MUST** be quoted:

```bash
npm run build
npm run typecheck
npm test
```

- New behavior **MUST** have a test that **fails before** the fix and **passes after** it. If the
  test already passed, it proves nothing — rewrite the test, never delete the assertion.
- If existing test counts change, explain why (new tests vs. removed tests).
- You **MUST NOT** write "tested" or "works" without real output. Fabricating command output is the
  single worst failure mode in this repo.
- When a test cannot be written (e.g. it needs a physical device), say so and describe the manual
  verification you actually performed.

## R4 — Secrets are untouchable

- You **MUST NOT** open, read, print, or copy `.env` (it holds `GITHUB_TOKEN`, `NPM_TOKEN`, and other
  credentials).
- You **MUST NOT** place tokens in `package.json`, remote URLs, npm config files, commit messages, or
  chat. Scripts that need a token read it themselves (`./update.sh`, `./scripts/release.sh`) and
  never echo it.
- You **MUST NOT** ask the owner for a password, OTP, or token in chat. If 2FA is required, tell the
  owner which command to run in their own terminal.
- Before committing, verify: `git ls-files | grep -E '(^|/)\.env$'` returns nothing.
- If a secret was exposed, report it immediately; do not "clean it up" with a force-push.

## R5 — Git discipline

- Commit in small, focused units. One topic per commit.
- Prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`.
- You **MUST NOT** run `git reset --hard`, `git push --force`, `git rebase` on shared history, or
  rewrite commits that were already pushed.
- Commit/push only when the owner asks. Use `./update.sh` (it refuses without a remote, reads the
  token from `.env`, and never writes the token to git config).
- `.env`, `update.sh`, `dist/`, `node_modules/`, `*.tgz`, and local reports **MUST NOT** be
  committed.
- If a push fails, diagnose before blaming auth: `getent hosts github.com` and a `curl -I` separate
  DNS/network failures from credential failures. Report the actual cause.

## R6 — Edit files safely

- You **MUST** read a file completely before `patch`/`write_file`; the tools enforce this for a
  reason.
- `patch` requires a unique `old_string`. If it is ambiguous, add surrounding context instead of
  guessing.
- If a patch fails: **do not retry the same payload**. Re-read the current file, rebuild the payload
  from what is actually on disk.
- Never hand-edit `dist/` or `node_modules/` — they are build output.
- For large edits, work in steps and run `npm run typecheck` after each step.
- Never use `sed -i`/`awk` for source edits; use the patch tool so the change is reviewable.

## R7 — Architecture contracts

- Dependency direction is one-way: **`vallencli` may import from `vallenagent`; never the reverse.**
- The turn loop is split by stage (`agent/turn_*.ts`). New stage-level logic belongs in a stage
  module with explicit dependencies, not in `agent.ts`.
- Every tool **MUST** be registered with a schema and covered by a test.
- Behavior that involves approvals, verification, or session state **MUST** keep its tests green
  (see `docs/TESTING.md`).
- The CLI **MUST** remain usable without a TTY (`-p`, piped stdin): no interactive prompt may block
  forever without an escape path.
- Public behavior changes (flags, command output, config keys) require a docs update in the same
  change.

## R8 — Cross-platform by default

- The suite runs on Linux, macOS, and Windows (CI matrix). Do not add POSIX-only assumptions
  (`/tmp`, `bash`, `sh -c`, `chmod`, `SIGKILL`) without a `process.platform` guard.
- Use `node:path`, `node:os` (`tmpdir()`), and the `node --test` API — not shell globs.
- New native dependencies need prebuilt binaries or a documented fallback; the "termux-shape" CI job
  exists because Android/aarch64 has no prebuilt native modules.

## R9 — Documentation is part of the change

Update, in the same change:

- `README.md` (features / quick start) and the affected package README,
- `HELP` in `vallencli/src/cli-ui.ts` and the command registry in `vallencli/src/cli-suggest.ts`,
- `vallenagent/src/core/commands.ts` for commands shared by every surface,
- `docs/PROJECT.md` when adding a module or a turn stage,
- `docs/DECISIONS.md` when you make an architectural choice that future agents might undo by accident.

## R10 — Scope discipline

- Fix what was asked. Do not refactor unrelated code in the same change.
- If you find an unrelated bug: write it in the report, do not fix it silently.
- If a requested change conflicts with an existing decision in `docs/DECISIONS.md`, raise it before
  implementing.

## R11 — Failure handling

- Diagnose first: read the exit code, the log, the failing assertion. Do not loop blindly.
- Retry only when the failure is transient (network, flaky timing), and say so.
- If a step keeps failing after two honest attempts, stop and report what you tried, what you saw,
  and what you need.
- Never suppress an error to make a test pass (`catch {}` around a real failure, skipping tests,
  loosening assertions) unless the code path is explicitly best-effort and documented.

## R12 — Reporting format

Every report to the owner **MUST** contain:

```text
What changed:      <files / modules / behavior>
Evidence:          build=OK typecheck=OK test=<a>/<a> + <b>/<b>
Version:           <new version> installed via npm install -g .
Smoke test:        <commands run against the installed binary + result>
Risks / notes:     <breaking changes, follow-ups, known gaps>
Next step:         <explicit question: release now, or add features first?>
```

Keep it short. No marketing language. Numbers must be real.

---

## Pre-report checklist

```text
[ ] build OK              [ ] typecheck OK          [ ] npm test green (numbers recorded)
[ ] new test failed before the fix, passes after
[ ] version +1            [ ] npm install -g .      [ ] smoke test on the installed binary
[ ] docs/HELP updated     [ ] no secrets staged     [ ] report + explicit approval request
```

## Escalation

Ask the owner (one concise question) when:

- a decision changes user-visible behavior or defaults,
- the requested change conflicts with a recorded decision,
- credentials/2FA are required,
- two honest fix attempts failed,
- the change would require deleting user data, history, or a published version.
