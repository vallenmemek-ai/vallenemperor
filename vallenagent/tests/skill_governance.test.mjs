import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildJourney, ReviewLogStore, SkillHistoryStore } from '../dist/skills/skill_history.js'
import { formatSkillIndexBudget, skillIndexBudget, skillIndexFile, skillIndexTokens, writeSkillIndexSnapshot } from '../dist/skills/skill_index_budget.js'
import { listPendingWrites, readPendingWrite } from '../dist/core/pending_writes.js'
import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { SkillLoader } from '../dist/skills/skills.js'
import { registry } from '../dist/tools/tools.js'

registerBuiltinTools(false)

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vallen-skillgov-${label}-`))
}

test('buildJourney merges skill changes and review rows newest first', () => {
  const changes = [
    { id: 'a', at: '2026-01-01T00:00:00.000Z', skill: 'deploy', action: 'create', reason: 'first', target: '/x', snapshot: null },
    { id: 'b', at: '2026-01-03T00:00:00.000Z', skill: 'deploy', action: 'patch', reason: 'fix', target: '/x', snapshot: null, undone: '2026-01-04T00:00:00.000Z' }
  ]
  const reviews = [{ at: '2026-01-02T00:00:00.000Z', kind: 'memory', name: 'user', change: 'add', reason: 'prefers tabs' }]
  const rows = buildJourney(changes, reviews, 10)
  assert.deepEqual(rows.map(row => row.at), ['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  assert.equal(rows[0].action, 'patch (undone)')
  assert.equal(rows[1].kind, 'memory')
  assert.equal(rows[1].source, 'review')
  assert.equal(rows[2].source, 'agent')
  assert.equal(buildJourney(changes, reviews, 1).length, 1)
})

test('the skill-index budget stores a baseline and reports the delta', () => {
  const home = tempDir('index')
  try {
    const file = skillIndexFile(home)
    const skills = [{ name: 'deploy', description: 'Deploy the app' }, { name: 'test', description: 'Write tests' }]
    const first = skillIndexBudget(skills, file)
    assert.equal(first.deltaTokens, null)
    assert.equal(first.skills, 2)
    assert.equal(first.tokens, skillIndexTokens(skills))
    assert.match(formatSkillIndexBudget(first), /first measurement/)

    writeSkillIndexSnapshot(file, { at: new Date().toISOString(), tokens: first.tokens - 20, skills: 1, names: ['deploy'] })
    const grown = skillIndexBudget(skills, file)
    assert.equal(grown.deltaTokens, 20)
    assert.deepEqual(grown.added, ['test'])
    assert.deepEqual(grown.removed, [])
    assert.match(formatSkillIndexBudget(grown), /delta \+\d+ tokens/)
    assert.match(formatSkillIndexBudget(grown), /\+1: test/)

    writeSkillIndexSnapshot(file, { at: new Date().toISOString(), tokens: 999, skills: 3, names: ['deploy', 'test', 'gone'] })
    const shrunk = skillIndexBudget(skills, file)
    assert.match(formatSkillIndexBudget(shrunk), /-1: gone/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('skill_manage stages a write batch instead of applying it when write_approval.skills is on', async t => {
  const home = tempDir('home')
  const catalog = tempDir('catalog')
  const oldHome = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
    rmSync(catalog, { recursive: true, force: true })
  })

  writeFileSync(join(home, 'config.json'), JSON.stringify({ write_approval: { skills: true } }))
  const loader = new SkillLoader([catalog])
  loader.load()
  const tool = registry.get('skill_manage')

  const staged = JSON.parse(await tool.handler({ operations: [{ action: 'create', name: 'staged-skill', category: 'custom', content: '---\nname: staged-skill\ndescription: Staged\n---\nbody\n' }] }, { sessionId: 'gov', stores: { skillLoader: loader } }))
  assert.equal(staged.staged, true)
  assert.match(staged.note, /Approve with \/skills approve/)
  assert.equal(existsSync(join(catalog, 'custom', 'staged-skill', 'SKILL.md')), false, 'nothing touched the skills directory')

  const pending = listPendingWrites(home, 'skills')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].operations.length, 1)
  assert.equal(pending[0].operations[0].name, 'staged-skill')

  // Approving re-runs the stored operations with staging disabled.
  const applied = JSON.parse(await tool.handler({ operations: readPendingWrite(home, staged.id).operations }, { sessionId: 'gov', skipSkillStaging: true, stores: { skillLoader: loader } }))
  assert.equal(applied.success, true)
  assert.equal(existsSync(join(catalog, 'custom', 'staged-skill', 'SKILL.md')), true)

  // A read-only action is never staged.
  const listed = JSON.parse(await tool.handler({ action: 'stats' }, { stores: { skillLoader: loader } }))
  assert.equal(listed.action, 'stats')
  assert.equal(listPendingWrites(home, 'skills').length, 1, 'no new pending entry for a read-only action')
})

test('skill history records the source of a change', () => {
  const home = tempDir('history')
  const oldHome = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const store = new SkillHistoryStore(join(home, 'skill-history'))
    store.commit(store.stage('deploy', join(home, 'skills', 'deploy'), 'create', 'created', 'skill_manage'))
    const [row] = store.list(5)
    assert.equal(row.source, 'skill_manage')
    const [journey] = buildJourney(store.list(5), [], 5)
    assert.equal(journey.source, 'skill_manage')

    new ReviewLogStore(join(home, 'review-log.json')).record([{ kind: 'skill', name: 'deploy', change: 'update', reason: 'missing step' }])
    const merged = buildJourney(store.list(5), new ReviewLogStore(join(home, 'review-log.json')).list(5), 5)
    assert.equal(merged.length, 2)
    assert.ok(merged.some(row => row.source === 'review'))
    assert.ok(readFileSync(join(home, 'skill-history', 'changes.json'), 'utf8').includes('skill_manage'))
  } finally {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})
