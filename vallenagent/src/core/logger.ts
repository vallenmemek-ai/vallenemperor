import { appendFileSync, mkdirSync } from 'fs'
import { chmodSafe } from './platform'
import { homedir } from 'os'
import { join } from 'path'

type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const levels: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const configured = process.env.VALLENEMPEROR_LOG as LogLevel | undefined
const threshold = configured && configured in levels ? levels[configured] : levels.warn
const interactive = process.env.VALLENEMPEROR_INTERACTIVE === '1' || Boolean(process.stdout.isTTY || process.stderr.isTTY)

function format(args: unknown[]): string {
  return args.map(value => {
    if (value instanceof Error) return value.stack || value.message
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
  }).join(' ')
}

function emit(level: LogLevel, args: unknown[], consoleWriter: (...values: unknown[]) => void): void {
  if (!interactive) {
    consoleWriter(...args)
    return
  }
  try {
    const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
    const logDir = join(home, 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    chmodSafe(logDir, 0o700)
    const logPath = join(logDir, 'agent.log')
    appendFileSync(logPath, `${new Date().toISOString()} [${level.toUpperCase()}] ${format(args)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSafe(logPath, 0o600)
  } catch {}
}

export const logger = {
  error: (...args: unknown[]): void => { if (threshold >= levels.error) emit('error', args, console.error) },
  warn: (...args: unknown[]): void => { if (threshold >= levels.warn) emit('warn', args, console.warn) },
  info: (...args: unknown[]): void => { if (threshold >= levels.info) emit('info', args, console.info) },
  debug: (...args: unknown[]): void => { if (threshold >= levels.debug) emit('debug', args, console.debug) }
}
