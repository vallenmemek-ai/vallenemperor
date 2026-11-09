import { relative, sep, isAbsolute, resolve, basename, dirname, join } from 'path'
import { homedir } from 'os'
import { realpathSync } from 'fs'
import { IS_WINDOWS } from './platform'

/**
 * Local approval heuristic shared by every surface (Electron chat, Telegram
 * gateway, CLI). Mirrors Hermes' approval floors: destructive shell commands
 * and writes into sensitive paths are gated; ordinary project commands are not.
 */

const TERMINAL_DANGERS = /(?:\brm\s+(?:(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)|(?:-[a-z]*r[a-z]*\s+-[a-z]*f[a-z]*|-[a-z]*f[a-z]*\s+-[a-z]*r[a-z]*)|(?:--recursive\b[^\n]*\b--force\b|--force\b[^\n]*\b--recursive\b))|\bdd\s+if=|\bmkfs(?:\.|\s)|\b(?:shutdown|reboot)\b|\b(?:curl|wget)\b[^\n]*(?:\s-d\s*@|--data(?:-binary)?\s+@|\s-T\s|--upload-file\b)|\b(?:scp|rsync|nc|netcat)\b|\bchmod\s+-R\b|\bgit\s+push\b[^\n]*--force|\bgit\s+clean\b|\bgit\s+reset\b[^\n]*--hard|\bfind\b[^\n]*\s-delete\b|>\s*\/dev\/sd)/i

/**
 * Windows shells have their own destructive vocabulary. Without this list a
 * `del /s /q`, `rd /s` or `Remove-Item -Recurse -Force` would run with no approval.
 */
const WINDOWS_TERMINAL_DANGERS = /(?:\b(?:del|erase)\b[^\n]*\s\/(?:[a-z]*[sfq][a-z]*)(?:\s|$)|\b(?:rd|rmdir)\b[^\n]*\s\/s\b|\bformat\b[^\n]*\s[a-z]:|\bdiskpart\b|\bbcdedit\b|\breg\s+delete\b|\breg\s+add\b|\btakeown\b|\bicacls\b[^\n]*\s\/(?:grant|deny|reset)|\b(?:net\s+user|net\s+localgroup)\b|\bset-executionpolicy\b|\bwmic\b[^\n]*\bdelete\b|\bremove-item\b[^\n]*(?:-recurse|-force)|\b(?:stop-process|kill)\b[^\n]*-force|\bclear-disk\b|\bformat-volume\b|\bremove-partition\b|\binvoke-expression\b|\biex\b|\b(?:shutdown|restart-computer|stop-computer)\b|\bcipher\b[^\n]*\/w|\b(?:curl|wget|invoke-webrequest|iwr)\b[^\n]*\|\s*(?:iex|invoke-expression)|>\s*[a-z]:\\windows)/i

const SHELL_WRAPPER = /^\s*(?:(?:sudo|env|nohup|command|exec|time)\s+)*(?:sh|bash|dash|zsh|fish|node|python(?:\d+(?:\.\d+)?)?|py|perl|ruby)\s+-(?:c|e)\b|^\s*(?:(?:cmd(?:\.exe)?\s+\/[a-z:]*\s*\/?[ck]|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*-(?:c|command|encodedcommand|enc)\b)/i

const SAFE_TERMINAL_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'git', 'npm', 'node', 'python', 'python3', 'py', 'wc', 'file', 'stat', 'du', 'df', 'uname', 'whoami', 'which', 'type', 'grep', 'rg', 'find', 'sed', 'sort', 'uniq', 'cut', 'tr', 'printf', 'echo', 'date'])

/** Read-only Windows commands that never need approval on their own. */
const SAFE_WINDOWS_COMMANDS = new Set(['dir', 'type', 'where', 'findstr', 'more', 'echo', 'cd', 'chdir', 'whoami', 'hostname', 'ver', 'vol', 'tree', 'tasklist', 'systeminfo', 'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-location', 'gl', 'get-item', 'gi', 'measure-object', 'sort-object', 'get-process', 'git', 'npm', 'node', 'python', 'py'])

