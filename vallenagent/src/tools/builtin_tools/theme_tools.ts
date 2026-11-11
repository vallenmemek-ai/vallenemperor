import { registry, ToolSchema } from '../tools'
import { readTheme, THEME_NAMES, writeTheme } from '../../core/theme_store'

/**
 * `set_theme` — the CLI owns `/theme`, so the agent could not change the look of the
 * surface it is talking through. This writes the same `cli_theme` file the CLI reads
 * at startup; the change lands on the next CLI start.
 */
export function registerThemeTools(): void {
  const schema: ToolSchema = {
    name: 'set_theme',
    description: `Read or change the CLI colour theme. action=status shows the saved theme, action=set saves a new one (applies on the next CLI start). Known themes: ${THEME_NAMES.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'set'], description: 'What to do (default: status)' },
        name: { type: 'string', enum: [...THEME_NAMES], description: 'Theme to save (action=set)' }
      },
      required: ['action']
    }
  }

  registry.register({
    name: 'set_theme',
    schema,
    toolset: 'core',
    handler: async args => {
      const action = String(args.action || 'status').toLowerCase()
      if (action === 'status') {
        return JSON.stringify({ action, theme: readTheme(), available: THEME_NAMES })
      }
      if (action !== 'set') return JSON.stringify({ error: 'action must be one of: status, set' })
      const result = writeTheme(String(args.name || ''))
      if (!result.ok) return JSON.stringify({ action, error: result.error })
      return JSON.stringify({
        action,
        theme: String(args.name).toLowerCase(),
        available: THEME_NAMES,
        note: 'Saved. Restart the CLI (or run /theme) to see it; this tool cannot repaint the running surface.'
      })
    }
  })
}
