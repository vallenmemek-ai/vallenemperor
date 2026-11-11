import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CronStore } from '../dist/core/cron_scheduler.js'

const UTC = 'UTC'
const at = iso => new Date(iso)

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-cron-life-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new CronStore(join(dir, 'cron', 'jobs.json'))
}

const base = { name: 'nightly', prompt: 'say hi', cron: '0 9 * * *', timezone: UTC, delivery: 'local' }

test('update edits a job and recomputes the next run', async t => {
  const store = tempStore(t)
  const job = await store.add(base, at('2026-11-08T10:00:00Z'))
  const updated = await store.update(job.id, { name: 'morning', cron: '30 7 * * *' }, undefined, at('2026-11-08T10:00:00Z'))
  assert.equal(updated.name, 'morning')
  assert.equal(updated.cron, '30 7 * * *')
  assert.equal(updated.nextRunAt, '2026-11-09T07:30:00.000Z')
  const listed = await store.list()
  assert.equal(listed[0].name, 'morning', 'the change must persist')
})

test('update rejects an invalid cron instead of storing it', async t => {
  const store = tempStore(t)
  const job = await store.add(base, at('2026-11-08T10:00:00Z'))
  await assert.rejects(store.update(job.id, { cron: 'nope' }, undefined, at('2026-11-08T10:00:00Z')), /Cron must contain five fields/)
  assert.equal((await store.list())[0].cron, '0 9 * * *', 'the old value must survive')
})

test('a paused job is never claimed, and resume brings it back', async t => {
  const store = tempStore(t)
  const job = await store.add(base, at('2026-11-08T10:00:00Z'))

  const paused = await store.setEnabled(job.id, false, undefined, at('2026-11-08T10:00:00Z'))
  assert.equal(paused.enabled, false)
  assert.deepEqual(await store.claimDue(at('2026-11-09T09:00:00Z')), [], 'paused jobs must not fire')

  const resumed = await store.setEnabled(job.id, true, undefined, at('2026-11-08T10:00:00Z'))
  assert.equal(resumed.enabled, true)
  assert.equal((await store.claimDue(at('2026-11-09T09:00:00Z'))).length, 1, 'resumed job fires on schedule')
})

test('run fires a job on the next tick without changing its cron', async t => {
  const store = tempStore(t)
  const job = await store.add(base, at('2026-11-08T10:00:00Z'))
  const fired = await store.runNow(job.id, undefined, at('2026-11-08T10:05:00Z'))
  assert.equal(fired.cron, '0 9 * * *')
  assert.equal(fired.nextRunAt, '2026-11-08T10:05:00.000Z')
  const claimed = await store.claimDue(at('2026-11-08T10:05:00Z'))
  assert.equal(claimed.length, 1, 'the forced job is due immediately')
  assert.equal(claimed[0].id, job.id)
})

test('update/pause/run report a missing job instead of throwing', async t => {
  const store = tempStore(t)
  assert.equal(await store.update('nope', { name: 'x' }), null)
  assert.equal(await store.setEnabled('nope', false), null)
  assert.equal(await store.runNow('nope'), null)
})

test('the schedule tool exposes the whole lifecycle', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-cron-tool-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const { registry, registerBuiltinTools } = await import('../dist/tools/index.js')
  registerBuiltinTools()
  const call = async args => JSON.parse(await registry.execute('schedule', args, {}))

  const created = await call({ action: 'add', name: 'tool job', prompt: 'p', cron: '0 9 * * *', timezone: UTC })
  const id = created.job.id

  assert.equal((await call({ action: 'pause', id })).job.enabled, false)
  assert.equal((await call({ action: 'resume', id })).job.enabled, true)
  assert.equal((await call({ action: 'update', id, name: 'renamed' })).job.name, 'renamed')
  assert.equal((await call({ action: 'run', id })).job.id, id)
  assert.equal((await call({ action: 'list' })).total, 1)
  assert.equal((await call({ action: 'remove', id })).removed, true)
  assert.equal((await call({ action: 'list' })).total, 0)

  assert.match((await call({ action: 'pause' })).error, /id is required/)
  assert.match((await call({ action: 'update', id: 'x' })).error, /at least one of/)
})
