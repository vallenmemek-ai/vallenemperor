import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildContextReport, findContextFiles } from '../dist/core/context_report.js'

const core = await import('../dist/index.js')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vallen-${label}-`))
}

test('a steer note is delivered after the next tool call', async t => {
  const home = tempDir('steer-home')
  const work = tempDir('steer-work')
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

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  let calls = 0
  let secondRequest = null
  agent.provider.chat = async payload => {
    calls++
    if (calls === 1) {
      return {
        id: 'c1', model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: 't1', content: 'x', status: 'completed' }] }) } }]
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }
    }
    secondRequest = payload
    return { id: 'c2', model: 'mock-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
  }

  assert.equal(agent.steer('focus on the auth module'), true)
  const result = await agent.runTurn({ message: 'do work', surfaceId: 'test' }, {})
  assert.equal(result.response, 'done')
  const steerMessage = secondRequest.messages.find(message => message.role === 'system' && String(message.content).includes('steer from the user'))
  assert.ok(steerMessage, 'the steer note is injected into the next request')
  assert.match(steerMessage.content, /focus on the auth module/)
})

test('context files are discovered up the tree and reported with token estimates', () => {
  const root = tempDir('ctx-root')
  try {
    writeFileSync(join(root, 'AGENTS.md'), '# rules\nbe careful\n')
    const nested = join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'CLAUDE.md'), 'nested rules\n')

    const files = findContextFiles(nested)
    assert.ok(files.some(file => file.path.endsWith('CLAUDE.md')))
    assert.ok(files.some(file => file.path.endsWith('AGENTS.md')), 'walks up to the repo root')

    const report = buildContextReport({
      cwd: nested,
      stats: { promptTokens: 1000, contextWindow: 10000, percent: 10, systemPromptTokens: 400, historyTokens: 500 },
      skills: [{ name: 'deploy', description: 'Deploy the app' }],
      toolSchemas: ['{"name":"read_file"}', '{"name":"write_file"}']
    })
    assert.match(report, /window {3}: 1000 \/ 10000 tokens \(10%\)/)
    assert.match(report, /skills {3}: 1 indexed/)
    assert.match(report, /tools {4}: 2 schemas/)
    assert.match(report, /Context files \(\d+\)/)
    assert.match(report, /AGENTS\.md/)
    assert.match(report, /CLAUDE\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/context all renders the breakdown through the shared handler', async () => {
  const dir = tempDir('ctx-cmd')
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# rules\n')
    const ctx = {
      channel: 'terminal',
      agent: {
        config: { terminal: { cwd: dir }, providers: {} },
        getContextStats: () => ({ promptTokens: 100, contextWindow: 1000, percent: 10, historyTokens: 40, systemPromptTokens: 30, messages: 3, turns: 1, sessionPromptTotal: 100, sessionCompletionTotal: 10, largestToolName: '', largestToolTokens: 0, estimated: false }),
        skillLoader: { list: () => [{ name: 'deploy', metadata: { description: 'Deploy' } }] },
        toolWhitelist: undefined
      }
    }
    const result = await core.handleCommand(ctx, '/context all')
    assert.match(result.response, /Context breakdown/)
    assert.match(result.response, /Context files \(\d+\)/)
    assert.match(result.response, /AGENTS\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
