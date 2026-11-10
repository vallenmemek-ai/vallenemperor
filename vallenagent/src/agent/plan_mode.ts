/**
 * Plan mode — turn a saved markdown plan into a steered, step-by-step run.
 *
 * The agent writes the plan (`/plan <task>` → `.vallenemperor/plans/*.md`). This module parses that
 * markdown into steps and builds the per-step prompts, so execution pauses at milestones and the
 * user can steer (`/plan next`, `/plan edit <feedback>`, `/plan skip`, `/plan stop`).
 *
 * Pure logic only: no filesystem writes, no terminal I/O. That keeps it unit-testable and lets every
 * surface (CLI, gateway) drive the same state machine.
 */

export interface PlanStep {
  /** 1-based position used in prompts and progress output. */
  index: number
  title: string
  body: string
}

export type PlanRunStatus = 'running' | 'finished' | 'stopped'

export interface PlanRun {
  planPath: string
  title: string
  steps: PlanStep[]
  /** 0-based index of the step in progress. */
  current: number
  done: number[]
  skipped: number[]
  status: PlanRunStatus
  /** Steering notes collected from `/plan edit <feedback>`. */
  feedback: string[]
  startedAt: string
}

const HEADING_STEP = /^#{2,4}\s*(?:step\s*)?(\d+)\s*[.):\-–—]*\s*(.+?)\s*$/i
const NUMBERED_STEP = /^(\d+)[.)]\s+(.+?)\s*$/
const BULLET_STEP = /^[-*]\s+(?:step\s*)?(\d+)\s*[.):\-–—]\s*(.+?)\s*$/i

/** Extract the plan title: first `#` heading, else the file name. */
export function planTitle(markdown: string, fallback = 'Plan'): string {
  const lines = String(markdown || '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match) return match[1].replace(/^plan\s*[:\-—]\s*/i, '').trim() || fallback
  }
  return fallback
}

/**
 * Parse steps from a plan document.
 *
 * Accepts `### Step 1 — title`, `1. title`, and `- Step 1: title` shapes. Each step body runs until
 * the next step marker, so the full task text (files, commands, tests) is preserved.
 */
