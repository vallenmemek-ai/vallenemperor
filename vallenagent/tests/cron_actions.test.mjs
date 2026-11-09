import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CronStore, CronScheduler } from '../dist/core/cron_scheduler.js'
import { createCronActions } from '../dist/gateway/cron_actions.js'

const UTC = 'UTC'
const at = iso => new Date(iso)

function setup(t, { agentFactory, adapter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-cron-actions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logPath = join(dir, 'cron-local.log')
  const store = new CronStore(join(dir, 'cron', 'jobs.json'))
  const actions = createCronActions({
    adapter: adapter ? () => adapter : () => null,
    createAgent: agentFactory,
    localLogPath: () => logPath
  })
  const scheduler = new CronScheduler(store, actions)
  return { store, scheduler, logPath, dir }
}

test('a terminal-created local job actually runs and its result is written to the log', async t => {
  const calls = []
  const { store, scheduler, logPath } = setup(t, {
    agentFactory: () => ({
      chat: async prompt => { calls.push(prompt); return { response: 'local job output' } },
      interrupt: () => {}
    })
  })
  await store.add({ name: 'nightly', prompt: 'say hi', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))

  assert.deepEqual(calls, ['say hi'])
  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /nightly/)
  assert.match(log, /local job output/)
  assert.equal((await store.history())[0].status, 'succeeded')
})

test('a scheduled slash command runs the command instead of asking the model', async t => {
  const calls = []
  const { store, scheduler } = setup(t, {
    agentFactory: () => ({
      chat: async prompt => { calls.push(prompt); return { response: 'MODEL' } },
      interrupt: () => {}
    })
  })
  await store.add({ name: 'help job', prompt: '/help', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))

  assert.deepEqual(calls, [], 'the model must not be asked about a slash command')
  assert.equal((await store.history())[0].status, 'succeeded')
})

test('a local job denies risky tools because there is nobody to approve them', async t => {
  const decisions = []
  const { store, scheduler } = setup(t, {
    agentFactory: () => ({
      chat: async (_prompt, callbacks) => {
        decisions.push(await callbacks.onBeforeTool({ name: 'terminal', args: { command: 'rm -rf /tmp/x' } }))
        return { response: 'done' }
      },
      interrupt: () => {}
    })
  })
  await store.add({ name: 'risky', prompt: 'clean up', cron: '*/5 * * * *', timezone: UTC, delivery: 'local' }, at('2026-11-08T10:00:00Z'))
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))
  assert.deepEqual(decisions, [false])
})

test('a telegram job is refused when the owner is not on the allowlist', async t => {
  const { store, scheduler } = setup(t, {
    adapter: {
      approve: async () => { throw new Error('must not prompt a non-allowlisted owner') },
      finish: async () => { throw new Error('must not deliver to a non-allowlisted owner') }
    }
  })
  await store.add({ name: 'tg', prompt: 'p', cron: '*/5 * * * *', timezone: UTC, delivery: 'telegram', ownerId: 999 }, at('2026-11-08T10:00:00Z'))
  await scheduler.runDue(at('2026-11-08T10:05:00Z'))
  assert.equal((await store.history())[0].status, 'denied')
})
