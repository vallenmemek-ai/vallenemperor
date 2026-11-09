import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleCommand } from '../dist/core/commands.js'

function fakeAgent(overrides = {}) {
  const calls = { setModel: [], resetSession: [], resumeSession: [] }
  const sessions = [
    { id: 'session-1', title: 'first', updated_at: '2026-01-01', model: 'm1' },
    { id: 'session-2', title: 'second', updated_at: '2026-01-02', model: 'm2' }
  ]
  const agent = {
    calls,
    getSessionId: () => 'session-live',
    provider: { model: 'live-model', baseURL: 'http://127.0.0.1:20128/v1' },
    config: { providers: { active: '9router' }, terminal: { cwd: '/tmp/work' } },
    mcpManager: { getStatus: () => [{ name: 'a', status: 'ready' }, { name: 'b', status: 'disabled' }] },
    skillLoader: { list: () => [{ name: 's1' }, { name: 's2' }] },
    sessionManager: { listSessions: () => sessions },
    getContextStats: () => ({
      promptTokens: 1200, contextWindow: 128000, percent: 1, estimated: false,
      messages: 4, turns: 2, systemPromptTokens: 500, historyTokens: 700,
      sessionPromptTotal: 3000, sessionCompletionTotal: 400
    }),
    setModel: (model, persist) => { calls.setModel.push([model, persist]) },
    resumeSession: id => { calls.resumeSession.push(id); return id === 'session-1' || id === 'session-2' },
    resetSession: id => { calls.resetSession.push(id); return Promise.resolve() },
    interrupt: () => true,
    requestBackgroundReview: () => true,
    ...overrides
  }
  return agent
}

const terminal = agent => ({ channel: 'terminal', agent })
const remote = (agent, userId = 42) => ({ channel: 'remote', agent, userId })

test('/status and /stats return the same rich report on the terminal', async () => {
  const agent = fakeAgent()
  const status = await handleCommand(terminal(agent), '/status')
  const stats = await handleCommand(terminal(agent), '/stats')
  assert.equal(status.handled, true)
  assert.equal(stats.handled, true)
  assert.equal(status.response, stats.response, '/stats must be an alias of /status')
  assert.match(status.response, /Session: session-live/)
  assert.match(status.response, /Model: live-model/)
  assert.match(status.response, /Working directory: \/tmp\/work/)
  assert.match(status.response, /MCP: 1\/1/, 'disabled servers are not counted')
  assert.match(status.response, /Skills: 2/)
})

test('/status works the same on the remote channel (one implementation)', async () => {
  const agent = fakeAgent()
  const local = await handleCommand(terminal(agent), '/status')
  const telegram = await handleCommand(remote(agent), '/status')
  assert.equal(local.response, telegram.response)
})

test('/status mentions a busy agent without hiding the report', async () => {
  const agent = fakeAgent()
  const busy = await handleCommand({ ...terminal(agent), busy: true }, '/status')
  assert.match(busy.response, /sedang mengerjakan/)
  assert.match(busy.response, /Session: session-live/)
})

test('/model switches for the session only; /model save persists', async () => {
  const agent = fakeAgent()
  const session = await handleCommand(terminal(agent), '/model gpt-4o-mini')
  assert.match(session.response, /tidak disimpan/)
  assert.deepEqual(agent.calls.setModel, [['gpt-4o-mini', false]])

  const saved = await handleCommand(terminal(agent), '/model save gpt-4o-mini')
  assert.match(saved.response, /disimpan ke config/)
  assert.deepEqual(agent.calls.setModel, [['gpt-4o-mini', false], ['gpt-4o-mini', true]])
})

test('/model with no argument shows the current model and both forms', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/model')
  assert.match(result.response, /live-model/)
  assert.match(result.response, /\/model save/)
  assert.deepEqual(agent.calls.setModel, [])
})

test('/model save without a name explains usage', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/model save')
  assert.match(result.response, /Penggunaan/)
  assert.deepEqual(agent.calls.setModel, [])
})

test('/sessions numbers the list so /resume can use a number', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/sessions')
  assert.match(result.response, /^1\. session-1/m)
  assert.match(result.response, /^2\. session-2/m)
  assert.match(result.response, /m1/)
})

test('/resume accepts a number and resolves it to a session id', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/resume 2')
  assert.deepEqual(agent.calls.resumeSession, ['session-2'])
  assert.match(result.response, /session-2 dilanjutkan/)
})

test('/resume accepts a raw session id (the form core always understood)', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/resume session-1')
  assert.deepEqual(agent.calls.resumeSession, ['session-1'])
  assert.match(result.response, /session-1 dilanjutkan/)
})

test('/resume reports an out-of-range number instead of resuming the wrong session', async () => {
  const agent = fakeAgent()
  const result = await handleCommand(terminal(agent), '/resume 99')
  assert.match(result.response, /di luar rentang/)
  assert.deepEqual(agent.calls.resumeSession, [])
})

test('/new resets with the channel prefix', async () => {
  const local = fakeAgent()
  await handleCommand(terminal(local), '/new')
  assert.equal(local.calls.resetSession.length, 1)
  assert.match(local.calls.resetSession[0], /^\d+$/, 'terminal prefix is empty, so the id is a timestamp')

  const telegram = fakeAgent()
  await handleCommand(remote(telegram, 7), '/reset')
  assert.match(telegram.calls.resetSession[0], /^tg-7-\d+$/)
})

test('/stop stays remote-only because the CLI needs its own approval cleanup', async () => {
  const agent = fakeAgent()
  const local = await handleCommand(terminal(agent), '/stop')
  assert.equal(local.handled, false)
  const telegram = await handleCommand(remote(agent), '/stop')
  assert.equal(telegram.handled, true)
})

test('/schedule manages real jobs from the terminal, not just Telegram', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-cron-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const agent = fakeAgent()

    const empty = await handleCommand(terminal(agent), '/schedule list')
    assert.match(empty.response, /Belum ada jadwal/, 'must not answer "use Telegram" any more')

    const added = await handleCommand(terminal(agent), '/schedule add 0 9 * * * Asia/Jakarta | nightly | say hi')
    assert.match(added.response, /Scheduled job created/)
    assert.match(added.response, /next:/)
    assert.doesNotMatch(added.response, /Telegram approval/)

    const listed = await handleCommand(terminal(agent), '/schedule list')
    assert.match(listed.response, /nightly/)
    const id = listed.response.split(' · ')[0]

    const removed = await handleCommand(terminal(agent), `/schedule remove ${id}`)
    assert.match(removed.response, /removed/)
    const after = await handleCommand(terminal(agent), '/schedule list')
    assert.match(after.response, /Belum ada jadwal/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/schedule rejects an invalid cron expression with a reason', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-cron-bad-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const result = await handleCommand(terminal(fakeAgent()), '/schedule add not-a-cron UTC | bad | x')
    assert.match(result.response, /Schedule rejected/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
