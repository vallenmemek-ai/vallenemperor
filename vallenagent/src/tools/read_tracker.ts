/**
 * Read tracker — conversation economy for `read_file`.
 *
 * Two failure modes this kills:
 * - **duplicate reads**: the same unchanged file re-read because the content was compacted away or
 *   the model forgot. The second read returns a stub naming the hash and how to get the body.
 * - **read loops**: the same path+range requested three times in a row. Any other tool call resets
 *   the streak, so legitimate read → edit → read flows are unaffected.
 *
 * State is per session, bounded, and in-process (no disk, no cross-session leakage).
 */

export interface ReadRecord {
  hash: string
  ranges: Array<[number, number]>
}

interface SessionState {
  lastKey: string
  consecutive: number
  reads: Map<string, ReadRecord>
}

const states = new Map<string, SessionState>()
const MAX_SESSIONS = 32
const MAX_FILES_PER_SESSION = 128
export const LOOP_THRESHOLD = 3

function stateFor(sessionId: string): SessionState {
  let state = states.get(sessionId)
  if (!state) {
    if (states.size >= MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest) states.delete(oldest)
    }
    state = { lastKey: '', consecutive: 0, reads: new Map() }
    states.set(sessionId, state)
  }
  return state
}

export type ReadVerdict = 'ok' | 'duplicate' | 'loop'

export interface NoteReadOptions {
  sessionId?: string
  path: string
  hash: string
  offset: number
  limit: number
  totalLines: number
}

/** Record a read and decide whether it is a repeat the caller should stub out. */
export function noteRead(options: NoteReadOptions): ReadVerdict {
  const sessionId = options.sessionId || 'default'
  const state = stateFor(sessionId)
  const key = `${options.path}#${options.offset}:${options.limit}`

  state.consecutive = state.lastKey === key ? state.consecutive + 1 : 1
  state.lastKey = key

  const start = Math.max(1, Number(options.offset) || 1)
  const end = Math.min(options.totalLines, start + Math.max(1, Number(options.limit) || 1) - 1)
  const record = state.reads.get(options.path)

  const alreadyCovered = Boolean(record && record.hash === options.hash
    && record.ranges.some(([rangeStart, rangeEnd]) => rangeStart <= start && rangeEnd >= end))

  if (state.consecutive >= LOOP_THRESHOLD) return 'loop'
  if (alreadyCovered) return 'duplicate'

  if (!record || record.hash !== options.hash) {
    state.reads.set(options.path, { hash: options.hash, ranges: [[start, end]] })
  } else {
    record.ranges.push([start, end])
    if (record.ranges.length > 64) record.ranges.splice(0, record.ranges.length - 64)
  }
  if (state.reads.size > MAX_FILES_PER_SESSION) {
    const oldest = state.reads.keys().next().value
    if (oldest) state.reads.delete(oldest)
  }
  return 'ok'
}

/** Any non-read tool call breaks a read streak. */
export function noteOtherTool(sessionId?: string): void {
  const state = states.get(sessionId || 'default')
  if (!state) return
  state.lastKey = ''
  state.consecutive = 0
}

export function resetReadTracker(sessionId?: string): void {
  if (sessionId) states.delete(sessionId)
  else states.clear()
}

/** Test/diagnostic helper. */
export function readTrackerSnapshot(sessionId?: string): { files: number; consecutive: number } {
  const state = states.get(sessionId || 'default')
  return { files: state?.reads.size || 0, consecutive: state?.consecutive || 0 }
}
