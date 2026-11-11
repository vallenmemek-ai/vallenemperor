import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyProfile, extractProfile, listProfiles, profileHome, runProfileCommand, sanitize } from '../dist/cli-profile.js'

// .pathname yields '/D:/...' on Windows, which node turns into 'D:\D:\...'
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

test('--profile is extracted from argv and points the home at the profile', () => {
  const parsed = extractProfile(['--profile', 'Work Client', 'run', 'hello'])
  assert.equal(parsed.profile, 'work-client')
  assert.deepEqual(parsed.argv, ['run', 'hello'])
  assert.equal(extractProfile(['--profile=acme']).profile, 'acme')
  assert.equal(extractProfile(['run']).profile, '')
  assert.equal(sanitize('Acme/../x'), 'acme-x', 'traversal segments are neutralised')
})

test('profiles are created, listed and deleted without touching the default home', () => {
  const base = mkdtempSync(join(tmpdir(), 'vallen-profile-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = base
  try {
    const lines = []
    const stdout = { write: text => lines.push(text) }
    assert.equal(runProfileCommand({ args: ['list'], stdout }), 0)
    assert.match(lines.join(''), /No profiles yet/)

    assert.equal(runProfileCommand({ args: ['create', 'acme'], stdout }), 0)
    assert.equal(existsSync(profileHome('acme')), true)
    assert.deepEqual(listProfiles(), ['acme'])

    assert.equal(applyProfile('acme'), 'acme')
    assert.equal(process.env.VALLENEMPEROR_HOME, profileHome('acme'))
    assert.equal(process.env.VALLENEMPEROR_PROFILE, 'acme')

    assert.equal(runProfileCommand({ args: ['delete', 'acme'], stdout }), 0)
    assert.equal(existsSync(profileHome('acme')), false)
    assert.equal(runProfileCommand({ args: ['delete', 'ghost'], stdout }), 1)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    delete process.env.VALLENEMPEROR_PROFILE
    delete process.env.VALLENEMPEROR_BASE_HOME
    rmSync(base, { recursive: true, force: true })
  }
})

test('the CLI accepts --profile end to end', () => {
  const base = mkdtempSync(join(tmpdir(), 'vallen-profile-cli-'))
  try {
    const output = execFileSync(process.execPath, [CLI, '--profile', 'ci', '--version'], {
      env: { ...process.env, VALLENEMPEROR_HOME: base },
      encoding: 'utf8'
    })
    assert.match(output, /vallenemperor v\d/)
    assert.equal(existsSync(join(base, 'profiles', 'ci')), true, 'the profile home is created on use')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
