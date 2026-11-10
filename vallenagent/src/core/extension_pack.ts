import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Extension packs — one directory that carries skills, custom commands and custom agents.
 *
 * This is the installable half of R34. A pack is either declared by `extension.json`
 * (`{ "name": "...", "version": "...", "skills": ["a.md"], ... }`) or discovered from the conventional
 * layout (`skills/`, `commands/`, `agents/`). Installing copies files into the user's home so they load
 * on the next start; nothing is executed, so a pack cannot run code at install time.
 */

export interface ExtensionPack {
  name: string
  version: string
  dir: string
  skills: string[]
  commands: string[]
  agents: string[]
}

export interface ExtensionInstallResult {
  pack: ExtensionPack
  installed: string[]
  skipped: string[]
}

function filesIn(dir: string, extensions = ['.md', '.mdc']): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(name => extensions.some(extension => name.endsWith(extension)))
      .map(name => join(dir, name))
  } catch { return [] }
}

export function readExtensionPack(dir: string): ExtensionPack {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`)
  const manifestPath = join(dir, 'extension.json')
  if (existsSync(manifestPath)) {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return {
      name: String(raw.name || basename(dir)),
      version: String(raw.version || '0.0.0'),
      dir,
      skills: (raw.skills || []).map((file: string) => join(dir, file)),
      commands: (raw.commands || []).map((file: string) => join(dir, file)),
      agents: (raw.agents || []).map((file: string) => join(dir, file))
    }
  }
  return {
    name: basename(dir),
    version: '0.0.0',
    dir,
    skills: filesIn(join(dir, 'skills')),
    commands: filesIn(join(dir, 'commands')),
    agents: filesIn(join(dir, 'agents'))
  }
}

export function installExtensionPack(pack: ExtensionPack, home: string): ExtensionInstallResult {
  const installed: string[] = []
  const skipped: string[] = []
  const targets: Array<[string[], string]> = [
    [pack.skills, join(home, 'skills')],
    [pack.commands, join(home, 'commands')],
    [pack.agents, join(home, 'agents')]
  ]
  for (const [files, targetDir] of targets) {
    for (const file of files) {
      if (!existsSync(file)) { skipped.push(`${file} (missing)`); continue }
      try {
        mkdirSync(targetDir, { recursive: true })
        const target = join(targetDir, basename(file))
        copyFileSync(file, target)
        installed.push(target)
      } catch (error: any) {
        skipped.push(`${file} (${error?.message || 'copy failed'})`)
      }
    }
  }
  return { pack, installed, skipped }
}

export function formatInstallResult(result: ExtensionInstallResult): string {
  const lines = [`Extension pack: ${result.pack.name}@${result.pack.version}`, `Installed ${result.installed.length} file(s)`]
  for (const path of result.installed) lines.push(`  ${path}`)
  if (result.skipped.length) {
    lines.push(`Skipped ${result.skipped.length}:`)
    for (const item of result.skipped) lines.push(`  ${item}`)
  }
  return lines.join('\n')
}
