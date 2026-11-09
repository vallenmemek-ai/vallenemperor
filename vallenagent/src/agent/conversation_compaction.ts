import type { Message, ToolCall } from '../providers/providers'

export const SUMMARY_HEADER = '[Previous conversation summary'
export const SUMMARY_FOOTER = '(Continue task with full awareness of above context)]'
export const TURN_PROGRESS_MARKER = '\n\n[Progress so far in this task (older steps compacted)]'
export const MAX_SUMMARY_CHARS = 14_000
const PINNED_SUMMARY_LINES = 3
export const COMPACT_TOKEN_RATIO = 0.7
export const MAX_HISTORY_MESSAGES = 80

function oneLine(text: string, max: number): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, max)
}

export function stripTurnProgress(content: string): string {
  const index = content.indexOf(TURN_PROGRESS_MARKER)
  return index >= 0 ? content.slice(0, index) : content
}

function describeToolCall(call: ToolCall): { line: string; path?: string } {
  let args: Record<string, any> = {}
  try { args = JSON.parse(call.function.arguments || '{}') } catch {}
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined
  const key = path || args.command || args.query || args.name || args.url || args.task || ''
  return { line: `Called ${call.function.name}${key ? `(${oneLine(String(key), 160)})` : ''}`, path }
}

export function buildSummaryLines(oldTurns: Message[], priorLines: string[] = [], maxChars: number = MAX_SUMMARY_CHARS): string[] {
  const lines: string[] = []
  const files = new Set<string>()
  const take = (line: string) => {
    if (line.startsWith('Files touched:')) {
      for (const f of line.slice('Files touched:'.length).split(',').map(x => x.trim()).filter(Boolean)) files.add(f)
    } else {
      lines.push(line)
    }
  }
  for (const line of priorLines) take(line)
  for (const m of oldTurns) {
    if (m.role === 'user') {
      if (m.content.startsWith(SUMMARY_HEADER)) {
        for (const line of m.content.split('\n').slice(1)) {
          if (line.trim() && line.trim() !== SUMMARY_FOOTER) take(line)
        }
      } else {
        const base = stripTurnProgress(m.content)
        lines.push(`User: "${oneLine(base, 700)}"`)
        const progressAt = m.content.indexOf(TURN_PROGRESS_MARKER)
        if (progressAt >= 0) {
          for (const line of m.content.slice(progressAt + TURN_PROGRESS_MARKER.length).split('\n')) if (line.trim()) take(line)
        }
      }
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`Agent: "${oneLine(m.content, 600)}"`)
      for (const call of m.tool_calls || []) {
        const described = describeToolCall(call)
        lines.push(described.line)
        if (described.path) files.add(described.path)
      }
    } else if (m.role === 'tool' && m.name) {
      const isError = /"error"|"exit_code":\s*[1-9]/.test(m.content.slice(0, 400))
      lines.push(`Tool ${m.name}${isError ? ' (ERROR)' : ''}: ${oneLine(m.content, isError ? 500 : 300)}`)
    }
  }
  let out = lines
  const total = out.reduce((n, l) => n + l.length + 1, 0)
  if (total > maxChars) {
    const pinned = out.slice(0, PINNED_SUMMARY_LINES)
    const rest = out.slice(PINNED_SUMMARY_LINES)
    let budget = maxChars - pinned.reduce((n, l) => n + l.length + 1, 0) - 80
    const kept: string[] = []
    for (let i = rest.length - 1; i >= 0 && budget > rest[i].length; i--) {
      kept.unshift(rest[i])
      budget -= rest[i].length + 1
    }
    const dropped = rest.length - kept.length
    out = [...pinned, ...(dropped > 0 ? [`[... ${dropped} older steps omitted ...]`] : []), ...kept]
  }
  if (files.size) out.push(`Files touched: ${[...files].slice(-60).join(', ')}`)
  return out
}

export function repairCompactionAck(history: Message[]): boolean {
  let changed = false
  for (let i = 1; i < history.length - 1; i++) {
    if (history[i].role === 'assistant' && history[i].content === 'Summary noted. Continuing.' && history[i + 1].role === 'assistant') {
      history.splice(i, 1)
      changed = true
      i--
    }
  }
  return changed
}

export function compactHistory(history: Message[], keepTailCount: number = 8, preserveIndex = -1, force = false, maxSummaryChars: number = MAX_SUMMARY_CHARS): boolean {
  if (!force && history.length <= keepTailCount + 2) return false
  const startIndex = 1
  let endIndex = force && preserveIndex >= 0
    ? preserveIndex
    : Math.min(history.length - keepTailCount, preserveIndex < 0 ? history.length : preserveIndex)
  while (endIndex > startIndex && history[endIndex]?.role === 'tool') endIndex--
  if (endIndex <= startIndex) return false

  const oldTurns = history.slice(startIndex, endIndex)
  const lines = buildSummaryLines(oldTurns, [], maxSummaryChars)
  const compactedMessage: Message = {
    role: 'user',
    content: `${SUMMARY_HEADER} (${oldTurns.length} messages compacted):\n${lines.join('\n')}\n${SUMMARY_FOOTER}`
  }
  const ackMessage: Message = { role: 'assistant', content: 'Summary noted. Continuing.' }
  const replacement = [compactedMessage]
  if (history[endIndex]?.role !== 'assistant') replacement.push(ackMessage)
  history.splice(startIndex, endIndex - startIndex, ...replacement)
  return true
}

export function compactActiveTurn(history: Message[], current: Message, keepTailCount: number = 12, maxSummaryChars: number = MAX_SUMMARY_CHARS): boolean {
  const userIndex = history.indexOf(current)
  if (userIndex < 0) return false
  let endIndex = history.length - keepTailCount
  while (endIndex > userIndex + 1 && history[endIndex]?.role === 'tool') endIndex--
  if (endIndex <= userIndex + 1) return false

  const oldSteps = history.slice(userIndex + 1, endIndex)
  const progressAt = current.content.indexOf(TURN_PROGRESS_MARKER)
  const priorLines = progressAt >= 0
    ? current.content.slice(progressAt + TURN_PROGRESS_MARKER.length).split('\n').filter(line => line.trim())
    : []
  const lines = buildSummaryLines(oldSteps, priorLines, maxSummaryChars)
  current.content = `${stripTurnProgress(current.content)}${TURN_PROGRESS_MARKER}\n${lines.join('\n')}`
  history.splice(userIndex + 1, endIndex - userIndex - 1)
  return true
}
