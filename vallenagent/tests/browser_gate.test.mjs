import test from 'node:test'
import assert from 'node:assert/strict'

import { BROWSER_LOCKED_MESSAGE, browserToolsUnlocked, browserUnlockRemaining, lockBrowserTools, resetBrowserGate, unlockBrowserTools } from '../dist/core/browser_gate.js'
import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'
import { buildAgentSystemPrompt } from '../dist/agent/agent_system_prompt.js'

registerBuiltinTools(false)

test('the browser gate starts locked, unlocks with a ttl, and expires', () => {
  resetBrowserGate()
  assert.equal(browserToolsUnlocked('s1'), false)

  unlockBrowserTools('s1', 60_000, 1_000_000)
  assert.equal(browserToolsUnlocked('s1', 1_030_000), true)
  assert.equal(browserUnlockRemaining('s1', 1_030_000), 30)
  assert.equal(browserToolsUnlocked('s1', 1_060_001), false, 'expires after the ttl')
  assert.equal(browserToolsUnlocked('other'), false, 'unlock is per session')

  unlockBrowserTools('s1')
  lockBrowserTools('s1')
  assert.equal(browserToolsUnlocked('s1'), false)
  resetBrowserGate()
})

test('browser_exec and browser_screenshot refuse to run while locked', async () => {
  resetBrowserGate()
  const exec = registry.get('browser_exec')
  const shot = registry.get('browser_screenshot')
  assert.ok(exec && shot)

  const execResult = JSON.parse(await exec.handler({ code: 'print(1)' }, { sessionId: 'locked-session', workingDir: process.cwd() }))
  assert.equal(execResult.error, BROWSER_LOCKED_MESSAGE)
  assert.match(execResult.error, /\/browser <task>/)

  const shotResult = JSON.parse(await shot.handler({ url: 'https://example.com' }, { sessionId: 'locked-session', workingDir: process.cwd(), turnNumber: 1 }))
  assert.equal(shotResult.success, false)
  assert.equal(shotResult.error, BROWSER_LOCKED_MESSAGE)

  // URL validation still runs first, so a bad URL keeps its own message.
  const badUrl = JSON.parse(await shot.handler({ url: 'file:///etc/passwd' }, { sessionId: 'locked-session', workingDir: process.cwd() }))
  assert.match(badUrl.error, /url must start with http/)
})

test('the system prompt tells the model when to delegate, screenshot and plan', () => {
  const { prompt } = buildAgentSystemPrompt({
    memoryStore: { formatForSystemPrompt: () => '' },
    todoStore: { formatForInjection: () => '' },
    skillLoader: { getFormattedIndex: () => '' },
    config: { terminal: { cwd: process.cwd() } }
  })

  assert.match(prompt, /# Delegation, Artifacts and Plan Mode/)
  assert.match(prompt, /background: true/)
  assert.match(prompt, /workspace: "branch"/)
  assert.match(prompt, /\.agents\/agents\/\*\.md/)
  assert.match(prompt, /Browser tools are on demand/)
  assert.match(prompt, /\/browser <task>/)
  assert.match(prompt, /browser_screenshot after any change that affects rendered UI/)
  assert.match(prompt, /more than five files/)
})
