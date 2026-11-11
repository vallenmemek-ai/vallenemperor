import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../dist/cli-commands.js'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

const PLAN_MD = `# Plan: demo feature

## Step-by-step tasks

1. First step
   Do the first thing.
   Verify: \`npm test\`

2. Second step
   Do the second thing.
`

function harness({ withPlan = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'vallen-plan-cmd-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-plan-home-'))
  if (withPlan) {
    const dir = join(cwd, '.vallenemperor', 'plans')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-01-01_120000-demo.md'), PLAN_MD)
  }
  const printed = []
  const turns = []
  const state = {}
  const handler = createLocalCommandHandler({
    agent: {
      config: { providers: {}, terminal: { cwd } },
      getSessionId: () => 'plan-session',
      getContextStats: () => ({ turns: 1 })
    },
    core,
    state,
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
  return {
    handler,
    state,
    printed,
    turns,
    cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  }
}

test('/plan status and /plan go explain the missing state', async () => {
  const h = harness({ withPlan: false })
  try {
    await h.handler('/plan status')
    assert.match(h.printed.join('\n'), /No plan run yet/)
    h.printed.length = 0

    await h.handler('/plan go')
    assert.match(h.printed.join('\n'), /No plan file found/)
    assert.equal(h.turns.length, 0)
  } finally { h.cleanup() }
})

test('/plan go runs step 1 only, then /plan next runs step 2 and finishes', async () => {
  const h = harness()
  try {
    await h.handler('/plan go')
    assert.equal(h.turns.length, 1)
    assert.match(h.turns[0].message, /plan mode — executing step 1\/2/)
    assert.match(h.turns[0].message, /Do the first thing/)
    assert.match(h.turns[0].display, /\[plan 1\/2\] First step/)
    assert.match(h.printed.join('\n'), /Step 1\/2 done: First step/)
    assert.match(h.printed.join('\n'), /Next: 2\. Second step/)

    h.printed.length = 0
    await h.handler('/plan next')
    assert.equal(h.turns.length, 2)
    assert.match(h.turns[1].message, /executing step 2\/2/)
    assert.match(h.printed.join('\n'), /Finished "demo feature"/)
    assert.equal(h.state.planRun.status, 'finished')
  } finally { h.cleanup() }
})

test('/plan edit re-runs the current step with feedback and does not advance', async () => {
  const h = harness()
  try {
    await h.handler('/plan go')
    h.printed.length = 0
    await h.handler('/plan edit use the existing helper')

    assert.equal(h.turns.length, 2)
    assert.match(h.turns[1].message, /executing step 2\/2/, 'edit re-runs the step that is now current')
    assert.match(h.turns[1].message, /use the existing helper/)
    assert.deepEqual(h.state.planRun.feedback, ['use the existing helper'])
  } finally { h.cleanup() }
})

test('/plan skip records the skip and /plan stop freezes the run', async () => {
  const h = harness()
  try {
    await h.handler('/plan go')
    h.printed.length = 0
    await h.handler('/plan skip')
    assert.deepEqual(h.state.planRun.skipped, [1])
    assert.equal(h.state.planRun.status, 'finished')
    assert.match(h.printed.join('\n'), /Skipped step 2: Second step/)

    h.printed.length = 0
    await h.handler('/plan status')
    assert.match(h.printed.join('\n'), /Plan finished/)

    const stopped = harness()
    try {
      await stopped.handler('/plan go')
      stopped.printed.length = 0
      await stopped.handler('/plan stop')
      assert.equal(stopped.state.planRun.status, 'stopped')
      assert.match(stopped.printed.join('\n'), /Stopped at step 2\/2/)
    } finally { stopped.cleanup() }
  } finally { h.cleanup() }
})

test('/plan <task> runs a planning turn and saves the new plan as an artifact', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-plan-home2-'))
  const cwd = mkdtempSync(join(tmpdir(), 'vallen-plan-cwd2-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const printed = []
    const turns = []
    const handler = createLocalCommandHandler({
      agent: { config: { providers: {}, terminal: { cwd } }, getSessionId: () => 'plan-session', getContextStats: () => ({ turns: 1 }) },
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
      // The planning turn is where the real agent writes the plan file itself.
      runTurn: async message => {
        turns.push(message)
        const dir = join(cwd, '.vallenemperor', 'plans')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, '2026-02-02_101010-demo.md'), PLAN_MD)
      },
      displayLine: text => printed.push(String(text))
    })

    await handler('/plan add a demo feature')
    assert.equal(turns.length, 1)
    assert.match(turns[0], /plan mode/i)
    assert.match(printed.join('\n'), /Plan saved:/)
    assert.match(printed.join('\n'), /\/plan go/)

    const artifacts = core.listArtifacts({ home, sessionId: 'plan-session' })
    assert.ok(artifacts.some(entry => entry.kind === 'plan'), 'the plan must be stored as an artifact')
    assert.ok(artifacts.some(entry => entry.name === 'plan-demo.md'))
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
