import { logger } from '../core/logger'
import { registry } from '../tools/tools'
import type { AgentConfig } from '../core/types'
import type { McpManager } from '../mcp/manager'
import type { McpServerSnapshot } from '../mcp/types'

export interface McpWiringOptions {
  /** Servers to connect on start; read lazily so config edits are picked up. */
  getServers: () => AgentConfig['mcpServers']
  /** True once the agent is shutting down; blocks new connections. */
  isShuttingDown: () => boolean
  /** Called whenever server state may have changed. */
  onStatus: (servers: McpServerSnapshot[]) => void
}

/**
 * Owns the MCP connection lifecycle for an agent: startup, tool registration,
 * reconnect, server replacement and shutdown.
 *
 * Kept out of the agent class so connection state (manager, registered tool names,
 * in-flight startup promise) has one owner and can be tested with a fake manager.
 */
export class McpWiring {
  manager: McpManager | null = null
  toolNames: string[] = []
  startup: Promise<void> | null = null

  constructor(private readonly options: McpWiringOptions) {}

  /** Connect every configured server; failures degrade to "no MCP" without killing the turn. */
  async start(): Promise<void> {
    try {
      const { McpManager } = await import('../mcp/manager.js')
      if (this.options.isShuttingDown()) return
      this.manager = new McpManager(this.options.getServers(), {
        onToolsChanged: async () => { await this.register(); this.emit() }
      })
      await this.manager.connectAll()
      await this.register()
      this.emit()
    } catch {
      logger.warn('[MCP] Startup failed; continuing without MCP servers.')
      this.emit()
    }
  }

  emit(): void {
    try { this.options.onStatus(this.manager?.getStatus() || []) } catch {}
  }

  /** Register every MCP tool in the global registry, keeping names collision-free. */
  async register(): Promise<void> {
    this.toolNames = []
    if (!this.manager) return
    const { createMcpToolRegistration } = await import('../mcp/convert.js')
    const reserved = new Set(registry.list().filter(tool => tool.toolset !== 'mcp').map(tool => tool.name))
    const entries = [...this.manager.getToolEntries()].sort((a, b) =>
      a.serverName.localeCompare(b.serverName) || a.tool.name.localeCompare(b.tool.name))
    for (const { serverName, tool } of entries) {
      const registration = createMcpToolRegistration(serverName, tool, reserved, (server, name, args, context, signal) =>
        context.mcpManager
          ? context.mcpManager.callTool(server, name, args, signal)
          : Promise.resolve(JSON.stringify({ error: 'MCP server is not available in this agent' }))
      )
      registry.registerDynamic(registration)
      reserved.add(registration.name)
      this.toolNames.push(registration.name)
    }
  }

  async reconnect(name: string): Promise<boolean> {
    await this.startup
    if (!this.manager) return false
    const reconnected = await this.manager.reconnect(name)
    if (reconnected) await this.register()
    this.emit()
    return reconnected
  }

  /** Replace the server set, connecting a fresh manager when none is live yet. */
  async replace(servers: NonNullable<AgentConfig['mcpServers']>): Promise<void> {
    await this.startup
    if (!Object.keys(servers).length) {
      await this.shutdown()
      return
    }
    if (this.manager) await this.manager.replaceServers(servers)
    else {
      const { McpManager } = await import('../mcp/manager.js')
      this.manager = new McpManager(servers, {
        onToolsChanged: async () => { await this.register(); this.emit() }
      })
      await this.manager.connectAll()
    }
    await this.register()
    this.emit()
  }

  async shutdown(): Promise<void> {
    await this.startup
    await this.manager?.shutdown()
    this.manager = null
    this.toolNames = []
    this.emit()
  }
}
