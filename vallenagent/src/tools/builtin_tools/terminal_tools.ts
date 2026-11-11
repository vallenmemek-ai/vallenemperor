import { existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { resolve, join, isAbsolute } from 'path'
import { homedir, tmpdir } from 'os'
import { spawn } from 'child_process'
import { registry, ToolSchema } from '../tools'
import { manageProcess, startBackgroundProcess } from '../../core/process_manager'
import { truncateOutput } from './tool_output'
import { CWD_MARKER, SUPPORTS_PROCESS_GROUPS, killTree, pipelineStatusReliable, resolvePty, resolvePython, resolveShell, wrapCommand } from '../../core/platform'
import { decideSandbox } from '../../core/terminal_sandbox'

export function registerTerminalTools(): void {
  // 5. terminal
  const terminalSchema: ToolSchema = {
    name: 'terminal',
    description: 'Execute shell commands on the host machine. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        workdir: { type: 'string', description: 'Working directory for this command' },
        timeout: { type: 'integer', description: 'Timeout in seconds (default: 120)' },
        background: { type: 'boolean', description: 'Start command in background and return a session_id for process_manage' },
        notify: { type: 'boolean', description: 'Emit process exit status through terminal output callback when background process ends' },
        pty: { type: 'boolean', description: 'Run on a pseudo-terminal so isatty() checks and TUI apps behave like a real terminal (Linux/macOS; Windows returns a clear error)' }
      },
      required: ['command']
    }
  }

  registry.register({
    name: 'terminal',
    schema: terminalSchema,
    toolset: 'terminal',
    checkFn: () => resolveShell() !== null,
    handler: async (args, context, signal) => {
      const rawCommand = String(args.command || '').trim()
      const requestedDir = String(args.workdir || context.workingDir || process.cwd())
      const workdir = isAbsolute(requestedDir) ? requestedDir : resolve(context.workingDir || process.cwd(), requestedDir)
      const timeout = (Number(args.timeout) || 120) * 1000

      const shellSpec = resolveShell()
      if (!shellSpec) {
        return JSON.stringify({ exit_code: 127, error: 'No usable shell found on this host; install bash or sh.' })
      }

      if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
        return JSON.stringify({ exit_code: 1, error: `Working directory does not exist or is not a directory: ${workdir}` })
      }

      // Direct single "cd <dir>" handler
      if (rawCommand.startsWith('cd ') && !rawCommand.includes('&&') && !rawCommand.includes(';') && !rawCommand.includes('|')) {
        let targetDir = rawCommand.slice(3).trim()
        if (targetDir.startsWith('"') && targetDir.endsWith('"')) targetDir = targetDir.slice(1, -1)
        if (targetDir.startsWith("'") && targetDir.endsWith("'")) targetDir = targetDir.slice(1, -1)
        if (targetDir === '~') targetDir = homedir()
        else if (targetDir.startsWith('~/')) targetDir = join(homedir(), targetDir.slice(2))
        const resolved = isAbsolute(targetDir) ? targetDir : resolve(workdir, targetDir)
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          context.workingDir = resolved
          return JSON.stringify({
            exit_code: 0,
            output: `Changed working directory to ${resolved}`,
            cwd: resolved
          })
        }
      }

      if (args.pty === true && args.background === true) {
        return JSON.stringify({ exit_code: 1, error: 'pty and background cannot be combined; use one of them.' })
      }

      if (args.background === true) {
        const onExit = args.notify === true ? (sessionId: string, exitCode: number | null, processSignal: string | null) => {
          context.onTerminalOutput?.('stderr', `\n[Background process ${sessionId} exited with exit code ${exitCode ?? 'unknown'}${processSignal ? ` (${processSignal})` : ''}]\n`)
        } : undefined
        return JSON.stringify(startBackgroundProcess(rawCommand, workdir, context.sessionId || 'default', onExit))
      }

      // Probe command to detect chained cd transitions
      const isBackground = /(?:^|[;&|])\s*[^;&|]+\s*&\s*$/.test(rawCommand)
      const probeCommand = isBackground ? rawCommand : wrapCommand(shellSpec, rawCommand)
      const hasPipeline = /(?:^|[^|])\|(?!\|)/.test(rawCommand)
      if (hasPipeline && !pipelineStatusReliable(shellSpec)) {
        return JSON.stringify({ exit_code: 127, error: `Pipeline status cannot be verified with ${shellSpec.label}; command was not run.` })
      }

      const sandboxDecision = decideSandbox({
        command: rawCommand,
        workdir,
        config: { terminal: context.terminalSandbox ? { sandbox: context.terminalSandbox.mode, sandbox_network: context.terminalSandbox.network, sandbox_roots: context.terminalSandbox.roots } : undefined }
      })
      if (sandboxDecision.mode === 'required' && !sandboxDecision.sandbox) {
        return JSON.stringify({ exit_code: 126, error: `Terminal sandbox required but unavailable: ${sandboxDecision.reason}` })
      }
      let spawnFile = sandboxDecision.sandbox ? sandboxDecision.sandbox.file : shellSpec.file
      let spawnArgs = sandboxDecision.sandbox ? sandboxDecision.sandbox.args : shellSpec.argv(probeCommand)

      if (args.pty === true) {
        if (sandboxDecision.sandbox) {
          return JSON.stringify({ exit_code: 126, error: 'pty cannot be combined with the terminal sandbox; drop one of them.' })
        }
        const ptyPlan = resolvePty(shellSpec, rawCommand)
        if (!ptyPlan.plan) return JSON.stringify({ exit_code: 127, error: ptyPlan.error })
        spawnFile = ptyPlan.plan.command
        spawnArgs = ptyPlan.plan.args
      }

      return new Promise<string>((resolveResult) => {
        const proc = spawn(spawnFile, spawnArgs, {
          cwd: workdir,
          detached: SUPPORTS_PROCESS_GROUPS,
          windowsHide: true,
          stdio: isBackground ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe']
        })

        let stdout = ''
        let stderr = ''
        let killed = false
        const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10MB in-memory cap to prevent OOM
        let exceededBufferCap = false

        proc.stdout?.on('data', (chunk: Buffer) => {
          context.onTerminalOutput?.('stdout', chunk.toString())
          if (stdout.length < MAX_OUTPUT_BYTES) {
            stdout += chunk.toString()
          } else if (!exceededBufferCap) {
            exceededBufferCap = true
            stdout += '\n[Output stream exceeded 10MB buffer limit, killing process...]'
            killTree(proc.pid, 'SIGKILL')
          }
        })
        proc.stderr?.on('data', (chunk: Buffer) => {
          context.onTerminalOutput?.('stderr', chunk.toString())
          if (stderr.length < MAX_OUTPUT_BYTES) {
            stderr += chunk.toString()
          }
        })

        const timeoutHandle = setTimeout(() => {
          killed = true
          killTree(proc.pid, 'SIGKILL')
        }, timeout)

        let interrupted = false
        if (signal) {
          if (signal.aborted) {
            interrupted = true
            killed = true
            killTree(proc.pid, 'SIGKILL')
          } else {
            signal.addEventListener('abort', () => {
              interrupted = true
              killed = true
              killTree(proc.pid, 'SIGKILL')
            }, { once: true })
          }
        }

        proc.on('error', (err: any) => {
          clearTimeout(timeoutHandle)
          resolveResult(JSON.stringify({
            exit_code: 1,
            output: '',
            error: err.message || 'Process error'
          }))
        })

        proc.on('close', (code: number | null, signalName: string | null) => {
          clearTimeout(timeoutHandle)

          if (interrupted || signal?.aborted) {
            return resolveResult(JSON.stringify({
              exit_code: 130,
              output: '',
              error: 'Interrupted'
            }))
          }
        
          let output = stdout || ''
          const markerIdx = output.lastIndexOf(CWD_MARKER)
          if (markerIdx !== -1) {
            const detectedCwd = output.slice(markerIdx + CWD_MARKER.length).split(/\r?\n/)[0].trim()
            output = output.slice(0, markerIdx)
            if (detectedCwd && resolve(detectedCwd) !== resolve(workdir) && existsSync(detectedCwd) && statSync(detectedCwd).isDirectory()) {
              context.workingDir = detectedCwd
            }
          }

          const exitCode = killed ? 124 : (code ?? 1)
          const rawOutput = (output + (stderr ? `\n[STDERR]\n${stderr}` : '')).trim()
          const { text: truncatedOut } = truncateOutput(rawOutput, 50_000)
          const result: any = {
            exit_code: exitCode,
            output: truncatedOut,
            cwd: context.workingDir
          }
          if (killed || signalName) {
            result.timed_out = true
            result.signal = signalName || 'SIGKILL'
          }
          if (exitCode !== 0 && (code !== null || killed)) {
            result.error = killed ? 'Command timed out' : `Process exited with code ${code}`
          }
          resolveResult(JSON.stringify(result))
        })
      })
    }
  })

  // 6. process_manage
  const processManageSchema: ToolSchema = {
    name: 'process_manage',
    description: 'List, poll, wait for, or stop background terminal processes by session_id. list shows processes from every session (with owner); killing another session\'s process needs confirm: true.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'poll', 'wait', 'kill'] },
        session_id: { type: 'string' },
        timeout: { type: 'integer', description: 'Maximum seconds to wait (0–300)' },
        confirm: { type: 'boolean', description: 'Required to kill a process owned by another session' }
      },
      required: ['action']
    }
  }
  registry.register({
    name: 'process_manage',
    schema: processManageSchema,
    toolset: 'terminal',
    handler: async (args, context) => JSON.stringify(await manageProcess(args, context.sessionId || 'default'))
  })

  // 7. execute_code
  const executeCodeSchema: ToolSchema = {
    name: 'execute_code',
    description: 'Execute Python code in a subprocess (not sandboxed) with stdlib and environment access. Stdout/stderr returned with head/tail truncation at 50KB.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        timeout_s: { type: 'integer', description: 'Timeout in seconds (default: 300)' }
      },
      required: ['code']
    }
  }

  registry.register({
    name: 'execute_code',
    schema: executeCodeSchema,
    toolset: 'code_execution',
    checkFn: () => resolvePython() !== null,
    handler: async (args, context, signal) => {
      const code = String(args.code || '')
      const workdir = context.workingDir || process.cwd()
      const timeout = (Number(args.timeout_s) || 300) * 1000
      const python = resolvePython()
      if (!python) {
        return JSON.stringify({ exit_code: 127, output: '', error: 'Python interpreter not found (tried py -3, python3, python).' })
      }

      return new Promise<string>((resolveResult) => {
        let child: any = null
        let tempDir: string | undefined
        let settled = false
        let timedOut = false
        let timeoutTimer: NodeJS.Timeout | undefined
        const abortChild = () => { killTree(child?.pid, 'SIGKILL') }
        const scriptArgs = [...python.args, '-c', code]
        if (Buffer.byteLength(code) > 100_000) {
          try {
            tempDir = mkdtempSync(join(tmpdir(), 'vallenemperor-code-'))
            writeFileSync(join(tempDir, 'script.py'), code, { mode: 0o600 })
            scriptArgs.splice(python.args.length, scriptArgs.length, join(tempDir, 'script.py'))
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
        child = spawn(python.command, scriptArgs, { cwd: workdir, detached: SUPPORTS_PROCESS_GROUPS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', collect(stdoutParts))
        child.stderr.on('data', collect(stderrParts))
        child.on('close', (code: number | null, closeSignal: string | null) => {
          if (signal?.aborted) return finish(JSON.stringify({ exit_code: 130, output: '', error: 'Interrupted' }))
          const stdout = Buffer.concat(stdoutParts).toString()
          const stderr = Buffer.concat(stderrParts).toString()
          const rawOutput = (stdout + (stderr ? `\n[STDERR]\n${stderr}` : '')).trim()
          const { text: output, truncated } = truncateOutput(rawOutput, 50_000)
          const exitCode = code ?? (closeSignal ? 128 : 1)
          const result: any = { exit_code: exitCode, stdout: output, truncated }
          if (timedOut) result.timed_out = true
          if (closeSignal) result.signal = closeSignal
          if (bufferExceeded) result.error = 'Process output exceeded 10 MB'
          else if (timedOut) result.error = 'Process timed out'
          finish(JSON.stringify(result))
        })
        if (signal?.aborted) abortChild()
        else signal?.addEventListener('abort', abortChild, { once: true })
        timeoutTimer = setTimeout(() => { timedOut = true; abortChild() }, timeout)
        child.on('error', (err: any) => finish(JSON.stringify({ exit_code: 1, output: '', error: err.message || 'Process error' })))
      })
    }
  })

}
