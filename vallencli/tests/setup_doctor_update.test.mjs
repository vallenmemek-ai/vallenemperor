import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSetup, runSetupCommand, SETUP_PRESETS } from '../src/cli-setup.mjs'
import { doctorExitCode, formatDoctor, runDoctor, runDoctorCommand, FAIL, OK, WARN } from '../src/cli-doctor.mjs'
import { checkForUpdate, formatUpdateNotice, isNewer, maybeNotifyUpdate, runUpdateCommand, updateCheckDisabled } from '../src/cli-update-check.mjs'
import { parseArgs } from '../src/cli.mjs'

function scriptedSetup({ answers, choices, models = ['model-a', 'model-b'], fetchThrows = false }) {
  const printed = []
  let writes = null
  const askQueue = [...answers]
  const choiceQueue = [...choices]
  return {
    printed,
    get writes() { return writes },
    options: {
      ask: async () => askQueue.shift() ?? '',
      choose: async (question, options) => {
        const pick = choiceQueue.shift()
        if (pick === undefined) return options[0]
        const index = Number(pick)
        return Number.isFinite(index) && index > 0 ? options[index - 1] : (options.find(option => option.startsWith(String(pick))) || options[0])
      },
      print: line => printed.push(line),
      fetchModels: async () => {
        if (fetchThrows) throw new Error('offline')
        return models
      },
      writeConfig: patch => { writes = patch }
    }
  }
}

test('setup walks preset → base url → model → approval and writes config', async () => {
  const h = scriptedSetup({ answers: ['', 'gpt-4o-mini', 'sk-test'], choices: ['openai', 'model-b', 'off'] })
  const result = await runSetup(h.options)

  assert.equal(result.provider, 'openai')
  assert.equal(result.base_url, SETUP_PRESETS.openai.base_url)
  assert.equal(result.model, 'model-b')
  assert.equal(result.approval, 'off')
  assert.equal(result.apiKeySet, true)
  assert.equal(h.writes.providers.active, 'openai')
  assert.equal(h.writes.providers.openai.base_url, SETUP_PRESETS.openai.base_url)
  assert.equal(h.writes.approval, 'off')
  assert.ok(h.printed.some(line => /Saved\./.test(line)))
})

test('setup falls back to typing the model when the endpoint is unreachable', async () => {
  const h = scriptedSetup({ answers: ['', 'my-local-model'], choices: ['ollama', 'dangerous'], fetchThrows: true })
  const result = await runSetup(h.options)
  assert.equal(result.model, 'my-local-model')
  assert.ok(h.printed.some(line => /Could not list models/.test(line)))
})

test('setup refuses to run without a TTY and points at the non-interactive path', async () => {
  const lines = []
  const code = await runSetupCommand({
    core: {},
    stdin: { isTTY: false },
    stdout: { isTTY: false, write: line => lines.push(line) }
  })
  assert.equal(code, 2)
  assert.match(lines.join(''), /config set provider/)
})

test('doctor reports failures, warnings and an exit code', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-doctor-'))
  try {
    const checks = await runDoctor({
      home,
      config: { providers: { active: 'x', x: { base_url: 'http://127.0.0.1:1/v1', model: 'm' } } },
      probes: {
        nodeVersion: 'v18.0.0',
        fetchModels: async () => { throw new Error('ECONNREFUSED') },
        isGit: () => true
      }
    })
    const byName = Object.fromEntries(checks.map(item => [item.name, item]))
    assert.equal(byName.node.status, FAIL)
    assert.match(byName.node.fix, /Node 20/)
    assert.equal(byName.endpoint.status, WARN)
    assert.equal(byName.git.status, OK)
    assert.equal(doctorExitCode(checks), 1)

    const text = formatDoctor(checks)
    assert.match(text, /✖ FAIL node/)
    assert.match(text, /1 check\(s\) failed/)

    const json = JSON.parse(formatDoctor(checks, { json: true }))
    assert.equal(json.ok, false)
    assert.ok(Array.isArray(json.checks))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor passes when everything is healthy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-doctor-ok-'))
  mkdirSync(join(home, 'skills'), { recursive: true })
  try {
    const checks = await runDoctor({
      home,
      config: { providers: { active: 'x', x: { base_url: 'http://127.0.0.1:1/v1', model: 'm', api_key: 'k' } } },
      probes: { nodeVersion: 'v20.11.0', fetchModels: async () => ['a', 'b'], isGit: () => true }
    })
    assert.equal(doctorExitCode(checks), 0)
    assert.match(formatDoctor(checks), /All checks passed/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('update check compares versions and caches for a day', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-update-'))
  try {
    assert.equal(isNewer('1.2.0', '1.1.9'), true)
    assert.equal(isNewer('1.1.0', '1.1.0'), false)
    assert.equal(isNewer('1.0.9', '1.1.0'), false)

    let calls = 0
    const fetcher = async () => { calls++; return '9.9.9' }
    const first = await checkForUpdate({ current: '1.0.0', home, fetcher, now: 1000 })
    assert.equal(first.latest, '9.9.9')
    assert.equal(first.checked, true)

    const second = await checkForUpdate({ current: '1.0.0', home, fetcher, now: 2000 })
    assert.equal(second.cached, true)
    assert.equal(calls, 1, 'the cache prevents a second network call')

    const third = await checkForUpdate({ current: '1.0.0', home, fetcher, now: 1000 + 25 * 60 * 60 * 1000 })
    assert.equal(calls, 2, 'a day later it refreshes')

    assert.match(formatUpdateNotice('1.0.0', '9.9.9'), /update available: 1\.0\.0 → 9\.9\.9/)
    assert.equal(formatUpdateNotice('9.9.9', '9.9.9'), null)
    assert.equal(updateCheckDisabled({ VALLENEMPEROR_NO_UPDATE_CHECK: '1' }), true)

    let printed = null
    await maybeNotifyUpdate({ home, current: '1.0.0', fetcher: async () => '9.9.9', print: line => { printed = line } })
    assert.match(String(printed), /update available/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('update command reports and can install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vallen-update-cmd-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const lines = []
    const stdout = { write: line => lines.push(line) }
    let installed = null

    const code = await runUpdateCommand({ root, checkOnly: true, stdout, fetcher: () => '2.0.0' })
    assert.equal(code, 0)
    assert.match(lines.join(''), /Update available: 1\.0\.0 → 2\.0\.0/)

    lines.length = 0
    const code2 = await runUpdateCommand({ root, stdout, fetcher: () => '2.0.0', install: version => { installed = version } })
    assert.equal(code2, 0)
    assert.equal(installed, '2.0.0')

    lines.length = 0
    const code3 = await runUpdateCommand({ root, stdout, fetcher: () => '1.0.0' })
    assert.equal(code3, 0)
    assert.match(lines.join(''), /Already on the latest version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseArgs routes the new subcommands', () => {
  assert.equal(parseArgs(['setup']).mode, 'setup')
  assert.equal(parseArgs(['doctor']).mode, 'doctor')
  assert.equal(parseArgs(['doctor', '--json']).json, true)
  assert.equal(parseArgs(['update']).mode, 'update')
  assert.equal(parseArgs(['update', '--check']).json, true)
  assert.equal(parseArgs(['--version']).mode, 'version')
})
