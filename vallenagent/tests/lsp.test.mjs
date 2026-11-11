import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lsp from '../dist/core/lsp.js'
const { MessageReader, collectDiagnostics, encodeMessage, formatDiagnostics, listLanguageServers, resolveLanguageServer } = lsp

test('language servers are resolved by extension and never guessed', () => {
  assert.equal(resolveLanguageServer('app.py').command, 'pyright-langserver')
  assert.equal(resolveLanguageServer('main.go').command, 'gopls')
  assert.equal(resolveLanguageServer('lib.rs').command, 'rust-analyzer')
  assert.equal(resolveLanguageServer('notes.txt'), null)
  assert.ok(listLanguageServers().length >= 8)
})

test('Content-Length framing round-trips, including split chunks', () => {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  const reader = new MessageReader()
  assert.deepEqual(reader.push(encoded.subarray(0, 10)), [], 'partial header yields nothing')
  const rest = reader.push(encoded.subarray(10))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].result.ok, true)

  const two = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })])
  const messages = new MessageReader().push(two)
  assert.deepEqual(messages.map(item => item.id), [1, 2])
})

test('diagnostics are collected from a real LSP process over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-lsp-'))
  try {
    const file = join(dir, 'sample.py')
    writeFileSync(file, 'def f():\n    return x\n')
    // .pathname yields '/D:/...' on Windows, which node cannot open; fileURLToPath is correct.
    const server = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
    const result = await collectDiagnostics({
      file,
      timeoutMs: 15_000,
      spec: { language: 'python', command: process.execPath, args: [server] }
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.diagnostics.length, 1)
    assert.equal(result.diagnostics[0].message, 'fake: undefined variable x')
    assert.equal(result.diagnostics[0].line, 2)
    assert.equal(result.diagnostics[0].character, 4)
    assert.match(formatDiagnostics(result), /error 3:5 {2}fake: undefined variable x \[fake-lsp\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing servers and missing files fail clearly instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-lsp2-'))
  try {
    const missing = await collectDiagnostics({ file: join(dir, 'nope.py') })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /File not found/)

    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    const unsupported = await collectDiagnostics({ file })
    assert.equal(unsupported.ok, false)
    assert.match(unsupported.error, /No language server mapped/)

    const brokenFile = join(dir, 'b.py')
    writeFileSync(brokenFile, 'x = 1\n')
    const broken = await collectDiagnostics({ file: brokenFile, timeoutMs: 3000, spec: { language: 'python', command: '/nonexistent/lsp', args: [] } })
    assert.equal(broken.ok, false)
    assert.match(broken.error, /nonexistent|exited|ENOENT/)
    assert.match(formatDiagnostics(broken), /LSP unavailable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
