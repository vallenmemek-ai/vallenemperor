import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { registry, ToolSchema } from '../tools'
import { getVallenHome } from '../../core/config'
import { browserProfilePath, browserSessionBootstrap } from '../../core/browser_sessions'
import { truncateOutput } from './tool_output'

export function registerBrowserTools(): void {
  // 13. browser_exec
  const browserExecSchema: ToolSchema = {
    name: 'browser_exec',
    description: 'Run Python browser automation. Optional named session persists an owner-isolated Playwright profile for 30 days after last use; use `with browser_session() as page:` to reuse cookies/storage. Profile closes after each call.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python browser automation code' },
        session: { type: 'string', description: 'Named browser session' },
        timeout_s: { type: 'integer', description: 'Timeout in seconds (default: 300)' }
      },
      required: ['code']
    }
  }

  registry.register({
    name: 'browser_exec',
    schema: browserExecSchema,
    toolset: 'browser-use',
    handler: async (args, context, signal) => {
      let code = String(args.code || '')
      let env = process.env
      if (args.session !== undefined) {
        if (typeof args.session !== 'string') return JSON.stringify({ exit_code: 1, output: '', error: 'Browser session name must be a string.' })
        if (!context.sessionId) return JSON.stringify({ exit_code: 1, output: '', error: 'Named browser sessions require an owner-scoped agent session.' })
        try {
          const profile = await browserProfilePath(getVallenHome(), context.sessionId, args.session)
          code = `${browserSessionBootstrap}\n${code}`
          env = { ...process.env, VALLENEMPEROR_BROWSER_PROFILE: profile }
        } catch (err: any) {
          return JSON.stringify({ exit_code: 1, output: '', error: err?.message || 'Could not prepare browser profile.' })
        }
      }
      const workdir = context.workingDir || process.cwd()
      const timeout = (Number(args.timeout_s) || 300) * 1000

      return new Promise<string>((resolveResult) => {
        let child: any = null
        let tempDir: string | undefined
        let settled = false
        let timedOut = false
        let timeoutTimer: NodeJS.Timeout | undefined
        const abortChild = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL') } catch { try { child?.kill?.('SIGKILL') } catch {} } }
        const argsList = ['-c', code]
        if (Buffer.byteLength(code) > 100_000) {
          try {
            tempDir = mkdtempSync(join(tmpdir(), 'vallenemperor-browser-'))
            writeFileSync(join(tempDir, 'script.py'), code, { mode: 0o600 })
            argsList.splice(0, argsList.length, join(tempDir, 'script.py'))
          } catch (err: any) {
            return resolveResult(JSON.stringify({ exit_code: 1, output: '', error: `Could not stage code: ${err.message}` }))
          }
        }
        const finish = (result: string) => {
          if (settled) return
          settled = true
          if (timeoutTimer) clearTimeout(timeoutTimer)
          signal?.removeEventListener('abort', abortChild)
          if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }) } catch {} }
          resolveResult(result)
        }
        const stdoutParts: Buffer[] = []
        const stderrParts: Buffer[] = []
        let capturedBytes = 0
        let bufferExceeded = false
        const collect = (parts: Buffer[]) => (chunk: Buffer) => {
          const available = 10 * 1024 * 1024 - capturedBytes
          if (available > 0) {
            const kept = chunk.subarray(0, available)
            parts.push(kept)
            capturedBytes += kept.length
          }
          if (chunk.length > available && !bufferExceeded) { bufferExceeded = true; abortChild() }
        }
        child = spawn('python3', argsList, { cwd: workdir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', collect(stdoutParts))
        child.stderr.on('data', collect(stderrParts))
        child.on('close', (code: number | null, closeSignal: string | null) => {
          if (signal?.aborted) return finish(JSON.stringify({ exit_code: 130, output: '', error: 'Interrupted' }))
          const stdout = Buffer.concat(stdoutParts).toString()
          const stderr = Buffer.concat(stderrParts).toString()
          const rawOutput = (stdout + (stderr ? `\n[STDERR]\n${stderr}` : '')).trim()
          const { text: output, truncated } = truncateOutput(rawOutput, 50_000)
          const exitCode = code ?? (closeSignal ? 128 : 1)
          let hint: string | undefined
          if (rawOutput.includes('No module named') || rawOutput.includes('not defined')) hint = 'Browser automation requires playwright. Use web_search and web_extract for web tasks.'
          const error = bufferExceeded ? 'Process output exceeded 10 MB' : timedOut ? 'Process timed out' : exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined
          finish(JSON.stringify({ exit_code: exitCode, stdout: output, stdout_untrusted: true, stderr_untrusted: true, truncated, timed_out: timedOut, hint, error }))
        })
        if (signal?.aborted) abortChild()
        else signal?.addEventListener('abort', abortChild, { once: true })
        timeoutTimer = setTimeout(() => { timedOut = true; abortChild() }, timeout)
        child.on('error', (err: any) => finish(JSON.stringify({ exit_code: 1, output: '', error: err.message || 'Process error' })))
      })
    }
  })

}
