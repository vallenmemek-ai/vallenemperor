import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Daily update check. One network call per day at most, silent on failure, never blocks startup.
 * The cache lives in `<home>/update-check.json`; `VALLENEMPEROR_NO_UPDATE_CHECK=1` disables it.
 */

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000

export function parseVersion(value) {
  return String(value || '').replace(/^v/, '').split('.').map(part => Number(part.replace(/[^0-9]/g, '')) || 0)
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] || 0
    const right = b[index] || 0
    if (left > right) return true
    if (left < right) return false
  }
  return false
}

export async function checkForUpdate({ current, home, fetcher, now = Date.now(), ttlMs = UPDATE_CHECK_TTL_MS }) {
  const cachePath = join(home, 'update-check.json')
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (cache && Number.isFinite(cache.checkedAt) && now - cache.checkedAt < ttlMs) {
      return { latest: cache.latest || null, checked: false, cached: true }
    }
  } catch { /* no cache yet */ }

  try {
    const latest = String(await fetcher() || '').trim()
    if (latest) {
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 })
        writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: now }), { mode: 0o600 })
      } catch { /* cache is best-effort */ }
    }
    return { latest: latest || null, checked: true, cached: false }
  } catch (error) {
    return { latest: null, checked: false, cached: false, error: String(error?.message || error) }
  }
}

export function formatUpdateNotice(current, latest) {
  if (!latest || !isNewer(latest, current)) return null
  return `update available: ${current} → ${latest} · run: npm i -g vallenemperor`
}

export function updateCheckDisabled(env = process.env) {
  return env.VALLENEMPEROR_NO_UPDATE_CHECK === '1' || env.CI === 'true'
}

export function currentVersion(root) {
  try { return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.0.0') } catch { return '0.0.0' }
}

/** npm registry lookup; bounded so a slow network never stalls startup. */
export function npmLatestVersion() {
  return execFileSync('npm', ['view', 'vallenemperor', 'version'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Fire-and-forget startup notice. Never throws, never blocks. */
export async function maybeNotifyUpdate({ home, current, fetcher = npmLatestVersion, print = () => {} }) {
  if (updateCheckDisabled()) return null
  try {
    const result = await checkForUpdate({ current, home, fetcher })
    const notice = formatUpdateNotice(current, result.latest)
    if (notice) print(notice)
    return notice
  } catch { return null }
}

export async function runUpdateCommand({ root, checkOnly = false, stdout = process.stdout, fetcher = npmLatestVersion, install = null }) {
  const current = currentVersion(root)
  let latest = null
  try { latest = fetcher() } catch (error) {
    stdout.write(`Could not reach npm (${String(error?.message || error).slice(0, 120)}).\n`)
    return 1
  }
  if (!latest) { stdout.write('Could not read the latest version from npm.\n'); return 1 }
  if (!isNewer(latest, current)) {
    stdout.write(`Already on the latest version (${current}).\n`)
    return 0
  }
  stdout.write(`Update available: ${current} → ${latest}\n`)
  if (checkOnly) return 0
  try {
    if (install) install(latest)
    else execFileSync('npm', ['install', '-g', `vallenemperor@${latest}`], { stdio: 'inherit' })
    stdout.write(`Updated to ${latest}. Restart the session to use it.\n`)
    return 0
  } catch (error) {
    stdout.write(`Update failed: ${String(error?.message || error).slice(0, 200)}\nRun manually: npm i -g vallenemperor@latest\n`)
    return 1
  }
}
