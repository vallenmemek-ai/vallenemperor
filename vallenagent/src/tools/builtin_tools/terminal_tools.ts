import { existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { resolve, join, isAbsolute } from 'path'
import { homedir, tmpdir } from 'os'
import { spawn } from 'child_process'
import { registry, ToolSchema } from '../tools'
import { manageProcess, startBackgroundProcess } from '../../core/process_manager'
import { truncateOutput } from './tool_output'

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
        notify: { type: 'boolean', description: 'Emit process exit status through terminal output callback when background process ends' }
      },
      required: ['command']
    }
  }

  registry.register({
    name: 'terminal',
    schema: terminalSchema,
    toolset: 'terminal',
    checkFn: () => process.platform !== 'win32',
    handler: async (args, context, signal) => {
      const rawCommand = String(args.command || '').trim()
      const requestedDir = String(args.workdir || context.workingDir || process.cwd())
      const workdir = isAbsolute(requestedDir) ? requestedDir : resolve(context.workingDir || process.cwd(), requestedDir)
      const timeout = (Number(args.timeout) || 120) * 1000

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

      if (args.background === true) {
        const onExit = args.notify === true ? (sessionId: string, exitCode: number | null, processSignal: string | null) => {
          context.onTerminalOutput?.('stderr', `\n[Background process ${sessionId} exited with exit code ${exitCode ?? 'unknown'}${processSignal ? ` (${processSignal})` : ''}]\n`)
        } : undefined
        return JSON.stringify(startBackgroundProcess(rawCommand, workdir, context.sessionId || 'default', onExit))
      }

      // Probe command to detect chained cd transitions
      const isBackground = /(?:^|[;&|])\s*[^;&|]+\s*&\s*$/.test(rawCommand)
      const probeCommand = isBackground ? rawCommand : `${rawCommand}\n__RET=$?; printf '\n__VALLEN_CWD__=%s\n' "$(pwd)"; exit $__RET`
      const hasPipeline = /(?:^|[^|])\|(?!\|)/.test(rawCommand)
      const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
      if (hasPipeline && shell !== '/bin/bash') {
        return JSON.stringify({ exit_code: 127, error: 'Pipeline status cannot be verified without Bash; command was not run.' })
      }
      const shellArgs = shell === '/bin/bash' ? ['--noprofile', '--norc', '-o', 'pipefail', '-c', probeCommand] : ['-c', probeCommand]

      return new Promise<string>((resolveResult) => {
        const proc = spawn(shell, shellArgs, {
          cwd: workdir,
          detached: true,
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
            try {
              if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
            } catch {}
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
          try {
            if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
          } catch {}
        }, timeout)

        let interrupted = false
        if (signal) {
          if (signal.aborted) {
            interrupted = true
            killed = true
            try {
              if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
            } catch {}
          } else {
            signal.addEventListener('abort', () => {
              interrupted = true
              killed = true
              try {
                if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
              } catch {}
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
          const cwdMarker = '\n__VALLEN_CWD__='
          const markerIdx = output.lastIndexOf(cwdMarker)
          if (markerIdx !== -1) {
            const detectedCwd = output.slice(markerIdx + cwdMarker.length).trim()
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
    checkFn: () => process.platform !== 'win32',
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
    checkFn: () => process.platform !== 'win32',
    handler: async (args, context, signal) => {
      const code = String(args.code || '')
      const workdir = context.workingDir || process.cwd()
      const timeout = (Number(args.timeout_s) || 300) * 1000

      return new Promise<string>((resolveResult) => {
        let child: any = null
        let tempDir: string | undefined
        let settled = false
        let timedOut = false
        let timeoutTimer: NodeJS.Timeout | undefined
        const abortChild = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL') } catch { try { child?.kill?.('SIGKILL') } catch {} } }
        const args = ['-c', code]
        if (Buffer.byteLength(code) > 100_000) {
          try {
            tempDir = mkdtempSync(join(tmpdir(), 'vallenemperor-code-'))
            writeFileSync(join(tempDir, 'script.py'), code, { mode: 0o600 })
            args.splice(0, args.length, join(tempDir, 'script.py'))
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
        child = spawn('python3', args, { cwd: workdir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
