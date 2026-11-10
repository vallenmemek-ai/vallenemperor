import { existsSync, accessSync, constants } from 'node:fs'
import { homedir, platform, arch } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import { fg, bg, FG_OFF, BG_OFF, getColorLevel, getTheme, gradientText, gradientBlock } from './cli-theme.mjs'
import { matchPositions } from './cli-suggest.mjs'

export const ANSI = { reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', purple: '\x1b[38;5;141m' }
export const color = (value, code) => process.env.NO_COLOR ? value : `${code}${value}${ANSI.reset}`
export const stripAnsi = text => String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

// VALLEN_ASCII=1: swap box-drawing and symbol glyphs for plain ASCII (one cell each, so layout stays aligned).
const ASCII_MAP = { '╭': '+', '╮': '+', '╰': '+', '╯': '+', '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+', '─': '-', '━': '-', '│': '|', '┊': '|', '▎': '|', '▌': '|', '●': '*', '◆': '*', '•': '*', '◦': 'o', '▪': '*', '▸': '>', '❯': '>', '›': '>', '▲': '!', '⚠': '!', '✖': 'x', '✔': 'v', '✓': 'v', '☑': 'x', '☐': 'o', '⎿': '`', '✦': '*', '⎇': '@', '⬡': '#', '⏱': 't', '↻': 'r', '⚙': '*', '▰': '#', '▱': '-', '☤': '+', '✱': '*', '…': '~', '—': '-', '·': '.', '↑': '^', '↓': 'v', '◉': 'o', '⠋': '|', '⠙': '/', '⠹': '-', '⠸': '\\', '⠼': '|', '⠴': '/', '⠦': '-', '⠧': '\\', '⠇': '|', '⠏': '/' }
export const toAscii = text => String(text).replace(/[^\x00-\x7f]/g, ch => ASCII_MAP[ch] ?? ch)

const CLASSIC_COLORS = { cyan: ANSI.cyan, green: ANSI.green, yellow: ANSI.yellow, red: ANSI.red, purple: ANSI.purple }
// Re-skin the legacy palette from the active theme (256/truecolor terminals only; 16-colour terminals keep the classic codes).
export function refreshThemeColors() {
  if (getColorLevel() < 2) { Object.assign(ANSI, CLASSIC_COLORS); return }
  ANSI.cyan = fg('primary'); ANSI.purple = fg('accent'); ANSI.green = fg('ok'); ANSI.yellow = fg('warn'); ANSI.red = fg('err')
}

export const THINKING_FACES = ['(｡•́︿•̀｡)', '(◔_◔)', '(¬‿¬)', '( •_•)>⌐■-■', '(⌐■_■)', '(´･_･`)', '◉_◉', '(°ロ°)', '( ˘⌣˘)♡', 'ヽ(>∀<☆)☆', '٩(๑❛ᴗ❛๑)۶', '(⊙_⊙)', '(¬_¬)', '( ͡° ͜ʖ ͡°)', 'ಠ_ಠ']
export const THINKING_VERBS = ['pondering', 'contemplating', 'musing', 'cogitating', 'ruminating', 'deliberating', 'mulling', 'reflecting', 'processing', 'reasoning', 'analyzing', 'computing', 'synthesizing', 'formulating', 'brainstorming']

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function formatThinkingActivity(elapsedMs, faceIndex = 0, verbIndex = 0, frame = null) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0)
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
  const face = THINKING_FACES[Math.abs(Math.floor(Number(faceIndex) || 0)) % THINKING_FACES.length]
  const verb = THINKING_VERBS[Math.abs(Math.floor(Number(verbIndex) || 0)) % THINKING_VERBS.length]
  const spinner = frame === null || frame === undefined ? '' : `${SPINNER_FRAMES[Math.abs(Math.floor(Number(frame) || 0)) % SPINNER_FRAMES.length]} `
  return `${spinner}${face} ${verb}... · ${duration}`
}

// Terminal cell width: wide (CJK/emoji) characters take 2 columns, combining marks 0.
export function charWidth(char) {
  const code = char.codePointAt(0)
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2
  return 1
}
export const stringWidth = text => Array.from(stripAnsi(text)).reduce((sum, char) => sum + charWidth(char), 0)
export const padEndWidth = (text, width) => `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`
export function clipWidth(text, width) {
  let used = 0
  let out = ''
  for (const char of Array.from(text)) {
    const w = charWidth(char)
    if (used + w > width) break
    out += char
    used += w
  }
  return out
}