export function parsePlanSteps(markdown: string): PlanStep[] {
  const lines = String(markdown || '').split(/\r?\n/)
  const found: { index: number; title: string; bodyLines: string[] }[] = []

  for (const line of lines) {
    const match = HEADING_STEP.exec(line) || NUMBERED_STEP.exec(line) || BULLET_STEP.exec(line)
    if (match) {
      const index = Number(match[1])
      const title = match[2].replace(/[*_`]/g, '').replace(/^[\s\-–—:.)]+/, '').trim()
      if (Number.isInteger(index) && index > 0 && title) {
        found.push({ index, title, bodyLines: [] })
        continue
      }
    }
    if (found.length) found[found.length - 1].bodyLines.push(line)
  }

  return found.map(step => ({
    index: step.index,
    title: step.title.slice(0, 160),
    body: step.bodyLines.join('\n').trim()
  }))
}

export interface CreatePlanRunOptions {
  planPath: string
  markdown: string
  title?: string
  now?: Date
}

export function createPlanRun(options: CreatePlanRunOptions): PlanRun {
  const steps = parsePlanSteps(options.markdown)
  return {
    planPath: options.planPath,
    title: options.title || planTitle(options.markdown, 'Plan'),
    steps,
    current: 0,
    done: [],
    skipped: [],
    status: steps.length ? 'running' : 'finished',
    feedback: [],
    startedAt: (options.now || new Date()).toISOString()
  }
}

export function currentStep(run: PlanRun): PlanStep | null {
  if (run.status !== 'running') return null
  return run.steps[run.current] || null
}

export function progressOf(run: PlanRun): { position: number; total: number; done: number; skipped: number } {
  return {
    position: Math.min(run.current + 1, Math.max(run.steps.length, 1)),
    total: run.steps.length,
    done: run.done.length,
    skipped: run.skipped.length
  }
}

/** Mark the current step done and move to the next one (finishing the run when exhausted). */
export function advancePlanRun(run: PlanRun): PlanRun {
  if (run.status !== 'running') return run
  const done = run.done.includes(run.current) ? run.done : [...run.done, run.current]
  const next = run.current + 1
  if (next >= run.steps.length) return { ...run, done, current: next, status: 'finished' }
  return { ...run, done, current: next }
}

/** Skip the current step (recorded separately so the report can show it). */
export function skipCurrentStep(run: PlanRun): PlanRun {
  if (run.status !== 'running') return run
  const skipped = run.skipped.includes(run.current) ? run.skipped : [...run.skipped, run.current]
  const next = run.current + 1
  if (next >= run.steps.length) return { ...run, skipped, current: next, status: 'finished' }
  return { ...run, skipped, current: next }
}

export function stopPlanRun(run: PlanRun): PlanRun {
  return run.status === 'finished' ? run : { ...run, status: 'stopped' }
}

/** Record a steering note without advancing (used by `/plan edit <feedback>`). */
export function addPlanFeedback(run: PlanRun, feedback: string): PlanRun {
  const text = String(feedback || '').trim()
  if (!text) return run
  return { ...run, feedback: [...run.feedback, text] }
}

export interface BuildStepPromptOptions {
  run: PlanRun
  step: PlanStep
  feedback?: string
}

/** Prompt that scopes one turn to exactly one plan step. */
export function buildStepPrompt(options: BuildStepPromptOptions): string {
  const { run, step } = options
  const total = run.steps.length
  const feedback = String(options.feedback || '').trim()
  const notes = run.feedback.length ? `\nSteering notes so far:\n${run.feedback.map(note => `- ${note}`).join('\n')}\n` : ''
  const thisFeedback = feedback ? `\nUser feedback for this step:\n${feedback}\n` : ''

  return `[plan mode — executing step ${step.index}/${total}]
Plan: ${run.planPath}
Plan title: ${run.title}

Step ${step.index}: ${step.title}
${step.body ? `\n${step.body}\n` : ''}${notes}${thisFeedback}
Rules for this turn:
- Implement ONLY this step. Do not start the next step.
- Follow the step's file paths and commands exactly.
- Run the step's verification and quote the real output.
- Finish with a short report: what changed, verification result, and anything the next step needs to know.`
}

function marker(run: PlanRun, position: number): string {
  if (run.done.includes(position)) return '✓'
  if (run.skipped.includes(position)) return '–'
  if (run.status === 'running' && run.current === position) return '→'
  return '·'
}

export function formatPlanStatus(run: PlanRun): string {
  const progress = progressOf(run)
  const header = run.status === 'finished'
    ? `Plan finished · ${run.title} · ${progress.done} done · ${progress.skipped} skipped`
    : run.status === 'stopped'
      ? `Plan stopped · ${run.title} · ${progress.done}/${progress.total} done · ${progress.skipped} skipped`
      : `Plan running · ${run.title} · step ${progress.position}/${progress.total} · ${progress.done} done · ${progress.skipped} skipped`

  const lines = [header, `File: ${run.planPath}`]
  run.steps.forEach((step, position) => {
    lines.push(`  ${marker(run, position)} ${step.index}. ${step.title}`)
  })
  if (run.feedback.length) lines.push(`Feedback: ${run.feedback.join(' | ')}`)
  if (run.status === 'running') {
    lines.push('Commands: /plan next · /plan edit <feedback> · /plan skip · /plan stop · /plan status')
  }
  return lines.join('\n')
}

/** Short pause banner printed after each step turn. */
export function formatPlanPause(run: PlanRun): string {
  if (run.status === 'finished') {
    const skipped = run.skipped.length ? ` · ${run.skipped.length} skipped` : ''
    return `[plan] Finished "${run.title}" — ${run.done.length} step(s) done${skipped}. Review with /artifacts or /diff.`
  }
  if (run.status === 'stopped') return `[plan] Stopped at step ${run.current + 1}/${run.steps.length}. Resume with /plan next.`

  const lastDone = run.done.length ? run.steps[run.done[run.done.length - 1]] : null
  const next = currentStep(run)
  const lines = lastDone
    ? [`[plan] Step ${lastDone.index}/${run.steps.length} done: ${lastDone.title}`]
    : [`[plan] ${run.title} · ${run.steps.length} step(s) ready`]
  if (next) lines.push(`[plan] Next: ${next.index}. ${next.title}`)
  lines.push('[plan] /plan next · /plan edit <feedback> · /plan skip · /plan stop')
  return lines.join('\n')
}
