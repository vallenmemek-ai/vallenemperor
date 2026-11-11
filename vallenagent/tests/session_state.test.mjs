import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { buildCheckpoint, saveCheckpoint, loadCheckpoint, clearCheckpoint, buildResumePrompt, isCheckpointRelevant, checkpointPath, progressFromHistory } from '../dist/agent/turn_recovery.js'
import { TodoStore } from '../dist/session/todo.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('checkpoint round-trips through disk and clears', t => {
  const dir = tempDir(t)
  const checkpoint = buildCheckpoint({
    sessionId: 'sess-1',
    iterations: 3,
    userRequest: 'fix the build',
    filesTouched: ['a.ts'],
    progress: 'wrote a.ts'
  })
  const file = saveCheckpoint(dir, checkpoint)
  assert.ok(file)
  assert.equal(file, checkpointPath(dir, 'sess-1'))

  const loaded = loadCheckpoint(dir, 'sess-1')
  assert.equal(loaded.userRequest, 'fix the build')
  assert.deepEqual(loaded.filesTouched, ['a.ts'])
  assert.equal(loaded.iterations, 3)

  clearCheckpoint(dir, 'sess-1')
  assert.equal(loadCheckpoint(dir, 'sess-1'), null)
})

test('checkpointPath sanitizes session ids so traversal cannot escape', () => {
  const p = checkpointPath('/base', '../../etc/passwd')
  assert.equal(resolve(dirname(p)), resolve('/base'), 'the file stays directly under the base dir')
  assert.equal(resolve(p).startsWith(resolve('/base')), true, 'the path cannot escape the base dir')
})

test('isCheckpointRelevant respects age and null', () => {
  assert.equal(isCheckpointRelevant(null), false)
  assert.equal(isCheckpointRelevant({ updatedAt: Date.now() }), true)
  assert.equal(isCheckpointRelevant({ updatedAt: Date.now() - 48 * 60 * 60 * 1000 }), false)
})

test('buildResumePrompt carries request, files and error forward', () => {
  const prompt = buildResumePrompt({ sessionId: 's', iterations: 2, updatedAt: Date.now(), userRequest: 'do the thing', filesTouched: ['x.ts'], progress: 'half done', lastError: 'boom' })
  assert.match(prompt, /do the thing/)
  assert.match(prompt, /x\.ts/)
  assert.match(prompt, /boom/)
  assert.match(prompt, /Continue from this state/)
})

test('progressFromHistory keeps recent assistant lines', () => {
  const progress = progressFromHistory([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'wrote file a' }
  ])
  assert.match(progress, /wrote file a/)
})

test('TodoStore rejects duplicate ids and tracks status transitions', () => {
  const store = new TodoStore()
  store.write([{ id: '1', content: 'first' }, { id: '2', content: 'second' }])
  assert.equal(store.read().length, 2)
  assert.throws(() => store.write([{ id: '1', content: 'a' }, { id: '1', content: 'b' }]), /Duplicate todo id/)

  store.write([{ id: '1', status: 'completed' }], true)
  assert.equal(store.read().find(i => i.id === '1').status, 'completed')
  assert.equal(store.read().find(i => i.id === '2').content, 'second')
})
