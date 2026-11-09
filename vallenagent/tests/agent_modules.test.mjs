import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveContextWindow, computeContextStats, DEFAULT_CONTEXT_WINDOW } from '../dist/agent/context_window.js'
import { prepareRequestMessages, shrinkOversizedMessages } from '../dist/agent/request_messages.js'
import { classifyToolResult } from '../dist/agent/tool_evidence.js'

// ---------- context window ----------

test('resolveContextWindow prefers the per-model override', () => {
  assert.equal(resolveContextWindow({ context_windows: { 'big-model': 1_000_000 } }, 'big-model'), 1_000_000)
})

test('resolveContextWindow falls back to the configured default then 128k', () => {
  assert.equal(resolveContextWindow({ default_context_window: 32_000 }, 'unknown'), 32_000)
  assert.equal(resolveContextWindow({}, 'unknown'), DEFAULT_CONTEXT_WINDOW)
})

test('resolveContextWindow ignores non-positive and non-finite values', () => {
  assert.equal(resolveContextWindow({ context_windows: { m: 0 } }, 'm'), DEFAULT_CONTEXT_WINDOW)
  assert.equal(resolveContextWindow({ context_windows: { m: -5 } }, 'm'), DEFAULT_CONTEXT_WINDOW)
  assert.equal(resolveContextWindow({ context_windows: { m: Number.NaN } }, 'm'), DEFAULT_CONTEXT_WINDOW)
  assert.equal(resolveContextWindow({ default_context_window: Number.POSITIVE_INFINITY }, 'm'), DEFAULT_CONTEXT_WINDOW)
})

test('computeContextStats reports percent, message counts and the largest tool output', () => {
  const stats = computeContextStats({
    history: [
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'hi' },
      { role: 'tool', name: 'read_file', content: 'y'.repeat(800) },
      { role: 'tool', name: 'terminal', content: 'z'.repeat(80) }
    ],
    contextWindow: 1000,
    lastPromptTokens: 500,
    lastContextEstimated: false,
    sessionPromptTotal: 1200,
    sessionCompletionTotal: 300,
    turns: 2
  })
  assert.equal(stats.percent, 50)
  assert.equal(stats.messages, 4)
  assert.equal(stats.systemPromptTokens, 100)
  assert.equal(stats.largestToolName, 'read_file')
  assert.equal(stats.largestToolTokens, 200)
  assert.equal(stats.turns, 2)
})

test('computeContextStats clamps percent at 100 and tolerates an empty history', () => {
  const stats = computeContextStats({
    history: [],
    cachedSystemPrompt: 'cached',
    contextWindow: 1000,
    lastPromptTokens: 5000,
    lastContextEstimated: true,
    sessionPromptTotal: 0,
    sessionCompletionTotal: 0,
    turns: 0
  })
  assert.equal(stats.percent, 100)
  assert.equal(stats.messages, 0)
  assert.equal(stats.largestToolName, '')
  assert.equal(stats.systemPromptTokens, Math.ceil('cached'.length / 4))
})

// ---------- request message preparation ----------

const toolMessage = (id, chars) => ({ role: 'tool', tool_call_id: id, name: 'read_file', content: 'y'.repeat(chars) })

test('prepareRequestMessages keeps history untouched without context pressure', () => {
  const history = [{ role: 'user', content: 'do work' }, toolMessage('a', 1000)]
  const current = history[0]
  const out = prepareRequestMessages({ history, currentUserMessage: current, tools: [], contextWindow: 1_000_000 })
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[1].content, history[1].content, 'no pruning when there is room')
})

test('prepareRequestMessages prunes old tool output under pressure but keeps the active turn', () => {
  const history = [toolMessage('old', 200_000), { role: 'user', content: 'active' }, toolMessage('new', 1000)]
  const current = history[1]
  const out = prepareRequestMessages({ history, currentUserMessage: current, tools: [], contextWindow: 50_000 })
  assert.match(out.messages[0].content, /pruned to save context/, 'old output is pruned')
  assert.equal(out.messages[2].content, history[2].content, 'tail stays verbatim when pruning is enough')
})

test('prepareRequestMessages still shrinks the tail when pruning alone cannot fit the window', () => {
  const history = [toolMessage('old', 200_000), { role: 'user', content: 'active' }, toolMessage('new', 200_000)]
  const current = history[1]
  const out = prepareRequestMessages({ history, currentUserMessage: current, tools: [], contextWindow: 50_000 })
  assert.match(out.messages[0].content, /pruned to save context/)
  assert.match(out.messages[2].content, /pruned to save context/, 'overflow shrink pass is the last resort')
  assert.ok(out.estimatedTokens <= 50_000 || out.estimatedTokens < 60_000)
})

test('prepareRequestMessages injects preloaded skill and memory text into the active message', () => {
  const history = [{ role: 'user', content: 'task' }]
  const out = prepareRequestMessages({
    history,
    currentUserMessage: history[0],
    tools: [],
    contextWindow: 1_000_000,
    preloadedSkillText: '\n\n[Loaded skill: x]',
    preloadedDeepMemoryText: '\n\n[deep]'
  })
  assert.equal(out.messages[0].content, 'task\n\n[Loaded skill: x]\n\n[deep]')
  assert.equal(history[0].content, 'task', 'caller history is not mutated')
})

