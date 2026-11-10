import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { pathLockCount, resetPathLocks, withPathLock } from '../dist/core/path_lock.js'
import { buildLearnPrompt, LEARN_AUTHORING_STANDARDS } from '../dist/agent/learn_prompt.js'

test('writes to the same path are serialised in order', async () => {
  resetPathLocks()
  const order = []
  const slow = (label, ms) => withPathLock('/repo/file.ts', async () => {
    order.push(`start:${label}`)
    await new Promise(resolve => setTimeout(resolve, ms))
    order.push(`end:${label}`)
    return label
  })

  const first = slow('a', 30)
  const second = slow('b', 5)
  const third = slow('c', 1)
  assert.deepEqual(await Promise.all([first, second, third]), ['a', 'b', 'c'])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pathLockCount(), 0, 'locks are released when the queue drains')
})

test('different paths do not block each other', async () => {
  resetPathLocks()
  const order = []
  const a = withPathLock('/repo/a.ts', async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    order.push('a')
  })
  const b = withPathLock('/repo/b.ts', async () => {
    order.push('b')
  })
  await Promise.all([a, b])
  assert.deepEqual(order, ['b', 'a'], 'the fast unrelated write does not wait for the slow one')
  resetPathLocks()
})

test('a failed write does not block the next one', async () => {
  resetPathLocks()
  await assert.rejects(withPathLock('/repo/x.ts', async () => { throw new Error('boom') }), /boom/)
  const value = await withPathLock('/repo/x.ts', async () => 'ok')
  assert.equal(value, 'ok')
  resetPathLocks()
})

test('the learn prompt encodes the authoring standards and the source', () => {
  const prompt = buildLearnPrompt('docs/ROADMAP.md')
  assert.match(prompt, /\[\/learn — author a skill\]/)
  assert.match(prompt, /docs\/ROADMAP\.md/)
  assert.match(prompt, /description: ONE sentence, <= 60 characters/)
  assert.match(prompt, /One rule per lesson/)
  assert.match(prompt, /Never record environment failures/)
  assert.match(prompt, /skill_manage/)
  assert.ok(LEARN_AUTHORING_STANDARDS.includes('## Pitfalls'))

  const noSource = buildLearnPrompt('')
  assert.match(noSource, /use the current conversation/i)
})

test('the learn prompt tells the agent to update an existing skill instead of duplicating', () => {
  const prompt = buildLearnPrompt('the deploy workflow')
  assert.match(prompt, /skills_list/)
  assert.match(prompt, /UPDATE\s+that skill instead of creating a near-duplicate/)
})
