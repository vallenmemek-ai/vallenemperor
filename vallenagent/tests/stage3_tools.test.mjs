import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registry, registerBuiltinTools } from '../dist/tools/index.js'
import { detectTtsEngine } from '../dist/tools/builtin_tools/tts_tools.js'
import { THEME_NAMES, readTheme, writeTheme } from '../dist/core/theme_store.js'
import { loadConfig } from '../dist/core/config.js'

registerBuiltinTools()

function withHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-stage3-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPOR_HOME = undefined
  process.env.VALLENEMPEROR_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('clarify timeout has a config default', () => {
  const config = loadConfig()
  assert.equal(typeof config.gateway?.clarify_timeout_ms, 'number')
  assert.ok(config.gateway.clarify_timeout_ms >= 1000)
})

test('set_theme reports, saves and rejects unknown themes', async t => {
  const home = withHome(t)
  const call = async args => JSON.parse(await registry.execute('set_theme', args, {}))

  const status = await call({ action: 'status' })
  assert.equal(status.theme, null)
  assert.deepEqual(status.available, [...THEME_NAMES])

  const saved = await call({ action: 'set', name: 'nord' })
  assert.equal(saved.theme, 'nord')
  assert.equal(readFileSync(join(home, 'cli_theme'), 'utf8').trim(), 'nord', 'the CLI reads this exact file')
  assert.equal(readTheme(), 'nord')

  const rejected = await call({ action: 'set', name: 'neon' })
  // The schema enum rejects it before the handler runs; either message is honest.
  assert.match(rejected.error, /Unknown theme|must be one of/)
  assert.equal(readTheme(), 'nord', 'a rejected theme must not overwrite the saved one')
})

test('writeTheme refuses path-like input', () => {
  const result = writeTheme('../../etc/passwd')
  assert.equal(result.ok, false)
  assert.match(result.error, /Unknown theme/)
})

test('text_to_speech validates its input before touching an engine', async () => {
  const call = async args => JSON.parse(await registry.execute('text_to_speech', args, {}))
  assert.match((await call({ text: '' })).error, /text is required/)
  assert.match((await call({ text: 'x'.repeat(2001) })).error, /too long/)
})

test('text_to_speech either speaks or explains why it cannot', async () => {
  const result = JSON.parse(await registry.execute('text_to_speech', { text: 'halo' }, {}))
  if (result.spoken) {
    assert.equal(typeof result.engine, 'string')
  } else {
    assert.match(result.error, /No speech engine|engine failed|spawn/i)
  }
})

test('detectTtsEngine honours a configured command over auto-detection', () => {
  const engine = detectTtsEngine({ tts: { command: 'my-tts' } })
  assert.equal(engine.command, 'my-tts')
  assert.deepEqual(engine.args('hi', 'v'), ['-v', 'v', 'hi'])
  assert.deepEqual(engine.args('hi', ''), ['hi'])
})
