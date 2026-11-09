import { unlinkSync, writeFileSync } from 'fs'
import { chmodSafe } from '../core/platform'
import { join } from 'path'
import { logger } from '../core/logger'
import { CronScheduler, CronStore } from '../core/cron_scheduler'
import { createCronActions } from './cron_actions'
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
    const scheduler = new CronScheduler(cronStore, createCronActions({ adapter: () => adapter ?? null }))
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
