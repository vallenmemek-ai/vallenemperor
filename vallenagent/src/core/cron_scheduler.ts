import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getVallenHome } from './config'

const HISTORY_LIMIT = 500
const SEARCH_MINUTES = 366 * 24 * 60
export type CronDelivery = 'local' | 'telegram' | 'whatsapp'
export interface CronJobInput { name: string; prompt: string; cron: string; timezone: string; delivery: CronDelivery; ownerId?: number }
export interface CronJob extends CronJobInput { id: string; enabled: boolean; createdAt: string; nextRunAt: string }
export interface CronRun { id: string; jobId: string; ownerId?: number; name: string; startedAt: string; finishedAt: string; status: 'denied' | 'failed' | 'succeeded'; detail?: string }
interface CronState { jobs: CronJob[]; history: CronRun[] }

function parseField(value: string, min: number, max: number, name: string, dow = false): Set<number> {
  if (!value) throw new Error(`Invalid cron ${name}`)
  const values = new Set<number>()
  for (const part of value.split(',')) {
    const [base, stepText, ...extra] = part.split('/')
    if (extra.length || (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1))) throw new Error(`Invalid cron ${name}`)
    const step = stepText === undefined ? 1 : Number(stepText)
    let start: number, end: number
    if (base === '*') { start = min; end = max }
    else if (/^\d+$/.test(base)) { start = Number(base); end = stepText === undefined ? start : max }
    else if (/^\d+-\d+$/.test(base)) [start, end] = base.split('-').map(Number)
    else throw new Error(`Invalid cron ${name}`)
    if (start < min || end > max || start > end) throw new Error(`Invalid cron ${name}`)
    for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n)
  }
  return values
}

function parseCron(expression: string) {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron must contain five fields: minute hour day-of-month month day-of-week')
  return {
    minute: parseField(fields[0], 0, 59, 'minute'), hour: parseField(fields[1], 0, 23, 'hour'),
    day: parseField(fields[2], 1, 31, 'day-of-month'), month: parseField(fields[3], 1, 12, 'month'),
    weekday: parseField(fields[4], 0, 7, 'day-of-week', true), dayWildcard: fields[2] === '*', weekdayWildcard: fields[4] === '*'
  }
}

function partsAt(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday) }
}

export function nextCronRun(expression: string, timezone: string, after = new Date()): Date {
  const cron = parseCron(expression)
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(after) }
  catch { throw new Error(`Invalid timezone: ${timezone}`) }
  const firstMinute = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
  for (let offset = 0; offset <= SEARCH_MINUTES; offset++) {
    const candidate = new Date(firstMinute + offset * 60_000)
    const local = partsAt(candidate, timezone)
    const dayMatch = cron.day.has(local.day)
    const weekdayMatch = cron.weekday.has(local.weekday)
    const calendarMatch = cron.dayWildcard ? weekdayMatch : cron.weekdayWildcard ? dayMatch : dayMatch || weekdayMatch
    if (cron.minute.has(local.minute) && cron.hour.has(local.hour) && cron.month.has(local.month) && calendarMatch) return candidate
  }
  throw new Error('Cron expression has no run within 366 days')
}

export class CronStore {
  constructor(private readonly filePath = join(getVallenHome(), 'cron', 'jobs.json')) {}
  private queue: Promise<unknown> = Promise.resolve()

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(): Promise<CronState> {
    try {
      const state = JSON.parse(await readFile(this.filePath, 'utf8'))
      return { jobs: Array.isArray(state.jobs) ? state.jobs : [], history: Array.isArray(state.history) ? state.history : [] }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { jobs: [], history: [] }
      throw new Error(`Cannot read scheduled jobs: ${error.message}`)
    }
  }

