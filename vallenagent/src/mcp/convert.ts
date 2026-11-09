import { createHash } from 'crypto'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext, ToolRegistration, ToolSchema } from '../tools/tools'

export function makeMcpToolName(serverName: string, toolName: string, reserved: Set<string>): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
  const raw = `mcp__${clean(serverName)}__${clean(toolName)}`
  const shortened = raw.slice(0, 64)
  if (!reserved.has(shortened)) return shortened
  const digest = createHash('sha256').update(`${serverName}\0${toolName}`).digest('hex')
  for (let size = 8; size <= digest.length; size += 4) {
    const suffix = `_${digest.slice(0, size)}`
    const candidate = `${raw.slice(0, 64 - suffix.length)}${suffix}`
    if (!reserved.has(candidate)) return candidate
  }
  throw new Error('Unable to create unique MCP tool name')
}

export function createMcpToolRegistration(
  serverName: string,
  tool: Tool,
  reserved: Set<string>,
  onCall: (server: string, toolName: string, args: Record<string, unknown>, context: ToolContext, signal?: AbortSignal) => Promise<string>
): ToolRegistration {
  const name = makeMcpToolName(serverName, tool.name, reserved)
  const inputSchema = tool.inputSchema as Record<string, unknown>
  const parameters = {
    ...inputSchema,
    type: 'object' as const,
    properties: inputSchema.properties && typeof inputSchema.properties === 'object' && !Array.isArray(inputSchema.properties)
      ? inputSchema.properties
      : {},
    required: Array.isArray(inputSchema.required) ? inputSchema.required : undefined
  } as ToolSchema['parameters']
  return {
    name,
    toolset: 'mcp',
    mcpServer: serverName,
    skipArgumentValidation: true,
    schema: {
      name,
      description: `[MCP ${serverName}] ${String(tool.description || tool.name).slice(0, 1000)}`,
      parameters
    },
    handler: (args, context, signal) => onCall(serverName, tool.name, args, context, signal)
  }
}
