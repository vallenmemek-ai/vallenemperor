import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Workspace code search — the engine behind `/codesearch`.
 *
 * A bounded, dependency-free walker: skips the usual heavy directories, ignores binary files, caps
 * how many files and bytes it reads, and returns hits with a few lines of context so the terminal can
 * show the match in place. Deliberately simple and deterministic (no shelling out to ripgrep) so it
 * behaves identically on Linux, macOS, Windows and Termux.
 */

export interface CodeSearchHit {
  path: string
  line: number
  column: number
  text: string
  before: string[]
  after: string[]
}

export interface CodeSearchResult {
  query: string
  hits: CodeSearchHit[]
  filesScanned: number
  filesWithHits: number
  truncated: boolean
  error?: string
}

export interface CodeSearchOptions {
  cwd: string
  query: string
  glob?: string
  limit?: number
  contextLines?: number
  ignoreDirs?: string[]
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.cache']
const MAX_FILES = 5000
const MAX_FILE_BYTES = 1_000_000

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  return sample.includes(0)
}

function walk(dir: string, ignore: Set<string>, out: string[], root: string): void {
  if (out.length >= MAX_FILES) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.isDirectory()) continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignore.has(entry.name)) continue
      walk(full, ignore, out, root)
      continue
    }
    if (!entry.isFile()) continue
    out.push(relative(root, full) || entry.name)
  }
}

export function searchWorkspace(options: CodeSearchOptions): CodeSearchResult {
  const query = String(options.query || '').trim()
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
  const contextLines = Math.max(0, Math.min(6, Number(options.contextLines ?? 2)))
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignoreDirs || [])])
  const result: CodeSearchResult = { query, hits: [], filesScanned: 0, filesWithHits: 0, truncated: false }

  if (!query) return { ...result, error: 'query is required' }
  if (!existsSync(options.cwd)) return { ...result, error: `directory not found: ${options.cwd}` }

  let pattern: RegExp
  try {
    pattern = new RegExp(query, 'i')
  } catch {
    // Treat an invalid regex as a literal string.
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const globMatcher = options.glob ? globToRegExp(options.glob) : null

  const files: string[] = []
  walk(options.cwd, ignore, files, options.cwd)

  for (const relativePath of files) {
    if (result.hits.length >= limit) { result.truncated = true; break }
    if (globMatcher && !globMatcher.test(relativePath.split(/[\\/]/).pop() || relativePath)) continue
    const full = join(options.cwd, relativePath)
    let stats
    try { stats = statSync(full) } catch { continue }
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue
    let buffer: Buffer
    try { buffer = readFileSync(full) } catch { continue }
    if (isBinary(buffer)) continue
    result.filesScanned++

    const lines = buffer.toString('utf8').split(/\r?\n/)
    let fileHit = false
    for (let index = 0; index < lines.length; index++) {
      const match = pattern.exec(lines[index])
      if (!match) continue
      fileHit = true
      result.hits.push({
        path: relativePath,
        line: index + 1,
        column: match.index + 1,
        text: lines[index],
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, index + 1 + contextLines)
      })
      if (result.hits.length >= limit) { result.truncated = true; break }
    }
    if (fileHit) result.filesWithHits++
  }

  return result
}

export function formatCodeSearch(result: CodeSearchResult): string {
  if (result.error) return `code search failed: ${result.error}`
  if (!result.hits.length) {
    return `No matches for "${result.query}" in ${result.filesScanned} file(s).`
  }
  const lines: string[] = [
    `${result.hits.length} match(es) for "${result.query}" in ${result.filesWithHits} file(s) (scanned ${result.filesScanned})`
  ]
  let currentPath = ''
  for (const hit of result.hits) {
    if (hit.path !== currentPath) {
      currentPath = hit.path
      lines.push('', currentPath)
    }
    hit.before.forEach((contextLine, index) => {
      lines.push(`  ${String(hit.line - hit.before.length + index).padStart(5)}│ ${contextLine}`)
    })
    lines.push(`  ${String(hit.line).padStart(5)}│ ${hit.text}`)
    hit.after.forEach((contextLine, index) => {
      lines.push(`  ${String(hit.line + 1 + index).padStart(5)}│ ${contextLine}`)
    })
  }
  if (result.truncated) lines.push('', '… results truncated; narrow the query or raise the limit.')
  return lines.join('\n')
}
