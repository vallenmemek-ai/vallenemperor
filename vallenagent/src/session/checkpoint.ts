import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { getVallenHome } from '../core/config'

export interface CheckpointContext {
  sessionId?: string
  turnNumber?: number
  checkpointRoot?: string
}

interface ManifestFile {
  path: string
  existed: boolean
  mode: number | null
  sizeBefore: number
  hashBefore: string | null
  hashAfter: string | null
  status?: 'not_backed_up'
  reason?: 'too_large' | 'binary'
}

const MAX_FILE = 2 * 1024 * 1024
const MAX_TOTAL = 200 * 1024 * 1024
const MAX_TURNS = 20

export function snapshotBeforeWrite(ctx: CheckpointContext, absPath: string): string | null {
  if (!ctx.sessionId || !ctx.turnNumber) return null
  const root = resolve(ctx.checkpointRoot || join(getVallenHome(), 'checkpoints'))
  const session = resolve(root, ctx.sessionId)
  if (!session.startsWith(`${root}${sep}`) && session !== root) throw new Error('Invalid checkpoint session ID')
  const turn = join(session, `turn-${ctx.turnNumber}`)
  mkdirSync(turn, { recursive: true, mode: 0o700 })
  const manifestPath = join(turn, 'manifest.json')
  const manifest: { files: ManifestFile[] } = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: [] }
  const filePath = resolve(absPath)
  const existing = manifest.files.find(file => file.path === filePath)
  if (existing) return existing.status ? null : join(turn, 'files', `${manifest.files.indexOf(existing)}.bin`)
  let existed = existsSync(filePath), mode: number | null = null, sizeBefore = 0, hashBefore: string | null = null
  let content: Buffer | null = null, reason: ManifestFile['reason']
  if (existed) {
    const info = statSync(filePath); mode = info.mode; sizeBefore = info.size
    if (sizeBefore > MAX_FILE) reason = 'too_large'
    else {
      content = readFileSync(filePath)
      if (content.includes(0)) { reason = 'binary'; content = null }
      else hashBefore = createHash('sha256').update(content).digest('hex')
    }
  }
  const entry: ManifestFile = { path: filePath, existed, mode, sizeBefore, hashBefore, hashAfter: null }
  if (reason) { entry.status = 'not_backed_up'; entry.reason = reason }
  manifest.files.push(entry)
  if (content) {
    const target = join(turn, 'files', `${manifest.files.length - 1}.bin`)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { mode: 0o600 })
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  prune(root, session)
  return content ? join(turn, 'files', `${manifest.files.length - 1}.bin`) : null
}

function prune(root: string, currentSession: string): void {
  const sessions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))
  for (const session of sessions) {
    const turns = readdirSync(session).filter(name => /^turn-\d+$/.test(name)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    while (turns.length > MAX_TURNS) rmSync(join(session, turns.shift()!), { recursive: true, force: true })
  }
  const turns = sessions.flatMap(session => readdirSync(session).filter(name => /^turn-\d+$/.test(name)).map(name => {
    const path = join(session, name)
    return { path, size: directorySize(path), mtime: statSync(path).mtimeMs }
  })).sort((a, b) => a.mtime - b.mtime)
  let total = turns.reduce((sum, turn) => sum + turn.size, 0)
  while (total > MAX_TOTAL && turns.length) {
    const oldest = turns.shift()!
    rmSync(oldest.path, { recursive: true, force: true })
    total -= oldest.size
  }
  if (existsSync(currentSession) && !readdirSync(currentSession).some(name => /^turn-\d+$/.test(name))) rmSync(currentSession, { recursive: true, force: true })
}

function directorySize(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, item) => {
    const path = join(dir, item.name)
    return sum + (item.isDirectory() ? directorySize(path) : statSync(path).size)
  }, 0)
}

function paths(ctx: CheckpointContext): { root: string; session: string } | null {
  if (!ctx.sessionId) return null
  const root = resolve(ctx.checkpointRoot || join(getVallenHome(), 'checkpoints'))
  const session = resolve(root, ctx.sessionId)
  if (!session.startsWith(`${root}${sep}`) && session !== root) throw new Error('Invalid checkpoint session ID')
  return { root, session }
}

