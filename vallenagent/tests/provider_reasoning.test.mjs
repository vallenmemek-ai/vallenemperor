import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const providers = await import('../dist/providers/providers.js')
const { createProvider } = providers

/** Streams SSE the way OpenAI-compatible gateways do: reasoning deltas first, then content. */
async function startStreamingProvider() {
  const server = createServer((request, response) => {
    request.on('data', () => { })
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
      send({ choices: [{ delta: { reasoning_content: 'step one\n' } }] })
      send({ choices: [{ delta: { reasoning_content: 'step two' } }] })
      send({ choices: [{ delta: { content: 'final ' } }] })
      send({ choices: [{ delta: { content: 'answer' } }] })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

test('streamed reasoning deltas reach onReasoning and are returned', async () => {
  const { server, port } = await startStreamingProvider()
  try {
    const provider = createProvider('test', `http://127.0.0.1:${port}/v1`, 'key', 'test-model')
    const reasoning = []
    const chunks = []
    const response = await provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onChunk: chunk => chunks.push(chunk),
      onReasoning: chunk => reasoning.push(chunk)
    })
    assert.deepEqual(reasoning, ['step one\n', 'step two'])
    assert.equal(reasoning.join(''), 'step one\nstep two')
    assert.deepEqual(chunks, ['final ', 'answer'])
    assert.equal(response.reasoning, 'step one\nstep two', 'the assembled reasoning rides along')
    assert.equal(response.choices[0].message.content, 'final answer')
  } finally {
    server.close()
  }
})

test('a provider without reasoning support simply reports none', async () => {
  const server = createServer((request, response) => {
    request.on('data', () => { })
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'plain' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const provider = createProvider('test', `http://127.0.0.1:${server.address().port}/v1`, 'key', 'test-model')
    const reasoning = []
    const response = await provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onChunk: () => { },
      onReasoning: chunk => reasoning.push(chunk)
    })
    assert.deepEqual(reasoning, [])
    assert.equal(response.reasoning, undefined, 'no reasoning key when the provider sends none')
    assert.equal(response.choices[0].message.content, 'plain')
  } finally {
    server.close()
  }
})

test('non-stream responses surface message.reasoning_content once', async () => {
  const server = createServer((request, response) => {
    request.on('data', () => { })
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        id: 'x', model: 'test-model',
        choices: [{ message: { role: 'assistant', content: 'done', reasoning_content: 'because reasons' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const provider = createProvider('test', `http://127.0.0.1:${server.address().port}/v1`, 'key', 'test-model')
    const reasoning = []
    const response = await provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      onReasoning: chunk => reasoning.push(chunk)
    })
    assert.deepEqual(reasoning, ['because reasons'])
    assert.equal(response.reasoning, 'because reasons')
  } finally {
    server.close()
  }
})
