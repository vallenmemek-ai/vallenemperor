import { spawnSync } from 'node:child_process'

import { registry, ToolSchema } from '../tools'
import { findOnPath, IS_WINDOWS } from '../../core/platform'
import { loadConfig } from '../../core/config'

export interface TtsEngine {
  command: string
  args: (text: string, voice: string) => string[]
}

/**
 * Speech output without adding a native dependency: use whatever the host already has.
 * Order matters — Termux has no espeak, macOS has `say`, Linux usually has espeak-ng.
 */
export function detectTtsEngine(config?: { tts?: { command?: string; voice?: string } }): TtsEngine | null {
  const configured = String(config?.tts?.command || '').trim()
  if (configured) {
    return { command: configured, args: (text: string, voice: string) => (voice ? ['-v', voice, text] : [text]) }
  }
  if (IS_WINDOWS) return null
  const termux = findOnPath('termux-tts-speak')
  if (termux) return { command: termux, args: (text: string) => [text] }
  const say = findOnPath('say')
  if (say) return { command: say, args: (text: string, voice: string) => (voice ? ['-v', voice, text] : [text]) }
  const espeak = findOnPath('espeak-ng') || findOnPath('espeak')
  if (espeak) return { command: espeak, args: (text: string, voice: string) => (voice ? ['-v', voice, text] : [text]) }
  return null
}

export function registerTtsTools(): void {
  const schema: ToolSchema = {
    name: 'text_to_speech',
    description: 'Speak text aloud through the host voice engine (say on macOS, espeak-ng on Linux, termux-tts-speak on Termux). Set tts.command in config to use another engine. Returns a clear error when no engine is installed.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say (max 2000 characters)' },
        voice: { type: 'string', description: 'Optional voice name understood by the engine' }
      },
      required: ['text']
    }
  }

  registry.register({
    name: 'text_to_speech',
    schema,
    toolset: 'media',
    handler: async args => {
      const text = String(args.text || '').trim()
      if (!text) return JSON.stringify({ error: 'text is required' })
      if (text.length > 2000) return JSON.stringify({ error: `text is too long (${text.length} > 2000 characters)` })
      let config: any = {}
      try { config = loadConfig() } catch { /* a broken config must not crash the tool */ }
      const engine = detectTtsEngine(config)
      if (!engine) {
        return JSON.stringify({
          spoken: false,
          error: 'No speech engine found. Install espeak-ng (Linux), use macOS `say`, install termux-tts-speak (Termux), or set tts.command in config.'
        })
      }
      const voice = String(args.voice || config?.tts?.voice || '').trim()
      const result = spawnSync(engine.command, engine.args(text, voice), { encoding: 'utf8', timeout: 60_000 })
      if (result.error) return JSON.stringify({ spoken: false, engine: engine.command, error: result.error.message })
      if (result.status !== 0) {
        return JSON.stringify({ spoken: false, engine: engine.command, exit_code: result.status, error: (result.stderr || '').trim().slice(0, 400) || 'engine failed' })
      }
      return JSON.stringify({ spoken: true, engine: engine.command, characters: text.length })
    }
  })
}
