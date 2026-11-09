import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { nextCronRun, CronStore, CronScheduler } from '../dist/core/cron_scheduler.js'

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-cron-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new CronStore(join(dir, 'cron', 'jobs.json'))
}

const UTC = 'UTC'
const at = iso => new Date(iso)

test('nextCronRun fires on the next matching minute', () => {
  const next = nextCronRun('30 14 * * *', UTC, at('2026-11-08T14:00:00Z'))
  assert.equal(next.toISOString(), '2026-11-08T14:30:00.000Z')
})

test('nextCronRun rolls to the next day when the time already passed', () => {
  const next = nextCronRun('30 14 * * *', UTC, at('2026-11-08T14:30:00Z'))
  assert.equal(next.toISOString(), '2026-11-09T14:30:00.000Z')
})

test('nextCronRun supports step values and ranges', () => {
  const every15 = nextCronRun('*/15 * * * *', UTC, at('2026-11-08T10:07:00Z'))
  assert.equal(every15.toISOString(), '2026-11-08T10:15:00.000Z')
  const window = nextCronRun('0 9-11 * * *', UTC, at('2026-11-08T10:30:00Z'))
  assert.equal(window.toISOString(), '2026-11-08T11:00:00.000Z')
})

test('nextCronRun matches day-of-week and accepts 7 as Sunday', () => {
  // 2026-11-08 is a Sunday.
  const sunday = nextCronRun('0 8 * * 0', UTC, at('2026-11-08T07:00:00Z'))
  assert.equal(sunday.toISOString(), '2026-11-08T08:00:00.000Z')
  const sundayAsSeven = nextCronRun('0 8 * * 7', UTC, at('2026-11-08T07:00:00Z'))
  assert.equal(sundayAsSeven.toISOString(), '2026-11-08T08:00:00.000Z')
})

test('nextCronRun respects the requested timezone', () => {
  const jakarta = nextCronRun('0 9 * * *', 'Asia/Jakarta', at('2026-11-08T00:00:00Z'))
  assert.equal(jakarta.toISOString(), '2026-11-08T02:00:00.000Z', '09:00 WIB is 02:00 UTC')
})

test('nextCronRun rejects malformed expressions and timezones', () => {
  assert.throws(() => nextCronRun('* * * *', UTC), /five fields/)
  assert.throws(() => nextCronRun('61 * * * *', UTC), /Invalid cron minute/)
  assert.throws(() => nextCronRun('* * * * 9', UTC), /Invalid cron day-of-week/)
  assert.throws(() => nextCronRun('*/0 * * * *', UTC), /Invalid cron minute/)
  assert.throws(() => nextCronRun('* * * * *', 'Not/AZone'), /Invalid timezone/)
})

test('CronStore.add validates input and computes the next run', async t => {
  const store = tempStore(t)
  const now = at('2026-11-08T10:00:00Z')
  const job = await store.add({ name: 'digest', prompt: 'summarize news', cron: '0 11 * * *', timezone: UTC, delivery: 'local' }, now)
  assert.equal(job.name, 'digest')
  assert.equal(job.enabled, true)
  assert.equal(job.nextRunAt, '2026-11-08T11:00:00.000Z')

  await assert.rejects(store.add({ name: '', prompt: 'x', cron: '0 11 * * *', timezone: UTC, delivery: 'local' }), /Job name/)
  await assert.rejects(store.add({ name: 'a', prompt: '', cron: '0 11 * * *', timezone: UTC, delivery: 'local' }), /Job prompt/)
  await assert.rejects(store.add({ name: 'a', prompt: 'x', cron: '0 11 * * *', timezone: UTC, delivery: 'carrier-pigeon' }), /Invalid delivery/)
  await assert.rejects(store.add({ name: 'a', prompt: 'x', cron: '0 11 * * *', timezone: UTC, delivery: 'local', ownerId: 0 }), /Invalid scheduled job owner/)
})

test('CronStore persists jobs across instances and removes them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-cron-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'cron', 'jobs.json')

  const first = new CronStore(path)
  const job = await first.add({ name: 'persist', prompt: 'do work', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:01:00Z'))

  const second = new CronStore(path)
  const jobs = await second.list()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, job.id)

  assert.equal(await second.remove(job.id), true)
  assert.deepEqual(await new CronStore(path).list(), [])
  assert.equal(await second.remove('nope'), false)
})

test('CronStore.claimDue hands out a job once and advances its schedule', async t => {
  const store = tempStore(t)
  const job = await store.add({ name: 'tick', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))

  const claimed = await store.claimDue(at('2026-11-08T10:05:00Z'))
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].id, job.id)
  assert.equal(claimed[0].nextRunAt, '2026-11-08T10:10:00.000Z', 'schedule moved forward on claim')

  const again = await store.claimDue(at('2026-11-08T10:06:00Z'))
  assert.deepEqual(again, [], 'a claimed job is not handed out twice')
})

test('CronStore.complete records run history with the given status', async t => {
  const store = tempStore(t)
  const job = await store.add({ name: 'log', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  await store.complete(job, { status: 'succeeded', detail: 'ok' }, at('2026-11-08T10:05:00Z'))

  const history = await store.history()
  assert.equal(history.length, 1)
  assert.equal(history[0].jobId, job.id)
  assert.equal(history[0].status, 'succeeded')
  assert.equal(history[0].detail, 'ok')
})

test('CronScheduler.runDue executes, delivers and marks success', async t => {
  const store = tempStore(t)
  const job = await store.add({ name: 'run', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  const calls = []
  const scheduler = new CronScheduler(store, {
    authorize: async () => { calls.push('authorize'); return true },
    execute: async () => { calls.push('execute'); return 'result text' },
    deliver: async (j, result) => { calls.push(`deliver:${result}`) }
  })
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))

  assert.deepEqual(calls, ['authorize', 'execute', 'deliver:result text'])
  const history = await store.history()
  assert.equal(history[0].status, 'succeeded')
  assert.equal(history[0].detail, 'result text')
  assert.equal(history[0].jobId, job.id)
})

test('CronScheduler.runDue records a denied job without executing it', async t => {
  const store = tempStore(t)
  await store.add({ name: 'denied', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  let executed = false
  const scheduler = new CronScheduler(store, {
    authorize: async () => false,
    execute: async () => { executed = true; return '' },
    deliver: async () => {}
  })
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))

  assert.equal(executed, false)
  const history = await store.history()
  assert.equal(history[0].status, 'denied')
})

test('CronScheduler.runDue records a failed job when execute throws', async t => {
  const store = tempStore(t)
  await store.add({ name: 'boom', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  const scheduler = new CronScheduler(store, {
    authorize: async () => true,
    execute: async () => { throw new Error('tool exploded') },
    deliver: async () => {}
  })
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))

  const history = await store.history()
  assert.equal(history[0].status, 'failed')
  assert.match(history[0].detail, /tool exploded/)
})

test('CronScheduler.start refuses polling intervals under one second', () => {
  const store = new CronStore(join(tmpdir(), 'never-used-jobs.json'))
  const scheduler = new CronScheduler(store, { authorize: async () => true, execute: async () => '', deliver: async () => {} })
  assert.throws(() => scheduler.start(500), /at least 1000ms/)
  const stop = scheduler.start(60_000)
  assert.equal(typeof stop, 'function')
  stop()
})
