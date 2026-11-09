import type { AgentConfig } from '../core/types'
import type { SkillLoader } from '../skills/skills'
import type { McpServerSnapshot } from '../mcp/types'

export interface AgentOptions {
  config?: AgentConfig
  maxIterations?: number
  sessionId?: string
  sessionDir?: string
  isSubagent?: boolean
  backgroundReview?: boolean
  reviewMode?: boolean
  reviewUserMessages?: string[]
  lightweight?: boolean
  skillLoader?: SkillLoader
  onMcpStatus?: (servers: McpServerSnapshot[]) => void
}

export interface AgentResponse {
  response: string
  completionStatus?: 'complete' | 'incomplete'
  iterations: number
  totalTokens: number
  toolCalls: number
  promptTokens?: number
  completionTokens?: number
  latencySec?: number
  tokensPerSec?: number
  contextWindow?: number
  contextEstimated?: boolean
  /** What this turn actually produced on disk, plus the verification commands that ran. */
  artifacts?: {
    created: string[]
    changed: string[]
    saved: string[]
    verification: string[]
    summary: string
  }
}

export interface AgentContextStats {
  promptTokens: number
  contextWindow: number
  percent: number
  estimated: boolean
  sessionPromptTotal: number
  sessionCompletionTotal: number
  turns: number
  messages: number
  systemPromptTokens: number
  historyTokens: number
  largestToolName: string
  largestToolTokens: number
}

export interface AgentUsage {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  latencySec: number
  tokensPerSec: number
  contextWindow: number
  contextEstimated: boolean
  percent: number
  sessionPromptTotal: number
  sessionCompletionTotal: number
  turns: number
}

export interface AgentCallbacks {
  onBeforeTool?: (info: { id: string; name: string; args: Record<string, any> }) => Promise<boolean>
  onTerminalOutput?: (info: { id: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
  onToolStart?: (info: { id: string; name: string; args: Record<string, any>; preview: string }) => void
  onToolEnd?: (info: { id: string; name: string; args: Record<string, any>; result: string; preview: string }) => void
  onThinking?: (status: string) => void
  onTelemetry?: (telemetry: AgentUsage) => void
  onReviewComplete?: (summary: string) => void
  onReviewError?: (error: string) => void
  /** The review ran and finished without changing anything. */
  onReviewSkipped?: (reason: string) => void
  onSubagentProgress?: (event: { taskId: string; goal: string; status: 'started' | 'thinking' | 'tool_start' | 'tool_end' | 'completed' | 'failed'; message?: string }) => void
  onChunk?: (chunk: string) => void
}

export interface AgentTurnRequest {
  message: string
  surfaceId: string
}

export type AgentTurnEvent =
  | { type: 'thinking'; sessionId: string; surfaceId: string; message: string }
  | { type: 'tool_start'; sessionId: string; surfaceId: string; tool: { id: string; name: string; args: Record<string, any>; preview: string } }
  | { type: 'tool_end'; sessionId: string; surfaceId: string; tool: { id: string; name: string; args: Record<string, any>; result: string; preview: string } }
  | { type: 'terminal_output'; sessionId: string; surfaceId: string; output: { id: string; stream: 'stdout' | 'stderr'; chunk: string } }
  | { type: 'telemetry'; sessionId: string; surfaceId: string; usage: AgentUsage }
  | { type: 'review_complete'; sessionId: string; surfaceId: string; summary: string }
  | { type: 'review_error'; sessionId: string; surfaceId: string; error: string }
  | { type: 'review_skipped'; sessionId: string; surfaceId: string; reason: string }
  | { type: 'error'; sessionId: string; surfaceId: string; error: string }
  | { type: 'chunk'; sessionId: string; surfaceId: string; chunk: string }
  | { type: 'subagent_progress'; sessionId: string; surfaceId: string; taskId: string; goal: string; status: 'started' | 'thinking' | 'tool_start' | 'tool_end' | 'completed' | 'failed'; message?: string }

export type AgentTurnEventPayload = AgentTurnEvent extends infer Event
  ? Event extends AgentTurnEvent ? Omit<Event, 'sessionId' | 'surfaceId'> : never
  : never

export interface AgentToolApprovalRequest {
  sessionId: string
  surfaceId: string
  id: string
  name: string
  args: Record<string, any>
}

export interface AgentTurnCallbacks {
  onEvent?: (event: AgentTurnEvent) => void
  requestApproval?: (request: AgentToolApprovalRequest) => Promise<boolean>
  /** Enable provider streaming; status events alone do not force SSE mode. */
  stream?: boolean
}

export interface AgentTurnResult extends AgentResponse {
  sessionId: string
  surfaceId: string
}
