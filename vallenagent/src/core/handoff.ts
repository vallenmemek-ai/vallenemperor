import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * `/handoff [platform]` — move a CLI session somewhere else.
 *
 * The deliverable is a self-contained, redacted transcript plus a resume command. Delivery is optional
 * and configured (`handoff.command`, with `{file}` substituted), so nothing is silently sent anywhere:
 * without a command you get the file and the exact command to continue.
 */

export interface HandoffResult {
  file: string
  sessionId: string
  platform: string
  resumeCommand: string
  bytes: number
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{12,})/g, 'sk-***'],
  [/\b(ghp_[A-Za-z0-9]{20,})/g, 'ghp_***'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_***'],
  [/\b(npm_[A-Za-z0-9]{20,})/g, 'npm_***'],
  [/\b(AKIA[0-9A-Z]{16})/g, 'AKIA***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/g, '$1***'],
  [/((?:api[_-]?key|token|secret)\s*[:=]\s*)["']?[A-Za-z0-9._-]{12,}["']?/gi, '$1***']
]

export function redactForHandoff(text: string): string {
  let output = String(text || '')
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

export function createHandoff(options: {
  messages: Array<{ role: string; content: string }>
  sessionId: string
  title?: string
  model?: string
  cwd?: string
  home: string
  platform?: string
  now?: Date
}): HandoffResult {
  const platform = String(options.platform || 'file')
  const stamp = (options.now || new Date()).toISOString().replace(/[:.]/g, '-')
  const dir = join(options.home, 'handoffs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${options.sessionId}-${stamp}.md`)
  const lines = [
    `# Handoff · ${options.title || options.sessionId}`,
    '',
    `- session: ${options.sessionId}`,
    `- platform: ${platform}`,
    `- model: ${options.model || 'unknown'}`,
    `- cwd: ${options.cwd || 'unknown'}`,
    `- exported: ${(options.now || new Date()).toISOString()}`,
    '',
    '## Resume',
    '',
    '```',
    `vallenemperor --resume ${options.sessionId}`,
    '```',
    '',
    '## Transcript',
    ''
  ]
  for (const message of options.messages) {
    if (!message || !message.content) continue
    lines.push(`### ${message.role}`, '', redactForHandoff(String(message.content)).slice(0, 8000), '')
  }
  const content = lines.join('\n')
  writeFileSync(file, content, { mode: 0o600 })
  return {
    file,
    sessionId: options.sessionId,
    platform,
    resumeCommand: `vallenemperor --resume ${options.sessionId}`,
    bytes: Buffer.byteLength(content)
  }
}

export function deliverHandoff(options: {
  command?: string
  result: HandoffResult
  runner?: (command: string) => { status: number | null; stdout?: string; stderr?: string }
}): { attempted: boolean; ok: boolean; output: string } {
  const template = String(options.command || '').trim()
  if (!template) return { attempted: false, ok: true, output: '' }
  const command = template.replaceAll('{file}', options.result.file).replaceAll('{platform}', options.result.platform)
  const runner = options.runner || (cmd => {
    const result = spawnSync(cmd, { shell: true, timeout: 30_000, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
  })
  try {
    const result = runner(command)
    return { attempted: true, ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 500) }
  } catch (error: any) {
    return { attempted: true, ok: false, output: String(error?.message || error).slice(0, 500) }
  }
}

export function formatHandoff(result: HandoffResult, delivery: { attempted: boolean; ok: boolean; output: string }): string {
  const lines = [
    `Handoff written: ${result.file} (${result.bytes} bytes, secrets redacted)`,
    `Resume here: ${result.resumeCommand}`
  ]
  if (delivery.attempted) lines.push(delivery.ok ? `Delivered to ${result.platform}.` : `Delivery failed: ${delivery.output || 'unknown error'}`)
  else lines.push('No handoff.command configured, so nothing was sent. Set handoff.command (with {file}) to deliver automatically.')
  return lines.join('\n')
}
