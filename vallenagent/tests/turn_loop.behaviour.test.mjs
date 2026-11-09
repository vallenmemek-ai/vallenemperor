import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Behaviour lock for the agent turn loop.
 *
 * These tests exist so the loop can be split into modules without silently changing
 * event order, tool execution or session accounting. They drive a real AIAgent with a
 * scripted provider — no network.
 */

const core = await import('../dist/index.js')

function makeAgent(t, { chatImpl, configPatch = {} } = {}) {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-loop-'))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })

  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'mock'
  config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }
  Object.assign(config, configPatch)

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  agent.provider.chat = chatImpl
  t.after(() => agent.shutdown())
  return agent
}

const textReply = content => async () => ({
  id: 'c',
  model: 'mock-model',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
})

test('a plain turn emits thinking then returns the model text and counts one turn', async t => {
  const agent = makeAgent(t, { chatImpl: textReply('done: nothing to do') })
  const events = []
  const result = await agent.runTurn({ message: 'say hi', surfaceId: 'test' }, { onEvent: e => events.push(e.type) })

  assert.equal(result.response, 'done: nothing to do')
  assert.equal(result.sessionId, agent.getSessionId())
  assert.deepEqual(events, ['thinking', 'telemetry'])
  assert.equal(agent.getContextStats().turns, 1)
  assert.equal(agent.getContextStats().messages, 3, 'system prompt + user + assistant')
})

test('a tool turn emits tool_start before tool_end and the tool really runs', async t => {
  const calls = []
  const chatImpl = async payload => {
    calls.push(payload)
    if (calls.length === 1) {
      return {
        id: 'c1',
        model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: 't1', content: 'step one', status: 'completed' }] }) } }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    }
    return {
      id: 'c2',
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'finished after tool' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    }
  }

  const agent = makeAgent(t, { chatImpl })
  const events = []
  const result = await agent.runTurn({ message: 'track a todo', surfaceId: 'test' }, { onEvent: e => events.push(e) })

  assert.equal(result.response, 'finished after tool')
  const types = events.map(e => e.type)
  assert.ok(types.includes('tool_start'), 'tool_start emitted')
  assert.ok(types.includes('tool_end'), 'tool_end emitted')
  assert.ok(types.indexOf('tool_start') < types.indexOf('tool_end'), 'start precedes end')

  const start = events.find(e => e.type === 'tool_start')
  const end = events.find(e => e.type === 'tool_end')
  assert.equal(start.tool.name, 'todo_list')
  assert.equal(start.tool.id, 'call_1')
  assert.equal(end.tool.name, 'todo_list')
  assert.equal(end.tool.id, 'call_1')

  assert.equal(calls.length, 2, 'loop made two provider calls: tool then answer')
  const toolResult = calls[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_1')
  assert.ok(toolResult, 'tool result is in the second request')
  assert.match(toolResult.content, /step one/, 'real tool output is fed back to the model')
  assert.equal(agent.getContextStats().turns, 1)
})

test('an open checklist blocks the final answer instead of reporting done', async t => {
  let call = 0
  const agent = makeAgent(t, {
    chatImpl: async () => {
      call++
      if (call === 1) {
        return {
          id: 'c1',
          model: 'mock-model',
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: 't1', content: 'unfinished work', status: 'pending' }] }) } }]
            }
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      }
      return {
        id: 'c2',
        model: 'mock-model',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'all done' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      }
    }
  })
  const result = await agent.runTurn({ message: 'do the work', surfaceId: 'test' }, {})
  assert.match(result.response, /all done/)
  assert.match(result.response, /Task incomplete; checklist still open/)
  assert.match(result.response, /unfinished work/)
})

test('the provider receives a stable system prompt first and the user message last', async t => {
  let seen
  const agent = makeAgent(t, { chatImpl: async payload => { seen = payload; return textReply('ok')() } })
  await agent.runTurn({ message: 'hello there', surfaceId: 'test' }, {})
  assert.equal(seen.messages[0].role, 'system')
  assert.match(seen.messages[0].content, /Vallen AI Agent/)
  assert.equal(seen.messages.at(-1).role, 'user')
  assert.match(seen.messages.at(-1).content, /hello there/)
})

