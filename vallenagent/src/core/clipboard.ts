import { spawnSync } from 'node:child_process'

/**
 * Clipboard support for `/copy`.
 *
 * Order: platform tool first (pbcopy / clip / wl-copy / xclip), then OSC 52 as the universal fallback
 * — OSC 52 works over SSH and inside tmux (with `set -g set-clipboard on`), which is where a terminal
 * agent is most often used.
 *
 * Everything is injectable so the matrix is testable without touching the real clipboard.
 */

export interface CopyResult {
  ok: boolean
  method: 'pbcopy' | 'clip' | 'wl-copy' | 'xclip' | 'osc52' | 'none'
  error?: string
}

export function encodeOsc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}\u0007`
}

export interface CopyOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Writes the OSC 52 sequence to the terminal. */
  write?: (text: string) => void
  /** Runs a platform clipboard command; returns true on success. */
  run?: (command: string, args: string[], input: string) => boolean
}

function defaultRun(command: string, args: string[], input: string): boolean {
  try {
    const result = spawnSync(command, args, { input, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] })
    return result.status === 0
  } catch {
    return false
  }
}

export function copyToClipboard(text: string, options: CopyOptions = {}): CopyResult {
  const value = String(text ?? '')
  if (!value) return { ok: false, method: 'none', error: 'nothing to copy' }

  const platform = options.platform || process.platform
  const env = options.env || process.env
  const run = options.run || defaultRun
  const write = options.write || ((sequence: string) => process.stdout.write(sequence))

  const candidates: Array<{ method: CopyResult['method']; command: string; args: string[] }> =
    platform === 'darwin' ? [{ method: 'pbcopy', command: 'pbcopy', args: [] }]
      : platform === 'win32' ? [{ method: 'clip', command: 'clip', args: [] }]
        : env.WAYLAND_DISPLAY ? [{ method: 'wl-copy', command: 'wl-copy', args: [] }, { method: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'] }]
          : [{ method: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'] }]

  for (const candidate of candidates) {
    if (run(candidate.command, candidate.args, value)) return { ok: true, method: candidate.method }
  }

  try {
    write(encodeOsc52(value))
    return { ok: true, method: 'osc52' }
  } catch (error: any) {
    return { ok: false, method: 'none', error: String(error?.message || error) }
  }
}

export function formatCopyResult(result: CopyResult, chars: number): string {
  if (!result.ok) return `Copy failed: ${result.error || 'no clipboard available'}`
  const method = result.method === 'osc52' ? 'OSC 52 (works over SSH)' : result.method
  return `Copied ${chars} character(s) via ${method}.`
}
