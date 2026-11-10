import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildContinuationPrompt, createGoal, formatGoal, judgeGoal } from '../dist/agent/goal.js'

const core = await import('../dist/index.js')

test('the goal judge returns done/continue and fails safe', async () => {
  const provider = (content) => ({ chat: async () => ({ choices: [{ message: { content } }] }) })
  assert.equal(await judgeGoal({ provider: provider('DONE'), model: 'm', goal: 'ship it', lastReply: 'shipped' }), 'done')
  assert.equal(await judgeGoal({ provider: provider('CONTINUE'), model: 'm', goal: 'ship it', lastReply: 'started' }), 'continue')
  assert.equal(await judgeGoal({ provider: { chat: async () => { throw new Error('boom') } }, model: 'm', goal: 'x', lastReply: 'y' }), 'done', 'a broken judge must not loop')

  const goal = createGoal('ship the release', 5)
  assert.equal(goal.status, 'active')
  assert.equal(goal.maxTurns, 5)
  assert.match(formatGoal(goal), /attempt 0\/5/)
  assert.match(buildContinuationPrompt(goal), /Attempt 1\/5/)
  assert.match(formatGoal(null), /No active goal/)
})

test('rewind cuts the conversation back to before a prompt and fork keeps both sessions', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-rewind-'))
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
  agent.provider.chat = async payload => ({
    id: 'c', model: 'mock-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  })

  await agent.runTurn({ message: 'first task', surfaceId: 'test' }, {})
  await agent.runTurn({ message: 'second task', surfaceId: 'test' }, {})

  const prompts = agent.listUserPrompts()
  assert.deepEqual(prompts.map(item => item.index), [1, 2])
  assert.equal(prompts[1].text, 'second task')

  const rewound = agent.rewindToPrompt(2)
  assert.equal(rewound, 'second task')
  assert.deepEqual(agent.listUserPrompts().map(item => item.text), ['first task'])

  const forked = agent.forkAtPrompt(1)
  assert.ok(forked.sessionId)
  assert.equal(forked.prompt, 'first task')
  assert.equal(agent.getSessionId(), forked.sessionId)
})

test('goal state can be paused, resumed and cleared', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-goal-'))
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
  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  const goal = agent.setGoal('ship the release', 3)
  assert.equal(goal.status, 'active')
  assert.equal(agent.getGoal().maxTurns, 3)
  agent.updateGoal({ status: 'paused' })
  assert.equal(agent.getGoal().status, 'paused')
  agent.updateGoal({ status: 'active', attempts: 2 })
  assert.equal(agent.getGoal().attempts, 2)
  agent.clearGoal()
  assert.equal(agent.getGoal(), null)
})
