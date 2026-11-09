import { describeVerificationGroup, type VerificationGroup } from './verification'

/**
 * Turn stage — verification gate, evaluated just before a final answer is accepted.
 *
 * Pure decision so the loop does not have to encode policy: allow the answer, ask once
 * for the missing proof (nudge), or refuse the answer and report what is missing (block).
 */
export interface VerificationGateInput {
  /** The provider response carries tool calls, so this is not a final answer. */
  hasPendingToolCalls: boolean
  toolCallCount: number
  isSubagent: boolean
  /** Evidence groups this turn's edits made necessary. */
  dirty: VerificationGroup[]
  /** Evidence groups already proven by a successful command. */
  verified: VerificationGroup[]
  /** True when the ledger says one nudge is still owed for this turn. */
  shouldNudge: boolean
}

export type VerificationGateDecision =
  | { action: 'allow' }
  | { action: 'nudge'; message: string }
  | { action: 'block'; message: string }

export function decideVerificationGate(input: VerificationGateInput): VerificationGateDecision {
  if (input.hasPendingToolCalls || input.toolCallCount === 0) return { action: 'allow' }
  const missing = input.dirty.filter(group => !input.verified.includes(group))

  if (!input.isSubagent && input.shouldNudge) {
    const message = missing.length > 0
      ? `[Verification required] This turn changed files that need ${missing.map(describeVerificationGroup).join(' and ')}. Run the matching command now, then report the real result. A different command (or a read-only one) does not satisfy this requirement.`
      : '[Verification required] You changed files but ran no verification command (test/build/lint/typecheck). Run the relevant command now, then report the real result. If nothing can be run, say so explicitly instead of claiming completion.'
    return { action: 'nudge', message }
  }

  if (missing.length > 0) {
    return {
      action: 'block',
      message: `Task incomplete: this turn's changes lack ${missing.map(describeVerificationGroup).join(' and ')}.`
    }
  }

  return { action: 'allow' }
}
