import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  artifactDir,
  artifactFileName,
  artifactSessionKey,
  formatArtifactList,
  listArtifacts,
  readArtifactIndex,
  writeArtifact,
  writeTurnWalkthrough
} from '../dist/agent/artifact_store.js'

function tempHome(label) {
  return mkdtempSync(join(tmpdir(), `vallen-artifacts-${label}-`))
}

test('writeArtifact stores content, records a manifest entry, and hashes the session id', () => {
  const home = tempHome('write')
  try {
    const entry = writeArtifact({
      home,
      sessionId: '../../etc/passwd',
      turn: 2,
      kind: 'plan',
      name: 'plan.md',
      content: '# Plan\n\n1. do the thing\n'
    })

    assert.equal(entry.kind, 'plan')
    assert.equal(entry.name, 'plan.md')
    assert.ok(entry.bytes > 0)
    assert.equal(readFileSync(entry.path, 'utf8'), '# Plan\n\n1. do the thing\n')

    const dir = artifactDir(home, '../../etc/passwd', 2)
    assert.ok(dir.startsWith(join(home, 'artifacts')), 'artifact dir must stay inside the home root')
    assert.ok(!dir.includes('..'), 'session id must not leak path segments')

    const index = readArtifactIndex(dir)
    assert.equal(index.turn, 2)
    assert.equal(index.entries.length, 1)
    assert.equal(index.entries[0].name, 'plan.md')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('writeArtifact rejects traversal names, reserved manifest names, and invalid turns', () => {
  const home = tempHome('reject')
  try {
    for (const name of ['../evil.md', 'a/b.md', 'index.json', '.hidden']) {
      assert.throws(
        () => writeArtifact({ home, sessionId: 's1', turn: 1, kind: 'note', name, content: 'x' }),
        /Invalid artifact name/,
        `name ${name} must be rejected`
      )
    }
    assert.throws(() => artifactDir(home, 's1', 0), /positive integer/)
    assert.throws(() => artifactDir(home, 's1', 1.5), /positive integer/)
    assert.throws(() => artifactSessionKey('  '), /required/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('generated file names are sanitized, stamped, and kind-specific', () => {
  const now = new Date('2026-02-03T04:05:06.789Z')
  assert.equal(artifactFileName('screenshot', 'Home page!', now), 'screenshot-home-page-20260203-040506.png')
  assert.equal(artifactFileName('plan', undefined, now), 'plan-20260203-040506.md')
  assert.equal(artifactFileName('diff', 'patch 2', now), 'diff-patch-2-20260203-040506.patch')
  assert.throws(() => artifactFileName('bogus', 'x', now), /Unknown artifact kind/)
})

test('sessions are isolated and listArtifacts returns the newest turn first', () => {
  const home = tempHome('list')
  try {
    writeArtifact({ home, sessionId: 'alpha', turn: 1, kind: 'note', name: 'first.md', content: 'one' })
    writeArtifact({ home, sessionId: 'alpha', turn: 2, kind: 'note', name: 'second.md', content: 'two' })
    writeArtifact({ home, sessionId: 'beta', turn: 1, kind: 'note', name: 'other.md', content: 'three' })

    const alpha = listArtifacts({ home, sessionId: 'alpha' })
    assert.deepEqual(alpha.map(entry => entry.name).sort(), ['first.md', 'second.md'])

    assert.equal(alpha[0].name, 'second.md', 'within a session the newest turn comes first')

    const all = listArtifacts({ home })
    assert.equal(all.length, 3, 'listing without a session id spans every session')
    assert.deepEqual(all.map(entry => entry.name).sort(), ['first.md', 'other.md', 'second.md'])

    assert.equal(listArtifacts({ home, sessionId: 'missing' }).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('writeTurnWalkthrough records request, result, files and verification', () => {
  const home = tempHome('walkthrough')
  try {
    const dir = writeTurnWalkthrough({
      home,
      sessionId: 'session-a',
      turn: 3,
      userMessage: 'add a screenshot tool',
      finalContent: 'Added browser_screenshot.',
      artifacts: { created: ['src/tool.ts'], changed: ['src/index.ts'], verification: ['npm test'] },
      toolCalls: 7,
      iterations: 4
    })
    assert.ok(dir, 'walkthrough dir must be returned')
    const text = readFileSync(join(dir, 'walkthrough.md'), 'utf8')
    assert.match(text, /^# Turn 3 — walkthrough/)
    assert.match(text, /add a screenshot tool/)
    assert.match(text, /Added browser_screenshot\./)
    assert.match(text, /## Created[\s\S]*src\/tool\.ts/)
    assert.match(text, /## Changed[\s\S]*src\/index\.ts/)
    assert.match(text, /## Verification[\s\S]*npm test/)
    assert.match(text, /Tool calls: 7 · iterations: 4/)

    const index = readArtifactIndex(dir)
    assert.equal(index.entries[0].kind, 'walkthrough')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('writeTurnWalkthrough keeps nothing for a turn that produced nothing', () => {
  const home = tempHome('empty')
  try {
    assert.equal(writeTurnWalkthrough({ home, sessionId: 's', turn: 1, userMessage: 'hi', finalContent: 'hello' }), null)
    assert.equal(existsSync(join(home, 'artifacts')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('formatArtifactList is readable and reports an empty state', () => {
  assert.match(formatArtifactList([]), /No artifacts yet/)
  const home = tempHome('format')
  try {
    writeArtifact({ home, sessionId: 's', turn: 1, kind: 'screenshot', name: 'shot.png', content: 'x'.repeat(2048) })
    const text = formatArtifactList(listArtifacts({ home, sessionId: 's' }))
    assert.match(text, /screenshot/)
    assert.match(text, /2\.0 KB/)
    assert.match(text, /shot\.png/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a corrupt manifest degrades to a fresh index instead of throwing', () => {
  const home = tempHome('corrupt')
  try {
    const dir = artifactDir(home, 's', 1)
    writeArtifact({ home, sessionId: 's', turn: 1, kind: 'note', name: 'a.md', content: 'a' })
    writeFileSync(join(dir, 'index.json'), '{not json')
    assert.equal(readArtifactIndex(dir), null)
    writeArtifact({ home, sessionId: 's', turn: 1, kind: 'note', name: 'b.md', content: 'b' })
    const index = readArtifactIndex(dir)
    assert.deepEqual(index.entries.map(entry => entry.name), ['b.md'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
