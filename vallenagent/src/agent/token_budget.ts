import type { AgentConfig } from '../core/types'

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

export interface TokenAllowanceInput {
  config: Pick<AgentConfig, 'max_tokens_per_turn' | 'max_output_tokens'>
  /** Completion tokens already spent in this turn. */
  budgetTokensUsed: number
}

export interface TokenAllowance {
  /** max_tokens for the next provider request, or undefined for "provider default". */
  allowance: number | undefined
  /** Set when the per-turn budget is exhausted; the caller must stop instead of requesting. */
  error: string | null
  /** True when max_tokens_per_turn is configured, so per-turn accounting is enforced. */
  enforceTurnBudget: boolean
  /** Hard per-request output cap derived from config (max_output_tokens or 16k). */
  perRequestCap: number
  /** Configured per-turn output budget, or undefined when unset. */
  turnBudget: number | undefined
}

/**
 * Per-request output allowance.
 *
 * `max_tokens_per_turn` budgets OUTPUT tokens only. Prompt tokens are re-sent on every
 * iteration, so counting them made large-context turns hit the cap after one or two
 * requests and truncate tool-call arguments.
 */
export function computeOutputTokenAllowance({ config, budgetTokensUsed }: TokenAllowanceInput): TokenAllowance {
  const turnBudget = config.max_tokens_per_turn
  const enforceTurnBudget = typeof turnBudget === 'number' && Number.isFinite(turnBudget) && turnBudget > 0
  const perRequestCap = typeof config.max_output_tokens === 'number' && config.max_output_tokens > 0
    ? Math.floor(config.max_output_tokens)
    : DEFAULT_MAX_OUTPUT_TOKENS
  const base = { enforceTurnBudget, perRequestCap, turnBudget: enforceTurnBudget ? turnBudget : undefined }

  if (!enforceTurnBudget) {
    return {
      ...base,
      allowance: typeof config.max_output_tokens === 'number' && config.max_output_tokens > 0 ? perRequestCap : undefined,
      error: null
    }
  }

  const remaining = Math.floor(turnBudget! - budgetTokensUsed)
  if (remaining < 1) {
    return {
      ...base,
      allowance: undefined,
      error: `Per-turn output token budget (${turnBudget}) reached; turn stopped before another provider request. Raise max_tokens_per_turn in config to allow longer turns.`
    }
  }
  return { ...base, allowance: Math.min(remaining, perRequestCap), error: null }
}
