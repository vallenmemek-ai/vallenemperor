import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addPlanFeedback,
  advancePlanRun,
  buildStepPrompt,
  createPlanRun,
  currentStep,
  formatPlanPause,
  formatPlanStatus,
  parsePlanSteps,
  planTitle,
  progressOf,
  skipCurrentStep,
  stopPlanRun
} from '../dist/agent/plan_mode.js'

const PLAN = `# Plan: add artifact listing

## Goal
Make artifacts reviewable.

## Step-by-step tasks

1. Add the artifact store
   Create \`src/agent/artifact_store.ts\` with write/list helpers.
   Verify: \`npm test -- artifact_store\`

2. Wire the turn loop
   Write the walkthrough at finalize.
   Verify: \`npm test -- turn_artifact\`

3. Expose /artifacts
   Register the command in core/commands.ts.
`

test('parsePlanSteps reads numbered steps with their bodies', () => {
  const steps = parsePlanSteps(PLAN)
  assert.equal(steps.length, 3)
  assert.equal(steps[0].index, 1)
  assert.equal(steps[0].title, 'Add the artifact store')
  assert.match(steps[0].body, /artifact_store\.ts/)
  assert.match(steps[0].body, /npm test -- artifact_store/)
  assert.equal(steps[2].index, 3)
  assert.match(steps[2].body, /core\/commands\.ts/)
})

test('parsePlanSteps also accepts heading and bullet step shapes', () => {
  const headings = parsePlanSteps(`# P\n\n### Step 1 — parse input\nBody one.\n\n### Step 2 — write output\nBody two.\n`)
  assert.deepEqual(headings.map(step => step.title), ['parse input', 'write output'])
  assert.match(headings[0].body, /Body one/)

  const bullets = parsePlanSteps(`# P\n\n- Step 1: first\n  do a\n- Step 2: second\n  do b\n`)
  assert.deepEqual(bullets.map(step => step.title), ['first', 'second'])
  assert.match(bullets[1].body, /do b/)
})

test('parsePlanSteps ignores prose that is not a step', () => {
  assert.deepEqual(parsePlanSteps('# Plan\n\nJust some text.\n\n- a bullet\n'), [])
  assert.deepEqual(parsePlanSteps(''), [])
})

test('planTitle prefers the first heading and strips a leading "Plan:"', () => {
  assert.equal(planTitle(PLAN), 'add artifact listing')
  assert.equal(planTitle('# My plan\n'), 'My plan')
  assert.equal(planTitle('no heading here', 'fallback'), 'fallback')
})

test('createPlanRun starts running when steps exist and finishes immediately when not', () => {
  const run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  assert.equal(run.status, 'running')
  assert.equal(run.current, 0)
  assert.equal(run.steps.length, 3)
  assert.deepEqual(progressOf(run), { position: 1, total: 3, done: 0, skipped: 0 })
  assert.equal(currentStep(run).title, 'Add the artifact store')

  const empty = createPlanRun({ planPath: '/tmp/plan.md', markdown: '# Plan\n\nnothing\n' })
  assert.equal(empty.status, 'finished')
  assert.equal(currentStep(empty), null)
})

test('advancePlanRun marks steps done and finishes after the last one', () => {
  let run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  run = advancePlanRun(run)
  assert.deepEqual(run.done, [0])
  assert.equal(run.current, 1)
  run = advancePlanRun(run)
  run = advancePlanRun(run)
  assert.deepEqual(run.done, [0, 1, 2])
  assert.equal(run.status, 'finished')
  assert.equal(currentStep(run), null)
})

test('skipCurrentStep records skips without marking done, and stop freezes the run', () => {
  let run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  run = skipCurrentStep(run)
  assert.deepEqual(run.skipped, [0])
  assert.deepEqual(run.done, [])
  assert.equal(run.current, 1)

  const stopped = stopPlanRun(run)
  assert.equal(stopped.status, 'stopped')
  assert.equal(currentStep(stopped), null)
  assert.equal(advancePlanRun(stopped).current, 1, 'a stopped run does not advance')
})

test('addPlanFeedback keeps notes for the next prompt', () => {
  const run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  const withNote = addPlanFeedback(run, 'use node:fs instead')
  assert.deepEqual(withNote.feedback, ['use node:fs instead'])
  assert.deepEqual(addPlanFeedback(run, '   ').feedback, [])
})

test('buildStepPrompt scopes the turn to one step and carries steering notes', () => {
  let run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  run = addPlanFeedback(run, 'keep it synchronous')
  const prompt = buildStepPrompt({ run, step: run.steps[1], feedback: 'also add a test' })

  assert.match(prompt, /plan mode — executing step 2\/3/)
  assert.match(prompt, /Plan: \/tmp\/plan\.md/)
  assert.match(prompt, /Step 2: Wire the turn loop/)
  assert.match(prompt, /Write the walkthrough at finalize\./)
  assert.match(prompt, /keep it synchronous/)
  assert.match(prompt, /also add a test/)
  assert.match(prompt, /Implement ONLY this step/)
})

test('formatPlanStatus marks done, current and skipped steps', () => {
  let run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  run = advancePlanRun(run)          // step 1 done, step 2 current
  run = skipCurrentStep(run)         // step 2 skipped, step 3 current
  const text = formatPlanStatus(run)

  assert.match(text, /Plan running · add artifact listing · step 3\/3 · 1 done · 1 skipped/)
  assert.match(text, /✓ 1\. Add the artifact store/)
  assert.match(text, /– 2\. Wire the turn loop/)
  assert.match(text, /→ 3\. Expose \/artifacts/)
  assert.match(text, /\/plan next/)
})

test('formatPlanPause reports the next step, completion and stop states', () => {
  let run = createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN })
  assert.match(formatPlanPause(run), /add artifact listing · 3 step\(s\) ready/)
  assert.match(formatPlanPause(run), /Next: 1\. Add the artifact store/)

  run = advancePlanRun(run)
  assert.match(formatPlanPause(run), /Step 1\/3 done: Add the artifact store/)
  assert.match(formatPlanPause(run), /Next: 2\. Wire the turn loop/)

  run = advancePlanRun(advancePlanRun(advancePlanRun(run)))
  assert.match(formatPlanPause(run), /Finished "add artifact listing" — 3 step\(s\) done/)

  const stopped = stopPlanRun(createPlanRun({ planPath: '/tmp/plan.md', markdown: PLAN }))
  assert.match(formatPlanPause(stopped), /Stopped at step 1\/3/)
})
