import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  formatPendingList,
  listPendingWrites,
  readPendingWrite,
  removePendingWrite,
  stagePendingWrite
} from '../dist/core/pending_writes.js'

const core = await import('../dist/index.js')

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'vallen-pending-'))
}

test('a staged write is recorded, listed, readable and removable', () => {
  const home = tempHome()
  try {
    const record = stagePendingWrite(home, { subsystem: 'memory', kind: 'memory', action: 'add', content: 'user prefers tabs' })
    assert.match(record.id, /^memory-/)
    assert.equal(record.createdAt.length > 0, true)

    const list = listPendingWrites(home, 'memory')
    assert.equal(list.length, 1)
    assert.equal(list[0].content, 'user prefers tabs')

    const read = readPendingWrite(home, record.id)
    assert.equal(read.action, 'add')

    assert.match(formatPendingList(list), /1 pending write/)
    assert.match(formatPendingList([]), /No pending writes/)

    assert.equal(removePendingWrite(home, record.id), true)
    assert.equal(listPendingWrites(home).length, 0)
    assert.equal(removePendingWrite(home, 'missing'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the memory tool stages instead of writing when write_approval.memory is on', async () => {
  const home = tempHome()
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      providers: { active: 'x', x: { base_url: 'http://127.0.0.1:1/v1', model: 'm', enabled: true } },
      write_approval: { memory: true }
    }))

    const { registry } = await import('../dist/tools/tools.js')
    const { registerBuiltinTools } = await import('../dist/tools/builtin_tools.js')
    registerBuiltinTools(false)

    const tool = registry.get('memory')
    const result = JSON.parse(await tool.handler({ action: 'add', target: 'memory', content: 'staged fact' }, { sessionId: 'pending-test' }))
    assert.equal(result.staged, true)
    assert.ok(result.id)
    assert.match(result.note, /Approve with \/memory approve/)

    const pending = listPendingWrites(home, 'memory')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].content, 'staged fact')
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/memory pending, approve and reject work end to end', async () => {
  const home = tempHome()
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const record = stagePendingWrite(home, { subsystem: 'memory', kind: 'memory', action: 'add', content: 'approved fact' })
    const rejected = stagePendingWrite(home, { subsystem: 'memory', kind: 'memory', action: 'add', content: 'rejected fact' })

    const ctx = { channel: 'terminal', agent: { memoryStore: new core.MemoryStore(join(home, 'memories')) } }

    const pending = await core.handleCommand(ctx, '/memory pending')
    assert.match(pending.response, /2 pending write\(s\)/)

    const approve = await core.handleCommand(ctx, `/memory approve ${record.id}`)
    assert.match(approve.response, /disetujui dan diterapkan/)
    assert.equal(readPendingWrite(home, record.id), null)

    const reject = await core.handleCommand(ctx, `/memory reject ${rejected.id}`)
    assert.match(reject.response, /ditolak dan dihapus/)
    assert.equal(readPendingWrite(home, rejected.id), null)

    const missing = await core.handleCommand(ctx, '/memory approve nope')
    assert.match(missing.response, /Tidak ada pending memory nope/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the review fork reuses the parent provider instance', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-pending-provider-'))
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

  const parentProvider = {
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'mock-model',
    chat: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'No updates needed' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions'), provider: parentProvider })
  t.after(() => agent.shutdown())

  assert.equal(agent.provider, parentProvider, 'the injected provider is used instead of a new one')
})
