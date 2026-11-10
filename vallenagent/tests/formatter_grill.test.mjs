import test from 'node:test'
import assert from 'node:assert/strict'

import { formatFile, shouldFormat } from '../dist/core/formatter.js'
import { buildGrillPrompt } from '../dist/agent/grill_prompt.js'

test('the formatter runs only for configured extensions and substitutes {file}', () => {
  const calls = []
  const config = { command: 'prettier --write {file}', extensions: ['.ts'] }
  assert.equal(shouldFormat('src/a.ts', config), true)
  assert.equal(shouldFormat('src/a.py', config), false)

  const ok = formatFile({ file: '/repo/a.ts', cwd: '/repo', config, runner: (command, cwd) => { calls.push({ command, cwd }); return { status: 0, stdout: 'formatted' } } })
  assert.equal(ok.ran, true)
  assert.equal(ok.ok, true)
  assert.equal(calls[0].command, 'prettier --write /repo/a.ts')
  assert.equal(calls[0].cwd, '/repo')

  const skipped = formatFile({ file: '/repo/a.py', config, runner: () => { throw new Error('should not run') } })
  assert.equal(skipped.ran, false)

  const failed = formatFile({ file: '/repo/b.ts', config, runner: () => ({ status: 1, stderr: 'syntax error' }) })
  assert.equal(failed.ran, true)
  assert.equal(failed.ok, false)
  assert.match(failed.output, /syntax error/)

  assert.equal(shouldFormat('a.ts', undefined), false)
})

test('the grill prompt interviews one question at a time with a recommended answer', () => {
  const prompt = buildGrillPrompt('add rate limiting')
  assert.match(prompt, /\[\/grill-me — interview before building\]/)
  assert.match(prompt, /add rate limiting/)
  assert.match(prompt, /Ask ONE question at a time/)
  assert.match(prompt, /recommended answer first/)
  assert.match(prompt, /at most 5 questions/)
  assert.match(prompt, /Do not write code or edit files in this turn/)
  assert.match(buildGrillPrompt(''), /No task was given/)
})
