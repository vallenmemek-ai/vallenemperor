import type { Message, ToolCall } from '../providers/providers'

/**
 * Turn stage — tool dispatch.
 *
 * Runs the tool calls of one assistant message: read-only tools that declare
 * `parallelSafe` run together (max 4), everything else runs in order. Every result is
 * appended to the conversation as a `tool` message so the next provider call sees it.
 */

export interface ToolBatchDeps {
  /** Executes one tool call and returns its raw result string. */
  execute: (call: ToolCall) => Promise<string>
  /** registry lookup: only tools that opt in may run concurrently. */
  isParallelSafe: (name: string) => boolean
  /** Approval callbacks and interrupts force sequential execution. */
  canParallelize: boolean
  conversationHistory: Message[]
  recordToolError: (result: string, name: string) => void
  saveCurrentSession: () => void
  /** Snapshot of the todo store, used to detect a real checklist change. */
  readTodos: () => unknown
}

export interface ToolBatchResult {
  /** true when a sequential todo_list call actually changed the checklist. */
  todoStateChanged: boolean
  /** Number of tool calls executed. */
  executed: number
}

const MAX_PARALLEL_TOOLS = 4

export async function runToolBatch(toolCalls: ToolCall[], deps: ToolBatchDeps): Promise<ToolBatchResult> {
  let toolIndex = 0
  let executed = 0
  let todoStateChanged = false

  while (toolIndex < toolCalls.length) {
    const first = toolCalls[toolIndex]
    const group: ToolCall[] = []
    if (deps.canParallelize && deps.isParallelSafe(first.function.name)) {
      while (toolIndex + group.length < toolCalls.length && group.length < MAX_PARALLEL_TOOLS) {
        const candidate = toolCalls[toolIndex + group.length]
        if (!deps.isParallelSafe(candidate.function.name)) break
        group.push(candidate)
      }
    }

    if (group.length > 1) {
      const results = await Promise.all(group.map(call => deps.execute(call)))
      group.forEach((call, index) => {
        deps.recordToolError(results[index], call.function.name)
        deps.conversationHistory.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: results[index] })
      })
      if (group.some(call => call.function.name === 'todo_list')) deps.saveCurrentSession()
      toolIndex += group.length
      executed += group.length
      continue
    }

    const previousTodoState = first.function.name === 'todo_list' ? JSON.stringify(deps.readTodos()) : ''
    const result = await deps.execute(first)
    deps.recordToolError(result, first.function.name)
    deps.conversationHistory.push({ role: 'tool', tool_call_id: first.id, name: first.function.name, content: result })
    if (first.function.name === 'todo_list') {
      if (JSON.stringify(deps.readTodos()) !== previousTodoState) todoStateChanged = true
      deps.saveCurrentSession()
    }
    toolIndex++
    executed++
  }

  return { todoStateChanged, executed }
}
