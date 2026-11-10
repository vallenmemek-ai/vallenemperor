import { resolve } from 'node:path'

/**
 * Per-path write lock.
 *
 * Tool calls inside one turn are already serialised, but two background subagents (or a subagent and
 * the parent) can write the same file concurrently. Without a lock the last writer wins silently and
 * the earlier diff is lost. This is a small in-process mutex keyed by the canonical path: writes to
 * the same path queue, writes to different paths run immediately.
 *
 * In-process only, by design: worktree isolation and the sandbox cover cross-process concerns.
 */

const chains = new Map<string, Promise<void>>()
const MAX_KEYS = 512

export function pathLockKey(path: string): string {
  return resolve(path)
}

/** Run `fn` after any in-flight work for the same path has finished. */
export function withPathLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const key = pathLockKey(path)
  const previous = chains.get(key) || Promise.resolve()

  const run = previous.then(
    () => fn(),
    () => fn()
  )

  const tail = run.then(() => undefined, () => undefined)
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })

  if (chains.size > MAX_KEYS) {
    const oldest = chains.keys().next().value
    if (oldest && oldest !== key) chains.delete(oldest)
  }
  return run
}

export function resetPathLocks(): void {
  chains.clear()
}

/** Test/diagnostic helper. */
export function pathLockCount(): number {
  return chains.size
}
