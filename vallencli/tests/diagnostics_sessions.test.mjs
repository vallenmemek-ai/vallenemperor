import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dumpReport, insightsReport, listLogs, promptSizeReport } from '../dist/cli-diagnostics.js'
import { runSessionsCommand } from '../dist/cli-sessions.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'vallen-diag-'))
}

test('prompt-size breaks down system prompt, tool schemas and skills', () => {
  const report = promptSizeReport({
    systemPrompt: 'x'.repeat(400),
    toolSchemas: ['{"name":"read_file"}', '{"name":"write_file"}'],
    skills: [{ name: 'deploy', description: 'Deploy the app' }]
  })
  assert.match(report, /system prompt : ~100 tokens/)
  assert.match(report, /tool schemas {2}: ~\d+ tokens \(2 tools\)/)
  assert.match(report, /skills index {2}: ~\d+ tokens \(1 skills\)/)
  assert.match(report, /total fixed/)
})

test('insights summarises sessions and dump redacts api keys', () => {
  assert.match(insightsReport({ sessions: [] }), /No saved sessions/)
  const report = insightsReport({ sessions: [{ id: 's1', title: 'demo', turns: 4, updatedAt: new Date().toISOString() }] })
  assert.match(report, /Sessions: 1 total · 1 in the last 7 days/)
  assert.match(report, /s1 · demo · 4 msgs/)

  const dump = dumpReport({ config: { providers: { active: 'x', x: { base_url: 'http://x', api_key: 'sk-secret' } } }, version: '1.2.3', home: '/tmp/home' })
  assert.match(dump, /version : 1\.2\.3/)
  assert.match(dump, /\*\*\*set\*\*\*/)
  assert.doesNotMatch(dump, /sk-secret/)
})

test('logs lists files from the home logs directory', () => {
  const home = tempHome()
  try {
    assert.deepEqual(listLogs(home), [])
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'logs', 'agent.log'), 'hello')
    const logs = listLogs(home)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].name, 'agent.log')
    assert.ok(logs[0].size >= 5)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('sessions list, show, export and prune work from the CLI', async () => {
  const home = tempHome()
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const core = await import('../../vallenagent/dist/index.js')
    const manager = new core.SessionManager()
    manager.saveSession('session-one', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], home, 'mock')
    manager.saveSession('session-two', [{ role: 'user', content: 'second' }], home, 'mock')

    const lines = []
    const stdout = { write: line => lines.push(line) }
    assert.equal(runSessionsCommand({ args: ['list'], stdout }), 0)
    assert.match(lines.join(''), /2 session\(s\)/)
    assert.match(lines.join(''), /session-one/)

    lines.length = 0
    assert.equal(runSessionsCommand({ args: ['show', 'session-one'], stdout }), 0)
    assert.match(lines.join(''), /Session session-one/)
    assert.match(lines.join(''), /messages: 2/)

    lines.length = 0
    assert.equal(runSessionsCommand({ args: ['export', 'session-one', 'json'], stdout }), 0)
    const exported = JSON.parse(lines.join(''))
    assert.equal(exported.sessionId, 'session-one')
    assert.equal(exported.messages.length, 2)

    assert.equal(runSessionsCommand({ args: ['show', 'missing'], stdout }), 1)
    assert.equal(runSessionsCommand({ args: ['nonsense'], stdout }), 2)

    lines.length = 0
    assert.equal(runSessionsCommand({ args: ['prune', '1'], stdout }), 0)
    assert.match(lines.join(''), /Pruned 1 session/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
