import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkPathAllowed, formatSandboxStatus, isWithinRoot, normalizeRoots, sandboxPolicyFor } from '../dist/core/sandbox.js'
import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'
import { registry } from '../dist/tools/tools.js'

registerBuiltinTools(false)

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vallen-sandbox-${label}-`))
}

test('isWithinRoot accepts the root and its children, rejects siblings and escapes', () => {
  const root = tempDir('root')
  try {
    assert.equal(isWithinRoot(root, root), true)
    assert.equal(isWithinRoot(join(root, 'a', 'b.txt'), root), true)
    assert.equal(isWithinRoot(join(root, '..', 'outside.txt'), root), false)
    assert.equal(isWithinRoot(`${root}-sibling`, root), false, 'prefix siblings are not inside')
    assert.equal(isWithinRoot('/etc/passwd', root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkPathAllowed is unrestricted without roots and explains a denial with roots', () => {
  const root = tempDir('check')
  try {
    assert.deepEqual(checkPathAllowed('/anywhere/file.txt', undefined), { allowed: true })
    assert.deepEqual(checkPathAllowed('/anywhere/file.txt', []), { allowed: true })

    const inside = checkPathAllowed(join(root, 'ok.txt'), normalizeRoots([root]))
    assert.equal(inside.allowed, true)

    const outside = checkPathAllowed('/etc/passwd', normalizeRoots([root]))
    assert.equal(outside.allowed, false)
    assert.match(outside.reason, /outside the sandbox/)
    assert.match(outside.reason, /security\.filesystem/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('subagents are always confined, the main agent only when configured', () => {
  const cwd = tempDir('policy')
  try {
    const sub = sandboxPolicyFor({ isSubagent: true, config: { terminal: { cwd } } })
    assert.equal(sub.mode, 'workspace')
    assert.equal(sub.roots.length, 1)
    assert.equal(realpathSync(sub.roots[0]), realpathSync(cwd), 'macOS reports /private/var for the same dir')

    const mainDefault = sandboxPolicyFor({ isSubagent: false, config: { terminal: { cwd } } })
    assert.equal(mainDefault.mode, 'unrestricted')
    assert.deepEqual(mainDefault.roots, [])

    const mainSandboxed = sandboxPolicyFor({ isSubagent: false, config: { terminal: { cwd }, security: { filesystem: 'workspace' } } })
    assert.equal(mainSandboxed.mode, 'workspace')
    assert.deepEqual(mainSandboxed.roots.map(root => realpathSync(root)), [realpathSync(cwd)])

    assert.match(formatSandboxStatus(mainDefault), /sandbox: off/)
    assert.match(formatSandboxStatus(mainSandboxed), /Allowed root/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('write_file refuses to escape the sandbox and still writes inside it', async () => {
  const root = tempDir('write')
  const outside = tempDir('outside')
  try {
    const tool = registry.get('write_file')
    const context = { workingDir: root, sessionId: 'sandbox-test', sandboxRoots: [root] }

    const blocked = JSON.parse(await tool.handler({ path: join(outside, 'escape.txt'), content: 'nope' }, context))
    assert.match(blocked.error, /outside the sandbox/)
    assert.equal(existsSync(join(outside, 'escape.txt')), false)

    const allowed = JSON.parse(await tool.handler({ path: join(root, 'ok.txt'), content: 'yes' }, context))
    assert.equal(allowed.success, true, JSON.stringify(allowed))
    assert.equal(readFileSync(join(root, 'ok.txt'), 'utf8'), 'yes')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('patch and patch_batch honour the sandbox', async () => {
  const root = tempDir('patch')
  const outside = tempDir('patch-outside')
  try {
    writeFileSync(join(outside, 'secret.txt'), 'original\n')
    const patchTool = registry.get('patch')
    const batchTool = registry.get('patch_batch')
    const context = { workingDir: root, sessionId: 'sandbox-test', sandboxRoots: [root] }

    const single = JSON.parse(await patchTool.handler({ path: join(outside, 'secret.txt'), old_string: 'original', new_string: 'hacked' }, context))
    assert.match(single.error, /outside the sandbox/)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original\n')

    const batch = JSON.parse(await batchTool.handler({ files: [{ path: join(outside, 'secret.txt'), old_string: 'original', new_string: 'hacked' }] }, context))
    assert.match(JSON.stringify(batch), /outside the sandbox/)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a subagent tool context gets sandbox roots from its working directory', async () => {
  const { buildToolContext } = await import('../dist/agent/tool_context.js')
  const cwd = tempDir('ctx')
  try {
    const base = {
      toolCallId: 'call', completedUserTurns: 0,
      config: { providers: { active: 'x', x: { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'm', enabled: true } }, terminal: { cwd } },
      provider: { baseURL: 'http://127.0.0.1:1/v1', model: 'm', chat: async () => ({}) },
      fileReadCoverage: new Map(), memoryStore: {}, todoStore: {}, skillLoader: {},
      createSubagent: () => ({ chat: async () => ({ response: '' }), interrupt: () => {} })
    }
    const subContext = buildToolContext({ ...base, isSubagent: true, sessionId: 'sub' })
    assert.deepEqual(subContext.sandboxRoots.map(root => realpathSync(root)), [realpathSync(cwd)])

    const mainContext = buildToolContext({ ...base, isSubagent: false, sessionId: 'main' })
    assert.equal(mainContext.sandboxRoots, undefined, 'main agent is unrestricted by default')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
