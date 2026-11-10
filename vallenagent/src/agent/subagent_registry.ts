/**
 * Background subagent registry — the data behind the `/agents` panel.
 *
 * Antigravity-style agent manager: the parent turn can queue subagents that keep running after the
 * tool call returns, and the user can watch, inspect, or stop them. This module owns that state and
 * nothing else (no spawning, no I/O), so it is trivially testable and safe to share across surfaces.
 */

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Where a subagent works: same tree, its own git worktree, or a shared directory. */
export type SubagentWorkspace = 'inherit' | 'branch' | 'share'

export interface SubagentProgressEntry {
  at: string
  status: string
  message?: string
}

export interface SubagentWorktree {
  /** Repository the worktree belongs to; needed to remove it later. */
  repo?: string
  path: string
  branch: string
}

export interface SubagentRun {
  id: string
  goal: string
  workspace: SubagentWorkspace
  /** Custom agent definition used for this run, when the planner routed one. */
  agent?: string
  status: SubagentStatus
  startedAt: string
  finishedAt?: string
  summary?: string
  error?: string
  worktree?: SubagentWorktree
  progress: SubagentProgressEntry[]
  /** Wired by whoever spawned the run; never serialized. */
  cancel?: () => void
}

export interface CreateSubagentInput {
  goal: string
  workspace?: SubagentWorkspace
  agent?: string
  worktree?: SubagentWorktree
  id?: string
  now?: Date
}

export interface SubagentRegistryOptions {
  /** Runs allowed to be active at once. Default 4. */
  maxConcurrent?: number
  /** Finished runs kept for history. Default 20. */
  keepFinished?: number
}

const TERMINAL: SubagentStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminalStatus(status: SubagentStatus): boolean {
  return TERMINAL.includes(status)
}

export class SubagentRegistry {
  private runs = new Map<string, SubagentRun>()
  private sequence = 0
  private readonly maxConcurrent: number
  private readonly keepFinished: number

  constructor(options: SubagentRegistryOptions = {}) {
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 4)
    this.keepFinished = Math.max(1, Number(options.keepFinished) || 20)
  }

  create(input: CreateSubagentInput): SubagentRun {
    const goal = String(input.goal || '').trim()
    if (!goal) throw new Error('Subagent goal is required')
    const now = (input.now || new Date()).toISOString()
    const id = input.id || `sa-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    const run: SubagentRun = {
      id,
      goal,
      workspace: input.workspace || 'inherit',
      agent: input.agent,
      status: 'queued',
      startedAt: now,
      worktree: input.worktree,
      progress: []
    }
    this.runs.set(id, run)
    this.prune()
    return run
  }

  get(id: string): SubagentRun | undefined {
    return this.runs.get(id)
  }

  list(): SubagentRun[] {
    return [...this.runs.values()]
  }

  activeCount(): number {
    return this.list().filter(run => !isTerminalStatus(run.status)).length
  }

  canStart(): boolean {
    return this.activeCount() < this.maxConcurrent
  }

  setWorktree(id: string, worktree: SubagentWorktree | undefined): SubagentRun | undefined {
    return this.patch(id, { worktree })
  }

  markRunning(id: string): SubagentRun | undefined {
    return this.patch(id, { status: 'running' })
  }

  update(id: string, status: string, message?: string): SubagentRun | undefined {
    const run = this.runs.get(id)
    if (!run || isTerminalStatus(run.status)) return run
    run.progress.push({ at: new Date().toISOString(), status, message: message ? String(message).slice(0, 500) : undefined })
    if (run.progress.length > 50) run.progress.splice(0, run.progress.length - 50)
    if (run.status === 'queued' && status !== 'queued') run.status = 'running'
    return run
  }

  complete(id: string, summary: string): SubagentRun | undefined {
    const text = String(summary || '').trim()
    const run = this.patch(id, { status: 'completed', summary: text.slice(0, 4000), finishedAt: new Date().toISOString() })
    this.prune()
    return run
  }

  fail(id: string, error: string): SubagentRun | undefined {
    const run = this.patch(id, { status: 'failed', error: String(error || 'Unknown error').slice(0, 1000), finishedAt: new Date().toISOString() })
    this.prune()
    return run
  }

  /** Request cancellation; returns false when the run is unknown or already finished. */
  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (!run || isTerminalStatus(run.status)) return false
    try { run.cancel?.() } catch { }
    this.patch(id, { status: 'cancelled', finishedAt: new Date().toISOString() })
    this.prune()
    return true
  }

  /** Drop the oldest finished runs beyond `keepFinished`; returns the removed runs. */
  prune(): SubagentRun[] {
    const finished = this.list().filter(run => isTerminalStatus(run.status))
    if (finished.length <= this.keepFinished) return []
    const removed = finished.slice(0, finished.length - this.keepFinished)
    for (const run of removed) this.runs.delete(run.id)
    return removed
  }

  clear(): void {
    this.runs.clear()
  }

  private patch(id: string, changes: Partial<SubagentRun>): SubagentRun | undefined {
    const run = this.runs.get(id)
    if (!run) return undefined
    Object.assign(run, changes)
    return run
  }
}

/** Process-wide registry used by the delegate tool and the `/agents` command. */
export const subagentRegistry = new SubagentRegistry()

export function formatSubagentLine(run: SubagentRun, now: number = Date.now()): string {
  const icon = run.status === 'running' ? '●' : run.status === 'queued' ? '◌' : run.status === 'completed' ? '✓' : run.status === 'cancelled' ? '–' : '✗'
  const started = Date.parse(run.startedAt) || now
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now
  const seconds = Math.max(0, Math.round((end - started) / 1000))
  const where = run.workspace === 'branch' && run.worktree ? `branch:${run.worktree.branch}` : run.workspace
  const agent = run.agent ? ` [${run.agent}]` : ''
  return `${icon} ${run.id.padEnd(14)} ${run.status.padEnd(9)} ${String(seconds).padStart(4)}s  ${where.padEnd(16)} ${run.goal.slice(0, 48)}${agent}`
}

export function formatSubagentDetail(run: SubagentRun): string {
  const lines = [
    `Subagent ${run.id}`,
    `  status   : ${run.status}`,
    `  workspace: ${run.workspace}${run.worktree ? ` (${run.worktree.path})` : ''}`,
    `  goal     : ${run.goal}`,
    ...(run.agent ? [`  agent    : ${run.agent}`] : []),
    `  started  : ${run.startedAt}${run.finishedAt ? ` → ${run.finishedAt}` : ''}`
  ]
  if (run.summary) lines.push(`  summary  : ${run.summary}`)
  if (run.error) lines.push(`  error    : ${run.error}`)
  if (run.progress.length) {
    lines.push('  progress :')
    for (const entry of run.progress.slice(-10)) lines.push(`    ${entry.at} ${entry.status}${entry.message ? ` — ${entry.message}` : ''}`)
  }
  return lines.join('\n')
}
