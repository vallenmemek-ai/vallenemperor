import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldAskApproval, bigEditPreview } from '../dist/cli.js'

test('/auto on (mode off) never asks, even for a big edit', () => {
  assert.equal(shouldAskApproval({ mode: 'off', required: false, bigPreview: { added: 105, removed: 0 } }), false)
  assert.equal(shouldAskApproval({ mode: 'off', required: true, bigPreview: null }), false)
  assert.equal(shouldAskApproval({ mode: 'off', required: true, bigPreview: { added: 500, removed: 0 } }), false)
})

test('a risky tool still asks in dangerous mode', () => {
  assert.equal(shouldAskApproval({ mode: 'dangerous', required: true, bigPreview: null }), true)
})

test('a big edit still previews in dangerous mode, as designed', () => {
  assert.equal(shouldAskApproval({ mode: 'dangerous', required: false, bigPreview: { added: 105, removed: 0 } }), true)
})

test('a small safe edit is silent in dangerous mode', () => {
  assert.equal(shouldAskApproval({ mode: 'dangerous', required: false, bigPreview: null }), false)
})

test('mode all asks for everything', () => {
  assert.equal(shouldAskApproval({ mode: 'all', required: true, bigPreview: null }), true)
})

test('bigEditPreview only fires for edit tools above the threshold', () => {
  const big = { name: 'write_file', args: { path: '/tmp/x.html', content: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') } }
  const preview = bigEditPreview(big, { interactive: true })
  assert.ok(preview, 'a 200-line write must produce a preview')
  assert.equal(preview.added > 100, true)

  const small = { name: 'write_file', args: { path: '/tmp/y.txt', content: 'a\nb' } }
  assert.equal(bigEditPreview(small, { interactive: true }), null)

  assert.equal(bigEditPreview({ name: 'terminal', args: { command: 'ls' } }, { interactive: true }), null)
  assert.equal(bigEditPreview(big, { interactive: false }), null, 'non-interactive runs never block on a preview')
})
