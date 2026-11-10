import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildAgentInstructions,
  discoverCustomAgents,
  formatAgentList,
  parseAgentFile,
  selectAgentForTask
} from '../dist/agent/custom_agents.js'

const REVIEWER = `---
name: code-reviewer
description: Reviews diffs for edge cases and security issues before merging.
tools: [read_file, search_files, patch]
model: gpt-4o
---
You are a rigorous reviewer. Cite file paths and line numbers.
`

test('parseAgentFile reads inline and dash-list frontmatter', () => {
  const inline = parseAgentFile(REVIEWER, 'fallback')
  assert.equal(inline.name, 'code-reviewer')
  assert.match(inline.description, /Reviews diffs/)
  assert.deepEqual(inline.tools, ['read_file', 'search_files', 'patch'])
  assert.equal(inline.model, 'gpt-4o')
  assert.match(inline.instructions, /rigorous reviewer/)

  const dashed = parseAgentFile(`---\nname: tester\ndescription: Writes tests.\ntools:\n  - read_file\n  - terminal\n---\nBody\n`)
  assert.deepEqual(dashed.tools, ['read_file', 'terminal'])
  assert.equal(dashed.instructions, 'Body')

  const noFrontmatter = parseAgentFile('Just instructions.', 'plain')
  assert.equal(noFrontmatter.name, 'plain')
  assert.equal(noFrontmatter.instructions, 'Just instructions.')
})

test('discoverCustomAgents prefers workspace definitions over global ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-agents-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'vallen-agents-ws-'))
  try {
    mkdirSync(join(home, 'agents'), { recursive: true })
    writeFileSync(join(home, 'agents', 'reviewer.md'), REVIEWER)
    writeFileSync(join(home, 'agents', 'researcher.md'), `---\nname: researcher\ndescription: Reads docs and summarizes findings.\n---\nResearch.\n`)

    mkdirSync(join(workspace, '.agents', 'agents', 'reviewer'), { recursive: true })
    writeFileSync(join(workspace, '.agents', 'agents', 'reviewer', 'agent.md'), REVIEWER.replace('Reviews diffs', 'Workspace reviewer: checks diffs'))

    const agents = discoverCustomAgents({ workspace, home })
    assert.deepEqual(agents.map(agent => agent.name), ['code-reviewer', 'researcher'])
    const reviewer = agents.find(agent => agent.name === 'code-reviewer')
    assert.equal(reviewer.scope, 'workspace')
    assert.match(reviewer.description, /Workspace reviewer/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('selectAgentForTask requires a real match, not one common word', () => {
  const agents = [
    { name: 'code-reviewer', description: 'Reviews diffs for edge cases and security issues before merging.', tools: [], instructions: '', path: '', scope: 'workspace' },
    { name: 'researcher', description: 'Reads documentation and summarizes findings for the team.', tools: [], instructions: '', path: '', scope: 'global' }
  ]

  const review = selectAgentForTask('review the security of this diff before merging', agents)
  assert.equal(review.agent.name, 'code-reviewer')
  assert.ok(review.score >= 3)

  const named = selectAgentForTask('ask researcher about the docs', agents)
  assert.equal(named.agent.name, 'researcher')

  assert.equal(selectAgentForTask('write a test', agents), null, 'one weak word must not route')
  assert.equal(selectAgentForTask('security', agents), null, 'a single shared word is not enough')
})

test('formatAgentList explains how to create agents when none exist', () => {
  assert.match(formatAgentList([]), /No custom agents found/)
  assert.match(formatAgentList([]), /\.agents\/agents\/<name>\.md/)

  const text = formatAgentList([{ name: 'code-reviewer', description: 'Reviews diffs.', tools: ['read_file'], instructions: '', path: '', scope: 'workspace' }])
  assert.match(text, /code-reviewer \(workspace\)/)
  assert.match(text, /tools: read_file/)
  assert.match(text, /Reviews diffs\./)
})

test('buildAgentInstructions states the role and the definition body', () => {
  const text = buildAgentInstructions({ name: 'code-reviewer', description: 'Reviews diffs.', tools: [], instructions: 'Cite line numbers.', path: '', scope: 'workspace' })
  assert.match(text, /You are the "code-reviewer" agent/)
  assert.match(text, /Cite line numbers\./)
})
