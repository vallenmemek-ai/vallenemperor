// @file mention completion for the VallenCLI prompt.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '__pycache__', '.venv', 'target'])

// "fix @src/cli" -> { start: 4, partial: 'src/cli' }; null when the cursor word is not an @mention.
export function fileToken(line) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(String(line || ''))
  if (!match) return null
  return { start: match.index + match[0].length - match[1].length - 1, partial: match[1] }
}

export function suggestFiles(partial, cwd, limit = 60) {
  const value = String(partial || '').replace(/^~(?=\/|$)/, homedir())
  const dirPart = value.includes('/') ? value.slice(0, value.lastIndexOf('/') + 1) : ''
  const namePart = value.slice(dirPart.length).toLowerCase()
  let entries
  try { entries = readdirSync(resolve(cwd || process.cwd(), dirPart || '.'), { withFileTypes: true }) } catch { return [] }
  const showHidden = namePart.startsWith('.')
  return entries
    .filter(entry => (showHidden || !entry.name.startsWith('.')) && !SKIP.has(entry.name) && entry.name.toLowerCase().includes(namePart))
    .map(entry => ({ entry, dir: entry.isDirectory(), starts: entry.name.toLowerCase().startsWith(namePart) }))
    .sort((a, b) => Number(b.starts) - Number(a.starts) || Number(b.dir) - Number(a.dir) || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(({ entry, dir }) => ({
      name: `@${dirPart}${entry.name}${dir ? '/' : ''}`,
      args: '',
      desc: dir ? 'directory' : 'file',
      fileItem: true,
      cat: 'workspace',
      fillText: `@${dirPart}${entry.name}${dir ? '/' : ' '}`
    }))
}
