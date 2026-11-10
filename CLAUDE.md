# CLAUDE.md

Project rules and map live in **[AGENTS.md](AGENTS.md)**. Read it first, then:

1. [RULES.md](RULES.md) — binding rules: owner gate, version bump, evidence, secrets, git
2. [docs/PROJECT.md](docs/PROJECT.md) — architecture, turn stages, where code belongs
3. [docs/TESTING.md](docs/TESTING.md) — how to test
4. [docs/RELEASING.md](docs/RELEASING.md) — release pipeline and approval
5. [docs/DECISIONS.md](docs/DECISIONS.md) — decisions you must not silently reverse

Non-negotiables: never publish without the owner's explicit approval; bump the patch version for
every change and `npm install -g .`; run `npm run build && npm run typecheck && npm test` and quote
real numbers; never read or commit `.env`; never claim success without output.
