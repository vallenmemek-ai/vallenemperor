import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultExportName, exportSession, redactSecrets } from '../dist/agent/session_export.js'
import { discoverCustomCommands, findCustomCommand, formatCustomCommandList, renderCustomCommand } from '../dist/core/custom_commands.js'

const messages = [
  { role: 'user', content: 'use key sk-abcdefghijklmnop1234 please' },
  { role: 'assistant', content: 'done' }
]

test('session export writes markdown and json, and redacts secrets on request', () => {
  const md = exportSession({ messages, sessionId: 'sess-1', model: 'm', title: 'Demo', now: new Date('2026-01-01T00:00:00Z') })
  assert.match(md, /^# Session Demo/)
  assert.match(md, /session: `sess-1`/)
  assert.match(md, /## user/)
  assert.match(md, /## assistant/)
  assert.match(md, /sk-abcdefghijklmnop1234/, 'no redaction by default')

  const redacted = exportSession({ messages, sessionId: 'sess-1', format: 'md', redact: true })
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop1234/)
  assert.match(redacted, /REDACTED/)

  const json = JSON.parse(exportSession({ messages, sessionId: 'sess-1', format: 'json', redact: true }))
  assert.equal(json.sessionId, 'sess-1')
  assert.equal(json.redacted, true)
  assert.equal(json.messages.length, 2)
  assert.doesNotMatch(json.messages[0].content, /sk-abcdefghijklmnop1234/)

  assert.match(redactSecrets('token ghp_abcdefghijklmnopqrstuvwx'), /ghp_\*\*\*REDACTED\*\*\*/)
  assert.match(defaultExportName('abcdefghijklmnop', 'md'), /^session-abcdefghijkl-\d{4}-\d{2}-\d{2}T.*\.md$/)
})

test('custom commands are discovered, workspace wins, and $ARGUMENTS renders', () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-cmd-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'vallen-cmd-ws-'))
  try {
    mkdirSync(join(home, 'commands'), { recursive: true })
    writeFileSync(join(home, 'commands', 'review.md'), '---\ndescription: global review\n---\nGlobal review body')
    mkdirSync(join(workspace, '.vallenemperor', 'commands'), { recursive: true })
    writeFileSync(join(workspace, '.vallenemperor', 'commands', 'review.md'), '---\ndescription: workspace review\n---\nReview this diff. Focus: $ARGUMENTS')
    writeFileSync(join(workspace, '.vallenemperor', 'commands', 'deploy.md'), '---\ndescription: deploy it\n---\nDeploy the app')

    const commands = discoverCustomCommands({ workspace, home })
    assert.deepEqual(commands.map(command => command.name), ['deploy', 'review'])
    const review = findCustomCommand('/review', commands)
    assert.equal(review.scope, 'workspace')
    assert.equal(review.description, 'workspace review')
    assert.equal(renderCustomCommand(review, 'auth bugs'), 'Review this diff. Focus: auth bugs')

    const deploy = findCustomCommand('deploy', commands)
    assert.equal(renderCustomCommand(deploy, 'prod'), 'Deploy the app\n\nArguments: prod')

    assert.match(formatCustomCommandList(commands), /\/review — workspace review \(workspace\)/)
    assert.match(formatCustomCommandList([]), /No custom commands found/)
    assert.equal(findCustomCommand('missing', commands), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
