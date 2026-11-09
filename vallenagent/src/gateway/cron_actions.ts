import { appendFileSync } from 'fs'
import { join } from 'path'

import { AIAgent } from '../agent/agent'
import { handleCommand } from '../core/commands'
import { loadConfig } from '../core/config'
import type { CronJob } from '../core/cron_scheduler'
import { logger } from '../core/logger'
import { createRemoteApprovalGate } from './approval_gate'
import { gatewayDir, loadTelegramConfig } from './store'

/** The slice of the Telegram adapter the scheduler needs. */
export interface CronChatAdapter {
  approve(chatId: number, userId: number, summary: string): Promise<boolean>
  finish(chatId: number, text: string): Promise<void>
}

export interface CronActionDeps {
  /** Returns the chat adapter, or null when no chat channel is running. */
  adapter?: () => CronChatAdapter | null
  /** Override agent construction (tests). */
  createAgent?: (job: CronJob) => Pick<AIAgent, 'chat'> & { interrupt(): void }
  /** Override the local result log path (tests). */
  localLogPath?: () => string
}

/**
 * The scheduled-job pipeline lives here instead of inside daemon.ts so it can be
 * tested without a Telegram token — and so the local/telegram branches are written
 * once, in one place.
 */
export function createCronActions(deps: CronActionDeps = {}) {
  const adapter = deps.adapter ?? (() => null)
  const localLogPath = deps.localLogPath ?? (() => join(gatewayDir(), 'cron-local.log'))
  const createAgent = deps.createAgent ?? ((job: CronJob) => {
    const config = structuredClone(loadConfig())
    config.terminal = { cwd: process.cwd() }
    return new AIAgent({
      config,
      sessionDir: join(gatewayDir(), 'telegram', 'scheduled', 'sessions'),
      sessionId: `cron-${job.id}-${Date.now()}`,
      maxIterations: config.gateway?.telegram?.max_iterations || 60,
      backgroundReview: false
    })
  })

  return {
    authorize: async (job: CronJob): Promise<boolean> => {
      // A terminal-created job has no Telegram owner, so there is nobody to ask.
      // It may run; execute() denies anything that would need a human.
      if (job.delivery === 'local') return true
      const chat = adapter()
      const live = loadTelegramConfig()
      if (!chat || !job.ownerId || !live.allowlist.includes(job.ownerId)) return false
      return chat.approve(job.ownerId, job.ownerId, `Scheduled job: ${job.name}\nPrompt: ${job.prompt.slice(0, 1200)}\nApprove this run?`)
    },

    execute: async (job: CronJob): Promise<string> => {
      const agent = createAgent(job)
      const chat = adapter()
      const config = loadConfig()
      const timeout = setTimeout(() => agent.interrupt(), config.gateway?.telegram?.turn_timeout_ms || 15 * 60_000)
      try {
        const prompt = job.prompt.trim()
        // A scheduled "/status" must run the command, exactly like `-p "/status"`.
        if (/^\/[a-z]/i.test(prompt)) {
          const shared = await handleCommand({
            channel: job.delivery === 'local' ? 'terminal' : 'remote',
            agent: agent as unknown as AIAgent,
            userId: job.ownerId ?? 0,
            sessionPrefix: 'cron'
          }, prompt)
          if (shared?.handled) return String(shared.response || '').trim()
        }
        const result = await agent.chat(prompt, {
          onBeforeTool: createRemoteApprovalGate({
            agent: agent as unknown as AIAgent,
            ownerId: job.ownerId ?? 0,
            requireAllowlist: job.delivery === 'telegram',
            // Without a chat there is no one to approve, so a local job refuses risky tools.
            approve: job.ownerId && chat
              ? summary => chat.approve(job.ownerId!, job.ownerId!, summary)
              : async () => false
          })
        })
        return String(result.response || '')
      } finally {
        clearTimeout(timeout)
      }
    },

    deliver: async (job: CronJob, result: string): Promise<void> => {
      if (job.delivery === 'local') {
        const path = localLogPath()
        appendFileSync(path, `${new Date().toISOString()} · ${job.name}\n${result}\n\n`, { encoding: 'utf8', mode: 0o600 })
        logger.info(`[Cron] Local job "${job.name}" finished (${String(result).length} chars) → ${path}`)
        return
      }
      if (job.delivery !== 'telegram') throw new Error(`No delivery adapter for "${job.delivery}"; supported: local, telegram`)
      const chat = adapter()
      if (!chat || !job.ownerId || !loadTelegramConfig().allowlist.includes(job.ownerId)) throw new Error('Telegram recipient is no longer authorized')
      await chat.finish(job.ownerId, `Scheduled job: ${job.name}\n\n${result}`)
    }
  }
}
