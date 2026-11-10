import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pending writes — stage cross-session memory/skill writes for review instead of committing them.
 *
 * Enabled per subsystem with `write_approval: { memory: true, skills: true }`. A staged write lands in
 * `<home>/pending/<subsystem>/<id>.json` and the agent is told it was staged, not applied. The owner
 * approves or rejects it later (`/memory pending`, `/memory approve <id>`, `/memory reject <id>`).
 *
 * Why: the self-improvement loop should not be able to silently rewrite long-term memory from a
 * single turn. Staging keeps the learning loop but adds a human checkpoint.
 */

export type PendingKind = 'memory' | 'user'
export type PendingAction = 'add' | 'replace' | 'remove'

export interface PendingWrite {
  id: string
  subsystem: 'memory' | 'skills'
  kind?: PendingKind
  action?: PendingAction
  content?: string
  old_text?: string
  createdAt: string
  sessionId?: string
  reason?: string
}

function dirFor(home: string, subsystem: string): string {
  return join(home, 'pending', subsystem)
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

export function stagePendingWrite(home: string, write: Omit<PendingWrite, 'id' | 'createdAt'> & { id?: string }): PendingWrite {
  const dir = dirFor(home, write.subsystem)
  ensureDir(dir)
  const id = write.id || `${write.subsystem}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const record: PendingWrite = { ...write, id, createdAt: new Date().toISOString() }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 })
  return record
}

export function listPendingWrites(home: string, subsystem?: 'memory' | 'skills'): PendingWrite[] {
  const subsystems = subsystem ? [subsystem] : ['memory', 'skills']
  const out: PendingWrite[] = []
  for (const name of subsystems) {
    const dir = dirFor(home, name)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      try { out.push(JSON.parse(readFileSync(join(dir, entry), 'utf8'))) } catch { }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function readPendingWrite(home: string, id: string): PendingWrite | null {
  for (const subsystem of ['memory', 'skills']) {
    const file = join(dirFor(home, subsystem), `${id}.json`)
    if (!existsSync(file)) continue
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }
  return null
}

export function removePendingWrite(home: string, id: string): boolean {
  let removed = false
  for (const subsystem of ['memory', 'skills']) {
    const file = join(dirFor(home, subsystem), `${id}.json`)
    if (!existsSync(file)) continue
    try { rmSync(file, { force: true }); removed = true } catch { }
  }
  return removed
}

export function formatPendingList(writes: PendingWrite[]): string {
  if (!writes.length) return 'No pending writes. Enable review with `write_approval: { memory: true }` in config.'
  return [
    `${writes.length} pending write(s)`,
    ...writes.map(write => `  ${write.id}  ${write.subsystem}/${write.kind || ''} ${write.action || ''}  ${(write.content || write.old_text || '').slice(0, 70)}`)
  ].join('\n')
}
