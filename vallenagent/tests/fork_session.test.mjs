import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../dist/index.js')

function makeAgent(t) {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-fork-'))
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
  agent.provider.chat = async () => ({
    id: 'c', model: 'mock-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  })
  t.after(() => agent.shutdown())
  return { agent, home }
}

test('forkSession switches to a new id and keeps both sessions on disk', async t => {
  const { agent } = makeAgent(t)
  await agent.runTurn({ message: 'first message', surfaceId: 'test' }, {})
  const original = agent.getSessionId()

  const forked = agent.forkSession()
  assert.notEqual(forked, original)
  assert.equal(agent.getSessionId(), forked)
  assert.match(forked, /-fork$/)

  const ids = agent.sessionManager.listSessions().map(session => session.id || session.sessionId || session)
  assert.ok(ids.includes(original), 'the original session stays resumable')
  assert.ok(ids.includes(forked), 'the fork is persisted')

  // The fork keeps working, and resuming the original still works.
  await agent.runTurn({ message: 'second message in fork', surfaceId: 'test' }, {})
  assert.equal(agent.getSessionId(), forked)
  assert.equal(agent.resumeSession(original), true)
  assert.equal(agent.getSessionId(), original)
})

test('a subagent cannot fork a session', async t => {
  const { agent } = makeAgent(t)
  agent.isSubagent = true
  assert.throws(() => agent.forkSession(), /cannot be forked/)
})
