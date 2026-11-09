import { accessSync, chmodSync, constants, existsSync } from 'fs'
import { delimiter, join } from 'path'
import { arch, platform, release } from 'os'
import { spawnSync } from 'child_process'

/**
 * Single place that knows what the host looks like. Every other module asks this
 * file instead of hardcoding /bin/bash, python3, process-group kills or chmod.
 * Keeping the per-OS branching here is what makes Linux, macOS, Windows and
 * Termux run the same code path above this layer.
 */

export const IS_WINDOWS = platform() === 'win32'
export const IS_MACOS = platform() === 'darwin'
export const IS_LINUX = platform() === 'linux'
/** Detached child processes get their own process group, which `process.kill(-pid)` can target. */
export const SUPPORTS_PROCESS_GROUPS = !IS_WINDOWS

export function isTermux(): boolean {
  if (!IS_LINUX) return false
  if (process.env.TERMUX_VERSION) return true
  if (String(process.env.PREFIX || '').includes('com.termux')) return true
  return existsSync('/data/data/com.termux/files/usr/bin')
}

export function platformSummary(): string {
  const flavour = isTermux() ? 'termux' : IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : IS_LINUX ? 'linux' : 'other'
  return `${flavour}-${arch()} (${platform()} ${release()})`
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, IS_WINDOWS ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a bare command name against PATH, honouring PATHEXT on Windows. */
export function findOnPath(name: string): string | null {
  const value = String(name || '').trim()
  if (!value) return null
  if (IS_WINDOWS ? /[\\/]/.test(value) : value.includes('/')) return isExecutableFile(value) ? value : null
  const extensions = IS_WINDOWS ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, value + extension)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

export function commandExists(name: string): boolean {
  return findOnPath(name) !== null
}

export type ShellKind = 'bash' | 'sh' | 'pwsh' | 'powershell' | 'cmd'

export interface ShellSpec {
  kind: ShellKind
  file: string
  /** Human label used in prompts, diagnostics and the status bar. */
  label: string
  /** True only for bash: enables `-o pipefail` so pipeline failures are visible. */
  pipefail: boolean
  /** Full argv that runs `script` non-interactively. */
  argv: (script: string) => string[]
}

/** Marker appended by wrapCommand so the agent can track `cd` across calls. */
export const CWD_MARKER = '__VALLEN_CWD__='

let cachedShell: ShellSpec | null | undefined

/**
 * Windows default is PowerShell 7 when present, then Windows PowerShell 5.1,
 * then cmd.exe. POSIX hosts prefer bash (pipefail) and fall back to sh.
 */
export function resolveShell(): ShellSpec | null {
  if (cachedShell !== undefined) return cachedShell
  cachedShell = detectShell()
  return cachedShell
}

function detectShell(): ShellSpec | null {
  if (IS_WINDOWS) {
    const pwsh = findOnPath('pwsh')
    if (pwsh) {
      return {
        kind: 'pwsh', file: pwsh, label: 'PowerShell 7 (pwsh)', pipefail: false,
        argv: script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
      }
    }
    const powershell = findOnPath('powershell')
    if (powershell) {
      return {
        kind: 'powershell', file: powershell, label: 'Windows PowerShell 5.1', pipefail: false,
        argv: script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
      }
    }
    return {
      kind: 'cmd', file: process.env.COMSPEC || findOnPath('cmd') || 'cmd.exe', label: 'cmd.exe', pipefail: false,
      argv: script => ['/d', '/s', '/c', script]
    }
  }
  const bash = findOnPath('bash') || (existsSync('/bin/bash') ? '/bin/bash' : null)
  if (bash) {
    return {
      kind: 'bash', file: bash, label: 'bash', pipefail: true,
      argv: script => ['--noprofile', '--norc', '-o', 'pipefail', '-c', script]
    }
  }
  const sh = findOnPath('sh') || (existsSync('/bin/sh') ? '/bin/sh' : null)
  if (sh) return { kind: 'sh', file: sh, label: 'sh (POSIX)', pipefail: false, argv: script => ['-c', script] }
  return null
}

/**
 * Wrap a user command so the shell reports its own exit code and final working
 * directory. Each shell needs different syntax; the marker format is shared.
 */
export function wrapCommand(spec: ShellSpec, command: string): string {
  if (spec.kind === 'bash' || spec.kind === 'sh') {
    return `${command}\n__VALLEN_RET=$?; printf '\\n${CWD_MARKER}%s\\n' "$(pwd)"; exit $__VALLEN_RET`
  }
  if (spec.kind === 'cmd') {
    // Delayed expansion is enabled only after the user command, so a literal `!`
    // in their command is not mangled by the parser.
    return [
      command,
      'setlocal EnableDelayedExpansion',
      'set "__VALLEN_RET=!ERRORLEVEL!"',
      'echo.',
      `echo ${CWD_MARKER}!CD!`,
      'exit /b !__VALLEN_RET!'
    ].join('\r\n')
  }
  return [
    command,
    '$__vallenRet = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    "Write-Output ''",
    `Write-Output "${CWD_MARKER}$((Get-Location).ProviderPath)"`,
    'exit $__vallenRet'
  ].join('\n')
}

/** True when a pipeline's exit status can be trusted (bash pipefail, or a single shell-native pipeline). */
export function pipelineStatusReliable(spec: ShellSpec): boolean {
  return spec.pipefail || spec.kind === 'pwsh' || spec.kind === 'powershell' || spec.kind === 'cmd'
}

/**
 * Kill a process and its children. POSIX uses the process group that `detached`
 * created; Windows has no signals, so taskkill /T /F walks the tree.
 */
export function killTree(pid: number | undefined | null, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false
  if (IS_WINDOWS) {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return result.status === 0
  }
  try {
    process.kill(-pid, signal)
    return true
  } catch { /* not a group leader */ }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export interface CommandSpec {
  command: string
  args: string[]
}

/** Termux ships `python`; Windows ships `py`/`python`; most Linux images ship `python3`. */
export function resolvePython(): CommandSpec | null {
  const candidates: CommandSpec[] = IS_WINDOWS
    ? [{ command: 'py', args: ['-3'] }, { command: 'python3', args: [] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  for (const candidate of candidates) if (findOnPath(candidate.command)) return candidate
  return null
}

/** chmod is meaningless on Windows and can throw EPERM on Android shared storage. */
export function chmodSafe(target: string, mode: number): void {
  if (IS_WINDOWS) return
  try {
    chmodSync(target, mode)
  } catch { /* read-only mounts and shared storage */ }
}

/**
 * Windows cannot exec a `.cmd`/`.bat` shim (npx, npm, git wrappers) without a
 * shell, so route it through cmd.exe. MCP servers and the gateway daemon use this.
 */
export function spawnableCommand(command: string, args: string[] = []): CommandSpec {
  if (!IS_WINDOWS) return { command, args }
  const resolved = findOnPath(command) || command
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { command: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${resolved}"`, ...args] }
  }
  return { command: resolved, args }
}

/** Interactive shell used by `/sh` — no script argument, the user drives it. */
export function interactiveShell(): CommandSpec {
  const spec = resolveShell()
  if (!spec) return { command: IS_WINDOWS ? 'cmd.exe' : '/bin/sh', args: [] }
  if (spec.kind === 'bash' || spec.kind === 'sh') return { command: process.env.SHELL || spec.file, args: ['-i'] }
  return { command: spec.file, args: [] }
}

/**
 * Tells the model which shell syntax actually works here. Without this the agent
 * emits POSIX commands on cmd.exe and every terminal call fails.
 */
export function shellDialectPrompt(): string {
  const spec = resolveShell()
  if (!spec) return 'Shell: none available. Do not use terminal commands on this host; use file tools instead.'
  if (spec.kind === 'bash') {
    return 'Shell: bash (POSIX). Use POSIX syntax: && || ; pipes, $VAR, $(...), single quotes, forward-slash paths.'
  }
  if (spec.kind === 'sh') {
    return 'Shell: sh (POSIX, no bash extensions). Use POSIX syntax: && || ; pipes, $VAR, forward-slash paths. Avoid [[ ]], arrays and process substitution.'
  }
  if (spec.kind === 'cmd') {
    return 'Shell: cmd.exe (Windows). Use cmd syntax: & to sequence, %VAR%, backslash paths, double quotes. There is no POSIX tooling: no ls, cat, grep, rm, sed, ~ or $(...). Use dir, type, findstr, del, mkdir; for anything complex prefer PowerShell via `powershell -NoProfile -Command "..."`.'
  }
  return `Shell: ${spec.label} (Windows PowerShell). Use PowerShell syntax: cmdlets (Get-ChildItem, Get-Content, Select-String, Remove-Item, Test-Path), backslash paths, $env:VAR, and ; to sequence commands. Do not use POSIX tools (ls, cat, grep, rm, sed) or bash $(...) substitution. Chain commands with ; and check $LASTEXITCODE for native programs.`
}
