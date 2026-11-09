import test from 'node:test'
import assert from 'node:assert/strict'

import { callProviderWithRetry, continueTruncatedResponse } from '../dist/agent/turn_provider_call.js'

const reply = (content, finish = 'stop') => ({
  id: 'c',
  model: 'm',
  choices: [{ finish_reason: finish, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
})

const baseRetryDeps = overrides => ({
  call: async () => reply('ok'),
  messages: [{ role: 'user', content: 'hi' }],
  plainMessages: [{ role: 'user', content: 'hi' }],
  promptCacheEnabled: false,
  estimatedTokens: 100,
  contextWindow: 1000,
  tools: [],
  outputTokenAllowance: 500,
  buildRetry: () => null,
  disablePromptCache: () => {},
  replaceHistory: () => {},
  ...overrides
})

test('a provider that rejects cache markers is retried once without them', async () => {
  const seen = []
  let disabled = false
  const marked = [{ role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } }]
  const response = await callProviderWithRetry(baseRetryDeps({
    promptCacheEnabled: true,
    messages: marked,
    plainMessages: [{ role: 'user', content: 'hi' }],
    disablePromptCache: () => { disabled = true },
    call: async payload => {
      seen.push(payload)
      if (seen.length === 1) throw new Error('Provider API error: 400 invalid request: unknown field cache_control')
      return reply('recovered')
    }
  }))

  assert.equal(seen.length, 2, 'exactly one retry')
  assert.equal(disabled, true, 'prompt caching is switched off after rejection')
  assert.ok(!('cache_control' in seen[1][0]), 'the retry payload has no cache markers')
  assert.equal(response.choices[0].message.content, 'recovered')
})

test('an unrelated provider failure is rethrown without a retry', async () => {
  let calls = 0
  await assert.rejects(
    callProviderWithRetry(baseRetryDeps({
      call: async () => { calls++; throw new Error('rate limited') }
    })),
    /rate limited/
  )
  assert.equal(calls, 1, 'no silent retry for unknown failures')
})

test('a context overflow retries once with compacted history', async () => {
  let calls = 0
  let replaced = null
  const response = await callProviderWithRetry(baseRetryDeps({
    call: async () => {
      calls++
      if (calls === 1) throw new Error('context length exceeded: maximum context window is 8192 tokens')
      return reply('compacted ok')
    },
    buildRetry: () => ({
      retryMessages: [{ role: 'user', content: 'summarized' }],
      compactedHistory: [{ role: 'user', content: 'summarized' }]
    }),
    replaceHistory: history => { replaced = history }
  }))

  assert.equal(calls, 2)
  assert.deepEqual(replaced, [{ role: 'user', content: 'summarized' }], 'the compacted history replaces the live one')
  assert.equal(response.choices[0].message.content, 'compacted ok')
})

test('an overflow with no compaction available still fails loudly', async () => {
  await assert.rejects(
    callProviderWithRetry(baseRetryDeps({
      call: async () => { throw new Error('context length exceeded') },
      buildRetry: () => null
    })),
    /context length exceeded/
  )
})

const continuationDeps = overrides => ({
  call: async () => reply('ok'),
  requestMessages: [{ role: 'user', content: 'write a long answer' }],
  tools: [],
  contextWindow: 10_000,
  estimatedTokens: 100,
  enforceTokenBudget: false,
  budgetTokensUsed: 0,
  perRequestCap: 500,
  response: reply('first half ', 'length'),
  ...overrides
})

test('a truncated text answer is continued and stitched together', async () => {
  let calls = 0
  const result = await continueTruncatedResponse(continuationDeps({
    call: async () => { calls++; return reply('second half') }
  }))

  assert.equal(calls, 1, 'one continuation request')
  assert.equal(result.responseTruncated, false)
  assert.equal(result.assistantMessage.content, 'first half second half')
  assert.equal(result.continuationText, 'first half ')
})

test('a truncated tool call is not continued and loses its partial tool_calls', async () => {
  let calls = 0
  const truncatedToolCall = {
    ...reply('', 'length'),
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'patch', arguments: '{' } }] } }]
  }
  const result = await continueTruncatedResponse(continuationDeps({
    response: truncatedToolCall,
    call: async () => { calls++; return reply('should not happen') }
  }))

  assert.equal(calls, 0, 'a broken tool call cannot be resumed')
  assert.equal(result.responseTruncated, true)
  assert.equal(result.assistantMessage.tool_calls, undefined)
})

test('continuation stops when the turn token budget is spent', async () => {
  let calls = 0
  const result = await continueTruncatedResponse(continuationDeps({
    enforceTokenBudget: true,
    tokenBudget: 1000,
    budgetTokensUsed: 995,
    call: async () => { calls++; return reply('more') }
  }))

  assert.equal(calls, 0)
  assert.equal(result.responseTruncated, true)
})

test('continuation gives up after two retries instead of looping', async () => {
  let calls = 0
  const result = await continueTruncatedResponse(continuationDeps({
    call: async () => { calls++; return reply('more text ', 'length') }
  }))

  assert.equal(calls, 2, 'at most two continuation requests')
  assert.equal(result.responseTruncated, true)
})
