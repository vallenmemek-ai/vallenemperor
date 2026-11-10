import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../dist/index.js')

function makeAgent(t, { configPatch = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vallen-policy-'))
  const work = mkdtempSync(join(tmpdir(), 'vallen-policy-work-'))
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
  Object.assign(config, configPatch)

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())
  return { agent, work, home }
}

function scriptedProvider(agent, toolName, args) {
  let calls = 0
  agent.provider.chat = async () => {
    calls++
    if (calls === 1) {
      return {
        id: 'c1', model: 'mock-model',
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }
    }
    return { id: 'c2', model: 'mock-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'finished' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
  }
}

test('tool_policy deny blocks the tool before it runs', async t => {
  const { agent, work } = makeAgent(t, { configPatch: { tool_policy: { write_file: 'deny' } } })
  scriptedProvider(agent, 'write_file', { path: join(work, 'blocked.txt'), content: 'x' })

  const result = await agent.runTurn({ message: 'write it', surfaceId: 'test' }, {})
  assert.equal(result.response, 'finished')
  assert.equal(existsSync(join(work, 'blocked.txt')), false, 'the denied tool never executed')
})

test('tool_policy ask blocks when the approval bridge refuses', async t => {
  const { agent, work } = makeAgent(t, { configPatch: { tool_policy: { write_file: 'ask' } } })
  scriptedProvider(agent, 'write_file', { path: join(work, 'ask.txt'), content: 'x' })

  const result = await agent.runTurn({ message: 'write it', surfaceId: 'test' }, { requestApproval: async () => false })
  assert.equal(result.response, 'finished')
  assert.equal(existsSync(join(work, 'ask.txt')), false, 'the refused tool never executed')

  const second = makeAgent(t, { configPatch: { tool_policy: { write_file: 'ask' } } })
  scriptedProvider(second.agent, 'write_file', { path: join(second.work, 'allowed.txt'), content: 'x' })
  await second.agent.runTurn({ message: 'write it', surfaceId: 'test' }, { requestApproval: async () => true })
  assert.equal(existsSync(join(second.work, 'allowed.txt')), true, 'an approved tool runs')
})

test('/policy stores and clears per-tool rules', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-policy-cmd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: home } }, getSessionId: () => 'p' } }
    const empty = await core.handleCommand(ctx, '/policy')
    assert.match(empty.response, /No tool policy set/)

    const set = await core.handleCommand(ctx, '/policy write_file deny')
    assert.match(set.response, /write_file: deny/)
    assert.equal(ctx.agent.config.tool_policy.write_file, 'deny')

    const show = await core.handleCommand(ctx, '/policy')
    assert.match(show.response, /write_file\s+deny/)

    const cleared = await core.handleCommand(ctx, '/policy write_file clear')
    assert.match(cleared.response, /cleared/)
    assert.equal(ctx.agent.config.tool_policy.write_file, undefined)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/worktree new creates a git worktree and retargets the session', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'vallen-wt-main-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-wt-main-home-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

  const { createLocalCommandHandler } = await import('../../vallencli/src/cli-commands.mjs')
  const printed = []
  const agent = { config: { providers: {}, terminal: { cwd: repo } }, getSessionId: () => 'wt', getContextStats: () => ({ turns: 1 }), memoryStore: { setWorkingDir: () => {} } }
  const handler = createLocalCommandHandler({
    agent, core, state: {},
    output: { isTTY: false, columns: 80, write: () => true },
    printResponse: text => printed.push(String(text)),
    readHiddenToken: async () => ({ value: '' }),
    settleApproval: () => {}, enqueue: () => {}, out: () => {}, refreshStatus: () => {},
    healthCheck: async () => [], enterShell: async () => {}, runTurn: async () => {}, displayLine: text => printed.push(String(text))
  })

  await handler('/worktree new feature-x')
  assert.match(printed.join('\n'), /Worktree ready:/)
  assert.ok(agent.config.terminal.cwd.includes('main-feature-x'))
  assert.equal(existsSync(join(agent.config.terminal.cwd, 'README.md')), true)

  printed.length = 0
  await handler('/worktree list')
  assert.match(printed.join('\n'), /main-feature-x/)
})
