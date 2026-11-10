import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Turn artifacts — the durable, reviewable record of what an agent turn produced.
 *
 * Antigravity-style artifacts: a plan, a diff, a screenshot, a walkthrough. Each turn gets its
 * own directory under `<home>/artifacts/<session-key>/turn-<n>/` with an `index.json` manifest,
 * so a user can review the work as deliverables instead of scrolling the transcript.
 *
 * Deliberately synchronous: these are a handful of small files written once per turn, and sync
 * writes keep the turn loop and the tests deterministic.
 */

export type ArtifactKind = 'plan' | 'diff' | 'screenshot' | 'walkthrough' | 'note'

export interface ArtifactEntry {
  kind: ArtifactKind
  name: string
  path: string
  bytes: number
  createdAt: string
}

export interface ArtifactIndex {
  sessionId: string
  turn: number
  dir: string
  entries: ArtifactEntry[]
}

const KIND_EXT: Record<ArtifactKind, string> = {
  plan: '.md',
  diff: '.patch',
  screenshot: '.png',
  walkthrough: '.md',
  note: '.md'
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RESERVED = new Set(['index.json'])

/** Session ids are user-controlled; directories use a stable hash so nothing escapes the root. */
export function artifactSessionKey(sessionId: string): string {
  const value = String(sessionId || '').trim()
  if (!value) throw new Error('Artifact session id is required')
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function artifactDir(home: string, sessionId: string, turn: number): string {
  const n = Number(turn)
  if (!Number.isInteger(n) || n < 1) throw new Error('Artifact turn must be a positive integer')
  return join(home, 'artifacts', artifactSessionKey(sessionId), `turn-${n}`)
}

export function artifactFileName(kind: ArtifactKind, label?: string, now: Date = new Date()): string {
  if (!KIND_EXT[kind]) throw new Error(`Unknown artifact kind: ${kind}`)
  const raw = String(label || '').trim()
  const stem = raw
    ? raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
    : ''
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const name = `${kind}-${stem ? `${stem}-` : ''}${stamp}${KIND_EXT[kind]}`
  if (!NAME_RE.test(name)) throw new Error('Invalid artifact name')
  return name
}

function validateName(name: string): string {
  const value = String(name || '').trim()
  if (!NAME_RE.test(value) || RESERVED.has(value.toLowerCase())) throw new Error(`Invalid artifact name: ${name}`)
  return value
}

export function readArtifactIndex(dir: string): ArtifactIndex | null {
  const file = join(dir, 'index.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed as ArtifactIndex
  } catch {
    return null
  }
}

export interface WriteArtifactOptions {
  home: string
  sessionId: string
  turn: number
  kind: ArtifactKind
  content: string | Buffer
  /** Explicit file name; must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. */
  name?: string
  /** Human label folded into the generated file name. */
  label?: string
  now?: Date
}

export function writeArtifact(options: WriteArtifactOptions): ArtifactEntry {
  const { home, sessionId, turn, kind, content } = options
  const dir = artifactDir(home, sessionId, turn)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const name = options.name ? validateName(options.name) : artifactFileName(kind, options.label, options.now)
  const path = join(dir, name)
  writeFileSync(path, content, { mode: 0o600 })

  const entry: ArtifactEntry = {
    kind,
    name,
    path,
    bytes: statSync(path).size,
    createdAt: (options.now || new Date()).toISOString()
  }

  const index: ArtifactIndex = readArtifactIndex(dir) || { sessionId, turn, dir, entries: [] }
  index.sessionId = sessionId
  index.turn = turn
  index.dir = dir
  index.entries = [...index.entries.filter(item => item.name !== name), entry]
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2), { mode: 0o600 })
  return entry
}

export interface ListArtifactsOptions {
  home: string
  /** Restrict to one session (hashed the same way as the directory layout). */
  sessionId?: string
  /** Maximum number of turns to inspect, newest first. Default 20. */
  turns?: number
}

