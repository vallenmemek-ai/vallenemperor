import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sandbox from '../dist/core/terminal_sandbox.js'
const { buildSandboxCommand, decideSandbox, formatSandboxProbe, probeSandbox, sandboxMode } = sandbox
const core = await import('../dist/index.js')

test('the sandbox command is read-only except the working directory, and offline by default', () => {
  const built = buildSandboxCommand({ command: 'echo hi', workdir: '/tmp' })
  assert.equal(built.file, 'bwrap')
  assert.deepEqual(built.args.slice(0, 1), ['--die-with-parent'])
  assert.ok(built.args.includes('--unshare-pid'))
  assert.ok(built.args.includes('--unshare-net'), 'network is off by default')
  const roIndex = built.args.indexOf('--ro-bind')
  assert.deepEqual(built.args.slice(roIndex, roIndex + 3), ['--ro-bind', '/', '/'])
  assert.ok(built.args.includes('--bind'))
  assert.equal(built.network, false)
  assert.equal(built.args[built.args.length - 1], 'echo hi')

  const online = buildSandboxCommand({ command: 'echo hi', workdir: '/tmp', allowNetwork: true })
  assert.equal(online.args.includes('--unshare-net'), false)
})

test('sandbox mode resolution is explicit and never silently upgrades', () => {
  assert.equal(sandboxMode('auto'), 'auto')
  assert.equal(sandboxMode('required'), 'required')
  assert.equal(sandboxMode('nonsense'), 'off')
  assert.equal(sandboxMode(undefined), 'off')

  const off = decideSandbox({ command: 'ls', workdir: '/tmp', config: { terminal: { sandbox: 'off' } } })
  assert.equal(off.sandbox, null)

  const missing = { available: false, tool: 'none' }
  const autoMissing = decideSandbox({ command: 'ls', workdir: '/tmp', config: { terminal: { sandbox: 'auto' } }, probe: missing })
  assert.equal(autoMissing.sandbox, null)
  assert.match(autoMissing.reason, /unsandboxed/)

  const requiredMissing = decideSandbox({ command: 'ls', workdir: '/tmp', config: { terminal: { sandbox: 'required' } }, probe: missing })
  assert.equal(requiredMissing.sandbox, null)
  assert.match(requiredMissing.reason, /not installed/)

  const present = { available: true, tool: 'bwrap', version: 'bubblewrap 0.12.0' }
  const built = decideSandbox({ command: 'ls', workdir: '/tmp', config: { terminal: { sandbox: 'auto' } }, probe: present })
  assert.ok(built.sandbox)
  assert.match(formatSandboxProbe(present), /bubblewrap available/)
})

const bwrap = probeSandbox()
test('inside the real sandbox the workspace is writable and the rest of the filesystem is not', { skip: bwrap.available ? false : 'bubblewrap not installed' }, () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vallen-bwrap-'))
  try {
    writeFileSync(join(workdir, 'seed.txt'), 'seed\n')
    const built = buildSandboxCommand({ command: 'echo inside > written.txt && cat seed.txt', workdir })
    const output = execFileSync('bwrap', built.args, { encoding: 'utf8' })
    assert.match(output, /seed/)
    assert.equal(existsSync(join(workdir, 'written.txt')), true, 'the working directory is writable')

    const denied = buildSandboxCommand({ command: 'echo nope > /etc/vallen-sandbox-test', workdir })
    let failed = false
    try { execFileSync('bwrap', denied.args, { stdio: 'pipe' }) } catch { failed = true }
    assert.equal(failed, true, 'writing outside the workspace is denied')
    assert.equal(existsSync('/etc/vallen-sandbox-test'), false)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('the terminal tool refuses to run when the sandbox is required but unavailable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-sbx-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const config = structuredClone(core.DEFAULT_CONFIG)
    config.providers.active = 'mock'
    config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'm', enabled: true }
    config.mcpServers = {}
    config.skills = { paths: [], disabled: [], enabled: [] }
    config.terminal = { cwd: home, sandbox: 'required' }
    const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
    try {
      const tool = core.registry.get('terminal')
      const context = {
        workingDir: home,
        terminalSandbox: { mode: 'required', network: false },
        config: { terminal: { sandbox: 'required' } }
      }
      const result = await tool.handler({ command: 'echo hi' }, context, new AbortController().signal)
      const parsed = JSON.parse(result)
      // With bubblewrap present the command runs; without it the tool must refuse, never run unsandboxed.
      if (bwrap.available) assert.equal(parsed.exit_code, 0)
      else {
        assert.equal(parsed.exit_code, 126)
        assert.match(parsed.error, /sandbox required but unavailable/i)
      }
    } finally {
      agent.shutdown()
    }
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
