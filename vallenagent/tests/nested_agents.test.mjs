import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../dist/index.js')

function makeAgent(t, { isSubagent = false, depth, maxDepth } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vallen-nested-'))
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
  if (maxDepth) config.agent = { ...(config.agent || {}), max_subagent_depth: maxDepth }

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, isSubagent, depth, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())
  return agent
}

test('delegation depth defaults to 0 for the main agent and 1 for subagents', async t => {
  const main = makeAgent(t)
  assert.equal(main.depth, 0)
  assert.equal(main.maxDepth, 2)

  const child = makeAgent(t, { isSubagent: true })
  assert.equal(child.depth, 1)

  const capped = makeAgent(t, { isSubagent: true, depth: 3, maxDepth: 3 })
  assert.equal(capped.depth, 3)
  assert.equal(capped.maxDepth, 3)
})

test('the depth cap is enforced in the tool executor, not only in registration', async () => {
  const execute = (depth, maxDepth) => core.registry.execute(
    'delegate_task',
    { tasks: [{ goal: 'do something' }] },
    { isSubagent: true, agentDepth: depth, maxAgentDepth: maxDepth }
  )

  const refused = JSON.parse(await execute(2, 2))
  assert.match(refused.error, /Delegation depth limit reached \(2\/2\)/)

  // Below the cap the call is allowed to proceed (it then fails on the missing factory, not on depth).
  const allowed = JSON.parse(await execute(1, 2))
  assert.doesNotMatch(String(allowed.error || ''), /Delegation depth limit reached/)
})

test('max_subagent_depth is clamped to a sane range', async t => {
  const high = makeAgent(t, { maxDepth: 99 })
  assert.equal(high.maxDepth, 5)
  const low = makeAgent(t, { maxDepth: 0 })
  assert.equal(low.maxDepth, 2, '0 falls back to the default of 2')
})
