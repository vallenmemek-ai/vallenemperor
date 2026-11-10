import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Extension manifest — one honest list of everything that extends this install.
 *
 * Skills, custom agents, custom commands, hooks and MCP servers are discovered from several
 * directories; `/extensions` (and `vallenemperor extensions`) shows what was actually found,
 * where it came from, and what is broken, so "why is my skill not loading?" has an answer.
 */

export interface ManifestEntry { name: string; path: string; source: string; detail?: string }
export interface ExtensionManifest {
  skills: ManifestEntry[]
  agents: ManifestEntry[]
  commands: ManifestEntry[]
  hooks: ManifestEntry[]
  mcp: string[]
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  try { return readdirSync(dir).filter(name => name.endsWith('.md') || name.endsWith('.mdc')) } catch { return [] }
}

function frontmatterName(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    const match = text.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!match) return null
    const name = match[1].match(/^name:\s*(.+)$/m)
    return name ? name[1].trim().replace(/^["']|["']$/g, '') : null
  } catch { return null }
}

export function buildExtensionManifest(inputs: { cwd: string; home: string; config?: any }): ExtensionManifest {
  const { cwd, home, config } = inputs
  const skills: ManifestEntry[] = []
  const agents: ManifestEntry[] = []
  const commands: ManifestEntry[] = []

  for (const [dir, source] of [[join(cwd, 'skills'), 'workspace'], [join(home, 'skills'), 'global']] as const) {
    for (const file of listMarkdown(dir)) {
      skills.push({ name: file.replace(/\.(md|mdc)$/, ''), path: join(dir, file), source })
    }
  }
  for (const [dir, source] of [[join(cwd, '.agents', 'agents'), 'workspace'], [join(home, 'agents'), 'global']] as const) {
    for (const file of listMarkdown(dir)) {
      const path = join(dir, file)
      agents.push({ name: frontmatterName(path) || file.replace(/\.md$/, ''), path, source })
    }
  }
  for (const [dir, source] of [[join(cwd, '.vallenemperor', 'commands'), 'workspace'], [join(home, 'commands'), 'global']] as const) {
    for (const file of listMarkdown(dir)) {
      commands.push({ name: file.replace(/\.md$/, ''), path: join(dir, file), source })
    }
  }

  const hooks: ManifestEntry[] = []
  for (const [event, handlers] of Object.entries(config?.hooks || {})) {
    const list = Array.isArray(handlers) ? handlers : [handlers]
    list.forEach((handler: any, index: number) => {
      if (!handler) return
      hooks.push({ name: `${event}[${index}]`, path: String(handler.command || handler.script || ''), source: 'config', detail: event })
    })
  }

  return { skills, agents, commands, hooks, mcp: Object.keys(config?.mcpServers || {}) }
}

export function formatManifest(manifest: ExtensionManifest): string {
  const section = (label: string, entries: ManifestEntry[]) => {
    const lines = [`${label} (${entries.length})`]
    if (!entries.length) lines.push('  (none)')
    for (const entry of entries) lines.push(`  ${entry.name.padEnd(24)} ${entry.source.padEnd(9)} ${entry.path}`)
    return lines
  }
  return [
    ...section('Skills', manifest.skills),
    ...section('Custom agents', manifest.agents),
    ...section('Custom commands', manifest.commands),
    ...section('Hooks', manifest.hooks),
    `MCP servers (${manifest.mcp.length})`,
    ...(manifest.mcp.length ? manifest.mcp.map(name => `  ${name}`) : ['  (none)'])
  ].join('\n')
}