  private async write(state: CronState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const { chmod } = await import('node:fs/promises')
    await chmod(dirname(this.filePath), 0o700)
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temp, this.filePath)
    } catch (error) {
      const { unlink } = await import('node:fs/promises')
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  async add(input: CronJobInput, now = new Date()): Promise<CronJob> {
    return this.exclusive(async () => {
      const name = String(input.name || '').trim()
      const prompt = String(input.prompt || '').trim()
      if (!name || name.length > 100) throw new Error('Job name must be 1-100 characters')
      if (!prompt || prompt.length > 4000) throw new Error('Job prompt must be 1-4000 characters')
      // 'whatsapp' is in the type but no adapter exists, so accepting it only created
      // jobs that failed on every run with a misleading "recipient not authorized".
      if (!['local', 'telegram'].includes(input.delivery)) throw new Error('Invalid delivery; choose local or telegram (WhatsApp has no adapter yet)')
      if (input.ownerId !== undefined && (!Number.isSafeInteger(input.ownerId) || input.ownerId <= 0)) throw new Error('Invalid scheduled job owner')
      const nextRunAt = nextCronRun(input.cron, input.timezone, now).toISOString()
      const job: CronJob = { id: randomUUID(), name, prompt, cron: input.cron.trim(), timezone: input.timezone, delivery: input.delivery, ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }), enabled: true, createdAt: now.toISOString(), nextRunAt }
      const state = await this.read(); state.jobs.push(job); await this.write(state)
      return job
    })
  }

  async list(ownerId?: number): Promise<CronJob[]> {
    return this.exclusive(async () => (await this.read()).jobs.filter(job => ownerId === undefined || job.ownerId === ownerId))
  }

  async history(limit = 100, ownerId?: number): Promise<CronRun[]> {
    return this.exclusive(async () => {
      const state = await this.read()
      const owned = ownerId === undefined ? state.history : state.history.filter(run => state.jobs.some(job => job.id === run.jobId && job.ownerId === ownerId) || run.ownerId === ownerId)
      return owned.slice(0, Math.max(0, Math.min(500, limit)))
    })
  }

  async remove(id: string, ownerId?: number): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.read(); const target = state.jobs.find(job => job.id === id && (ownerId === undefined || job.ownerId === ownerId))
      if (!target) return false
      state.jobs = state.jobs.filter(job => job.id !== id); await this.write(state); return true
    })
  }

  async claimDue(now = new Date()): Promise<CronJob[]> {
    return this.exclusive(async () => {
      const state = await this.read(); const due = state.jobs.filter(job => job.enabled && Date.parse(job.nextRunAt) <= now.getTime())
      if (!due.length) return []
      for (const job of due) job.nextRunAt = nextCronRun(job.cron, job.timezone, now).toISOString()
      await this.write(state)
      return due
    })
  }

  async complete(job: CronJob, result: { status: CronRun['status']; detail?: string }, startedAt = new Date()): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.read()
      state.history.unshift({ id: randomUUID(), jobId: job.id, ...(job.ownerId === undefined ? {} : { ownerId: job.ownerId }), name: job.name, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), status: result.status, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) })
      state.history = state.history.slice(0, HISTORY_LIMIT)
      await this.write(state)
    })
  }
}

export interface CronActions {
  authorize(job: CronJob): Promise<boolean>
  execute(job: CronJob): Promise<string>
  deliver(job: CronJob, result: string): Promise<void>
}

export class CronScheduler {
  private running = false
  constructor(private readonly store: CronStore, private readonly actions: CronActions) {}

  async runDue(now = new Date()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const job of await this.store.claimDue(now)) {
        const startedAt = new Date()
        try {
          if (!await this.actions.authorize(job)) {
            await this.store.complete(job, { status: 'denied', detail: 'Approval not granted' }, startedAt)
            continue
          }
          const result = await this.actions.execute(job)
          await this.actions.deliver(job, result)
          await this.store.complete(job, { status: 'succeeded', detail: result }, startedAt)
        } catch (error: any) {
          await this.store.complete(job, { status: 'failed', detail: error?.message || String(error) }, startedAt)
        }
      }
    } finally { this.running = false }
  }

  start(pollIntervalMs = 30_000): () => void {
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) throw new Error('Scheduler polling interval must be at least 1000ms')
    const timer = setInterval(() => { void this.runDue().catch(() => undefined) }, pollIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
