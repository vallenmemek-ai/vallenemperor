import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillLoader } from '../dist/skills/skills.js'

const catalog = mkdtempSync(join(tmpdir(), 'vallenemperor-relevance-'))

function seedSkill(category, name, description, extra = '') {
  const dir = join(catalog, category, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nbody\n`,
    'utf8'
  )
}

// Matches only the single word "test".
seedSkill('general', 'test-driven-development', 'Write tests first with red green refactor')
// Matches two distinct words.
seedSkill('general', 'github-workflow', 'Create github pull requests from the command line')
// Unrelated, so it never sneaks in through generic overlap.
seedSkill('general', 'himalaya-mail', 'Send and read email from the terminal')

const loader = new SkillLoader([catalog])
loader.load()

test.after(() => rmSync(catalog, { recursive: true, force: true }))

const names = query => loader.getRelevantSkills(query).map(skill => skill.name)

test('a repeated word does not count twice toward the two-word threshold', () => {
  const matched = names('coba di test test dulu')
  assert.ok(
    !matched.includes('test-driven-development'),
    `one distinct matching word repeated by the user must not load the skill, got ${JSON.stringify(matched)}`
  )
})

test('a genuine multi-word match still loads the skill', () => {
  const matched = names('test driven development red green refactor')
  assert.ok(matched.includes('test-driven-development'), `expected TDD skill, got ${JSON.stringify(matched)}`)
})

test('two different matching words still pass the threshold', () => {
  const matched = names('github pull request')
  assert.ok(matched.includes('github-workflow'), `expected github skill, got ${JSON.stringify(matched)}`)
})
