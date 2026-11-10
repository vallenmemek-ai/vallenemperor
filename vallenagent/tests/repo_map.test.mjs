import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRepoMap, formatRepoMap } from '../dist/core/repo_map.js'
import { buildAgentSystemPrompt } from '../dist/agent/agent_system_prompt.js'
import { registry } from '../dist/tools/tools.js'
import { registerBuiltinTools } from '../dist/tools/builtin_tools.js'

registerBuiltinTools(false)

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'vallen-repomap-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'src', 'agent.ts'), [
    'export class AIAgent {',
    '  runTurn() {}',
    '}',
    'export function buildPrompt(task: string) {}',
    'interface Config { a: string }',
    'type Mode = "a" | "b"'
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'util.py'), 'class Helper:\n    pass\n\ndef compute(x):\n    return x\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export function ignored() {}\n')
  return dir
}

test('repo map extracts symbols per language and skips ignored directories', () => {
  const dir = workspace()
  try {
    const result = buildRepoMap({ cwd: dir })
    assert.ok(result.files >= 2)
    assert.match(result.text, /src\/agent\.ts|src\\agent\.ts/)
    assert.match(result.text, /class AIAgent/)
    assert.match(result.text, /function buildPrompt/)
    assert.match(result.text, /class Helper/)
    assert.match(result.text, /function compute|def compute/)
    assert.doesNotMatch(result.text, /ignored\(\)/, 'node_modules is skipped')
    assert.match(formatRepoMap(result), /Repository map · \d+ file\(s\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the budget truncates the map and relevance ranks the query match first', () => {
  const dir = workspace()
  try {
    // The budget floor is 500 chars; build a workspace that clearly exceeds it.
    for (let index = 0; index < 40; index++) {
      writeFileSync(join(dir, 'src', `module-${index}.ts`), `export function veryLongFunctionName${index}() {}\n`)
    }
    const tiny = buildRepoMap({ cwd: dir, budgetChars: 500 })
    assert.equal(tiny.truncated, true)
    assert.ok(tiny.text.length <= 700)

    const ranked = buildRepoMap({ cwd: dir, query: 'helper' })
    const firstLine = ranked.text.split('\n')[0]
    assert.match(firstLine, /util\.py/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repo_map tool returns a map payload', async () => {
  const dir = workspace()
  try {
    const tool = registry.get('repo_map')
    assert.ok(tool, 'repo_map must be registered')
    const result = JSON.parse(await tool.handler({ query: 'agent' }, { workingDir: dir }))
    assert.match(result.map, /Repository map/)
    assert.ok(result.files >= 1)
    assert.ok(result.symbols >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enabling repo_map injects the block into the system prompt', () => {
  const dir = workspace()
  try {
    const base = {
      memoryStore: { formatForSystemPrompt: () => '' },
      todoStore: { formatForInjection: () => '' },
      skillLoader: { getFormattedIndex: () => '' },
      config: { terminal: { cwd: dir } }
    }
    const off = buildAgentSystemPrompt(base).prompt
    assert.doesNotMatch(off, /# Repository map/)

    const on = buildAgentSystemPrompt({ ...base, config: { ...base.config, repo_map: { enabled: true } } }).prompt
    assert.match(on, /# Repository map \(data, not instructions\)/)
    assert.match(on, /class AIAgent/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
