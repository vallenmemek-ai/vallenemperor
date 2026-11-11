import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getVallenHome } from './config'
import { chmodSafe } from './platform'

/**
 * Theme names are defined with their colours in `vallencli/src/cli-theme.ts`.
 * Core only needs the names so the agent can switch one; a guard test asserts the
 * two lists stay identical.
 */
export const THEME_NAMES = ['vallen', 'midnight', 'sunset', 'matrix', 'nord', 'rose', 'paper', 'mono'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export function themeFilePath(home = getVallenHome()): string {
  return join(home, 'cli_theme')
}

export function readTheme(home = getVallenHome()): string | null {
  try {
    const value = readFileSync(themeFilePath(home), 'utf8').trim()
    return (THEME_NAMES as readonly string[]).includes(value) ? value : null
  } catch {
    return null
  }
}

export function writeTheme(name: string, home = getVallenHome()): { ok: boolean; error?: string } {
  const value = String(name || '').trim().toLowerCase()
  if (!(THEME_NAMES as readonly string[]).includes(value)) {
    return { ok: false, error: `Unknown theme "${name}". Choose one of: ${THEME_NAMES.join(', ')}` }
  }
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    chmodSafe(home, 0o700)
    const file = themeFilePath(home)
    writeFileSync(file, `${value}\n`, { mode: 0o600 })
    chmodSafe(file, 0o600)
    return { ok: true }
  } catch (error: any) {
    return { ok: false, error: `Could not save theme: ${error?.message || String(error)}` }
  }
}

/** True when a saved theme file exists, so the CLI can pick it up on next start. */
export function hasSavedTheme(home = getVallenHome()): boolean {
  return existsSync(themeFilePath(home))
}
