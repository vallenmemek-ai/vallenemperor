import type { CompletionRequest, CompletionResponse, Message, Provider, ToolCall } from './providers'

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string }

function toAnthropicMessages(messages: Message[]): { system: string | Array<Record<string, unknown>> | undefined; messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> } {
  const systemParts: Array<Record<string, unknown>> = []
  const result: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = []
  const append = (role: 'user' | 'assistant', content: string | AnthropicBlock[]) => {
    const previous = result.at(-1)
    if (previous?.role === role && role === 'user') {
      const left = Array.isArray(previous.content) ? previous.content : [{ type: 'text', text: previous.content }]
      const right = Array.isArray(content) ? content : [{ type: 'text', text: content }]
      previous.content = [...left, ...right]
    } else result.push({ role, content })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push({ type: 'text', text: message.content, ...(message.cache_control ? { cache_control: message.cache_control } : {}) })
    } else if (message.role === 'user') {
      append('user', message.content)
    } else if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls || []) {
        let input: unknown
        try { input = JSON.parse(call.function.arguments || '{}') } catch { throw new Error(`Invalid tool arguments for ${call.function.name}`) }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
      if (blocks.length) append('assistant', blocks)
    } else {
      if (!message.tool_call_id) throw new Error('Anthropic tool result is missing tool_call_id')
      append('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }])
    }
  }
  const system = systemParts.length === 0 ? undefined
    : systemParts.some(part => part.cache_control) ? systemParts : systemParts.map(part => part.text).join('\n\n')
  return { system, messages: result }
}

function toAnthropicTools(tools: unknown[]): Array<Record<string, unknown>> | undefined {
  if (!tools.length) return undefined
  return tools.map((entry: any) => {
    const fn = entry?.function
    if (entry?.type !== 'function' || typeof fn?.name !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') {
      throw new Error('Anthropic adapter received an invalid function tool schema')
    }
    return { name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', input_schema: fn.parameters }
  })
}

function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504, 529].includes(status)
}

function retryDelay(retryAfter: string | null | undefined, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const dateDelay = Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(dateDelay) && dateDelay >= 0) return dateDelay
  }
  const base = Math.min(2000, 500 * 2 ** (attempt - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function waitBeforeRetry(delayMs: number, signal: AbortSignal | undefined, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(Object.assign(new Error('Provider request deadline exceeded'), { name: 'TimeoutError' }))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      if (Date.now() >= deadline) reject(Object.assign(new Error('Provider request deadline exceeded'), { name: 'TimeoutError' }))
      else resolve()
    }, Math.min(delayMs, remaining))
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function fromAnthropic(data: any): CompletionResponse {
  if (!data || !Array.isArray(data.content)) throw new Error('Anthropic returned an invalid Messages response')
  const text = data.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('')
  const calls: ToolCall[] = data.content.filter((part: any) => part?.type === 'tool_use').map((part: any) => ({
    id: String(part.id), type: 'function', function: { name: String(part.name), arguments: JSON.stringify(part.input ?? {}) }
  }))
  return {
    id: String(data.id || ''), model: String(data.model || ''),
    choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: { prompt_tokens: Number(data.usage?.input_tokens || 0), completion_tokens: Number(data.usage?.output_tokens || 0),
      total_tokens: Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0) }
  }
}

export class AnthropicMessagesProvider implements Provider {
  constructor(public name: string, public baseURL: string, public apiKey: string, public model: string) {
    this.baseURL = baseURL.replace(/\/$/, '')
  }

