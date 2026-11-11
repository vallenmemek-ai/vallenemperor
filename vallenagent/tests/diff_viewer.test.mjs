import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import viewer from '../dist/core/diff_viewer.js'
const { formatHunkView, moveReview, parseDiffHunks, revertHunk, startDiffReview } = viewer
const core = await import('../dist/index.js')

const SAMPLE = `diff --git a/app.js b/app.js
index 1111111..2222222 100644
--- a/app.js
+++ b/app.js
@@ -1,3 +1,4 @@
 line one
+added line
 line two
 line three
@@ -10,3 +11,3 @@
 context a
-old value
+new value
 context b
`

test('a diff is split into per-file hunks with patches git can apply', () => {
  const hunks = parseDiffHunks(SAMPLE)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].file, 'app.js')
  assert.equal(hunks[0].index, 1)
  assert.match(hunks[0].patch, /^diff --git a\/app\.js b\/app\.js/)
  assert.match(hunks[0].patch, /\+added line/)
  assert.equal(hunks[1].index, 2)
  assert.match(hunks[1].header, /^@@ -10,3 \+11,3 @@/)
  assert.match(formatHunkView(hunks[0], 2), /Hunk 1\/2 · app\.js · \+1 -0/)
  assert.match(formatHunkView(hunks[0], 2), /\/diff skip \(revert this hunk\)/)
  assert.deepEqual(parseDiffHunks(''), [])
})

test('navigation clamps at both ends', () => {
  const state = startDiffReview('/repo', SAMPLE)
  assert.equal(state.index, 0)
  assert.equal(moveReview(state, -1).index, 0)
  assert.equal(moveReview(state, 1).index, 1)
  assert.equal(moveReview(state, 5).index, 1)
  assert.equal(startDiffReview('/repo', 'nothing here'), null)
})

test('skipping a hunk reverts only that hunk in a real repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vallen-diff-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    const file = join(repo, 'app.txt')
    const base = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
    writeFileSync(file, `${base.join('\n')}\n`)
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    // Two far-apart hunks so git keeps them separate.
    const changed = [...base]
    changed[0] = 'LINE 1 CHANGED'
    changed[39] = 'LINE 40 CHANGED'
    writeFileSync(file, `${changed.join('\n')}\n`)
    const diff = execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' })
    const hunks = parseDiffHunks(diff)
    assert.equal(hunks.length, 2)

    const result = revertHunk({ repo, hunk: hunks[0] })
    assert.equal(result.ok, true, result.output)
    const afterFirst = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
    assert.equal(afterFirst[0], 'line 1', 'only the first hunk was reverted')
    assert.equal(afterFirst[39], 'LINE 40 CHANGED')

    const second = revertHunk({ repo, hunk: hunks[1] })
    assert.equal(second.ok, true, second.output)
    assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `${base.join('\n')}\n`, 'the working tree is clean again')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('/diff review walks hunks, keeps one and reverts another', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'vallen-diff-cmd-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    const file = join(repo, 'app.txt')
    writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    writeFileSync(file, 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n')

    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: repo } }, getSessionId: () => 'd' } }
    const started = await core.handleCommand(ctx, '/diff review')
    assert.match(started.response, /Hunk 1\/2/)

    const kept = await core.handleCommand(ctx, '/diff keep')
    assert.match(kept.response, /Kept hunk 1/)
    assert.match(kept.response, /Hunk 2\/2/)

    const skipped = await core.handleCommand(ctx, '/diff skip')
    assert.match(skipped.response, /Reverted hunk 2/)
    assert.equal(readFileSync(file, 'utf8'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')

    const done = await core.handleCommand(ctx, '/diff done')
    assert.match(done.response, /kept 1 · skipped 1 of 2/)
    assert.match((await core.handleCommand(ctx, '/diff next')).response, /No diff review running/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
