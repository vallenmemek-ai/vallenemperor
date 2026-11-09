import type { AIAgent } from '../../agent/agent'
import { saveConfig, validateMcpServers } from '../config'
import { approveProjectMcpConfig, discoverProjectMcpConfig } from '../../mcp/project_config'
import type { McpServerConfig, McpServerSnapshot } from '../../mcp/types'

function projectCwd(agent: AIAgent): string { return agent.config.terminal?.cwd || process.cwd() }

export function formatMcpStatus(snapshots: McpServerSnapshot[], projectLine = ''): string {
  const status = snapshots.length
    ? snapshots.map(server => `MCP ${server.status === 'ready' ? '✅' : server.status === 'failed' ? '❌' : '⏳'} ${server.name} · ${server.status === 'ready' ? `${server.toolCount} tool` : server.error || server.status}`).join(String.fromCharCode(10))
    : 'Belum ada server MCP.'
  return [status, projectLine, 'Tambah: /mcp add <nama> <command|url> [args…]. Bantuan: /help.'].filter(Boolean).join(String.fromCharCode(10))
}

export function formatMcpReconnect(name: string, server?: McpServerSnapshot): string {
  return server ? `Server ${name}: ${server.status}${server.error ? ` — ${server.error}` : ''}.` : `Server ${name} tidak ditemukan.`
}
export async function handleMcpCommand(agent: AIAgent, args: string[]): Promise<string> {
  const [action = 'status', name, ...rest] = args
  const configured = agent.config.mcpServers || {}
  const snapshots: McpServerSnapshot[] = agent.mcpManager?.getStatus() || Object.entries(configured).map(([serverName, config]) => ({
    name: serverName, status: config.enabled === false ? 'disabled' as const : 'connecting' as const, toolCount: 0
  }))
  if (action === 'status') {
    const project = discoverProjectMcpConfig(projectCwd(agent))
    const projectLine = project.status === 'missing' ? '' : `Project config: ${project.status} · ${project.path}${project.hash ? ` · sha256 ${project.hash.slice(0, 12)}` : ''}. Jalankan /mcp project approve hanya setelah meninjau file.`
    return formatMcpStatus(snapshots, projectLine)
  }
  if (action === 'project') {
    const discovery = discoverProjectMcpConfig(projectCwd(agent))
    if (name !== 'approve') return discovery.status === 'missing'
      ? `Tidak ada project MCP config (${discovery.path}).`
      : `Project MCP config: ${discovery.status} · ${discovery.path}${discovery.hash ? ` · sha256 ${discovery.hash.slice(0, 12)}` : ''}. Approval tidak memuatnya otomatis.`
    if (discovery.status === 'missing' || discovery.status === 'invalid' || !discovery.servers || !discovery.hash) return `Project MCP config tidak valid atau tidak ditemukan: ${discovery.path}.`
    const valid = validateMcpServers(discovery.servers)
    if (Object.keys(valid).length !== Object.keys(discovery.servers).length) return 'Project MCP config berisi entry invalid; tidak ada server diaktifkan.'
    const collisions = Object.keys(valid).filter(server => configured[server])
    if (collisions.length) return `Nama server project bentrok dengan config user: ${collisions.join(', ')}. Ubah nama lalu ulangi approval.`
    if (!approveProjectMcpConfig(projectCwd(agent))) return 'Approval gagal; file berubah atau tidak valid.'
    try {
      await agent.updateMcpServers({ ...configured, ...valid })
      return `Project MCP config disetujui berdasarkan hash ${discovery.hash.slice(0, 12)} dan server diaktifkan.`
    } catch { return 'Project MCP disetujui, tetapi koneksi gagal diterapkan.' }
  }
  if (action === 'trust' || action === 'untrust') {
    if (!name || !configured[name]) return `Server ${name || '(nama kosong)'} tidak ditemukan.`
    const trusted = action === 'trust'
    await agent.mcpManager?.setTrusted(name, trusted)
    const next = { ...configured, [name]: { ...configured[name], trusted } }
    return persistMcpConfig(agent, next, `Server ${name} ${trusted ? 'trusted' : 'untrusted'}; pilihan disimpan.`)
  }
  if (action === 'tools') {
    const tools = agent.mcpManager?.getTools(name) || []
    return tools.length
      ? tools.map(tool => `${name || 'MCP'} · ${tool.name}${tool.description ? ` — ${String(tool.description).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`).join('\n')
      : 'Tidak ada tool MCP aktif untuk server itu.'
  }
  if (action === 'add') {
    const [serverName, command, ...serverArgs] = [name, ...rest]
    if (!serverName || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(serverName)) return 'Nama server harus cocok dengan ^[a-z0-9][a-z0-9_-]{0,31}$.'
    if (!command) return 'Penggunaan: /mcp add <nama> <command> [args…]. Jangan masukkan token; atur env lewat config.json.'
    const isUrl = /^https?:\/\//i.test(command)
    if (isUrl && serverArgs.length) return 'Untuk HTTP gunakan /mcp add <nama> <url>; atur headers lewat config.json.'
    if (configured[serverName]) return `Server ${serverName} sudah ada.`
    const entry: McpServerConfig = isUrl
      ? { url: command, enabled: true, trusted: false }
      : { command, args: serverArgs, enabled: true, trusted: false }
    const next = { ...configured, [serverName]: entry }
    return persistMcpConfig(agent, next, `Server ${serverName} ditambahkan. Tambahkan env/headers sensitif lewat ~/.vallenemperor/config.json.`)
  }
  if (!name) return 'Penggunaan: /mcp status|project [approve]|add|remove|enable|disable|trust|untrust|reconnect|tools.'
  if (!configured[name]) return `Server ${name} tidak ditemukan.`
  if (action === 'remove') {
    const next = { ...configured }
    delete next[name]
    return persistMcpConfig(agent, next, `Server ${name} dihapus.`)
  }
  if (action === 'enable' || action === 'disable') {
    const next = { ...configured, [name]: { ...configured[name], enabled: action === 'enable' } }
    return persistMcpConfig(agent, next, `Server ${name} ${action === 'enable' ? 'diaktifkan' : 'dinonaktifkan'}.`)
  }
  if (action === 'reconnect') {
    if (!await agent.reconnectMcpServer(name)) return `Server ${name} tidak ditemukan.`
    const server = agent.mcpManager?.getStatus().find(item => item.name === name)
    return formatMcpReconnect(name, server)
  }
  return 'Penggunaan: /mcp status|project [approve]|add|remove|enable|disable|trust|untrust|reconnect|tools.'
}

async function persistMcpConfig(agent: AIAgent, servers: Record<string, McpServerConfig>, success: string): Promise<string> {
  try {
    saveConfig({ mcpServers: servers })
    await agent.updateMcpServers(servers)
    return success
  } catch {
    return 'Config MCP gagal disimpan atau diterapkan.'
  }
}

