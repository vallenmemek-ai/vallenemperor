import test from 'node:test'
import assert from 'node:assert/strict'

import { truncateToolResult, estimateRequestTokens, assertToolCallPairs, normalizeToolCalls, pruneOldToolResults } from '../dist/agent/agent_tool_history.js'
import { stripTurnProgress, buildSummaryLines, compactHistory, SUMMARY_HEADER } from '../dist/agent/conversation_compaction.js'

test('truncateToolResult keeps short results untouched and cuts long ones', () => {
  assert.equal(truncateToolResult('short'), 'short')
  const long = 'x'.repeat(500)
  const cut = truncateToolResult(long, 100)
  assert.ok(cut.length < long.length)
  assert.match(cut, /truncat/i)
})

test('estimateRequestTokens grows with message content', () => {
  const small = estimateRequestTokens([{ role: 'user', content: 'hi' }], [])
  const big = estimateRequestTokens([{ role: 'user', content: 'x'.repeat(4000) }], [])
  assert.ok(big > small)
})

test('assertToolCallPairs throws when a tool call has no result', () => {
  assert.throws(() => assertToolCallPairs([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
  ]))
  assert.doesNotThrow(() => assertToolCallPairs([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
  ]))
})

test('normalizeToolCalls rewrites ids that collide with known ids and keeps every call', () => {
  const calls = [
    { id: 'known', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    { id: 'fresh', type: 'function', function: { name: 'read_file', arguments: '{}' } }
  ]
  const known = new Set(['known'])
  const result = normalizeToolCalls(calls, known)
  assert.equal(result.length, 2, 'no call is dropped')
  assert.notEqual(result[0].id, 'known', 'colliding id must be renamed')
  assert.equal(result[1].id, 'fresh', 'unseen id is kept as-is')
  assert.equal(new Set(result.map(c => c.id)).size, 2, 'ids stay unique')
})

test('pruneOldToolResults keeps the protected tail intact', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(2000) }))
  const pruned = pruneOldToolResults(messages, 24, 0)
  assert.equal(pruned.length, messages.length)
  assert.equal(pruned[29].content, messages[29].content, 'tail must stay verbatim')
})

test('stripTurnProgress removes the appended progress block', () => {
  const content = 'answer text\n\n[Progress so far in this task (older steps compacted)]\nmore'
  assert.equal(stripTurnProgress(content), 'answer text')
})

test('compactHistory folds old turns into a summary header', () => {
  const history = []
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'user', content: `question ${i}` })
    history.push({ role: 'assistant', content: `answer ${i}` })
  }
  const changed = compactHistory(history, 8, -1, true)
  assert.equal(changed, true)
  assert.ok(history.length < 80)
  const summary = history.find(m => typeof m.content === 'string' && m.content.includes(SUMMARY_HEADER))
  assert.ok(summary, 'a summary message must exist after compaction')
  assert.equal(history[0].content, 'question 0', 'the leading message is preserved')
})

test('buildSummaryLines lists user requests in order', () => {
  const lines = buildSummaryLines([
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second request' }
  ])
  const text = lines.join('\n')
  assert.match(text, /first request/)
  assert.match(text, /second request/)
})
