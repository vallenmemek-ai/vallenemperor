/**
 * Browser on-demand gate.
 *
 * Antigravity hides its browser subagent from the normal tool list and only exposes it when the user
 * asks (`/browser`). The same rule applies here: browser tools refuse to run until the session is
 * explicitly unlocked, so the model cannot wander onto the web on its own initiative.
 */

const unlocks = new Map<string, number>()
const DEFAULT_TTL_MS = 30 * 60_000

function key(sessionId?: string): string {
  return String(sessionId || 'global')
}

export function unlockBrowserTools(sessionId?: string, ttlMs: number = DEFAULT_TTL_MS, now: number = Date.now()): void {
  unlocks.set(key(sessionId), now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS))
}

export function lockBrowserTools(sessionId?: string): void {
  unlocks.delete(key(sessionId))
}

export function browserToolsUnlocked(sessionId?: string, now: number = Date.now()): boolean {
  const until = unlocks.get(key(sessionId))
  if (!until) return false
  if (until <= now) {
    unlocks.delete(key(sessionId))
    return false
  }
  return true
}

/** Remaining unlock time in seconds (0 when locked). */
export function browserUnlockRemaining(sessionId?: string, now: number = Date.now()): number {
  const until = unlocks.get(key(sessionId))
  if (!until || until <= now) return 0
  return Math.round((until - now) / 1000)
}

export function resetBrowserGate(): void {
  unlocks.clear()
}

export const BROWSER_LOCKED_MESSAGE =
  'Browser tools are on demand and currently locked. The user must run /browser <task> to unlock them for this session. '
  + 'Use web_search / web_extract for read-only web research instead.'
