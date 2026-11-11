import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Profiles (`--profile`) — isolated home per project or client.
 *
 * A profile is just a different `VALLENEMPEROR_HOME`, so config, sessions, skills and approvals are
 * separate without touching the default install. The env var is read dynamically by `getVallenHome()`,
 * which is why this can be applied at startup before the core is imported.
 */

export function baseHome() {
  return process.env.VALLENEMPEROR_BASE_HOME || process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
}

export function profileHome(name) {
  return join(baseHome(), 'profiles', sanitize(name))
}

export function sanitize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.{2,}/g, '-')            // never allow traversal segments
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Extract `--profile <name>` / `--profile=<name>` from argv; returns the remaining args. */
export function extractProfile(argv) {
  const rest = []
  let profile = ''
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index])
    if (arg === '--profile') { profile = String(argv[index + 1] || ''); index++; continue }
    if (arg.startsWith('--profile=')) { profile = arg.slice('--profile='.length); continue }
    rest.push(arg)
  }
  return { profile: profile ? sanitize(profile) : '', argv: rest }
}

/** Apply the profile by pointing VALLENEMPEROR_HOME at it. Returns the profile name ('' when none). */
export function applyProfile(profile) {
  if (!profile) return ''
  // Remember the base once, so nested profileHome() calls never build paths inside a profile.
  if (!process.env.VALLENEMPEROR_BASE_HOME) process.env.VALLENEMPEROR_BASE_HOME = baseHome()
  const home = profileHome(profile)
  mkdirSync(home, { recursive: true })
  process.env.VALLENEMPEROR_HOME = home
  process.env.VALLENEMPEROR_PROFILE = profile
  return profile
}

export function listProfiles() {
  const dir = join(baseHome(), 'profiles')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter(name => existsSync(join(dir, name)))
  } catch { return [] }
}

export function runProfileCommand({ args = [], stdout = process.stdout } = {}) {
  const [action = 'list', name] = args
  if (action === 'list') {
    const profiles = listProfiles()
    stdout.write(profiles.length
      ? `Profiles (${profiles.length})\n${profiles.map(item => `  ${item}  ${profileHome(item)}`).join('\n')}\n`
      : 'No profiles yet. Create one with: vallenemperor profile create <name>\n')
    return 0
  }
  if (action === 'create') {
    if (!name) { stdout.write('Usage: vallenemperor profile create <name>\n'); return 2 }
    const home = profileHome(name)
    mkdirSync(home, { recursive: true })
    stdout.write(`Profile ready: ${sanitize(name)}\nHome: ${home}\nUse it with: vallenemperor --profile ${sanitize(name)}\n`)
    return 0
  }
  if (action === 'delete') {
    if (!name) { stdout.write('Usage: vallenemperor profile delete <name>\n'); return 2 }
    const home = profileHome(name)
    if (!existsSync(home)) { stdout.write(`No profile ${sanitize(name)}.\n`); return 1 }
    rmSync(home, { recursive: true, force: true })
    stdout.write(`Deleted profile ${sanitize(name)}.\n`)
    return 0
  }
  stdout.write('Usage: vallenemperor profile [list|create <name>|delete <name>]\n')
  return 2
}
