# AIDER.md — Aider inventory vs VallenEmperor

Source: `https://aider.chat/docs/repomap.html`, `/docs/more/edit-formats.html` (read 2026-11).

## 1. Repository map (the differentiator)

Aider sends a **concise map of the whole git repository** with every change request: files plus the
key classes/functions with their **types and call signatures**, and the critical definition lines.
It is built with tree-sitter, ranked by relevance to the request, and **token-budgeted**.

Why it matters: the model sees the shape of the codebase without grepping, so it writes code that
uses existing abstractions instead of reinventing them. This is the single biggest quality lever for
work in unfamiliar or large repos.

| Ours | Verdict |
| --- | --- |
| `search_files` (regex + glob), `read_file` pagination, no symbol index | **adopt** a repo map → Roadmap **R30** |

Sketch for us: `vallenagent/src/core/repo_map.ts`
- tree-sitter (or `tsc`/`ts-morph` for TS-only first) → per-file symbols: `class`, `function`,
  `method`, signatures;
- rank by file recency + name match with the request;
- budget by tokens (default ~2–4k), injected as a `# Repository map` block in the request;
- cache per git commit + invalidate on file change.

## 2. Edit formats

| Format | Shape | Ours | Verdict |
| --- | --- | --- | --- |
| `whole` | return the full file | ✅ `write_file` | parity |
| `diff` | `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks | 🟡 `patch` (`old_string`/`new_string`) | parity (same idea, different syntax) |
| `diff-fenced` | path inside the fence (Gemini models) | — | skip |
| `udiff` | simplified unified diff | 🟡 `apply_patch` (V4A) | parity |
| architect | plan with one model, edit with another | ❌ | adapt later (two-model workflow) |

## 3. Other Aider conventions

- **Git-native**: auto-commit each change with a generated message; `/undo` reverses the commit.
- **Lint/test loop**: run the project's linter/tests after edits and feed failures back.
- **`/add`, `/drop`** explicit file context selection.

| Ours | Verdict |
| --- | --- |
| Checkpoints + `/undo` (no git commits) | 🟡 acceptable; auto-commit is a user preference, not a default |
| Verification gate (typecheck/test/build) | ✅ **we are ahead** of the lint/test loop |
| `@path` mentions | ✅ parity |

## 4. What to copy

1. **Repo map** (R30) — the highest-leverage single feature in this document.
2. **Architect two-model flow** — later, after `/effort` (P1.2).
3. **Explicit context selection** — we have `@path`; add `/add`/`/drop` aliases later.
