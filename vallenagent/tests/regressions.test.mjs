import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { pruneOldToolResults, truncateToolResult } from '../dist/agent/agent_tool_history.js'
import { HubLock } from '../dist/skills_hub/lock.js'

const bigToolMessage = (id, chars = 2000) => ({ role: 'tool', tool_call_id: id, name: 'read_file', content: 'y'.repeat(chars) })

test('pruneOldToolResults prunes old history and protects the active turn window', () => {
  // 40 messages: indices 0..9 = old history, 10 = active user turn start, 11..39 = active turn + tail
  const messages = Array.from({ length: 40 }, (_, i) => bigToolMessage(`c${i}`))
  const activeUserIndex = 10
  const protectTail = 24 // cutoffIndex = 40 - 24 = 16
  const pruned = pruneOldToolResults(messages, protectTail, activeUserIndex)

  for (let i = 0; i < activeUserIndex; i++) {
    assert.match(pruned[i].content, /pruned to save context/, `old message ${i} must be pruned`)
  }
  for (let i = activeUserIndex; i < messages.length; i++) {
    assert.equal(pruned[i].content, messages[i].content, `protected message ${i} must stay verbatim`)
  }
})

test('pruneOldToolResults keeps failed tool output even in the prunable region', () => {
  const messages = Array.from({ length: 10 }, (_, i) => bigToolMessage(`c${i}`))
  messages[2] = { role: 'tool', tool_call_id: 'c2', name: 'terminal', content: JSON.stringify({ exit_code: 1, output: 'z'.repeat(2000) }) }
  const pruned = pruneOldToolResults(messages, 4, 8)
  assert.match(pruned[2].content, /exit_code/, 'error output must not be pruned')
  assert.match(pruned[0].content, /pruned to save context/)
})

test('pruneOldToolResults leaves short results alone', () => {
  const messages = Array.from({ length: 10 }, (_, i) => bigToolMessage(`c${i}`, 100))
  const pruned = pruneOldToolResults(messages, 4, 8)
  assert.deepEqual(pruned.map(m => m.content), messages.map(m => m.content))
})

test('pruneOldToolResults treats a missing active turn (-1) as no protected window', () => {
  const messages = Array.from({ length: 10 }, (_, i) => bigToolMessage(`c${i}`))
  const pruned = pruneOldToolResults(messages, 4, -1)
  for (let i = 0; i < 6; i++) assert.match(pruned[i].content, /pruned to save context/)
  for (let i = 6; i < 10; i++) assert.equal(pruned[i].content, messages[i].content)
})

test('truncateToolResult reports the real character budget, not a hardcoded 100K', () => {
  const out = truncateToolResult('x'.repeat(5000), 1000)
  assert.ok(out.length <= 1000, `output must fit the budget, got ${out.length}`)
  assert.match(out, /1,000 characters|1000 characters/, 'marker must state the actual limit')
  assert.doesNotMatch(out, /100K/)
})

test('HubLock writes atomically and keeps a backup of a corrupt lock file', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-lock-'))
  const savedHome = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (savedHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const lock = new HubLock()
  lock.set('demo-skill', {
    name: 'demo-skill',
    source: 'official',
    installPath: 'demo/demo-skill',
    contentHash: 'abc',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  })
  lock.save()

  const lockPath = join(home, 'skills_hub', '.lock.json')
  assert.equal(existsSync(lockPath), true)
  const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(parsed.skills['demo-skill'].contentHash, 'abc')
  assert.equal(existsSync(`${lockPath}.tmp`), false, 'temp file must be renamed away')

  // A corrupt lock must not be silently discarded: it gets moved aside for recovery.
  writeFileSync(lockPath, '{ not json', 'utf8')
  const recovered = new HubLock()
  assert.equal(recovered.has('demo-skill'), false)
  const { readdirSync } = await import('node:fs')
  const backups = readdirSync(join(home, 'skills_hub')).filter(f => f.startsWith('.lock.corrupt-'))
  assert.equal(backups.length, 1, 'corrupt lock is preserved as a backup')
  assert.equal(readFileSync(join(home, 'skills_hub', backups[0]), 'utf8'), '{ not json')
  assert.equal(existsSync(lockPath), false, 'unreadable lock is not left in place to be silently reused')
})
