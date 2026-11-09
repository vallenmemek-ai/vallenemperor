import type { Message } from '../providers/providers'

export function pruneOldToolResults(messages: Message[], protectTailCount: number = 24, protectedStart = messages.length): Message[] {
  if (messages.length <= protectTailCount) return [...messages]
  const cutoffIndex = messages.length - protectTailCount
  // indexOf() returns -1 when the active turn is not in history; treat that as "no protected window".
  const protectedUntil = protectedStart >= 0 ? protectedStart : messages.length
  return messages.map((m, idx) => {
    // Prune only history BEFORE the protected window: the recent tail (cutoffIndex) and
    // the active turn that starts at protectedStart must stay verbatim.
    if (idx < cutoffIndex && idx < protectedUntil && m.role === 'tool' && m.content && m.content.length > 600) {
      try {
        const parsed = JSON.parse(m.content)
        if (parsed.error || (typeof parsed.exit_code === 'number' && parsed.exit_code !== 0)) return m
      } catch {}
      const head = m.content.trim().replace(/\s+/g, ' ').slice(0, 300)
      return { ...m, content: `[Output of ${m.name || 'tool'} (${m.content.length} chars) pruned to save context. Start of output: ${head} ... Re-run the tool if you need the rest.]` }
    }
    return m
  })
}

export function truncateToolResult(result: string, maxChars = 100_000): string {
  if (result.length <= maxChars) return result
  const marker = '[... truncated ...]'
  let parsed: any
  try { parsed = JSON.parse(result) } catch {
    const limit = `${maxChars.toLocaleString('en-US')} characters`
    const suffix = `${String.fromCharCode(10)}${String.fromCharCode(10)}[... Truncated at ${limit} ...]`
    return result.slice(0, Math.max(0, maxChars - suffix.length)) + suffix
  }
  let root: any = parsed && typeof parsed === 'object' ? parsed : { value: parsed }
  if (Array.isArray(root)) root = { items: root }
  root.truncated = true
  const fields: Array<{ get: () => string; set: (value: string) => void }> = []
  const visit = (value: any) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (typeof value[key] === 'string') fields.push({ get: () => value[key], set: text => { value[key] = text } })
        else visit(value[key])
      }
    }
  }
  visit(root)
  let output = JSON.stringify(root)
  while (output.length > maxChars && fields.length) {
    fields.sort((a, b) => b.get().length - a.get().length)
    const field = fields[0]
    const current = field.get()
    const base = current.endsWith(marker) ? current.slice(0, -marker.length) : current
    const remove = Math.max(1, output.length - maxChars + marker.length)
    field.set(`${base.slice(0, Math.max(0, base.length - remove))}${marker}`)
    output = JSON.stringify(root)
  }
  return output.length <= maxChars ? output : JSON.stringify({ truncated: true, error: 'Tool JSON exceeded output limit; unable to shorten any text field safely.' })
}

export function estimateRequestTokens(messages: Message[], tools: any[]): number {
  const serialized = JSON.stringify({ messages, tools })
  let asciiChars = 0
  let otherChars = 0
  for (const char of serialized) {
    if (char.codePointAt(0)! < 128) asciiChars++
    else otherChars++
  }
  return Math.ceil(asciiChars / 4) + otherChars + messages.length * 4 + tools.length * 8
}

export function assertToolCallPairs(messages: Message[]): void {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) {
        if (!call.id || calls.has(call.id)) throw new Error(`Invalid tool history: duplicate or empty call ID ${call.id || '(empty)'}`)
        calls.add(call.id)
      }
    } else if (message.role === 'tool') {
      const id = message.tool_call_id || ''
      if (!id || !calls.has(id) || results.has(id)) throw new Error(`Invalid tool history: orphan or duplicate result for ${id || '(empty)'}`)
      results.add(id)
    }
  }
  for (const id of calls) if (!results.has(id)) throw new Error(`Invalid tool history: missing result for ${id}`)
}

export function normalizeToolCalls(calls: Message['tool_calls'], knownIds: Set<string>): Message['tool_calls'] {
  if (!calls) return undefined
  return calls.map((call, index) => {
    const originalId = typeof call?.id === 'string' ? call.id.trim() : ''
    let id = originalId
    if (!id || knownIds.has(id)) {
      const base = id || `call-${Date.now()}-${index}`
      let suffix = 1
      id = `${base}-${suffix}`
      while (knownIds.has(id)) id = `${base}-${++suffix}`
    }
    knownIds.add(id)
    return { ...call, id }
  })
}
