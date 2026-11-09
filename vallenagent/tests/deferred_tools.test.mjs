import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../dist/index.js')
const { registry } = await import('../dist/tools/tools.js')
const { registerBuiltinTools } = await import('../dist/tools/builtin_tools.js')
registerBuiltinTools()

function makeAgent(t, { chatImpl }) {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-deferred-'))
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

const textPayload = content => ({
  id: 'c2',
  model: 'mock-model',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
})

test('tool_search returns the full parameter schema so tool_describe is optional', async () => {
  const raw = await registry.execute('tool_search', { query: 'web search' }, {})
  const { results } = JSON.parse(raw)
  assert.ok(results.length > 0, `expected deferred tools, got ${raw}`)
  for (const result of results) {
    assert.ok(result.parameters && typeof result.parameters === 'object', `${result.name} must expose parameters`)
  }
})

test('tool_call runs a deferred tool without a preceding tool_describe', async t => {
  const original = registry.get('web_search')
  registry.register({
    name: 'web_search',
    toolset: 'web',
    schema: {
      name: 'web_search',
      description: 'stub search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    handler: async args => JSON.stringify({ stubbed: String(args.query) })
  })
  t.after(() => {
    if (original) registry.register(original)
  })

  let call = 0
  const agent = makeAgent(t, {
    chatImpl: async () => {
      call++
      if (call === 1) return toolCallPayload('tool_call', { name: 'web_search', arguments: { query: 'vallenemperor' } })
      return textPayload('search finished')
    }
  })

  const result = await agent.runTurn({ message: 'cari info vallenemperor', surfaceId: 'test' }, {})
  assert.equal(result.completionStatus, 'complete', result.response)
  const toolMessage = agent.conversationHistory.filter(message => message.role === 'tool').at(-1)
  assert.ok(toolMessage, 'the deferred tool really ran')
  assert.match(toolMessage.content, /"stubbed":"vallenemperor"/)
})
