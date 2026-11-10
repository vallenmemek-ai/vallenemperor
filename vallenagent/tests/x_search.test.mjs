import test from 'node:test'
import assert from 'node:assert/strict'

import xsearch from '../dist/core/x_search.js'
import toolsModule from '../dist/tools/tools.js'
const { buildXSearchUrl, formatXSearch, searchPosts, xBearerToken } = xsearch
const { registerBuiltinTools } = await import('../dist/tools/builtin_tools.js')
registerBuiltinTools()

test('x_search refuses clearly without a bearer token', async () => {
  const result = await searchPosts({ query: 'typescript', token: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /No X bearer token/)
  assert.match(result.hint, /X_BEARER_TOKEN/)
  assert.match(formatXSearch(result), /x_search failed/)

  assert.equal(xBearerToken({ X_BEARER_TOKEN: 'abc' }), 'abc')
  assert.equal(xBearerToken({ TWITTER_BEARER_TOKEN: 'def' }), 'def')
  assert.equal(xBearerToken({}), '')
})

test('the query URL is built with bounded max_results and useful fields', () => {
  const url = buildXSearchUrl('from:vercel', 5)
  assert.match(url, /^https:\/\/api\.x\.com\/2\/tweets\/search\/recent\?/)
  assert.match(url, /max_results=10/, 'below the API minimum is clamped to 10')
  assert.match(url, /tweet\.fields=created_at/)
  assert.match(url, /query=from%3Avercel/)
})

test('posts are parsed from the API payload with metrics and permalinks', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      json: async () => ({
        data: [{
          id: '12345',
          text: 'hello from the api',
          created_at: '2026-01-01T00:00:00.000Z',
          author_id: 'u1',
          public_metrics: { like_count: 7, retweet_count: 3 }
        }]
      })
    }
  }
  const result = await searchPosts({ query: 'hello', token: 'tok', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.posts.length, 1)
  assert.equal(result.posts[0].url, 'https://x.com/i/web/status/12345')
  assert.equal(result.posts[0].likes, 7)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  assert.match(formatXSearch(result), /1 post\(s\) for "hello"/)
})

test('API errors surface the status instead of pretending there were no results', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
  const result = await searchPosts({ query: 'x', token: 'tok', fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /X API 429: rate limited/)

  const tool = toolsModule.registry.get('x_search')
  assert.ok(tool, 'the tool is registered')
  const response = JSON.parse(await tool.handler({ query: 'anything' }, {}, new AbortController().signal))
  assert.equal(typeof response.ok, 'boolean')
})
