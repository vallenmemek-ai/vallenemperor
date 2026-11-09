import test from 'node:test'
import assert from 'node:assert/strict'

import { applyRuntimeOverrides, createOneShotApproval, isSlashCommandLine, parseArgs, runOneShotCommand } from '../src/cli.mjs'

function sink() {
  const chunks = []
  return { write: value => chunks.push(String(value)), text: () => chunks.join('') }
}

function fakeCore({ mode = 'dangerous', risky = ['terminal'], handled = { handled: false, response: '' }, onHandle } = {}) {
  return {
    approvalMode: () => mode,
    // Mirrors the real rule: a trusted MCP server skips the gate.
    requiresApproval: ({ name }, _mode, mcpTrusted = false) => risky.includes(name) && !mcpTrusted,
    mcpServerFromTool: () => null,
    isMcpApproved: () => false,
    handleCommand: async (_ctx, text) => {
      onHandle?.(text)
      return handled
    }
  }
}

const fakeAgent = { config: { mcpServers: {} }, getSessionId: () => 'session-test' }

test('one-shot gate allows tools that need no approval', async () => {
  const { requestApproval, denied } = createOneShotApproval(fakeCore(), fakeAgent)
  assert.equal(await requestApproval({ name: 'read_file', args: { path: 'a' } }), true)
  assert.deepEqual(denied, [])
})

test('one-shot gate refuses a risky tool instead of running it silently', async () => {
  const blocked = []
  const { requestApproval, denied } = createOneShotApproval(fakeCore(), fakeAgent, {
    onBlocked: (name, mode) => blocked.push([name, mode])
  })
  assert.equal(await requestApproval({ name: 'terminal', args: { command: 'rm -rf /tmp/x' } }), false)
  assert.deepEqual(denied, ['terminal'])
  assert.deepEqual(blocked, [['terminal', 'dangerous']])
})

test('--approval off still allows everything (explicit opt-in)', async () => {
  const core = fakeCore({ mode: 'off', risky: ['terminal'] })
  core.requiresApproval = () => false
  const { requestApproval, denied } = createOneShotApproval(core, fakeAgent)
  assert.equal(await requestApproval({ name: 'terminal', args: { command: 'rm -rf /tmp/x' } }), true)
  assert.deepEqual(denied, [])
})

test('trusted MCP server bypasses the gate', async () => {
  const core = fakeCore({ risky: ['mcp__fs__write'] })
  core.mcpServerFromTool = () => 'fs'
  const agent = { config: { mcpServers: { fs: { trusted: true } } }, getSessionId: () => 's' }
  const { requestApproval } = createOneShotApproval(core, agent)
  assert.equal(await requestApproval({ name: 'mcp__fs__write', args: {} }), true)
})

test('slash detection separates commands from paths', () => {
  assert.equal(isSlashCommandLine('/help'), true)
  assert.equal(isSlashCommandLine('/stats'), true)
  assert.equal(isSlashCommandLine('  /model gpt-4o  '), true)
  // A single-segment path is indistinguishable from a command, exactly like the
  // interactive REPL: "/home" is treated as a command, "/home/me/app" is a path.
  assert.equal(isSlashCommandLine('/home'), true)
  assert.equal(isSlashCommandLine('/home/me/app'), false)
  assert.equal(isSlashCommandLine('/etc/hosts'), false)
  assert.equal(isSlashCommandLine('hello /help'), false)
  assert.equal(isSlashCommandLine(''), false)
})

test('/help is answered by the CLI, not the model', async () => {
  const out = sink()
  const err = sink()
  let called = false
  const core = fakeCore({ onHandle: () => { called = true } })
  const code = await runOneShotCommand(core, fakeAgent, '/help', { out, err })
  assert.equal(code, 0)
  assert.match(out.text(), /Startup flags/)
  assert.equal(called, false, 'the shared handler must not be consulted for /help')
  assert.equal(err.text(), '')
})

test('/exit ends the run without calling the model', async () => {
  const out = sink()
  const code = await runOneShotCommand(fakeCore(), fakeAgent, '/exit', { out, err: sink() })
  assert.equal(code, 0)
  assert.match(out.text(), /Session ending/)
})

test('handled shared command prints its response', async () => {
  const out = sink()
  const core = fakeCore({ handled: { handled: true, response: 'model: gpt-4o' } })
  const code = await runOneShotCommand(core, fakeAgent, '/model', { out, err: sink() })
  assert.equal(code, 0)
  assert.equal(out.text().trim(), 'model: gpt-4o')
})

test('unknown slash command exits non-zero instead of asking the model', async () => {
  const out = sink()
  const err = sink()
  const code = await runOneShotCommand(fakeCore(), fakeAgent, '/zzz-not-a-command', { out, err })
  assert.equal(code, 2)
  assert.equal(out.text(), '')
  assert.match(err.text(), /Unknown command: \/zzz-not-a-command/)
})

test('a throwing command handler is reported as an error, not a success', async () => {
  const err = sink()
  const core = fakeCore()
  core.handleCommand = async () => { throw new Error('boom') }
  const code = await runOneShotCommand(core, fakeAgent, '/stats', { out: sink(), err })
  assert.equal(code, 1)
  assert.match(err.text(), /Command error: boom/)
})

test('--approval overrides the mode that every surface actually reads', () => {
  const config = { agentApproval: 'off', providers: { active: 'p', p: { model: 'old' } } }
  applyRuntimeOverrides(config, { approval: 'dangerous', model: 'new-model' })
  assert.equal(config.agentApproval, 'dangerous', 'agentApproval is what approvalMode() reads')
  assert.equal(config.approval, 'dangerous')
  assert.equal(config.providers.p.model, 'new-model')
})

test('applyRuntimeOverrides leaves the config alone when no flags are given', () => {
  const config = { agentApproval: 'off', providers: { active: 'p', p: { model: 'keep' } } }
  applyRuntimeOverrides(config, { approval: null, model: null })
  assert.equal(config.agentApproval, 'off')
  assert.equal(config.providers.p.model, 'keep')
})

test('--json and --quiet are parsed and default to off', () => {
  assert.equal(parseArgs([]).json, false)
  assert.equal(parseArgs([]).quiet, false)
  assert.equal(parseArgs(['--json']).json, true)
  assert.equal(parseArgs(['--quiet']).quiet, true)
  assert.equal(parseArgs(['--no-banner']).quiet, true)
  assert.equal(parseArgs(['--json', '-p', 'hi']).mode, 'prompt')
})

test('--json prints telemetry as one JSON object for /stats', async () => {
  const out = sink()
  const core = fakeCore()
  core.contextTelemetry = () => ({ session_id: 's1', model: 'm', prompt_tokens: 10, context_window: 100, percent: 10 })
  const code = await runOneShotCommand(core, fakeAgent, '/stats', { out, err: sink(), json: true })
  assert.equal(code, 0)
  const parsed = JSON.parse(out.text())
  assert.equal(parsed.session_id, 's1')
  assert.equal(parsed.percent, 10)
})

test('--json wraps other command results in an envelope', async () => {
  const out = sink()
  const core = fakeCore({ handled: { handled: true, response: 'plain text answer' } })
  const code = await runOneShotCommand(core, fakeAgent, '/model', { out, err: sink(), json: true })
  assert.equal(code, 0)
  const parsed = JSON.parse(out.text())
  assert.equal(parsed.command, '/model')
  assert.equal(parsed.handled, true)
  assert.equal(parsed.response, 'plain text answer')
})
