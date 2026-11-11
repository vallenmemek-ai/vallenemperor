import test from 'node:test'
import assert from 'node:assert/strict'

import { appendReasoning, closeReasoning, closeThinkingPhase, createReasoningState, reasoningPreview, resetReasoning } from '../src/cli-reasoning.mjs'
import { formatReasoningLine, formatThoughtLine } from '../src/cli-ui.mjs'

function collector() {
  const lines = []
  return { lines, emit: line => lines.push(line) }
}

test('the thought footer is dim+italic and rounds to whole seconds', () => {
  const line = formatThoughtLine(1.4)
  assert.match(line, /^\x1b\[2;3m∴ Thought for 1s\x1b\[0m$/)
  assert.match(formatThoughtLine(0), /Thought for 0s/)
  assert.match(formatThoughtLine(-3), /Thought for 0s/, 'negative durations never print')
  assert.match(formatThoughtLine(59.6), /Thought for 60s/)
  assert.match(formatReasoningLine('step one'), /step one/)
})

test('reasoning deltas open a block, stream complete lines and flush long partials', () => {
  const state = createReasoningState()
  const out = collector()
  appendReasoning(state, 'first line\nsecond', out.emit, 1000)
  assert.equal(state.opened, true)
  assert.equal(state.startedAt, 1000)
  assert.equal(out.lines[0], '', 'the block opens with a blank spacer line')
  assert.match(out.lines[1], /first line/)
  assert.equal(state.buffer, 'second', 'an incomplete line stays buffered')

  appendReasoning(state, ' line\n', out.emit, 1100)
  assert.match(out.lines[2], /second line/)
  assert.equal(state.buffer, '')

  appendReasoning(state, 'x'.repeat(120), out.emit, 1200)
  assert.match(out.lines[3], /x{120}/, 'a long partial line is flushed so it stays realtime')
  assert.equal(state.buffer, '')
})

test('closing the block prints the footer and remembers the text', () => {
  const state = createReasoningState()
  const out = collector()
  appendReasoning(state, 'thinking...\n', out.emit, 1000)
  closeReasoning(state, out.emit, 3500)
  assert.match(out.lines[out.lines.length - 1], /Thought for 3s/)
  assert.equal(state.opened, false)
  assert.equal(state.last, 'thinking...\n')
})

test('without reasoning deltas a footer appears only after a slow thinking phase', () => {
  const fast = createReasoningState()
  const fastOut = collector()
  closeThinkingPhase(fast, 400, fastOut.emit)
  assert.deepEqual(fastOut.lines, [], 'an instant turn prints nothing')

  const slow = createReasoningState()
  const slowOut = collector()
  closeThinkingPhase(slow, 2400, slowOut.emit)
  assert.equal(slowOut.lines.length, 1)
  assert.match(slowOut.lines[0], /Thought for 2s/)

  const disabled = createReasoningState({ enabled: false })
  const disabledOut = collector()
  closeThinkingPhase(disabled, 5000, disabledOut.emit)
  assert.deepEqual(disabledOut.lines, [], '/reasoning off suppresses everything')
})

test('resetReasoning clears a block between turns but keeps the last text for /reasoning', () => {
  const state = createReasoningState()
  const out = collector()
  appendReasoning(state, 'turn one\n', out.emit, 1000)
  closeReasoning(state, out.emit, 2000)
  assert.equal(state.last, 'turn one\n')
  resetReasoning(state)
  assert.equal(state.opened, false)
  assert.equal(state.text, '')
  assert.equal(state.last, 'turn one\n', 'the replay buffer survives the reset')
})

test('the /reasoning preview shows ten lines unless full is requested', () => {
  const text = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n')
  const short = reasoningPreview(text)
  assert.equal(short.lines.length, 10)
  assert.equal(short.more, 4)
  const full = reasoningPreview(text, { full: true })
  assert.equal(full.lines.length, 14)
  assert.equal(full.more, 0)
  assert.deepEqual(reasoningPreview(''), { lines: [], more: 0 })
})
