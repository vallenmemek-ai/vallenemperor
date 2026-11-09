import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getVallenHome } from '../core/config'
import type { McpServerConfig } from './types'
export interface ProjectMcpDiscovery { path: string; status: 'missing' | 'discovered-unapproved' | 'approved' | 'invalid'; hash?: string; servers?: Record<string, McpServerConfig> }
const approvalPath = () => join(getVallenHome(), 'mcp-project-approvals.json')
function approvals(): Record<string, string> { try { return JSON.parse(readFileSync(approvalPath(), 'utf8')) } catch { return {} } }
export function discoverProjectMcpConfig(cwd = process.cwd()): ProjectMcpDiscovery {
 const path = join(cwd, '.vallenemperor', 'mcp.json'); let text: string
 try { text = readFileSync(path, 'utf8') } catch { return { path, status: 'missing' } }
 const hash = createHash('sha256').update(text).digest('hex')
 try { const parsed = JSON.parse(text); const servers = parsed.servers ?? parsed.mcpServers ?? parsed; if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { path, hash, status: 'invalid' }; return { path, hash, status: approvals()[path] === hash ? 'approved' : 'discovered-unapproved', servers } } catch { return { path, hash, status: 'invalid' } }
}
export function approveProjectMcpConfig(cwd = process.cwd()): boolean {
 const found = discoverProjectMcpConfig(cwd); if (!found.hash || !found.servers) return false
 const data = approvals(); data[found.path] = found.hash; const path = approvalPath(); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); return true
}
export function isProjectMcpConfigApproved(cwd = process.cwd(), hash?: string): boolean { const found = discoverProjectMcpConfig(cwd); return Boolean(found.hash && (!hash || found.hash === hash) && approvals()[found.path] === found.hash) }
