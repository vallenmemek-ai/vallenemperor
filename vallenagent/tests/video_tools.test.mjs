import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registry, registerBuiltinTools } from '../dist/tools/index.js'
import { findOnPath } from '../dist/core/platform.js'

registerBuiltinTools()

const call = async args => JSON.parse(await registry.execute('video_analyze', args, { workingDir: process.cwd() }))

test('video_analyze is registered and reports its ffmpeg dependency honestly', () => {
  const tool = registry.list().find(entry => entry.name === 'video_analyze')
  assert.ok(tool, 'video_analyze must be registered')
  assert.equal(tool.toolset, 'vision')
  assert.equal(typeof tool.checkFn, 'function')
})

test('video_analyze rejects a URL instead of pretending to download', async () => {
  const result = await call({ video_path: 'https://example.com/clip.mp4' })
  assert.match(result.error, /local file only/)
})

test('video_analyze reports a missing file', async () => {
  const result = await call({ video_path: '/definitely/not/here.mp4' })
  assert.match(result.error, /Video file not found/)
})

test('video_analyze rejects a directory', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-video-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = await call({ video_path: dir })
  assert.match(result.error, /Not a regular file/)
})

test('video_analyze fails clearly on a file that is not a video', { skip: findOnPath('ffmpeg') ? false : 'ffmpeg not installed' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-video-bad-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'not-a-video.mp4')
  writeFileSync(file, 'this is text, not a video')
  const result = await call({ video_path: file, frames: 2 })
  assert.equal(result.answer, undefined)
  assert.match(result.error, /could not decode|produced no frames/i)
})
