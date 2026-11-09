import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'

registerBuiltinTools()

const call = async (name, args, workingDir, extra = {}) => {
  const tool = registry.get(name)
  assert.ok(tool, `${name} must be registered`)
  return JSON.parse(await tool.handler(args, { workingDir, sessionId: 'tool-surface-test', ...extra }))
}

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `vallen-${label}-`))
  return dir
}

test('list_dir is registered and lists directories before files', async () => {
  const dir = tempDir('listdir')
  try {
    mkdirSync(join(dir, 'zeta-dir'))
    mkdirSync(join(dir, 'alpha-dir'))
    writeFileSync(join(dir, 'b.txt'), 'b')
    writeFileSync(join(dir, 'a.txt'), 'a')

    const result = await call('list_dir', { path: dir }, dir)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.entries.map(entry => entry.name), ['alpha-dir', 'zeta-dir', 'a.txt', 'b.txt'])
    assert.equal(result.entries[0].type, 'dir')
    assert.equal(result.entries[3].type, 'file')
    assert.equal(result.entries[3].size, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('list_dir filters by glob and can hide dotfiles', async () => {
  const dir = tempDir('listdir-filter')
  try {
    writeFileSync(join(dir, 'keep.ts'), 'x')
    writeFileSync(join(dir, 'skip.js'), 'x')
    writeFileSync(join(dir, '.hidden'), 'x')

    const filtered = await call('list_dir', { path: dir, pattern: '*.ts' }, dir)
    assert.deepEqual(filtered.entries.map(entry => entry.name), ['keep.ts'])

    const hidden = await call('list_dir', { path: dir, include_hidden: false }, dir)
    assert.equal(hidden.entries.some(entry => entry.name === '.hidden'), false)

    const withHidden = await call('list_dir', { path: dir, include_hidden: true }, dir)
    assert.equal(withHidden.entries.some(entry => entry.name === '.hidden'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('list_dir reports a missing path instead of throwing', async () => {
  const result = await call('list_dir', { path: '/definitely/not/here' }, '/tmp')
  assert.match(String(result.error), /Path not found/)
})

test('typecheck reports a real type error without a shell command', async () => {
  const dir = tempDir('typecheck')
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' },
      include: ['*.ts']
    }))
    writeFileSync(join(dir, 'bad.ts'), 'const value: number = "not a number"\nexport { value }\n')

    const result = await call('typecheck', { path: dir }, dir)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.errors >= 1, JSON.stringify(result))
    assert.equal(result.files_checked, 1)
    assert.ok(result.diagnostics.some(item => item.severity === 'error'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('typecheck passes on a clean file', async () => {
  const dir = tempDir('typecheck-ok')
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' },
      include: ['*.ts']
    }))
    writeFileSync(join(dir, 'good.ts'), 'export const value: number = 42\n')

    const result = await call('typecheck', { path: dir }, dir)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.errors, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('typecheck explains when there is no tsconfig', async () => {
  const dir = tempDir('typecheck-none')
  try {
    writeFileSync(join(dir, 'loose.ts'), 'export const x = 1\n')
    const result = await call('typecheck', { path: dir }, dir)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /tsconfig\.json/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('patch refuses when expected_hash does not match the current file', async () => {
  const dir = tempDir('patch-hash')
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'line1=ALPHA\n')

    const stale = await call('patch', {
      path: file,
      old_string: 'ALPHA',
      new_string: 'BETA',
      expected_hash: 'deadbeef'
    }, dir)
    assert.match(String(stale.error), /expected_hash does not match/)
    assert.equal(stale.actual_hash, createHash('sha256').update('line1=ALPHA\n').digest('hex'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('patch accepts a matching expected_hash (and moves on to the read-first rule)', async () => {
  const dir = tempDir('patch-hash-ok')
  try {
    const file = join(dir, 'a.txt')
    const content = 'line1=ALPHA\n'
    writeFileSync(file, content)

    const result = await call('patch', {
      path: file,
      old_string: 'ALPHA',
      new_string: 'BETA',
      expected_hash: createHash('sha256').update(content).digest('hex')
    }, dir)
    // The hash gate passed, so the next refusal is the unrelated read-first rule.
    assert.match(String(result.error), /read it with read_file first/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('read_file returns a sha256 the agent can feed to patch', async () => {
  const dir = tempDir('read-hash')
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello\n')
    const result = await call('read_file', { path: file }, dir)
    assert.equal(result.sha256, createHash('sha256').update('hello\n').digest('hex'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('patch_batch aborts the whole batch when one expected_hash is stale', async () => {
  const dir = tempDir('batch-hash')
  try {
    const one = join(dir, 'one.txt')
    const two = join(dir, 'two.txt')
    writeFileSync(one, 'value=1\n')
    writeFileSync(two, 'value=2\n')

    const result = await call('patch_batch', {
      files: [
        { path: one, old_string: 'value=1', new_string: 'value=99', expected_hash: createHash('sha256').update('value=1\n').digest('hex') },
        { path: two, old_string: 'value=2', new_string: 'value=98', expected_hash: 'deadbeef' }
      ]
    }, dir)

    assert.match(String(result.error), /expected_hash does not match/)
    // Atomic: the file with a valid hash must be untouched too.
    assert.equal(readFileSync(one, 'utf8'), 'value=1\n')
    assert.equal(readFileSync(two, 'utf8'), 'value=2\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('checkpoint tool lists turns for a session without a shell', async () => {
  const dir = tempDir('checkpoint')
  try {
    const result = await call('checkpoint', { action: 'list' }, dir, { sessionId: 'session-test', checkpointRoot: join(dir, 'checkpoints') })
    assert.equal(result.action, 'list')
    assert.deepEqual(result.turns, [])
    assert.equal(result.session_id, 'session-test')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('checkpoint tool explains when there is no session', async () => {
  const result = await call('checkpoint', { action: 'list' }, '/tmp', { sessionId: undefined })
  assert.match(String(result.error), /needs an active session/)
})

test('checkpoint tool rejects an unknown action', async () => {
  const result = await call('checkpoint', { action: 'nuke' }, '/tmp', { sessionId: 's' })
  assert.match(String(result.error), /action must be one of/)
})

test('schedule tool adds, lists and removes a cron job', async () => {
  const home = tempDir('cron-home')
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const added = await call('schedule', { action: 'add', name: 'nightly', prompt: 'say hi', cron: '0 9 * * *' }, home)
    assert.ok(added.job?.id, JSON.stringify(added))
    assert.equal(added.job.name, 'nightly')

    const listed = await call('schedule', { action: 'list' }, home)
    assert.equal(listed.total, 1)
    assert.equal(listed.jobs[0].id, added.job.id)

    const removed = await call('schedule', { action: 'remove', id: added.job.id }, home)
    assert.equal(removed.removed, true)

    const after = await call('schedule', { action: 'list' }, home)
    assert.equal(after.total, 0)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('schedule tool rejects an invalid cron expression', async () => {
  const home = tempDir('cron-bad')
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const result = await call('schedule', { action: 'add', name: 'bad', prompt: 'x', cron: 'not a cron' }, home)
    assert.match(String(result.error), /Cron/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('tool_search reports backend health for deferred tools', async () => {
  const browser = await call('tool_search', { query: 'browser' }, '/tmp')
  const browserHit = browser.results.find(item => item.name === 'browser_exec')
  assert.ok(browserHit, JSON.stringify(browser))
  assert.ok(['ready', 'degraded', 'unavailable'].includes(browserHit.health.status))
  assert.ok(browserHit.health.detail.length > 0)

  const web = await call('tool_search', { query: 'web search' }, '/tmp')
  const webHit = web.results.find(item => item.name === 'web_search')
  assert.ok(webHit)
  assert.equal(webHit.health.status, 'degraded')
})
