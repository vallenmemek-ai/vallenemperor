import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectWorkingDiff, formatDiffSummary, isGitRepository } from '../dist/core/working_diff.js'

function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'vallen-gitdiff-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
  writeFileSync(join(repo, 'tracked.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  return repo
}

test('working mode reports modified and untracked files', t => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'new-file.txt'), 'brand new\n')

  const result = collectWorkingDiff({ cwd: repo, mode: 'working' })
  assert.equal(result.ok, true)
  const paths = result.files.map(file => file.path).sort()
  assert.deepEqual(paths, ['new-file.txt', 'tracked.txt'])
  const untracked = result.files.find(file => file.path === 'new-file.txt')
  assert.equal(untracked.status, 'untracked')
  assert.match(untracked.diff, /brand new/)
  assert.match(result.text, /two/)

  const summary = formatDiffSummary(result)
  assert.match(summary, /2 file\(s\) · mode: working/)
  assert.match(summary, /untracked/)
})

test('staged mode only shows staged changes, all mode shows everything since HEAD', t => {
  const repo = makeRepo(t)
  writeFileSync(join(repo, 'tracked.txt'), 'staged change\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  writeFileSync(join(repo, 'later.txt'), 'unstaged\n')

  const staged = collectWorkingDiff({ cwd: repo, mode: 'staged' })
  assert.deepEqual(staged.files.map(file => file.path), ['tracked.txt'])

  const working = collectWorkingDiff({ cwd: repo, mode: 'working' })
  assert.ok(working.files.some(file => file.path === 'later.txt'), 'untracked files appear in working mode')

  const all = collectWorkingDiff({ cwd: repo, mode: 'all' })
  assert.ok(all.files.some(file => file.path === 'tracked.txt'))
})

test('a non-git directory fails cleanly', t => {
  const plain = mkdtempSync(join(tmpdir(), 'vallen-gitdiff-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  assert.equal(isGitRepository(plain), false)
  const result = collectWorkingDiff({ cwd: plain, mode: 'working' })
  assert.equal(result.ok, false)
  assert.match(result.error, /not a git repository/)
  assert.match(formatDiffSummary(result), /git diff failed/)
})
