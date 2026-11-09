export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  trusted?: boolean
  timeoutMs?: number
}

export type McpServerStatus = 'disabled' | 'connecting' | 'ready' | 'failed'

export interface McpServerSnapshot {
  name: string
  status: McpServerStatus
  toolCount: number
  error?: string
}
