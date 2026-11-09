import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getVallenHome } from '../core/config'
import { chmodSafe } from '../core/platform'

export type SkillOutcome = 'unknown' | 'verified' | 'failed'
type SkillStats = { view_count: number; manage_count: number; completed_count: number; verified_count: number; failed_verification_count: number; correction_count: number }
type StatsFile = { skills: Record<string, SkillStats>; correction_keys: string[] }
const emptyStats = (): SkillStats => ({ view_count: 0, manage_count: 0, completed_count: 0, verified_count: 0, failed_verification_count: 0, correction_count: 0 })

function normalizeStats(value: any = {}): SkillStats {
  return {
    view_count: Number(value.view_count) || 0,
    manage_count: Number(value.manage_count) || 0,
    completed_count: Number(value.completed_count) || Number(value.success_count) || 0,
    verified_count: Number(value.verified_count) || 0,
    failed_verification_count: Number(value.failed_verification_count) || 0,
    correction_count: Number(value.correction_count) || 0
  }
}

function ensureSkill(data: StatsFile, name: string): SkillStats {
  data.skills[name] = normalizeStats(data.skills[name] || emptyStats())
  return data.skills[name]
}

export class SkillStatsStore {
  private readonly file: string
  constructor(file = join(getVallenHome(), 'skill-stats.json')) { this.file = file }

  private read(): StatsFile {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      const skills = Object.fromEntries(Object.entries(data.skills || {}).map(([name, stats]) => [name, normalizeStats(stats)]))
      return { skills, correction_keys: Array.isArray(data.correction_keys) ? data.correction_keys.slice(-2000) : [] }
    } catch { return { skills: {}, correction_keys: [] } }
  }

  private write(data: StatsFile): void {
    const dir = join(this.file, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSafe(dir, 0o700)
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSafe(temp, 0o600)
    try { renameSync(temp, this.file) } catch (error) { try { unlinkSync(temp) } catch {}; throw error }
  }

  recordView(name: string, _sessionId?: string): void {
    const data = this.read()
    ensureSkill(data, name).view_count++
    this.write(data)
  }

  recordManage(name: string): void {
    const data = this.read()
    ensureSkill(data, name).manage_count++
    this.write(data)
  }

  recordCompleted(name: string, outcome: SkillOutcome): void {
    const data = this.read()
    const stats = ensureSkill(data, name)
    stats.completed_count++
    if (outcome === 'verified') stats.verified_count++
    if (outcome === 'failed') stats.failed_verification_count++
    this.write(data)
  }

  recordCorrection(sessionId: string, turn: number, skillName?: string): void {
    if (!skillName) return
    const data = this.read()
    const key = `${sessionId}:${turn}:${skillName}`
    if (data.correction_keys.includes(key)) return
    ensureSkill(data, skillName).correction_count++
    data.correction_keys.push(key)
    if (data.correction_keys.length > 2000) data.correction_keys = data.correction_keys.slice(-2000)
    this.write(data)
  }

  list(): Array<{ name: string } & SkillStats> {
    return Object.entries(this.read().skills).map(([name, stats]) => ({ name, ...stats })).sort((a, b) => a.name.localeCompare(b.name))
  }
}
