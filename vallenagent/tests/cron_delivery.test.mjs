import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CronStore } from '../dist/core/cron_scheduler.js'

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-cron-delivery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new CronStore(join(dir, 'cron', 'jobs.json'))
}

test('a job without an owner is a local job and can be stored', async t => {
  const store = tempStore(t)
  const job = await store.add({ name: 'nightly', prompt: '/status', cron: '0 9 * * *', timezone: 'UTC', delivery: 'local' })
  assert.equal(job.delivery, 'local')
  assert.equal(job.ownerId, undefined)
  const listed = await store.list()
  assert.equal(listed.length, 1)
})

test('whatsapp delivery is rejected because no adapter exists', async t => {
  const store = tempStore(t)
  await assert.rejects(
    store.add({ name: 'wa job', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC', delivery: 'whatsapp' }),
    /WhatsApp has no adapter/
  )
})

test('telegram delivery still works for an owned job', async t => {
  const store = tempStore(t)
  const job = await store.add({ name: 'tg', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC', delivery: 'telegram', ownerId: 42 })
  assert.equal(job.ownerId, 42)
  assert.deepEqual((await store.list(42)).map(item => item.id), [job.id])
  assert.deepEqual(await store.list(7), [], 'another owner must not see it')
})
