import type { AIAgent } from '../agent/agent'
import { isMcpApproved, mcpServerFromTool, rememberMcpApproval, requiresApproval } from '../core/approval'
import { loadConfig } from '../core/config'
import { loadTelegramConfig } from './store'

export interface RemoteApprovalOptions {
  agent: AIAgent
  ownerId: number
  /** Asks the human; resolves true when the tool may run. */
  approve: (summary: string) => Promise<boolean>
  /** Reject the call when the owner is no longer on the allowlist (scheduled jobs). */
  requireAllowlist?: boolean
  /** Characters of a shell command shown in the prompt. */
  commandPreview?: number
}

/**
 * One approval gate for every remote surface. The daemon (scheduled jobs) and the
 * chat router each had their own copy with different wording and limits, which is
 * exactly how the CLI and core drifted apart before.
 */
export function createRemoteApprovalGate(options: RemoteApprovalOptions) {
  const { agent, ownerId, approve, requireAllowlist = false, commandPreview = 1200 } = options
  return async (info: { name: string; args: Record<string, any> }): Promise<boolean> => {
    const live = loadTelegramConfig()
    if (requireAllowlist && !live.allowlist.includes(ownerId)) return false
    const mode = loadConfig().gateway?.telegram?.approval || live.approval
    const server = mcpServerFromTool(info.name)
    const trusted = server ? agent.config.mcpServers?.[server]?.trusted === true : false
    if (!requiresApproval({ name: info.name, args: info.args }, mode, trusted)) return true
    if (server && isMcpApproved(agent.getSessionId(), server)) return true
    const summary = info.name === 'terminal'
      ? `Tool: ${info.name}\nCommand: ${String(info.args.command || '').slice(0, commandPreview)}`
      : server
        ? `Allow MCP ${server}, tool ${info.name}? Arguments are hidden.`
        : `Allow tool ${info.name}?`
    const allowed = await approve(summary)
    if (allowed && server) rememberMcpApproval(agent.getSessionId(), server)
    return allowed
  }
}
