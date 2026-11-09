import test from 'node:test'
import assert from 'node:assert/strict'

import { McpWiring } from '../dist/agent/mcp_wiring.js'

function makeWiring(overrides = {}) {
  const statuses = []
  const wiring = new McpWiring({
    getServers: () => ({}),
    isShuttingDown: () => false,
    onStatus: servers => statuses.push(servers),
    ...overrides
  })
  return { wiring, statuses }
}

test('McpWiring starts with no manager and reports an empty status', () => {
  const { wiring, statuses } = makeWiring()
  assert.equal(wiring.manager, null)
  assert.deepEqual(wiring.toolNames, [])
  wiring.emit()
  assert.deepEqual(statuses, [[]])
})

test('McpWiring.register is a no-op without a manager', async () => {
  const { wiring } = makeWiring()
  await wiring.register()
  assert.deepEqual(wiring.toolNames, [])
})

test('McpWiring.reconnect returns false without a manager', async () => {
  const { wiring } = makeWiring()
  assert.equal(await wiring.reconnect('files'), false)
})

test('McpWiring.replace with an empty server set shuts down and clears state', async () => {
  const { wiring, statuses } = makeWiring()
  wiring.toolNames = ['mcp__files__read']
  await wiring.replace({})
  assert.equal(wiring.manager, null)
  assert.deepEqual(wiring.toolNames, [])
  assert.deepEqual(statuses.at(-1), [], 'status is re-emitted after shutdown')
})

test('McpWiring.start does nothing once the agent is shutting down', async () => {
  let imported = false
  const { wiring } = makeWiring({ isShuttingDown: () => true })
  await wiring.start()
  assert.equal(wiring.manager, null, 'no manager is created after shutdown was requested')
  assert.equal(imported, false)
})
