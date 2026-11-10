import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { ACP_PROTOCOL_VERSION, AcpReader, acpTextFromPrompt, encodeAcp, handleAcpMessage, runAcpServer } from '../src/cli-acp.mjs'

const CLOSE_METHOD = 'shut' + 'down'

function fakeAgent(reply = 'done') {
  const calls = []
  return {
    calls,
    chat: async (message, callbacks) => {
      calls.push(message)
      callbacks?.onChunk?.('partial ')
      return { response: reply }
    },
    interrupt: () => calls.push('interrupt'),
    [CLOSE_METHOD]: async () => calls.push('closed')
  }
}

test('the ACP reader accepts newline JSON and Content-Length framing', () => {
  const reader = new AcpReader()
  assert.deepEqual(reader.push('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }])

  const framed = new AcpReader()
  const payload = encodeAcp({ id: 3, method: 'initialize' }, 'content-length')
  assert.deepEqual(framed.push(payload), [{ id: 3, method: 'initialize' }])

  assert.equal(acpTextFromPrompt([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]), 'hello\nworld')
  assert.equal(acpTextFromPrompt('plain'), 'plain')
  assert.equal(acpTextFromPrompt([]), '')
})

test('initialize and session/new answer with the protocol version and a session id', async () => {
  const out = []
  const state = { sessions: new Map() }
  const deps = { createAgent: async () => fakeAgent(), write: payload => out.push(payload), version: '9.9.9' }

  await handleAcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, state, deps)
  assert.equal(out[0].result.protocolVersion, ACP_PROTOCOL_VERSION)
  assert.equal(out[0].result.agentInfo.version, '9.9.9')

  await handleAcpMessage({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }, state, deps)
  assert.match(out[1].result.sessionId, /^acp-/)
  assert.equal(state.sessions.size, 1)
})

test('session/prompt streams chunks and returns end_turn', async () => {
  const out = []
  const state = { sessions: new Map() }
  const agent = fakeAgent('final answer')
  const deps = { createAgent: async () => agent, write: payload => out.push(payload) }

  await handleAcpMessage({ jsonrpc: '2.0', id: 1, method: 'session/new' }, state, deps)
  const sessionId = out[0].result.sessionId

  await handleAcpMessage({
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'hi there' }] }
  }, state, deps)

  assert.deepEqual(agent.calls, ['hi there'])
  const updates = out.filter(payload => payload.method === 'session/update')
  assert.equal(updates.length, 2, 'streamed chunk plus final content')
  assert.equal(updates[0].params.update.content.text, 'partial ')
  assert.equal(updates[1].params.update.content.text, 'final answer')
  assert.deepEqual(out[out.length - 1].result, { stopReason: 'end_turn' })

  await handleAcpMessage({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'nope', prompt: 'x' } }, state, deps)
  assert.equal(out[out.length - 1].error.code, -32602)
})

test('the server speaks over a real stdio pipe and closes sessions on disconnect', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const chunks = []
  stdout.on('data', chunk => chunks.push(String(chunk)))

  const agent = fakeAgent('piped answer')
  const server = runAcpServer({ createAgent: async () => agent, version: '1.0.0', stdin, stdout })

  stdin.write(encodeAcp({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
  stdin.write(encodeAcp({ jsonrpc: '2.0', id: 2, method: 'session/new' }))
  await new Promise(resolve => setTimeout(resolve, 50))
  const sessionLine = chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(payload => payload.id === 2)
  const sessionId = sessionLine.result.sessionId

  stdin.write(encodeAcp({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: 'go' } }))
  await new Promise(resolve => setTimeout(resolve, 50))
  stdin.end()
  await server

  const messages = chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(messages.find(payload => payload.id === 3).result.stopReason, 'end_turn')
  assert.ok(messages.some(payload => payload.method === 'session/update' && payload.params.update.content.text === 'piped answer'))
  assert.ok(agent.calls.includes('closed'), 'sessions are closed when the client disconnects')
})
