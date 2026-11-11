import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../dist/cli-commands.js'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

function harness({ home, cwd = process.cwd(), sideAgent } = {}) {
  const printed = []
  const turns = []
  const agent = {
    config: { providers: {}, terminal: { cwd } },
    getSessionId: () => 'panel-session',
    getContextStats: () => ({ turns: 1 }),
    forkSession: () => 'session-123-fork'
  }
  const handler = createLocalCommandHandler({
    agent,
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
    displayLine: text => printed.push(String(text)),
    createSideAgent: sideAgent
  })
  return { handler, printed, turns, agent }
}

test('/artifact lists entries and opens one by number', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-artifact-panel-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const empty = await core.handleCommand({ channel: 'terminal', agent: { getSessionId: () => 'panel-session' } }, '/artifact')
    assert.match(empty.response, /No artifacts in this session yet/)

    core.writeArtifact({ home, sessionId: 'panel-session', turn: 1, kind: 'walkthrough', name: 'walkthrough.md', content: '# Turn 1\n\n## Created\n- src/a.ts\n' })

    const list = await core.handleCommand({ channel: 'terminal', agent: { getSessionId: () => 'panel-session' } }, '/artifact')
    assert.match(list.response, /Artifacts · 1 item/)
    assert.match(list.response, /walkthrough/)
    assert.match(list.response, /\/artifact <number>/)

    const open = await core.handleCommand({ channel: 'terminal', agent: { getSessionId: () => 'panel-session' } }, '/artifact 1')
    assert.match(open.response, /walkthrough · walkthrough\.md/)
    assert.match(open.response, /# Turn 1/)
    assert.match(open.response, /src\/a\.ts/)

    const last = await core.handleCommand({ channel: 'terminal', agent: { getSessionId: () => 'panel-session' } }, '/artifact last')
    assert.match(last.response, /walkthrough/)

    const bad = await core.handleCommand({ channel: 'terminal', agent: { getSessionId: () => 'panel-session' } }, '/artifact 99')
    assert.match(bad.response, /No artifact at "99"/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/btw answers through a side agent and never touches the main turn loop', async () => {
  let asked = null
  let shutdown = false
  const h = harness({
    sideAgent: () => ({
      chat: async question => { asked = question; return { response: 'side answer' } },
      shutdown: () => { shutdown = true }
    })
  })

  assert.equal(await h.handler('/btw what is a worktree?'), true)
  assert.equal(asked, 'what is a worktree?')
  assert.match(h.printed.join('\n'), /\[btw\] side answer/)
  assert.equal(shutdown, true, 'the side agent must be shut down')
  assert.equal(h.turns.length, 0, 'no main turn is started')
})

test('/btw without a question explains usage', async () => {
  const h = harness({ sideAgent: () => ({ chat: async () => ({ response: '' }) }) })
  assert.equal(await h.handler('/btw'), true)
  assert.match(h.printed.join('\n'), /Usage: \/btw <question>/)
})

test('/fork switches to the forked session id', async () => {
  const h = harness({})
  assert.equal(await h.handler('/fork'), true)
  assert.match(h.printed.join('\n'), /Forked into session-123-fork/)
  assert.match(h.printed.join('\n'), /still resumable/)
})
