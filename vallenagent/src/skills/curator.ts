import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Curator — keep the skill index lean.
 *
 * The only signal we actually have is time: a skill file nobody has touched in N days is a candidate
 * for archiving. It is never deleted — `archive/` keeps it loadable by hand and restorable by moving
 * it back. The default is a dry run; `apply` is explicit.
 */

export interface StaleSkill {
  name: string
  path: string
  ageDays: number
}

export function findStaleSkills(dirs: string[], options: { staleDays?: number; now?: number } = {}): StaleSkill[] {
  const staleDays = Math.max(1, Number(options.staleDays) || 90)
  const now = Number(options.now) || Date.now()
  const stale: StaleSkill[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith('.md') && !entry.endsWith('.mdc')) continue
      const path = join(dir, entry)
      let ageDays = 0
      try { ageDays = Math.floor((now - statSync(path).mtimeMs) / 86_400_000) } catch { continue }
      if (ageDays >= staleDays) stale.push({ name: entry.replace(/\.(md|mdc)$/, ''), path, ageDays })
    }
  }
  return stale.sort((a, b) => b.ageDays - a.ageDays)
}

export function archiveSkills(skills: StaleSkill[], archiveDir: string): string[] {
  if (!skills.length) return []
  mkdirSync(archiveDir, { recursive: true })
  const moved: string[] = []
  for (const skill of skills) {
    const target = join(archiveDir, skill.path.split('/').pop() || `${skill.name}.md`)
    try {
      renameSync(skill.path, target)
      moved.push(target)
    } catch { }
  }
  return moved
}

export function formatCuratorReport(stale: StaleSkill[], options: { staleDays?: number; applied?: string[] } = {}): string {
  const days = options.staleDays || 90
  if (!stale.length) return `No skill is older than ${days} days. Nothing to archive.`
  const lines = [`${stale.length} skill(s) untouched for ${days}+ days`, ...stale.map(skill => `  ${skill.name.padEnd(28)} ${String(skill.ageDays).padStart(4)} days  ${skill.path}`)]
  if (options.applied?.length) lines.push('', `Archived ${options.applied.length} file(s):`, ...options.applied.map(path => `  ${path}`))
  else lines.push('', 'Dry run. Run /curator apply to move them into skills/archive/.')
  return lines.join('\n')
}
