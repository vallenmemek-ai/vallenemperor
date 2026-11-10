# RELEASING.md — release pipeline

Principle: **the owner holds the release button.** The agent prepares, proves, and reports; the owner
decides when a version ships.

```text
work → build + test → version +1 → install as primary app → smoke test
     → REPORT + request approval
     → owner says go  →  commit + push (./update.sh)  →  publish (./scripts/release.sh)
     → if staged: owner approves with 2FA  →  verify the registry install
```

## 0. Version series

- Production releases use normal semver (`0.x.y`).
- The `999.999.xxxx` series exists to exercise the release pipeline (staging, 2FA, approval). Do not
  mix series: ask the owner which one to bump.

## 1. Preflight

```bash
git status --short          # must be clean (or only intended changes)
npm run build
npm run typecheck
npm test                    # record the numbers
```

Do not release on a dirty tree unless the owner explicitly wants a WIP build.

## 2. Bump and make it the primary app

```bash
npm version patch --no-git-tag-version     # x.y.z -> x.y.z+1
npm run build
npm install -g .
vallenemperor --version                    # must print the new version
vallenemperor --help
vallenemperor config show                  # exercises config + packaged assets
```

Smoke test the changed surface with the **installed** binary (e.g. `/model`, `-p`, gateway command).
Testing `node vallencli/src/cli.mjs` is not enough: it bypasses the package layout.

## 3. Report and wait

The report must include: what changed, real test numbers, the new version, risks, and an explicit
question ("release now, or add features first?"). **Stop here until the owner answers.**

## 4. Commit and push (after approval)

```bash
./update.sh
```

- Reads `GITHUB_TOKEN` from `.env` (never written to git config, never echoed).
- Refuses to run without a remote or on a detached HEAD.
- `.env`, `dist/`, `node_modules/`, `*.tgz` must never be staged.

## 5. Publish

```bash
./scripts/release.sh current        # publish the version already in package.json
./scripts/release.sh patch          # or bump one more and publish
```

What the script does: run tests → bump (unless `current`) → publish → check whether the version is
actually live, printing an approval hint when it landed in staging.

Options:

- `--otp=<code>` — TOTP accounts. This also **ignores `NPM_TOKEN` from `.env`**, so the release
  publishes directly instead of staging.
- `NPM_TOKEN` — a granular token. It is written to a temporary 0600 npmrc (not to argv, not to your
  npm config).

## 6. If it lands in staging

```text
… vallenemperor@x.y.z masuk AREA STAGING (belum publik).
```

The token may only stage; a human must approve with 2FA:

1. https://www.npmjs.com/package/vallenemperor → **Staged Packages** tab
2. **Approve** → security key / TOTP

CLI alternative (npm ≥ 11.15 and Node ≥ 22.14): `npm stage list` → `npm stage approve <id>`.

While it is staged, the version is **not** installable. Do not claim it is live. Check with:

```bash
npm view vallenemperor dist-tags
npm view vallenemperor versions --json | tail -5
```

## 7. Verify from the registry

```bash
npm install -g --prefix /tmp/vem-check vallenemperor@<version>
VALLENEMPEROR_HOME=/tmp/vem-home /tmp/vem-check/bin/vallenemperor --version
```

- `ETARGET` → the version is not public yet (still staged).
- `--version` shows an older number → `latest` still points elsewhere.

## 8. When something goes wrong

| Situation | Action |
| --- | --- |
| Wrong content published | Publish a patch with the fix. `npm unpublish` is a last resort (72 h limit, breaks installs). |
| Version is broken but installed by users | `npm deprecate vallenemperor@<version> "reason"`, then release a fix. |
| `E403 cannot publish over ...` | The version already exists (published or staged). Bump again. |
| `E403 ... 2FA required` | Use `--otp=` or a token with bypass-2FA; otherwise approve via staging. |
| `E401 / ENEEDAUTH` | `npm whoami` first; `npm login` if not authenticated. |
| Push fails with `Could not resolve host` | Network/DNS issue, not auth. Verify with `getent hosts github.com` and `curl -I https://github.com`. |

## 9. Release checklist

```text
[ ] build OK            [ ] typecheck OK        [ ] npm test green (numbers recorded)
[ ] version +1          [ ] npm install -g .    [ ] smoke test on the installed binary
[ ] report + owner approval
[ ] commit + push       [ ] publish             [ ] staging approved (if staged)
[ ] registry install verified
```
