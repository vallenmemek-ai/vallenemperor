import { logger } from '../core/logger'
import type { Message } from '../providers/providers'
import { isMalformedToolCallError, isCompactionWorthyOverflow } from './failure_classification'
import { estimateRequestTokens } from './agent_tool_history'
import { stripCacheMarkers } from './prompt_cache'

/**
 * Turn stage — provider call, with the two retries the runtime actually needs:
 *
 * 1. the provider rejects `cache_control` markers → drop them and retry once;
 * 2. the provider reports a context/payload overflow (or a 400 on a request that is
 *    clearly too large) → compact history once and retry.
 *
 * Everything else is rethrown: a provider failure must stay visible.
 */

export interface ProviderRetryDeps {
  /** Sends one payload; `maxTokens` overrides the per-request allowance. */
  call: (messages: Message[], maxTokens?: number) => Promise<any>
  /** Request messages, cache markers included when prompt caching is on. */
  messages: Message[]
  /** Same messages without cache markers (retry path). */
  plainMessages: Message[]
  promptCacheEnabled: boolean
  estimatedTokens: number
  contextWindow: number
  /** Tool schemas, needed to re-estimate the compacted payload. */
  tools: unknown[]
  outputTokenAllowance?: number
  /** Builds the compacted retry payload + the history it corresponds to; null when compaction cannot help. */
  buildRetry: () => { retryMessages: Message[]; compactedHistory: Message[] } | null
  disablePromptCache: () => void
  replaceHistory: (history: Message[]) => void
}

export async function callProviderWithRetry(deps: ProviderRetryDeps): Promise<any> {
  try {
    return await deps.call(deps.messages)
  } catch (error: any) {
    const failure = String(error?.message || '')
    const rejectedCache = deps.promptCacheEnabled && deps.messages !== deps.plainMessages && /(^|\D)400(\D|$)|invalid|unknown field|unsupported/i.test(failure)
    if (rejectedCache) {
      logger.warn('[Agent] Provider rejected cache_control; retrying without prompt cache markers.')
      deps.disablePromptCache()
      return await deps.call(stripCacheMarkers(deps.messages))
    }

    const malformedToolCall = isMalformedToolCallError(failure)
    const explicitContextOverflow = isCompactionWorthyOverflow(failure)
    const genericBadRequest = !malformedToolCall && failure.includes('Provider API error: 400') && /invalid request/i.test(failure) && !/context length|context window|too many tokens|max_tokens/i.test(failure)
    const inputOutputBudget = deps.estimatedTokens + Math.max(0, deps.outputTokenAllowance || 0)
    if (!explicitContextOverflow && (!genericBadRequest || inputOutputBudget <= deps.contextWindow * 0.5)) throw error

    const retry = deps.buildRetry()
    if (!retry) throw error
    if (estimateRequestTokens(retry.retryMessages, deps.tools as any) >= deps.estimatedTokens) throw error

    logger.warn(`[Agent] ${explicitContextOverflow ? 'Explicit context/payload overflow' : 'Generic provider 400 on large request'} (${inputOutputBudget}/${deps.contextWindow} estimated input+output tokens); retrying once with compacted history.`)
    const response = await deps.call(retry.retryMessages)
    deps.replaceHistory(retry.compactedHistory)
    return response
  }
}

/**
 * Turn stage — finish a response the provider cut off with `finish_reason: 'length'`.
 *
 * Only a text-only partial answer is continued (a truncated tool call cannot be resumed);
 * at most two continuation requests, and only while the token budget allows it.
 */

export interface ContinuationDeps {
  call: (messages: Message[], maxTokens?: number) => Promise<any>
  requestMessages: Message[]
  tools: unknown[]
  contextWindow: number
  /** Estimate used when the provider reports no prompt usage. */
  estimatedTokens: number
  enforceTokenBudget: boolean
  tokenBudget?: number
  budgetTokensUsed: number
  /** Always defined: computeOutputTokenAllowance falls back to DEFAULT_MAX_OUTPUT_TOKENS. */
  perRequestCap: number
  response: any
}

export interface ContinuationResult {
  response: any
  assistantMessage: any
  continuationText: string
  responseTruncated: boolean
  extraPromptTokens: number
  extraCompletionTokens: number
}

export async function continueTruncatedResponse(deps: ContinuationDeps): Promise<ContinuationResult> {
  let response = deps.response
  let choice = response.choices[0]
  let assistantMessage = choice.message
  let continuationText = ''
  let continuationRetries = 0
  let responseTruncated = false
  let extraPromptTokens = 0
  let extraCompletionTokens = 0

  while (choice.finish_reason === 'length') {
    if (assistantMessage.tool_calls?.length || !assistantMessage.content?.trim()) {
      responseTruncated = true
      break
    }
    continuationText += assistantMessage.content
    extraPromptTokens += response.usage?.prompt_tokens || deps.estimatedTokens
    extraCompletionTokens += response.usage?.completion_tokens || Math.ceil(assistantMessage.content.length / 4)
    if (continuationRetries >= 2) {
      responseTruncated = true
      break
    }
    const remaining = deps.enforceTokenBudget
      ? Math.floor(deps.tokenBudget! - deps.budgetTokensUsed - extraCompletionTokens)
      : deps.perRequestCap
    if (remaining < 1) {
      responseTruncated = true
      break
    }
    const continuationMessages: Message[] = [
      ...deps.requestMessages,
      { role: 'assistant', content: continuationText },
      { role: 'user', content: 'Continue the previous response from its exact ending. Do not repeat earlier text. If finished, end normally.' }
    ]
    if (estimateRequestTokens(continuationMessages, deps.tools as any) > deps.contextWindow) {
      responseTruncated = true
      break
    }
    continuationRetries++
    response = await deps.call(continuationMessages, Math.min(deps.perRequestCap, remaining))
    choice = response.choices[0]
    assistantMessage = choice.message
  }

  if (continuationText) assistantMessage = { ...assistantMessage, content: continuationText + (assistantMessage.content || '') }
  if (responseTruncated && assistantMessage.tool_calls?.length) assistantMessage = { ...assistantMessage, tool_calls: undefined }

  return { response, assistantMessage, continuationText, responseTruncated, extraPromptTokens, extraCompletionTokens }
}
