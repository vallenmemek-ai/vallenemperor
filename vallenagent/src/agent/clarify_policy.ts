/**
 * Clarify policy — when asking is worth the interruption, and what a usable question looks like.
 *
 * The runtime cannot collect structured answers, so `clarify` is a decision gate, not a form.
 * A request that is really a permission check ("should I continue?") or a preference poll
 * (naming, style, file layout) must not stop the turn: the agent should pick the conventional
 * default and say so. Only a decision that changes what gets built or run is worth asking.
 */

export interface ClarifyQuestion {
  question: string
  choices?: string[]
  multi_select?: boolean
}

export interface ClarifyEvaluation {
  ok: boolean
  questions: ClarifyQuestion[]
  errors: string[]
  /** Set when the request should be replaced by acting: what to do instead. */
  advice: string | null
}

export const MAX_CLARIFY_QUESTIONS = 5
export const MAX_CLARIFY_CHOICES = 4
export const MAX_QUESTION_CHARS = 300
export const MAX_CHOICE_CHARS = 80

/** Questions that only ask permission to keep working. */
const PERMISSION_QUESTION = /(?:^(?:boleh|mau|harus|perlu)\s+(?:saya|aku|gue|gw)\b|\b(?:lanjut|lanjutkan|teruskan)\s*\?|\b(?:should|shall|may|can)\s+i\s+(?:continue|proceed|go ahead|keep going)\b|\bshall we (?:continue|proceed)\b|\bcontinue\?|\bproceed\?|\boke? lanjut\b|\bmau saya lanjutkan\b|\bboleh saya kerjakan\b)/i

/** Questions that only ask for a preference the agent can pick itself. */
const PREFERENCE_QUESTION = /(?:\b(?:warna|colour|color|nama|name|gaya|style|format|penamaan|naming|layout|struktur folder|folder structure)\b.*\?)|(?:\bwhich (?:color|colour|name|style|format|library)\b)/i

function normalize(text: string): string {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Validate and normalize one clarify call.
 * `errors` are blocking (the model must fix the payload or proceed); `advice` explains why
 * the question should not be asked at all.
 */
export function evaluateClarifyRequest(raw: unknown): ClarifyEvaluation {
  const errors: string[] = []
  let advice: string | null = null
  const questions: ClarifyQuestion[] = []

  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, questions: [], errors: ['clarify needs at least one question.'], advice: null }
  }
  if (raw.length > MAX_CLARIFY_QUESTIONS) {
    errors.push(`clarify accepts at most ${MAX_CLARIFY_QUESTIONS} questions (got ${raw.length}); ask only the decisions that block you.`)
  }

  const seen = new Set<string>()
  for (const entry of raw.slice(0, MAX_CLARIFY_QUESTIONS)) {
    const question = String((entry as any)?.question ?? '').trim()
    if (!question) {
      errors.push('each clarify question needs non-empty text.')
      continue
    }
    if (question.length > MAX_QUESTION_CHARS) {
      errors.push(`clarify question is too long (${question.length} > ${MAX_QUESTION_CHARS} chars); state the blocking decision in one sentence.`)
      continue
    }
    const key = normalize(question)
    if (seen.has(key)) {
      errors.push(`duplicate clarify question: "${question}".`)
      continue
    }
    seen.add(key)

    const choices = Array.isArray((entry as any)?.choices)
      ? ((entry as any).choices as unknown[]).map(choice => String(choice ?? '').trim()).filter(Boolean)
      : undefined
    if (choices && choices.length > MAX_CLARIFY_CHOICES) {
      errors.push(`clarify question "${question}" offers ${choices.length} choices; keep at most ${MAX_CLARIFY_CHOICES} choices with the recommended one first.`)
      continue
    }
    if (choices && choices.some(choice => choice.length > MAX_CHOICE_CHARS)) {
      errors.push(`clarify choice text is too long (max ${MAX_CHOICE_CHARS} chars) in "${question}".`)
      continue
    }
    if (choices && new Set(choices.map(choice => normalize(choice))).size !== choices.length) {
      errors.push(`clarify question "${question}" repeats a choice.`)
      continue
    }

    if (PERMISSION_QUESTION.test(question)) {
      advice = 'This only asks permission to keep working. Continue the task with the next concrete step instead of asking; report the assumption you made.'
      continue
    }
    if (PREFERENCE_QUESTION.test(question)) {
      advice = 'This asks for a preference you can choose yourself. Pick the conventional default, state it in one line, and continue.'
      continue
    }

    questions.push({ question, ...(choices ? { choices } : {}), ...((entry as any)?.multi_select === true ? { multi_select: true } : {}) })
  }

  if (!advice && questions.length === 0 && errors.length === 0) {
    advice = 'Nothing in this request blocks progress; continue the task and state any assumption.'
  }

  return { ok: errors.length === 0 && Boolean(advice) === false && questions.length > 0, questions, errors, advice }
}

/** One-line result for the tool call, so the model sees why it must act instead of asking. */
export function formatClarifyOutcome(evaluation: ClarifyEvaluation): string {
  if (evaluation.advice && evaluation.questions.length === 0) {
    return JSON.stringify({
      clarification_needed: false,
      proceed: true,
      advice: evaluation.advice,
      message: 'Do not ask the user. Continue the task now and state the assumption you made in the final response.'
    })
  }
  if (!evaluation.ok) {
    return JSON.stringify({
      clarification_needed: false,
      proceed: true,
      error: evaluation.errors.join(' '),
      message: 'Fix the clarify payload only if a decision truly blocks you; otherwise continue the task and state your assumption.'
    })
  }
  return JSON.stringify({
    clarification_needed: true,
    proceed: false,
    responses: evaluation.questions.map(question => ({
      question: question.question,
      choices_offered: question.choices,
      status: 'clarification_requested'
    })),
    message: 'This runtime cannot collect structured answers: ask these questions directly in the final response, then stop and wait for the user.'
  })
}
