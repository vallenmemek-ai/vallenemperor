import test from 'node:test'
import assert from 'node:assert/strict'

import browser from '../dist/tools/builtin_tools/browser_tools.js'
import toolsModule from '../dist/tools/tools.js'
const { buildRecordingScript } = browser
const { registerBuiltinTools } = await import('../dist/tools/builtin_tools.js')
registerBuiltinTools()
const core = { registry: toolsModule.registry }

test('the recording script uses Playwright video capture with a bounded wait', () => {
  const code = buildRecordingScript({ url: 'https://example.com/app', seconds: 7, width: 1280, height: 720, videoDir: '/tmp/rec' })
  assert.match(code, /from playwright\.sync_api import sync_playwright/)
  assert.match(code, /record_video_dir="\/tmp\/rec"/)
  assert.match(code, /record_video_size=\{"width": 1280, "height": 720\}/)
  assert.match(code, /page\.goto\("https:\/\/example\.com\/app"/)
  assert.match(code, /page\.wait_for_timeout\(7000\)/)
  assert.match(code, /context\.close\(\)/)
  assert.match(code, /user_data_dir="\/tmp\/rec\/profile"/)
})

test('browser_record refuses non-http URLs and stays behind the browser gate', async () => {
  const tool = core.registry.get('browser_record')
  assert.ok(tool, 'the tool is registered')

  const bad = JSON.parse(await tool.handler({ url: 'file:///etc/passwd' }, { sessionId: 's1', turnNumber: 1 }, new AbortController().signal))
  assert.equal(bad.success, false)
  assert.match(bad.error, /http:\/\/ or https:\/\//)

  const locked = JSON.parse(await tool.handler({ url: 'https://example.com' }, { sessionId: 'locked-session', turnNumber: 1 }, new AbortController().signal))
  assert.equal(locked.success, false)
  assert.match(String(locked.error), /browser|unlock|\/browser/i)
})

test('the recording artifact kind maps to a webm file name', async () => {
  const store = await import('../dist/agent/artifact_store.js')
  const name = store.artifactFileName('recording', 'example.com')
  assert.match(name, /recording.*\.png$|recording.*webm$/)
})
