import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { estimateTokens } from '../core/context_report'

/**
 * R28 — skill-index budget/delta tracking.
 *
 * The skills index is part of every request: when it grows, the context window shrinks silently.
 * This records the last measured cost in `<home>/skill-index.json` and reports the delta, so a
 * session can see "the index grew 340 tokens (+12 skills) since the last check".
 */

export interface SkillIndexSnapshot {
  at: string
  tokens: number
  skills: number
  names: string[]
}

/** What `getFormattedIndex` will cost, in tokens, for this skill set. */
export function skillIndexTokens(skills: Array<{ name: string; description?: string }>): number {
  const chars = skills.reduce((total, skill) => total + skill.name.length + String(skill.description || '').length + 8, 0)
  return estimateTokens(String(chars))
}

export function readSkillIndexSnapshot(file: string): SkillIndexSnapshot | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(value.names) && typeof value.tokens === 'number' ? value as SkillIndexSnapshot : null
  } catch { return null }
}

export function writeSkillIndexSnapshot(file: string, snapshot: SkillIndexSnapshot): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export interface SkillIndexBudget {
  tokens: number
  skills: number
  added: string[]
  removed: string[]
  deltaTokens: number | null
}

/** Compare the current index against the stored snapshot; `deltaTokens` is null on a first run. */
export function skillIndexBudget(skills: Array<{ name: string; description?: string }>, file: string): SkillIndexBudget {
  const names = skills.map(skill => skill.name).sort()
  const previous = readSkillIndexSnapshot(file)
  const added = previous ? names.filter(name => !previous.names.includes(name)) : []
  const removed = previous ? previous.names.filter(name => !names.includes(name)) : []
  return {
    tokens: skillIndexTokens(skills),
    skills: names.length,
    added,
    removed,
    deltaTokens: previous ? skillIndexTokens(skills) - previous.tokens : null
  }
}

export function formatSkillIndexBudget(budget: SkillIndexBudget): string {
  if (budget.deltaTokens === null) return `skills index : ~${budget.tokens} tokens (${budget.skills} skills) · first measurement, stored for delta tracking`
  const sign = budget.deltaTokens > 0 ? '+' : ''
  const changes: string[] = []
  if (budget.added.length) changes.push(`+${budget.added.length}: ${budget.added.slice(0, 5).join(', ')}`)
  if (budget.removed.length) changes.push(`-${budget.removed.length}: ${budget.removed.slice(0, 5).join(', ')}`)
  return `skills index : ~${budget.tokens} tokens (${budget.skills} skills) · delta ${sign}${budget.deltaTokens} tokens${changes.length ? ` · ${changes.join(' · ')}` : ''}`
}

export function skillIndexFile(home: string): string {
  return join(home, 'skill-index.json')
}