/** Flatten artifact entries across turn directories, newest turn first. */
export function listArtifacts(options: ListArtifactsOptions): ArtifactEntry[] {
  const root = join(options.home, 'artifacts')
  if (!existsSync(root)) return []
  const limit = Math.max(1, Number(options.turns) || 20)

  const sessionDirs = options.sessionId
    ? [join(root, artifactSessionKey(options.sessionId))]
    : readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))

  const turns: { dir: string; mtime: number; turn: number }[] = []
  for (const sessionDir of sessionDirs) {
    if (!existsSync(sessionDir)) continue
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^turn-\d+$/.test(entry.name)) continue
      const dir = join(sessionDir, entry.name)
      turns.push({ dir, mtime: statSync(dir).mtimeMs, turn: Number(entry.name.slice(5)) })
    }
  }
  // Newest first. mtime alone is not enough: two turns can land in the same millisecond,
  // so the turn number is the deterministic tie-breaker.
  turns.sort((a, b) => (b.mtime - a.mtime) || (b.turn - a.turn))

  const out: ArtifactEntry[] = []
  for (const turn of turns.slice(0, limit)) {
    const index = readArtifactIndex(turn.dir)
    if (index) out.push(...index.entries)
  }
  return out
}

/** Newest artifact directory for a session, or null when the session produced none. */
export function latestArtifactDir(home: string, sessionId: string): string | null {
  const entries = listArtifacts({ home, sessionId, turns: 1 })
  return entries.length ? dirname(entries[0].path) : null
}

export function formatArtifactList(entries: ArtifactEntry[], limit = 20): string {
  if (!entries.length) return 'No artifacts yet. Artifacts appear after a turn that changes files or captures a screenshot.'
  const shown = entries.slice(0, limit)
  const lines = shown.map(entry => `${entry.kind.padEnd(11)} ${(entry.bytes / 1024).toFixed(1).padStart(6)} KB  ${entry.path}`)
  if (entries.length > shown.length) lines.push(`… ${entries.length - shown.length} more`)
  return lines.join('\n')
}

export interface TurnWalkthroughOptions {
  home: string
  sessionId: string
  turn: number
  userMessage: string
  finalContent: string
  artifacts?: { created?: string[]; changed?: string[]; saved?: string[]; verification?: string[] }
  toolCalls?: number
  iterations?: number
  now?: Date
}

/**
 * Write the human-readable walkthrough for a finished turn and return its directory.
 * Returns null when there is nothing worth keeping (no files, no verification, no screenshots).
 */
export function writeTurnWalkthrough(options: TurnWalkthroughOptions): string | null {
  const { home, sessionId, turn, userMessage, finalContent } = options
  const artifacts = options.artifacts || {}
  const created = artifacts.created || []
  const changed = artifacts.changed || []
  const saved = artifacts.saved || []
  const verification = artifacts.verification || []
  if (!created.length && !changed.length && !saved.length && !verification.length) return null

  const lines: string[] = [
    `# Turn ${turn} — walkthrough`,
    '',
    `- Session: \`${sessionId}\``,
    `- When: ${(options.now || new Date()).toISOString()}`,
    `- Tool calls: ${options.toolCalls ?? 0} · iterations: ${options.iterations ?? 0}`,
    '',
    '## Request',
    '',
    String(userMessage || '').trim().slice(0, 4000) || '_(empty)_',
    '',
    '## Result',
    '',
    String(finalContent || '').trim().slice(0, 8000) || '_(empty)_',
    ''
  ]
  if (created.length) lines.push('## Created', '', ...created.map(file => `- \`${file}\``), '')
  if (changed.length) lines.push('## Changed', '', ...changed.map(file => `- \`${file}\``), '')
  if (saved.length) lines.push('## Saved', '', ...saved.map(file => `- \`${file}\``), '')
  if (verification.length) lines.push('## Verification', '', ...verification.map(cmd => `- \`${cmd}\``), '')

  writeArtifact({ home, sessionId, turn, kind: 'walkthrough', name: 'walkthrough.md', content: lines.join('\n'), now: options.now })
  return artifactDir(home, sessionId, turn)
}

/** First `lines` lines of a text artifact; binary artifacts report their size instead. */
export function readArtifactPreview(entry: ArtifactEntry, lines = 40): string {
  const header = `${entry.kind} · ${entry.name} · ${(entry.bytes / 1024).toFixed(1)} KB\n${entry.path}`
  if (entry.kind === 'screenshot' || /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
    return `${header}\n\n[binary image — open the path above to view it]`
  }
  try {
    const text = readFileSync(entry.path, 'utf8').split(/\r?\n/)
    const shown = text.slice(0, Math.max(1, lines))
    const truncated = text.length > shown.length ? `\n… ${text.length - shown.length} more line(s)` : ''
    return `${header}\n\n${shown.join('\n')}${truncated}`
  } catch (err: any) {
    return `${header}\n\n[could not read artifact: ${err?.message || 'unknown error'}]`
  }
}
