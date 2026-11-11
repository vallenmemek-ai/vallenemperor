import test from 'node:test'
import assert from 'node:assert/strict'

import { toAscii } from '../dist/cli-ui.js'

// A legacy Windows console (conhost without VT processing) cannot render box drawing
// or '·', so the CLI swaps them for plain ASCII. These mappings are the whole reason
// the Windows CI output looks different, so they are pinned here.
test('toAscii keeps a legacy Windows console readable', () => {
  assert.equal(toAscii('WORKING · terminal · npm test'), 'WORKING . terminal . npm test')
  assert.equal(toAscii('╭─ box ─╮'), '+- box -+')
  assert.equal(toAscii('│ line │'), '| line |')
  assert.equal(toAscii('✓ done'), 'v done')
})

test('toAscii leaves plain ASCII and unknown characters alone', () => {
  assert.equal(toAscii('plain text 123'), 'plain text 123')
  assert.equal(toAscii('日本語'), '日本語', 'characters without a mapping are preserved, not dropped')
})
