import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * User-defined slash commands — `.vallenemperor/commands/<name>.md` (workspace) or
 * `<home>/commands/<name>.md` (global).
 *
 * Frontmatter: `description: ...`. Body is the prompt; `$ARGUMENTS` is replaced with whatever the user
 * typed after the command. Workspace definitions win over global ones with the same name.
 */

export interface CustomCommand {
  name: string
  description: string
  body: string
  path: string
  scope: 'workspace' | 'global'
}

function parseFile(path: string, fallbackName: string, scope: 'workspace' | 'global'): CustomCommand | null {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return null }
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const frontmatter = match ? match[1] : ''
  const body = (match ? text.slice(match[0].length) : text).trim()
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || ''
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || fallbackName
  if (!body) return null
  return { name, description, body, path, scope }
}

function readDir(dir: string, scope: 'workspace' | 'global'): CustomCommand[] {
  if (!existsSync(dir)) return []
  const out: CustomCommand[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const parsed = parseFile(join(dir, entry.name), entry.name.replace(/\.md$/, ''), scope)
    if (parsed) out.push(parsed)
  }
  return out
}

export function discoverCustomCommands(options: { workspace: string; home: string }): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  for (const command of readDir(join(options.home, 'commands'), 'global')) byName.set(command.name.toLowerCase(), command)
  for (const command of readDir(join(options.workspace, '.vallenemperor', 'commands'), 'workspace')) byName.set(command.name.toLowerCase(), command)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function findCustomCommand(name: string, commands: CustomCommand[]): CustomCommand | undefined {
  const target = String(name || '').replace(/^\//, '').toLowerCase()
  return commands.find(command => command.name.toLowerCase() === target)
}

export function renderCustomCommand(command: CustomCommand, args: string): string {
  const value = String(args || '').trim()
  return command.body.includes('$ARGUMENTS')
    ? command.body.replaceAll('$ARGUMENTS', value)
    : (value ? `${command.body}\n\nArguments: ${value}` : command.body)
}

export function formatCustomCommandList(commands: CustomCommand[]): string {
  if (!commands.length) {
    return [
      'No custom commands found.',
      'Create one at .vallenemperor/commands/<name>.md (workspace) or ~/.vallenemperor/commands/<name>.md:',
      '',
      '---',
      'description: Review the staged diff for bugs',
      '---',
      'Review the current git diff. Focus on: $ARGUMENTS'
    ].join('\n')
  }
  return commands.map(command => `/${command.name}${command.description ? ` — ${command.description}` : ''} (${command.scope})`).join('\n')
}
