import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startBackgroundProcess, manageProcess } from '../dist/core/process_manager.js'

const cwd = process.cwd()
// `sleep` does not exist on Windows, so every long-running process here is a
// node script instead. Quoted so a space in process.execPath still works.
const sleepDir = mkdtempSync(join(tmpdir(), 'vallen-sleeper-'))
const sleepScript = join(sleepDir, 'sleeper.mjs')
writeFileSync(sleepScript, 'setTimeout(() => {}, 30000)\n')
const LONG_RUNNING = `"${process.execPath}" "${sleepScript}"`

test('a background process from another session is visible, not silently hidden', async () => {
  const started = startBackgroundProcess(LONG_RUNNING, cwd, 'session-a')
  assert.ok(started.session_id, JSON.stringify(started))

  const listed = await manageProcess({ action: 'list' }, 'session-b')
  const found = listed.processes.find(entry => entry.session_id === started.session_id)
  assert.ok(found, 'session B must see session A processes')
  assert.equal(found.owner, 'session-a')
  assert.equal(found.owned, false)

  await manageProcess({ action: 'kill', session_id: started.session_id, confirm: true }, 'session-b')
})

test('killing another session process requires explicit confirmation', async () => {
  const started = startBackgroundProcess(LONG_RUNNING, cwd, 'session-a')

  const refused = await manageProcess({ action: 'kill', session_id: started.session_id }, 'session-b')
  assert.match(String(refused.error), /belongs to session session-a/)
  assert.equal(refused.requires_confirmation, true)

  const stillRunning = await manageProcess({ action: 'poll', session_id: started.session_id }, 'session-b')
  assert.equal(stillRunning.running, true, 'a refused kill must not stop the process')

  const killed = await manageProcess({ action: 'kill', session_id: started.session_id, confirm: true }, 'session-b')
  assert.equal(killed.success, true)
  const after = await manageProcess({ action: 'wait', session_id: started.session_id, timeout: 5 }, 'session-b')
  assert.equal(after.running, false, 'SIGTERM must actually stop the process')
})

test('a session still polls, waits for, and kills its own processes', async () => {
  const started = startBackgroundProcess(LONG_RUNNING, cwd, 'session-own')

  const polled = await manageProcess({ action: 'poll', session_id: started.session_id }, 'session-own')
  assert.equal(polled.running, true)
  assert.equal(polled.owned, true)

  const waited = await manageProcess({ action: 'wait', session_id: started.session_id, timeout: 0 }, 'session-own')
  assert.equal(waited.running, true)

  const killed = await manageProcess({ action: 'kill', session_id: started.session_id }, 'session-own')
  assert.equal(killed.success, true)
  const after = await manageProcess({ action: 'wait', session_id: started.session_id, timeout: 5 }, 'session-own')
  assert.equal(after.running, false)
})

test('an unknown process id is reported clearly', async () => {
  const result = await manageProcess({ action: 'poll', session_id: 'nope' }, 'session-own')
  assert.match(String(result.error), /Unknown process session_id/)
})