function readManifest(turn: string): { files: ManifestFile[] } {
  return JSON.parse(readFileSync(join(turn, 'manifest.json'), 'utf8'))
}

export interface CheckpointSummary {
  turnNumber: number
  path: string
  files: ManifestFile[]
  updatedAt: number
}

export function finalizeCheckpointTurn(ctx: CheckpointContext): boolean {
  if (!ctx.sessionId || !ctx.turnNumber) return false
  const { session } = paths(ctx)!
  const turn = join(session, `turn-${ctx.turnNumber}`)
  const manifestPath = join(turn, 'manifest.json')
  if (!existsSync(manifestPath)) return false
  const manifest = readManifest(turn)
  for (const file of manifest.files) {
    file.hashAfter = existsSync(file.path) ? createHash('sha256').update(readFileSync(file.path)).digest('hex') : null
  }
  const temp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  renameSync(temp, manifestPath)
  return true
}

export function listCheckpoints(ctx: CheckpointContext): CheckpointSummary[] {
  const location = paths(ctx)
  if (!location || !existsSync(location.session)) return []
  return readdirSync(location.session).filter(name => /^turn-\d+$/.test(name)).map(name => {
    const path = join(location.session, name)
    return { turnNumber: Number(name.slice(5)), path, files: readManifest(path).files, updatedAt: statSync(path).mtimeMs }
  }).sort((a, b) => b.turnNumber - a.turnNumber)
}

export function undoCheckpoints(ctx: CheckpointContext, count = 1, force = false): { restored: string[]; skipped: string[]; turns: number[] } {
  const summaries = listCheckpoints(ctx).slice(0, Math.max(1, Math.floor(count)))
  const restored: string[] = []
  const skipped: string[] = []
  for (const summary of summaries) {
    for (let index = summary.files.length - 1; index >= 0; index--) {
      const file = summary.files[index]
      if (file.status === 'not_backed_up') { skipped.push(`${file.path} (${file.reason || 'not backed up'})`); continue }
      const exists = existsSync(file.path)
      const currentHash = exists ? createHash('sha256').update(readFileSync(file.path)).digest('hex') : null
      if (!force && currentHash !== file.hashAfter) { skipped.push(`${file.path} (changed since checkpoint)`); continue }
      if (file.existed) {
        const backup = join(summary.path, 'files', `${index}.bin`)
        if (!existsSync(backup)) { skipped.push(`${file.path} (backup missing)`); continue }
        mkdirSync(dirname(file.path), { recursive: true })
        const temp = `${file.path}.undo-${process.pid}-${Math.random().toString(36).slice(2)}`
        writeFileSync(temp, readFileSync(backup), { mode: (file.mode || 0o644) & 0o7777 })
        renameSync(temp, file.path)
      } else if (exists) rmSync(file.path, { force: true })
      else { skipped.push(`${file.path} (already absent)`); continue }
      restored.push(file.path)
    }
  }
  return { restored, skipped, turns: summaries.map(summary => summary.turnNumber) }
}

export function getCheckpointDiff(ctx: CheckpointContext, turnNumber?: number, color = false): string {
  const summary = listCheckpoints(ctx).find(item => turnNumber === undefined || item.turnNumber === turnNumber)
  if (!summary) return 'Belum ada checkpoint untuk sesi ini.'
  const red = (line: string) => color ? `\x1b[31m${line}\x1b[0m` : line
  const green = (line: string) => color ? `\x1b[32m${line}\x1b[0m` : line
  const sections = summary.files.map((file, index) => {
    if (file.status === 'not_backed_up') return `--- ${file.path}\n(perubahan tidak dicadangkan: ${file.reason})`
    const backup = join(summary.path, 'files', `${index}.bin`)
    const before = file.existed && existsSync(backup) ? readFileSync(backup, 'utf8') : ''
    const after = existsSync(file.path) ? readFileSync(file.path, 'utf8') : ''
    return [`--- ${file.path}`, `+++ ${file.path}`, ...before.split(/\r?\n/).filter(Boolean).map(line => red(`-${line}`)), ...after.split(/\r?\n/).filter(Boolean).map(line => green(`+${line}`))].join('\n')
  })
  return sections.join('\n').slice(0, 20_000) || 'Checkpoint tidak punya perubahan file.'
}
