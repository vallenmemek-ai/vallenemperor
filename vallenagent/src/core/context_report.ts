import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * `/context all` — where the context window actually goes.
 *
 * Answers the question users ask most: "why is my AGENTS.md ignored?" and "what is eating my window?".
 * Everything here is computed locally from files and the tool registry — no model call, no cost.
 */

export interface ContextFileInfo {
  path: string
  tokens: number
  loaded: boolean
  note?: string
}

const CONTEXT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SOUL.md', '.cursorrules']

export function estimateTokens(text: string): number {
  return Math.ceil(String(text || '').length / 4)
}

/** Walk up from `cwd` collecting instruction files (nearest first). */
export function findContextFiles(cwd: string, maxDepth = 4): ContextFileInfo[] {
  const found: ContextFileInfo[] = []
  let dir = cwd
  for (let depth = 0; depth <= maxDepth; depth++) {
    for (const name of CONTEXT_FILE_NAMES) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      let text = ''
      try { text = readFileSync(path, 'utf8') } catch { continue }
      found.push({ path, tokens: estimateTokens(text), loaded: true })
    }
    const cursorRules = join(dir, '.cursor', 'rules')
    if (existsSync(cursorRules)) {
      try {
        for (const entry of readdirSafe(cursorRules)) {
          if (!entry.endsWith('.mdc')) continue
          const path = join(cursorRules, entry)
          const text = readFileSync(path, 'utf8')
          found.push({ path, tokens: estimateTokens(text), loaded: true })
        }
      } catch { }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

export interface ContextReportInputs {
  cwd: string
  stats?: { promptTokens?: number; contextWindow?: number; percent?: number; historyTokens?: number; systemPromptTokens?: number }
  skills?: Array<{ name: string; description?: string }>
  toolSchemas?: string[]
  systemPrompt?: string
}

export function buildContextReport(inputs: ContextReportInputs): string {
  const lines: string[] = ['Context breakdown']
  const stats = inputs.stats || {}
  if (stats.contextWindow) {
    const used = stats.promptTokens || 0
    lines.push(`  window   : ${used} / ${stats.contextWindow} tokens (${stats.percent ?? Math.round((used / stats.contextWindow) * 100)}%)`)
  }
  if (stats.systemPromptTokens) lines.push(`  system   : ~${stats.systemPromptTokens} tokens`)
  if (stats.historyTokens) lines.push(`  history  : ~${stats.historyTokens} tokens`)

  const skills = inputs.skills || []
  if (skills.length) {
    const indexChars = skills.reduce((total, skill) => total + skill.name.length + (skill.description || '').length + 8, 0)
    lines.push(`  skills   : ${skills.length} indexed · index ~${estimateTokens(String(indexChars))} tokens (loaded bodies cost extra)`)
  }

  const schemas = inputs.toolSchemas || []
  if (schemas.length) {
    const schemaChars = schemas.reduce((total, schema) => total + schema.length, 0)
    lines.push(`  tools    : ${schemas.length} schemas · ~${estimateTokens(String(schemaChars))} tokens`)
  }

  const files = findContextFiles(inputs.cwd)
  lines.push('', `Context files (${files.length})`)
  if (!files.length) lines.push('  (none found — add AGENTS.md at the repo root)')
  for (const file of files) {
    lines.push(`  ${file.loaded ? '✔' : '✖'} ~${String(file.tokens).padStart(6)} tok  ${file.path}`)
  }
  return lines.join('\n')
}
