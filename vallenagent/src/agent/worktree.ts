import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Git worktree isolation for subagents (`workspace: 'branch'`).
 *
 * A branch subagent gets its own checkout so it cannot fight the parent over the same files. Worktrees
 * live under `<home>/worktrees/<repo-hash>/<id>` — outside the repository, so the user's tree stays
 * clean and `git status` never shows them.
 */

export interface WorktreeInfo {
  repo: string
  path: string
  branch: string
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

export function isGitRepo(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir).trim() === 'true'
  } catch {
    return false
  }
}

/** Current HEAD commit, used as the base for a worktree branch. */
export function headCommit(repo: string): string {
  return git(['rev-parse', 'HEAD'], repo).trim()
}

export function worktreeRoot(home: string, repo: string): string {
  const key = createHash('sha256').update(repo).digest('hex').slice(0, 12)
  return join(home, 'worktrees', key)
}

export interface CreateWorktreeOptions {
  repo: string
  home: string
  id: string
  baseRef?: string
}

export function createSubagentWorktree(options: CreateWorktreeOptions): WorktreeInfo {
  const { repo, home, id } = options
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id || ''))) throw new Error('Invalid worktree id')
  if (!isGitRepo(repo)) throw new Error('workspace="branch" requires a git repository')

  const root = worktreeRoot(home, repo)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, id)
  const branch = `vallen/subagent-${id}`
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })

  git(['worktree', 'add', '-b', branch, path, options.baseRef || 'HEAD'], repo)
  return { repo, path, branch }
}

/** Remove the checkout and its branch; never throws (cleanup must not break a turn). */
export function removeSubagentWorktree(info: Partial<WorktreeInfo> | undefined): void {
  if (!info?.repo || !info?.path) return
  try { git(['worktree', 'remove', '--force', info.path], info.repo) } catch { }
  try { rmSync(info.path, { recursive: true, force: true }) } catch { }
  if (info.branch) {
    try { git(['branch', '-D', info.branch], info.repo) } catch { }
  }
  try { git(['worktree', 'prune'], info.repo) } catch { }
}

/** Paths of worktrees registered for a repository (used by tests and `/agents clean`). */
export function listWorktrees(repo: string): string[] {
  try {
    return git(['worktree', 'list', '--porcelain'], repo)
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
  } catch {
    return []
  }
}
