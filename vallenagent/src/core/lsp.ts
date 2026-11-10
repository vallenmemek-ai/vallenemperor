import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

/**
 * LSP diagnostics (R14) — real semantic errors, not just `tsc` for TypeScript.
 *
 * A tiny JSON-RPC client over stdio: initialize, didOpen, collect publishDiagnostics, shutdown. It is
 * deliberately narrow (diagnostics only) so it stays auditable, and every server is resolved from the
 * file extension and skipped when the binary is missing — never installed on the user's behalf.
 */

export interface LanguageServerSpec {
  language: string
  command: string
  args: string[]
}

const SERVERS: Record<string, LanguageServerSpec> = {
  '.ts': { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  '.tsx': { language: 'typescriptreact', command: 'typescript-language-server', args: ['--stdio'] },
  '.js': { language: 'javascript', command: 'typescript-language-server', args: ['--stdio'] },
  '.jsx': { language: 'javascriptreact', command: 'typescript-language-server', args: ['--stdio'] },
  '.py': { language: 'python', command: 'pyright-langserver', args: ['--stdio'] },
  '.go': { language: 'go', command: 'gopls', args: [] },
  '.rs': { language: 'rust', command: 'rust-analyzer', args: [] },
  '.c': { language: 'c', command: 'clangd', args: [] },
  '.cpp': { language: 'cpp', command: 'clangd', args: [] },
  '.h': { language: 'c', command: 'clangd', args: [] },
  '.lua': { language: 'lua', command: 'lua-language-server', args: [] }
}

export function resolveLanguageServer(file: string): LanguageServerSpec | null {
  return SERVERS[extname(String(file || '')).toLowerCase()] || null
}

export function listLanguageServers(): Array<{ extension: string; command: string }> {
  return Object.entries(SERVERS).map(([extension, spec]) => ({ extension, command: spec.command }))
}

export function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** Incremental parser for `Content-Length` framed messages. */
export class MessageReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): any[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: any[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const header = this.buffer.slice(0, headerEnd).toString('ascii')
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) break
      const body = this.buffer.slice(start, start + length).toString('utf8')
      this.buffer = this.buffer.slice(start + length)
      try { messages.push(JSON.parse(body)) } catch { }
    }
    return messages
  }
}

export interface LspDiagnostic {
  severity: number
  message: string
  line: number
  character: number
  source?: string
}

export interface DiagnosticsResult {
  ok: boolean
  language?: string
  server?: string
  diagnostics: LspDiagnostic[]
  error?: string
}

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

export function formatDiagnostics(result: DiagnosticsResult): string {
  if (!result.ok) return `LSP unavailable: ${result.error}`
  if (!result.diagnostics.length) return `No diagnostics (${result.language} via ${result.server}).`
  const lines = [`${result.diagnostics.length} diagnostic(s) — ${result.language} via ${result.server}`]
  for (const item of result.diagnostics) {
    lines.push(`  ${SEVERITY[item.severity] || 'issue'} ${item.line + 1}:${item.character + 1}  ${item.message}${item.source ? ` [${item.source}]` : ''}`)
  }
  return lines.join('\n')
}

export interface CollectOptions {
  file: string
  timeoutMs?: number
  /** Injected for tests: replaces the real server process. */
  factory?: (spec: LanguageServerSpec, file: string) => Promise<LspDiagnostic[]>
  /** Override the resolved server (tests, or a project-specific server). */
  spec?: LanguageServerSpec
}

export async function collectDiagnostics(options: CollectOptions): Promise<DiagnosticsResult> {
  const file = resolve(options.file)
  if (!existsSync(file)) return { ok: false, diagnostics: [], error: `File not found: ${file}` }
  const spec = options.spec || resolveLanguageServer(file)
  if (!spec) return { ok: false, diagnostics: [], error: `No language server mapped for ${extname(file) || 'this file'}` }

  if (options.factory) {
    try {
      const diagnostics = await options.factory(spec, file)
      return { ok: true, language: spec.language, server: spec.command, diagnostics }
    } catch (error: any) {
      return { ok: false, language: spec.language, server: spec.command, diagnostics: [], error: String(error?.message || error) }
    }
  }

  return runServer(spec, file, options.timeoutMs || 15_000)
}

async function runServer(spec: LanguageServerSpec, file: string, timeoutMs: number): Promise<DiagnosticsResult> {
  return new Promise<DiagnosticsResult>(resolveResult => {
    let settled = false
    const finish = (result: DiagnosticsResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { }
      resolveResult(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() })
    } catch (error: any) {
      return resolveResult({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: String(error?.message || error) })
    }

    const reader = new MessageReader()
    let nextId = 1
    const pending = new Map<number, (value: any) => void>()
    let diagnostics: LspDiagnostic[] = []

    const send = (payload: any) => { try { child.stdin?.write(encodeMessage(payload)) } catch { } }
    const request = (method: string, params: any) => new Promise<any>(resolveRequest => {
      const id = nextId++
      pending.set(id, resolveRequest)
      send({ jsonrpc: '2.0', id, method, params })
    })

    const timer = setTimeout(() => finish({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: `Timed out after ${timeoutMs}ms waiting for ${spec.command}` }), timeoutMs)

    child.on('error', (error: any) => finish({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: `${spec.command}: ${error?.message || error}` }))
    child.on('exit', (code: number | null) => {
      if (!settled) finish({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: `${spec.command} exited with code ${code}` })
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) {
        if (message.id && pending.has(message.id)) {
          const callback = pending.get(message.id)!
          pending.delete(message.id)
          callback(message)
          continue
        }
        if (message.method === 'textDocument/publishDiagnostics') {
          diagnostics = (message.params?.diagnostics || []).map((item: any) => ({
            severity: Number(item.severity) || 1,
            message: String(item.message || ''),
            line: Number(item.range?.start?.line) || 0,
            character: Number(item.range?.start?.character) || 0,
            source: item.source
          }))
          finish({ ok: true, language: spec.language, server: spec.command, diagnostics })
        }
      }
    })

    void (async () => {
      try {
        const initialized = await request('initialize', {
          processId: process.pid,
          rootUri: `file://${process.cwd()}`,
          capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } }
        })
        if (initialized?.error) return finish({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: String(initialized.error.message || 'initialize failed') })
        send({ jsonrpc: '2.0', method: 'initialized', params: {} })
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: { uri: `file://${file}`, languageId: spec.language, version: 1, text: readFileSync(file, 'utf8') }
          }
        })
      } catch (error: any) {
        finish({ ok: false, language: spec.language, server: spec.command, diagnostics: [], error: String(error?.message || error) })
      }
    })()
  })
}
