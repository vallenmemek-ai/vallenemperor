import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../src/cli-commands.mjs'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

function harness(cwd = process.cwd()) {
  const printed = []
  const turns = []
  const handler = createLocalCommandHandler({
    agent: {
      config: { providers: {}, terminal: { cwd } },
      getSessionId: () => 'browser-session',
      getContextStats: () => ({ turns: 1 })
    },
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
  return { handler, printed, turns }
}

test('/browser without a task explains usage and leaves the gate locked', async () => {
  core.resetBrowserGate()
  const h = harness()
  assert.equal(await h.handler('/browser'), true)
  assert.match(h.printed.join('\n'), /Usage: \/browser <task>/)
  assert.equal(h.turns.length, 0)
  assert.equal(core.browserToolsUnlocked('browser-session'), false)
})

test('/browser <task> unlocks browser tools for the session and runs the task', async () => {
  core.resetBrowserGate()
  const h = harness()
  assert.equal(await h.handler('/browser open localhost:3000 and screenshot the header'), true)

  assert.equal(core.browserToolsUnlocked('browser-session'), true)
  assert.ok(core.browserUnlockRemaining('browser-session') > 0)
  assert.equal(h.turns.length, 1)
  assert.match(h.turns[0].message, /^\[browser task\] open localhost:3000/)
  assert.match(h.turns[0].message, /browser_screenshot/)

  // /browser off locks them again.
  h.printed.length = 0
  await h.handler('/browser off')
  assert.equal(core.browserToolsUnlocked('browser-session'), false)
  assert.match(h.printed.join('\n'), /Browser tools locked/)
  core.resetBrowserGate()
})

test('/agents available lists custom agents from the workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'vallen-agents-cmd-'))
  try {
    const empty = await core.handleCommand({ channel: 'terminal', agent: { config: { terminal: { cwd: workspace } } } }, '/agents available')
    assert.match(empty.response, /No custom agents found/)
    assert.match(empty.response, /\.agents\/agents\/<name>\.md/)

    mkdirSync(join(workspace, '.agents', 'agents'), { recursive: true })
    writeFileSync(join(workspace, '.agents', 'agents', 'reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews diffs for security.\ntools: [read_file]\n---\nReview.\n')

    const filled = await core.handleCommand({ channel: 'terminal', agent: { config: { terminal: { cwd: workspace } } } }, '/agents available')
    assert.match(filled.response, /code-reviewer \(workspace\)/)
    assert.match(filled.response, /tools: read_file/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
