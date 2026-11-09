import { join } from 'path'
import { registry, ToolSchema } from '../tools'
import { getVallenHome } from '../../core/config'
import { getCheckpointDiff, listCheckpoints, undoCheckpoints } from '../../session/checkpoint'

/**
 * `checkpoint` — the /checkpoints, /diff and /undo features already existed but only
 * the REPL could reach them, so an agent that broke a file could not restore it
 * itself. This exposes the same store the agent writes to.
 */
export function registerCheckpointTools(): void {
  const schema: ToolSchema = {
    name: 'checkpoint',
    description: 'Inspect or restore file checkpoints captured before writes in this session. action=list shows turns, action=diff shows the change for a turn, action=undo restores files (newest first).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'diff', 'undo'], description: 'What to do (default: list)' },
        turn: { type: 'integer', description: 'Turn number for action=diff (default: latest)' },
        count: { type: 'integer', description: 'How many turns to undo (default: 1)' },
        force: { type: 'boolean', description: 'Overwrite files that changed since the checkpoint (default: false)' }
      },
      required: ['action']
    }
  }

  registry.register({
    name: 'checkpoint',
    schema,
    toolset: 'session',
    handler: async (args, context) => {
      const sessionId = context.sessionId
      if (!sessionId) return JSON.stringify({ error: 'checkpoint needs an active session (no session id in this context)' })
      const ctx = {
        sessionId,
        turnNumber: context.turnNumber,
        checkpointRoot: context.checkpointRoot || join(getVallenHome(), 'checkpoints')
      }
      const action = String(args.action || 'list').toLowerCase()
      try {
        if (action === 'list') {
          const turns = listCheckpoints(ctx)
          return JSON.stringify({ action, session_id: sessionId, turns, total: turns.length })
        }
        if (action === 'diff') {
          const turn = Number.isFinite(Number(args.turn)) ? Number(args.turn) : undefined
          return JSON.stringify({ action, session_id: sessionId, turn: turn ?? null, diff: getCheckpointDiff(ctx, turn, false) })
        }
        if (action === 'undo') {
          const count = Math.max(1, Math.min(20, Number(args.count) || 1))
          const result = undoCheckpoints(ctx, count, args.force === true)
          return JSON.stringify({ action, session_id: sessionId, ...result })
        }
        return JSON.stringify({ error: 'action must be one of: list, diff, undo' })
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}
