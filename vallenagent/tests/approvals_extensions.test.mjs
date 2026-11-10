import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatApprovals, mineApprovals, readApprovals, recordApproval } from '../dist/core/approval_mining.js'
import { buildExtensionManifest, formatManifest } from '../dist/core/extension_manifest.js'

const core = await import('../dist/index.js')

test('approvals are recorded, mined and only propose unanimous rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-appr-'))
  try {
    assert.deepEqual(readApprovals(home), [])
    for (let i = 0; i < 3; i++) recordApproval(home, { tool: 'terminal', approved: true })
    for (let i = 0; i < 3; i++) recordApproval(home, { tool: 'browser_navigate', approved: false })
    recordApproval(home, { tool: 'write_file', approved: true })
    recordApproval(home, { tool: 'write_file', approved: false })
    recordApproval(home, { tool: 'write_file', approved: true })

    const records = readApprovals(home)
    assert.equal(records.length, 9)
    const suggestions = mineApprovals(records)
    const byTool = Object.fromEntries(suggestions.map(item => [item.tool, item]))
    assert.equal(byTool.terminal.suggestion, 'allow')
    assert.equal(byTool.browser_navigate.suggestion, 'deny')
    assert.equal(byTool.write_file.suggestion, null, 'a mixed history proposes nothing')
    assert.match(formatApprovals(suggestions), /→ propose allow/)
    assert.match(formatApprovals([]), /No approval history/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/approvals apply writes confident rules into tool_policy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-appr-cmd-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    for (let i = 0; i < 3; i++) recordApproval(home, { tool: 'terminal', approved: true })
    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: home } }, getSessionId: () => 'a' } }

    const empty = await core.handleCommand(ctx, '/approvals')
    assert.match(empty.response, /Approval history/)
    assert.match(empty.response, /terminal\s+3 approved/)

    const applied = await core.handleCommand(ctx, '/approvals apply')
    assert.match(applied.response, /Applied 1 policy rule/)
    assert.equal(ctx.agent.config.tool_policy.terminal, 'allow')

    const again = await core.handleCommand(ctx, '/approvals apply')
    assert.match(again.response, /Applied 1 policy rule/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the extension manifest lists skills, agents, commands, hooks and MCP servers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vallen-ext-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-ext-home-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    mkdirSync(join(cwd, 'skills'), { recursive: true })
    writeFileSync(join(cwd, 'skills', 'deploy.md'), '# deploy\n')
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'review.md'), '# review\n')
    mkdirSync(join(cwd, '.agents', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.agents', 'agents', 'helper.md'), '---\nname: helper\ndescription: helps\n---\nbody\n')
    mkdirSync(join(cwd, '.vallenemperor', 'commands'), { recursive: true })
    writeFileSync(join(cwd, '.vallenemperor', 'commands', 'ship.md'), '# ship\n')

    // Bundled layouts: <dir>/<category>/<name>/SKILL.md and <dir>/<name>.md
    const bundled = join(home, 'bundled-skills')
    mkdirSync(join(bundled, 'creative', 'video'), { recursive: true })
    writeFileSync(join(bundled, 'creative', 'video', 'SKILL.md'), '# video\n')
    writeFileSync(join(bundled, 'top-level.md'), '# top\n')

    const manifest = buildExtensionManifest({ cwd, home, config: { hooks: { pre_tool: [{ command: 'echo hi' }] }, mcpServers: { github: {} } }, extraSkillDirs: [bundled] })
    const skillNames = manifest.skills.map(entry => entry.name).sort()
    assert.deepEqual(skillNames.filter(name => !name.includes('/')), ['deploy', 'review', 'top-level'])
    assert.ok(skillNames.includes('creative/video'), 'nested SKILL.md layouts are discovered')
    assert.equal(manifest.skills.filter(entry => entry.source === 'bundled').length, 2)
    assert.equal(manifest.agents[0].name, 'helper')
    assert.equal(manifest.commands[0].name, 'ship')
    assert.equal(manifest.hooks.length, 1)
    assert.deepEqual(manifest.mcp, ['github'])

    const text = formatManifest(manifest)
    assert.match(text, /Skills \(4\)/)
    assert.match(text, /Custom agents \(1\)/)
    assert.match(text, /MCP servers \(1\)/)

    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd }, hooks: { pre_tool: [{ command: 'echo hi' }] }, mcpServers: {} }, getSessionId: () => 'e' } }
    const response = await core.handleCommand(ctx, '/extensions')
    assert.match(response.response, /Custom commands \(1\)/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(cwd, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('the curator finds stale skills, reports a dry run, and archives on apply', async () => {
  const { findStaleSkills, archiveSkills, formatCuratorReport } = await import('../dist/skills/curator.js')
  const { utimesSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'vallen-cur-'))
  const home = mkdtempSync(join(tmpdir(), 'vallen-cur-home-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    mkdirSync(join(dir, 'skills'), { recursive: true })
    const oldPath = join(dir, 'skills', 'old.md')
    const freshPath = join(dir, 'skills', 'fresh.md')
    writeFileSync(oldPath, '# old\n')
    writeFileSync(freshPath, '# fresh\n')
    const oldStamp = new Date(Date.now() - 200 * 86_400_000)
    utimesSync(oldPath, oldStamp, oldStamp)

    const stale = findStaleSkills([join(dir, 'skills')], { staleDays: 90 })
    assert.equal(stale.length, 1)
    assert.equal(stale[0].name, 'old')
    assert.ok(stale[0].ageDays >= 199)
    assert.match(formatCuratorReport(stale, { staleDays: 90 }), /Dry run/)

    const moved = archiveSkills(stale, join(home, 'skills', 'archive'))
    assert.equal(moved.length, 1)
    assert.equal(existsSync(oldPath), false)
    assert.equal(existsSync(moved[0]), true)
    assert.match(formatCuratorReport(stale, { staleDays: 90, applied: moved }), /Archived 1 file/)

    const ctx = { channel: 'terminal', agent: { config: { providers: {}, terminal: { cwd: dir } }, getSessionId: () => 'c' } }
    const response = await core.handleCommand(ctx, '/curator 90')
    assert.match(response.response, /Nothing to archive|untouched for 90\+ days/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
