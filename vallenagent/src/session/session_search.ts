import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const Database: any = require('better-sqlite3')

export interface SessionHit {
  sessionId: string
  file: string
  score: number
  snippet: string
  matchedTerms: string[]
}

const MAX_FILES = 10_000
const SNIPPET_CHARS = 240
const STOPWORDS = new Set(['yang', 'dan', 'untuk', 'dengan', 'dari', 'itu', 'ini', 'ada', 'tidak', 'bisa', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'not', 'you', 'are'])

function sessionDirs(): string[] {
  const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
  return [join(home, 'sessions'), join(home, 'gateway', 'telegram', 'sessions')].filter(existsSync)
}

export function tokenize(query: string): string[] {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9_.\-]+/).filter(term => term.length >= 3 && !STOPWORDS.has(term)))].slice(0, 12)
}

function readMessages(file: string): Array<{ role?: string; content?: string }> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray(raw.messages)) return raw.messages
    if (raw && Array.isArray(raw.history)) return raw.history
  } catch {}
  return []
}

function searchable(file: string): { sessionId: string; title: string; body: string } | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const messages = Array.isArray(data) ? data : data.messages || data.history
    if (!Array.isArray(messages)) return null
    const body = messages.filter((message: any) => message?.role !== 'system' && typeof message?.content === 'string')
      .map((message: any) => message.content).join('\n').slice(0, 2_000_000)
    return { sessionId: String(data.id || file.split('/').pop()!.replace(/\.json$/, '')), title: String(data.title || ''), body }
  } catch { return null }
}

function legacySearch(query: string, options: { limit?: number; dirs?: string[] }): SessionHit[] {
  const terms = tokenize(query)
  const hits: SessionHit[] = []
  const files = (options.dirs ?? sessionDirs()).flatMap(dir => {
    try { return readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith('.meta.json')).map(name => join(dir, name)) } catch { return [] }
  }).slice(0, MAX_FILES)
  for (const file of files) {
    const messages = readMessages(file)
    const sessionId = searchable(file)?.sessionId || file.split('/').pop()!.replace(/\.json$/, '')
    let score = 0
    let snippet = ''
    const matched = new Set<string>()
    for (const message of messages) {
      if (message.role === 'system' || typeof message.content !== 'string') continue
      const lower = message.content.toLowerCase()
      for (const term of terms) {
        const index = lower.indexOf(term)
        if (index < 0) continue
        score++
        matched.add(term)
        if (!snippet || message.role === 'user') snippet = message.content.slice(Math.max(0, index - 70), index + SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
      }
    }
    if (score) hits.push({ sessionId, file, score, snippet, matchedTerms: [...matched] })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(options.limit ?? 10, 50)))
}

function openIndex(path: string) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  chmodSync(path, 0o600)
  db.pragma('journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS session_files (file TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(session_id UNINDEXED, file UNINDEXED, title, body, tokenize='unicode61');`)
  return db
}

function syncIndex(db: ReturnType<typeof openIndex>, dirs: string[]): void {
  const files = dirs.flatMap(dir => {
    try { return readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith('.meta.json')).map(name => join(dir, name)) } catch { return [] }
  }).slice(0, MAX_FILES)
  const present = new Set(files)
  const known = new Map<string, { mtime: number; size: number }>((db.prepare('SELECT file, mtime, size FROM session_files').all() as any[]).map(row => [row.file, row]))
  const remove = db.prepare('DELETE FROM session_fts WHERE file = ?')
  const drop = db.prepare('DELETE FROM session_files WHERE file = ?')
  const add = db.prepare('INSERT INTO session_files(file, mtime, size) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET mtime=excluded.mtime, size=excluded.size')
  const insert = db.prepare('INSERT INTO session_fts(session_id, file, title, body) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (const file of known.keys()) if (!present.has(file)) { remove.run(file); drop.run(file) }
    for (const file of files) {
      let info
      try { info = statSync(file) } catch { continue }
      const old = known.get(file)
      const mtime = Math.trunc(info.mtimeMs)
      if (old && old.mtime === mtime && old.size === info.size) continue
      const row = searchable(file)
      remove.run(file)
      if (!row) { drop.run(file); continue }
      insert.run(row.sessionId, file, row.title, row.body)
      add.run(file, mtime, info.size)
    }
  })()
}

export function indexSessionFile(file: string): void {
  try {
    const row = searchable(file)
    if (!row) return
    const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
    const db = openIndex(join(home, 'session-search.sqlite'))
    try {
      const info = statSync(file)
      db.transaction(() => {
        db.prepare('DELETE FROM session_fts WHERE file = ?').run(file)
        db.prepare('INSERT INTO session_fts(session_id, file, title, body) VALUES (?, ?, ?, ?)').run(row.sessionId, file, row.title, row.body)
        db.prepare('INSERT INTO session_files(file, mtime, size) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET mtime=excluded.mtime, size=excluded.size').run(file, Math.trunc(info.mtimeMs), info.size)
      })()
    } finally { db.close() }
  } catch {}
}

export function searchSessions(query: string, options: { limit?: number; dirs?: string[]; sqlitePath?: string } = {}): SessionHit[] {
  const terms = tokenize(query)
  if (!terms.length) return []
  const dirs = options.dirs ?? sessionDirs()
  try {
    const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
    const db = openIndex(options.sqlitePath || join(home, 'session-search.sqlite'))
    try {
      syncIndex(db, dirs)
      const expression = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      const rows = db.prepare(`SELECT session_id, file, -bm25(session_fts, 0, 0, 3.0, 1.0) AS score,
        snippet(session_fts, 3, '', '', ' … ', 36) AS snippet
        FROM session_fts WHERE session_fts MATCH ? ORDER BY bm25(session_fts, 0, 0, 3.0, 1.0) LIMIT ?`)
        .all(expression, Math.max(1, Math.min(options.limit ?? 10, 50))) as any[]
      return rows.map(row => ({ sessionId: row.session_id, file: row.file, score: row.score,
        snippet: String(row.snippet || row.title || '').replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS),
        matchedTerms: terms.filter(term => String(row.snippet || '').toLowerCase().includes(term)) }))
    } finally { db.close() }
  } catch { return legacySearch(query, options) }
}

export function formatHits(hits: SessionHit[]): string {
  if (!hits.length) return 'Tidak ada sesi lama yang cocok.'
  return hits.map((hit, index) => `${index + 1}. ${hit.sessionId} (skor ${hit.score.toFixed(3)}; term: ${hit.matchedTerms.join(', ')})\n   ${hit.snippet}`).join('\n')
}

export function viewSession(sessionId: string, options: { offset?: number; limit?: number; dirs?: string[] } = {}): { sessionId: string; total: number; messages: Array<{ role?: string; content?: string }> } | null {
  const safeId = String(sessionId || '')
  if (!safeId || safeId.includes('/') || safeId.includes('\\') || safeId.includes('..')) return null
  for (const dir of options.dirs ?? sessionDirs()) {
    let names: string[]
    try { names = readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith('.meta.json')) } catch { continue }
    for (const name of names) {
      const file = join(dir, name)
      const data = searchable(file)
      if (!data || (data.sessionId !== safeId && name.replace(/\.json$/, '') !== safeId)) continue
      const messages = readMessages(file)
      const offset = Math.max(0, Math.floor(options.offset || 0))
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 20)))
      return { sessionId: data.sessionId, total: messages.length, messages: messages.slice(offset, offset + limit) }
    }
  }
  return null
}

export function ensureSessionDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
