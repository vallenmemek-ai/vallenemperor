import test from 'node:test'
import assert from 'node:assert/strict'

import { createLocalCommandHandler } from '../src/cli-commands.mjs'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

test('/learn runs a turn with the skill-authoring prompt', async () => {
  const turns = []
  const printed = []
  const handler = createLocalCommandHandler({
    agent: { config: { providers: {}, terminal: { cwd: process.cwd() } }, getSessionId: () => 'learn-session', getContextStats: () => ({ turns: 1 }) },
    core,
    state: {},
    output: { isTTY: false, columns: 80, write: () => true },
    printResponse: text => printed.push(String(text)),
    readHiddenToken: async () => ({ value: '' }),
    settleApproval: () => {},
    enqueue: () => {},
    out: () => {},
    refreshStatus: () => {},
    healthCheck: async () => [],
    enterShell: async () => {},
    runTurn: async (message, display) => { turns.push({ message, display }) },
    displayLine: text => printed.push(String(text))
  })

  assert.equal(await handler('/learn docs/ROADMAP.md'), true)
  assert.equal(turns.length, 1)
  assert.match(turns[0].message, /author a skill/)
  assert.match(turns[0].message, /docs\/ROADMAP\.md/)
  assert.match(turns[0].message, /<= 60 characters/)
  assert.equal(turns[0].display, '/learn docs/ROADMAP.md')
})
