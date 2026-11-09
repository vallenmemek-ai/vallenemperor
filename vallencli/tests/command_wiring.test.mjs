import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Drift guard. Commands that change session/model/cwd live in
 * `vallenagent/src/core/commands.ts` so every surface behaves the same. If a local
 * handler is added back to the CLI, the two implementations will diverge again —
 * which is exactly the bug this file prevents.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/cli-commands.mjs'), 'utf8')

const CORE_OWNED = ['/model', '/status', '/stats', '/sessions', '/resume', '/new', '/reset', '/memory']
const CLI_ONLY = ['/token', '/cd', '/output', '/theme', '/skills', '/sh', '/pty', '/health', '/perf', '/tools', '/auto', '/plan', '/plans', '/search', '/gamedev', '/session', '/todos', '/settings', '/clear']

const hasHandler = command => new RegExp(`cmd === '${command.replace('/', '\\/')}'`).test(source)

test('the CLI no longer re-implements commands owned by core', () => {
  for (const command of CORE_OWNED) {
    assert.equal(hasHandler(command), false, `${command} must be handled by core.handleCommand, not cli-commands.mjs`)
  }
})

test('the CLI keeps the commands that need CLI-only state', () => {
  for (const command of CLI_ONLY) {
    assert.equal(hasHandler(command), true, `${command} needs CLI state and must stay local`)
  }
})

test('/review stays local but forwards its focus text to the agent', () => {
  assert.match(source, /requestBackgroundReview\([\s\S]*?,\s*focus\)/, 'the focus argument must be forwarded')
})

test('the CLI reaches core through the public barrel, never internal dist paths', () => {
  assert.doesNotMatch(source, /vallenagent\/dist\//, 'import from the `core` object instead of dist internals')
})

test('commands that exist are also discoverable in the dropdown', async () => {
  const { COMMANDS } = await import('../src/cli-suggest.mjs')
  const names = new Set(COMMANDS.flatMap(command => [command.name, ...(command.aliases || [])]))
  for (const command of ['/output', '/schedule', '/status', '/context']) {
    assert.equal(names.has(command), true, `${command} must be suggested`)
  }
})
