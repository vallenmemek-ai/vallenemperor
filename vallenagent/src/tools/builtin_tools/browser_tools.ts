import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { registry, ToolSchema } from '../tools'
import { getVallenHome } from '../../core/config'
import { browserProfilePath, browserSessionBootstrap } from '../../core/browser_sessions'
import { truncateOutput } from './tool_output'
import { SUPPORTS_PROCESS_GROUPS, killTree, resolvePython } from '../../core/platform'
import { artifactDir, artifactFileName } from '../../agent/artifact_store'
import { BROWSER_LOCKED_MESSAGE, browserToolsUnlocked } from '../../core/browser_gate'


interface PythonRunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run a staged Python snippet and capture its output (bounded). Used by browser_screenshot. */
function runPythonScript(options: {
  python: { command: string; args: string[] }
  code: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeout: number
  signal?: AbortSignal
}): Promise<PythonRunResult> {
  return new Promise(resolveResult => {
    const child = spawn(options.python.command, [...options.python.args, '-c', options.code], {
      cwd: options.cwd,
      env: options.env,
      detached: SUPPORTS_PROCESS_GROUPS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: PythonRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortChild)
      resolveResult(result)
    }
    const abortChild = () => killTree(child.pid, 'SIGKILL')
    const timer = setTimeout(() => { timedOut = true; abortChild() }, options.timeout)
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 100_000) stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk.toString() })
    child.on('error', (err: any) => finish({ exitCode: 1, stdout, stderr: stderr + (err?.message || 'Process error'), timedOut }))
    child.on('close', (code: number | null) => finish({ exitCode: code ?? 1, stdout, stderr, timedOut }))
    if (options.signal?.aborted) abortChild()
    else options.signal?.addEventListener('abort', abortChild, { once: true })
  })
}

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
      if (!browserToolsUnlocked(context?.sessionId)) {
        return JSON.stringify({ exit_code: 1, output: '', error: BROWSER_LOCKED_MESSAGE })
      }
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
      const python = resolvePython()
      if (!python) return JSON.stringify({ exit_code: 127, output: '', error: 'Python interpreter not found (tried py -3, python3, python).' })

      return new Promise<string>((resolveResult) => {
        let child: any = null
        let tempDir: string | undefined
        let settled = false
        let timedOut = false
        let timeoutTimer: NodeJS.Timeout | undefined
        const abortChild = () => { killTree(child?.pid, 'SIGKILL') }
        const argsList = [...python.args, '-c', code]
        if (Buffer.byteLength(code) > 100_000) {
          try {
            tempDir = mkdtempSync(join(tmpdir(), 'vallenemperor-browser-'))
            writeFileSync(join(tempDir, 'script.py'), code, { mode: 0o600 })
            argsList.splice(python.args.length, argsList.length, join(tempDir, 'script.py'))
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
        child = spawn(python.command, argsList, { cwd: workdir, env, detached: SUPPORTS_PROCESS_GROUPS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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


  // 14. browser_screenshot
  const browserScreenshotSchema: ToolSchema = {
    name: 'browser_screenshot',
    description: 'Open a URL in a headless browser and save a PNG screenshot as a turn artifact. Use it to prove UI work: the returned path is reviewable, shareable, and shows up in /artifacts.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL (http or https)' },
        session: { type: 'string', description: 'Named browser session to reuse cookies/storage' },
        full_page: { type: 'boolean', description: 'Capture the full scrollable page (default true)' },
        selector: { type: 'string', description: 'CSS selector to capture instead of the page' },
        width: { type: 'integer', description: 'Viewport width (default 1440)' },
        height: { type: 'integer', description: 'Viewport height (default 900)' },
        timeout_s: { type: 'integer', description: 'Timeout in seconds (default 120)' }
      },
      required: ['url']
    }
  }

  registry.register({
    name: 'browser_screenshot',
    schema: browserScreenshotSchema,
    toolset: 'browser-use',
    handler: async (args, context, signal) => {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return JSON.stringify({ success: false, error: 'url must start with http:// or https://' })

      if (!browserToolsUnlocked(context?.sessionId)) {
        return JSON.stringify({ success: false, error: BROWSER_LOCKED_MESSAGE })
      }

      const home = getVallenHome()
      const turn = Number(context.turnNumber) > 0 ? Number(context.turnNumber) : 1
      let dir: string
      let outputPath: string
      try {
        dir = artifactDir(home, context.sessionId || 'anonymous', turn)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        outputPath = join(dir, artifactFileName('screenshot', new URL(url).hostname))
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err?.message || 'Could not prepare the artifact directory.' })
      }

      let env = process.env
      if (args.session !== undefined) {
        if (typeof args.session !== 'string') return JSON.stringify({ success: false, error: 'Browser session name must be a string.' })
        if (!context.sessionId) return JSON.stringify({ success: false, error: 'Named browser sessions require an owner-scoped agent session.' })
        try {
          const profile = await browserProfilePath(home, context.sessionId, args.session)
          env = { ...process.env, VALLENEMPEROR_BROWSER_PROFILE: profile }
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err?.message || 'Could not prepare browser profile.' })
        }
      }

      const python = resolvePython()
      if (!python) return JSON.stringify({ success: false, error: 'Python interpreter not found (tried py -3, python3, python).' })

      const width = Math.min(3840, Math.max(320, Number(args.width) || 1440))
      const height = Math.min(2160, Math.max(240, Number(args.height) || 900))
      const fullPage = args.full_page !== false
      const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : ''
      const timeout = Math.min(600, Math.max(10, Number(args.timeout_s) || 120)) * 1000
      const capture = selector
        ? `page.locator(${JSON.stringify(selector)}).first.screenshot(path=${JSON.stringify(outputPath)})`
        : `page.screenshot(path=${JSON.stringify(outputPath)}, full_page=${fullPage ? 'True' : 'False'})`

      const code = `${browserSessionBootstrap}
with browser_session() as page:
    page.set_viewport_size({"width": ${width}, "height": ${height}})
    page.goto(${JSON.stringify(url)}, wait_until="load", timeout=30000)
    page.wait_for_timeout(400)
    ${capture}
print("screenshot-ok")
`

      const outcome = await runPythonScript({ python, code, env, cwd: context.workingDir || process.cwd(), timeout, signal })
      if (outcome.timedOut) return JSON.stringify({ success: false, error: 'Screenshot timed out' })
      if (!existsSync(outputPath)) {
        const hint = /No module named|playwright/i.test(outcome.stderr)
          ? 'Browser screenshots require playwright: pip install playwright && playwright install chromium.'
          : undefined
        return JSON.stringify({ success: false, error: (outcome.stderr.trim() || `Screenshot failed (exit ${outcome.exitCode})`).slice(0, 800), hint })
      }
      return JSON.stringify({ success: true, kind: 'screenshot', path: outputPath, bytes: statSync(outputPath).size, url, dir })
    }
  })

}
