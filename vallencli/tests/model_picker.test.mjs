import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import {
  backspacePicker,
  backPicker,
  createPickerState,
  enterPicker,
  fetchGatewayModels,
  formatModelCatalog,
  groupModelsByOwner,
  movePicker,
  normalizeGatewayModels,
  ownerLabel,
  pickerLines,
  typeInPicker,
  visibleGroups,
  visibleModels
} from '../dist/cli-model-picker.js'
import { runCli } from '../dist/cli.js'

// A trimmed copy of a real 9router /v1/models payload.
const gatewayPayload = {
  object: 'list',
  data: [
    { id: 'ag/gemini-4-argon-high', object: 'model', owned_by: 'ag', context_length: 200000, capabilities: { tools: true, vision: true } },
    { id: 'ag/claude-sonnet-4.6', object: 'model', owned_by: 'ag', context_length: 200000, capabilities: { tools: true } },
    { id: 'kc/anthropic/claude-sonnet-4', object: 'model', owned_by: 'kc', context_length: 200000, capabilities: { tools: true } },
    { id: 'jawaaa/deepseek-v4.1-flash:free', object: 'model', owned_by: 'jawaaa', context_length: 128000, capabilities: { tools: true } },
    { id: 'openrouter/typesafe/jev-1.13', object: 'model', owned_by: 'openrouter', context_length: 200000 }
  ]
}

test('models are grouped by gateway account with friendly labels', () => {
  const groups = groupModelsByOwner(normalizeGatewayModels(gatewayPayload))
  assert.deepEqual(groups.map(group => group.owner), ['ag', 'jawaaa', 'kc', 'openrouter'], 'sorted by model count')
  const ag = groups.find(group => group.owner === 'ag')
  assert.equal(ag.label, 'antigravity')
  assert.equal(ag.models.length, 2)
  assert.equal(ownerLabel('kc'), 'kiro')
  assert.equal(ownerLabel('jawaaa'), 'jawaaa', 'unknown accounts keep their id')
  assert.equal(ownerLabel(''), 'other')
})

test('normalizeGatewayModels keeps context, tools and vision metadata', () => {
  const [first] = normalizeGatewayModels(gatewayPayload)
  assert.equal(first.id, 'ag/gemini-4-argon-high')
  assert.equal(first.owner, 'ag')
  assert.equal(first.context, 200000)
  assert.equal(first.tools, true)
  assert.equal(first.vision, true)
})

