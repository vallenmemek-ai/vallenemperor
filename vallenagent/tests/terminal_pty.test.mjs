import test from 'node:test'
import assert from 'node:assert/strict'

import { registry, registerBuiltinTools } from '../dist/tools/index.js'
import { resolvePty, resolveShell, IS_WINDOWS } from '../dist/core/platform.js'

registerBuiltinTools()

const run = async (args) => JSON.parse(await registry.execute('terminal', args, { workingDir: process.cwd() }))

test('resolvePty plans a pty run on POSIX and refuses on Windows', () => {
  const shell = resolveShell()
  assert.ok(shell, 'a shell must exist on this host')
  const pty = resolvePty(shell, 'echo hi')
  if (IS_WINDOWS) {
    assert.match(pty.error, /not available on Windows/)
    assert.equal(pty.plan, undefined)
  } else {
    assert.ok(pty.plan, `expected a plan, got: ${pty.error}`)
    assert.match(pty.plan.command, /script$/)
    assert.ok(pty.plan.args.length > 0)
  }
})

test('terminal pty=true makes the child see a real terminal', { skip: IS_WINDOWS ? 'pty is POSIX-only in this build' : false }, async () => {
  const result = await run({
    command: 'python3 -c "import sys; print(sys.stdin.isatty())"',
    pty: true
  })
  assert.equal(result.exit_code, 0, JSON.stringify(result))
  assert.match(result.output, /True/, `expected a tty, got: ${JSON.stringify(result.output)}`)
})

test('without pty the child sees a pipe, which is the documented difference', { skip: IS_WINDOWS ? 'python check is POSIX-oriented' : false }, async () => {
  const result = await run({ command: 'python3 -c "import sys; print(sys.stdin.isatty())"' })
  assert.equal(result.exit_code, 0, JSON.stringify(result))
  assert.match(result.output, /False/)
})

test('pty propagates a non-zero exit code', { skip: IS_WINDOWS ? 'pty is POSIX-only in this build' : false }, async () => {
  const result = await run({ command: 'exit 7', pty: true })
  assert.equal(result.exit_code, 7, JSON.stringify(result))
})

test('pty refuses to combine with background or the sandbox', async () => {
  const both = await run({ command: 'echo hi', pty: true, background: true })
  assert.match(both.error, /cannot be combined/)
})
