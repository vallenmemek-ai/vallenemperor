# VallenEmperor

Autonomous Coding and Task-Execution AI Agent Core & CLI runtime inspired by Hermes Agent architecture.

## Overview

VallenEmperor provides a clean, modular agent framework designed for terminal interactions, multi-turn reasoning, MCP (Model Context Protocol) integration, skill management, and tool execution.

### Key Components

- **`vallenagent`**: Core agent engine containing:
  - Task intent classification and verification.
  - Multi-provider LLM abstraction (OpenAI, Anthropic, Custom/Local gateways).
  - Built-in tools: filesystem operations, POSIX terminal execution, web scraping/search, state/session management, and MCP client support.
  - Dynamic skill loading and execution environment.
  - Context compaction and session persistence.
- **`vallencli`**: Terminal user interface:
  - Rich streaming response cards with markdown rendering.
  - Interactive approval prompts for dangerous commands.
  - Session resumption and history indexing.
  - Model switching and slash commands (`/model`, `/token`, `/tools`, `/skills`, `/mcp`, `/review`).
- **`bin/`**: Launcher scripts (`vallenemperor`, `vallenemperorcli`).

---

## Architecture map

`vallenagent/src` is split by responsibility. Every folder owns an `index.ts` barrel, and the
root `src/index.ts` only re-exports folders — so a new module is added in exactly one place.

```
vallenagent/src/
  index.ts            public surface: re-exports each folder barrel
  core/               config, display/rendering, cron scheduler, network safety,
                      project context (VALLEN.md/AGENTS.md), model eval harness
  providers/          LLM provider abstraction: OpenAI-compatible, Anthropic, router
  tools/              tool registry (global singleton) and tool schemas
  skills/             SKILL.md loading and skill prompt assembly
  skills_hub/         search, quarantine, install, lock file (models/lock/search/install)
  memory/             MEMORY.md handling and deep memory store with source quoting
  session/            session persistence and SQLite-backed session search
  agent/              the turn loop (agent.ts) plus extracted helpers:
                      context_window, request_messages, tool_evidence, turn_setup,
                      turn_recovery, compaction, summarizer, token_budget,
                      failure_classification, mcp_wiring
  gateway/            Telegram gateway (manager, store, daemon, cli)
  mcp/                MCP client manager, tool conversion, project config

vallencli/src/
  cli.mjs             REPL entry, slash command dispatch, agent wiring
  cli-commands.mjs    slash command implementations
  cli-ui.mjs          boxes, diff rendering, tool lines, status bar
  cli-markdown.mjs    markdown and code rendering
  cli-theme.mjs       color levels, themes, gradients
  cli-files.mjs       file mention handling (@path)
  cli-suggest.mjs     inline suggestions
```

Data lives in `~/.vallenemperor` (override with `VALLENEMPEROR_HOME`): `config.json`,
`sessions/`, `session-search.sqlite`, `memories/`, `checkpoints/`, `skills/`, `logs/`,
`gateway/`, plus `skills_hub/` (lock file, quarantine, audit log) created on first skill install.

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0

### Installation

#### Global install (npm)

Once published, the CLI installs like any other agent CLI:

```bash
npm install -g vallenemperor
vallenemperor --version
```

Until the package is on the npm registry you can install the same tarball or the GitHub repo:

```bash
# from a packed tarball
npm pack && npm install -g ./vallenemperor-0.1.0.tgz

# or straight from GitHub (runs the build on install)
npm install -g github:vallenmemek-ai/vallenemperor
```

The published package ships the compiled core (`vallenagent/dist`), the CLI sources, the bundled
skill catalog and the banner, so no build step is needed after `npm install -g`.

#### Publishing a release

```bash
./scripts/release.sh patch              # test → bump versi → npm publish
./scripts/release.sh minor --otp=123456 # akun dengan 2FA: tempel kode authenticator
NPM_TOKEN=... ./scripts/release.sh patch # atau granular token dengan "bypass 2FA"
```

Akun npm yang mewajibkan 2FA akan menolak `npm publish` dengan **E403** kecuali memakai
`--otp=<kode>` atau granular access token yang opsi *bypass 2FA*-nya aktif. Token tidak pernah
ditulis ke config npm: skrip hanya membacanya dari environment atau `.env`.

Kalau token hanya punya izin *staging*, npm menyimpan rilis di area staging dan membuat versi
placeholder `0.0.0-stage`. Rilis baru tayang setelah di-approve dengan 2FA di
**npmjs.com → package → tab Staged Packages → Approve** (atau `npm stage approve <stage-id>` pada
npm CLI 11.15+ dengan Node 22.14+). Untuk rilis manual yang langsung tayang, pakai
`npm publish --otp=<kode>`.

#### From a clone

Clone repository and install dependencies:

```bash
npm install
npm run build
```

Install CLI launcher to your `~/.local/bin`:

```bash
./install.sh --install-vallencli
```

### Running the CLI

Directly via npm:

```bash
npm run cli
```

Or via installed binary:

```bash
vallenemperor
# or
vallenemperorcli
```

---

## Configuration

VallenEmperor reads configuration from `~/.vallenemperor/config.json` or environment variables:

- `OPENAI_API_KEY`: API key for OpenAI-compatible providers.
- `OPENAI_BASE_URL`: Base URL for OpenAI-compatible gateways.
- `ANTHROPIC_API_KEY`: API key for Anthropic models.
- `VALLENEMPEROR_HOME`: Override data home directory (default: `~/.vallenemperor`).

---

## Development & Testing

Run full test suite (both packages, colors disabled):

```bash
npm test
```

Tests live next to their package and run on `node --test` against the compiled output:

- `vallenagent/tests/*.test.mjs` — turn loop, tool history, MCP end-to-end (spawns a real
  stdio MCP server from `tests/fixtures/`), cron scheduler, session search, deep memory,
  skills hub install/search, project context, approvals, patch engine.
- `vallencli/tests/*.test.mjs` — CLI wiring, rendering, installer.

Typecheck TypeScript source:

```bash
npm run typecheck
```

Build all packages:

```bash
npm run build
```

CI runs the same three commands on push and pull request (`.github/workflows/test.yml`).

---

## License

MIT © vallenganteng