function isSafeTestLogPipeline(command: string): boolean {
  const match = command.trim().match(/^cd\s+("[^"]+"|'[^']+'|[^&|;\n]+?)\s*&&\s*npm\s+test\s+2>&1\s*\|\s*tail\s+-30\s*&&\s*git\s+log\s+--oneline\s+-5\s+2>\/dev\/null\s*\|\s*head(?:\s+-n\s+\d+)?$/)
  if (!match) return false
  const directory = match[1].replace(/^["']|["']$/g, '').trim()
  return directory.length > 0 && !isSensitivePath(directory)
}
const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.config', '.kube', '.docker', '.vallenemperor']
const SENSITIVE_ROOTS = IS_WINDOWS
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\System Volume Information']
  : ['/etc', '/usr', '/boot', '/root']
const SENSITIVE_RC = new Set(['.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.zshenv', 'Microsoft.PowerShell_profile.ps1', 'profile.ps1'])

const ENV_KEYS = ['VALLENEMPEROR_APPROVAL', 'VALLENEMPEROR_APPROVAL_MODE']

/** Approval mode for the current surface: 'dangerous' (gate risky ops), 'all', or 'off'. */
export function approvalMode(config?: any): 'dangerous' | 'all' | 'off' {
  for (const key of ENV_KEYS) {
    const value = process.env[key]
    if (value === 'all' || value === 'off' || value === 'dangerous') return value
  }
  const configured = typeof config === 'string' ? config : config?.approval
  if (configured === 'all' || configured === 'off' || configured === 'dangerous') return configured
  return 'dangerous'
}

export function normalizeToolPath(raw: string, workingDir = process.cwd()): string {
  let value = String(raw || '').trim()
  if (!value) return resolve(workingDir)
  if (value === '~') value = homedir()
  else if (value.startsWith('~/')) value = join(homedir(), value.slice(2))
  const absolute = isAbsolute(value) ? resolve(value) : resolve(workingDir, value)
  try { return realpathSync(absolute) } catch { return absolute }
}

function isSensitivePath(raw: string, workingDir = process.cwd()): boolean {
  const parts = String(raw).split(/[\\/]+/)
  if (parts.includes('..') && parts.some(part => SENSITIVE_DIRS.includes(part) || SENSITIVE_RC.has(part))) return true
  const target = normalizeToolPath(raw, workingDir)
  const home = normalizeToolPath(homedir())
  const sensitive = [...SENSITIVE_DIRS.map(dir => join(home, dir)), ...SENSITIVE_ROOTS]
  for (const root of sensitive) {
    const rel = relative(root, target)
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return true
  }
  const base = basename(target)
  // Path-aware home check: works with backslash separators and drive letters,
  // unlike the old target.split('/') heuristic.
  const homeRoot = normalizeToolPath(homedir())
  const homeRel = relative(homeRoot, target)
  const insideHome = homeRel === '' || (!homeRel.startsWith(`..${sep}`) && homeRel !== '..' && !isAbsolute(homeRel))
  if (insideHome && SENSITIVE_RC.has(base)) return true
  if (insideHome && SENSITIVE_DIRS.includes(basename(dirname(target)))) return true
  if (!IS_WINDOWS && (target.startsWith('/var/spool/cron/') || target === '/var/spool/cron' || target.startsWith('/etc/cron.') || target.startsWith('/etc/cron/'))) return true
  return false
}

function globSegmentMatches(pattern: string, value: string): boolean {
  let p = 0, v = 0, star = -1, retry = 0
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++; continue }
    if (pattern[p] === '*') { star = p++; retry = v; continue }
    if (star >= 0) { p = star + 1; v = ++retry; continue }
    return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

function mayResolveToSensitivePath(raw: string, workingDir: string): boolean {
  let value = String(raw || '').trim()
  if (!value) return false
  let expanded = ''
  for (let i = 0; i < value.length;) {
    if (value[i] === '$') {
      let end = i + 1
      const braced = value[end] === '{'
      if (braced) end++
      const start = end
      while (/[A-Za-z0-9_]/.test(value[end] || '')) end++
      if (end > start && (!braced || value[end] === '}')) {
        const key = value.slice(start, end)
        expanded += key === 'HOME' ? homedir() : process.env[key] ?? value.slice(i, end + Number(braced))
        i = end + Number(braced)
        continue
      }
    }
    expanded += value[i++]
  }
  value = expanded
  if (value === '~' || value.startsWith('~/')) value = value === '~' ? homedir() : join(homedir(), value.slice(2))
  if (!/[*?[]/.test(value)) return isSensitivePath(value, workingDir)
  const pattern = resolve(workingDir, value).split(/[\\/]+/)
  const home = normalizeToolPath(homedir())
  const protectedPaths = [
    ...SENSITIVE_DIRS.map(dir => join(home, dir)),
    ...SENSITIVE_ROOTS,
    ...[...SENSITIVE_RC].map(file => join(home, file)),
    '/var/spool/cron', '/etc/cron.d'
  ].map(path => path.split(/[\\/]+/))
  return protectedPaths.some(target => {
    const length = Math.min(pattern.length, target.length)
    for (let i = 0; i < length; i++) {
      if (!globSegmentMatches(pattern[i], target[i])) return false
    }
    return true
  })
}

function isOutsideWorkingDir(raw: string, workingDir: string): boolean {
  const target = normalizeToolPath(raw, workingDir)
  const root = normalizeToolPath(workingDir)
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function patchTargetsSensitivePath(info: { name: string; args: Record<string, any> }, workingDir: string): boolean {
  if (info.name === 'patch_batch') {
    return Array.isArray(info.args.files) && info.args.files.some((edit: any) => mayResolveToSensitivePath(String(edit?.path || ''), workingDir))
  }
  if (info.name === 'apply_patch') {
    const patch = String(info.args.patch || '')
    const prefixes = ['*** Update File: ', '*** Add File: ', '*** Delete File: ']
    const targets = patch.split(String.fromCharCode(10)).flatMap(line => {
      const prefix = prefixes.find(value => line.startsWith(value))
      return prefix ? [line.slice(prefix.length).trim()] : []
    })
    return targets.some(path => mayResolveToSensitivePath(path, workingDir))
  }
  return false
}

function hasRiskySafeCommandFlags(tokens: string[], workingDir: string): boolean {
  const binary = basename(tokens[0]).toLowerCase()
  const args = tokens.slice(1)
  if (binary === 'find' && args.some(arg => ['-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls', '-delete'].includes(arg))) return true
  if ((binary === 'rg' || binary === 'grep') && args.some(arg => ['--pre', '--pre-glob'].includes(arg))) return true
  if (binary === 'git' && args.some(arg => arg === '--output' || arg.startsWith('--output='))) return true
  if (binary === 'sed' && args.some(arg => arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place='))) {
    const target = args.at(-1)
    if (target && !target.startsWith('-') && (mayResolveToSensitivePath(target, workingDir) || isOutsideWorkingDir(target, workingDir))) return true
  }
  return false
}

function shellSegmentRequiresApproval(tokens: string[], workingDir: string): boolean {
  if (!tokens.length) return true
  const binary = basename(tokens[0]).toLowerCase()
  if (['env', 'printenv'].includes(binary)) return true
  if (tokens.some(token => (token.includes('$') || /[*?[]/.test(token)) && mayResolveToSensitivePath(token, workingDir))) return true
  if (tokens.slice(1).some(token => mayResolveToSensitivePath(token, workingDir))) return true
  if (!SAFE_TERMINAL_COMMANDS.has(binary) && !SAFE_WINDOWS_COMMANDS.has(binary)) return true
  if (hasRiskySafeCommandFlags(tokens, workingDir)) return true
  if (['node', 'python', 'python3', 'py'].includes(binary) && tokens.slice(1).some(arg => !['-v', '--version', '-V', '-h', '--help'].includes(arg))) return true
  if (binary === 'git' && !['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'describe'].includes(tokens[1])) return true
  if (binary === 'npm' && !['test', 'run', 'ls', 'view', 'audit', '-v', '--version', '-h', '--help'].includes(tokens[1])) return true
  if (binary === 'npm' && ['-v', '--version', '-h', '--help'].includes(tokens[1]) && tokens.length > 2) return true
  return false
}

function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let tokens: string[] = []
  let token = ''
  let quote = ''
  let escaped = false
  let expectCommand = false
  const flushToken = () => { if (token) { tokens.push(token); token = '' } }
  const flushSegment = () => {
    flushToken()
    if (tokens.length) { segments.push(tokens); tokens = []; expectCommand = false }
  }
  const input = command.trim()
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (escaped) { token += char; escaped = false; continue }
    if (char === '\\' && quote !== "'" && !IS_WINDOWS) { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; else token += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '$' && input[i + 1] === '(' || char === '`' || char === '<') return []
    if (char === ';' || char === '\n' || char === '\r') { flushSegment(); continue }
    if (char === '&' || char === '|') {
      if (input[i + 1] === char && (char === '&' || char === '|')) {
        flushToken()
        if (!tokens.length) return []
        flushSegment()
        expectCommand = true
        i++
        continue
      }
      return []
    }
    if (char === '>' && (token === '1' || token === '2') && input.slice(i).startsWith('>/dev/null') && /^(?:1|2)>\/dev\/null(?:\s|;|&|$)/.test(input.slice(i - 1))) {
      token = ''
      i += '>/dev/null'.length - 1
      continue
    }
    if (char === '>') return []
    if (/\s/.test(char)) { flushToken(); continue }
    token += char
  }
  if (quote || escaped) return []
  flushSegment()
  return expectCommand || !segments.length ? [] : segments.map(segment => {
    while (['sudo', 'env', 'nohup', 'command', 'exec', 'time', 'xargs'].includes(segment[0]) && segment.length > 1) segment.shift()
    return segment
  })
}

export function requiresDangerousApproval(info: { name: string; args: Record<string, any> }): boolean {
  if (['execute_code', 'browser_exec'].includes(info.name)) return true
  if (info.name === 'skill_manage') {
    const operations = Array.isArray(info.args.operations) ? info.args.operations : [info.args]
    return operations.some((op: any) => ['create', 'patch', 'delete', 'install', 'update', 'uninstall', 'undo'].includes(String(op?.action || op?.operation || '').toLowerCase()))
  }
  const workingDir = String(info.args.workdir || info.args.cwd || process.cwd())
  if (['patch_batch', 'apply_patch'].includes(info.name)) return patchTargetsSensitivePath(info, workingDir)
  if (['read_file', 'write_file', 'patch', 'search_files'].includes(info.name)) {
    const raw = String(info.args.path || info.args.file_path || '.')
    return isSensitivePath(raw, workingDir)
  }
  if (['patch_batch', 'apply_patch'].includes(info.name)) return patchTargetsSensitivePath(info, workingDir)
  if (info.name !== 'terminal') return false
  const command = String(info.args.command || '')
  if (isSafeTestLogPipeline(command)) return false
  if (SHELL_WRAPPER.test(command) || TERMINAL_DANGERS.test(command) || WINDOWS_TERMINAL_DANGERS.test(command)) return true
  const segments = shellSegments(command)
  if (!segments.length) return true
  return segments.some(tokens => shellSegmentRequiresApproval(tokens, workingDir))
}

const mcpApprovals = new Map<string, Set<string>>()

export function mcpServerFromTool(name: string): string | null {
  return /^mcp__([a-z0-9][a-z0-9_-]{0,31})__/.exec(name)?.[1] || null
}

export function isMcpApproved(sessionId: string, server: string): boolean {
  return mcpApprovals.get(sessionId)?.has(server) || false
}

export function rememberMcpApproval(sessionId: string, server: string): void {
  let approved = mcpApprovals.get(sessionId)
  if (!approved) {
    if (mcpApprovals.size >= 500) mcpApprovals.delete(mcpApprovals.keys().next().value!)
    approved = new Set()
    mcpApprovals.set(sessionId, approved)
  }
  approved.add(server)
}

export function requiresApproval(info: { name: string; args: Record<string, any> }, mode: 'dangerous' | 'all' | 'off', mcpTrusted = false): boolean {
  if (mode === 'off') return false
  if (info.name.startsWith('mcp__')) return !mcpTrusted
  if (mode === 'all') return true
  return requiresDangerousApproval(info)
}
