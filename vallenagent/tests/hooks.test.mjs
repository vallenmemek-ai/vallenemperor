import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blockedBy, formatHookOutcomes, runHooks } from '../dist/core/hooks.js'

const core = await import('../dist/index.js')

test('hooks receive a JSON payload and honour a block decision', () => {
  const seen = []
  const runner = (command, input) => {
    seen.push({ command, payload: JSON.parse(input) })
    if (command === 'deny') return { stdout: JSON.stringify({ decision: 'block', reason: 'no writes to secrets' }), status: 0 }
    return { stdout: '', status: 0 }
  }

  const outcomes = runHooks({
    event: 'pre_tool',
    hooks: { pre_tool: [{ command: 'deny' }, { command: 'observe' }] },
    payload: { tool: 'write_file', args: { path: '/tmp/x' }, sessionId: 's1' },
    runner
  })

  assert.equal(seen.length, 2)
  assert.equal(seen[0].payload.event, 'pre_tool')
  assert.equal(seen[0].payload.tool, 'write_file')
  assert.equal(seen[0].payload.sessionId, 's1')
  assert.equal(outcomes[0].status, 'blocked')
  assert.match(outcomes[0].reason, /no writes to secrets/)
  assert.equal(outcomes[1].status, 'ok')
  assert.match(formatHookOutcomes(outcomes), /blocked\s+pre_tool\s+deny/)
})

test('matchers filter by tool name and non-zero exits are reported, not thrown', () => {
  let calls = 0
  const outcomes = runHooks({
    event: 'pre_tool',
    hooks: { pre_tool: [{ command: 'only-patch', matcher: '^patch$' }, { command: 'boom' }] },
    payload: { tool: 'read_file' },
    runner: () => { calls++; return { stdout: '', stderr: 'nope', status: 1 } }
  })
  assert.equal(calls, 1, 'the matcher skipped the patch-only hook')
  assert.equal(outcomes[0].status, 'failed')
  assert.match(outcomes[0].output, /nope/)
})

test('a timed-out hook is reported as timeout and never blocks', () => {
  const outcomes = runHooks({
    event: 'pre_tool',
    hooks: { pre_tool: [{ command: 'slow', timeout_ms: 1000 }] },
    payload: { tool: 'terminal' },
    runner: () => ({ stdout: '', status: null, signal: 'SIGTERM' })
  })
  assert.equal(outcomes[0].status, 'timeout')
  assert.equal(blockedBy(outcomes), null)
})

test('no hooks configured means no work', () => {
  assert.deepEqual(runHooks({ event: 'turn_end', payload: {} }), [])
  assert.equal(blockedBy([]), null)
})

test('a real pre_tool hook blocks the tool before it runs', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-hooks-'))
  const work = mkdtempSync(join(tmpdir(), 'vallen-hooks-work-'))
  const oldHome = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'mock'
  config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }
  config.terminal = { cwd: work }
  config.hooks = {
    pre_tool: [{
      command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);if(p.tool==='write_file'){console.log(JSON.stringify({decision:'block',reason:'hook says no'}))}else{console.log('{}')}})"`,
      matcher: '^write_file$'
    }]
  }

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  let calls = 0
  agent.provider.chat = async () => {
    calls++
    if (calls === 1) {
      return {
        id: 'c1', model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(work, 'x.txt'), content: 'nope' }) } }]
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }
    }
    return { id: 'c2', model: 'mock-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'blocked, stopped' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
  }

  const result = await agent.runTurn({ message: 'write x.txt', surfaceId: 'test' }, {})
  assert.equal(result.response, 'blocked, stopped')
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(work, 'x.txt')), false, 'the blocked tool never ran')
})