test('prepareRequestMessages appends the task tracker with the right directive', () => {
  const history = [{ role: 'user', content: 'task' }]
  const open = prepareRequestMessages({
    history, currentUserMessage: history[0], tools: [], contextWindow: 1_000_000,
    taskSnapshot: '- [ ] a', requestHasOpenTasks: true, prematureFinalAttempts: 1
  })
  const tracker = open.messages.at(-1).content
  assert.match(tracker, /Current task tracker/)
  assert.match(tracker, /Continue working until these tasks are completed/)
  assert.match(tracker, /attempted to finish early/)

  const done = prepareRequestMessages({
    history, currentUserMessage: history[0], tools: [], contextWindow: 1_000_000,
    taskSnapshot: '- [x] a', requestHasOpenTasks: false
  })
  assert.match(done.messages.at(-1).content, /These tasks are complete/)
  assert.doesNotMatch(done.messages.at(-1).content, /attempted to finish early/)
})

test('prepareRequestMessages omits the tracker when there is no snapshot', () => {
  const history = [{ role: 'user', content: 'task' }]
  const out = prepareRequestMessages({ history, currentUserMessage: history[0], tools: [], contextWindow: 1_000_000, taskSnapshot: '' })
  assert.equal(out.messages.length, 1)
})

test('prepareRequestMessages appends the verification block and marks it as state data', () => {
  const history = [{ role: 'user', content: 'task' }]
  const out = prepareRequestMessages({
    history, currentUserMessage: history[0], tools: [], contextWindow: 1_000_000,
    verificationBlock: '[Verification]\n- npm test exit 0'
  })
  const last = out.messages.at(-1).content
  assert.match(last, /npm test exit 0/)
  assert.match(last, /state data recorded from real command runs/)
})

test('shrinkOversizedMessages trims long tool output and oversized skill bodies', () => {
  const messages = [
    toolMessage('t', 5000),
    { role: 'user', content: 'q\n\n[Loaded skill: big]\n' + 'z'.repeat(5000) }
  ]
  const shrunk = shrinkOversizedMessages(messages)
  assert.match(shrunk[0].content, /pruned to save context/)
  assert.match(shrunk[1].content, /Skill body shortened to fit context window/)
  assert.ok(shrunk[1].content.length < messages[1].content.length)
})

test('shrinkOversizedMessages leaves short messages and other roles alone', () => {
  const messages = [{ role: 'assistant', content: 'a'.repeat(5000) }, toolMessage('t', 100)]
  assert.deepEqual(shrinkOversizedMessages(messages), messages)
})

// ---------- tool evidence classification ----------

test('classifyToolResult treats a successful write_file as an edit', () => {
  const evidence = classifyToolResult('write_file', { path: 'a.txt' }, JSON.stringify({ path: 'a.txt' }))
  assert.equal(evidence.edited, true)
  assert.equal(evidence.typescriptEdited, false)
})

test('classifyToolResult flags TypeScript edits so a typecheck is expected', () => {
  assert.equal(classifyToolResult('patch', { path: 'src/a.ts' }, JSON.stringify({ path: 'src/a.ts' })).typescriptEdited, true)
  assert.equal(classifyToolResult('patch', { path: 'src/a.tsx' }, JSON.stringify({ path: 'src/a.tsx' })).typescriptEdited, true)
  assert.equal(classifyToolResult('patch', { path: 'src/a.py' }, JSON.stringify({ path: 'src/a.py' })).typescriptEdited, false)
})

test('classifyToolResult ignores failed or unparseable edits', () => {
  assert.equal(classifyToolResult('write_file', { path: 'a.ts' }, JSON.stringify({ error: 'denied' })).edited, false)
  assert.equal(classifyToolResult('write_file', { path: 'a.ts' }, 'not json').edited, false)
})

test('classifyToolResult reads patch_batch file lists', () => {
  const ok = classifyToolResult('patch_batch', {}, JSON.stringify({ success: true, files: [{ path: 'x.ts' }] }))
  assert.equal(ok.edited, true)
  assert.equal(ok.typescriptEdited, true)
  assert.equal(classifyToolResult('patch_batch', {}, JSON.stringify({ success: false, files: [{ path: 'x.ts' }] })).edited, false)
  assert.equal(classifyToolResult('apply_patch', {}, JSON.stringify({ success: true, files: [] })).edited, true)
})

test('classifyToolResult records terminal runs as verification evidence with the real exit code', () => {
  const evidence = classifyToolResult('terminal', { command: 'npm test' }, JSON.stringify({ exit_code: 0, output: 'ok', stderr: '' }))
  assert.equal(evidence.verification.exitCode, 0)
  assert.equal(evidence.verification.command, 'npm test')
  assert.equal(evidence.verification.typecheckPassed, false)

  const typecheck = classifyToolResult('terminal', { command: 'npx tsc --noEmit' }, JSON.stringify({ exit_code: 0, output: '' }))
  assert.equal(typecheck.verification.typecheckPassed, true)

  const failed = classifyToolResult('terminal', { command: 'npx tsc --noEmit' }, JSON.stringify({ exit_code: 2, output: 'err' }))
  assert.equal(failed.verification.typecheckPassed, false, 'a failed typecheck is not proof')
})

test('classifyToolResult ignores subagent terminal runs and non-JSON output', () => {
  assert.equal(classifyToolResult('terminal', { command: 'npm test' }, JSON.stringify({ exit_code: 0 }), { isSubagent: true }).verification, undefined)
  assert.equal(classifyToolResult('terminal', { command: 'npm test' }, 'plain text').verification, undefined)
})

test('classifyToolResult returns no evidence for unrelated tools', () => {
  const evidence = classifyToolResult('read_file', { path: 'a.ts' }, JSON.stringify({ content: 'x' }))
  assert.deepEqual(evidence, { edited: false, typescriptEdited: false })
})
