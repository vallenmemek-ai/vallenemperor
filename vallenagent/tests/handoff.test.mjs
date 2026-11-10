import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import handoff from '../dist/core/handoff.js'
const { createHandoff, deliverHandoff, formatHandoff, redactForHandoff } = handoff
const core = await import('../dist/index.js')

test('handoff redacts secrets and writes a resumable transcript', () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-handoff-'))
  try {
    const result = createHandoff({
      messages: [
        { role: 'user', content: 'my key is sk-abcdefghijklmnop and token=supersecretvalue123' },
        { role: 'assistant', content: 'noted' }
      ],
      sessionId: 'session-abc',
      title: 'demo',
      model: 'mock-model',
      cwd: '/repo',
      home,
      platform: 'telegram'
    })
    assert.equal(existsSync(result.file), true)
    const text = readFileSync(result.file, 'utf8')
    assert.match(text, /# Handoff · demo/)
    assert.match(text, /vallenemperor --resume session-abc/)
    assert.doesNotMatch(text, /sk-abcdefghijklmnop/)
    assert.doesNotMatch(text, /supersecretvalue123/)
    assert.match(text, /### user/)
    assert.equal(result.resumeCommand, 'vallenemperor --resume session-abc')

    assert.equal(redactForHandoff('npm_abcdefghijklmnopqrstuvwx'), 'npm_***')
    assert.equal(redactForHandoff('Bearer abcdefghijklmnop'), 'Bearer ***')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('delivery only runs when a command is configured, and substitutes {file}', () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-handoff2-'))
  try {
    const result = createHandoff({ messages: [{ role: 'user', content: 'hi' }], sessionId: 's1', home, platform: 'telegram' })
    const skipped = deliverHandoff({ result })
    assert.equal(skipped.attempted, false)
    assert.match(formatHandoff(result, skipped), /No handoff\.command configured/)

    const calls = []
    const sent = deliverHandoff({ command: 'send --file {file} --to {platform}', result, runner: command => { calls.push(command); return { status: 0, stdout: 'ok' } } })
    assert.equal(sent.attempted, true)
    assert.equal(sent.ok, true)
    assert.equal(calls[0], `send --file ${result.file} --to telegram`)

    const failed = deliverHandoff({ command: 'false {file}', result, runner: () => ({ status: 1, stderr: 'boom' }) })
    assert.equal(failed.ok, false)
    assert.match(formatHandoff(result, failed), /Delivery failed: boom/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/handoff writes a file and reports the resume command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-handoff-cmd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const ctx = {
      channel: 'terminal',
      agent: {
        config: { providers: {}, terminal: { cwd: '/repo' } },
        getSessionId: () => 'sess-42',
        provider: { model: 'mock-model' },
        exportTranscript: () => [{ role: 'user', content: 'do the thing' }, { role: 'assistant', content: 'done' }]
      }
    }
    const result = await core.handleCommand(ctx, '/handoff telegram')
    assert.match(result.response, /Handoff written:/)
    assert.match(result.response, /vallenemperor --resume sess-42/)
    assert.match(result.response, /No handoff\.command configured/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
