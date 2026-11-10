import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Terminal sandbox (P2.5) — run shell commands inside a bubblewrap namespace.
 *
 * Without it, `terminal` can touch anything the user can. With it: the whole filesystem is read-only,
 * only the working directory (plus optional extra roots) is writable, the network is off by default, and
 * the process gets its own PID/IPC/UTS namespaces. If bubblewrap is missing, `auto` runs unsandboxed and
 * says so; `required` refuses instead of pretending.
 */

export type TerminalSandboxMode = 'off' | 'auto' | 'required'

export interface SandboxProbe {
  available: boolean
  tool: 'bwrap' | 'none'
  version?: string
}

export interface SandboxCommand {
  file: string
  args: string[]
  writableRoots: string[]
  network: boolean
}

let cachedProbe: SandboxProbe | null = null

export function probeSandbox(): SandboxProbe {
  if (cachedProbe) return cachedProbe
  try {
    const result = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (result.status === 0) {
      cachedProbe = { available: true, tool: 'bwrap', version: String(result.stdout || '').trim() }
      return cachedProbe
    }
  } catch { }
  cachedProbe = { available: false, tool: 'none' }
  return cachedProbe
}

export function resetSandboxProbe(): void { cachedProbe = null }

export function sandboxMode(value: unknown): TerminalSandboxMode {
  return value === 'required' || value === 'auto' || value === 'off' ? value : 'off'
}

/** Canonical, existing path — bubblewrap refuses to bind a path that does not exist. */
function canonical(path: string): string {
  try { return realpathSync(path) } catch { }
  let current = path
  const rest: string[] = []
  while (!existsSync(current) && dirname(current) !== current) {
    rest.unshift(current.split('/').pop() || '')
    current = dirname(current)
  }
  try { return join(realpathSync(current), ...rest) } catch { return path }
}

export function buildSandboxCommand(options: {
  command: string
  workdir: string
  extraRoots?: string[]
  allowNetwork?: boolean
  shell?: string
}): SandboxCommand {
  const workdir = canonical(options.workdir)
  const writableRoots = [workdir, ...(options.extraRoots || []).map(canonical)]
  const network = options.allowNetwork === true
  const shell = options.shell || '/bin/bash'
  const args = [
    '--die-with-parent',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    ...(network ? [] : ['--unshare-net']),
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...writableRoots.flatMap(root => ['--bind', root, root]),
    '--chdir', workdir,
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'PATH', process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'LANG', process.env.LANG || 'C.UTF-8',
    '--setenv', 'TERM', process.env.TERM || 'xterm-256color',
    '--',
    shell, '-lc', options.command
  ]
  return { file: 'bwrap', args, writableRoots, network }
}

export interface SandboxDecision {
  /** Null means: run the command as-is (sandbox disabled or unavailable). */
  sandbox: SandboxCommand | null
  mode: TerminalSandboxMode
  reason?: string
}

export function decideSandbox(options: {
  command: string
  workdir: string
  config?: any
  extraRoots?: string[]
  probe?: SandboxProbe
}): SandboxDecision {
  const terminalConfig = options.config?.terminal || {}
  const mode = sandboxMode(terminalConfig.sandbox)
  if (mode === 'off') return { sandbox: null, mode, reason: 'sandbox off' }
  const probe = options.probe || probeSandbox()
  if (!probe.available) {
    return { sandbox: null, mode, reason: mode === 'required' ? 'bubblewrap is not installed' : 'bubblewrap is not installed; running unsandboxed' }
  }
  return {
    sandbox: buildSandboxCommand({
      command: options.command,
      workdir: options.workdir,
      extraRoots: options.extraRoots ?? terminalConfig.sandbox_roots,
      allowNetwork: terminalConfig.sandbox_network === true
    }),
    mode
  }
}

export function formatSandboxProbe(probe: SandboxProbe = probeSandbox()): string {
  return probe.available
    ? `bubblewrap available (${probe.version || 'unknown version'})`
    : 'bubblewrap not installed — terminal commands run unsandboxed'
}
