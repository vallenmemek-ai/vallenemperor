import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Filesystem sandbox — keeps agent writes inside an allowed root.
 *
 * Antigravity bounds read/write access to the project folders by default. We cannot sandbox the
 * terminal without an OS container, but file tools can be bounded, and subagents always are: a
 * `workspace: "branch"` subagent is confined to its worktree instead of merely starting there.
 */

export type SandboxMode = 'workspace' | 'unrestricted'

export interface SandboxPolicy {
  mode: SandboxMode
  roots: string[]
}

/** Canonicalize a path without requiring it to exist (resolves the deepest existing ancestor). */
export function canonicalPath(target: string): string {
  const absolute = resolve(target)
  if (existsSync(absolute)) {
    try { return realpathSync(absolute) } catch { return absolute }
  }
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  const canonicalParent = canonicalPath(parent)
  return join(canonicalParent, absolute.slice(parent.length + 1))
}

export function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    const canonical = canonicalPath(root)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push(canonical)
  }
  return out
}

/** True when `target` is the root itself or lives underneath it (no `..` escape). */
export function isWithinRoot(target: string, root: string): boolean {
  const canonicalTarget = canonicalPath(target)
  const canonicalRoot = canonicalPath(root)
  const rel = relative(canonicalRoot, canonicalTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface PathCheck {
  allowed: boolean
  reason?: string
}

/** Empty/undefined roots mean "unrestricted" (current behaviour for the main agent). */
export function checkPathAllowed(target: string, roots: string[] | undefined): PathCheck {
  if (!roots || !roots.length) return { allowed: true }
  for (const root of roots) {
    if (isWithinRoot(target, root)) return { allowed: true }
  }
  return {
    allowed: false,
    reason: `Path is outside the sandbox: ${target}. Allowed root(s): ${roots.join(', ')}. `
      + 'Stay inside the workspace, or ask the user to widen permissions (security.filesystem).'
  }
}

export interface SandboxConfigLike {
  security?: { filesystem?: string }
  terminal?: { cwd?: string }
}

/**
 * Resolve the effective policy for a context.
 * - subagents: always confined to their working directory (worktree or parent cwd);
 * - main agent: confined only when `security.filesystem === 'workspace'`.
 */
export function sandboxPolicyFor(options: {
  isSubagent: boolean
  config: SandboxConfigLike
  workingDir?: string
  extraRoots?: string[]
}): SandboxPolicy {
  const cwd = options.workingDir || options.config?.terminal?.cwd || process.cwd()
  const mode: SandboxMode = options.config?.security?.filesystem === 'workspace' ? 'workspace' : 'unrestricted'
  if (options.isSubagent) return { mode: 'workspace', roots: normalizeRoots([cwd, ...(options.extraRoots || [])]) }
  if (mode === 'workspace') return { mode, roots: normalizeRoots([cwd, ...(options.extraRoots || [])]) }
  return { mode: 'unrestricted', roots: [] }
}

export function formatSandboxStatus(policy: SandboxPolicy): string {
  if (policy.mode === 'unrestricted' || !policy.roots.length) {
    return 'Filesystem sandbox: off (main agent can write anywhere). Subagents are always confined to their working directory.'
  }
  return `Filesystem sandbox: workspace\nAllowed root(s):\n${policy.roots.map(root => `  ${root}`).join('\n')}`
}
