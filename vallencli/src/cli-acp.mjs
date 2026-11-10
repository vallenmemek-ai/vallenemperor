/**
 * ACP server (P2.4 / R17) — let an editor drive VallenEmperor.
 *
 * Implements the Agent Client Protocol over stdio JSON-RPC: `initialize`, `session/new`,
 * `session/prompt` (streaming `session/update` notifications) and `session/cancel`. Both
 * newline-delimited JSON and `Content-Length` framing are accepted, so it works with editors that
 * follow either convention.
 */

export const ACP_PROTOCOL_VERSION = 1

export function encodeAcp(payload, framing = 'ndjson') {
  const body = JSON.stringify(payload)
  if (framing === 'content-length') {
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
  }
  return `${body}\n`
}

/** Incremental reader for ndjson and Content-Length framed JSON-RPC. */
export class AcpReader {
  constructor() { this.buffer = '' }
  push(chunk) {
    this.buffer += chunk
    const messages = []
    for (;;) {
      const text = this.buffer
      if (!text.length) break
      if (/^\s*Content-Length:/i.test(text)) {
        const headerEnd = text.indexOf('\r\n\r\n')
        if (headerEnd < 0) break
        const match = text.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)
        if (!match) { this.buffer = text.slice(headerEnd + 4); continue }
        const length = Number(match[1])
        const start = headerEnd + 4
        if (Buffer.byteLength(text.slice(start), 'utf8') < length) break
        const body = text.slice(start, start + length)
        this.buffer = text.slice(start + length)
        try { messages.push(JSON.parse(body)) } catch { }
        continue
      }
      const newline = text.indexOf('\n')
      if (newline < 0) break
      const line = text.slice(0, newline).trim()
      this.buffer = text.slice(newline + 1)
      if (!line) continue
      try { messages.push(JSON.parse(line)) } catch { }
    }
    return messages
  }
}

export function acpTextFromPrompt(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .filter(part => part && (part.type === 'text' || typeof part.text === 'string'))
    .map(part => String(part.text || ''))
    .join('\n')
    .trim()
}

export async function handleAcpMessage(message, state, deps) {
  const { createAgent, write, log } = deps
  const reply = (result, id = message.id) => write({ jsonrpc: '2.0', id, result })
  const fail = (code, text) => write({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })

  if (message.method === 'initialize') {
    reply({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      agentInfo: { name: 'vallenemperor', version: deps.version || '0.0.0' }
    })
    return
  }

  if (message.method === 'authenticate') { reply({}); return }

  if (message.method === 'session/new') {
    const sessionId = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const agent = await createAgent({ sessionId })
    state.sessions.set(sessionId, agent)
    reply({ sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } })
    return
  }

  if (message.method === 'session/prompt') {
    const sessionId = message.params?.sessionId
    const agent = state.sessions.get(sessionId)
    if (!agent) return fail(-32602, `Unknown session: ${sessionId}`)
    const text = acpTextFromPrompt(message.params?.prompt)
    if (!text) return fail(-32602, 'prompt must contain text')
    try {
      const result = await agent.chat(text, {
        onChunk: chunk => write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(chunk || '') } }
          }
        })
      })
      const content = String(result?.response ?? result ?? '')
      if (content) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content } } }
        })
      }
      reply({ stopReason: 'end_turn' })
    } catch (error) {
      fail(-32603, String(error?.message || error))
    }
    return
  }

  if (message.method === 'session/cancel') {
    const agent = state.sessions.get(message.params?.sessionId)
    try { agent?.interrupt?.() } catch { }
    reply({})
    return
  }

  if (message.method === 'session/close') {
    const sessionId = message.params?.sessionId
    const agent = state.sessions.get(sessionId)
    try { await agent?.shutdown?.() } catch { }
    state.sessions.delete(sessionId)
    reply({})
    return
  }

  if (message.id !== undefined) fail(-32601, `Method not found: ${message.method}`)
  else log?.(`ignored notification: ${message.method}`)
}

export async function runAcpServer({ createAgent, version, stdin = process.stdin, stdout = process.stdout } = {}) {
  const state = { sessions: new Map() }
  const write = payload => stdout.write(encodeAcp(payload))
  const reader = new AcpReader()
  const deps = { createAgent, write, version }

  const handle = async chunk => {
    for (const message of reader.push(chunk)) {
      await handleAcpMessage(message, state, deps)
    }
  }

  return new Promise(resolve => {
    stdin.setEncoding?.('utf8')
    stdin.on('data', chunk => { void handle(String(chunk)) })
    stdin.on('end', async () => {
      for (const agent of state.sessions.values()) { try { await agent?.shutdown?.() } catch { } }
      resolve(0)
    })
  })
}
