/**
 * Session export — `/save md|json [file] [redact]`.
 *
 * Produces a shareable transcript or a machine-readable snapshot. `redact` scrubs credential-shaped
 * strings before writing, because transcripts are the thing people paste into bug reports.
 */

export interface ExportMessage {
  role: string
  content: string
  name?: string
}

export interface ExportOptions {
  messages: ExportMessage[]
  sessionId: string
  model?: string
  title?: string
  format?: 'md' | 'json'
  redact?: boolean
  now?: Date
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***REDACTED***'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***REDACTED***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***'],
  [/npm_[A-Za-z0-9]{20,}/g, 'npm_***REDACTED***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1***REDACTED***'],
  [/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{16,}/gi, '$1***REDACTED***'],
  [/(xox[baprs]-)[A-Za-z0-9-]{10,}/g, '$1***REDACTED***']
]

export function redactSecrets(text: string): string {
  let output = String(text ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

export function exportSession(options: ExportOptions): string {
  const format = options.format || 'md'
  const messages = (options.messages || []).filter(message => message && typeof message.content === 'string')
  const clean = options.redact
    ? messages.map(message => ({ ...message, content: redactSecrets(message.content) }))
    : messages

  if (format === 'json') {
    return JSON.stringify({
      sessionId: options.sessionId,
      title: options.title || null,
      model: options.model || null,
      exportedAt: (options.now || new Date()).toISOString(),
      redacted: Boolean(options.redact),
      messages: clean
    }, null, 2)
  }

  const lines: string[] = [
    `# Session ${options.title || options.sessionId}`,
    '',
    `- session: \`${options.sessionId}\``,
    `- model: ${options.model || 'unknown'}`,
    `- exported: ${(options.now || new Date()).toISOString()}`,
    `- messages: ${clean.length}${options.redact ? ' · secrets redacted' : ''}`,
    ''
  ]
  for (const message of clean) {
    lines.push(`## ${message.role}`, '', message.content.trim(), '')
  }
  return lines.join('\n')
}

export function defaultExportName(sessionId: string, format: 'md' | 'json'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `session-${sessionId.slice(0, 12)}-${stamp}.${format}`
}
