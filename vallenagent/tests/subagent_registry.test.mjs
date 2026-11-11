import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SubagentRegistry, formatSubagentDetail, formatSubagentLine, isTerminalStatus, subagentRegistry } from '../dist/agent/subagent_registry.js'
import { createSubagentWorktree, isGitRepo, listWorktrees, removeSubagentWorktree } from '../dist/agent/worktree.js'

test('registry tracks the full lifecycle of a run', () => {
  const registry = new SubagentRegistry()
  const run = registry.create({ goal: 'research the repo', workspace: 'branch' })

  assert.equal(run.status, 'queued')
  assert.equal(run.workspace, 'branch')
  assert.equal(registry.activeCount(), 1)
  assert.equal(isTerminalStatus(run.status), false)

  registry.markRunning(run.id)
  registry.update(run.id, 'tool_start', 'grep for handlers')
  assert.equal(registry.get(run.id).status, 'running')
  assert.equal(registry.get(run.id).progress.length, 1)

  registry.complete(run.id, 'found 3 handlers')
  const done = registry.get(run.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.summary, 'found 3 handlers')
  assert.ok(done.finishedAt)
  assert.equal(registry.activeCount(), 0)
})

test('registry enforces the concurrency cap and supports cancellation', () => {
  const registry = new SubagentRegistry({ maxConcurrent: 2 })
  const first = registry.create({ goal: 'one' })
  assert.equal(registry.canStart(), true, 'one queued run leaves a free slot')
  const second = registry.create({ goal: 'two' })
  registry.markRunning(first.id)
  registry.markRunning(second.id)
  assert.equal(registry.canStart(), false, 'two active runs fill the cap')

  let cancelled = false
  registry.get(first.id).cancel = () => { cancelled = true }
  assert.equal(registry.cancel(first.id), true)
  assert.equal(cancelled, true, 'cancel must call the wired abort handler')
  assert.equal(registry.get(first.id).status, 'cancelled')
  assert.equal(registry.cancel(first.id), false, 'cancelling twice is a no-op')
  assert.equal(registry.cancel('missing'), false)
})

test('progress updates after a terminal state are ignored', () => {
  const registry = new SubagentRegistry()
  const run = registry.create({ goal: 'x' })
  registry.fail(run.id, 'boom')
  registry.update(run.id, 'tool_start', 'late event')
  assert.equal(registry.get(run.id).progress.length, 0)
  assert.equal(registry.get(run.id).status, 'failed')
})

test('prune keeps the newest finished runs only', () => {
  const registry = new SubagentRegistry({ keepFinished: 2 })
  for (let i = 0; i < 5; i++) {
    const run = registry.create({ goal: `run ${i}` })
    registry.complete(run.id, 'ok')
  }
  assert.equal(registry.list().length, 2, 'finishing a run prunes beyond keepFinished')
  assert.deepEqual(registry.prune(), [], 'nothing left to prune')
  const newest = registry.list().map(run => run.goal)
  assert.deepEqual(newest, ['run 3', 'run 4'], 'the newest finished runs are kept')
})

test('formatting a run is stable and readable', () => {
  const registry = new SubagentRegistry()
  const run = registry.create({ goal: 'audit the CLI', workspace: 'inherit' })
  registry.markRunning(run.id)
  const line = formatSubagentLine(run, Date.parse(run.startedAt) + 5000)
  assert.match(line, /● /)
  assert.match(line, /running/)
  assert.match(line, /5s/)
  assert.match(line, /audit the CLI/)

  const detail = formatSubagentDetail(run)
  assert.match(detail, /Subagent sa-/)
  assert.match(detail, /status   : running/)
  assert.match(detail, /goal     : audit the CLI/)
})

test('the shared registry is a singleton so the tool and the panel agree', () => {
  const run = subagentRegistry.create({ goal: 'singleton check' })
  assert.equal(subagentRegistry.get(run.id).goal, 'singleton check')
  subagentRegistry.clear()
})

function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'vallen-wt-repo-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  return repo
}

test('a branch worktree is created outside the repo and removed cleanly', t => {
  const repo = makeRepo(t)
  const home = mkdtempSync(join(tmpdir(), 'vallen-wt-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  assert.equal(isGitRepo(repo), true)
  const info = createSubagentWorktree({ repo, home, id: 'sa-1' })

  assert.equal(existsSync(info.path), true)
  assert.ok(info.path.startsWith(home), 'worktrees live under the home dir, not the repo')
  assert.equal(existsSync(join(info.path, 'README.md')), true, 'the worktree has a checkout')
  assert.equal(info.branch, 'vallen/subagent-sa-1')
  assert.ok(listWorktrees(repo).map(path => realpathSync(path)).includes(realpathSync(info.path)), 'git reports the resolved path')

  removeSubagentWorktree(info)
  assert.equal(existsSync(info.path), false)
  assert.equal(listWorktrees(repo).includes(info.path), false)
})

test('branch workspaces are refused outside a git repository', t => {
  const plain = mkdtempSync(join(tmpdir(), 'vallen-wt-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  const home = mkdtempSync(join(tmpdir(), 'vallen-wt-home2-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  assert.equal(isGitRepo(plain), false)
  assert.throws(() => createSubagentWorktree({ repo: plain, home, id: 'sa-2' }), /requires a git repository/)
  assert.throws(() => createSubagentWorktree({ repo: plain, home, id: '../escape' }), /Invalid worktree id/)
})
