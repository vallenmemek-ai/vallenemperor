import test from 'node:test'
import assert from 'node:assert/strict'

const core = await import('../dist/index.js')

function ctx(config = {}) {
  return { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: process.cwd() }, ...config }, getSessionId: () => 'r32' } }
}

test('/agents runs reaches the dashboard, not the custom-agent list', async () => {
  core.subagentRegistry.clear()
  try {
    const empty = await core.handleCommand(ctx(), '/agents runs')
    assert.match(empty.response, /No subagent runs yet/)

    const run = core.subagentRegistry.create({ goal: 'port the parser', workspace: 'branch' })
    core.subagentRegistry.markRunning(run.id)
    core.subagentRegistry.update(run.id, 'read file', 'src/parser.ts')

    const view = await core.handleCommand(ctx(), '/agents runs')
    assert.match(view.response, /Agent dashboard · 1 active \/ 1 tracked/)
    assert.match(view.response, /port the parser/)
    assert.match(view.response, /last: src\/parser\.ts/)

    const alias = await core.handleCommand(ctx(), '/agents dashboard')
    assert.match(alias.response, /Agent dashboard/)
  } finally {
    core.subagentRegistry.clear()
  }
})