export const HELP = `VallenEmperor Autonomous Agent — CLI\n\nSubcommands:\n  setup               First-run wizard: provider, model, API key, approval mode\n  doctor [--json]     Diagnose node/config/provider/skills/git and print fixes\n  update [--check]    Update the global install from npm\n  completion bash|zsh|fish\n                      Print a shell completion script\n  --profile <name>    Isolated home (config, sessions, skills)\n  profile [list|create|delete] [name]\n                      Manage profiles\n  sessions [list|show|export|prune]\n                      Browse, export or prune saved sessions\n  prompt-size         Byte breakdown of the system prompt + tool schemas\n  insights            Session activity summary\n  logs                List log files\n  dump                Paste-safe setup summary\n  extensions [--json]  Manifest of skills, agents, commands, hooks, MCP\n  extensions install <dir>\n                      Install an extension pack (skills + commands + agents)\n\nStartup flags:\n  vallenemperor                  Interactive REPL\n  -p, --prompt \"text\"           One-shot: send one prompt, print the answer, exit\n  -r, --resume [id]              Resume the last session, or the given session id\n  --approval <mode>              dangerous | all | off for this run\n  -m, --model <name>             Model override for this run\n  --json                         Machine-readable output (telemetry + command results)\n  --quiet, --no-banner           Skip the startup banner and health probe\n  -h, --help                     Show this help\n  -v, --version                  Show version\n\nOne-shot (-p) has no approval prompt: risky tools are refused and the run exits\nnon-zero. Pass --approval off to allow them, e.g. in trusted scripts.\n\nConfig (writes ~/.vallenemperor/config.json):\n  config show                    Active provider, base_url, key source, validation\n  config set provider <preset>   openrouter | openai | anthropic | deepseek | 9router | ollama\n  config set model <name>        Model for the active provider\n  config set approval <mode>     dangerous | all | off\n\nChat:\n  Enter message       Send to shared VallenAgent core\n  /stop               Interrupt active turn\n  /exit, /quit        Exit VallenCLI\n\nAgent & session:\n  /model [name]       Pick provider & model live from the gateway; /model save <name> persists\n  /token [status]     Enter token hidden; status checks configuration\n  /sessions           List saved sessions\n  /resume <number|id> Resume a session by number (/sessions) or by session id\n  /new, /reset        Start a fresh conversation\n  /stats, /context    Show telemetry or context use\n  /search <query>     Search saved sessions\n  /memory [add|replace|remove]  Show or edit persistent memory\n  /todos              Show task list\n  /tools              List available tools\n  /skills help         Search/install/manage skills; stats/history/journey/index/pending\n  /review [log]       Run review or show review history\n  /session clearall   Delete saved sessions (requires confirmation)\n  /plan [task]        Create read-only implementation plan\n  /plans              List saved plans\n  /gamedev [off]      Toggle game-development mode\n\nWorkspace & tools:
  /output             Expand latest terminal command output\n\n  /cd <path>          Change project folder\n  /mcp [subcommand]   Manage MCP servers and tools\n  /project            Show project instructions/context\n  /init [confirm]     Preview/save VALLEN.md after review\n  /checkpoints        List file checkpoints\n  /artifact [n|last]  Review artifacts: list, then open one by number\n  /codesearch <query> Search workspace code with context\n  /copy [n]           Copy the last (or n-th) assistant reply to the clipboard\n  /save [md|json] [file] [redact]\n                      Export the transcript (optionally redacted)\n  /title [name]       Name this session\n  /history [n]        Show the last n messages\n  /prompt             Compose the next prompt in $EDITOR\n  /commands           List custom commands (.vallenemperor/commands/*.md)\n  /steer <note>       Inject a mid-turn note (after the next tool call)\n  /queue [add|list|rm|clear] [text]\n                      Queue prompts to run after the current turn\n  /rewind [n | fork n]\n                      Cut back to before prompt n (or branch first)\n  /goal [text|status|pause|resume|clear]\n                      Standing goal with an automatic continuation loop\n  /<skill-name>       Run a loaded skill directly\n  /context all        Context breakdown incl. context files\n  /effort [level]     Reasoning effort: low | medium | high\n  /artifacts          List this session's artifacts (walkthrough, screenshots)\n  /btw <question>     Side question in a clean context (session untouched)\n  /fork               Clone this conversation into a new session\n  /permissions        Show the effective permission summary\n  /worktree [new [name]|list]\n                      Create/switch a git worktree for this session\n  /approvals [apply]  Mine approval history into tool policy\n  /extensions         Manifest of skills, agents, commands, hooks, MCP\n  /fast [on|off|status] Fast mode: low reasoning effort, no background review\n  /handoff [platform] Export the session (redacted) + resume command\n  /curator [days] [apply]\n                      Archive skills untouched for N days (default 90)\n  /policy [tool] [allow|ask|deny|clear]\n                      Per-tool policy (deny blocks, ask forces approval)\n  /sandbox [status|workspace|off]\n                      Filesystem write boundary for the agent\n  /browser <task|off>  Unlock browser tools for this session and run a browser task\n  /agents [runs|available|show|stop|clean]\n                      Subagent dashboard: status, elapsed, last step; stop or clean worktrees\n  /learn [source]     Turn a session/doc/dir into a reusable skill\n  /grill-me [task]    Interview me before building (one question at a time)\n  /plan [task|go|next|edit <fb>|skip|stop|status]\n                      Plan mode; /plan go runs the saved plan step by step\n  /diff [turn | working | staged | all | review]\n                      Checkpoint diff, git diff, or per-hunk review with revert\n  /undo [count]       Restore file checkpoints\n  /compact            Compact conversation history\n  /auto [on|safe|off] Set tool approval mode\n  /health, /perf      Diagnostics or process sample\n  /clear              Clear screen\n  /theme [name]       Show or switch color theme\n  /sh, /pty           Enter a direct shell (bash/sh, PowerShell or cmd)\n  /help               Show this help\n\nInput:\n  /                   Command suggestions (↑/↓ select, Tab complete, Enter run, Esc close)\n  Ctrl+C              Stop active turn; press twice to exit\n  @path               Mention a file (↑/↓ select, Tab insert)\n  Paste               Multi-line paste is folded into one message\n\nUI-only commands: /settings, window actions, and Electron PTY shortcuts are not available in CLI.`

function commandExists(name) {
  const extensions = platform() === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  const delimiter = platform() === 'win32' ? ';' : ':'
  return (process.env.PATH || '').split(delimiter).some(dir => extensions.some(ext => {
    try { accessSync(join(dir || '.', name + ext), constants.X_OK); return true } catch { return false }
  }))
}

function probeGateway(baseURL, timeout = 1200) {
  return new Promise(resolveResult => {
    try {
      const url = new URL(`${String(baseURL).replace(/\/+$/, '')}/models`)
      const client = url.protocol === 'https:' ? https : http
      const req = client.get(url, { timeout }, response => {
        response.resume()
        const code = response.statusCode || 0
        resolveResult(code >= 200 && code < 400
          ? { status: 'ok', detail: `gateway HTTP ${code}` }
          : { status: 'warn', detail: `gateway HTTP ${code} (reachable)` })
      })
      req.on('timeout', () => { req.destroy(); resolveResult({ status: 'warn', detail: 'gateway timeout' }) })
      req.on('error', () => resolveResult({ status: 'warn', detail: 'gateway offline' }))
    } catch {
      resolveResult({ status: 'warn', detail: 'gateway URL invalid' })
    }
  })
}

export function summarizeMcp(agent, mcpServers = []) {
  const runtime = mcpServers.filter(server => server.status !== 'disabled')
  const configured = Object.values(agent?.config?.mcpServers || {}).filter(server => server.enabled !== false).length
  const total = runtime.length || configured
  return { total, ready: runtime.filter(server => server.status === 'ready').length }
}

