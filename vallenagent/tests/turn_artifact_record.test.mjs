import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Integration lock for turn artifacts: a real AIAgent turn that writes a file must leave a
 * reviewable record on disk and expose its directory on the response.
 */

const core = await import('../dist/index.js')

function makeAgent(t, { chatImpl, configPatch = {} } = {}) {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-artifact-turn-'))
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
  Object.assign(config, configPatch)

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  agent.provider.chat = chatImpl
  t.after(() => agent.shutdown())
  return { agent, home }
}

test('a turn that writes a file leaves a walkthrough artifact and exposes its directory', async t => {
  const workdir = mkdtempSync(join(tmpdir(), 'vallenemperor-artifact-work-'))
  t.after(() => rmSync(workdir, { recursive: true, force: true }))
  const target = join(workdir, 'notes.txt')

  const calls = []
  const chatImpl = async payload => {
    calls.push(payload)
    if (calls.length === 1) {
      return {
        id: 'c1',
        model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_write',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'hello artifacts\n' }) }
            }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    }
    return {
      id: 'c2',
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'wrote the file' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    }
  }

  const { agent } = makeAgent(t, { chatImpl, configPatch: { terminal: { cwd: workdir } } })
  const result = await agent.runTurn({ message: 'write notes.txt', surfaceId: 'test' }, {})

  assert.equal(result.response, 'wrote the file')
  assert.equal(existsSync(target), true, 'the tool really wrote the file')

  assert.ok(result.artifacts, 'response carries artifacts')
  assert.deepEqual(result.artifacts.created, [target])
  assert.ok(result.artifacts.dir, 'response carries the artifact directory')
  assert.ok(result.artifacts.dir.includes(join('artifacts')), 'artifact dir lives under the home artifacts root')

  const walkthrough = join(result.artifacts.dir, 'walkthrough.md')
  assert.equal(existsSync(walkthrough), true, 'walkthrough.md must be written')
  const text = readFileSync(walkthrough, 'utf8')
  assert.match(text, /^# Turn 1 — walkthrough/)
  assert.match(text, /write notes\.txt/)
  assert.match(text, /wrote the file/)
  assert.match(text, /## Created[\s\S]*notes\.txt/)

  const index = JSON.parse(readFileSync(join(result.artifacts.dir, 'index.json'), 'utf8'))
  assert.equal(index.turn, 1)
  assert.deepEqual(index.entries.map(entry => entry.kind), ['walkthrough'])
})

test('a turn with no file changes writes no artifact directory', async t => {
  const chatImpl = async () => ({
    id: 'c',
    model: 'mock-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'just talking' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  })

  const { agent, home } = makeAgent(t, { chatImpl })
  const result = await agent.runTurn({ message: 'say something', surfaceId: 'test' }, {})

  assert.equal(result.artifacts?.dir, undefined, 'nothing to record means no directory')
  assert.equal(existsSync(join(home, 'artifacts')), false)
})
