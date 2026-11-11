import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTurnArtifacts, recordArtifacts, buildArtifactSummary } from '../dist/agent/turn_artifacts.js'

test('a turn that changes two files and creates one reports three paths', () => {
  const state = createTurnArtifacts()
  recordArtifacts(state, 'patch', { path: 'src/a.ts' }, JSON.stringify({ success: true, path: '/repo/src/a.ts' }))
  recordArtifacts(state, 'patch_batch', { files: [{ path: 'src/b.ts' }] }, JSON.stringify({ success: true, files: [{ path: '/repo/src/b.ts' }] }))
  recordArtifacts(state, 'write_file', { path: 'docs/new.md' }, JSON.stringify({ success: true, path: '/repo/docs/new.md', created: true }))
  recordArtifacts(state, 'terminal', { command: 'npm test' }, JSON.stringify({ exit_code: 0, output: '# pass 1' }))

  const summary = buildArtifactSummary(state)
  assert.match(summary, /created: \/repo\/docs\/new\.md/)
  assert.match(summary, /changed: \/repo\/src\/a\.ts, \/repo\/src\/b\.ts/)
  assert.match(summary, /verified: npm test/)
  const paths = summary.match(/\/repo\/[\w./-]+/g) || []
  assert.equal(new Set(paths).size, 3, `expected exactly three paths, got ${paths.join(', ')}`)
})

test('a turn without changes prints no artifact summary', () => {
  const state = createTurnArtifacts()
  recordArtifacts(state, 'read_file', { path: 'src/a.ts' }, JSON.stringify({ content: 'x' }))
  recordArtifacts(state, 'terminal', { command: 'git status' }, JSON.stringify({ exit_code: 0, output: '' }))
  assert.equal(buildArtifactSummary(state), '')
})

test('failed edits and read-only commands are not reported as artifacts', () => {
  const state = createTurnArtifacts()
  recordArtifacts(state, 'patch', { path: 'src/a.ts' }, JSON.stringify({ error: 'old_string not found' }))
  recordArtifacts(state, 'terminal', { command: 'ls' }, JSON.stringify({ exit_code: 0, output: '' }))
  assert.deepEqual(state.changed, [])
  assert.deepEqual(state.verification, [])
})

// ---------- the agent attaches the summary to the turn result ----------

const core = await import('../dist/index.js')

test('runTurn returns the artifact summary for real edits', async t => {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-artifacts-'))
  const workdir = mkdtempSync(join(tmpdir(), 'vallenemperor-artifacts-work-'))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  })
  mkdirSync(join(workdir, 'tests'), { recursive: true })

  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'mock'
  config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }
  config.terminal = { cwd: workdir }

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  let call = 0
  agent.provider.chat = async () => {
    call++
    if (call === 1) {
      return {
        id: 'c1',
        model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'tests/x.test.mjs', content: "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n" }) } }
            ]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    }
    if (call === 2) {
      return {
        id: 'c2',
        model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'node --test tests/x.test.mjs' }) } }]
          }
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      }
    }
    return {
      id: 'c3',
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'test added and run' } }],
      usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 }
    }
  }

  const result = await agent.runTurn({ message: 'ubah nilai a', surfaceId: 'test' }, {})
  assert.ok(result.artifacts, 'turn result carries artifacts')
  assert.equal(result.completionStatus, 'complete', result.response)
  assert.ok(result.artifacts.created.some(path => path.replace(/\\/g, '/').endsWith('tests/x.test.mjs')), JSON.stringify(result.artifacts))
  assert.ok(result.artifacts.verification.includes('node --test tests/x.test.mjs'))
  assert.match(result.artifacts.summary, /\[Artifacts\]/)
})
