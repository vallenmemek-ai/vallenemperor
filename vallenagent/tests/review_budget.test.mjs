import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReviewInputBudget, spawnBackgroundReview } from '../dist/agent/background_review.js'
import { ReviewLogStore } from '../dist/skills/skill_history.js'

test('ReviewInputBudget charges growth, not the whole prompt again', () => {
  const budget = new ReviewInputBudget(20_000)
  // A 8k prompt re-sent four times growing slightly is ONE context, not four.
  assert.equal(budget.consume(8_000), true)
  assert.equal(budget.consume(9_000), true)
  assert.equal(budget.consume(9_500), true)
  assert.equal(budget.consume(10_000), true)
  assert.equal(budget.total, 10_000, 'only the growth is counted')
})

test('ReviewInputBudget still stops a context that really grows too far', () => {
  const budget = new ReviewInputBudget(20_000)
  assert.equal(budget.consume(10_000), true)
  assert.equal(budget.consume(15_000), true)
  assert.equal(budget.consume(25_000), false, '25k of real context exceeds a 20k budget')
  assert.equal(budget.ceiling, 20_000)
})

test('a budget skip is logged as skipped, not as a review error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vallen-review-'))
  const previous = process.env.VALLENEMPEROR_HOME
  process.env.VALLENEMPEROR_HOME = home
  try {
    const errors = []
    await new Promise(resolve => {
      spawnBackgroundReview(
        [{ role: 'user', content: 'do the thing' }],
        async () => 'Review budget reached (21000/20000 tokens)',
        {
          onReviewError: message => errors.push(message),
          onReviewFinished: () => resolve()
        }
      )
    })
    assert.deepEqual(errors, [], 'a budget skip must not be reported as an error')

    const rows = new ReviewLogStore().list(10)
    const entry = rows.find(row => row.change === 'skipped')
    assert.ok(entry, `expected a skipped entry, got: ${JSON.stringify(rows)}`)
    assert.match(entry.reason, /budget/i)
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_HOME
    else process.env.VALLENEMPEROR_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
