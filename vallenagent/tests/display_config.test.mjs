import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { formatResponseBox, formatToolStart, cutePath, sanitizeControlChars, getToolEmoji } from '../dist/core/display.js'
import { supportsPromptCache, markCachePrefix, stripCacheMarkers, hasCacheMarkers } from '../dist/agent/prompt_cache.js'
import { isPrivateAddress } from '../dist/core/network_safety.js'
import { getVallenHome } from '../dist/core/config.js'

test('formatResponseBox frames content with the requested label', () => {
  const strip = s => s.replace(/\u001b\[[0-9;]*m/g, '')
  const box = formatResponseBox('hello', ' ☤ VallenEmperor ', 60)
  const lines = box.split('\n').map(strip)
  assert.ok(lines[0].startsWith('╭'), lines[0])
  assert.ok(lines[0].includes('VallenEmperor'))
  assert.ok(lines[lines.length - 1].startsWith('╰'))
  assert.ok(lines.some(line => line.includes('hello')))
})

test('cutePath shortens paths under cwd', () => {
  assert.equal(cutePath(join('/work', 'proj', 'src', 'a.ts'), join('/work', 'proj')), join('src', 'a.ts'))
})

test('sanitizeControlChars replaces raw control bytes with spaces', () => {
  assert.equal(sanitizeControlChars('a\u0007b\nc'), 'a b c')
  assert.equal(sanitizeControlChars('\u001b[31mred\u001b[0m'), 'red')
})

test('getToolEmoji and formatToolStart describe a tool call', () => {
  assert.equal(typeof getToolEmoji('read_file'), 'string')
  assert.match(formatToolStart('read_file', { path: 'src/a.ts' }), /src[\\/]a\.ts/)
})

test('supportsPromptCache matches capable models and honors the off switch', () => {
  const saved = process.env.VALLENEMPEROR_PROMPT_CACHE
  try {
    delete process.env.VALLENEMPEROR_PROMPT_CACHE
    assert.equal(supportsPromptCache('claude-sonnet-4'), true)
    assert.equal(supportsPromptCache('some-random-local-model'), false)
    process.env.VALLENEMPEROR_PROMPT_CACHE = 'off'
    assert.equal(supportsPromptCache('claude-sonnet-4'), false)
  } finally {
    if (saved === undefined) delete process.env.VALLENEMPEROR_PROMPT_CACHE
    else process.env.VALLENEMPEROR_PROMPT_CACHE = saved
  }
})

test('cache markers are added to the prefix and stripped again', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
  const marked = markCachePrefix(messages, { prefixMessages: 1 })
  assert.equal(hasCacheMarkers(marked), true)
  assert.deepEqual(marked[1], messages[1], 'messages past the prefix stay untouched')
  const stripped = stripCacheMarkers(marked)
  assert.equal(hasCacheMarkers(stripped), false)
  assert.deepEqual(stripped, messages)
})

test('isPrivateAddress flags loopback, RFC1918, link-local and public ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`)
  }
})

test('getVallenHome defaults to ~/.vallenemperor and honors the env override', () => {
  const saved = process.env.VALLENEMPEROR_HOME
  try {
    delete process.env.VALLENEMPEROR_HOME
    assert.equal(getVallenHome(), join(homedir(), '.vallenemperor'))
    process.env.VALLENEMPEROR_HOME = '/tmp/vallen-custom'
    assert.equal(getVallenHome(), '/tmp/vallen-custom')
  } finally {
    if (saved === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = saved
  }
})
