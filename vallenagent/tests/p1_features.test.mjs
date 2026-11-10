import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatCodeSearch, searchWorkspace } from '../dist/core/code_search.js'
import { copyToClipboard, encodeOsc52, formatCopyResult } from '../dist/core/clipboard.js'

const core = await import('../dist/index.js')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vallen-p1-${label}-`))
}

test('codesearch finds matches with context and skips heavy/binary files', () => {
  const dir = tempDir('search')
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'src', 'app.ts'), 'const a = 1\nfunction login() {\n  return "auth token"\n}\n')
    writeFileSync(join(dir, 'src', 'notes.md'), 'no match here\n')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'function login() {}\n')
    writeFileSync(join(dir, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3]))

    const result = searchWorkspace({ cwd: dir, query: 'login' })
    assert.equal(result.hits.length, 1, 'only the real source file matches')
    const hit = result.hits[0]
    assert.equal(hit.path, join('src', 'app.ts'))
    assert.equal(hit.line, 2)
    assert.match(hit.text, /function login/)
    assert.deepEqual(hit.before, ['const a = 1'])
    assert.match(hit.after[0], /return "auth token"/)

    const text = formatCodeSearch(result)
    assert.match(text, /1 match\(es\) for "login"/)
    assert.match(text, /src\/app\.ts|src\\app\.ts/)
    assert.match(text, /2│ function login/)

    assert.match(formatCodeSearch(searchWorkspace({ cwd: dir, query: 'zzz-not-there' })), /No matches/)
    assert.match(formatCodeSearch(searchWorkspace({ cwd: dir, query: '' })), /query is required/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codesearch respects the limit and marks truncation', () => {
  const dir = tempDir('limit')
  try {
    writeFileSync(join(dir, 'many.txt'), Array.from({ length: 20 }, () => 'needle').join('\n'))
    const result = searchWorkspace({ cwd: dir, query: 'needle', limit: 5 })
    assert.equal(result.hits.length, 5)
    assert.equal(result.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/codesearch and /effort behave through the shared command handler', async () => {
  const dir = tempDir('cmd')
  const home = tempDir('home')
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    writeFileSync(join(dir, 'a.ts'), 'export function handler() {}\n')
    const agent = { config: { providers: { active: 'x', x: { base_url: 'http://127.0.0.1:1/v1', model: 'm', enabled: true } }, terminal: { cwd: dir } } }
    const ctx = { channel: 'terminal', agent }

    const search = await core.handleCommand(ctx, '/codesearch handler')
    assert.match(search.response, /1 match\(es\) for "handler"/)

    const status = await core.handleCommand(ctx, '/effort')
    assert.match(status.response, /provider default/)

    const set = await core.handleCommand(ctx, '/effort high')
    assert.match(set.response, /set to high/)
    assert.equal(agent.config.reasoning_effort, 'high')

    const bad = await core.handleCommand(ctx, '/effort ultra')
    assert.match(bad.response, /Usage: \/effort/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('clipboard prefers the platform tool and falls back to OSC 52', () => {
  const attempts = []
  const written = []
  const run = (command, args, input) => { attempts.push({ command, input }); return command === 'pbcopy' }

  const mac = copyToClipboard('hello', { platform: 'darwin', run, write: text => written.push(text) })
  assert.equal(mac.method, 'pbcopy')
  assert.equal(attempts[0].input, 'hello')

  const linux = copyToClipboard('hello', { platform: 'linux', env: {}, run: () => false, write: text => written.push(text) })
  assert.equal(linux.method, 'osc52')
  assert.ok(written.length > 0)
  assert.match(written[0], /\u001b\]52;c;/)

  const encoded = encodeOsc52('abc')
  assert.equal(encoded, '\u001b]52;c;YWJj\u0007')

  assert.match(formatCopyResult({ ok: true, method: 'osc52' }, 5), /OSC 52/)
  assert.match(formatCopyResult({ ok: false, method: 'none', error: 'nope' }, 0), /Copy failed: nope/)
  assert.equal(copyToClipboard('', {}).ok, false)
})

test('the effort level reaches the provider request payload', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-p1-effort-'))
  const oldHome = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })

  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'mock'
  config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }
  config.reasoning_effort = 'low'

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  let captured = null
  agent.provider.chat = async payload => {
    captured = payload
    return {
      id: 'c', model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }
  }

  await agent.runTurn({ message: 'hello', surfaceId: 'test' }, {})
  assert.ok(captured, 'the provider was called')
  assert.equal(captured.reasoning_effort, 'low', 'the configured effort is sent with the request')
})
