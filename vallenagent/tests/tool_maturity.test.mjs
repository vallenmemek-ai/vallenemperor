import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyPath, checkWritePolicy, instructionEditsAllowed } from '../dist/core/path_policy.js'
import { LOOP_THRESHOLD, noteOtherTool, noteRead, readTrackerSnapshot, resetReadTracker } from '../dist/tools/read_tracker.js'
import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'
import { REVIEW_SYSTEM_PROMPT } from '../dist/agent/background_review.js'

registerBuiltinTools(false)

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vallen-maturity-${label}-`))
}

test('path policy blocks credential material and instruction files', () => {
  assert.equal(classifyPath(join('/home/x', '.ssh', 'id_rsa')).class, 'sensitive')
  assert.equal(classifyPath('/repo/.env').class, 'sensitive')
  assert.equal(classifyPath('/repo/.env.local').class, 'sensitive')
  assert.equal(classifyPath('/repo/.env.example').class, 'normal')
  assert.equal(classifyPath('/repo/certs/server.pem').class, 'sensitive')
  assert.equal(classifyPath('/repo/.npmrc').class, 'sensitive')

  assert.equal(classifyPath('/repo/AGENTS.md').class, 'instruction')
  assert.equal(classifyPath('/repo/RULES.md').class, 'instruction')
  assert.equal(classifyPath('/repo/src/app.ts').class, 'normal')

  const denied = checkWritePolicy('/repo/.env', {})
  assert.match(denied, /credential/)
  const instruction = checkWritePolicy('/repo/AGENTS.md', {})
  assert.match(instruction, /instruction file/)
  assert.match(instruction, /VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS=1/)

  const allowed = checkWritePolicy('/repo/AGENTS.md', { VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS: '1' })
  assert.equal(allowed, null)
  assert.equal(instructionEditsAllowed({ VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS: '1' }), true)

  // Sensitive paths stay denied even with the instruction override.
  assert.match(checkWritePolicy('/repo/.env', { VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS: '1' }), /credential/)
})

test('write_file refuses credentials and instruction files, and allows normal files', async () => {
  const dir = tempDir('policy')
  const previous = process.env.VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS
  delete process.env.VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS
  try {
    const tool = registry.get('write_file')
    const context = { workingDir: dir, sessionId: 'policy-session' }

    const secret = JSON.parse(await tool.handler({ path: join(dir, '.env'), content: 'TOKEN=x' }, context))
    assert.match(secret.error, /credential/)
    assert.equal(existsSync(join(dir, '.env')), false)

    const rules = JSON.parse(await tool.handler({ path: join(dir, 'AGENTS.md'), content: '# hi' }, context))
    assert.match(rules.error, /instruction file/)
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false)

    const normal = JSON.parse(await tool.handler({ path: join(dir, 'app.ts'), content: 'export const a = 1\n' }, context))
    assert.equal(normal.success, true, JSON.stringify(normal))
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), 'export const a = 1\n')
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS
    else process.env.VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read tracker detects duplicates and read loops, and other tools reset the streak', () => {
  resetReadTracker('t1')
  const base = { sessionId: 't1', path: '/repo/a.ts', hash: 'h1', offset: 1, limit: 200, totalLines: 100 }

  assert.equal(noteRead(base), 'ok')
  assert.equal(noteRead(base), 'duplicate', 'the same unchanged range is a duplicate')

  assert.equal(noteRead({ ...base, path: '/repo/b.ts' }), 'ok')
  assert.equal(noteRead({ ...base, path: '/repo/b.ts' }), 'duplicate')
  assert.equal(noteRead({ ...base, path: '/repo/b.ts' }), 'loop', `three in a row is a loop (threshold ${LOOP_THRESHOLD})`)

  noteOtherTool('t1')
  assert.equal(noteRead({ ...base, path: '/repo/b.ts' }), 'duplicate', 'a different tool resets the streak but not the dedup memory')

  // A changed file is never a duplicate.
  assert.equal(noteRead({ ...base, path: '/repo/c.ts' }), 'ok')
  assert.equal(noteRead({ ...base, path: '/repo/c.ts', hash: 'h2' }), 'ok')

  assert.deepEqual(readTrackerSnapshot('t1').files >= 3, true)
  assert.deepEqual(readTrackerSnapshot('other').files, 0, 'sessions are isolated')
  resetReadTracker()
})

test('read_file returns a stub on a repeat and force re-reads the body', async () => {
  const dir = tempDir('read')
  try {
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'alpha\nbeta\n')
    const tool = registry.get('read_file')
    const context = { workingDir: dir, sessionId: 'read-session' }

    const first = JSON.parse(await tool.handler({ path: file }, context))
    assert.match(first.content, /1\|alpha/)

    const second = JSON.parse(await tool.handler({ path: file }, context))
    assert.equal(second.duplicate, true)
    assert.match(second.note, /already read/i)
    assert.equal(second.content, undefined, 'the body is omitted to save context')
    assert.ok(second.sha256)

    const forced = JSON.parse(await tool.handler({ path: file, force: true }, context))
    assert.match(forced.content, /1\|alpha/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch refuses a stale baseline (file changed after read)', async () => {
  const dir = tempDir('stale')
  try {
    const file = join(dir, 'app.ts')
    writeFileSync(file, 'export const a = 1\n')
    const read = registry.get('read_file')
    const patch = registry.get('patch')
    const fileReadCoverage = new Map()
    const context = { workingDir: dir, sessionId: 'stale-session', fileReadCoverage }

    await read.handler({ path: file }, context)
    writeFileSync(file, 'export const a = 2\n')  // external change

    const result = JSON.parse(await patch.handler({ path: file, old_string: 'a = 1', new_string: 'a = 3' }, context))
    assert.match(result.error, /changed since read_file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the review prompt states what not to capture and the skill shape', () => {
  assert.match(REVIEW_SYSTEM_PROMPT, /DO NOT CAPTURE/)
  assert.match(REVIEW_SYSTEM_PROMPT, /Negative claims about tools/)
  assert.match(REVIEW_SYSTEM_PROMPT, /Unresolved failures/)
  assert.match(REVIEW_SYSTEM_PROMPT, /SKILL SHAPE/)
  assert.match(REVIEW_SYSTEM_PROMPT, /The same lesson learned twice is ONE rule/)
  assert.match(REVIEW_SYSTEM_PROMPT, /Fix a wrong sentence in place/)
})
