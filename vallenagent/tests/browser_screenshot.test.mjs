import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'
import { resetBrowserGate, unlockBrowserTools } from '../dist/core/browser_gate.js'

registerBuiltinTools()

async function screenshot(args, context = {}) {
  const tool = registry.get('browser_screenshot')
  assert.ok(tool, 'browser_screenshot must be registered')
  return JSON.parse(await tool.handler(args, { workingDir: process.cwd(), sessionId: 'shot-test', turnNumber: 2, ...context }))
}

test('browser_screenshot is registered as a browser-use tool that requires a url', () => {
  const tool = registry.get('browser_screenshot')
  assert.ok(tool)
  assert.equal(tool.toolset, 'browser-use')
  assert.deepEqual(tool.schema.parameters.required, ['url'])
  assert.ok(tool.schema.description.includes('artifact'), 'description must mention artifacts so the model knows the output is reviewable')
})

test('browser_screenshot rejects non-http urls and malformed sessions before spawning anything', async () => {
  resetBrowserGate()
  unlockBrowserTools('shot-test')
  unlockBrowserTools(undefined)
  assert.match((await screenshot({})).error, /url must start with http/)

  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'example.com']) {
    const result = await screenshot({ url })
    assert.equal(result.success, false, `${url} must be rejected`)
    assert.match(result.error, /url must start with http/)
  }

  const badSession = await screenshot({ url: 'https://example.com', session: 42 })
  assert.equal(badSession.success, false)
  assert.match(badSession.error, /session name must be a string/)

  const anonymous = await screenshot({ url: 'https://example.com', session: 'keep' }, { sessionId: undefined })
  assert.equal(anonymous.success, false)
  assert.match(anonymous.error, /owner-scoped agent session/)
})

test('browser_screenshot never throws and only reports a path inside the artifact directory', async () => {
  resetBrowserGate()
  unlockBrowserTools('shot-test')
  const home = mkdtempSync(join(tmpdir(), 'vallen-shot-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    // Depending on the machine, playwright may or may not exist. Either way the contract holds:
    // success => the file exists under <home>/artifacts; failure => a readable error and no path.
    const result = await screenshot({ url: 'https://example.com', timeout_s: 10 })
    if (result.success) {
      assert.ok(result.path.startsWith(join(home, 'artifacts')), 'screenshots must land in the artifact store')
      assert.equal(result.kind, 'screenshot')
      assert.ok(result.bytes > 0)
    } else {
      assert.equal(typeof result.error, 'string')
      assert.ok(result.error.length > 0)
      assert.equal(result.path, undefined)
    }
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
