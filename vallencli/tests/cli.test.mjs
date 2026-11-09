import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { BIG_EDIT_PREVIEW_LINES, bigEditPreview, chatBoxRedrawSequence, collectHealthChecks, createCliAgent, formatChatBox, formatStatus, formatThinkingActivity, parseArgs, runCli, runConfigCommand } from '../src/cli.mjs'
import { HELP } from '../src/cli-ui.mjs'
import { colorizeDiffPro, formatFileEditResult, formatToolResult, stringWidth } from '../src/cli-ui.mjs'

function fakeAgent({ turn, sessions = [] } = {}) {
  const calls = []
  return {
    calls,
    config: { providers: { active: '9router', '9router': { model: 'mock-model', base_url: 'http://127.0.0.1:1/v1', api_key: '' } }, terminal: { cwd: process.cwd() }, mcpServers: {} },
    provider: { model: 'mock-model', baseURL: 'http://127.0.0.1:1/v1' },
    skillLoader: { list: () => [] }, memoryStore: { setWorkingDir() {}, formatForSystemPrompt: () => '' },
    todoStore: { read: () => [] }, sessionManager: { listSessions: () => sessions }, mcpManager: null,
    getSessionId: () => 'test-session', getContextStats: () => ({ promptTokens: 12, contextWindow: 1000, percent: 1, estimated: true, turns: 0, messages: 1, systemPromptTokens: 4, historyTokens: 0, sessionPromptTotal: 0, sessionCompletionTotal: 0, largestToolName: '', largestToolTokens: 0 }),
    getConfig() { return this.config },
    setModel(model) { this.provider.model = model; this.config.providers['9router'].model = model },
    setToken(token) { this.token = token }, interrupt() { calls.push('interrupt'); return true },
    async resetSession() { calls.push('reset') }, resumeSession(id) { calls.push(['resume', id]); return sessions.some(session => session.id === id) },
    async runTurn(request, callbacks) { calls.push(request); return turn ? turn(request, callbacks, calls) : { response: 'mock answer', sessionId: 'test-session', surfaceId: request.surfaceId } },
    async shutdown() { calls.push('shutdown') }
  }
}

function captureOutput(onWrite = () => {}) {
  let text = ''
  const output = new Writable({ write(chunk, _encoding, callback) { const value = String(chunk); text += value; onWrite(value); callback() } })
  output.columns = 80
  output.isTTY = false
  return { output, get text() { return text } }
}

const noHealth = async () => []

test('CLI enables background review by default while honoring explicit opt-out', () => {
  const seen = []
  class StubAgent { constructor(options) { seen.push(options) } }
  const core = { AIAgent: StubAgent }
  createCliAgent(core, {})
  createCliAgent(core, { backgroundReview: false })
  createCliAgent(core, { config: { gateway: { background_review: false } } })
  assert.equal(seen[0].backgroundReview, true)
  assert.equal(seen[1].backgroundReview, false)
  assert.equal(seen[2].backgroundReview, false)
})


test('health diagnostics report host, tools, storage, skills, MCP, and provider without exposing credentials', async () => {
  const agent = fakeAgent()
  const core = { registry: { getOpenAISchemas: () => [{ function: { name: 'terminal' } }] } }
  agent.config.mcpServers = { sample: { enabled: true } }
  agent.config.providers['9router'].api_key = 'sensitive-test-value'
  const checks = await collectHealthChecks(agent, [{ name: 'sample', status: 'ready' }], core)
  assert.deepEqual(checks.map(check => check.title), ['Host Platform', 'Developer Tools', 'Persistent Stores', 'Modular Skills', 'Core Toolsets', 'MCP Servers', 'AI Gateway'])
  assert.match(checks.find(check => check.title === 'MCP Servers').detail, /1\/1 ready/)
  assert.match(checks.find(check => check.title === 'Core Toolsets').detail, /1 tools available/)
  assert.doesNotMatch(JSON.stringify(checks), /sensitive-test-value/)
})

