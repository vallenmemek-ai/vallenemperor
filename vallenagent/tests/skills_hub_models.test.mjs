import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ValidationError,
  validateSkillName,
  validateCategory,
  validateBundleRelPath,
  normalizeLockInstallPath,
  computeContentHash,
  parseSkillIdentifier
} from '../dist/skills_hub/models.js'

test('validateSkillName accepts safe names and trims them', () => {
  assert.equal(validateSkillName('  my-skill_1.2 '), 'my-skill_1.2')
  assert.throws(() => validateSkillName(''), ValidationError)
  assert.throws(() => validateSkillName('../escape'), ValidationError)
  assert.throws(() => validateSkillName('a'.repeat(65)), ValidationError)
})

test('validateCategory normalizes plain categories and blocks traversal', () => {
  assert.equal(validateCategory('tools/web'), 'tools/web')
  assert.equal(validateCategory(''), '')
  assert.throws(() => validateCategory('/tools/web/'), ValidationError)
  assert.throws(() => validateCategory('tools//web'), ValidationError)
  assert.throws(() => validateCategory('tools/../web'), ValidationError)
})

test('validateBundleRelPath rejects absolute and escaping paths', () => {
  assert.equal(validateBundleRelPath('/scripts/run.py'), 'scripts/run.py')
  assert.throws(() => validateBundleRelPath(''), ValidationError)
  assert.throws(() => validateBundleRelPath('../outside.md'), ValidationError)
  assert.throws(() => validateBundleRelPath('a//b.md'), ValidationError)
})

test('normalizeLockInstallPath trims slashes and falls back to the skill name', () => {
  assert.equal(normalizeLockInstallPath('/tools/web/my-skill/', 'my-skill'), 'tools/web/my-skill')
  assert.equal(normalizeLockInstallPath('', 'my-skill'), 'my-skill')
})

test('computeContentHash is deterministic and order independent', () => {
  const a = computeContentHash({ 'b.md': '2', 'a.md': '1' })
  const b = computeContentHash({ 'a.md': '1', 'b.md': '2' })
  assert.equal(a, b)
  assert.equal(a.length, 64)
  assert.notEqual(a, computeContentHash({ 'a.md': '1', 'b.md': '3' }))
})

test('parseSkillIdentifier understands official, community, local and github forms', () => {
  assert.deepEqual(parseSkillIdentifier('official/devops/docker'), { source: 'official', category: 'devops', name: 'docker' })
  assert.deepEqual(parseSkillIdentifier('devops/docker'), { source: 'community', category: 'devops', name: 'docker' })
  assert.deepEqual(parseSkillIdentifier('docker'), { source: 'local', name: 'docker' })
  const gh = parseSkillIdentifier('https://github.com/owner/repo')
  assert.equal(gh.source, 'github')
  assert.equal(gh.name, 'repo')
})
