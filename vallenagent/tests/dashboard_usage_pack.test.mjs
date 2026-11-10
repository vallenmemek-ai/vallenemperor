import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import subagentModule from '../dist/agent/subagent_registry.js'
import curatorModule from '../dist/skills/curator.js'
import statsModule from '../dist/skills/skill_stats.js'
import packModule from '../dist/core/extension_pack.js'

const { formatAgentDashboard } = subagentModule
const { findStaleSkillsByUsage } = curatorModule
const { SkillStatsStore } = statsModule
const { formatInstallResult, installExtensionPack, readExtensionPack } = packModule

const core = await import('../dist/index.js')

function run(id, overrides = {}) {
  return {
    id, goal: `goal ${id}`, workspace: 'inherit', status: 'running',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    progress: [{ at: new Date().toISOString(), status: 'thinking', message: 'reading files' }],
    ...overrides
  }
}

test('the agent dashboard shows status, elapsed time and the last progress line', () => {
  assert.match(formatAgentDashboard([]), /No subagent runs yet/)
  const text = formatAgentDashboard([
    run('run-1'),
    run('run-2', { status: 'completed', finishedAt: new Date().toISOString(), workspace: 'branch', worktree: { path: '/tmp/wt', branch: 'vallen/x' } })
  ])
  assert.match(text, /1 active \/ 2 tracked/)
  assert.match(text, /run-1\s+running\s+1m05s/)
  assert.match(text, /last: reading files/)
  assert.match(text, /worktree/)
})

test('usage-based curation prefers never-used skills and falls back to file age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-usage-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-usage-home-'))
  try {
    mkdirSync(join(dir, 'skills'), { recursive: true })
    const stale = join(dir, 'skills', 'never.md')
    const usedRecently = join(dir, 'skills', 'recent.md')
    writeFileSync(stale, '# never\n')
    writeFileSync(usedRecently, '# recent\n')
    const old = new Date(Date.now() - 300 * 86_400_000)
    utimesSync(stale, old, old)
    utimesSync(usedRecently, old, old)

    const store = new SkillStatsStore(join(home, 'skill-stats.json'))
    store.recordView('recent')

    const stats = store.list()
    const found = findStaleSkillsByUsage([join(dir, 'skills')], stats, { staleDays: 90 })
    const byName = Object.fromEntries(found.map(entry => [entry.name, entry]))
    assert.equal(byName.never.name, 'never')
    assert.equal(byName.never.reason, 'old-file', 'no usage record at all falls back to file age')

    // A skill that has a usage record but zero uses is explicitly "never-used".
    store.recordManage('never')
    const withRecord = findStaleSkillsByUsage([join(dir, 'skills')], store.list(), { staleDays: 90 })
    assert.equal(withRecord.find(entry => entry.name === 'never').reason, 'never-used')
    assert.equal(byName.recent, undefined, 'a recently used skill is not stale')
    assert.ok(stats.find(entry => entry.name === 'recent').last_used_at, 'usage records a timestamp')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('/fast toggles reasoning effort and background review', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-fast-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: home }, gateway: { background_review: true } }, getSessionId: () => 'f' } }
    assert.match((await core.handleCommand(ctx, '/fast status')).response, /Fast mode: off/)
    assert.match((await core.handleCommand(ctx, '/fast on')).response, /Fast mode on/)
    assert.equal(ctx.agent.config.reasoning_effort, 'low')
    assert.equal(ctx.agent.config.gateway.background_review, false)
    assert.match((await core.handleCommand(ctx, '/fast status')).response, /Fast mode: on/)
    assert.match((await core.handleCommand(ctx, '/fast off')).response, /Fast mode off/)
    assert.equal(ctx.agent.config.reasoning_effort, undefined)
    assert.match((await core.handleCommand(ctx, '/fast nonsense')).response, /Usage: \/fast/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('an extension pack installs skills, commands and agents into the home', () => {
  const packDir = mkdtempSync(join(tmpdir(), 'vallen-pack-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-pack-home-'))
  try {
    mkdirSync(join(packDir, 'skills'), { recursive: true })
    mkdirSync(join(packDir, 'commands'), { recursive: true })
    mkdirSync(join(packDir, 'agents'), { recursive: true })
    writeFileSync(join(packDir, 'skills', 'deploy.md'), '# deploy\n')
    writeFileSync(join(packDir, 'commands', 'ship.md'), '# ship\n')
    writeFileSync(join(packDir, 'agents', 'helper.md'), '---\nname: helper\n---\nbody\n')

    const pack = readExtensionPack(packDir)
    assert.equal(pack.skills.length, 1)
    assert.equal(pack.commands.length, 1)
    assert.equal(pack.agents.length, 1)

    const result = installExtensionPack(pack, home)
    assert.equal(result.installed.length, 3)
    assert.equal(existsSync(join(home, 'skills', 'deploy.md')), true)
    assert.equal(existsSync(join(home, 'commands', 'ship.md')), true)
    assert.equal(existsSync(join(home, 'agents', 'helper.md')), true)
    assert.match(formatInstallResult(result), /Installed 3 file\(s\)/)
  } finally {
    rmSync(packDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