export async function collectHealthChecks(agent, mcpServers = [], core = null) {
  const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
  const provider = agent?.provider
  const gateway = provider?.baseURL ? await probeGateway(provider.baseURL) : { status: 'warn', detail: 'provider endpoint not set' }
  const { total: mcpTotal, ready: mcpReady } = summarizeMcp(agent, mcpServers)
  const skills = agent?.skillLoader?.list?.().length || 0
  const tools = (core?.registry ?? agent?.coreRegistry)?.getOpenAISchemas?.().length
  const storage = existsSync(home) ? 'data directory exists' : 'will create on first save'
  const developerTools = ['git', 'python3', 'npm'].map(name => `${name} ${commandExists(name) ? 'available' : 'missing'}`).join(' · ')
  return [
    { title: 'Host Platform', detail: `${platform()}-${arch()} · Node ${process.version}`, status: 'ok' },
    { title: 'Developer Tools', detail: developerTools, status: ['git', 'npm'].every(commandExists) ? 'ok' : 'warn' },
    { title: 'Persistent Stores', detail: `${home} · ${storage}`, status: 'ok' },
    { title: 'Modular Skills', detail: `${skills} loaded`, status: 'ok' },
    { title: 'Core Toolsets', detail: `${typeof tools === 'number' ? tools : 'available'} tools available`, status: 'ok' },
    { title: 'MCP Servers', detail: mcpTotal ? `${mcpReady}/${mcpTotal} ready` : 'none configured', status: !mcpTotal || mcpReady === mcpTotal ? 'ok' : 'warn' },
    { title: 'AI Gateway', detail: `${provider?.model || 'no model'} · ${gateway.detail}`, status: gateway.status }
  ]
}

export function startupBox(agent, bannerText, checks, width, opts = {}) {
  const fancy = Boolean(opts.fancy)
  if (opts.compact) {
    const bad = checks.filter(c => c.status === 'error')
    const warn = checks.filter(c => c.status === 'warn')
    const head = fancy ? `${sgr(BOLD_ON)}${gradientText('VallenEmperor CLI')}${sgr(BOLD_OFF)}` : color('VallenEmperor CLI', ANSI.bold + ANSI.cyan)
    const state = bad.length ? paint(`✖ ${bad.length} failed`, 'err', true) : warn.length ? paint(`▲ ${warn.length} warning${warn.length === 1 ? '' : 's'}`, 'warn', true) : paint(`● ${checks.length}/${checks.length} ok`, 'ok')
    const lines = [`${head}  ${state}`]
    for (const c of [...bad, ...warn]) lines.push(`  ${dimText(c.title)} ${clipEllipsis(c.detail, Math.max(10, width - stringWidth(c.title) - 6))}`)
    return lines.join('\n')
  }
  const inner = Math.max(48, Math.min(width - 4, 76))
  const title = 'System Diagnostics & Health Check'
  const bar = `╭─ ${title} ${'─'.repeat(Math.max(0, inner - title.length - 1))}╮`
  const bottom = `╰${'─'.repeat(inner + 2)}╯`
  const heading = 'VallenEmperor Autonomous Agent · CLI'
  const rows = [fancy ? `${sgr(BOLD_ON)}${gradientText(heading)}${sgr(BOLD_OFF)}` : color(heading, ANSI.bold + ANSI.cyan)]
  if (bannerText.trim()) rows.push(fancy ? gradientBlock(bannerText.trimEnd()) : color(bannerText.trimEnd(), ANSI.purple))
  rows.push(fancy ? gradientText(bar) : color(bar, ANSI.cyan))
  const edge = `${fg('primary')}│${FG_OFF}`
  for (const check of checks) {
    const colorCode = check.status === 'ok' ? ANSI.green : check.status === 'error' ? ANSI.red : ANSI.yellow
    const word = check.status === 'ok' ? 'OK' : check.status === 'error' ? 'ERROR' : 'WARN'
    if (fancy) {
      // modern row: coloured status dot, dim label, detail; a text badge only when something needs attention
      const role = check.status === 'ok' ? 'ok' : check.status === 'error' ? 'err' : 'warn'
      const dot = paint(check.status === 'ok' ? '●' : check.status === 'error' ? '✖' : '▲', role, true)
      const badge = check.status === 'ok' ? '' : paint(word, role, true)
      const room = Math.max(8, inner - 24 - (badge ? stringWidth(word) + 1 : 0))
      const detail = clipEllipsis(check.detail, room)
      const text = `${dot}  ${dimText(check.title.padEnd(18))} ${detail}`
      const pad = ' '.repeat(Math.max(1, inner - stringWidth(text) - (badge ? stringWidth(word) : 0) - 1))
      rows.push(`${edge}  ${text}${pad}${badge} ${edge}`)
      continue
    }
    const badge = `[${word}]`
    const label = color(check.title.padEnd(19), ANSI.bold)
    const maxDetail = Math.max(8, inner - 27 - stringWidth(badge))
    const detail = stringWidth(check.detail) > maxDetail ? `${clipWidth(check.detail, maxDetail - 1)}…` : check.detail
    const text = `${label} ${detail}`
    const pad = ' '.repeat(Math.max(1, inner - stringWidth(text) - stringWidth(badge) - 1))
    rows.push(color(`│  ${text}${pad}${color(badge, colorCode)} │`, ANSI.cyan))
  }
  rows.push(fancy ? gradientText(bottom) : color(bottom, ANSI.cyan))
  if (fancy) {
    const bad = checks.filter(c => c.status === 'error').length
    const warn = checks.filter(c => c.status === 'warn').length
    rows.push(bad ? `  ${paint('✖', 'err', true)} ${paint(`${bad} check${bad === 1 ? '' : 's'} failed`, 'err')}${warn ? dimText(` · ${warn} warning${warn === 1 ? '' : 's'}`) : ''}`
      : warn ? `  ${paint('▲', 'warn', true)} ${paint(`${warn} warning${warn === 1 ? '' : 's'}`, 'warn')}${dimText(` · ${checks.length - warn}/${checks.length} checks ok · /health for details`)}`
      : `  ${paint('✔', 'ok', true)} ${paint('all systems ready', 'ok')}${dimText(` · ${checks.length}/${checks.length} checks ok`)}`)
  }
  return rows.join('\n')
}

function cwdLabel(cwd) {
  const home = homedir()
  if (cwd === home) return '~'
  if (cwd.startsWith(home + (platform() === 'win32' ? '\\' : '/'))) return '~' + cwd.slice(home.length)
  return cwd
}

export function chatBoxRedrawSequence(message, width = 80, extraRows = 0) {
  const columns = Math.max(1, Math.floor(Number(width) || 80))
  const rows = Math.max(1, Math.ceil(stringWidth(`› ${String(message || '')}`) / columns)) + Math.max(0, Math.floor(Number(extraRows) || 0))
  return `\x1b[${rows}A\r\x1b[J`
}

