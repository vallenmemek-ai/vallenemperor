import { isVerificationCommand } from './verification'

/**
 * Per-turn record of what the agent actually produced: files created/changed, files saved
 * to disk by media/output tools, and verification commands that ran. The CLI prints this
 * at the end of a turn so "what changed" is answerable without scrolling the transcript.
 */
export interface TurnArtifactState {
  created: string[]
  changed: string[]
  saved: string[]
  verification: string[]
}

export function createTurnArtifacts(): TurnArtifactState {
  return { created: [], changed: [], saved: [], verification: [] }
}

function pushUnique(list: string[], value: string): void {
  const trimmed = String(value || '').trim()
  if (trimmed && !list.includes(trimmed)) list.push(trimmed)
}

function parseResult(result: string): any | null {
  try { return JSON.parse(result) } catch { return null }
}

/** Classify one successful tool result into the turn artifact record. */
export function recordArtifacts(state: TurnArtifactState, toolName: string, args: Record<string, any>, result: string): void {
  const parsed = parseResult(result)
  if (!parsed || parsed.error) return

  if (toolName === 'write_file' && parsed.success !== false && parsed.path) {
    pushUnique(parsed.created === true ? state.created : state.changed, parsed.path)
    return
  }
  if (toolName === 'patch' && parsed.path) {
    pushUnique(state.changed, parsed.path)
    return
  }
  if ((toolName === 'patch_batch' || toolName === 'apply_patch') && Array.isArray(parsed.files)) {
    for (const file of parsed.files) if (file?.path) pushUnique(state.changed, file.path)
    return
  }
  if (toolName === 'terminal') {
    const command = String(args.command || '').trim()
    if (command && isVerificationCommand(command) && parsed.exit_code === 0) pushUnique(state.verification, command)
    return
  }
  if (parsed.path && (toolName === 'image_generate' || toolName === 'vision_analyze' || toolName === 'browser_exec')) {
    pushUnique(state.saved, parsed.path)
  }
}

/** Human-readable summary; empty string when the turn produced nothing worth reporting. */
export function buildArtifactSummary(state: TurnArtifactState): string {
  const lines: string[] = []
  if (state.created.length) lines.push(`created: ${state.created.join(', ')}`)
  if (state.changed.length) lines.push(`changed: ${state.changed.join(', ')}`)
  if (state.saved.length) lines.push(`saved: ${state.saved.join(', ')}`)
  if (state.verification.length) lines.push(`verified: ${state.verification.join(' · ')}`)
  return lines.length ? `[Artifacts]\n${lines.join('\n')}` : ''
}
