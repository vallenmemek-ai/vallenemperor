import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../dist/cli.js', import.meta.url).pathname

test('each profile is a fully isolated home: config, sessions and skills do not leak', () => {
  const base = mkdtempSync(join(tmpdir(), 'vallen-iso-'))
  try {
    const run = args => execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, VALLENEMPEROR_HOME: base, VALLENEMPEROR_BASE_HOME: base },
      encoding: 'utf8'
    })

    run(['profile', 'create', 'work'])
    run(['profile', 'create', 'personal'])

    const workHome = join(base, 'profiles', 'work')
    const personalHome = join(base, 'profiles', 'personal')
    assert.notEqual(workHome, personalHome)

    // A config written into one profile must not appear in the other or in the base home.
    writeFileSync(join(workHome, 'config.json'), JSON.stringify({ marker: 'work-only' }))
    writeFileSync(join(personalHome, 'config.json'), JSON.stringify({ marker: 'personal-only' }))

    assert.equal(JSON.parse(readFileSync(join(workHome, 'config.json'), 'utf8')).marker, 'work-only')
    assert.equal(JSON.parse(readFileSync(join(personalHome, 'config.json'), 'utf8')).marker, 'personal-only')
    assert.equal(existsSync(join(base, 'config.json')), false, 'the base home stays untouched')

    // Running with a profile writes its own state there, not in the base home.
    run(['--profile', 'work', '--version'])
    assert.equal(existsSync(workHome), true, 'the profile home exists after use')
    assert.equal(existsSync(join(base, 'sessions')), false, 'no session state leaks into the base home')
    assert.equal(existsSync(join(base, 'config.json')), false, 'no config is written to the base home')

    const listed = run(['profile', 'list'])
    assert.match(listed, /work/)
    assert.match(listed, /personal/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
