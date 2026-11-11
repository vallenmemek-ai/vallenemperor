import { logger } from '../core/logger'
// Tool registry system mirroring Hermes architecture

export interface ToolParameter {
  type: string
  description?: string
  enum?: string[]
  items?: ToolParameter
  properties?: Record<string, ToolParameter>
  required?: string[]
  default?: any
  [key: string]: any
}

export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required?: string[]
    [key: string]: any
  }
}

export type ToolHandler = (args: Record<string, any>, context: ToolContext, signal?: AbortSignal) => Promise<string>

function validateValue(value: unknown, parameter: ToolParameter, path: string): string | null {
  if (parameter.enum && !parameter.enum.includes(value as string)) return `${path} must be one of: ${parameter.enum.join(', ')}`
  const valid = parameter.type === 'string' ? typeof value === 'string'
    : parameter.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : parameter.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : parameter.type === 'boolean' ? typeof value === 'boolean'
    : parameter.type === 'array' ? Array.isArray(value)
    : parameter.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : true
  if (!valid) return `${path} must be ${parameter.type}`
  if (parameter.type === 'object' && parameter.properties) {
    const object = value as Record<string, unknown>
    for (const key of parameter.required || []) {
      if (object[key] === undefined) return `Missing required argument: ${path}.${key}`
    }
    for (const [key, child] of Object.entries(parameter.properties)) {
      if (object[key] !== undefined) {
        const error = validateValue(object[key], child, `${path}.${key}`)
        if (error) return error
      }
    }
  }
  if (parameter.type === 'array' && parameter.items) {
    for (let index = 0; index < (value as unknown[]).length; index++) {
      const error = validateValue((value as unknown[])[index], parameter.items, `${path}[${index}]`)
      if (error) return error
    }
  }
  return null
}

function coerceValue(value: unknown, parameter: ToolParameter): unknown {
  if ((parameter.type === 'integer' || parameter.type === 'number') && typeof value === 'string') {
    const text = value.trim()
    const numeric = parameter.type === 'integer' ? /^[+-]?\d+$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
    if (numeric.test(text)) {
      const number = Number(text)
      if (Number.isFinite(number)) return number
    }
  }
  if (parameter.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const normalized = { ...(value as Record<string, unknown>) }
    for (const [key, child] of Object.entries(parameter.properties || {})) {
      if (normalized[key] !== undefined) normalized[key] = coerceValue(normalized[key], child)
    }
    return normalized
  }
  if (parameter.type === 'array' && Array.isArray(value) && parameter.items) {
    return value.map(item => coerceValue(item, parameter.items!))
  }
  return value
}

function validateToolArguments(schema: ToolSchema, args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'Tool arguments must be an object'
  return validateValue(args, schema.parameters, 'arguments')
}

export interface FileReadCoverage {
  hash: string
  totalLines: number
  ranges: Array<[number, number]>
}

export interface ToolContext {
  /** Blocks on a real human when the host has an interactive prompt. */
  onClarify?: (questions: Array<{ question: string; choices?: string[]; multi_select?: boolean }>) => Promise<{ answers: Record<string, string | string[] | null>; outcome: 'submitted' | 'timed_out' | 'cancelled' | 'unavailable' }>
  sessionId?: string
  turnNumber?: number
  checkpointRoot?: string
  fileReadCoverage?: Map<string, FileReadCoverage>
  toolCallId?: string
  taskId?: string
  workingDir?: string
  providerConfig?: { base_url: string; api_key: string; model: string }
  httpRequester?: (url: URL, options: any, callback: (response: any) => void) => any
  isSubagent?: boolean
  reviewMode?: boolean
  reviewUserMessages?: string[]
  reviewSkillsRead?: Set<string>
  toolWhitelist?: string[]
  /** When set, file writes must stay inside one of these roots (subagents and sandboxed main agents). */
  sandboxRoots?: string[]
  /** Delegation depth: 0 for the main agent, 1 for its subagents, ... */
  agentDepth?: number
  /** Maximum delegation depth allowed by config (default 2). */
  maxAgentDepth?: number
  /** Terminal sandbox settings resolved from config.terminal. */
  terminalSandbox?: { mode: 'off' | 'auto' | 'required'; network: boolean; roots?: string[] }
  /** Apply a previously staged write without staging it again (/skills approve). */
  skipSkillStaging?: boolean
  mcpToolNames?: string[]
  mcpManager?: {
    callTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  }
  onTerminalOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  delegateAgentFactory?: (task: { taskId: string; goal: string; context?: string; max_iterations?: number; max_output_tokens?: number; model?: string; cwd?: string; agentInstructions?: string; tools?: string[] }, onProgress?: (event: { status: 'thinking' | 'tool_start' | 'tool_end'; message?: string }) => void, onHandle?: (handle: { interrupt: () => void }) => void) => Promise<string>
  onSubagentProgress?: (event: { taskId: string; goal: string; status: 'started' | 'thinking' | 'tool_start' | 'tool_end' | 'completed' | 'failed'; message?: string }) => void
  summarizeSessionHits?: (query: string, hits: Array<{ sessionId: string; snippet: string }>) => Promise<string | null>
  stores?: {
    memory?: any
    todo?: any
    skillLoader?: any
  }
}