test('a provider failure surfaces as an error event and a thrown error', async t => {
  const agent = makeAgent(t, { chatImpl: async () => { throw new Error('provider exploded') } })
  const events = []
  await assert.rejects(
    agent.runTurn({ message: 'boom', surfaceId: 'test' }, { onEvent: e => events.push(e) }),
    /provider exploded/
  )
  const errorEvent = events.find(e => e.type === 'error')
  assert.ok(errorEvent, 'error event emitted')
  assert.match(errorEvent.error, /provider exploded/)
})

test('a truncated turn does not fabricate a completion', async t => {
  const agent = makeAgent(t, {
    chatImpl: async () => ({
      id: 'c',
      model: 'mock-model',
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'half an ans' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
  })
  const result = await agent.runTurn({ message: 'long task', surfaceId: 'test' }, {})
  assert.match(result.response, /half an ans/)
  assert.match(result.response, /incomplete|truncat/i)
})

test('a request that cannot fit the context window fails loudly instead of truncating silently', async t => {
  const agent = makeAgent(t, {
    configPatch: { context_windows: { 'mock-model': 2_000 }, default_context_window: 2_000 },
    chatImpl: textReply('short answer')
  })
  for (let i = 0; i < 30; i++) {
    agent.conversationHistory.push({ role: 'user', content: `q${i} ` + 'x'.repeat(200) })
    agent.conversationHistory.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(200) })
  }
  await assert.rejects(
    agent.runTurn({ message: 'final question', surfaceId: 'test' }, {}),
    /exceeds configured context window/
  )
})

test('a successful turn clears the resume checkpoint so stale work is not offered again', async t => {
  const agent = makeAgent(t, { chatImpl: textReply('finished cleanly') })
  const { saveCheckpoint, buildCheckpoint, loadCheckpoint } = core
  // Simulate a checkpoint left behind by an earlier failed attempt.
  saveCheckpoint(agent.checkpointDir ?? join(process.env.VALLENEMPEROR_HOME, 'sessions'), buildCheckpoint({
    sessionId: agent.getSessionId(),
    iterations: 3,
    userRequest: 'older failed task',
    filesTouched: ['a.ts'],
    progress: 'half done'
  }))
  assert.ok(agent.resumePrompt(), 'stale checkpoint is visible before the turn')

  await agent.runTurn({ message: 'new work', surfaceId: 'test' }, {})

  assert.equal(loadCheckpoint(agent.checkpointDir ?? join(process.env.VALLENEMPEROR_HOME, 'sessions'), agent.getSessionId()), null)
  assert.equal(agent.resumePrompt(), null, 'no resume prompt after a completed turn')
})

test('a failed turn keeps a checkpoint so the work can be resumed', async t => {
  const agent = makeAgent(t, { chatImpl: async () => { throw new Error('provider exploded') } })
  await assert.rejects(agent.runTurn({ message: 'do hard work', surfaceId: 'test' }, {}), /provider exploded/)
  const prompt = agent.resumePrompt()
  assert.ok(prompt, 'failed turn must leave a resume prompt')
  assert.match(prompt, /do hard work/)
})

test('compaction keeps the newest turns when the window allows it', async t => {
  const agent = makeAgent(t, {
    configPatch: { context_windows: { 'mock-model': 60_000 }, default_context_window: 60_000 },
    chatImpl: textReply('short answer')
  })
  // 60 turns = 120 messages, above MAX_HISTORY_MESSAGES (80), so compaction must kick in.
  for (let i = 0; i < 60; i++) {
    agent.conversationHistory.push({ role: 'user', content: `q${i} ` + 'x'.repeat(200) })
    agent.conversationHistory.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(200) })
  }
  const before = agent.getContextStats().messages
  const result = await agent.runTurn({ message: 'final question', surfaceId: 'test' }, {})
  assert.equal(result.response, 'short answer')
  assert.ok(agent.getContextStats().messages < before, 'history shrank instead of growing without bound')
  const lastUser = agent.conversationHistory.filter(m => m.role === 'user').at(-1)
  assert.match(lastUser.content, /final question/, 'the active request survives compaction')
})

