import { spawnSync } from 'child_process'
import { resolvePython } from '../core/platform'
import type { ToolContext } from './tools'

export type DeferredHealthStatus = 'ready' | 'degraded' | 'unavailable'
export interface DeferredHealth {
  status: DeferredHealthStatus
  detail: string
}

const healthCache = new Map<string, { at: number; value: DeferredHealth }>()
const HEALTH_TTL_MS = 5 * 60_000

/**
 * Deferred tools used to be advertised with no indication that their backend might be
 * missing: `browser_exec` failed only after the agent called it. Probe the cheap,
 * cacheable dependency here so tool_search and tool_call can say "ready" vs
 * "unavailable" before the call.
 */
function browserExecHealth(): DeferredHealth {
  const cached = healthCache.get('browser_exec')
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value
  const python = resolvePython()
  let value: DeferredHealth
  if (!python) {
    value = { status: 'unavailable', detail: 'no Python interpreter found (tried py -3, python3, python)' }
  } else {
    const probe = spawnSync(python.command, [...python.args, '-c', 'import playwright'], { timeout: 4000, stdio: 'ignore', windowsHide: true })
    value = probe.status === 0
      ? { status: 'ready', detail: `playwright importable via ${python.command}` }
      : { status: 'unavailable', detail: 'playwright is not installed for this Python; run: pip install playwright' }
  }
  healthCache.set('browser_exec', { at: Date.now(), value })
  return value
}

export function deferredToolHealth(name: string, context?: ToolContext): DeferredHealth {
  switch (name) {
    case 'browser_exec':
      return browserExecHealth()
    case 'web_search':
    case 'web_extract':
      return { status: 'degraded', detail: 'needs outbound HTTPS; network failures only surface when called' }
    case 'vision_analyze':
      return context?.providerConfig?.base_url
        ? { status: 'ready', detail: 'provider configured; accuracy still depends on the model' }
        : { status: 'degraded', detail: 'no provider config in this context' }
    case 'image_generate':
      return context?.providerConfig?.api_key
        ? { status: 'ready', detail: 'provider key present' }
        : { status: 'degraded', detail: 'provider api_key is not set; generation will fail' }
    default:
      return { status: 'ready', detail: 'no external dependency' }
  }
}

/**
 * `blocked` means the backend is known to be missing, so `tool_call` should refuse
 * instead of running a call that is guaranteed to fail. `degraded` still runs —
 * the tool may work, the agent just knows it can fail.
 */
export function deferredToolGate(name: string, context?: ToolContext, health: DeferredHealth = deferredToolHealth(name, context)) {
  return { blocked: health.status === 'unavailable', health }
}

/** Test seam: forget cached probes so a later call re-probes the host. */
export function resetDeferredHealthCache(): void {
  healthCache.clear()
}
