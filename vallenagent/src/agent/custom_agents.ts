import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Custom agents — reusable role definitions the planner can route work to.
 *
 * Antigravity-compatible layout:
 *   <workspace>/.agents/agents/<name>.md      (or <name>/agent.md)
 *   <home>/agents/<name>.md                   (or <name>/agent.md)
 *
 * Frontmatter: name, description, tools (list), model (optional). `description` is what the planner
 * matches against, so it must say *when* to use the agent, not just what it is.
 */

export interface CustomAgent {
  name: string
  description: string
  tools: string[]
  model?: string
  instructions: string
  path: string
  scope: 'workspace' | 'global'
}

export interface DiscoverOptions {
  workspace: string
  home: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(item => unquote(item)).filter(Boolean)
  }
  return trimmed.split(',').map(item => unquote(item)).filter(Boolean)
}

export interface ParsedAgentFile {
  name: string
  description: string
  tools: string[]
  model?: string
  instructions: string
}

/** Parse a markdown agent file with optional YAML frontmatter. */
export function parseAgentFile(text: string, fallbackName = ''): ParsedAgentFile {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  const frontmatter = match ? match[1] : ''
  const body = match ? source.slice(match[0].length) : source

  const fields: Record<string, string> = {}
  const listFields: Record<string, string[]> = {}
  let currentList: string | null = null
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentList) {
      listFields[currentList] = [...(listFields[currentList] || []), unquote(item[1])]
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2]
    if (!value.trim()) {
      currentList = key
      listFields[key] = []
      continue
    }
    currentList = null
    fields[key] = unquote(value)
  }

  const tools = listFields.tools?.length ? listFields.tools : parseList(fields.tools || '')
  return {
    name: fields.name || fallbackName,
    description: fields.description || '',
    tools,
    model: fields.model || undefined,
    instructions: body.trim()
  }
}

function readAgentFile(path: string, fallbackName: string, scope: 'workspace' | 'global'): CustomAgent | null {
  try {
    const parsed = parseAgentFile(readFileSync(path, 'utf8'), fallbackName)
    if (!parsed.name || !parsed.description) return null
    return { ...parsed, path, scope }
  } catch {
    return null
  }
}

function readAgentDir(dir: string, scope: 'workspace' | 'global'): CustomAgent[] {
  if (!existsSync(dir)) return []
  const agents: CustomAgent[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = join(dir, entry.name, 'agent.md')
      if (existsSync(nested)) {
        const agent = readAgentFile(nested, entry.name, scope)
        if (agent) agents.push(agent)
      }
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    const agent = readAgentFile(join(dir, entry.name), entry.name.replace(/\.md$/, ''), scope)
    if (agent) agents.push(agent)
  }
  return agents
}

/** Discover agents; workspace definitions win over global ones with the same name. */
export function discoverCustomAgents(options: DiscoverOptions): CustomAgent[] {
  const global = readAgentDir(join(options.home, 'agents'), 'global')
  const workspace = readAgentDir(join(options.workspace, '.agents', 'agents'), 'workspace')
  const byName = new Map<string, CustomAgent>()
  for (const agent of global) byName.set(agent.name.toLowerCase(), agent)
  for (const agent of workspace) byName.set(agent.name.toLowerCase(), agent)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'use', 'when', 'this', 'that', 'is', 'are', 'it', 'its'])

export function distinctWords(text: string): string[] {
  return [...new Set(String(text || '').toLowerCase().match(/[a-z0-9_-]+/g) || [])].filter(word => word.length > 2 && !STOPWORDS.has(word))
}

export interface AgentSelection {
  agent: CustomAgent
  score: number
  matched: string[]
}

/**
 * Route a task to the best custom agent. Requires at least two distinct matched words (or the
 * agent's name appearing verbatim), so a single common word never wins.
 */
export function selectAgentForTask(task: string, agents: CustomAgent[]): AgentSelection | null {
  const taskText = String(task || '').toLowerCase()
  const taskWords = distinctWords(task)
  let best: AgentSelection | null = null

  for (const agent of agents) {
    const descriptionWords = distinctWords(`${agent.name} ${agent.description}`)
    const matched = taskWords.filter(word => descriptionWords.includes(word))
    const nameHit = taskText.includes(agent.name.toLowerCase().replace(/[-_]/g, ' ')) || taskText.includes(agent.name.toLowerCase())
    const score = matched.length + (nameHit ? 2 : 0)
    if (!nameHit && matched.length < 2) continue
    if (!best || score > best.score) best = { agent, score, matched }
  }
  return best
}

export function formatAgentList(agents: CustomAgent[]): string {
  if (!agents.length) {
    return [
      'No custom agents found.',
      'Create one at .agents/agents/<name>.md (workspace) or ~/.vallenemperor/agents/<name>.md (global):',
      '',
      '---',
      'name: code-reviewer',
      'description: Reviews diffs for edge cases and security before merging.',
      'tools: [read_file, search_files, patch]',
      '---',
      'You are a rigorous reviewer...'
    ].join('\n')
  }
  return agents.map(agent => {
    const tools = agent.tools.length ? ` · tools: ${agent.tools.join(', ')}` : ''
    return `${agent.name} (${agent.scope})${tools}\n  ${agent.description}`
  }).join('\n')
}

/** Instruction block injected into a subagent that runs a custom agent definition. */
export function buildAgentInstructions(agent: CustomAgent): string {
  return `You are the "${agent.name}" agent. ${agent.description}\n\n${agent.instructions}`.trim()
}
