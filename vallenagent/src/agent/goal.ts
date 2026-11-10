/**
 * Standing goals (`/goal`) — the "keep going until it is actually done" loop.
 *
 * After each turn an auxiliary judge decides DONE or CONTINUE. The judge is a cheap, bounded provider
 * call that sees only the goal and the last assistant reply; it never sees tools or the full history,
 * so it cannot be talked into continuing by prompt injection from tool output.
 */

export type GoalVerdict = 'done' | 'continue'

export interface GoalState {
  text: string
  status: 'active' | 'paused' | 'done' | 'cleared'
  attempts: number
  maxTurns: number
}

export interface JudgeGoalOptions {
  provider: { chat(payload: any): Promise<any> }
  model: string
  goal: string
  lastReply: string
  signal?: AbortSignal
  timeoutMs?: number
}

const JUDGE_SYSTEM = `You are a strict completion judge. You receive a goal and the assistant's last reply.
Answer with exactly one word: DONE if the goal is fully achieved and verified by the reply, or CONTINUE
if any part of the goal remains. Never invent work that the goal does not ask for. If the reply claims
success without evidence (a command output, a test result, a file path), answer CONTINUE.`

export async function judgeGoal(options: JudgeGoalOptions): Promise<GoalVerdict> {
  const reply = String(options.lastReply || '').slice(0, 4000)
  try {
    const response = await options.provider.chat({
      model: options.model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: `Goal:\n${options.goal}\n\nAssistant's last reply:\n${reply}\n\nDONE or CONTINUE?` }
      ],
      max_tokens: 4,
      temperature: 0,
      timeout: Math.max(1000, Number(options.timeoutMs) || 15_000),
      signal: options.signal
    })
    const content = String(response?.choices?.[0]?.message?.content || '').trim().toUpperCase()
    return content.startsWith('DONE') ? 'done' : 'continue'
  } catch {
    // A broken judge must not trap the user in a loop.
    return 'done'
  }
}

export function createGoal(text: string, maxTurns = 20): GoalState {
  const goal = String(text || '').trim()
  if (!goal) throw new Error('goal text is required')
  return { text: goal.slice(0, 2000), status: 'active', attempts: 0, maxTurns: Math.max(1, Math.min(100, Number(maxTurns) || 20)) }
}

export function formatGoal(goal: GoalState | null): string {
  if (!goal) return 'No active goal. Set one with /goal <objective>.'
  const lines = [`Goal (${goal.status}) · attempt ${goal.attempts}/${goal.maxTurns}`, goal.text]
  if (goal.status === 'active') lines.push('Commands: /goal status · /goal pause · /goal resume · /goal clear')
  return lines.join('\n')
}

export function buildContinuationPrompt(goal: GoalState): string {
  return `[goal] Keep working toward this objective until it is verifiably complete:\n${goal.text}\n\n`
    + `Attempt ${goal.attempts + 1}/${goal.maxTurns}. Do not stop at a plan or a partial edit: finish the work, `
    + 'run the verification, and report the real output. If something blocks you, say exactly what and what you tried.'
}
