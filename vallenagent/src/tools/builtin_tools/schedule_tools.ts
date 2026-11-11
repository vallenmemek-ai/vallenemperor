import { registry, ToolSchema } from '../tools'
import { CronStore } from '../../core/cron_scheduler'

/**
 * `schedule` — the cron scheduler lived in core with no tool wrapper, so the agent
 * could not create a recurring job without shelling out. This is a thin wrapper
 * over the same CronStore the Telegram gateway uses.
 *
 * Lifecycle parity with Hermes' cronjob_manage: list, add, update, pause, resume,
 * run (fire now), remove, history. `cancel` is deliberately absent: VallenEmperor
 * has no live-run registry, so there is no in-flight run to stop — pause is the
 * honest equivalent.
 */
export function registerScheduleTools(): void {
  const schema: ToolSchema = {
    name: 'schedule',
    description: 'Manage scheduled agent jobs (cron). action=list shows jobs, add creates one, update edits name/prompt/cron/timezone, pause and resume toggle it, run fires it on the next tick without changing its schedule, remove deletes it, history shows recent runs. Always list first and use the real job id.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'pause', 'resume', 'run', 'remove', 'history'], description: 'What to do (default: list)' },
        id: { type: 'string', description: 'Job id (update, pause, resume, run, remove)' },
        name: { type: 'string', description: 'Job name (add; optional on update)' },
        prompt: { type: 'string', description: 'Prompt the job runs (add; optional on update)' },
        cron: { type: 'string', description: 'Five-field cron expression, e.g. "0 9 * * *" (add; optional on update)' },
        timezone: { type: 'string', description: 'IANA timezone (default: host timezone)' },
        delivery: { type: 'string', enum: ['local', 'telegram'], description: 'Where the result goes (default: local)' },
        limit: { type: 'integer', description: 'History entries to return (default: 20)' }
      },
      required: ['action']
    }
  }

  registry.register({
    name: 'schedule',
    schema,
    toolset: 'core',
    handler: async args => {
      const store = new CronStore()
      const action = String(args.action || 'list').toLowerCase()
      const id = String(args.id || '').trim()
      const needId = () => (id ? null : JSON.stringify({ error: `id is required for action=${action}` }))
      try {
        if (action === 'list') {
          const jobs = await store.list()
          return JSON.stringify({ action, jobs, total: jobs.length })
        }
        if (action === 'history') {
          const runs = await store.history(Math.max(1, Math.min(100, Number(args.limit) || 20)))
          return JSON.stringify({ action, runs, total: runs.length })
        }
        if (action === 'remove') {
          const missing = needId(); if (missing) return missing
          return JSON.stringify({ action, id, removed: await store.remove(id) })
        }
        if (action === 'pause' || action === 'resume') {
          const missing = needId(); if (missing) return missing
          const job = await store.setEnabled(id, action === 'resume')
          return job
            ? JSON.stringify({ action, job, note: action === 'pause' ? 'Job paused; it stays in the list but is never claimed.' : `Job resumed; next run ${job.nextRunAt}.` })
            : JSON.stringify({ action, id, error: 'Scheduled job not found.' })
        }
        if (action === 'run') {
          const missing = needId(); if (missing) return missing
          const job = await store.runNow(id)
          return job
            ? JSON.stringify({ action, job, note: 'Job queued to fire on the next scheduler tick; its schedule is unchanged.' })
            : JSON.stringify({ action, id, error: 'Scheduled job not found.' })
        }
        if (action === 'update') {
          const missing = needId(); if (missing) return missing
          const patch: Record<string, string> = {}
          for (const key of ['name', 'prompt', 'cron', 'timezone', 'delivery']) {
            if (args[key] !== undefined && String(args[key]).trim()) patch[key] = String(args[key]).trim()
          }
          if (!Object.keys(patch).length) return JSON.stringify({ error: 'update needs at least one of: name, prompt, cron, timezone, delivery' })
          const job = await store.update(id, patch as any)
          return job ? JSON.stringify({ action, job }) : JSON.stringify({ action, id, error: 'Scheduled job not found.' })
        }
        if (action === 'add') {
          const name = String(args.name || '').trim()
          const prompt = String(args.prompt || '').trim()
          const cron = String(args.cron || '').trim()
          if (!name || !prompt || !cron) return JSON.stringify({ error: 'name, prompt and cron are required for action=add' })
          const timezone = String(args.timezone || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          // This tool has no chat/owner context, so a telegram job created here could
          // never be delivered. Local is the only delivery it can honour.
          const requested = String(args.delivery || 'local').toLowerCase()
          if (requested !== 'local') return JSON.stringify({ error: `delivery "${requested}" needs a chat owner; create it with /schedule from the terminal or Telegram instead` })
          const job = await store.add({ name, prompt, cron, timezone, delivery: 'local' })
          return JSON.stringify({ action, job, note: 'Local jobs are run by the gateway daemon; results are appended to gateway/cron-local.log' })
        }
        return JSON.stringify({ error: 'action must be one of: list, add, update, pause, resume, run, remove, history' })
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}
