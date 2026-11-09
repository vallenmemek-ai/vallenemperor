import { registry, ToolSchema } from '../tools'
import { CronStore } from '../../core/cron_scheduler'

/**
 * `schedule` — the cron scheduler lived in core with no tool wrapper, so the agent
 * could not create a recurring job without shelling out. This is a thin wrapper
 * over the same CronStore the Telegram gateway uses.
 */
export function registerScheduleTools(): void {
  const schema: ToolSchema = {
    name: 'schedule',
    description: 'Manage scheduled agent jobs (cron). action=list shows jobs, action=add creates one, action=remove deletes by id, action=history shows recent runs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'history'], description: 'What to do (default: list)' },
        name: { type: 'string', description: 'Job name (action=add)' },
        prompt: { type: 'string', description: 'Prompt the job runs (action=add)' },
        cron: { type: 'string', description: 'Five-field cron expression, e.g. "0 9 * * *" (action=add)' },
        timezone: { type: 'string', description: 'IANA timezone (default: host timezone)' },
        delivery: { type: 'string', enum: ['local', 'telegram', 'whatsapp'], description: 'Where the result goes (default: local)' },
        id: { type: 'string', description: 'Job id (action=remove)' },
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
          const id = String(args.id || '').trim()
          if (!id) return JSON.stringify({ error: 'id is required for action=remove' })
          const removed = await store.remove(id)
          return JSON.stringify({ action, id, removed })
        }
        if (action === 'add') {
          const name = String(args.name || '').trim()
          const prompt = String(args.prompt || '').trim()
          const cron = String(args.cron || '').trim()
          if (!name || !prompt || !cron) return JSON.stringify({ error: 'name, prompt and cron are required for action=add' })
          const timezone = String(args.timezone || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          const delivery = (String(args.delivery || 'local').toLowerCase()) as 'local' | 'telegram' | 'whatsapp'
          const job = await store.add({ name, prompt, cron, timezone, delivery })
          return JSON.stringify({ action, job })
        }
        return JSON.stringify({ error: 'action must be one of: list, add, remove, history' })
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}
