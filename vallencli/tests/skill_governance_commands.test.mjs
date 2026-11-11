import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalCommandHandler } from '../dist/cli-commands.js'

const core = await import(new URL('../../vallenagent/dist/index.js', import.meta.url).href)

function harness({ loader, skills = [] } = {}) {
  const printed = []
  const agent = {
    config: { providers: {}, terminal: { cwd: process.cwd() } },
    getSessionId: () => 'skillgov-session',
    getContextStats: () => ({ turns: 1 }),
    skillLoader: loader || { list: () => skills, scanAll: () => {} }
  }
  const handler = createLocalCommandHandler({
    agent,
    core,
    state: {},
    output: { isTTY: false, columns: 80, write: () => true },
    printResponse: text => printed.push(String(text)),
    readHiddenToken: async () => ({ value: '' }),
    settleApproval: () => {},
    enqueue: () => {},
    out: () => {},
    refreshStatus: () => {},
    healthCheck: async () => [],
    enterShell: async () => {},
    runTurn: async () => {},
    displayLine: text => printed.push(String(text))
  })
  return { handler, printed }
}

test('/skills journey prints the learning timeline', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-journey-home-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const history = new core.SkillHistoryStore()
    const id = history.stage('deploy', join(home, 'skills', 'deploy'), 'create', 'first version', 'skill_manage')
    history.commit(id)
    new core.ReviewLogStore().record([{ kind: 'memory', name: 'user', change: 'add', reason: 'prefers tabs' }])

    const { handler, printed } = harness()
    await handler('/skills journey')
    const text = printed.join('\n')
    assert.match(text, /skill deploy · create/)
    assert.match(text, /first version \(skill_manage\)/)
    assert.match(text, /memory user · add/)

    const empty = mkdtempSync(join(tmpdir(), 'vallen-journey-empty-'))
    process.env.VALLENEMPEROR_HOME = empty
    const second = harness()
    await second.handler('/skills journey')
    assert.match(second.printed.join('\n'), /Nothing learned yet/)
    rmSync(empty, { recursive: true, force: true })
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/skills index reports the cost and stores a baseline on request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-index-home-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const { handler, printed } = harness({ skills: [{ name: 'deploy', metadata: { description: 'Deploy the app' } }] })
    await handler('/skills index')
    assert.match(printed.join('\n'), /skills index : ~\d+ tokens \(1 skills\) · first measurement/)
    assert.equal(existsSync(join(home, 'skill-index.json')), false, 'a read does not write the baseline')

    printed.length = 0
    await handler('/skills index store')
    assert.equal(existsSync(join(home, 'skill-index.json')), true)
    printed.length = 0
    await handler('/skills index')
    assert.match(printed.join('\n'), /delta \+?\-?\d+ tokens/)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('/skills pending, approve and reject drive staged skill writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-pending-skills-'))
  const catalog = mkdtempSync(join(tmpdir(), 'vallen-pending-catalog-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    mkdirSync(join(catalog, 'general'), { recursive: true })
    const loader = new core.SkillLoader([catalog])
    loader.load()
    core.registerBuiltinTools(loader)
    new core.saveConfig({ write_approval: { skills: true } })

    const tool = core.registry.get('skill_manage')
    const ctx = { sessionId: 'skillgov-session', stores: { skillLoader: loader } }
    const staged = JSON.parse(await tool.handler({ operations: [{ action: 'create', name: 'from-pending', category: 'custom', content: '---\nname: from-pending\ndescription: Pending\n---\nbody\n' }] }, ctx))
    const rejected = JSON.parse(await tool.handler({ operations: [{ action: 'create', name: 'rejected-skill', category: 'custom' }] }, ctx))
    assert.equal(staged.staged, true)

    const { handler, printed } = harness({ loader })
    await handler('/skills pending')
    assert.match(printed.join('\n'), /2 pending write\(s\)/)

    await handler(`/skills reject ${rejected.id}`)
    assert.match(printed.join('\n'), /rejected and removed/)
    assert.equal(core.readPendingWrite(home, rejected.id), null)

    const approver = harness({ loader })
    await approver.handler(`/skills approve ${staged.id}`)
    assert.match(approver.printed.join('\n'), /approved and applied \(1 operation\(s\)\)/)
    assert.equal(existsSync(join(catalog, 'custom', 'from-pending', 'SKILL.md')), true)
    assert.equal(core.readPendingWrite(home, staged.id), null)
    assert.equal(existsSync(join(catalog, 'custom', 'rejected-skill')), false, 'a rejected write never lands')
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    core.saveConfig({ write_approval: { skills: false } })
    rmSync(home, { recursive: true, force: true })
    rmSync(catalog, { recursive: true, force: true })
  }
})