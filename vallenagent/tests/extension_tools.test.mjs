import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import extTools from '../dist/core/extension_tools.js'
import packModule from '../dist/core/extension_pack.js'
const { formatExtensionTools, loadExtensionTools } = extTools
const { installExtensionPack, readExtensionPack } = packModule
const core = await import('../dist/index.js')

const GOOD_TOOL = `export default {
  name: 'pack_hello',
  description: 'Say hello from an installed extension pack.',
  parameters: { type: 'object', properties: {} },
  handler: () => JSON.stringify({ hello: true })
}
`

function makePack(root) {
  const packDir = join(root, 'hello-pack')
  mkdirSync(join(packDir, 'tools'), { recursive: true })
  writeFileSync(join(packDir, 'tools', 'hello.mjs'), GOOD_TOOL)
  writeFileSync(join(packDir, 'extension.json'), JSON.stringify({ name: 'hello-pack', version: '1.0.0', tools: ['tools/hello.mjs'] }))
  return packDir
}

test('pack tools are never loaded without an explicit opt-in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-exttools-off-'))
  try {
    const packDir = makePack(home)
    const pack = readExtensionPack(packDir)
    installExtensionPack(pack, home)

    const off = await loadExtensionTools({ home, allow: false })
    assert.equal(off.allowed, false)
    assert.equal(off.tools.length, 0)
    assert.match(formatExtensionTools(off), /allow_tools is false/)

    const on = await loadExtensionTools({ home, allow: true })
    assert.equal(on.allowed, true)
    assert.equal(on.tools.length, 1)
    assert.equal(on.tools[0].definition.name, 'pack_hello')
    assert.equal(on.tools[0].pack, 'hello-pack')
    assert.match(formatExtensionTools(on), /1 extension tool\(s\) loaded/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('invalid names, builtin shadowing and broken modules are rejected with reasons', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-exttools-bad-'))
  try {
    const dir = join(home, 'extensions', 'bad', 'tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.mjs'), `export default [
      { name: 'Bad Name', description: 'invalid characters in the name', handler: () => 'x' },
      { name: 'read_file', description: 'tries to shadow a builtin tool', handler: () => 'x' },
      { name: 'no_handler', description: 'has no handler function at all' }
    ]\n`)
    writeFileSync(join(dir, 'broken.mjs'), 'export default {{{')

    const result = await loadExtensionTools({ home, allow: true, builtinNames: ['read_file'] })
    assert.equal(result.tools.length, 0)
    assert.ok(result.errors.length >= 3, `expected several errors, got ${JSON.stringify(result.errors)}`)
    assert.ok(result.errors.some(error => /invalid tool name/.test(error)))
    assert.ok(result.errors.some(error => /shadow a builtin/.test(error)))
    assert.ok(result.errors.some(error => /no handler/.test(error)))
    assert.ok(result.errors.some(error => /broken\.mjs/.test(error)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/extensions tools reports the opt-in state through the command handler', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-exttools-cmd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const packDir = makePack(home)
    installExtensionPack(readExtensionPack(packDir), home)

    const offCtx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: home } }, getSessionId: () => 'x' } }
    const off = await core.handleCommand(offCtx, '/extensions tools')
    assert.match(off.response, /allow_tools is false/)

    const onCtx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: home }, extensions: { allow_tools: true } }, getSessionId: () => 'x' } }
    const on = await core.handleCommand(onCtx, '/extensions tools')
    assert.match(on.response, /pack_hello/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
