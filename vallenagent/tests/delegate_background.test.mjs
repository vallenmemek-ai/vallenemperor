import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'
import { subagentRegistry } from '../dist/agent/subagent_registry.js'

registerBuiltinTools(false)

function delegate(args, context) {
  const tool = registry.get('delegate_task')
  assert.ok(tool, 'delegate_task must be registered')
  return tool.handler(args, { workingDir: process.cwd(), sessionId: 'delegate-test', toolCallId: 'call_1', ...context })
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

test('background delegation returns immediately and completes through the registry', async () => {
  subagentRegistry.clear()
  const progress = []
  const factory = async (task, onProgress) => {
    progress.push(task.cwd ?? 'no-cwd')
    onProgress?.({ status: 'thinking', message: 'planning' })
    onProgress?.({ status: 'tool_start', message: 'read_file' })
    await new Promise(resolve => setTimeout(resolve, 30))
    return `done: ${task.goal}`
  }

  const result = JSON.parse(await delegate({ tasks: [{ goal: 'inspect the CLI', background: true }] }, { delegateAgentFactory: factory }))
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].status, 'running')
  assert.equal(result.results[0].workspace, 'inherit')
  const id = result.results[0].id
  assert.ok(id)

  assert.equal(subagentRegistry.get(id).status, 'running')
  assert.equal(await waitFor(() => subagentRegistry.get(id).status === 'completed'), true)
  const run = subagentRegistry.get(id)
  assert.equal(run.summary, 'done: inspect the CLI')
  assert.deepEqual(run.progress.map(entry => entry.status), ['thinking', 'tool_start'])
  assert.deepEqual(progress, ['no-cwd'])
  subagentRegistry.clear()
})

test('a background run can be cancelled and interrupts the underlying subagent', async () => {
  subagentRegistry.clear()
  let interrupted = false
  const factory = async (task, onProgress, onHandle) => {
    onHandle?.({ interrupt: () => { interrupted = true } })
    await new Promise(resolve => setTimeout(resolve, 5000))
    return 'never'
  }

  const result = JSON.parse(await delegate({ tasks: [{ goal: 'long job', background: true }] }, { delegateAgentFactory: factory }))
  const id = result.results[0].id
  assert.equal(await waitFor(() => typeof subagentRegistry.get(id).cancel === 'function'), true)

  assert.equal(subagentRegistry.cancel(id), true)
  assert.equal(interrupted, true)
  assert.equal(subagentRegistry.get(id).status, 'cancelled')
  subagentRegistry.clear()
})

test('foreground delegation keeps the synchronous contract', async () => {
  subagentRegistry.clear()
  const factory = async task => `sync: ${task.goal}`
  const result = JSON.parse(await delegate({ tasks: [{ goal: 'quick job' }] }, { delegateAgentFactory: factory }))
  assert.deepEqual(result.results, [{ goal: 'quick job', summary: 'sync: quick job' }])
  assert.equal(subagentRegistry.list().length, 0, 'foreground runs are not registered')
})

test('branch workspace creates a worktree and refuses outside a git repo', async () => {
  subagentRegistry.clear()
  const home = mkdtempSync(join(tmpdir(), 'vallen-delegate-home-'))
  const plain = mkdtempSync(join(tmpdir(), 'vallen-delegate-plain-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const result = JSON.parse(await delegate(
      { tasks: [{ goal: 'branch job', background: true, workspace: 'branch' }] },
      { workingDir: plain, delegateAgentFactory: async () => 'ok' }
    ))
    assert.equal(result.results[0].status, undefined)
    assert.match(result.results[0].error, /requires a git repository/)
    assert.equal(subagentRegistry.get(result.results[0].id).status, 'failed')
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
    subagentRegistry.clear()
  }
})
