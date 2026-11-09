import type { AgentConfig } from '../core/types'
import type { AgentContextStats } from './agent_types'
import type { Message } from '../providers/providers'

export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Context window for a model: explicit per-model override, then the configured default,
 * then 128k. Values that are not positive finite numbers are ignored rather than trusted.
 */
export function resolveContextWindow(config: Pick<AgentConfig, 'context_windows' | 'default_context_window'>, model: string): number {
  const configured = config.context_windows?.[model]
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured
  const fallback = config.default_context_window
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_CONTEXT_WINDOW
}

export interface ContextStatsInput {
  history: Message[]
  cachedSystemPrompt?: string | null
  contextWindow: number
  lastPromptTokens: number
  lastContextEstimated: boolean
  sessionPromptTotal: number
  sessionCompletionTotal: number
  turns: number
}

/** Token/size breakdown for the current session, reported to the CLI status bar. */
export function computeContextStats(input: ContextStatsInput): AgentContextStats {
  const system = String(input.history[0]?.content || input.cachedSystemPrompt || '')
  const history = input.history.slice(1)
  const largestTool = history
    .filter(message => message.role === 'tool')
    .reduce((largest, message) => String(message.content || '').length > String(largest?.content || '').length ? message : largest, null as Message | null)
  return {
    promptTokens: input.lastPromptTokens,
    contextWindow: input.contextWindow,
    percent: Math.min(100, Math.round(input.lastPromptTokens / input.contextWindow * 100)),
    estimated: input.lastContextEstimated,
    sessionPromptTotal: input.sessionPromptTotal,
    sessionCompletionTotal: input.sessionCompletionTotal,
    turns: input.turns,
    messages: input.history.length,
    systemPromptTokens: Math.ceil(system.length / 4),
    historyTokens: Math.ceil(history.reduce((sum, message) => sum + String(message.content || '').length, 0) / 4),
    largestToolName: largestTool?.name || '',
    largestToolTokens: largestTool ? Math.ceil(String(largestTool.content || '').length / 4) : 0
  }
}
