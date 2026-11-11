import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../dist/cli-commands.js'
import { completionScript, runCompletionCommand } from '../dist/cli-completion.js'
import { parseArgs } from '../dist/cli.js'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

function harness({ cwd = process.cwd(), transcript = [], editor } = {}) {
  const printed = []
  const turns = []
  const state = { sessionTitle: undefined }
  const agent = {
    config: { providers: { active: 'x', x: { model: 'm' } }, terminal: { cwd } },
    getSessionId: () => 'session-abcdefghijkl',
    getContextStats: () => ({ turns: 1 }),
    exportTranscript: () => transcript
  }
  const handler = createLocalCommandHandler({
    agent,
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
    displayLine: text => printed.push(String(text)),
    runEditor: editor
  })
  return { handler, printed, turns, state }
}

test('/save writes a transcript file and /title names the session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-save-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'vallen-save-cwd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const h = harness({ cwd, transcript: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] })
    await h.handler('/title demo session')
    assert.equal(h.state.sessionTitle, 'demo session')

    await h.handler('/save md notes.md')
    const saved = readFileSync(join(cwd, 'notes.md'), 'utf8')
    assert.match(saved, /^# Session demo session/)
    assert.match(saved, /## user/)
    assert.match(saved, /hello/)
    assert.match(h.printed.join('\n'), /Saved md transcript \(2 messages\)/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('/history prints recent messages and /prompt sends the editor buffer', async () => {
  const h = harness({
    transcript: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }],
    editor: (command, file) => { writeFileSync(file, 'composed prompt'); return true }
  })
  await h.handler('/history 5')
  assert.match(h.printed.join('\n'), /› first/)
  assert.match(h.printed.join('\n'), /‹ second/)

  h.printed.length = 0
  await h.handler('/prompt')
  assert.equal(h.turns.length, 1)
  assert.equal(h.turns[0].message, 'composed prompt')
})

test('/commands lists custom commands and /<name> runs one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-custom-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'vallen-custom-cwd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    mkdirSync(join(cwd, '.vallenemperor', 'commands'), { recursive: true })
    writeFileSync(join(cwd, '.vallenemperor', 'commands', 'review.md'), '---\ndescription: review the diff\n---\nReview this diff. Focus: $ARGUMENTS')

    const h = harness({ cwd })
    await h.handler('/commands')
    assert.match(h.printed.join('\n'), /\/review — review the diff/)

    await h.handler('/review auth bugs')
    assert.equal(h.turns.length, 1)
    assert.equal(h.turns[0].message, 'Review this diff. Focus: auth bugs')
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('/steer queues a mid-turn note and /<skill> runs a loaded skill', async () => {
  const steers = []
  const turns = []
  const printed = []
  const handler = createLocalCommandHandler({
    agent: {
      config: { providers: {}, terminal: { cwd: process.cwd() } },
      getSessionId: () => 'skill-session',
      getContextStats: () => ({ turns: 1 }),
      steer: text => { steers.push(text); return true },
      skillLoader: { list: () => [{ name: 'deploy', content: 'Step 1: build\nStep 2: ship' }] }
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

  assert.equal(await handler('/steer focus on auth'), true)
  assert.deepEqual(steers, ['focus on auth'])
  assert.match(printed.join('\n'), /Steer queued: focus on auth/)

  await handler('/deploy production')
  assert.equal(turns.length, 1)
  assert.match(turns[0].message, /\[skill: deploy\]/)
  assert.match(turns[0].message, /Step 1: build/)
  assert.match(turns[0].message, /Task: production/)
})

test('/queue, /rewind and /goal drive the session controls', async () => {
  const printed = []
  const rewinds = []
  let goal = null
  const state = {}
  const agent = {
    config: { providers: {}, terminal: { cwd: process.cwd() } },
    getSessionId: () => 'ctrl-session',
    getContextStats: () => ({ turns: 1 }),
    listUserPrompts: () => [{ index: 1, text: 'first task' }, { index: 2, text: 'second task' }],
    rewindToPrompt: n => { rewinds.push(n); return 'second task' },
    forkAtPrompt: n => { rewinds.push(`fork:${n}`); return { sessionId: 'session-fork', prompt: 'first task' } },
    setGoal: text => { goal = { text, status: 'active', attempts: 0, maxTurns: 20 }; return goal },
    getGoal: () => goal,
    updateGoal: patch => { if (goal) Object.assign(goal, patch); return goal },
    clearGoal: () => { goal = null }
  }
  const handler = createLocalCommandHandler({
    agent,
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
    runTurn: async () => {},
    displayLine: text => printed.push(String(text))
  })

  await handler('/queue add run the tests')
  await handler('/queue add lint the code')
  assert.deepEqual(state.queuedPrompts, ['run the tests', 'lint the code'])
  printed.length = 0
  await handler('/queue list')
  assert.match(printed.join('\n'), /1\. run the tests/)
  await handler('/queue rm 1')
  assert.deepEqual(state.queuedPrompts, ['lint the code'])
  await handler('/queue clear')
  assert.deepEqual(state.queuedPrompts, [])

  printed.length = 0
  await handler('/rewind')
  assert.match(printed.join('\n'), /Recent prompts/)
  await handler('/rewind 2')
  assert.match(printed.join('\n'), /Rewound to before prompt 2/)
  await handler('/rewind fork 1')
  assert.match(printed.join('\n'), /Forked into session-fork at prompt 1/)
  assert.deepEqual(rewinds, [2, 'fork:1'])

  printed.length = 0
  await handler('/goal ship the release')
  assert.equal(goal.text, 'ship the release')
  assert.match(printed.join('\n'), /Goal set \(max 20 attempts\)/)
  await handler('/goal pause')
  assert.equal(goal.status, 'paused')
  await handler('/goal resume')
  assert.equal(goal.status, 'active')
  await handler('/goal status')
  assert.match(printed.join('\n'), /Goal \(active\)/)
  await handler('/goal clear')
  assert.equal(goal, null)
})

test('/journey is an alias for /skills journey', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'vallen-journey-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  const printed = []
  const handler = createLocalCommandHandler({
    agent: {
      config: { providers: {}, terminal: { cwd: process.cwd() } },
      getSessionId: () => 'journey-session',
      getContextStats: () => ({ turns: 1 }),
      skillLoader: { list: () => [] }
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
    runTurn: async () => {},
    displayLine: text => printed.push(String(text))
  })

  assert.equal(await handler('/journey'), true, 'the alias is handled locally, not sent to the model')
  assert.match(printed.join('\n'), /Nothing learned yet|skill/i)
})

test('completion scripts exist for bash, zsh and fish, and routing works', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const script = completionScript(shell)
    assert.ok(script, `${shell} script`)
    assert.match(script, /vallenemperor/)
    assert.match(script, /doctor/)
  }
  assert.equal(completionScript('pwsh'), null)

  const lines = []
  assert.equal(runCompletionCommand({ shell: 'nope', stdout: { write: line => lines.push(line) } }), 2)
  assert.match(lines.join(''), /Usage: vallenemperor completion/)

  assert.equal(parseArgs(['completion', 'bash']).mode, 'completion')
  assert.equal(parseArgs(['completion', 'bash']).shell, 'bash')
})