test('health diagnostics fall back to agent.coreRegistry when no core is passed', async () => {
  const agent = fakeAgent()
  agent.coreRegistry = { getOpenAISchemas: () => [{}, {}] }
  const checks = await collectHealthChecks(agent, [])
  assert.match(checks.find(check => check.title === 'Core Toolsets').detail, /2 tools available/)
})

test('MCP diagnostics and status use same runtime server count', async () => {
  const agent = fakeAgent()
  const servers = [{ name: 'stale', status: 'connecting' }]
  const checks = await collectHealthChecks(agent, servers)
  assert.match(checks.find(check => check.title === 'MCP Servers').detail, /0\/1 ready/)
  assert.match(formatStatus(agent, servers).replace(/\u001b\[[0-9;]*m/g, ''), /MCP 0\/1/)
})

test('thinking activity uses Hermes face, verb and elapsed-time label', () => {
  assert.equal(formatThinkingActivity(8_600, 0, 0), '(｡•́︿•̀｡) pondering... · 8s')
  assert.equal(formatThinkingActivity(80_000, 14, 14), 'ಠ_ಠ brainstorming... · 1m 20s')
})

test('idle status uses VallenEmperor brand instead of transient READY state', () => {
  assert.match(formatStatus(fakeAgent(), []), /VALLENEMPEROR/)
})

test('chat panel keeps status and user message inside four-sided box', () => {
  const lines = formatChatBox('MODEL mock  │  MCP 0/0  │  VALLENEMPEROR', '› split css?', 42).split(String.fromCharCode(10)).map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
  assert.equal(lines.length, 4)
  assert.ok(lines[0].startsWith('╭') && lines[0].endsWith('╮'))
  assert.ok(lines[1].startsWith('│') && lines[1].endsWith('│'))
  assert.match(lines[1], /MODEL mock/)
  assert.ok(lines[2].includes('› split css?'))
  assert.ok(lines[3].startsWith('╰') && lines[3].endsWith('╯'))
  assert.ok(lines.every(line => Array.from(line).length === 42))
})

test('chat panel wraps long unbroken terminal-like text without losing content', () => {
  const value = 'command-' + 'x'.repeat(70)
  const lines = formatChatBox('', value, 44).split('\n').map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
  assert.ok(lines.length > 3)
  assert.ok(lines.every(line => Array.from(line).length === 44))
  assert.ok(lines.join('').replace(/[│╭╮╰╯─ ]/g, '').includes('x'.repeat(70)))
})

test('tool result wraps long terminal lines without clipping content', () => {
  const text = 'log-' + 'y'.repeat(90)
  const rendered = formatToolResult(text, { width: 48, maxLines: 20 }).replace(/\u001b\[[0-9;]*m/g, '')
  const content = rendered.split('\n').map(line => line.replace(/^\s+/, '')).join('').replace(/[⎿✓│ ]/g, '')
  assert.ok(content.includes('y'.repeat(90)))
  assert.ok(rendered.split('\n').every(line => Array.from(line).length <= 48))
})

test('tool result retains patch path, hunk headers, additions, removals, and exact patch errors', () => {
  const diff = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old value\n+new value'
  const rendered = formatToolResult(diff, { width: 80 }).replace(/\u001b\[[0-9;]*m/g, '')
  assert.match(rendered, /a\/src\/example\.ts/)
  assert.match(rendered, /b\/src\/example\.ts/)
  assert.match(rendered, /@@ -1 \+1 @@/)
  assert.match(rendered, /old value/)
  assert.match(rendered, /new value/)
  assert.match(formatToolResult('patch failed: patch content required', { error: true }), /patch content required/)
  const preview = `  ┊ 🔧 patch     src/example.ts  0.0s\n  ┊ review diff\n${diff}`
  const timed = formatToolResult(preview, { durationMs: 340 }).replace(/\u001b\[[0-9;]*m/g, '')
  assert.match(timed, /340ms/)
  assert.doesNotMatch(timed, /0\.0s/)
})

test('diff wrapping preserves long added source text and fits each row to cell width', () => {
  const source = '+const sample = "' + '界'.repeat(30) + 'x'.repeat(35) + '"'
  const rows = colorizeDiffPro(`@@ -1 +1 @@\n ${source.slice(1)}\n ${source}`, { width: 32, maxLines: 20 })
  const plain = rows.map(row => row.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\s*\d+\s+/, '').replace(/^ {5}/, '')).join('')
  assert.ok(rows.length > 3)
  assert.ok(rows.every(row => stringWidth(row) <= 32))
  assert.ok(plain.includes(source))
})

test('file edit result shows target, verification status, diff, and match strategy', () => {
  const result = JSON.stringify({ success: true, verified: true, strategy: 'line_trimmed', diff: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after' })
  const rendered = formatFileEditResult('patch', { path: 'src/file.ts' }, result, { durationMs: 250, width: 50 }).replace(/\u001b\[[0-9;]*m/g, '')
  assert.match(rendered, /patch.*src\/file\.ts.*verified/)
  assert.match(rendered, /match:\s+line_trimmed/)
  assert.match(rendered, /review diff/)
  assert.match(rendered, /│.*before/)
  assert.match(rendered, /-old/)
  assert.match(rendered, /\+new/)
})

test('status line stays within terminal width when model and workspace path are long', () => {
  const agent = fakeAgent()
  agent.provider.model = 'provider-with-a-very-long-model-identifier-that-would-wrap'
  agent.config.terminal.cwd = '/home/user/workspaces/a/very/deep/project/path/that/keeps/going'
  const line = formatStatus(agent, [], 'WORKING', 80).replace(/\u001b\[[0-9;]*m/g, '')
  assert.ok(line.length <= 80, `${line.length} columns: ${line}`)
})

test('status line fits a narrow terminal width', () => {
  const line = formatStatus(fakeAgent(), [], 'THINKING', 48).replace(/\u001b\[[0-9;]*m/g, '')
  assert.ok(line.length <= 48, `${line.length} columns: ${line}`)
})

test('CLI delays status rendering until banner is ready even when MCP reports during startup', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({
    input, output: output.output, healthCheck: noHealth, bannerText: 'STARTUP BANNER',
    createAgent: ({ onMcpStatus }) => { onMcpStatus([{ name: 'sample', status: 'connecting' }]); return agent }
  })
  input.end('/exit\n')
  await run
  assert.ok(output.text.indexOf('STARTUP BANNER') < output.text.indexOf('MODEL mock-model'))
})

test('CLI renders banner and status, dispatches prompt to core, then exits cleanly', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: 'ASCII BANNER' })
  input.end('hello core\n/exit\n')
  await run
  assert.match(output.text, /ASCII BANNER/)
  assert.match(output.text, /System Diagnostics & Health Check/)
  assert.match(output.text, /MODEL mock-model/)
  assert.match(output.text, /MCP 0\/0/)
  assert.doesNotMatch(output.text, /^› /m)
  assert.match(output.text, /mock answer/)
  assert.equal(agent.calls.filter(call => typeof call === 'object').length, 1)
  assert.equal(agent.calls.find(call => typeof call === 'object').message, 'hello core')
})

test('CLI shuts the agent down on exit so MCP child processes do not leak', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('/exit\n')
  await run
  assert.ok(agent.calls.includes('shutdown'), 'agent.shutdown() must run on CLI exit')
})

test('the real AIAgent exposes the shutdown hook the CLI calls', async () => {
  const core = await import('../../vallenagent/dist/index.js')
  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'probe'
  config.providers.probe = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'probe-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false })
  try {
    assert.equal(typeof agent.shutdown, 'function')
    assert.equal(typeof agent.getContextStats, 'function')
    assert.equal(typeof agent.mcpManager, 'object', 'mcpManager is exposed as a getter')
  } finally {
    await agent.shutdown()
  }
})

test('TTY chat redraw moves to submitted prompt rows only', () => {
  const esc = String.fromCharCode(27)
  assert.equal(chatBoxRedrawSequence('first message', 80), `${esc}[1A\r${esc}[J`)
  assert.equal(chatBoxRedrawSequence('x'.repeat(80), 80), `${esc}[2A\r${esc}[J`)
})

test('active turn keeps boxed status while showing compact robot states', async () => {
  const input = new PassThrough()
  input.isTTY = false
  let exitQueued = false
  const output = captureOutput(chunk => {
    if (!exitQueued && chunk.includes('robot turn result')) {
      exitQueued = true
      setImmediate(() => input.end('/exit\n'))
    }
  })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    callbacks.onEvent({ type: 'thinking', sessionId: 'test-session', surfaceId: request.surfaceId })
    callbacks.onEvent({ type: 'tool_start', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-1', name: 'read_file', args: {}, preview: 'READ FILE' } })
    callbacks.onEvent({ type: 'telemetry', sessionId: 'test-session', surfaceId: request.surfaceId })
    return { response: 'robot turn result', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('keep chat visible\n')
  await run
  assert.match(output.text, /(?:pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|processing|reasoning|analyzing|computing|synthesizing|formulating|brainstorming)\.\.\. · \d+s/)
  assert.match(output.text, /\[o_o\] WORKING/)
  assert.equal((output.text.match(/MODEL mock-model/g) || []).length, 3)
  assert.match(output.text, /│ › keep chat visible/)
  assert.match(output.text, /VALLENEMPEROR/)
})

test('CLI forwards /sessions and /resume to the shared core handler', async () => {
  const shared = []
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({
    input, output: output.output, agent, healthCheck: noHealth, bannerText: '',
    handleSharedCommand: async (_ctx, text) => { shared.push(text); return { handled: true, response: `core:${text}` } }
  })
  input.end(['/sessions', '/resume 1', '/exit', ''].join(String.fromCharCode(10)))
  await run
  // Numbering and index→id resolution live in core now; the CLI only forwards.
  assert.deepEqual(shared, ['/sessions', '/resume 1'])
  assert.match(output.text, /core:\/sessions/)
  assert.match(output.text, /core:\/resume 1/)
})

test('CLI forwards every /resume form instead of rejecting ids locally', async () => {
  const shared = []
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent({ sessions: [{ id: 'session-one', title: 'one', updated_at: '', model: 'mock-model' }] })
  const run = runCli({
    input, output: output.output, agent, healthCheck: noHealth, bannerText: '',
    handleSharedCommand: async (_ctx, text) => { shared.push(text); return { handled: true, response: 'ok' } }
  })
  input.end(['/resume 0', '/resume 2', '/resume latest', '/resume session-one', '/resume', '/exit', ''].join(String.fromCharCode(10)))
  await run
  assert.deepEqual(shared, ['/resume 0', '/resume 2', '/resume latest', '/resume session-one', '/resume'])
  assert.equal(agent.calls.filter(call => Array.isArray(call) && call[0] === 'resume').length, 0, 'the CLI must not resume on its own')
})

test('CLI renders typed tool progress and terminal output from the core', async () => {
  const input = new PassThrough()
  input.isTTY = false
  let fed = false
  const output = captureOutput(chunk => {
    if (!fed && chunk.includes('tool trace result')) { fed = true; setImmediate(() => input.end('/exit\n')) }
  })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    callbacks.onEvent({ type: 'tool_start', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-1', name: 'terminal', args: { command: 'npm test' }, preview: 'TOOL START: terminal' } })
    callbacks.onEvent({ type: 'terminal_output', sessionId: 'test-session', surfaceId: request.surfaceId, output: { id: 'tool-1', stream: 'stdout', chunk: 'tool output' } })
    callbacks.onEvent({ type: 'terminal_output', sessionId: 'test-session', surfaceId: request.surfaceId, output: { id: 'tool-1', stream: 'stdout', chunk: ' marker' } })
    callbacks.onEvent({ type: 'tool_end', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-1', name: 'terminal', args: {}, result: 'ok', preview: 'TOOL END: terminal' } })
    for (let id = 0; id < 3; id++) callbacks.onEvent({ type: 'tool_end', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: `skill-${id}`, name: 'skill_view', args: { name: 'architecture-diagram' }, result: '{}', preview: 'skill architecture-diagram' } })
    return { response: 'tool trace result', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('run tool\n')
  await run
  assert.match(output.text, /WORKING · terminal · npm test/)
  assert.match(output.text, /TOOL START: terminal/)
  assert.match(output.text, /tool output marker/)
  assert.match(output.text, /Terminal · \$  · exit unknown · \d+ms/)
  assert.doesNotMatch(output.text, /skill architecture-diagram/)
})

test('CLI keeps terminal output available through /output after tool finishes', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput(chunk => { if (chunk.includes('full terminal payload')) setImmediate(() => input.end('/output\n/exit\n')) })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    callbacks.onEvent({ type: 'tool_start', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-output', name: 'terminal', args: { command: 'printf output' }, preview: '$ printf output' } })
    const payload = Array.from({ length: 12 }, (_, i) => i === 0 ? 'full terminal payload' : `output line ${i + 1}`).join('\n')
    callbacks.onEvent({ type: 'terminal_output', sessionId: 'test-session', surfaceId: request.surfaceId, output: { id: 'tool-output', stream: 'stdout', chunk: payload } })
    callbacks.onEvent({ type: 'tool_end', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-output', name: 'terminal', args: { command: 'printf output' }, result: JSON.stringify({ exit_code: 0, output: payload }), preview: '$ printf output' } })
    return { response: 'command finished', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('run command\n')
  await run
  assert.match(output.text, /Terminal · \$ printf output · exit 0 · \d+ms/)
  assert.match(output.text, /12 lines · \/output expands/)
  assert.match(output.text, /4 lines hidden · use \/output/)
  assert.match(output.text, /full terminal payload/)
  assert.match(output.text, /output line 12/)
})

test('CLI explains unsupported shell tool with available terminal command', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput(chunk => { if (chunk.includes('Unsupported tool')) setImmediate(() => input.end('/exit\n') ) })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    callbacks.onEvent({ type: 'tool_end', sessionId: 'test-session', surfaceId: request.surfaceId, tool: { id: 'tool-1', name: 'shell', args: {}, result: JSON.stringify({ error: 'Tool not found: shell' }) } })
    return { response: 'retrying with terminal', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('run shell\n')
  await run
  assert.match(output.text, /Unsupported tool "shell"\. Use "terminal" instead\./)
  assert.doesNotMatch(output.text, /Tool not found: shell/)
})

test('CLI waits for explicit approval answer before continuing agent turn', async () => {
  const input = new PassThrough()
  input.isTTY = false
  let fed = false
  const output = captureOutput(chunk => {
    if (!fed && chunk.includes('Allow tool terminal?')) { fed = true; setImmediate(() => input.end('y\n')) }
  })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    const allowed = await callbacks.requestApproval({ sessionId: 'test-session', surfaceId: request.surfaceId, id: 'tool-1', name: 'terminal', args: { command: 'rm -rf ./target' } })
    agent.calls.push(['approved', allowed])
    return { response: allowed ? 'approved result' : 'denied result', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('hello\n')
  await run
  assert.equal(fed, true)
  assert.deepEqual(agent.calls.find(Array.isArray), ['approved', true])
  assert.match(output.text, /\[o_o\] APPROVAL/)
  assert.match(output.text, /\[o_o\] WORKING/)
  assert.match(output.text, /approved result/)
})

test('CLI keeps denied tool approval denied', async () => {
  const input = new PassThrough()
  input.isTTY = false
  let fed = false
  const output = captureOutput(chunk => {
    if (!fed && chunk.includes('Allow tool terminal?')) { fed = true; setImmediate(() => input.end('n\n')) }
  })
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    const allowed = await callbacks.requestApproval({ sessionId: 'test-session', surfaceId: request.surfaceId, id: 'tool-2', name: 'terminal', args: { command: 'rm -rf ./target' } })
    agent.calls.push(['approved', allowed])
    return { response: allowed ? 'unexpected allow' : 'denied result', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.write('hello\n')
  await run
  assert.equal(fed, true)
  assert.deepEqual(agent.calls.find(Array.isArray), ['approved', false])
  assert.match(output.text, /denied result/)
})

test('CLI forwards shared slash commands and no longer switches models itself', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const shared = []
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '', handleSharedCommand: async (_ctx, text) => { shared.push(text); return { handled: true, response: 'MCP command result' } } })
  input.end('/mcp\n/model next-model\n/exit\n')
  await run
  assert.deepEqual(shared, ['/mcp', '/model next-model'])
  assert.equal(agent.provider.model, 'mock-model', 'model switching belongs to core, not the CLI')
  assert.match(output.text, /MCP command result/)
})

test('CLI forwards /stop to the active turn and exits without input races', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent({ turn: async request => {
    await new Promise(resolve => setTimeout(resolve, 15))
    return { response: 'stopped turn result', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('hello\nsecond turn must wait\n/stop\n/exit\n')
  await run
  assert.ok(agent.calls.filter(call => call === 'interrupt').length >= 1)
  assert.equal(agent.calls.filter(call => typeof call === 'object').length, 1)
  assert.match(output.text, /Agent busy/)
  assert.match(output.text, /Stopping agent turn/)
})

test('CLI refuses inline API tokens because terminal input may echo secrets', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('/token secret-value\n/exit\n')
  await run
  assert.equal(agent.token, undefined)
  assert.match(output.text, /Token rejected/)
  assert.doesNotMatch(output.text, /secret-value/)
})

test('CLI refuses hidden token entry when stdin is not a TTY', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent()
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('/token\n/exit\n')
  await run
  assert.match(output.text, /requires an interactive terminal/)
  assert.equal(agent.token, undefined)
})

test('CLI reports core turn errors without fabricating a response', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const agent = fakeAgent({ turn: async () => { throw new Error('provider unavailable') } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('hello\n/exit\n')
  await run
  assert.match(output.text, /provider unavailable/)
  assert.doesNotMatch(output.text, /mock answer/)
})

// ---------- startup flags ----------

test('parseArgs understands the documented startup flags', () => {
  assert.equal(parseArgs([]).mode, 'run')
  assert.equal(parseArgs(['--help']).mode, 'help')
  assert.equal(parseArgs(['--version']).mode, 'version')

  assert.equal(parseArgs(['--resume']).mode, 'resume')
  assert.equal(parseArgs(['--resume']).resumeId, null)
  assert.equal(parseArgs(['--resume', 'sess-42']).resumeId, 'sess-42')

  const oneShot = parseArgs(['-p', 'halo'])
  assert.equal(oneShot.mode, 'prompt')
  assert.equal(oneShot.prompt, 'halo')

  assert.equal(parseArgs(['--approval', 'all']).approval, 'all')
  assert.equal(parseArgs(['--model', 'gpt-x']).model, 'gpt-x')
})

test('parseArgs rejects unknown or incomplete arguments instead of silently running the REPL', () => {
  const unknown = parseArgs(['--bogus'])
  assert.equal(unknown.mode, 'error')
  assert.match(unknown.error, /Unknown option: --bogus/)

  const stray = parseArgs(['halo'])
  assert.equal(stray.mode, 'error')
  assert.match(stray.error, /Unknown argument: halo/)

  assert.equal(parseArgs(['-p']).mode, 'error')
  assert.match(parseArgs(['--approval', 'sometimes']).error, /--approval must be one of/)
  assert.equal(parseArgs(['--model']).mode, 'error')
})

test('help lists every startup flag', () => {
  for (const flag of ['--prompt', '--resume', '--approval', '--model', '--help', '--version', 'config set provider']) {
    assert.ok(HELP.includes(flag), `help must document ${flag}`)
  }
})

// ---------- big edits show their diff before landing ----------

const lines = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n')

test('bigEditPreview only fires for edits above the line threshold', () => {
  const big = bigEditPreview({ name: 'patch', args: { path: 'a.ts', old_string: lines('old', 15), new_string: lines('new', 15) } })
  assert.ok(big, 'a 30-line change must be previewed')
  assert.equal(big.changedLines, 30)
  assert.ok(big.changedLines > BIG_EDIT_PREVIEW_LINES)

  const small = bigEditPreview({ name: 'patch', args: { path: 'a.ts', old_string: 'one', new_string: 'two' } })
  assert.equal(small, null, 'a one-line edit must not nag')
})

test('bigEditPreview ignores non-edit tools and non-interactive surfaces', () => {
  const bigArgs = { path: 'a.ts', old_string: lines('old', 15), new_string: lines('new', 15) }
  assert.equal(bigEditPreview({ name: 'terminal', args: { command: 'ls' } }), null)
  assert.equal(bigEditPreview({ name: 'patch', args: bigArgs }, { interactive: false }), null, 'one-shot runs have nobody to ask')
})

// ---------- config subcommand ----------

test('parseArgs routes the config subcommands', () => {
  const show = parseArgs(['config', 'show'])
  assert.equal(show.mode, 'config')
  assert.equal(show.configAction, 'show')

  const provider = parseArgs(['config', 'set', 'provider', 'deepseek'])
  assert.equal(provider.configAction, 'set-provider')
  assert.equal(provider.provider, 'deepseek')

  const model = parseArgs(['config', 'set', 'model', 'gpt-x'])
  assert.equal(model.configAction, 'set-model')
  assert.equal(model.configModel, 'gpt-x')

  assert.equal(parseArgs(['config', 'set', 'approval', 'all']).configApproval, 'all')
  assert.equal(parseArgs(['config', 'set', 'approval', 'kadang']).mode, 'error')
  assert.equal(parseArgs(['config', 'set', 'provider']).mode, 'error')
  assert.equal(parseArgs(['config', 'nonsense']).mode, 'error')
})

test('config set provider writes a valid preset and never stores the api key', async t => {
  const core = await import('../../vallenagent/dist/index.js')
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-config-'))
  const previousHome = process.env.VALLENEMPEROR_HOME
  const logs = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    console.log = originalLog
    console.error = originalError
    if (previousHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const code = await runConfigCommand(core, parseArgs(['config', 'set', 'provider', 'deepseek']))
  assert.equal(code, 0, logs.join('\n'))

  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  assert.equal(saved.providers.active, 'deepseek')
  assert.equal(saved.providers.deepseek.base_url, 'https://api.deepseek.com/v1')
  assert.equal(saved.providers.deepseek.model, 'deepseek-chat')
  assert.equal(saved.providers.deepseek.api_key, '', 'the key belongs to the environment, not config.json')
  assert.match(logs.join('\n'), /DEEPSEEK_API_KEY/)
})

test('config set provider rejects an unknown preset without touching the config', async t => {
  const core = await import('../../vallenagent/dist/index.js')
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-config-bad-'))
  const previousHome = process.env.VALLENEMPEROR_HOME
  const originalLog = console.log
  const originalError = console.error
  const logs = []
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    console.log = originalLog
    console.error = originalError
    if (previousHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const code = await runConfigCommand(core, parseArgs(['config', 'set', 'provider', 'nope']))
  assert.equal(code, 2)
  assert.match(logs.join('\n'), /Unknown provider preset "nope"/)
  assert.equal(existsSync(join(home, 'config.json')), false, 'a rejected preset must not write a config')
})

test('a non-interactive run auto-approves a big edit instead of waiting for input', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const output = captureOutput()
  const bigArgs = { path: 'a.ts', old_string: lines('old', 15), new_string: lines('new', 15) }
  const agent = fakeAgent({ turn: async (request, callbacks) => {
    const allowed = await callbacks.requestApproval({ sessionId: 'test-session', surfaceId: request.surfaceId, id: 'tool-9', name: 'patch', args: bigArgs })
    agent.calls.push(['approved', allowed])
    return { response: 'edit done', sessionId: 'test-session', surfaceId: request.surfaceId }
  } })
  const run = runCli({ input, output: output.output, agent, healthCheck: noHealth, bannerText: '' })
  input.end('ubah file besar\n')
  await run
  assert.deepEqual(agent.calls.find(Array.isArray), ['approved', true])
  assert.match(output.text, /edit done/)
})

// ---------- global install (npm bin symlink) ----------

test('the CLI still runs when invoked through a symlink, as npm global installs do', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-binlink-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = join(dir, 'vallenemperor')
  symlinkSync(resolve('src/cli.mjs'), link)

  const output = execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' })
  assert.match(output, /vallenemperor v\d+\.\d+\.\d+/)
})
