import test from 'node:test'
import assert from 'node:assert/strict'

import { createLocalCommandHandler } from '../dist/cli-commands.js'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

const ctx = { channel: 'terminal', agent: { getSessionId: () => 'agents-session' } }

test('/agents explains the empty state', async () => {
  core.subagentRegistry.clear()
  const result = await core.handleCommand(ctx, '/agents')
  assert.equal(result.handled, true)
  assert.match(result.response, /No subagents yet/)
  assert.match(result.response, /background: true/)
})

test('/agents lists runs with status, workspace and goal, and /agents show gives detail', async () => {
  core.subagentRegistry.clear()
  const running = core.subagentRegistry.create({ goal: 'audit the CLI', workspace: 'inherit' })
  core.subagentRegistry.markRunning(running.id)
  const done = core.subagentRegistry.create({ goal: 'port the picker', workspace: 'branch' })
  core.subagentRegistry.setWorktree(done.id, { repo: '/tmp/repo', path: '/tmp/wt/sa-x', branch: 'vallen/subagent-sa-x' })
  core.subagentRegistry.complete(done.id, 'ported')

  const list = await core.handleCommand(ctx, '/agents')
  assert.match(list.response, /Subagents · 1 active · 2 total/)
  assert.match(list.response, new RegExp(running.id))
  assert.match(list.response, /audit the CLI/)
  assert.match(list.response, /branch:vallen\/subagent-sa-x/)
  assert.match(list.response, /\/agents show <id>/)

  const detail = await core.handleCommand(ctx, `/agents show ${done.id}`)
  assert.match(detail.response, /status   : completed/)
  assert.match(detail.response, /summary  : ported/)
  assert.match(detail.response, /workspace: branch/)

  const missing = await core.handleCommand(ctx, '/agents show nope')
  assert.match(missing.response, /No subagent nope/)
  core.subagentRegistry.clear()
})

test('/agents stop cancels a running subagent', async () => {
  core.subagentRegistry.clear()
  const run = core.subagentRegistry.create({ goal: 'long job' })
  core.subagentRegistry.markRunning(run.id)
  let interrupted = false
  core.subagentRegistry.get(run.id).cancel = () => { interrupted = true }

  const stopped = await core.handleCommand(ctx, `/agents stop ${run.id}`)
  assert.match(stopped.response, new RegExp(`Cancelled subagent ${run.id}`))
  assert.equal(interrupted, true)
  assert.equal(core.subagentRegistry.get(run.id).status, 'cancelled')

  const again = await core.handleCommand(ctx, `/agents stop ${run.id}`)
  assert.match(again.response, /No running subagent/)
  core.subagentRegistry.clear()
})

test('/agents clean only touches finished worktrees', async () => {
  core.subagentRegistry.clear()
  const active = core.subagentRegistry.create({ goal: 'still running', workspace: 'branch' })
  core.subagentRegistry.setWorktree(active.id, { repo: '/tmp/repo', path: '/tmp/wt/active', branch: 'vallen/subagent-active' })
  core.subagentRegistry.markRunning(active.id)

  const finished = core.subagentRegistry.create({ goal: 'finished', workspace: 'branch' })
  core.subagentRegistry.setWorktree(finished.id, { repo: '/tmp/repo', path: '/tmp/wt/finished', branch: 'vallen/subagent-finished' })
  core.subagentRegistry.complete(finished.id, 'ok')

  const cleaned = await core.handleCommand(ctx, '/agents clean')
  assert.match(cleaned.response, /Removed 1 finished worktree\(s\)/)
  core.subagentRegistry.clear()
})

test('the /agents command is advertised in help and suggestions', async () => {
  const { HELP } = await import('../dist/cli-ui.js')
  const { COMMANDS } = await import('../dist/cli-suggest.js')
  assert.ok(HELP.includes('/agents'), 'HELP must document /agents')
  assert.ok(COMMANDS.some(entry => entry.name === '/agents'), 'suggestions must include /agents')
})
