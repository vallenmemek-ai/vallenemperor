import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../src/cli-commands.mjs'
import { completionScript, runCompletionCommand } from '../src/cli-completion.mjs'
import { parseArgs } from '../src/cli.mjs'

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
