import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Repository map — a compact, token-budgeted index of the codebase's symbols.
 *
 * Aider's biggest quality lever: the model sees classes/functions/signatures across the repo instead
 * of grepping blind, so it reuses existing abstractions. Ours is dependency-free: a per-language
 * regex extractor (no tree-sitter), ranked by query relevance and file recency, capped by a character
 * budget that maps to roughly `budgetChars / 4` tokens.
 */

export interface RepoMapOptions {
  cwd: string
  query?: string
  budgetChars?: number
  maxFiles?: number
  ignoreDirs?: string[]
}

export interface RepoMapResult {
  text: string
  files: number
  symbols: number
  truncated: boolean
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.kt'])
const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.cache', '.vallenemperor']
const MAX_FILE_BYTES = 400_000

function walk(dir: string, ignore: Set<string>, out: string[], root: string, depth = 0): void {
  if (depth > 12) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignore.has(entry.name) || entry.name.startsWith('.')) continue
      walk(full, ignore, out, root, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0) continue
    if (!SOURCE_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
    out.push(relative(root, full))
  }
}

interface SymbolHit { kind: string; name: string; signature?: string }

const PATTERNS: Array<{ ext: RegExp; pattern: RegExp }> = [
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i, pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)\s*(\([^)]*\))?/ },
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i, pattern: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/ },
  { ext: /\.py$/i, pattern: /^\s*(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?/ },
  { ext: /\.go$/i, pattern: /^(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/ },
  { ext: /\.rs$/i, pattern: /^\s*(?:pub\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { ext: /\.(java|cs|kt|swift)$/i, pattern: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(class|interface|enum|record|struct|func|fun)\s+([A-Za-z_][A-Za-z0-9_]*)/ }
]

function extractSymbols(path: string, text: string): SymbolHit[] {
  const rules = PATTERNS.filter(rule => rule.ext.test(path))
  if (!rules.length) return []
  const hits: SymbolHit[] = []
  for (const line of text.split(/\r?\n/)) {
    for (const rule of rules) {
      const match = rule.pattern.exec(line)
      if (!match) continue
      // The JS `const x = (` rule has the name in group 1; the others in group 2.
      const kind = match[2] ? match[1] : 'const'
      const name = match[2] || match[1]
      if (!name || name.length > 80) continue
      hits.push({ kind, name, signature: match[3] || undefined })
      break
    }
    if (hits.length >= 80) break
  }
  return hits
}

function relevance(path: string, symbols: SymbolHit[], query: string, mtime: number): number {
  let score = 0
  const lowerQuery = query.toLowerCase()
  if (lowerQuery) {
    if (path.toLowerCase().includes(lowerQuery)) score += 20
    for (const symbol of symbols) {
      if (symbol.name.toLowerCase().includes(lowerQuery)) score += 10
    }
  }
  // Recency: newer files first, capped so an old file can still rank on relevance.
  score += Math.min(10, Math.max(0, (mtime - (Date.now() - 7 * 24 * 60 * 60 * 1000)) / (24 * 60 * 60 * 1000)))
  return score
}

export function buildRepoMap(options: RepoMapOptions): RepoMapResult {
  const cwd = options.cwd
  const budgetChars = Math.max(500, Math.min(60_000, Number(options.budgetChars) || 12_000))
  const maxFiles = Math.max(10, Math.min(2000, Number(options.maxFiles) || 400))
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignoreDirs || [])])
  const query = String(options.query || '').trim()

  const files: string[] = []
  walk(cwd, ignore, files, cwd)

  const entries: Array<{ path: string; symbols: SymbolHit[]; score: number }> = []
  for (const relativePath of files.slice(0, maxFiles * 4)) {
    const full = join(cwd, relativePath)
    let stats
    try { stats = statSync(full) } catch { continue }
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue
    let text = ''
    try { text = readFileSync(full, 'utf8') } catch { continue }
    const symbols = extractSymbols(relativePath, text)
    if (!symbols.length) continue
    entries.push({ path: relativePath, symbols, score: relevance(relativePath, symbols, query, stats.mtimeMs) })
  }

  entries.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const lines: string[] = []
  let used = 0
  let symbolCount = 0
  let truncated = false

  for (const entry of entries) {
    if (lines.length >= maxFiles) { truncated = true; break }
    const symbols = entry.symbols.slice(0, 24).map(symbol => `${symbol.kind} ${symbol.name}`).join(' · ')
    const line = `${entry.path}: ${symbols}`
    if (used + line.length + 1 > budgetChars) { truncated = true; break }
    lines.push(line)
    used += line.length + 1
    symbolCount += entry.symbols.length
  }

  return {
    text: lines.length ? lines.join('\n') : '(no symbols found)',
    files: lines.length,
    symbols: symbolCount,
    truncated
  }
}

export function formatRepoMap(result: RepoMapResult): string {
  const header = `Repository map · ${result.files} file(s) · ${result.symbols} symbol(s)${result.truncated ? ' · truncated to budget' : ''}`
  return `${header}\n${result.text}`
}
