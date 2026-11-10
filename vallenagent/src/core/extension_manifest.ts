import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Skills live either as `<dir>/<name>.md` or as `<dir>/<category>/<name>/SKILL.md`; both layouts are
 * collected so the manifest matches what the loader actually sees.
 */
function listSkillEntries(dir: string): Array<{ name: string; path: string }> {
  const entries: Array<{ name: string; path: string }> = []
  for (const file of listMarkdown(dir)) entries.push({ name: file.replace(/\.(md|mdc)$/, ''), path: join(dir, file) })
  if (!existsSync(dir)) return entries
  let categories: string[] = []
  try { categories = readdirSync(dir) } catch { return entries }
  for (const category of categories) {
    const categoryDir = join(dir, category)
    try { if (!statSync(categoryDir).isDirectory()) continue } catch { continue }
    let skillDirs: string[] = []
    try { skillDirs = readdirSync(categoryDir) } catch { continue }
    for (const skillDirName of skillDirs) {
      const skillDir = join(categoryDir, skillDirName)
      const skillFile = join(skillDir, 'SKILL.md')
      if (existsSync(skillFile)) entries.push({ name: `${category}/${skillDirName}`, path: skillFile })
    }
  }
  return entries
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

export function buildExtensionManifest(inputs: { cwd: string; home: string; config?: any; extraSkillDirs?: string[] }): ExtensionManifest {
  const { cwd, home, config } = inputs
  const skills: ManifestEntry[] = []
  const agents: ManifestEntry[] = []
  const commands: ManifestEntry[] = []

  const skillDirs: Array<[string, string]> = [
    [join(cwd, 'skills'), 'workspace'],
    [join(home, 'skills'), 'global'],
    ...(inputs.extraSkillDirs || []).map((dir): [string, string] => [dir, 'bundled'])
  ]
  for (const [dir, source] of skillDirs) {
    for (const entry of listSkillEntries(dir)) skills.push({ ...entry, source })
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