// status may be empty: then only the message box is drawn (what stays in the chat history).
export function formatChatBox(status, chat, width = 80) {
  const columns = Math.max(36, Math.floor(Number(width) || 80))
  const inner = columns - 2
  const contentWidth = columns - 4
  const row = value => color(`│ ${padEndWidth(value, contentWidth)} │`, ANSI.cyan)
  const border = (left, right) => color(`${left}${'─'.repeat(inner)}${right}`, ANSI.cyan)
  const clip = value => clipWidth(stripAnsi(value), contentWidth)
  const chatRows = []
  for (const line of String(chat || '›').split('\n')) {
    let rest = Array.from(line)
    if (!rest.length) chatRows.push('')
    while (rest.length) {
      let piece = ''
      let used = 0
      let count = 0
      while (count < rest.length) {
        const width = charWidth(rest[count])
        if (used + width > contentWidth) break
        piece += rest[count++]
        used += width
      }
      chatRows.push(piece || rest[0])
      rest = rest.slice(count || 1)
    }
  }
  return [border('╭', '╮'), ...(status ? [row(clip(status))] : []), ...chatRows.map(row), border('╰', '╯')].join('\n')
}

export function formatStatus(agent, mcpServers, activity = 'VALLENEMPEROR', width = 80) {
  const stats = agent.getContextStats?.() || { percent: 0, estimated: true }
  const { total, ready } = summarizeMcp(agent, mcpServers)
  const ctx = `${stats.estimated ? '~' : ''}${stats.percent || 0}%`
  let model = agent.provider?.model || 'unconfigured'
  let cwd = cwdLabel(agent.config?.terminal?.cwd || process.cwd())
  const maxWidth = Math.max(36, Math.floor(Number(width) || 80))
  const line = () => `MODEL ${model}  │  MCP ${ready}/${total}  │  ${cwd}  │  CTX ${ctx}  │  ${activity}`
  let text = line()
  if (stringWidth(text) > maxWidth && stringWidth(cwd) > 8) {
    const keep = Math.max(8, stringWidth(cwd) - (stringWidth(text) - maxWidth))
    cwd = `…${cwd.slice(-(keep - 1))}`
    text = line()
  }
  if (stringWidth(text) > maxWidth && stringWidth(model) > 8) {
    const keep = Math.max(8, stringWidth(model) - (stringWidth(text) - maxWidth))
    model = `${model.slice(0, keep - 1)}…`
    text = line()
  }
  if (stringWidth(text) > maxWidth) return color(clipWidth(text, maxWidth), ANSI.cyan)
  const percent = Number(stats.percent) || 0
  const ctxColor = percent >= 85 ? ANSI.red : percent >= 60 ? ANSI.yellow : ANSI.green
  const mcpColor = !total || ready === total ? ANSI.green : ANSI.yellow
  const activityColor = activity === 'APPROVAL' ? ANSI.red : activity === 'THINKING' || activity === 'WORKING' ? ANSI.yellow : ANSI.purple
  const sep = color('  │  ', ANSI.dim)
  return [
    `${color('MODEL', ANSI.dim)} ${color(model, ANSI.bold + ANSI.cyan)}`,
    `${color('MCP', ANSI.dim)} ${color(`${ready}/${total}`, mcpColor)}`,
    color(cwd, ANSI.cyan),
    `${color('CTX', ANSI.dim)} ${color(ctx, ctxColor)}`,
    color(activity, ANSI.bold + activityColor)
  ].join(sep)
}

// Colour unified-diff style previews (only used for tool previews that contain "@@" hunks).
export function colorizeDiff(text) {
  const value = String(text)
  if (!/^\s*@@ /m.test(value)) return value
  return value.split('\n').map(line => {
    if (/^\s*@@ /.test(line)) return color(line, ANSI.cyan)
    if (/^\s+\+(?!\+\+)/.test(line)) return color(line, ANSI.green)
    if (/^\s+-(?!--)/.test(line)) return color(line, ANSI.red)
    return line
  }).join('\n')
}

// ======================================================================
// Premium UI helpers (used by the interactive CLI; plain paths above stay untouched)
// ======================================================================
const sgr = code => (getColorLevel() === 0 ? '' : code)
const BOLD_ON = '\x1b[1m'
const BOLD_OFF = '\x1b[22m'
const DIM_ON = '\x1b[2m'
const paint = (text, role, bold = false) => `${bold ? sgr(BOLD_ON) : ''}${fg(role)}${text}${FG_OFF}${bold ? sgr(BOLD_OFF) : ''}`
const dimText = text => `${sgr(DIM_ON)}${text}${sgr(BOLD_OFF)}`
export const clipEllipsis = (text, width) => (stringWidth(text) <= width ? text : `${clipWidth(text, Math.max(0, width - 1))}…`)

export function fmtDuration(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
}
export function fmtTokens(count) {
  const n = Math.max(0, Number(count) || 0)
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

// ---- git info for the status bar (cached; never throws) ----
const gitCache = new Map()
export function invalidateGit() { gitCache.clear() }
export function gitInfo(cwd, ttl = 5000) {
  const cached = gitCache.get(cwd)
  if (cached && Date.now() - cached.at < ttl) return cached.value
  let value = null
  const git = args => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 700, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head.status === 0) {
      let branch = head.stdout.trim()
      if (branch === 'HEAD') { const sha = git(['rev-parse', '--short', 'HEAD']); branch = sha.status === 0 ? sha.stdout.trim() : 'detached' }
      const status = git(['status', '--porcelain'])
      value = { branch, dirty: status.status === 0 && status.stdout.trim().length > 0 }
    }
  } catch {}
  gitCache.set(cwd, { at: Date.now(), value })
  return value
}