  async chat(request: CompletionRequest): Promise<CompletionResponse> {
    const primaryModel = request.model || this.model
    const models = [...new Set([primaryModel, ...(request.fallbackModels || []).filter(model => model && model !== primaryModel)])]
    const messages = toAnthropicMessages(request.messages)
    const stream = Boolean(request.stream && request.onChunk)
    const timeoutMs = request.timeout ?? (stream ? 180_000 : 120_000)
    const deadline = Date.now() + timeoutMs
    let emittedChunk = false
    let lastError: unknown
    const onChunk = (chunk: string) => { emittedChunk = emittedChunk || Boolean(chunk); request.onChunk?.(chunk) }

    for (const [modelIndex, model] of models.entries()) {
      if (modelIndex > 0) request.onModelFallback?.(model)
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (request.signal?.aborted) throw request.signal.reason || new DOMException('Aborted', 'AbortError')
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) throw Object.assign(new Error('Provider request deadline exceeded'), { name: 'TimeoutError' })
        const timeoutSignal = AbortSignal.timeout(remainingMs)
        const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
        const payload = {
          model, max_tokens: request.max_tokens ?? 16384, messages: messages.messages,
          ...(messages.system ? { system: messages.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}), stream
        }
        let response: Response
        try {
          response = await fetch(`${this.baseURL}/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(payload), signal
          })
        } catch (error: any) {
          if (request.signal?.aborted || timeoutSignal.aborted || emittedChunk) throw error
          lastError = error
          if (attempt >= 3) break
          await waitBeforeRetry(retryDelay(undefined, attempt), request.signal, deadline)
          continue
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 4000)
          lastError = new Error(`Anthropic API error: ${response.status} ${detail}`)
          if (!isRetryableStatus(response.status) || attempt >= 3) break
          await waitBeforeRetry(retryDelay(response.headers.get('retry-after'), attempt), request.signal, deadline)
          continue
        }
        if (!stream || !response.body) return fromAnthropic(await response.json())
        try { return await this.readStream(response.body, model, onChunk) }
        catch (error) {
          if (emittedChunk || request.signal?.aborted) throw error
          lastError = error
          if (attempt >= 3) break
          await waitBeforeRetry(retryDelay(undefined, attempt), request.signal, deadline)
        }
      }
      if (emittedChunk || request.signal?.aborted) throw request.signal?.reason || lastError
    }
    throw lastError || new Error('Anthropic request failed')
  }

  private async readStream(body: ReadableStream<Uint8Array>, model: string, onChunk: (chunk: string) => void): Promise<CompletionResponse> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const newline = String.fromCharCode(10)
    const carriageReturn = String.fromCharCode(13)
    let event = ''
    let dataLines: string[] = []
    let id = ''
    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'stop'
    let text = ''
    const blocks = new Map<number, { id: string; name: string; json: string }>()
    const dispatch = () => {
      if (!dataLines.length) return
      let data: any
      try { data = JSON.parse(dataLines.join(newline)) } catch { throw new Error('Invalid Anthropic SSE event') }
      if (event === 'message_start') { id = String(data.message?.id || ''); inputTokens = Number(data.message?.usage?.input_tokens || 0) }
      else if (event === 'content_block_start' && data.content_block?.type === 'tool_use') {
        blocks.set(data.index, { id: String(data.content_block.id), name: String(data.content_block.name), json: '' })
      } else if (event === 'content_block_delta') {
        if (data.delta?.type === 'text_delta') { text += data.delta.text || ''; onChunk(data.delta.text || '') }
        if (data.delta?.type === 'input_json_delta') { const block = blocks.get(data.index); if (block) block.json += data.delta.partial_json || '' }
      } else if (event === 'message_delta') {
        stopReason = data.delta?.stop_reason || stopReason
        outputTokens = Number(data.usage?.output_tokens || outputTokens)
      } else if (event === 'error') throw new Error(`Anthropic stream error: ${String(data.error?.message || 'unknown error').slice(0, 1000)}`)
      event = ''
      dataLines = []
    }
    const line = (value: string) => {
      if (value === '') { dispatch(); return }
      if (value.startsWith('event:')) event = value.slice(6).trim()
      else if (value.startsWith('data:')) dataLines.push(value.slice(5).trimStart())
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer) line(buffer.endsWith(carriageReturn) ? buffer.slice(0, -1) : buffer)
          dispatch()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(newline).map(value => value.endsWith(carriageReturn) ? value.slice(0, -1) : value)
        buffer = lines.pop() || ''
        for (const value of lines) line(value)
      }
    } finally { reader.releaseLock() }
    const calls: ToolCall[] = Array.from(blocks.values()).map(block => {
      let args: unknown
      try { args = block.json ? JSON.parse(block.json) : {} } catch { throw new Error(`Invalid streamed tool arguments for ${block.name}`) }
      return { id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(args) } }
    })
    return { id, model, choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }
  }
}
