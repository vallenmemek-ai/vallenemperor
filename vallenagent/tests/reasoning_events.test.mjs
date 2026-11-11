import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../dist/index.js')

test('reasoning deltas are forwarded to the surface as reasoning events', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-reason-'))
  const oldHome = process.env.VALLENEMPEROR_HOME
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
  t.after(() => agent.shutdown())

  agent.provider.chat = async payload => {
    payload.onReasoning?.('thinking about it\n')
    payload.onReasoning?.('second thought')
    payload.onChunk?.('answer ')
    payload.onChunk?.('here')
    return {
      id: 'c1', model: 'mock-model',
      reasoning: 'thinking about it\nsecond thought',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer here' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }
  }

  const events = []
  const result = await agent.runTurn(
    { message: 'hi', surfaceId: 'test' },
    { stream: true, onEvent: event => events.push(event) }
  )

  const reasoning = events.filter(event => event.type === 'reasoning').map(event => event.text)
  assert.deepEqual(reasoning, ['thinking about it\n', 'second thought'])
  const chunks = events.filter(event => event.type === 'chunk').map(event => event.chunk)
  assert.deepEqual(chunks, ['answer ', 'here'], 'content chunks still arrive separately')
  assert.equal(result.response, 'answer here')
})
