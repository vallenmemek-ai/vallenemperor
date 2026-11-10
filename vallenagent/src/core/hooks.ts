import { spawnSync } from 'node:child_process'

/**
 * Hooks — user-defined commands that run at fixed points in the turn lifecycle.
 *
 * Events: `session_start`, `user_prompt`, `pre_tool`, `post_tool`, `turn_end`, `session_end`.
 * A hook is a shell command that receives a JSON payload on stdin and may print a JSON decision on
 * stdout: `{"decision":"block","reason":"..."}`. `pre_tool` and `user_prompt` honour a block; the
 * other events are notification-only.
 *
 * Config shape:
 * ```yaml
 * hooks:
 *   pre_tool:
 *     - command: node scripts/deny-secrets.js
 *       matcher: '^(write_file|patch)$'
 *       timeout_ms: 5000
 * ```
 *
 * The runner is injectable so the whole contract is testable without spawning processes.
 */

export type HookEvent = 'session_start' | 'user_prompt' | 'pre_tool' | 'post_tool' | 'turn_end' | 'session_end'

export interface HookDefinition {
  command: string
  /** Regex matched against the tool name (pre_tool/post_tool) or the prompt text. */
  matcher?: string
  timeout_ms?: number
}

export interface HookPayload {
  event: HookEvent
  sessionId?: string
  tool?: string
  args?: Record<string, any>
  result?: string
  prompt?: string
  cwd?: string
}

export interface HookOutcome {
  event: HookEvent
  command: string
  status: 'ok' | 'blocked' | 'failed' | 'timeout'
  reason?: string
  output?: string
}

export interface RunHooksOptions {
  event: HookEvent
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>
  payload: Omit<HookPayload, 'event'>
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Returns { stdout, stderr, status } for a command; injected in tests. */
  runner?: (command: string, input: string, options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }) => { stdout: string; stderr?: string; status: number | null; signal?: string | null }
}

export const BLOCKING_EVENTS: HookEvent[] = ['user_prompt', 'pre_tool']

function defaultRunner(command: string, input: string, options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, {
    shell: true,
    input,
    cwd: options.cwd,
    env: options.env || process.env,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status, signal: result.signal }
}

function matches(matcher: string | undefined, value: string): boolean {
  if (!matcher) return true
  try { return new RegExp(matcher).test(value) } catch { return true }
}

/** Run every hook for one event. Never throws; a failing hook is reported, not fatal. */
export function runHooks(options: RunHooksOptions): HookOutcome[] {
  const definitions = options.hooks?.[options.event] || []
  if (!definitions.length) return []
  const runner = options.runner || defaultRunner
  const subject = options.event === 'pre_tool' || options.event === 'post_tool'
    ? String(options.payload.tool || '')
    : String(options.payload.prompt || '')
  const payload = JSON.stringify({ ...options.payload, event: options.event })
  const outcomes: HookOutcome[] = []

  for (const definition of definitions) {
    if (!definition?.command) continue
    if (!matches(definition.matcher, subject)) continue
    const timeoutMs = Math.min(60_000, Math.max(500, Number(definition.timeout_ms) || 10_000))
    try {
      const result = runner(definition.command, payload, { timeoutMs, cwd: options.cwd, env: options.env })
      const output = String(result.stdout || '').trim()
      if (result.signal === 'SIGTERM' || (result.status === null && !output)) {
        outcomes.push({ event: options.event, command: definition.command, status: 'timeout' })
        continue
      }
      if (result.status !== 0 && !output) {
        outcomes.push({ event: options.event, command: definition.command, status: 'failed', output: String(result.stderr || '').slice(0, 500) })
        continue
      }
      let decision: any = null
      if (output) { try { decision = JSON.parse(output) } catch { /* plain text output is allowed */ } }
      if (decision?.decision === 'block') {
        outcomes.push({ event: options.event, command: definition.command, status: 'blocked', reason: String(decision.reason || 'blocked by hook'), output })
        continue
      }
      outcomes.push({ event: options.event, command: definition.command, status: 'ok', output: output.slice(0, 500) })
    } catch (error: any) {
      outcomes.push({ event: options.event, command: definition.command, status: 'failed', output: String(error?.message || error).slice(0, 500) })
    }
  }
  return outcomes
}

/** First blocking outcome for an event, if any. */
export function blockedBy(outcomes: HookOutcome[]): HookOutcome | null {
  return outcomes.find(outcome => outcome.status === 'blocked') || null
}

export function formatHookOutcomes(outcomes: HookOutcome[]): string {
  if (!outcomes.length) return 'No hooks ran.'
  return outcomes.map(outcome => `${outcome.status.padEnd(8)} ${outcome.event.padEnd(13)} ${outcome.command}${outcome.reason ? ` — ${outcome.reason}` : ''}`).join('\n')
}