// ---------- auto-checklist must not invent unfinished work ----------

test('a question that merely mentions "update" completes without a phantom checklist', async t => {
  const agent = makeAgent(t, { chatImpl: textReply('Jujur: pertanyaannya wajar kok.') })
  const result = await agent.runTurn(
    { message: 'ini pertanyaan jujur kah bang, biar enak gw update', surfaceId: 'test' },
    {}
  )

  assert.equal(result.completionStatus, 'complete')
  assert.doesNotMatch(result.response, /Task incomplete/)
  const openAutoGoals = agent.todoStore.read().filter(todo => todo.id.startsWith('request-') && todo.status !== 'completed')
  assert.deepEqual(openAutoGoals, [], 'no auto checklist item may stay open')
})

test('a real execution request is still nudged before a tool-less answer is accepted', async t => {
  const thinkings = []
  let calls = 0
  const agent = makeAgent(t, {
    chatImpl: async () => {
      calls++
      return textReply('sudah beres bang')()
    }
  })
  const result = await agent.runTurn(
    { message: 'benerin bug login di app', surfaceId: 'test' },
    { onEvent: event => { if (event.type === 'thinking') thinkings.push(event.message) } }
  )

  assert.equal(calls, 2, 'the model must be asked to continue once, not accepted on the first answer')
  assert.ok(
    thinkings.some(message => /Checklist still has/.test(String(message))),
    `expected a continuation nudge, got ${JSON.stringify(thinkings)}`
  )
  assert.equal(result.completionStatus, 'complete')
  assert.doesNotMatch(result.response, /Task incomplete/)
})

test('Indonesian questions are not execution requests, imperative requests still are', async () => {
  const { isTaskExecutionRequest } = await import('../dist/agent/agent_task_intent.js')
  assert.equal(isTaskExecutionRequest('ini pertanyaan jujur kah bang, saran dong'), false)
  assert.equal(isTaskExecutionRequest('update config biar jalan'), true)
  assert.equal(isTaskExecutionRequest('benerin bug login'), true)
  assert.equal(isTaskExecutionRequest('gimana cara update config?'), false)
})

// ---------- verification must be atomic: proof before "done" ----------

const toolCallPayload = (name, args) => ({
  id: 'c1',
  model: 'mock-model',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    }
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
})

/** Replay a scripted provider: { tool } steps call a tool, { text } steps answer. */
function scripted(steps) {
  let index = 0
  return async () => {
    const step = steps[Math.min(index, steps.length - 1)]
    index++
    return step.tool ? toolCallPayload(step.tool.name, step.tool.args) : textReply(step.text)()
  }
}

function verifyAgent(t, steps) {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-verify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const agent = makeAgent(t, { chatImpl: scripted(steps), configPatch: { terminal: { cwd: dir } } })
  return { agent, dir }
}

const PASSING_TEST_FILE = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n"

test('a TypeScript edit without a typecheck still ends incomplete', async t => {
  const { agent } = verifyAgent(t, [
    { tool: { name: 'write_file', args: { path: 'src/thing.ts', content: 'export const a = 1\n' } } },
    { text: 'done, all good' },
    { text: 'done, all good' }
  ])
  const result = await agent.runTurn({ message: 'ubah nilai a', surfaceId: 'test' }, {})
  assert.equal(result.completionStatus, 'incomplete')
  assert.match(result.response, /typecheck/i)
})

