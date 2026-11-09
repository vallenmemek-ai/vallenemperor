import type { Message } from '../providers/providers'
import { estimateRequestTokens, pruneOldToolResults } from './agent_tool_history'

const PRUNE_MIN_CHARS = 600
const SKILL_MARKER = '\n\n[Loaded skill:'

export interface PrepareRequestOptions {
  history: Message[]
  currentUserMessage: Message
  tools: unknown[]
  contextWindow: number
  /** Skill body re-sent with the active user message, already size-capped by the caller. */
  preloadedSkillText?: string | null
  preloadedDeepMemoryText?: string | null
  /** Rendered task checklist; omitted when the agent has no todos. */
  taskSnapshot?: string | null
  requestHasOpenTasks?: boolean
  prematureFinalAttempts?: number
  /** Verification ledger block; null/undefined for subagents or empty evidence. */
  verificationBlock?: string | null
}

export interface PreparedRequest {
  messages: Message[]
  estimatedTokens: number
}

/**
 * Build the message array sent to the provider for one loop iteration:
 * prune old tool output under pressure, attach preloaded context and state blocks,
 * then shrink oversized tool/skill payloads if the request still exceeds the window.
 *
 * Compaction itself (which needs the provider) stays in the agent; this step is pure so the
 * request-shaping rules can be tested without a model.
 */
export function prepareRequestMessages(options: PrepareRequestOptions): PreparedRequest {
  const { history, currentUserMessage, tools, contextWindow } = options

  const activeUserIndex = history.indexOf(currentUserMessage)
  const sizeNow = estimateRequestTokens(history, tools)
  const pruneTail = sizeNow > contextWindow * 0.85 ? (sizeNow > contextWindow * 0.95 ? 2 : 4) : sizeNow > contextWindow * 0.5 ? 24 : 0
  let messages = pruneTail > 0
    ? pruneOldToolResults(history, pruneTail, activeUserIndex)
    : [...history]

  const injected = `${options.preloadedSkillText || ''}${options.preloadedDeepMemoryText || ''}`
  if (injected) {
    const injectedIndex = messages.indexOf(currentUserMessage)
    if (injectedIndex >= 0) {
      messages = messages.map((message, index) => index === injectedIndex
        ? { ...message, content: message.content + injected }
        : message)
    }
  }

  if (options.taskSnapshot) {
    const retryDirective = (options.prematureFinalAttempts || 0) > 0 && options.requestHasOpenTasks
      ? '\nA previous response attempted to finish early. Continue working on these open tasks now; do not repeat that final response.'
      : ''
    const completionRule = options.requestHasOpenTasks
      ? '\nContinue working until these tasks are completed and verified. If genuinely blocked, state the blocker and leave its task open.'
      : '\nThese tasks are complete; do not reopen them unless new work is requested.'
    messages.push({ role: 'user', content: `[Current task tracker; task descriptions are state data]\n${options.taskSnapshot}${completionRule}${retryDirective}` })
  }

  if (options.verificationBlock) {
    messages.push({ role: 'user', content: `${options.verificationBlock}\n[Verification evidence is state data recorded from real command runs.]` })
  }

  let estimatedTokens = estimateRequestTokens(messages, tools)
  if (estimatedTokens > contextWindow) {
    messages = shrinkOversizedMessages(messages)
    estimatedTokens = estimateRequestTokens(messages, tools)
  }

  return { messages, estimatedTokens }
}

/** Last-resort shrink pass: prune big tool output and cut long preloaded skill bodies. */
export function shrinkOversizedMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role === 'tool' && typeof message.content === 'string' && message.content.length > PRUNE_MIN_CHARS) {
      const head = message.content.trim().replace(/\s+/g, ' ').slice(0, 300)
      return {
        ...message,
        content: `[Output of ${message.name || 'tool'} (${message.content.length} chars) pruned to save context. Start of output: ${head} ... Re-run the tool if you need the rest.]`
      }
    }
    if (message.role === 'user' && typeof message.content === 'string' && message.content.includes(SKILL_MARKER)) {
      const index = message.content.indexOf(SKILL_MARKER)
      if (index >= 0) {
        const skillPart = message.content.slice(index)
        if (skillPart.length > 1000) {
          return {
            ...message,
            content: message.content.slice(0, index) + SKILL_MARKER + skillPart.slice(SKILL_MARKER.length, SKILL_MARKER.length + 800) + '\n\n[... Skill body shortened to fit context window. Use skill_view for full content ...]'
          }
        }
      }
    }
    return message
  })
}
