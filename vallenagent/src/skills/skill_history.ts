import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, relative, resolve, join, sep } from 'path'
import { randomUUID } from 'crypto'
import { getVallenHome } from '../core/config'
import { chmodSafe } from '../core/platform'

type Change = { id: string; at: string; skill: string; action: string; reason: string; target: string; snapshot: string | null; pending?: boolean; undone?: string }
type Review = { at: string; kind: 'skill' | 'memory' | 'review'; name: string; change: string; reason: string }

function copyTree(source: string, target: string): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) { symlinkSync(readlinkSync(source), target); return }
  if (info.isDirectory()) {
    mkdirSync(target, { mode: info.mode & 0o7777 })
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name))
    chmodSafe(target, info.mode & 0o7777)
    return
  }
  if (!info.isFile()) throw new Error('Unsupported file type in skill history')
  copyFileSync(source, target)
  chmodSafe(target, info.mode & 0o7777)
}

export class SkillHistoryStore {
  private readonly root: string
  private readonly file: string
  constructor(root = join(getVallenHome(), 'skill-history')) {
    this.root = root
    this.file = join(root, 'changes.json')
  }
  private read(): Change[] { try { const value = JSON.parse(readFileSync(this.file, 'utf8')); return Array.isArray(value) ? value : [] } catch { return [] } }
  private write(data: Change[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSafe(this.root, 0o700)
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); chmodSafe(temp, 0o600)
    try { renameSync(temp, this.file) } catch (error) { try { unlinkSync(temp) } catch {}; throw error }
  }
  stage(skill: string, target: string, action: string, reason: string): string {
    const id = randomUUID()
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSafe(this.root, 0o700)
    const snapshot = existsSync(target) ? join(this.root, `${id}.snapshot`) : null
    if (snapshot) {
      if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error('Skill history only snapshots real directories')
      copyTree(target, snapshot)
    }
    const data = this.read(); data.unshift({ id, at: new Date().toISOString(), skill, action, reason, target: resolve(target), snapshot, pending: true })
    this.write(data)
    return id
  }
  commit(id: string): void { const data = this.read(); const row = data.find(item => item.id === id); if (!row) return; delete row.pending; this.write(data) }
  abort(id: string): void { const data = this.read(); const row = data.find(item => item.id === id); if (row?.snapshot) rmSync(row.snapshot, { recursive: true, force: true }); this.write(data.filter(item => item.id !== id)) }
  list(limit = 20): Change[] { return this.read().filter(row => !row.pending).slice(0, Math.max(1, Math.min(100, Math.trunc(limit)))) }
  undo(id: string, allowedRoots: string[]): { success: boolean; message: string } {
    const data = this.read(), row = data.find(item => item.id === id && !item.pending)
    if (!row) return { success: false, message: 'Change not found' }
    if (row.undone) return { success: false, message: `Already undone at ${row.undone}` }
    const target = resolve(row.target)
    if (!allowedRoots.some(root => { const rel = relative(resolve(root), target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) })) return { success: false, message: 'Refusing restore outside configured skill roots' }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) return { success: false, message: 'Refusing to replace symlink target' }
    if (row.snapshot && !existsSync(row.snapshot)) return { success: false, message: 'Saved skill version is missing' }
    const parent = resolve(target, '..'); mkdirSync(parent, { recursive: true, mode: 0o700 })
    const displaced = `${target}.${process.pid}.undo`
    try {
      if (existsSync(target)) renameSync(target, displaced)
      if (row.snapshot) copyTree(row.snapshot, target)
      rmSync(displaced, { recursive: true, force: true })
      row.undone = new Date().toISOString(); this.write(data)
      return { success: true, message: `Restored ${row.skill} (${row.id})` }
    } catch (error: any) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      if (existsSync(displaced)) renameSync(displaced, target)
      return { success: false, message: `Restore failed: ${error.message || String(error)}` }
    }
  }
}

export class ReviewLogStore {
  private readonly file: string
  constructor(file = join(getVallenHome(), 'review-log.json')) { this.file = file }
  record(items: Array<{ kind?: string; name?: string; change?: string; reason?: string }>): void {
    let rows: Review[] = []
    try { const value = JSON.parse(readFileSync(this.file, 'utf8')); if (Array.isArray(value)) rows = value } catch {}
    const at = new Date().toISOString()
    for (const item of items) if ((item.kind === 'skill' || item.kind === 'memory' || item.kind === 'review') && item.name && item.change) rows.unshift({ at, kind: item.kind, name: item.name.slice(0, 120), change: item.change.slice(0, 500), reason: String(item.reason || 'No reason supplied').slice(0, 300) })
    if (!items.length) return
    rows = rows.slice(0, 500)
    mkdirSync(resolve(this.file, '..'), { recursive: true, mode: 0o700 }); chmodSafe(resolve(this.file, '..'), 0o700)
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); chmodSafe(temp, 0o600)
    try { renameSync(temp, this.file) } catch (error) { try { unlinkSync(temp) } catch {}; throw error }
  }
  list(limit = 20): Review[] { try { const value = JSON.parse(readFileSync(this.file, 'utf8')); return Array.isArray(value) ? value.slice(0, Math.max(1, Math.min(100, Math.trunc(limit)))) : [] } catch { return [] } }
}
