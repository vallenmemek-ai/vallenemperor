import { unlinkSync, writeFileSync } from 'fs'
import { chmodSafe } from '../core/platform'
import { join } from 'path'
import { logger } from '../core/logger'
import { AIAgent } from '../agent/agent'
import { loadConfig } from '../core/config'
import { requiresApproval, mcpServerFromTool, isMcpApproved, rememberMcpApproval } from '../core/approval'
import { CronScheduler, CronStore } from '../core/cron_scheduler'
import { TelegramAdapter } from './telegram'
import { gatewayDir, loadTelegramConfig, saveTelegramConfig } from './store'
import { redact } from './format'

const pidFile = join(gatewayDir(), 'telegram.pid')
let adapter: TelegramAdapter | undefined
let stopScheduledJobs: (() => void) | undefined
let stopping = false

async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return
  stopping = true
  try { stopScheduledJobs?.() } catch {}
  try { await adapter?.stop() } catch {}
  try { unlinkSync(pidFile) } catch {}
  process.exit(exitCode)
}

async function main(): Promise<void> {
  try {
    adapter = new TelegramAdapter()
    const cronStore = new CronStore()
    const scheduler = new CronScheduler(cronStore, {
      authorize: async job => {
        const live = loadTelegramConfig()
        return Boolean(job.ownerId && live.allowlist.includes(job.ownerId) && await adapter!.approve(job.ownerId, job.ownerId, `Scheduled job: ${job.name}\nPrompt: ${job.prompt.slice(0, 1200)}\nApprove this run?`))
      },
      execute: async job => {
        const config = structuredClone(loadConfig())
        config.terminal = { cwd: process.cwd() }
        const sessionDir = join(gatewayDir(), 'telegram', 'scheduled', 'sessions')
        const agent = new AIAgent({ config, sessionDir, sessionId: `cron-${job.id}-${Date.now()}`, maxIterations: config.gateway?.telegram?.max_iterations || 60, backgroundReview: false })
        const timeout = setTimeout(() => agent.interrupt(), config.gateway?.telegram?.turn_timeout_ms || 15 * 60_000)
        try {
          return (await agent.chat(job.prompt, {
          onBeforeTool: async info => {
            const live = loadTelegramConfig()
            if (!job.ownerId || !live.allowlist.includes(job.ownerId)) return false
            const mode = loadConfig().gateway?.telegram?.approval || live.approval
            const server = mcpServerFromTool(info.name)
            const trusted = server ? config.mcpServers?.[server]?.trusted === true : false
            if (!requiresApproval({ name: info.name, args: info.args }, mode, trusted)) return true
            if (server && isMcpApproved(agent.getSessionId(), server)) return true
            const summary = info.name === 'terminal'
              ? `Tool: ${info.name}\nCommand: ${String(info.args.command || '').slice(0, 1200)}`
              : server ? `MCP ${server}, tool ${info.name}; args hidden.` : `Allow tool ${info.name}?`
            const allowed = await adapter!.approve(job.ownerId, job.ownerId, summary)
            if (allowed && server) rememberMcpApproval(agent.getSessionId(), server)
            return allowed
          }
        })).response
        } finally { clearTimeout(timeout) }
      },
      deliver: async (job, result) => {
        if (job.delivery !== 'telegram' || !job.ownerId || !loadTelegramConfig().allowlist.includes(job.ownerId)) throw new Error('Telegram recipient is no longer authorized')
        await adapter!.finish(job.ownerId, `Scheduled job: ${job.name}\n\n${result}`)
      }
    })
    stopScheduledJobs = scheduler.start()
    void scheduler.runDue().catch(error => logger.error(`[Cron] Startup run failed: ${redact(String(error))}`))
    writeFileSync(pidFile, String(process.pid), { encoding: 'utf8', mode: 0o600 })
    chmodSafe(pidFile, 0o600)
    process.once('SIGTERM', () => { void shutdown() })
    process.once('SIGINT', () => { void shutdown() })
    await adapter.start()

    const monitor = setInterval(async () => {
      const state = await adapter?.status()
      if (state && !state.running && !stopping) {
        const error = state.last_error ? redact(String(state.last_error)) : 'Telegram polling stopped.'
        logger.error(`[Gateway] ${error}`)
        const config = loadTelegramConfig()
        config.last_error = error
        saveTelegramConfig(config)
        clearInterval(monitor)
        await shutdown(1)
      }
    }, 500)
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
    try {
      const config = loadTelegramConfig()
      config.last_error = message
      saveTelegramConfig(config)
    } catch {}
    logger.error(`[Gateway] Telegram daemon failed to start: ${message}`)
    try { unlinkSync(pidFile) } catch {}
    process.exit(1)
  }
}

void main()
