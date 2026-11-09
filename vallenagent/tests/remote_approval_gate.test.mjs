import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRemoteApprovalGate } from '../dist/gateway/approval_gate.js'

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'vallen-gate-'))
    const previous = process.env.VALLENEMPEROR_HOME
    process.env.VALLENEMPEROR_HOME = home
    try {
      await fn(home)
    } finally {
      if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
      else process.env.VALLENEMPEROR_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function fakeAgent(mcpServers = {}) {
  return { config: { mcpServers }, getSessionId: () => 'session-gate' }
}

function writeTelegramConfig(home, config) {
  const dir = join(home, 'gateway')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'telegram.json'), JSON.stringify(config))
}

test('safe tools run without asking the human', withHome(async () => {
  const prompts = []
  const gate = createRemoteApprovalGate({
    agent: fakeAgent(),
    ownerId: 1,
    approve: async summary => { prompts.push(summary); return true }
  })
  assert.equal(await gate({ name: 'read_file', args: { path: 'a.txt' } }), true)
  assert.deepEqual(prompts, [])
}))

test('a risky shell command asks once and is allowed when approved', withHome(async () => {
  const prompts = []
  const gate = createRemoteApprovalGate({
    agent: fakeAgent(),
    ownerId: 1,
    approve: async summary => { prompts.push(summary); return true }
  })
  assert.equal(await gate({ name: 'terminal', args: { command: 'rm -rf /tmp/probe' } }), true)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /rm -rf \/tmp\/probe/)
}))

test('a denied prompt denies the tool', withHome(async () => {
  const gate = createRemoteApprovalGate({ agent: fakeAgent(), ownerId: 1, approve: async () => false })
  assert.equal(await gate({ name: 'terminal', args: { command: 'rm -rf /tmp/probe' } }), false)
}))

test('a trusted MCP server needs no prompt', withHome(async () => {
  const prompts = []
  const gate = createRemoteApprovalGate({
    agent: fakeAgent({ fs: { trusted: true } }),
    ownerId: 1,
    approve: async summary => { prompts.push(summary); return true }
  })
  assert.equal(await gate({ name: 'mcp__fs__write', args: {} }), true)
  assert.deepEqual(prompts, [])
}))

test('requireAllowlist denies an owner who was removed from the allowlist', withHome(async home => {
  writeTelegramConfig(home, { allowlist: [], approval: 'dangerous' })
  const prompts = []
  const gate = createRemoteApprovalGate({
    agent: fakeAgent(),
    ownerId: 42,
    requireAllowlist: true,
    approve: async summary => { prompts.push(summary); return true }
  })
  assert.equal(await gate({ name: 'terminal', args: { command: 'ls' } }), false)
  assert.deepEqual(prompts, [], 'a non-allowlisted owner must be denied before prompting')
}))

test('the command preview is capped so a huge command cannot flood the chat', withHome(async () => {
  const prompts = []
  const gate = createRemoteApprovalGate({
    agent: fakeAgent(),
    ownerId: 1,
    commandPreview: 10,
    approve: async summary => { prompts.push(summary); return true }
  })
  await gate({ name: 'terminal', args: { command: 'x'.repeat(500) } })
  assert.equal(prompts[0].includes('x'.repeat(11)), false)
}))
