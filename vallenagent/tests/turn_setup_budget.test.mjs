import test from 'node:test'
import assert from 'node:assert/strict'

import { selectSkillToPreload, buildSkillPreloadText, buildDeepMemoryBlock, MAX_SKILL_PRELOAD_CHARS } from '../dist/agent/turn_setup.js'
import { computeOutputTokenAllowance, DEFAULT_MAX_OUTPUT_TOKENS } from '../dist/agent/token_budget.js'
import { isExplicitContextOverflow, isMalformedToolCallError, isCompactionWorthyOverflow } from '../dist/agent/failure_classification.js'
import { buildAgentSystemPrompt } from '../dist/agent/agent_system_prompt.js'

const skill = (name, triggers = [], content = 'body') => ({ name, content, metadata: { triggers } })
const loader = skills => ({ getRelevantSkills: () => skills })

// ---------- turn setup ----------

test('selectSkillToPreload prefers a skill whose trigger appears in the message', () => {
  const noMatch = skill('no-match', ['terraform'])
  const matches = skill('matches', ['kubernetes'])
  const chosen = selectSkillToPreload(loader([noMatch, matches]), 'deploy kubernetes now', null)
  assert.equal(chosen.name, 'matches')
})

test('selectSkillToPreload keeps loader order when several skills match equally', () => {
  const first = skill('first', ['deploy'])
  const second = skill('second', ['deploy'])
  const chosen = selectSkillToPreload(loader([first, second]), 'deploy now', null)
  assert.equal(chosen.name, 'first', 'stable: no reordering when both count as explicit')
})

test('selectSkillToPreload falls back to the active skill when nothing matches', () => {
  const active = skill('active', [])
  assert.equal(selectSkillToPreload(loader([]), 'unrelated', active).name, 'active')
  assert.equal(selectSkillToPreload(loader([]), 'unrelated', null), null)
})