// Segmented status line: model | cwd | git | context bar | MCP | session timer | activity.
// Low-priority segments are dropped first when the terminal is narrow.
export function formatStatusBar(agent, mcpServers, { activity = 'VALLENEMPEROR', width = 80, startedAt = 0, git, hint = '' } = {}) {
  const stats = agent.getContextStats?.() || { percent: 0, estimated: true }
  const { total, ready } = summarizeMcp(agent, mcpServers)
  const percent = Math.max(0, Math.min(100, Number(stats.percent) || 0))
  const cwdFull = agent.config?.terminal?.cwd || process.cwd()
  const info = git === undefined ? gitInfo(cwdFull) : git
  let modelText = agent.provider?.model || 'unconfigured'
  let cwdText = cwdLabel(cwdFull)
  const maxWidth = Math.max(36, Math.floor(Number(width) || 80))
  const ctxRole = percent >= 85 ? 'err' : percent >= 60 ? 'warn' : 'ok'
  const cells = 8
  const filled = percent > 0 ? Math.max(1, Math.round(percent / 100 * cells)) : 0
  const ctxLabel = `${stats.estimated ? '~' : ''}${percent}%`
  const activityRole = activity === 'APPROVAL' ? 'err' : activity === 'THINKING' || activity === 'WORKING' ? 'warn' : 'accent'
  const dropped = new Set()
  const make = () => {
    const list = [
      { p: 0, plain: `◆ ${modelText}`, styled: paint(`◆ ${modelText}`, 'primary', true) },
      { p: 1, plain: cwdText, styled: paint(cwdText, 'primary') }
    ]
    if (info) {
      const mark = info.dirty ? ' ✱' : ''
      list.push({ p: 4, plain: `⎇ ${info.branch}${mark}`, styled: `${paint(`⎇ ${info.branch}`, 'accent')}${info.dirty ? paint(' ✱', 'warn') : ''}` })
    }
    list.push({ p: 2, plain: `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)} ${ctxLabel}`, styled: `${paint('▰'.repeat(filled), ctxRole)}${paint('▱'.repeat(cells - filled), 'muted')} ${paint(ctxLabel, ctxRole)}` })
    list.push({ p: 5, plain: `⬡ ${ready}/${total}`, styled: paint(`⬡ ${ready}/${total}`, !total || ready === total ? 'ok' : 'warn') })
    if (startedAt && Date.now() - startedAt >= 60_000) list.push({ p: 6, plain: `⏱ ${fmtDuration(Date.now() - startedAt)}`, styled: dimText(`⏱ ${fmtDuration(Date.now() - startedAt)}`) })
    list.push({ p: 3, plain: `● ${activity}`, styled: paint(`● ${activity}`, activityRole, true) })
    return list.filter(part => !dropped.has(part.p))
  }
  const sepWidth = 3
  const measure = list => list.reduce((sum, part) => sum + stringWidth(part.plain), 0) + sepWidth * (list.length - 1)
  let list = make()
  while (measure(list) > maxWidth) {
    const victim = list.filter(part => part.p >= 4).sort((a, b) => b.p - a.p)[0]
    if (!victim) break
    dropped.add(victim.p)
    list = make()
  }
  if (measure(list) > maxWidth && stringWidth(cwdText) > 8) {
    const keep = Math.max(8, stringWidth(cwdText) - (measure(list) - maxWidth))
    cwdText = `…${Array.from(cwdText).slice(-(keep - 1)).join('')}`
    list = make()
  }
  if (measure(list) > maxWidth && stringWidth(modelText) > 8) {
    const keep = Math.max(8, stringWidth(modelText) - (measure(list) - maxWidth))
    modelText = `${Array.from(modelText).slice(0, keep - 1).join('')}…`
    list = make()
  }
  if (measure(list) > maxWidth) return paint(clipWidth(list.map(part => part.plain).join(' │ '), maxWidth), 'primary')
  const left = list.map(part => part.styled).join(` ${dimText('│')} `)
  if (hint && measure(list) + 2 + stringWidth(hint) <= maxWidth) return `${left}${' '.repeat(maxWidth - measure(list) - stringWidth(hint))}${dimText(hint)}`
  return left
}