export interface ToolRegistration {
  name: string
  schema: ToolSchema
  handler: ToolHandler
  toolset: string
  parallelSafe?: boolean
  checkFn?: () => boolean
  skipArgumentValidation?: boolean
  mcpServer?: string
}

const DEFERRED_TOOLS = new Set(['web_search', 'web_extract', 'browser_exec', 'image_generate', 'vision_analyze', 'manage_connections', 'skill_manage'])

class ToolRegistry {
  private tools: Map<string, ToolRegistration> = new Map()
  private whitelist: string[] | null = null

  register(tool: ToolRegistration): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`[Tools] Overwriting existing tool: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  registerDynamic(tool: ToolRegistration): void {
    if (tool.toolset !== 'mcp') throw new Error('Only MCP tools may be registered dynamically')
    const existing = this.tools.get(tool.name)
    if (existing && existing.toolset !== 'mcp') throw new Error(`MCP tool conflicts with built-in tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  unregisterMcpTools(serverName?: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.toolset === 'mcp' && (!serverName || tool.mcpServer === serverName)) this.tools.delete(name)
    }
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name)
  }

  list(): ToolRegistration[] {
    return Array.from(this.tools.values())
  }

  listByToolset(toolset: string): ToolRegistration[] {
    return this.list().filter(t => t.toolset === toolset)
  }

  filterTools(whitelist: string[]): void {
    this.whitelist = whitelist
  }

  clearFilter(): void {
    this.whitelist = null
  }

  getSchemas(enabledToolsets: string[] = [], whitelist?: string[]): ToolSchema[] {
    let tools = this.list()
    const allowedTools = whitelist ?? this.whitelist
    if (allowedTools) tools = tools.filter(t => allowedTools.includes(t.name))
    
    if (enabledToolsets.length > 0) {
      tools = tools.filter(t => enabledToolsets.includes(t.toolset))
    }
    
    // Filter by availability check
    tools = tools.filter(t => {
      if (!t.checkFn) return true
      try {
        return t.checkFn()
      } catch {
        return false
      }
    })
    
    return tools.map(t => t.schema)
  }

  getDeferredTools(whitelist?: string[], mcpToolNames?: string[]): ToolRegistration[] {
    const allowedTools = whitelist ?? this.whitelist
    const availableMcp = mcpToolNames ? new Set(mcpToolNames) : null
    return this.list().filter(tool => (DEFERRED_TOOLS.has(tool.name) || tool.toolset === 'mcp') &&
      (tool.toolset !== 'mcp' || !availableMcp || availableMcp.has(tool.name)) &&
      (!allowedTools || allowedTools.includes(tool.name)) && (!tool.checkFn || tool.checkFn()))
  }

  getOpenAISchemas(enabledToolsets: string[] = [], whitelist?: string[]): Array<{ type: 'function'; function: ToolSchema }> {
    return this.getSchemas(enabledToolsets, whitelist)
      .filter(schema => !DEFERRED_TOOLS.has(schema.name) && this.tools.get(schema.name)?.toolset !== 'mcp')
      .map(schema => ({ type: 'function', function: schema }))
  }

  async execute(name: string, args: Record<string, any>, context: ToolContext = {}, whitelist?: string[], signal?: AbortSignal): Promise<string> {
    const allowedTools = whitelist ?? this.whitelist
    if (allowedTools && !allowedTools.includes(name)) return JSON.stringify({ error: `Tool not allowed: ${name}` })
    if (name === 'delegate_task') {
      const depth = Number(context.agentDepth ?? (context.isSubagent ? 1 : 0))
      const maxDepth = Number(context.maxAgentDepth ?? 2)
      if (depth >= maxDepth) {
        return JSON.stringify({ error: `Delegation depth limit reached (${depth}/${maxDepth}). Finish this task yourself.` })
      }
    }
    const tool = this.tools.get(name)
    
    if (!tool) {
      return JSON.stringify({ error: `Tool not found: ${name}` })
    }
    
    try {
      if (tool.checkFn && !tool.checkFn()) return JSON.stringify({ error: `Tool unavailable: ${name}` })
      if (tool.skipArgumentValidation && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        return JSON.stringify({ error: 'Tool arguments must be an object' })
      }
      const normalizedArgs = tool.skipArgumentValidation
        ? args
        : coerceValue(args, tool.schema.parameters) as Record<string, any>
      const validationError = tool.skipArgumentValidation ? null : validateToolArguments(tool.schema, normalizedArgs)
      if (validationError) return JSON.stringify({ error: validationError })
      return await tool.handler(normalizedArgs, context, signal)
    } catch (err: any) {
      logger.error(`[Tools] Error executing ${name}:`, err)
      return JSON.stringify({ error: err.message || 'Tool execution failed' })
    }
  }
}

export const registry = new ToolRegistry()
