import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

function harness(home) {
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  const agent = {
    config: {
      providers: { active: '9router', '9router': { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'm', enabled: true } },
      terminal: { cwd: home },
      security: { filesystem: 'unrestricted' }
    },
    getSessionId: () => 'sandbox-session'
  }
  return {
    ctx: { channel: 'terminal', agent },
    agent,
    restore: () => {
      if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
      else process.env.VALLENEMPEROR_HOME = previous
    }
  }
}

test('/sandbox reports the default policy and explains subagent confinement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-sandbox-cmd-'))
  const h = harness(home)
  try {
    const result = await core.handleCommand(h.ctx, '/sandbox')
    assert.equal(result.handled, true)
    assert.match(result.response, /sandbox: off/)
    assert.match(result.response, /Subagents are always confined/)
    assert.match(result.response, /\/sandbox workspace/)
  } finally {
    h.restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('/sandbox workspace turns the boundary on and persists it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-sandbox-cmd2-'))
  const h = harness(home)
  try {
    const on = await core.handleCommand(h.ctx, '/sandbox workspace')
    assert.match(on.response, /Filesystem sandbox ON/)
    assert.equal(h.agent.config.security.filesystem, 'workspace')

    const status = await core.handleCommand(h.ctx, '/sandbox status')
    assert.match(status.response, /Filesystem sandbox: workspace/)
    assert.match(status.response, /Allowed root/)

    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(saved.security.filesystem, 'workspace')

    const off = await core.handleCommand(h.ctx, '/sandbox off')
    assert.match(off.response, /Filesystem sandbox OFF/)
    assert.equal(h.agent.config.security.filesystem, 'unrestricted')

    const bad = await core.handleCommand(h.ctx, '/sandbox nope')
    assert.match(bad.response, /Usage: \/sandbox/)
  } finally {
    h.restore()
    rmSync(home, { recursive: true, force: true })
  }
})
