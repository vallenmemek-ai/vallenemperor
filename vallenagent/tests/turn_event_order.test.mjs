import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Event-order lock for one turn. `agent.ts` is being split per turn stage, so the
 * observable sequence per stage (thinking → tool_start → tool_end → chunk → telemetry)
 * must be pinned before the code moves.
 */

const core = await import('../dist/index.js')

function makeAgent(t, { chatImpl }) {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-events-'))
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

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  agent.provider.chat = chatImpl
  t.after(() => agent.shutdown())
  return agent
}

const textReply = (content, { stream = false } = {}) => async payload => {
  if (stream) payload?.onChunk?.(content.slice(0, 3))
  if (stream) payload?.onChunk?.(content.slice(3))
  return {
    id: 'c',
    model: 'mock-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }
}

const toolThenText = (toolName, args, text) => {
  let call = 0
  return async () => {
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
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    }
    return {
      id: 'c2',
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    }
  }
}

test('a plain turn emits thinking once, then telemetry once, in that order', async t => {
  const agent = makeAgent(t, { chatImpl: textReply('done') })
  const events = []
  await agent.runTurn({ message: 'say hi', surfaceId: 'order' }, { onEvent: event => events.push(event) })

  const types = events.map(event => event.type)
  assert.deepEqual(types, ['thinking', 'telemetry'])
  assert.ok(events[1].usage, 'telemetry carries usage')
})

// Telemetry is emitted once per provider response (the CLI status bar needs it mid-turn),
// so the contract is: per iteration, response → telemetry; each tool_start pairs with its
// tool_end; the turn closes with the final iteration's telemetry.

test('a tool turn keeps thinking → telemetry → tool_start → tool_end → telemetry order', async t => {
  const agent = makeAgent(t, { chatImpl: toolThenText('todo_list', { todos: [{ id: 't1', content: 'step', status: 'completed' }] }, 'finished') })
  const events = []
  await agent.runTurn({ message: 'track a todo', surfaceId: 'order' }, { onEvent: event => events.push(event) })

  const types = events.map(event => event.type)
  const index = type => types.indexOf(type)
  assert.ok(index('thinking') >= 0, 'thinking emitted')
  assert.ok(index('thinking') < index('tool_start'), 'thinking precedes tool_start')
  assert.ok(index('tool_start') < index('tool_end'), 'tool_start precedes tool_end')
  assert.ok(index('tool_end') < types.lastIndexOf('telemetry'), 'the final telemetry follows the last tool_end')
  assert.equal(types.filter(type => type === 'telemetry').length, 2, 'one telemetry per provider response (two calls here)')
  assert.equal(types.at(-1), 'telemetry', 'telemetry closes the turn')

  const start = events.find(event => event.type === 'tool_start')
  const end = events.find(event => event.type === 'tool_end')
  assert.equal(start.tool.id, end.tool.id, 'the same tool id is reported on start and end')
  assert.equal(start.tool.name, 'todo_list')
})

test('streamed chunks arrive after thinking and before telemetry', async t => {
  const agent = makeAgent(t, { chatImpl: textReply('streamed answer', { stream: true }) })
  const events = []
  const result = await agent.runTurn({ message: 'stream please', surfaceId: 'order' }, { stream: true, onEvent: event => events.push(event) })

  const types = events.map(event => event.type)
  const chunks = events.filter(event => event.type === 'chunk')
  assert.ok(chunks.length >= 1, 'chunks are emitted when the surface asks for a stream')
  assert.ok(types.indexOf('thinking') < types.indexOf('chunk'), 'thinking precedes chunks')
  assert.ok(types.lastIndexOf('chunk') < types.lastIndexOf('telemetry'), 'chunks precede the final telemetry')
  assert.equal(types.at(-1), 'telemetry')
  assert.equal(result.response, 'streamed answer')
})

test('a failing turn emits error last and no telemetry after it', async t => {
  const agent = makeAgent(t, { chatImpl: async () => { throw new Error('provider exploded') } })
  const events = []
  await assert.rejects(agent.runTurn({ message: 'boom', surfaceId: 'order' }, { onEvent: event => events.push(event) }), /provider exploded/)

  const types = events.map(event => event.type)
  assert.equal(types.at(-1), 'error', 'error closes a failed turn')
  assert.equal(types.filter(type => type === 'telemetry').length, 0, 'a failed turn reports no telemetry')
})