test('the picker walks provider → model and returns the chosen id', () => {
  const state = createPickerState(groupModelsByOwner(normalizeGatewayModels(gatewayPayload)))
  assert.equal(state.level, 'owner')
  assert.equal(visibleGroups(state)[0].owner, 'ag')

  movePicker(state, 1)
  assert.equal(state.ownerIndex, 1, 'arrow down moves to the next provider')

  const entered = enterPicker(state)
  assert.equal(entered.done, false)
  assert.equal(state.level, 'model')

  movePicker(state, 1)
  const picked = enterPicker(state)
  assert.equal(picked.done, true)
  assert.match(picked.model, /^jawaaa\//, 'the highlighted model of the selected provider')
})

test('navigation wraps and resets the model cursor when the provider changes', () => {
  const state = createPickerState(groupModelsByOwner(normalizeGatewayModels(gatewayPayload)))
  movePicker(state, -1)
  assert.equal(state.ownerIndex, visibleGroups(state).length - 1, 'wraps to the last provider')

  // antigravity has two models: move down, then come back to a different provider.
  state.ownerIndex = 0
  enterPicker(state)
  movePicker(state, 1)
  assert.ok(state.modelIndex > 0)
  backPicker(state)
  movePicker(state, 1)
  enterPicker(state)
  assert.equal(state.modelIndex, 0, 'a fresh provider starts at its first model')
})

test('typing filters the list and backspace restores it', () => {
  const state = createPickerState(groupModelsByOwner(normalizeGatewayModels(gatewayPayload)))
  typeInPicker(state, 'kiro')
  assert.deepEqual(visibleGroups(state).map(group => group.owner), ['kc'], 'label match finds the provider')

  backspacePicker(state)
  backspacePicker(state)
  backspacePicker(state)
  backspacePicker(state)
  assert.equal(state.query, '')
  assert.equal(visibleGroups(state).length, 4)

  enterPicker(state)
  typeInPicker(state, 'claude')
  assert.deepEqual(visibleModels(state).map(model => model.id), ['ag/claude-sonnet-4.6'])
  assert.equal(enterPicker(state).model, 'ag/claude-sonnet-4.6')
})

test('Esc goes back one level, then closes', () => {
  const state = createPickerState(groupModelsByOwner(normalizeGatewayModels(gatewayPayload)))
  enterPicker(state)
  assert.deepEqual(backPicker(state), { closed: false })
  assert.equal(state.level, 'owner')
  assert.deepEqual(backPicker(state), { closed: true })
})

test('pickerLines marks the highlighted row and shows provider counts', () => {
  const state = createPickerState(groupModelsByOwner(normalizeGatewayModels(gatewayPayload)))
  const { lines, selectedIndex } = pickerLines(state, { width: 80 })
  assert.match(lines[0], /Pilih provider\/akun/)
  assert.match(lines[0], /Enter lanjut/)
  assert.match(lines[selectedIndex], /^  ❯ antigravity \(ag\)/)
  assert.match(lines[selectedIndex], /2 model/)

  enterPicker(state)
  const modelView = pickerLines(state, { width: 80 })
  assert.match(modelView.lines[0], /Model di antigravity/)
  assert.match(modelView.lines[modelView.selectedIndex], /ag\/claude-sonnet-4\.6/)
  assert.match(modelView.lines[modelView.selectedIndex], /200k ctx/)
})

test('fetchGatewayModels reads /models and sends the bearer token', async () => {
  const seen = []
  const result = await fetchGatewayModels({
    baseUrl: 'http://127.0.0.1:20128/v1/',
    apiKey: 'secret-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return { ok: true, status: 200, json: async () => gatewayPayload }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(seen[0].url, 'http://127.0.0.1:20128/v1/models')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer secret-token')
  assert.equal(result.models.length, 5)
})

test('fetchGatewayModels reports failures instead of throwing', async () => {
  const httpError = await fetchGatewayModels({ baseUrl: 'http://x/v1', fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.equal(httpError.ok, false)
  assert.match(httpError.error, /HTTP 503/)

  const empty = await fetchGatewayModels({ baseUrl: 'http://x/v1', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /0 model/)

  const missing = await fetchGatewayModels({ baseUrl: '', fetchImpl: async () => ({}) })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /base_url/)

  const boom = await fetchGatewayModels({ baseUrl: 'http://x/v1', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /ECONNREFUSED/)
})

test('formatModelCatalog is the non-interactive fallback listing', () => {
  const groups = groupModelsByOwner(normalizeGatewayModels(gatewayPayload))
  const text = formatModelCatalog(groups, { currentModel: 'kc/anthropic/claude-sonnet-4', maxModelsPerGroup: 1 })
  assert.match(text, /antigravity \(ag\) · 2 model/)
  assert.match(text, /… 1 lainnya/)
  assert.match(text, /\* kc\/anthropic\/claude-sonnet-4/)
})

// ---------- CLI wiring (non-TTY fallback) ----------

function fakeAgent() {
  const calls = []
  return {
    calls,
    config: {
      providers: { active: '9router', '9router': { base_url: 'http://127.0.0.1:20128/v1', api_key: '', model: 'jawaaa/deepseek-v4.1-flash:free' } },
      terminal: { cwd: process.cwd() },
      mcpServers: {}
    },
    provider: { model: 'jawaaa/deepseek-v4.1-flash:free', baseURL: 'http://127.0.0.1:20128/v1' },
    skillLoader: { list: () => [] },
    memoryStore: { setWorkingDir() {}, formatForSystemPrompt: () => '' },
    todoStore: { read: () => [] },
    sessionManager: { listSessions: () => [] },
    mcpManager: null,
    getSessionId: () => 'test-session',
    getContextStats: () => ({ promptTokens: 12, contextWindow: 1000, percent: 1, estimated: true, turns: 0, messages: 1, systemPromptTokens: 4, historyTokens: 0, sessionPromptTotal: 0, sessionCompletionTotal: 0, largestToolName: '', largestToolTokens: 0 }),
    getConfig() { return this.config },
    setModel(model) { calls.push(['setModel', model]); this.provider.model = model },
    setToken() {},
    interrupt() { return true },
    async resetSession() {},
    resumeSession() { return false },
    async runTurn() { return { response: 'ok', sessionId: 'test-session' } },
    async shutdown() {}
  }
}

function capture() {
  let text = ''
  const output = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback() } })
  output.columns = 100
  output.isTTY = false
  return { output, get text() { return text } }
}

test('non-interactive /model prints the live catalog and keeps /model <name> working', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const captured = capture()
  const agent = fakeAgent()
  const fetched = []
  const run = runCli({
    input,
    output: captured.output,
    agent,
    bannerText: '',
    healthCheck: async () => [],
    fetchModels: async options => { fetched.push(options); return { ok: true, models: normalizeGatewayModels(gatewayPayload) } }
  })
  input.end('/model\n/model kc/anthropic/claude-sonnet-4\n/exit\n')
  await run

  assert.equal(fetched.length, 1, 'the picker asked the gateway once')
  assert.match(fetched[0].baseUrl, /20128/)
  assert.match(captured.text, /antigravity \(ag\) · 2 model/)
  assert.match(captured.text, /Pakai \/model <nama> untuk memilih/)
  assert.deepEqual(agent.calls.find(call => call[0] === 'setModel'), ['setModel', 'kc/anthropic/claude-sonnet-4'])
})

test('non-interactive /model falls back cleanly when the gateway is down', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const captured = capture()
  const agent = fakeAgent()
  const run = runCli({
    input,
    output: captured.output,
    agent,
    bannerText: '',
    healthCheck: async () => [],
    fetchModels: async () => ({ ok: false, error: 'ECONNREFUSED' })
  })
  input.end('/model\n/exit\n')
  await run

  assert.match(captured.text, /Gagal memuat model dari .*ECONNREFUSED/)
  assert.match(captured.text, /Pakai \/model <nama>/)
  assert.equal(agent.calls.some(call => call[0] === 'setModel'), false)
})

test('the gateway catalog is cached for the session, so the second /model is instant', async () => {
  const input = new PassThrough()
  input.isTTY = false
  const captured = capture()
  const agent = fakeAgent()
  let calls = 0
  const run = runCli({
    input,
    output: captured.output,
    agent,
    bannerText: '',
    healthCheck: async () => [],
    fetchModels: async () => { calls++; return { ok: true, models: normalizeGatewayModels(gatewayPayload) } }
  })
  input.end('/model\n/model\n/exit\n')
  await run

  assert.equal(calls, 1, 'the second picker open reuses the cached catalog')
  assert.equal((captured.text.match(/antigravity \(ag\) · 2 model/g) || []).length, 2, 'both opens rendered the catalog')
})
