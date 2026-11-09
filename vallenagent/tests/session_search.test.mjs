import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { tokenize, searchSessions, viewSession, formatHits, indexSessionFile, ensureSessionDir } from '../dist/session/session_search.js'

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-search-'))
  const saved = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  mkdirSync(join(home, 'sessions'), { recursive: true })
  t.after(() => {
    if (saved === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function writeSession(home, id, messages) {
  const file = join(home, 'sessions', `${id}.json`)
  writeFileSync(file, JSON.stringify({ sessionId: id, messages }), 'utf8')
  return file
}

test('tokenize lowercases, drops stopwords and short terms, and dedupes', () => {
  assert.deepEqual(tokenize('Fix the AUTH bug and the auth again'), ['fix', 'auth', 'bug', 'again'])
  assert.deepEqual(tokenize('dan untuk dengan the and'), [])
  assert.deepEqual(tokenize(''), [])
})

test('tokenize caps the number of terms at 12', () => {
  const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ')
  assert.equal(tokenize(many).length, 12)
})

test('searchSessions finds a session by content and reports the matched terms', t => {
  const home = tempHome(t)
  writeSession(home, 'sess-alpha', [
    { role: 'user', content: 'please fix the websocket reconnect loop' },
    { role: 'assistant', content: 'patched reconnect handler' }
  ])
  const hits = searchSessions('websocket reconnect')
  assert.ok(hits.length >= 1, 'expected at least one hit')
  assert.equal(hits[0].sessionId, 'sess-alpha')
  assert.ok(hits[0].snippet.length > 0)
  assert.ok(hits[0].matchedTerms.length >= 1)
})

test('searchSessions returns nothing for an empty or stopword-only query', t => {
  tempHome(t)
  assert.deepEqual(searchSessions(''), [])
  assert.deepEqual(searchSessions('dan untuk dengan'), [])
})

test('searchSessions honours the limit option', t => {
  const home = tempHome(t)
  for (let i = 0; i < 5; i++) {
    writeSession(home, `sess-${i}`, [{ role: 'user', content: `deployment pipeline number ${i}` }])
  }
  assert.equal(searchSessions('deployment pipeline', { limit: 2 }).length, 2)
})

test('indexSessionFile makes a session searchable without a full resync', t => {
  const home = tempHome(t)
  const file = writeSession(home, 'sess-indexed', [{ role: 'user', content: 'unique-marker-zebra' }])
  indexSessionFile(file)
  const hits = searchSessions('zebra')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sessionId, 'sess-indexed')
})

test('viewSession returns messages with offset and limit', t => {
  const home = tempHome(t)
  writeSession(home, 'sess-view', [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' }
  ])
  const page = viewSession('sess-view', { offset: 1, limit: 1 })
  assert.equal(page.total, 3)
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].content, 'two')
})

test('viewSession refuses path traversal and unknown ids', t => {
  tempHome(t)
  assert.equal(viewSession('../etc/passwd'), null)
  assert.equal(viewSession('a/b'), null)
  assert.equal(viewSession(''), null)
  assert.equal(viewSession('does-not-exist'), null)
})

test('formatHits renders numbered hits and an empty message', () => {
  assert.equal(formatHits([]), 'Tidak ada sesi lama yang cocok.')
  const text = formatHits([{ sessionId: 's1', file: '/x', score: 1.23456, snippet: 'hello', matchedTerms: ['hello'] }])
  assert.match(text, /^1\. s1 \(skor 1\.235; term: hello\)/)
  assert.match(text, /hello/)
})

test('ensureSessionDir creates the directory with owner-only permissions', t => {
  const home = tempHome(t)
  const dir = join(home, 'nested', 'sessions')
  assert.equal(ensureSessionDir(dir), dir)
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700)
})
