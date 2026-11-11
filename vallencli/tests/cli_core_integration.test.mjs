import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../dist/cli.js'

test('VallenCLI drives real AIAgent.runTurn with deterministic in-process provider', async t => {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallencli-core-'))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })

  const core = await import('../../vallenagent/dist/index.js')
  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = '9router'
  config.providers['9router'] = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }
  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false })
  agent.provider.chat = async () => ({
    id: 'mock-completion',
    model: 'mock-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'real core result' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  })

  const input = new PassThrough()
  input.isTTY = false
  let exitQueued = false
  let captured = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk)
      if (!exitQueued && captured.includes('real core result')) {
        exitQueued = true
        setImmediate(() => input.end('/exit\n'))
      }
      callback()
    }
  })
  output.columns = 80
  output.isTTY = false
  const running = runCli({ input, output, agent, core, healthCheck: async () => [], bannerText: '' })
  input.write('use actual agent\n')
  await running
  assert.match(captured, /real core result/)
  assert.equal(agent.getContextStats().turns, 1)
})
