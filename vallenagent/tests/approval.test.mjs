import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { approvalMode, normalizeToolPath, requiresDangerousApproval, requiresApproval, mcpServerFromTool } from '../dist/core/approval.js'

test('approvalMode defaults to dangerous and honors explicit values', () => {
  const saved = process.env.VALLENEMPEROR_APPROVAL
  delete process.env.VALLENEMPEROR_APPROVAL
  try {
    assert.equal(approvalMode(undefined), 'dangerous')
    assert.equal(approvalMode('off'), 'off')
    assert.equal(approvalMode({ approval: 'all' }), 'all')
    assert.equal(approvalMode({ approval: 'nonsense' }), 'dangerous')
    process.env.VALLENEMPEROR_APPROVAL = 'all'
    assert.equal(approvalMode('off'), 'all', 'env must win over config')
  } finally {
    if (saved === undefined) delete process.env.VALLENEMPEROR_APPROVAL
    else process.env.VALLENEMPEROR_APPROVAL = saved
  }
})

test('normalizeToolPath expands ~ and resolves relative paths against workingDir', () => {
  assert.equal(normalizeToolPath('~'), normalizeToolPath(homedir()))
  assert.equal(normalizeToolPath('~/x'), join(homedir(), 'x'))
  // Expected values are built with the host separator so Windows passes too.
  assert.equal(normalizeToolPath('a/b', '/tmp'), join('/tmp', 'a/b'))
  assert.equal(normalizeToolPath('', '/tmp'), resolve('/tmp'))
})

test('recursive rm and git hard reset require dangerous approval', () => {
  assert.equal(requiresDangerousApproval({ name: 'terminal', args: { command: 'rm -rf /tmp/x' } }), true)
  assert.equal(requiresDangerousApproval({ name: 'terminal', args: { command: 'git reset --hard HEAD~1' } }), true)
  assert.equal(requiresDangerousApproval({ name: 'terminal', args: { command: 'ls -la' } }), false)
  assert.equal(requiresDangerousApproval({ name: 'read_file', args: { path: 'a.txt' } }), false)
})

test('writes into sensitive home directories require approval', () => {
  assert.equal(requiresDangerousApproval({ name: 'write_file', args: { path: join(homedir(), '.ssh', 'authorized_keys') } }), true)
  assert.equal(requiresDangerousApproval({ name: 'write_file', args: { path: join(homedir(), 'project', 'notes.md') } }), false)
})

test('requiresApproval respects mode and trusted MCP servers', () => {
  const danger = { name: 'terminal', args: { command: 'rm -rf build' } }
  const safe = { name: 'read_file', args: { path: 'a.txt' } }
  assert.equal(requiresApproval(danger, 'off'), false)
  assert.equal(requiresApproval(safe, 'all'), true)
  assert.equal(requiresApproval(safe, 'dangerous'), false)
  assert.equal(requiresApproval(danger, 'dangerous'), true)
  assert.equal(requiresApproval({ name: 'mcp__server__tool', args: {} }, 'dangerous', true), false)
  assert.equal(requiresApproval({ name: 'mcp__server__tool', args: {} }, 'dangerous', false), true)
})

test('mcpServerFromTool extracts the server segment only for MCP tool names', () => {
  assert.equal(mcpServerFromTool('mcp__files__read'), 'files')
  assert.equal(mcpServerFromTool('read_file'), null)
})
