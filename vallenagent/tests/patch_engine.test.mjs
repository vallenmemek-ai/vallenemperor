import test from 'node:test'
import assert from 'node:assert/strict'

import { fuzzyReplace, unescapeString, generateDiff } from '../dist/core/patch_engine.js'

test('fuzzyReplace applies an exact unique match', () => {
  const result = fuzzyReplace('const a = 1\nconst b = 2\n', 'const b = 2', 'const b = 3')
  assert.equal(result.strategy, 'exact')
  assert.equal(result.content, 'const a = 1\nconst b = 3\n')
})

test('fuzzyReplace rejects empty and identical old_string', () => {
  assert.throws(() => fuzzyReplace('abc', '', 'x'), /old_string must not be empty/)
  assert.throws(() => fuzzyReplace('abc', 'abc', 'abc'), /identical/)
})

test('fuzzyReplace rejects ambiguous exact matches unless replace_all is set', () => {
  assert.throws(() => fuzzyReplace('x\nx\n', 'x', 'y'), /2 exact matches/)
  const all = fuzzyReplace('x\nx\n', 'x', 'y', true)
  assert.equal(all.content, 'y\ny\n')
})

test('fuzzyReplace tolerates indentation drift and reports the strategy used', () => {
  const content = 'function f() {\n    return 1\n}\n'
  const result = fuzzyReplace(content, 'function f() {\n  return 1\n}', 'function f() {\n  return 2\n}')
  assert.notEqual(result.strategy, 'exact')
  assert.match(result.content, /return 2/)
})

test('unescapeString converts escaped sequences without double-unescaping', () => {
  assert.equal(unescapeString('a\\nb'), 'a\nb')
  assert.equal(unescapeString('a\\\\nb'), 'a\\nb')
  assert.equal(unescapeString('say \\"hi\\"'), 'say "hi"')
})

test('generateDiff marks added and removed lines', () => {
  const diff = generateDiff('a\nb', 'a\nc')
  assert.match(diff, /^-b$/m)
  assert.match(diff, /^\+c$/m)
})

// ---------- partial reads must not force a whole-file read for a unique edit ----------

const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { registry } = await import('../dist/tools/tools.js')
const { registerBuiltinTools } = await import('../dist/tools/builtin_tools.js')

registerBuiltinTools()

const contextFor = dir => ({ workingDir: dir, fileReadCoverage: new Map(), sessionId: 'patch-test' })
const run = (name, args, context) => registry.execute(name, args, context)

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallenemperor-patch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const bigFile = (target = 'const TARGET = 1') => Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).with(149, target).join('\n')

test('a partial read plus a unique old_string is enough to patch', async t => {
  const dir = workspace(t)
  writeFileSync(join(dir, 'big.ts'), bigFile())
  const context = contextFor(dir)

  await run('read_file', { path: 'big.ts', offset: 1, limit: 20 }, context)
  const result = JSON.parse(await run('patch', { path: 'big.ts', old_string: 'const TARGET = 1', new_string: 'const TARGET = 2' }, context))

  assert.equal(result.error, undefined, `patch must succeed, got ${JSON.stringify(result)}`)
  assert.match(readFileSync(join(dir, 'big.ts'), 'utf8'), /const TARGET = 2/)
})

test('a partial read plus an ambiguous old_string is still refused', async t => {
  const dir = workspace(t)
  writeFileSync(join(dir, 'dup.txt'), 'alpha\ndup\nbeta\ndup\n')
  const context = contextFor(dir)

  await run('read_file', { path: 'dup.txt', offset: 1, limit: 1 }, context)
  const result = JSON.parse(await run('patch', { path: 'dup.txt', old_string: 'dup', new_string: 'gone' }, context))

  assert.match(String(result.error), /partial read is accepted only when old_string matches exactly once/)
  assert.match(readFileSync(join(dir, 'dup.txt'), 'utf8'), /dup/, 'file is untouched')
})

test('a file that changed on disk after the read is still refused as stale', async t => {
  const dir = workspace(t)
  writeFileSync(join(dir, 'moved.txt'), 'one\ntwo\n')
  const context = contextFor(dir)

  await run('read_file', { path: 'moved.txt' }, context)
  writeFileSync(join(dir, 'moved.txt'), 'one\ntwo changed elsewhere\n')
  const result = JSON.parse(await run('patch', { path: 'moved.txt', old_string: 'two', new_string: 'three' }, context))

  assert.match(String(result.error), /changed since read_file/)
})

test('a file that was never read is still refused as unread', async t => {
  const dir = workspace(t)
  writeFileSync(join(dir, 'never.txt'), 'content\n')
  const result = JSON.parse(await run('patch', { path: 'never.txt', old_string: 'content', new_string: 'other' }, contextFor(dir)))

  assert.match(String(result.error), /read it with read_file first/)
})
