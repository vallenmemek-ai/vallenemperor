import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateClarifyRequest, formatClarifyOutcome, MAX_CLARIFY_CHOICES, MAX_CLARIFY_QUESTIONS } from '../dist/agent/clarify_policy.js'
import { buildAgentSystemPrompt } from '../dist/agent/agent_system_prompt.js'

const question = (text, choices) => ({ question: text, ...(choices ? { choices } : {}) })

test('a real blocking decision is accepted', () => {
  const evaluation = evaluateClarifyRequest([
    question('Hapus tabel users lama atau migrasi datanya dulu?', ['Migrasi dulu (disarankan)', 'Hapus langsung'])
  ])
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation))
  assert.equal(evaluation.questions.length, 1)
  assert.equal(evaluation.questions[0].choices[0], 'Migrasi dulu (disarankan)')

  const payload = JSON.parse(formatClarifyOutcome(evaluation))
  assert.equal(payload.clarification_needed, true)
  assert.equal(payload.proceed, false)
  assert.match(payload.message, /ask these questions directly/i)
})

test('asking permission to continue is rejected with advice to proceed', () => {
  const evaluation = evaluateClarifyRequest([question('Boleh saya lanjutkan?')])
  assert.equal(evaluation.ok, false)
  assert.equal(evaluation.questions.length, 0)
  assert.match(String(evaluation.advice), /permission to keep working/i)

  const payload = JSON.parse(formatClarifyOutcome(evaluation))
  assert.equal(payload.clarification_needed, false)
  assert.equal(payload.proceed, true)
  assert.match(payload.message, /Do not ask the user/)
})

test('a preference poll is rejected instead of interrupting the user', () => {
  for (const text of ['Pakai warna apa untuk tombolnya?', 'Which color should the button be?', 'Gaya penamaan file apa?']) {
    const evaluation = evaluateClarifyRequest([question(text)])
    assert.equal(evaluation.ok, false, text)
    assert.match(String(evaluation.advice), /preference|conventional default/i, text)
  }
})

test('payload limits are enforced instead of silently truncating', () => {
  const tooMany = evaluateClarifyRequest(Array.from({ length: MAX_CLARIFY_QUESTIONS + 1 }, (_, i) => question(`Keputusan ${i} yang memblokir?`)))
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.errors.join(' '), new RegExp(`at most ${MAX_CLARIFY_QUESTIONS} questions`))

  const tooManyChoices = evaluateClarifyRequest([question('Mau yang mana?', ['a', 'b', 'c', 'd', 'e'])])
  assert.equal(tooManyChoices.ok, false)
  assert.match(tooManyChoices.errors.join(' '), new RegExp(`at most ${MAX_CLARIFY_CHOICES} choices`))

  const empty = evaluateClarifyRequest([{ question: '   ' }])
  assert.equal(empty.ok, false)
  assert.match(empty.errors.join(' '), /non-empty text/)

  const duplicate = evaluateClarifyRequest([question('Hapus tabel users?'), question('hapus tabel users?')])
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.errors.join(' '), /duplicate clarify question/)
})

test('an empty clarify call is rejected', () => {
  for (const value of [undefined, null, [], 'nope']) {
    const evaluation = evaluateClarifyRequest(value)
    assert.equal(evaluation.ok, false)
    assert.match(evaluation.errors.join(' '), /at least one question/)
  }
})

// ---------- the tool actually applies the policy ----------

const core = await import('../dist/index.js')

test('the clarify tool refuses a permission question and tells the model to continue', async t => {
  const oldHome = process.env.VALLENEMPEROR_HOME
  const home = mkdtempSync(join(tmpdir(), 'vallenemperor-clarify-'))
  process.env.VALLENEMPEROR_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })

  const config = structuredClone(core.DEFAULT_CONFIG)
  config.providers.active = 'mock'
  config.providers.mock = { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'mock-model', enabled: true }
  config.mcpServers = {}
  config.skills = { paths: [], disabled: [], enabled: [] }
  config.gateway = { ...config.gateway, background_review: false, llm_compaction: false }

  const agent = new core.AIAgent({ config, lightweight: true, backgroundReview: false, sessionDir: join(home, 'sessions') })
  t.after(() => agent.shutdown())

  let call = 0
  agent.provider.chat = async () => {
    call++
    if (call === 1) {
      return {
        id: 'c1',
        model: 'mock-model',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clarify', arguments: JSON.stringify({ questions: [{ question: 'Boleh saya lanjutkan?' }] }) } }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    }
    return {
      id: 'c2',
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'lanjut dikerjakan' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    }
  }

  const result = await agent.runTurn({ message: 'kerjakan fitur login', surfaceId: 'clarify' }, {})
  const toolMessage = agent.conversationHistory.filter(message => message.role === 'tool').at(-1)
  const payload = JSON.parse(toolMessage.content)
  assert.equal(payload.clarification_needed, false)
  assert.equal(payload.proceed, true)
  assert.equal(result.completionStatus, 'complete')
})

test('the system prompt states when asking is allowed', () => {
  const { prompt } = buildAgentSystemPrompt({
    config: { terminal: {}, providers: {} },
    skillLoader: { getFormattedIndex: () => '' },
    memoryStore: { formatForSystemPrompt: () => null },
    todoStore: { formatForInjection: () => null },
    gameDevMode: false,
    mcpSummary: '',
    cwd: process.cwd()
  })
  assert.match(prompt, /# When to Ask \(clarify\)/)
  assert.match(prompt, /Ask the user only when all three hold/)
  assert.match(prompt, /Never ask permission to continue/)
  assert.match(prompt, /at most 5 questions and 4 choices/)
  assert.doesNotMatch(prompt, /ask only if ambiguity changes the action/)
})