// ---- approval prompt ----
// Covers POSIX and Windows shells: a `del /s /q` or `Remove-Item -Recurse -Force`
// is exactly as destructive as `rm -rf`, so it must not ride an "always" grant.
const DANGEROUS = /(\brm\s+-[a-z]*r[a-z]*|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\b|\bchown\s+-R\b|\bgit\s+push\s+(-f|--force)\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|(curl|wget)[^|\n]*\|\s*(ba|z)?sh|:\(\)\s*\{|>\s*\/dev\/sd|\b(del|erase)\b[^\n]*\s\/[a-z]*[sfq][a-z]*|\b(rd|rmdir)\b[^\n]*\s\/s\b|\bformat\b[^\n]*\s[a-z]:|\bdiskpart\b|\bbcdedit\b|\breg\s+(delete|add)\b|\btakeown\b|\bicacls\b|\bnet\s+(user|localgroup)\b|\bset-executionpolicy\b|\bremove-item\b[^\n]*(-recurse|-force)|\b(stop-process|kill)\b[^\n]*-force|\bclear-disk\b|\b(restart-computer|stop-computer)\b|\bcipher\b[^\n]*\/w|(curl|wget|invoke-webrequest|iwr)[^|\n]*\|\s*(iex|invoke-expression)|\bwmic\b[^\n]*\bdelete\b)/i
export const isDangerousCommand = command => DANGEROUS.test(String(command || ''))

// Summarise a file-edit tool call (diff/patch text, or old/new strings, or whole new content) for the approval box.
export function buildEditPreview(args = {}) {
  const text = value => (typeof value === 'string' ? value : null)
  const lines = []
  let added = 0
  let removed = 0
  const diff = text(args.diff) ?? text(args.patch)
  if (diff) {
    for (const line of diff.split('\n')) {
      if (/^(\+\+\+|---) /.test(line)) continue
      if (line.startsWith('+')) { added++; lines.push(line) } else if (line.startsWith('-')) { removed++; lines.push(line) }
    }
  } else {
    const oldText = text(args.old_string) ?? text(args.old_str) ?? text(args.old_text)
    const newText = text(args.new_string) ?? text(args.new_str) ?? text(args.new_text) ?? text(args.content) ?? text(args.text)
    if (newText === null) return null
    if (oldText) for (const line of oldText.split('\n')) { removed++; lines.push(`-${line}`) }
    for (const line of newText.split('\n')) { added++; lines.push(`+${line}`) }
  }
  return added || removed ? { added, removed, lines } : null
}

export function formatApprovalBox({ name, command = '', server = '', details = [], preview = null, canAlways = false }, width = 80) {
  const columns = Math.max(36, Math.min(Math.floor(Number(width) || 80), 96))
  const inner = columns - 2
  const content = columns - 4
  const danger = isDangerousCommand(command)
  const role = danger ? 'err' : 'warn'
  const edge = text => paint(text, role)
  const title = ` ⚠ Allow tool ${name}? [y/N] `
  const rows = []
  const row = (styled, plain) => rows.push(`${edge('│')} ${styled}${' '.repeat(Math.max(0, content - stringWidth(plain)))} ${edge('│')}`)
  if (server) { const plain = `server  ${server}`; row(`${dimText('server')}  ${clipEllipsis(server, content - 8)}`, clipEllipsis(plain, content)) }
  if (String(command).trim()) {
    for (const raw of String(command).split('\n').slice(0, 6)) {
      const text = clipEllipsis(`$ ${raw}`, content)
      row(paint(text, 'primary'), text)
    }
    if (String(command).split('\n').length > 6) row(dimText('… (command truncated)'), '… (command truncated)')
  }
  for (const [key, value] of details.slice(0, 4)) {
    const text = clipEllipsis(`${key}  ${value}`, content)
    row(`${dimText(key)}${clipEllipsis(text, content).slice(String(key).length)}`, text)
  }
  if (preview) {
    const head = `changes  +${preview.added} −${preview.removed}`
    row(`${dimText('changes')}  ${paint(`+${preview.added}`, 'ok', true)} ${paint(`−${preview.removed}`, 'err', true)}`, head)
    for (const line of preview.lines.slice(0, 8)) { const shown = clipEllipsis(line.replace(/\t/g, '  '), content); row(paint(shown, line.startsWith('+') ? 'ok' : 'err'), shown) }
    if (preview.lines.length > 8) { const more = `… +${preview.lines.length - 8} more lines`; row(dimText(more), more) }
  }
  if (danger) { const note = '⚠ potentially destructive — review before approving'; row(paint(clipEllipsis(note, content), 'err', true), clipEllipsis(note, content)) }
  const keys = `[y] allow once  [n] deny${canAlways ? '  [a] always this session' : ''}`
  row(`${paint('[y]', 'ok', true)} allow once  ${paint('[n]', 'err', true)} deny${canAlways ? `  ${paint('[a]', 'accent', true)} always this session` : ''}`, keys)
  const top = `${edge('╭─')}${paint(title, role, true)}${edge(`${'─'.repeat(Math.max(0, inner - 1 - stringWidth(title)))}╮`)}`
  return [top, ...rows, edge(`╰${'─'.repeat(inner)}╯`)].join('\n')
}

// ---- tool cards ----
// One-line terminal result: "✓ $ npm test · 3.2s" (or "✖ … · exit 1" plus a short dim tail on failure).
export function formatTerminalLine(command, { exit = null, failed = false, durationMs = 0, tail = [], width = 80 } = {}) {
  const cmdLines = String(command || '').split('\n').map(line => line.trim()).filter(Boolean)
  const head = `$ ${cmdLines[0] || 'terminal'}${cmdLines.length > 1 ? ' …' : ''}`
  const timing = durationMs > 0 ? ` · ${fmtDuration(durationMs)}` : ''
  const exitNote = failed && exit !== null && exit !== 'unknown' ? ` · exit ${exit}` : ''
  const room = Math.max(16, width - 6 - stringWidth(timing) - stringWidth(exitNote))
  const icon = failed ? paint('✖', 'err', true) : paint('✓', 'ok', true)
  const rows = [`  ${icon} ${clipEllipsis(head, room)}${failed ? paint(exitNote, 'err') : ''}${dimText(timing)}`]
  for (const line of tail) rows.push(`    ${dimText(clipEllipsis(line, Math.max(12, width - 8)))}`)
  return rows.join('\n')
}

export function formatToolCall(text, { width = 80 } = {}) {
  const lines = stripAnsi(String(text || '')).split('\n').map(line => line.replace(/\s+$/, ''))
  while (lines.length > 1 && !lines[lines.length - 1]) lines.pop()
  const room = Math.max(12, width - 4)
  const rows = [`${paint('●', 'primary')} ${sgr(BOLD_ON)}${clipEllipsis(lines[0].trim() || 'tool', room)}${sgr(BOLD_OFF)}`]
  for (const extra of lines.slice(1, 5)) rows.push(`  ${dimText(clipEllipsis(extra, room))}`)
  if (lines.length > 5) rows.push(`  ${dimText(`… +${lines.length - 5} more lines`)}`)
  return rows.join('\n')
}

// One compact line for a successful, uneventful tool call: "✓ read_file auth.rs — 80 lines · 120ms".
export function formatToolLine(callText, resultText, { durationMs = 0, width = 80 } = {}) {
  const head = stripAnsi(String(callText || '')).split('\n')[0].trim() || 'tool'
  const detail = stripAnsi(String(resultText || '')).replace(/^([^\n]*)\s+\d+(?:\.\d+)?s(?=\r?$)/m, '$1').split('\n').map(line => line.trim()).find(Boolean) || ''
  const timing = durationMs > 0 ? ` · ${fmtDuration(durationMs)}` : ''
  const room = Math.max(16, width - 6 - stringWidth(timing))
  const shownHead = clipEllipsis(head, room)
  const left = room - stringWidth(shownHead) - 3
  const tail = detail && detail !== head && left > 8 ? ` ${dimText(`— ${clipEllipsis(detail, left - 2)}`)}` : ''
  return `  ${paint('✓', 'ok', true)} ${shownHead}${tail}${dimText(timing)}`
}

export function formatToolResult(text, { error = false, durationMs = 0, maxLines = 8, width = 80 } = {}) {
  const plain = stripAnsi(String(text || '')).replace(/^([^\n]*)\s+\d+(?:\.\d+)?s(?=\r?$)/m, '$1')
  const timing = durationMs > 0 ? dimText(` · ${fmtDuration(durationMs)}`) : ''
  const icon = error ? paint('✖', 'err', true) : paint('✓', 'ok', true)
  const lead = `  ${dimText('⎿')} ${icon}`
  if (/^\s*@@ /m.test(plain)) return [`${lead}${timing}`, ...colorizeDiffPro(plain, { width: width - 4, maxLines: 30 }).map(row => `    ${row}`)].join('\n')
  const room = Math.max(12, width - 8)
  const wrap = value => {
    const chars = Array.from(value)
    const wrapped = []
    while (chars.length) {
      let text = ''
      let used = 0
      let count = 0
      while (count < chars.length) {
        const nextWidth = charWidth(chars[count])
        if (used + nextWidth > room) break
        text += chars[count++]
        used += nextWidth
      }
      wrapped.push(text || chars[0])
      chars.splice(0, count || 1)
    }
    return wrapped.length ? wrapped : ['']
  }
  const lines = plain.split('\n').map(line => line.replace(/\s+$/, '')).filter((line, i, all) => line || (i > 0 && i < all.length - 1)).flatMap(wrap)
  const first = lines.shift() || ''
  const head = clipEllipsis(first, Math.max(8, room - stringWidth(timing)))
  const rows = [`${lead}${head ? ` ${error ? paint(head, 'err') : head}` : ''}${timing}`]
  for (const line of lines.slice(0, maxLines - 1)) rows.push(`    ${dimText(line)}`)
  if (lines.length > maxLines - 1) rows.push(`    ${dimText(`… +${lines.length - (maxLines - 1)} more lines`)}`)
  return rows.join('\n')
}

export function formatFileEditResult(name, args = {}, rawResult = '', { durationMs = 0, width = 80 } = {}) {
  let result
  try { result = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult } catch { result = { error: String(rawResult) } }
  const rawPath = String(result?.path || result?.resolved_path || args.path || '(unknown path)')
  const home = homedir()
  const path = rawPath.startsWith(`${process.cwd()}/`) ? rawPath.slice(process.cwd().length + 1)
    : rawPath === home || rawPath.startsWith(`${home}/`) ? `~${rawPath.slice(home.length)}` : rawPath
  const timing = durationMs > 0 ? ` · ${fmtDuration(durationMs)}` : ''
  const summary = `  ${name} ${path}${result?.verified ? ' · verified' : ''}${result?.strategy ? ` · match: ${result.strategy}` : ''}${timing}`
  const wrap = value => {
    const chars = Array.from(value)
    const lines = []
    while (chars.length) {
      let line = ''; let cells = 0; let count = 0
      while (count < chars.length && cells + charWidth(chars[count]) <= Math.max(12, width - 4)) {
        line += chars[count]; cells += charWidth(chars[count]); count++
      }
      const breakAt = count < chars.length ? line.lastIndexOf(' ') : -1
      if (breakAt > 0) { line = line.slice(0, breakAt); count = breakAt + 1 }
      lines.push(line || chars[0]); chars.splice(0, count || 1)
    }
    return lines.length ? lines : ['']
  }
  if (result?.error) return [`  ${dimText('┊')} ${paint('✖', 'err', true)} ${name} ${path} · error${timing}`, `    ${result.error}`].flatMap(line => wrap(line).map((part, index) => index ? `    ${part}` : part)).join('\n')
  const rows = wrap(summary).map((line, index) => `${index ? '    ' : `  ${dimText('┊')} ${paint('✓', 'ok', true)} `}${line}`)
  if (result?.diff) {
    const diffLines = String(result.diff).split('\n')
    const fileHeader = diffLines.find(line => line.startsWith('+++ '))
    const displayPath = fileHeader ? fileHeader.slice(4).replace(/^b\//, '') : path
    rows.push(`  ${dimText('│')} review diff · ${displayPath}`)
    rows.push(...colorizeDiffPro(diffLines.filter(line => !line.startsWith('--- ') && !line.startsWith('+++ ')).join('\n'), { width: Math.max(24, width - 4), maxLines: 30 }).map(row => `  ${dimText('│')} ${row}`))
  }
  if (result?.diff_truncated) rows.push(`  ${dimText('│')} ${dimText(`… ${Number(result.diff_omitted_lines) || 'some'} diff lines omitted`)}`)
  if (result?.diff_omitted) rows.push(`  ${dimText('│')} ${dimText(result.diff_omitted)}`)
  if (result?.lsp_diagnostics) rows.push(`  ${dimText('│')} ${paint('diagnostics', 'warn')}: ${result.lsp_diagnostics}`)
  return rows.join('\n')
}

// Diff with line-number gutter and add/remove background tints. Returns an array of rows.
export function colorizeDiffPro(text, { width = 80, maxLines = 30 } = {}) {
  const level = getColorLevel()
  const lines = stripAnsi(String(text)).split('\n')
  const room = Math.max(10, width - 6)
  let oldNo = null
  let newNo = null
  const rows = []
  // Real unified diffs ("+x" / "-x" / " x" at column 0) vs. indented previews from the core ("  + x").
  const strict = lines.some(line => /^[+-](?![+-]{2} )/.test(line))
  const wrapDiffLine = (line, columns) => {
    const chars = Array.from(line)
    const pieces = []
    while (chars.length) {
      let part = ''
      let cells = 0
      let count = 0
      while (count < chars.length) {
        const char = chars[count]
        const next = charWidth(char)
        if (cells + next > columns) break
        part += char
        cells += next
        count++
      }
      pieces.push(part || chars[0])
      chars.splice(0, count || 1)
    }
    return pieces.length ? pieces : ['']
  }
  for (let i = 0; i < lines.length; i++) {
    if (rows.length >= maxLines) { rows.push(dimText(`… +${lines.length - i} more lines`)); break }
    const raw = lines[i]
    if (/^\s*@@ /.test(raw)) {
      const hunk = /^\s*@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw)
      if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]) }
      for (const part of wrapDiffLine(raw.trim(), Math.max(1, width - 2))) rows.push(paint(part, 'primary'))
      continue
    }
    const add = strict ? /^\+(?!\+\+ )/.test(raw) : /^\s+\+(?!\+\+)/.test(raw)
    const del = strict ? /^-(?!-- )/.test(raw) : /^\s+-(?!--)/.test(raw)
    if (oldNo === null && newNo === null && !add && !del) {
      if (raw.trim()) for (const part of wrapDiffLine(raw.trim(), Math.max(1, width - 2))) rows.push(dimText(part))
      continue
    }
    let no = null
    if (add) { no = newNo; if (newNo !== null) newNo++ }
    else if (del) { no = oldNo; if (oldNo !== null) oldNo++ }
    else if (newNo !== null && (raw.trim() || (strict && i < lines.length - 1))) { no = newNo; newNo++; if (oldNo !== null) oldNo++ }
    const gutter = dimText(`${no === null ? '' : String(no)}`.padStart(4) + ' ')
    const continuation = '     '
    const bodyParts = wrapDiffLine(raw, Math.max(1, room))
    if (add || del) {
      const tint = level >= 2 ? bg(add ? (getTheme().addBg || '#10301c') : (getTheme().delBg || '#3a1420')) : ''
      bodyParts.forEach((body, index) => {
        const prefix = index ? continuation : ''
        const pad = ' '.repeat(Math.max(0, room - stringWidth(prefix) - stringWidth(body)))
        rows.push(`${index ? dimText(prefix) : gutter}${tint}${fg(add ? 'ok' : 'err')}${body}${pad}${FG_OFF}${tint ? BG_OFF : ''}`)
      })
    } else bodyParts.forEach((body, index) => rows.push(`${index ? dimText(continuation) : gutter}${dimText(body)}`))
  }
  return rows
}

