import type { AgentResponse } from './agent_types'

/**
 * Turn stage — successful finalization.
 *
 * Everything that happens once a final answer is accepted: checkpoint bookkeeping, session
 * persistence, counters, skill outcome stats, the background-review decision and the result
 * object. Extracted from agent.ts so the loop ends with one call instead of 40 inline lines.
 */

export interface TurnFinalizeDeps {
  isSubagent: boolean
  finalContent: string
  iterations: number
  totalTokens: number
  toolCallCount: number
  promptTokens: number
  completionTokens: number
  latencySec: number
  tokensPerSec: number
  contextWindow: number
  contextEstimated?: boolean
  artifacts: AgentResponse['artifacts']
  /** Prompt tokens spent in this turn (all iterations). */
  turnPromptTokens: number
  /** Turn count before this turn is counted. */
  completedUserTurns: number
  skillName?: string
  /** Outcome of the last verification entry this turn, if any. */
  lastVerificationOk: boolean | null
  backgroundReviewEnabled: boolean
  reviewInterval: number
  toolErrorCount: number
  userMessage: string
  shouldRunReview: (userMessage: string, completedUserTurns: number, toolCalls: number, interval: number, toolErrors: number) => boolean
  tryStartReview: () => boolean
  spawnReview: () => void
  recordSkillCompleted?: (name: string, outcome: 'verified' | 'failed' | 'unknown') => void
  saveCurrentSession: () => void
  finalizeCheckpoint: (turnNumber: number) => void
  clearCheckpoint: () => void
}

export interface TurnFinalizeResult {
  result: AgentResponse
  /** Prompt-token delta to add to the session total. */
  sessionPromptDelta: number
  /** Completion-token delta to add to the session total. */
  sessionCompletionDelta: number
  /** Turn count after this turn. */
  completedUserTurns: number
}

export function finalizeSuccessfulTurn(deps: TurnFinalizeDeps): TurnFinalizeResult {
  if (!deps.isSubagent) {
    try { deps.finalizeCheckpoint(deps.completedUserTurns + 1) } catch {}
  }
  // The turn finished, so a resume checkpoint from an earlier failure is stale. Leaving it
  // made the next start offer to resume work that was already done.
  if (!deps.isSubagent) {
    try { deps.clearCheckpoint() } catch {}
  }
  // Persist session to disk (skip for subagents - BUG-20)
  try { deps.saveCurrentSession() } catch {}

  const completedUserTurns = deps.completedUserTurns + 1

  if (!deps.isSubagent && deps.skillName && deps.recordSkillCompleted) {
    const outcome = deps.lastVerificationOk === null ? 'unknown' : deps.lastVerificationOk ? 'verified' : 'failed'
    try { deps.recordSkillCompleted(deps.skillName, outcome) } catch {}
  }

  if (deps.backgroundReviewEnabled && !deps.isSubagent && deps.iterations > 0 &&
      deps.shouldRunReview(deps.userMessage, completedUserTurns, deps.toolCallCount, deps.reviewInterval, deps.toolErrorCount) &&
      deps.tryStartReview()) {
    deps.spawnReview()
  }

  return {
    result: {
      response: deps.finalContent,
      completionStatus: 'complete',
      iterations: deps.iterations,
      totalTokens: deps.totalTokens,
      toolCalls: deps.toolCallCount,
      promptTokens: deps.promptTokens,
      completionTokens: deps.completionTokens,
      latencySec: deps.latencySec,
      tokensPerSec: deps.tokensPerSec,
      contextWindow: deps.contextWindow,
      contextEstimated: deps.contextEstimated,
      artifacts: deps.artifacts
    },
    sessionPromptDelta: deps.turnPromptTokens,
    sessionCompletionDelta: deps.completionTokens,
    completedUserTurns
  }
}
