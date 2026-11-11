import { formatReasoningLine, formatThoughtLine } from './cli-ui.js'

/**
 * Reasoning block + `∴ Thought for Ns` footer (pure state machine).
 *
 * The block opens on the first reasoning delta, streams dim lines, and closes with a footer the moment
 * real content arrives or the turn ends. Providers that send no reasoning still get a footer when the
 * thinking phase took at least a second — never a fake "0s".
 *
 * Rendering is injected (`emit(line)`), so this is testable without a terminal.
 */

export const REASONING_PREVIEW_LINES = 10
/** Hermes uses a fixed 40-cell rule so it never re-wraps when the terminal is resized. */
export const SEPARATOR_WIDTH = 40
const FLUSH_AT = 80

export function createReasoningState({ enabled = true } = {}) {
  return { enabled, opened: false, startedAt: 0, buffer: '', text: '', last: '', turnHad: false, printed: false, lastPrinted: false }
}

export function resetReasoning(state) {
  state.opened = false
  state.startedAt = 0
  state.buffer = ''
  state.text = ''
  state.turnHad = false
  state.printed = false
  state.lastPrinted = false
  return state
}

export function appendReasoning(state, text, emit, now = Date.now()) {
  if (!state.enabled || !text) return state
  state.turnHad = true
  state.text += text
  if (!state.opened) {
    state.opened = true
    state.startedAt = now
    state.buffer = ''
    emit('')
  }
  state.buffer += text
  let newline = state.buffer.indexOf('\n')
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline)
    state.buffer = state.buffer.slice(newline + 1)
    if (line.trim()) emit(formatReasoningLine(line))
    newline = state.buffer.indexOf('\n')
  }
  if (state.buffer.length > FLUSH_AT) {
    emit(formatReasoningLine(state.buffer))
    state.buffer = ''
  }
  return state
}

export function closeReasoning(state, emit, now = Date.now(), fallbackStartedAt = 0) {
  // A provider that delivers reasoning in one burst closes the block in under a second; falling back to
  // the turn start keeps "Thought for 0s" from being printed when the model really did think for a while.
  if (state.printed) return state  // one footer per turn, whichever path closes the block
  const startedAt = state.startedAt && now - state.startedAt >= 1000 ? state.startedAt : (fallbackStartedAt || state.startedAt)
  let printed = false
  if (state.opened) {
    if (state.buffer.trim()) emit(formatReasoningLine(state.buffer))
    state.buffer = ''
    emit(formatThoughtLine((now - startedAt) / 1000))
    state.opened = false
    printed = true
  } else if (state.turnHad) {
    emit(formatThoughtLine((now - startedAt) / 1000))
    printed = true
  }
  if (state.text.trim()) state.last = state.text
  state.printed = printed
  state.lastPrinted = printed
  return state
}

/** No reasoning deltas at all: close the thinking phase with a footer only if it was not instant. */
export function closeThinkingPhase(state, elapsedMs, emit) {
  if (state.turnHad || state.opened) return closeReasoning(state, emit)
  if (!state.enabled) return state
  if (elapsedMs >= 1000) emit(formatThoughtLine(elapsedMs / 1000))
  return state
}

export function reasoningPreview(text, { full = false, limit = REASONING_PREVIEW_LINES } = {}) {
  const lines = String(text || '').trim().split('\n').filter(line => line.length > 0)
  if (!lines.length) return { lines: [], more: 0 }
  const shown = full ? lines : lines.slice(0, limit)
  return { lines: shown, more: lines.length - shown.length }
}

/**
 * End of turn: close a reasoning block if one opened, otherwise print the footer when the thinking
 * phase was slow. The REPL does not stream provider text, so `chunk` events never fire there — without
 * this, a provider that sends no reasoning would never show a `∴ Thought for Ns` line at all.
 */
export function finishTurn(state, elapsedMs, emit, now = Date.now(), turnStartedAt = 0) {
  if (state.turnHad || state.opened) return closeReasoning(state, emit, now, turnStartedAt)
  return closeThinkingPhase(state, elapsedMs, emit)
}