// ---- user message bubble (interactive chat history) ----
// Soft full-width panel with a coloured prompt glyph; falls back to a plain "› text" on low-colour terminals.
export function formatUserMessage(message, width = 80) {
  const columns = Math.max(36, Math.floor(Number(width) || 80))
  const room = columns - 4
  const rich = getColorLevel() >= 2
  const rows = []
  for (const line of String(message ?? '').split('\n')) {
    const chars = Array.from(line)
    do {
      let piece = ''; let used = 0; let count = 0
      while (count < chars.length) {
        const w = charWidth(chars[count])
        if (used + w > room) break
        piece += chars[count++]; used += w
      }
      if (!count && chars.length) { piece = chars[0]; count = 1 }
      chars.splice(0, count)
      rows.push(piece)
    } while (chars.length)
  }
  return rows.map((text, i) => {
    const lead = i === 0 ? paint('›', 'primary', true) : ' '
    if (!rich) return `${lead} ${text}`
    return `${bg('panel')} ${lead} ${sgr(BOLD_ON)}${text}${sgr(BOLD_OFF)}${' '.repeat(Math.max(0, room - stringWidth(text)))} ${BG_OFF}`
  }).join('\n')
}

// ---- end-of-session card + startup tips ----
export function formatSessionSummary({ model = '', sessionId = '', startedAt = 0, turns = 0, toolCalls = 0, toolErrors = 0, percent = 0, width = 80 } = {}) {
  const columns = Math.max(36, Math.min(Math.floor(Number(width) || 80), 80))
  const inner = columns - 2
  const content = columns - 4
  const edge = text => paint(text, 'accent')
  const title = ' Session summary '
  const row = (text, role) => `${edge('│')} ${role ? paint(clipEllipsis(text, content), role) : dimText(clipEllipsis(text, content))}${' '.repeat(Math.max(0, content - stringWidth(clipEllipsis(text, content))))} ${edge('│')}`
  const rows = [
    row(`⏱ ${fmtDuration(Date.now() - (startedAt || Date.now()))}   ↻ ${turns} turn${turns === 1 ? '' : 's'}   ⚙ ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}${toolErrors ? ` (${toolErrors} failed)` : ''}`, 'primary'),
    row(`◆ ${model || 'model'}   ctx ${percent}%`, 'accent')
  ]
  if (sessionId) rows.push(row(`session ${sessionId}`))
  rows.push(row('continue later: /sessions → /resume <number>'))
  return [`${edge('╭─')}${paint(title, 'accent', true)}${edge(`${'─'.repeat(Math.max(0, inner - 1 - stringWidth(title)))}╮`)}`, ...rows, edge(`╰${'─'.repeat(inner)}╯`)].join('\n')
}

