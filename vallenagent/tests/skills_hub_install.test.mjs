import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'vallenemperor-install-'))
process.env.VALLENEMPEROR_HOME = home

const { quarantineBundle, installFromQuarantine, uninstallSkill, listInstalledSkills } = await import('../dist/skills_hub/install.js')

test.after(() => rmSync(home, { recursive: true, force: true }))

const skillsDir = () => join(home, 'skills')

function bundle(overrides = {}) {
  return {
    name: 'demo-skill',
    category: 'tools',
    description: 'demo skill for tests',
    source: 'test',
    identifier: 'test/tools/demo-skill',
    files: {
      'SKILL.md': '---\nname: demo-skill\ndescription: demo skill for tests\n---\n\n# Demo\n',
      'references/notes.md': 'notes'
    },
    ...overrides
  }
}

test('quarantineBundle writes the bundle into the quarantine directory', () => {
  const path = quarantineBundle(bundle())
  assert.ok(existsSync(join(path, 'SKILL.md')))
  assert.equal(readFileSync(join(path, 'references/notes.md'), 'utf8'), 'notes')
})

test('quarantineBundle rejects traversal inside the bundle', () => {
  assert.throws(() => quarantineBundle(bundle({ files: { '../escape.md': 'x' } })), /Invalid|Unsafe|traversal/i)
  assert.throws(() => quarantineBundle(bundle({ files: { 'a/../../escape.md': 'x' } })), /Invalid|Unsafe|traversal/i)
})

test('an absolute bundle path is normalised inside the quarantine instead of escaping it', () => {
  const path = quarantineBundle(bundle({ name: 'abs-path-skill', files: { '/etc/passwd': 'not really' } }))
  assert.ok(existsSync(join(path, 'etc', 'passwd')), 'leading slash is stripped, file stays in quarantine')
  assert.equal(existsSync('/etc/passwd.not-written'), false)
  assert.ok(path.startsWith(home), 'quarantine lives under VALLENEMPEROR_HOME')
})

test('quarantineBundle rejects an invalid skill name', () => {
  assert.throws(() => quarantineBundle(bundle({ name: '../evil' })), /Invalid skill name/)
  assert.throws(() => quarantineBundle(bundle({ name: '' })), /cannot be empty/)
})

test('installFromQuarantine installs files and records a lock entry', () => {
  const path = quarantineBundle(bundle())
  const result = installFromQuarantine(path, bundle())
  assert.equal(result.success, true)
  assert.equal(result.path, join(skillsDir(), 'tools', 'demo-skill'))
  assert.ok(existsSync(join(result.path, 'SKILL.md')))

  const installed = listInstalledSkills()
  assert.ok(installed.some(entry => entry.name === 'demo-skill'))
  const lockFile = join(home, 'skills_hub', '.lock.json')
  assert.ok(existsSync(lockFile))
  assert.equal(statSync(lockFile).mode & 0o777, 0o600, 'lock file is owner-only')
})

test('installing the same skill twice requires an explicit overwrite', () => {
  const path = quarantineBundle(bundle({ files: { 'SKILL.md': '---\nname: demo-skill\n---\n\nv2\n' } }))
  const blocked = installFromQuarantine(path, bundle())
  assert.equal(blocked.success, false)
  assert.equal(blocked.error, 'already_installed')

  const replaced = installFromQuarantine(path, bundle(), { overwrite: true })
  assert.equal(replaced.success, true)
  assert.match(readFileSync(join(replaced.path, 'SKILL.md'), 'utf8'), /v2/)
})

test('the security scan blocks dangerous bundle contents', () => {
  const dangerous = bundle({
    name: 'danger-skill',
    files: { 'SKILL.md': 'run this: rm -rf /\n' }
  })
  const path = quarantineBundle(dangerous)
  const result = installFromQuarantine(path, dangerous)
  assert.equal(result.success, false)
  assert.equal(result.error, 'scan_failed')
  assert.match(result.message, /rm -rf/)
  assert.equal(existsSync(join(skillsDir(), 'tools', 'danger-skill')), false, 'nothing is written on a failed scan')
})

test('eval and exec payloads are flagged by the scan', () => {
  for (const [name, content] of [['eval-skill', 'const x = eval("1")'], ['exec-skill', 'exec("ls")']]) {
    const evil = bundle({ name, files: { 'SKILL.md': content } })
    const result = installFromQuarantine(quarantineBundle(evil), evil)
    assert.equal(result.error, 'scan_failed', `${name} must be blocked`)
  }
})

test('skipScan bypasses the scanner but still validates the name', () => {
  const flagged = bundle({ name: 'flagged-skill', files: { 'SKILL.md': 'eval("x")' } })
  const path = quarantineBundle(flagged)
  const result = installFromQuarantine(path, flagged, { skipScan: true })
  assert.equal(result.success, true)
})

test('an invalid category fails the install instead of escaping the skills directory', () => {
  const path = quarantineBundle(bundle({ name: 'cat-skill' }))
  for (const category of ['../escape', 'tools/../..', 'tools//web']) {
    const result = installFromQuarantine(path, bundle({ name: 'cat-skill' }), { category })
    assert.equal(result.success, false, `category ${category} must be rejected`)
    assert.match(result.message, /Invalid category/i)
  }
  assert.equal(existsSync(join(home, 'escape')), false)
  assert.equal(existsSync(join(skillsDir(), 'cat-skill')), false, 'a rejected category writes nothing')
})

test('a leading slash in the category is rejected outright', () => {
  const path = quarantineBundle(bundle({ name: 'abs-cat-skill' }))
  const result = installFromQuarantine(path, bundle({ name: 'abs-cat-skill' }), { category: '/tools' })
  assert.equal(result.success, false)
  assert.match(result.message, /Invalid category/i)
  assert.equal(existsSync(join(skillsDir(), 'abs-cat-skill')), false)
})

test('uninstallSkill removes the files and the lock entry', () => {
  const removable = bundle({ name: 'removable-skill', files: { 'SKILL.md': '---\nname: removable-skill\n---\n' } })
  const installed = installFromQuarantine(quarantineBundle(removable), removable)
  assert.equal(installed.success, true)

  const removed = uninstallSkill('removable-skill')
  assert.equal(removed.success, true)
  assert.equal(existsSync(installed.path), false)
  assert.ok(!listInstalledSkills().some(entry => entry.name === 'removable-skill'))

  const missing = uninstallSkill('removable-skill')
  assert.equal(missing.success, false)
})

test('uninstallSkill refuses traversal in the skill name', () => {
  const result = uninstallSkill('../etc')
  assert.equal(result.success, false)
  assert.match(result.message, /Invalid skill name/)
})

test('the quarantine directory is cleaned between bundles of the same name', () => {
  const first = quarantineBundle(bundle({ name: 'clean-skill', files: { 'SKILL.md': 'one', 'old.md': 'stale' } }))
  assert.ok(existsSync(join(first, 'old.md')))
  const second = quarantineBundle(bundle({ name: 'clean-skill', files: { 'SKILL.md': 'two' } }))
  assert.deepEqual(readdirSync(second).sort(), ['SKILL.md'])
})

test('installed skills land under the VALLENEMPEROR_HOME skills directory', () => {
  const isolated = bundle({ name: 'isolated-skill', files: { 'SKILL.md': '---\nname: isolated-skill\n---\n' } })
  const result = installFromQuarantine(quarantineBundle(isolated), isolated)
  assert.equal(result.success, true)
  assert.ok(result.path.startsWith(skillsDir()), `expected install under ${skillsDir()}, got ${result.path}`)
})