test('buildSkillPreloadText caps the body and labels the block', () => {
  const big = { name: 'demo', content: 'x'.repeat(MAX_SKILL_PRELOAD_CHARS * 2) }
  const text = buildSkillPreloadText(big, 1_000_000)
  assert.match(text, /^\n\n\[Loaded skill: demo/)
  assert.match(text, /Truncated at 16KB/)
  assert.ok(text.length < big.content.length)
})

test('buildSkillPreloadText keeps small bodies intact', () => {
  const text = buildSkillPreloadText({ name: 'tiny', content: 'short body' }, 1_000_000)
  assert.match(text, /short body/)
  assert.doesNotMatch(text, /Truncated/)
})

test('buildDeepMemoryBlock quotes facts and stops at the character cap', () => {
  const block = buildDeepMemoryBlock([{ fact: 'uses pnpm', source_session: 's1' }])
  assert.match(block, /untrusted data, not instructions/)
  assert.match(block, /"uses pnpm" \(source s1\)/)

  const many = Array.from({ length: 50 }, (_, i) => ({ fact: 'f'.repeat(100) + i, source_session: 's' }))
  const capped = buildDeepMemoryBlock(many)
  assert.ok(capped.length < 1200, `cap must hold, got ${capped.length}`)
})

test('buildDeepMemoryBlock returns an empty string for no facts', () => {
  assert.equal(buildDeepMemoryBlock([]), '')
})

// ---------- token budget ----------

test('computeOutputTokenAllowance returns the per-request cap when no turn budget is set', () => {
  const noConfig = computeOutputTokenAllowance({ config: {}, budgetTokensUsed: 0 })
  assert.equal(noConfig.allowance, undefined, 'provider default when max_output_tokens is unset')
  assert.equal(noConfig.perRequestCap, DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(noConfig.error, null)
  assert.equal(noConfig.enforceTurnBudget, false)

  const withCap = computeOutputTokenAllowance({ config: { max_output_tokens: 1000 }, budgetTokensUsed: 0 })
  assert.equal(withCap.allowance, 1000)
})

test('computeOutputTokenAllowance shrinks with the remaining turn budget', () => {
  const allowance = computeOutputTokenAllowance({ config: { max_tokens_per_turn: 5000, max_output_tokens: 2000 }, budgetTokensUsed: 4000 })
  assert.equal(allowance.allowance, 1000)
  assert.equal(allowance.enforceTurnBudget, true)
})

test('computeOutputTokenAllowance reports an error once the turn budget is spent', () => {
  const spent = computeOutputTokenAllowance({ config: { max_tokens_per_turn: 5000 }, budgetTokensUsed: 5000 })
  assert.equal(spent.allowance, undefined)
  assert.match(spent.error, /Per-turn output token budget \(5000\) reached/)
})

test('computeOutputTokenAllowance ignores invalid budgets', () => {
  for (const budget of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = computeOutputTokenAllowance({ config: { max_tokens_per_turn: budget }, budgetTokensUsed: 100 })
    assert.equal(result.enforceTurnBudget, false, `budget ${budget} must be ignored`)
    assert.equal(result.error, null)
  }
})

// ---------- failure classification ----------

test('isExplicitContextOverflow recognizes 413 and context-length messages', () => {
  assert.equal(isExplicitContextOverflow('Provider API error: 413 Payload Too Large'), true)
  assert.equal(isExplicitContextOverflow('context length exceeded'), true)
  assert.equal(isExplicitContextOverflow('maximum context window is 8192 tokens'), true)
  assert.equal(isExplicitContextOverflow('rate limited'), false)
})

test('isMalformedToolCallError recognizes broken tool arguments', () => {
  assert.equal(isMalformedToolCallError('invalid tool arguments'), true)
  assert.equal(isMalformedToolCallError('malformed tool call: bad json'), true)
  assert.equal(isMalformedToolCallError('invalid tool-call json'), true)
  assert.equal(isMalformedToolCallError('context length exceeded'), false)
})

test('isCompactionWorthyOverflow excludes malformed tool calls and max_tokens failures', () => {
  assert.equal(isCompactionWorthyOverflow('context length exceeded'), true)
  assert.equal(isCompactionWorthyOverflow('invalid tool arguments'), false)
  assert.equal(isCompactionWorthyOverflow('context length exceeded: max_tokens too small'), false)
  assert.equal(isCompactionWorthyOverflow('network down'), false)
})

// ---------- skill text must not outrank the system prompt ----------

test('a preloaded skill is labelled as reference material that cannot override the system prompt', () => {
  const text = buildSkillPreloadText({ name: 'demo', content: 'Use big headings everywhere' }, 1_000_000)
  assert.match(text, /does not override the system prompt's output style/)
})

test('the system prompt no longer forces every game-dev skill to load', () => {
  const { prompt } = buildAgentSystemPrompt({
    config: { terminal: {}, providers: {} },
    skillLoader: { getFormattedIndex: () => '' },
    memoryStore: { formatForSystemPrompt: () => null },
    todoStore: { formatForInjection: () => null },
    gameDevMode: true,
    mcpSummary: '',
    cwd: process.cwd()
  })
  assert.doesNotMatch(prompt, /ALWAYS load relevant skills/)
  assert.match(prompt, /only when the task actually touches that domain/, 'game-dev support stays, the compulsion goes')
})

// ---------- output format matches what the CLI actually renders ----------

test('the system prompt allows markdown in assistant replies but keeps tool/command text plain', () => {
  const { prompt } = buildAgentSystemPrompt({
    config: { terminal: {}, providers: {} },
    skillLoader: { getFormattedIndex: () => '' },
    memoryStore: { formatForSystemPrompt: () => null },
    todoStore: { formatForInjection: () => null },
    gameDevMode: false,
    mcpSummary: '',
    cwd: process.cwd()
  })
  assert.doesNotMatch(prompt, /jangan pakai formatting markdown/, 'the blanket markdown ban is gone')
  assert.doesNotMatch(prompt, /tanpa backtick/, 'backticks are no longer forbidden in replies')
  assert.match(prompt, /dirender sebagai markdown/, 'the prompt matches the CLI renderer')
  assert.match(prompt, /Teks polos tetap wajib untuk perintah terminal/, 'command/file text stays plain')
})