export const TIPS = [
  'type / for commands — Tab completes, Enter runs',
  'type @ to mention a file from your project',
  '/theme switches the color theme (vallen, midnight, sunset, matrix, nord, rose, paper, mono)',
  'Ctrl+C stops a running turn; press it twice to exit',
  '/plan <task> drafts a read-only plan before anything is changed',
  '/compact frees context when the CTX bar turns yellow or red',
  'long pastes are folded into a single message automatically',
  'VALLEN_ASCII=1 swaps box glyphs for plain ASCII; VALLEN_VERBOSE=1 shows full tool cards',
  'on a light terminal, /theme paper gives readable colours'
]
export const formatTip = (index = Math.floor(Math.random() * TIPS.length)) => `${paint('✦', 'accent')} ${dimText(`tip: ${TIPS[Math.abs(index) % TIPS.length]}`)}`

// Command-suggestion dropdown. Returns an array of single-line strings (never wider than width - 1).
const CAT_ROLE = { chat: 'primary', agent: 'accent', workspace: 'ok', system: 'warn' }
export function formatSuggestions(items, selected = 0, width = 80, top = 0, maxRows = 6, query = '') {
  const limit = Math.max(20, Math.floor(Number(width) || 80)) - 1
  if (!items.length) return [color(`  no matching command · /help lists them all`, ANSI.dim)]
  const visible = items.slice(top, top + maxRows)
  const label = item => `${item.name}${item.args ? ` ${item.args}` : ''}`
  const nameWidth = Math.min(visible.some(item => item.fileItem) ? 44 : 30, Math.max(...visible.map(item => stringWidth(label(item)))))
  const rich = getColorLevel() >= 2
  const rows = visible.map((item, offset) => {
    const active = top + offset === selected
    const text = label(item)
    const room = Math.max(0, limit - 3 - nameWidth - 2)
    const desc = stringWidth(item.desc) > room ? `${clipWidth(item.desc, Math.max(0, room - 1))}…` : item.desc
    const shown = stringWidth(item.name) > nameWidth ? `…${Array.from(item.name).slice(-(nameWidth - 1)).join('')}` : item.name
    const pad = ' '.repeat(Math.max(0, nameWidth - stringWidth(shown) - (item.args ? stringWidth(item.args) + 1 : 0)))
    const hits = new Set(item.fileItem ? [] : matchPositions(query, item.name.slice(1)).map(i => i + 1))
    const name = Array.from(shown).map((ch, i) => (hits.has(i)
      ? `${sgr(BOLD_ON)}${fg('warn')}${ch}${FG_OFF}${sgr(BOLD_OFF)}`
      : `${active ? sgr(BOLD_ON) : ''}${fg('primary')}${ch}${FG_OFF}${active ? sgr(BOLD_OFF) : ''}`)).join('')
    const args = item.args ? dimText(` ${item.args}`) : ''
    const glyph = item.fileItem ? (item.desc === 'directory' ? '▸' : '▪') : '●'
    const marker = active ? ` ${paint('❯', 'primary', true)} ` : ` ${fg(CAT_ROLE[item.cat] || 'muted')}${glyph}${FG_OFF} `
    const content = `${marker}${name}${args}${pad}  ${active ? desc : dimText(desc)}`
    if (active && rich) return `${bg('panel')}${content}${' '.repeat(Math.max(0, limit - stringWidth(content)))}${BG_OFF}`
    return content
  })
  const enterWord = items[selected]?.fileItem ? 'insert' : 'run'
  rows.push(dimText(clipWidth(`   ↑↓ select · Tab complete · Enter ${enterWord} · Esc close · ${selected + 1}/${items.length}`, limit)))
  return rows
}