test('a test-file edit without running the suite ends incomplete', async t => {
  const { agent } = verifyAgent(t, [
    { tool: { name: 'write_file', args: { path: 'tests/thing.test.mjs', content: PASSING_TEST_FILE } } },
    { text: 'tests written, done' },
    { text: 'tests written, done' }
  ])
  const result = await agent.runTurn({ message: 'tambah test untuk fitur baru', surfaceId: 'test' }, {})
  assert.equal(result.completionStatus, 'incomplete')
  assert.match(result.response, /test run/i)
})

test('an edit followed by the matching verification command completes', async t => {
  const { agent } = verifyAgent(t, [
    { tool: { name: 'write_file', args: { path: 'tests/thing.test.mjs', content: PASSING_TEST_FILE } } },
    { tool: { name: 'terminal', args: { command: 'node --test tests/thing.test.mjs' } } },
    { text: 'done: test suite ran green' }
  ])
  const result = await agent.runTurn({ message: 'tambah test untuk fitur baru', surfaceId: 'test' }, {})
  assert.equal(result.completionStatus, 'complete', result.response)
  assert.match(result.response, /test suite ran green/)
})

test('a read-only command is not accepted as verification', async t => {
  const { agent } = verifyAgent(t, [
    { tool: { name: 'write_file', args: { path: 'tests/thing.test.mjs', content: PASSING_TEST_FILE } } },
    { tool: { name: 'terminal', args: { command: 'ls tests' } } },
    { text: 'looked at the files, done' },
    { text: 'looked at the files, done' }
  ])
  const result = await agent.runTurn({ message: 'tambah test untuk fitur baru', surfaceId: 'test' }, {})
  assert.equal(result.completionStatus, 'incomplete')
  assert.match(result.response, /test run/i)
})

// ---------- auto-loaded skills must not stick after the topic changes ----------

function seedSkillCatalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-skillcat-'))
  const skillDir = join(dir, 'email', 'himalaya-mail')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: himalaya-mail\ndescription: Send and read email from the terminal\ntriggers:\n  - email\n---\n\n# himalaya-mail\n\nUse himalaya.\n',
    'utf8'
  )
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const skillBlocks = payload => payload.messages.filter(message => /\[Loaded skill:/.test(String(message.content || '')))

test('an auto-loaded skill is released once the topic changes', async t => {
  const skillsDir = seedSkillCatalog(t)
  const payloads = []
  const agent = makeAgent(t, {
    configPatch: { skills: { paths: [skillsDir], disabled: [], enabled: [] } },
    chatImpl: async payload => {
      payloads.push(payload)
      return textReply('ok')()
    }
  })

  agent.skillLoader.load()
  await agent.runTurn({ message: 'tolong baca email saya', surfaceId: 'test' }, {})
  await agent.runTurn({ message: 'apa kabar', surfaceId: 'test' }, {})

  assert.equal(skillBlocks(payloads[0]).length, 1, 'first turn preloads the matching skill')
  assert.match(String(skillBlocks(payloads[0])[0].content), /himalaya-mail/)
  assert.equal(skillBlocks(payloads[1]).length, 0, 'a non-matching next message must not inherit the old skill')
})

test('a skill loaded explicitly with skill_view stays active for later messages', async t => {
  const skillsDir = seedSkillCatalog(t)
  const payloads = []
  const agent = makeAgent(t, {
    configPatch: { skills: { paths: [skillsDir], disabled: [], enabled: [] } },
    chatImpl: async payload => {
      payloads.push(payload)
      if (payloads.length === 1) {
        return toolCallPayload('skill_view', { name: 'himalaya-mail' })
      }
      return textReply('ok')()
    }
  })

  agent.skillLoader.load()
  await agent.runTurn({ message: 'cek skill email', surfaceId: 'test' }, {})
  await agent.runTurn({ message: 'apa kabar', surfaceId: 'test' }, {})

  const last = payloads.at(-1)
  assert.equal(skillBlocks(last).length, 1, 'explicitly loaded skill is still preloaded')
  assert.match(String(skillBlocks(last)[0].content), /himalaya-mail/)
})
