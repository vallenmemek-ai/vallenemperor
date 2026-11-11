import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registry, registerBuiltinTools } from '../dist/tools/index.js'
import { findOnPath } from '../dist/core/platform.js'

registerBuiltinTools()

const hasFfmpeg = Boolean(findOnPath('ffmpeg'))
// Handler-level checks only run when the tool is available: the registry refuses to
// call a tool whose checkFn is false, which is the honest behaviour — and exactly what
// the CI runner (no ffmpeg installed) exercises.
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg not installed; the tool is unavailable here' }

const call = async args => JSON.parse(await registry.execute('video_analyze', args, { workingDir: process.cwd() }))

test('video_analyze is registered and declares its ffmpeg dependency', () => {
  const tool = registry.list().find(entry => entry.name === 'video_analyze')
  assert.ok(tool, 'video_analyze must be registered')
  assert.equal(tool.toolset, 'vision')
  assert.equal(typeof tool.checkFn, 'function')
})

test('without ffmpeg the tool reports itself unavailable instead of failing oddly', async () => {
  const saved = process.env.PATH
  process.env.PATH = '/definitely-no-binaries-here'
  try {
    const result = await call({ video_path: 'whatever.mp4' })
    assert.match(result.error, /Tool unavailable: video_analyze/)
  } finally {
    process.env.PATH = saved
  }
})

test('video_analyze rejects a URL instead of pretending to download', needsFfmpeg, async () => {
  const result = await call({ video_path: 'https://example.com/clip.mp4' })
  assert.match(result.error, /local file only/)
})

test('video_analyze reports a missing file', needsFfmpeg, async () => {
  const result = await call({ video_path: '/definitely/not/here.mp4' })
  assert.match(result.error, /Video file not found/)
})

test('video_analyze rejects a directory', needsFfmpeg, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-video-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = await call({ video_path: dir })
  assert.match(result.error, /Not a regular file/)
})

test('video_analyze fails clearly on a file that is not a video', needsFfmpeg, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-video-bad-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'not-a-video.mp4')
  writeFileSync(file, 'this is text, not a video')
  const result = await call({ video_path: file, frames: 2 })
  assert.equal(result.answer, undefined)
  assert.match(result.error, /could not decode|produced no frames/i)
})
