#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ANSI, color, stripAnsi, stringWidth, clipWidth, HELP, collectHealthChecks, startupBox, chatBoxRedrawSequence, formatChatBox, formatStatus, formatThinkingActivity, formatSuggestions, colorizeDiff, THINKING_FACES, THINKING_VERBS, formatStatusBar, formatApprovalBox, formatToolResult, formatFileEditResult, formatSessionSummary, formatTip, formatUserMessage, formatToolCall, formatToolLine, buildEditPreview, formatTerminalLine, isDangerousCommand, toAscii, fmtTokens, fmtDuration, refreshThemeColors, invalidateGit } from './cli-ui.mjs'
import { loadSavedTheme, shimmerText, getColorLevel } from './cli-theme.mjs'
import { createCardStream, formatResponseCard } from './cli-markdown.mjs'
import { fileToken, suggestFiles } from './cli-files.mjs'
import { suggestCommands, commandToken, findCommand, needsMoreInput } from './cli-suggest.mjs'
import { createLocalCommandHandler } from './cli-commands.mjs'
import { backspacePicker, backPicker, createPickerState, enterPicker, fetchGatewayModels, formatModelCatalog, groupModelsByOwner, movePicker, pickerLines, typeInPicker } from './cli-model-picker.mjs'
export { HELP, collectHealthChecks, chatBoxRedrawSequence, formatChatBox, formatStatus, formatThinkingActivity } from './cli-ui.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CORE_PATH = join(ROOT, 'vallenagent', 'dist', 'index.js')
// VALLEN_ASCII=1 (or a legacy Windows console) swaps box glyphs for plain ASCII.
let ASCII_MODE = process.env.VALLEN_ASCII === '1'
function write(output, text = '') {
  const line = `${text}${text.endsWith('\n') ? '' : '\n'}`
  output.write(ASCII_MODE ? toAscii(line) : line)
}

function toolError(result) {
  try { return JSON.parse(result)?.error || null } catch { return null }
}

function hasToolError(result) { return Boolean(toolError(result)) }

// Tool events carry no stable id across versions: try the likely ones, fall back to the tool name.
const toolKey = tool => tool?.id ?? tool?.callId ?? tool?.toolCallId ?? tool?.name
// Short "key  value" lines describing a non-terminal tool call for the approval box.
const summarizeArgs = args => Object.entries(args && typeof args === 'object' ? args : {}).slice(0, 4).map(([key, value]) => [key, String(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').slice(0, 120)])
// Event names an agent may use for streamed answer text.
// Edit-style tools: the approval box shows a +/- preview instead of raw argument dumps.
const isEditTool = name => /patch|write|edit|replace/i.test(String(name))
const editPreviewFor = request => (isEditTool(request?.name) ? buildEditPreview(request.args) : null)
/** Edits changing more lines than this always show their diff before landing, whatever the approval mode. */
export const BIG_EDIT_PREVIEW_LINES = 20

/**
 * Preview that must be shown even in `dangerous` mode: a large edit is exactly the case where
 * a silent write is expensive. Only interactive surfaces ask (a one-shot run has nobody to ask).
 */
export function bigEditPreview(request, { interactive = true } = {}) {
  if (!interactive || !isEditTool(request?.name)) return null
  const preview = buildEditPreview(request?.args)
  if (!preview) return null
  const changedLines = preview.added + preview.removed
  return changedLines > BIG_EDIT_PREVIEW_LINES ? { ...preview, changedLines } : null
}
// "/auto on" promises "no approval gates". A big edit used to bypass the mode check and
// still prompt, so /auto looked broken. The mode wins; the preview only decides when the
// mode is not 'off'.
export function shouldAskApproval({ mode, required, bigPreview }) {
  if (mode === 'off') return false
  return Boolean(required || bigPreview)
}
// "[a] always this session" scope: all file-edit tools share one key; terminal has its own; everything else is per tool.
const approvalKey = request => (isEditTool(request?.name) ? 'file-edit' : String(request?.name))
// Destructive shell commands (rm -r, sudo, git push -f, ...) never ride on an "always" grant.
const isRiskyTerminal = request => request?.name === 'terminal' && isDangerousCommand(request.args?.command)
const stripEditArgs = args => Object.fromEntries(Object.entries(args && typeof args === 'object' ? args : {}).filter(([key]) => !/^(old|new|content|text|diff|patch)/i.test(key)))
const DELTA_EVENTS = new Set(['text_delta', 'delta', 'response_delta', 'message_delta', 'content_delta', 'assistant_delta'])

function safeInput(value) { return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') }

export async function runCli(options = {}) {
  const input = options.input || process.stdin
  const output = options.output || process.stdout
  const core = options.core || await import(pathToFileURL(CORE_PATH).href)
  const state = { busy: false, closing: false, pendingApproval: null, activeTurn: null, mcpServers: [], rl: null, generation: 0, queue: [], waiter: null, ended: false, started: false, terminalBuffer: '', robotVisible: false, robotActivity: 'THINKING', turnStartedAt: 0, thinkingFaceIndex: 0, thinkingVerbIndex: 0, thinkingTimer: null, thinkingTicks: 0, spinnerFrame: 0, statusRows: 0, sugRows: 0, sugReserved: 0, sugTimer: null, sug: { token: null, kind: 'cmd', fileStart: 0, items: [], index: 0, top: 0, open: false, dismissed: null }, pastes: new Map(), pasteSeq: 0, lastSigint: 0, sessionStartedAt: Date.now(), turns: 0, toolCalls: 0, toolErrors: 0, toolStarts: new Map(), terminalOutputs: new Map(), terminalOutputTruncated: new Set(), lastTerminalOutput: '', stream: null, streamedChars: 0, sessionAllow: new Set(), printSeq: 0, approvalBox: null, modelPicker: null, lastTokens: 0, turnToolCalls: 0, toolCallText: new Map() }
  let agent = options.agent
  if (!agent) agent = options.createAgent ? options.createAgent({ onMcpStatus: servers => { state.mcpServers = servers; if (state.started) refreshStatus() } }) : new core.AIAgent({ onMcpStatus: servers => { state.mcpServers = servers; if (state.started) refreshStatus() } })
  state.mcpServers = agent.mcpManager?.getStatus?.() || []
  if (options.resumeSessionId || options.resumeLatest) {
    try {
      const sessions = agent.sessionManager?.listSessions?.() || []
      const target = options.resumeSessionId || sessions[0]?.id
      if (target && agent.resumeSession?.(target)) out(`Resumed session ${target}\n`)
      else out('No saved session to resume.\n')
    } catch (error) {
      out(`Could not resume session: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  const healthCheck = options.healthCheck || ((target, servers) => collectHealthChecks(target, servers, core))
  const bannerText = options.bannerText ?? (() => { try { return readFileSync(join(ROOT, 'banner.txt'), 'utf8') } catch { return '' } })()
  const sharedCommand = options.handleSharedCommand || core.handleCommand
  // A legacy Windows console (conhost without VT processing) prints ANSI escapes as
  // garbage and ignores bracketed paste, so it gets plain ASCII and no colour.
  const legacyWindowsConsole = platform() === 'win32'
    && !process.env.WT_SESSION && !process.env.TERM_PROGRAM && !process.env.CONEMU_VERSION && !process.env.ANSICON
  ASCII_MODE = ASCII_MODE || legacyWindowsConsole
  const supportsAnsi = !legacyWindowsConsole
  const noColorMode = process.env.NO_COLOR || output.isTTY === false || !supportsAnsi
  const fixAscii = value => (ASCII_MODE ? toAscii(value) : value)
  const out = value => output.write(fixAscii(noColorMode ? stripAnsi(value) : value))
  const verboseTools = process.env.VALLEN_VERBOSE === '1'
  const interactive = Boolean(input.isTTY && output.isTTY)
  const compactUi = interactive && ((output.columns || 80) < 70 || (output.rows || 40) < 24)
  const termWidth = () => Math.max(40, output.columns || 80)
  const boxWidth = () => Math.max(36, Math.min((output.columns || 80) - 2, 80))
  const home = process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor')
  const historyFile = join(home, 'cli_history')
  if (interactive) { loadSavedTheme(home); refreshThemeColors() }
  const setTitle = text => { if (interactive && supportsAnsi) output.write(`\x1b]0;${text}\x07`) }
  let readerInput = input
  const loadHistory = () => {
    if (!interactive) return []
    try { return readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).slice(-500).reverse() } catch { return [] }
  }
  const saveHistory = line => {
    if (!interactive || !line.trim() || /^\/token\b/i.test(line) || /\[Pasted text #\d+/.test(line)) return
    try { mkdirSync(home, { recursive: true }); appendFileSync(historyFile, `${line}\n`, { mode: 0o600 }) } catch {}
  }
  const pasteMode = on => { if (interactive && supportsAnsi) output.write(on ? '\x1b[?2004h' : '\x1b[?2004l') }
  const resetPasteMode = () => { try { output.write('\x1b[?2004l') } catch {} }
  function lockInputEcho() {
    const rl = state.rl
    if (!input.isTTY || !output.isTTY || !rl || typeof rl._writeToOutput !== 'function' || state.restoreInputEcho) return
    const originalOutput = rl.output
    rl.output = { write() {} }
    state.restoreInputEcho = () => {
      if (state.rl === rl) {
        if (!rl.closed) rl.write(null, { ctrl: true, name: 'u' })
        rl.output = originalOutput
      }
      state.restoreInputEcho = null
    }
  }
  function unlockInputEcho() { state.restoreInputEcho?.() }
  const robotLine = activity => {
    const thinking = activity === 'THINKING'
    const label = thinking
      ? `${formatThinkingActivity(Date.now() - state.turnStartedAt, state.thinkingFaceIndex, state.thinkingVerbIndex, interactive ? state.spinnerFrame : null)}${interactive && state.lastTokens > 0 ? ` · ${fmtTokens(state.lastTokens)} ctx` : ''}${interactive ? ' · Ctrl+C to stop' : ''}`
      : `[o_o] ${activity}`
    if (interactive && getColorLevel() > 0) {
      if (thinking) return `  ${shimmerText(label, state.thinkingTicks)}`
      return color(`  ${activity === 'APPROVAL' ? '⚠' : '⚙'} ${clipWidth(activity, Math.max(12, termWidth() - 6))}`, activity === 'APPROVAL' ? ANSI.red : ANSI.yellow)
    }
    return color(`  ${label}`, ANSI.dim)
  }
  function stopThinkingTicker() {
    if (state.thinkingTimer) clearInterval(state.thinkingTimer)
    state.thinkingTimer = null
  }
  function startThinkingTicker() {
    if (!output.isTTY || !input.isTTY || state.thinkingTimer) return
    state.thinkingTicks = 0
    state.thinkingTimer = setInterval(() => {
      if (!state.busy || state.robotActivity !== 'THINKING') return stopThinkingTicker()
      state.thinkingTicks++
      state.spinnerFrame = state.thinkingTicks
      if (state.thinkingTicks % 25 === 0) {
        state.thinkingFaceIndex = Math.floor(Math.random() * THINKING_FACES.length)
        state.thinkingVerbIndex = Math.floor(Math.random() * THINKING_VERBS.length)
      }
      output.write('\r\x1b[2K')
      out(robotLine('THINKING'))
      state.robotVisible = true
    }, 120)
    state.thinkingTimer.unref?.()
  }
  function showRobot(activity) {
    state.robotActivity = activity
    if (activity === 'THINKING') startThinkingTicker()
    else stopThinkingTicker()
    if (output.isTTY && input.isTTY) {
      if (state.robotVisible) output.write('\r\x1b[2K')
      out(robotLine(activity))
      state.robotVisible = true
    } else write(output, noColorMode ? stripAnsi(robotLine(activity)) : robotLine(activity))
  }
  function displayLine(value) {
    state.printSeq++
    const text = noColorMode ? stripAnsi(value) : value
    if (state.busy) {
      if (output.isTTY && input.isTTY) {
        if (!state.robotVisible) showRobot(state.pendingApproval ? 'APPROVAL' : state.robotActivity)
        output.write('\r\x1b[2K')
        write(output, text)
        out(robotLine(state.robotActivity))
      } else {
        write(output, text)
        showRobot(state.pendingApproval ? 'APPROVAL' : state.robotActivity)
      }
      return
    }
    if (state.rl && interactive && !state.closing) {
      clearPromptArea()
      write(output, text)
      drawPrompt()
    } else write(output, text)
  }

  function captureTerminalOutput(event) {
    const id = String(event?.id || 'unknown')
    const current = state.terminalOutputs.get(id) || ''
    const chunk = safeInput(event?.chunk || '')
    if (current.length + chunk.length > 200_000) state.terminalOutputTruncated.add(id)
    state.terminalOutputs.set(id, current + chunk.slice(0, Math.max(0, 200_000 - current.length)))
  }
  function flushTerminalChunk(id, tool, durationMs = 0) {
    const raw = state.terminalOutputs.get(String(id)) || ''
    state.terminalOutputs.delete(String(id))
    const truncated = state.terminalOutputTruncated.delete(String(id))
    const text = raw.replace(/\n?__VALLEN_CWD__=.*?(?:\n|$)/g, '\n').trim()
    let exit = 'unknown'
    try { exit = JSON.parse(tool.result)?.exit_code ?? exit } catch {}
    // Interactive mode: just "✓ $ command · 3.2s" (full output stays available through /output).
    if (interactive && !verboseTools) {
      if (text) state.lastTerminalOutput = `${text}${truncated ? '\n[CLI preview limit reached; remaining output omitted]' : ''}`
      const failed = hasToolError(tool.result) || (exit !== 'unknown' && Number(exit) !== 0)
      const tail = failed ? (text || String(toolError(tool.result) || '')).split('\n').filter(Boolean).slice(-4) : []
      displayLine(formatTerminalLine(tool.args?.command, { exit, failed, durationMs, tail, width: boxWidth() }))
      return true
    }
    if (!text) return false
    state.lastTerminalOutput = `${text}${truncated ? '\n[CLI preview limit reached; remaining output omitted]' : ''}`
    const lines = state.lastTerminalOutput.split('\n')
    const command = String(tool.args?.command || '').replace(/\s+/g, ' ').trim()
    const preview = lines.length <= 8 ? lines : [...lines.slice(0, 4), `… ${lines.length - 8} lines hidden · use /output`, ...lines.slice(-4)]
    const title = ` Terminal · $ ${command} · exit ${exit} · ${fmtDuration(durationMs)} `
    const card = formatResponseCard(`${lines.length} lines${lines.length > 8 ? ' · /output expands' : ''}\n\n${preview.join('\n')}`, title, boxWidth(), { markdown: false })
    displayLine(card)
    return true
  }

  function renderChatBox(message) {
    state.mcpServers = agent.mcpManager?.getStatus?.() || state.mcpServers
    const width = Math.max(36, output.columns || 80)
    const status = formatStatus(agent, state.mcpServers, 'VALLENEMPEROR', width - 4)
    const box = formatChatBox(status, `› ${message}`, width)
    write(output, noColorMode ? stripAnsi(box) : box)
  }

  function refreshStatus(activity = state.pendingApproval ? 'APPROVAL' : state.busy ? 'WORKING' : 'VALLENEMPEROR') {
    state.mcpServers = agent.mcpManager?.getStatus?.() || state.mcpServers
    // --quiet on a non-interactive run means no status chrome at all.
    if (options.quiet && !interactive) return
    if (state.busy) {
      showRobot(activity)
      return
    }
    if (state.robotVisible) {
      output.write('\r\x1b[2K')
      state.robotVisible = false
    }
    if (!interactive) { displayLine(formatStatus(agent, state.mcpServers, activity, output.columns || 80)); return }
    clearPromptArea()
    drawPrompt()
  }
  // One live status line + the input prompt. Erased on Enter, so it never piles up in the chat history.
  function drawPrompt() {
    if (state.closing || !state.rl || !interactive) return
    const rule = color('─'.repeat(Math.max(10, termWidth() - 1)), ANSI.dim)
    out(`${rule}\n${formatStatusBar(agent, state.mcpServers, { activity: state.pendingApproval ? 'APPROVAL' : 'VALLENEMPEROR', width: termWidth() - 1, startedAt: state.sessionStartedAt, hint: 'Ctrl+C stop · /help' })}\n`)
    state.rl.setPrompt(fixAscii(`${noColorMode ? '›' : color('›', ANSI.bold + ANSI.cyan)} `))
    state.rl.prompt(true)
    state.statusRows = 2
    state.sugRows = 0
    state.sugReserved = 0
    state.sug.token = null
    scheduleSuggest()
  }
  function prompt() { drawPrompt() }
  // Wipe status line, input line and any suggestion list (cursor is on the input line).
  function clearPromptArea() {
    if (!state.statusRows) return
    output.write(`\r\x1b[${state.statusRows}A\x1b[J`)
    state.statusRows = 0
    state.sugRows = 0
    state.sugReserved = 0
  }

  // ---- command suggestions (dropdown under the input line) ----
  function updateSuggestions() {
    const sug = state.sug
    if (state.modelPicker) { sug.open = false; sug.token = null; return sug }
    const line = state.rl?.line ?? ''
    const ok = interactive && state.rl && !state.busy && !state.closing && stringWidth(line) < termWidth() - 6
    const cmd = ok ? commandToken(line) : null
    const file = ok && !cmd ? fileToken(line) : null
    const token = cmd || (file ? `@${file.partial}` : null)
    if (token !== sug.token) {
      sug.token = token
      sug.kind = file ? 'file' : 'cmd'
      sug.fileStart = file ? file.start : 0
      sug.items = cmd ? suggestCommands(cmd) : file ? suggestFiles(file.partial, agent.config?.terminal?.cwd || process.cwd()) : []
      sug.index = 0
      sug.top = 0
      sug.dismissed = null
    }
    sug.open = Boolean(token) && sug.dismissed !== token && (sug.kind === 'cmd' || sug.items.length > 0)
    return sug
  }
  function scheduleSuggest() {
    if (!interactive || state.sugTimer) return
    state.sugTimer = setImmediate(() => { state.sugTimer = null; paintSuggestions() })
  }
  function paintSuggestions() {
    if (!interactive || !state.rl || state.busy || state.closing) return
    const sug = updateSuggestions()
    const lines = sug.open ? formatSuggestions(sug.items, sug.index, termWidth(), sug.top, 6, sug.kind === 'cmd' ? String(sug.token || '').slice(1) : '') : []
    if (!lines.length && !state.sugRows) return
    const pos = typeof state.rl.getCursorPos === 'function' ? state.rl.getCursorPos() : { cols: 2 + (state.rl.cursor || 0) }
    let seq = ''
    if (state.sugReserved > 0) seq += '\x1b[1B\r\x1b[J\x1b[1A'
    for (const line of lines) seq += `\r\n\x1b[2K${line}`
    if (lines.length) seq += `\x1b[${lines.length}A`
    seq += `\x1b[${pos.cols + 1}G`
    out(seq)
    state.sugRows = lines.length
    state.sugReserved = Math.max(state.sugReserved, lines.length)
  }
  function fillLine(text) {
    const rl = state.rl
    rl.write(null, { ctrl: true, name: 'e' })
    rl.write(null, { ctrl: true, name: 'u' })
    rl.write(text)
    scheduleSuggest()
  }
  // Keys that drive the dropdown. Returns true when the key was consumed (readline never sees it).
  function handleSuggestKey(key) {
    if (!interactive || !state.rl || state.busy || state.closing) return false
    const up = key === '\x1b[A' || key === '\x1bOA'
    const down = key === '\x1b[B' || key === '\x1bOB'
    const tab = key === '\t'
    const esc = key === '\x1b'
    const enter = key === '\r' || key === '\n'
    if (!(up || down || tab || esc || enter)) return false
    const sug = updateSuggestions()
    if (!sug.open || !sug.items.length) return false
    if (up || down) {
      const count = sug.items.length
      sug.index = (sug.index + (down ? 1 : -1) + count) % count
      if (sug.index < sug.top) sug.top = sug.index
      if (sug.index >= sug.top + 6) sug.top = sug.index - 5
      paintSuggestions()
      return true
    }
    if (esc) { sug.dismissed = sug.token; paintSuggestions(); return true }
    const item = sug.items[sug.index]
    if (sug.kind === 'file') {
      // Enter on an already-complete mention just sends the message; otherwise insert the highlighted entry.
      if (enter && item.fillText.trimEnd() === sug.token) return false
      const line = state.rl.line ?? ''
      fillLine(`${line.slice(0, sug.fileStart)}${item.fillText}`)
      return true
    }
    if (tab) { fillLine(`${item.name}${item.args ? ' ' : ''}`); return true }
    if (findCommand(sug.token)) return false // exact command typed: Enter just runs it
    if (needsMoreInput(item) || item.fuzzy) { fillLine(`${item.name}${item.args ? ' ' : ''}`); return true }
    fillLine(item.name)
    readerInput.write('\r')
    return true
  }

  // ---- /model picker: provider/account first, then the model ----
  const fetchModels = options.fetchModels || fetchGatewayModels
  function pickerWidth() { return Math.max(40, Math.min(termWidth() - 2, 100)) }

  function paintModelPicker() {
    const picker = state.modelPicker
    if (!picker || picker.loading || !interactive) return
    if (picker.rows) output.write(`\r\x1b[${picker.rows}A\x1b[J`)
    const { lines, selectedIndex } = pickerLines(picker, { width: pickerWidth() })
    lines.forEach((line, index) => {
      out(`${index === selectedIndex ? color(line, ANSI.cyan) : line}\n`)
    })
    picker.rows = lines.length
  }

  function closeModelPicker({ keepRows = false } = {}) {
    const picker = state.modelPicker
    if (!picker) return
    if (!keepRows && picker.rows) output.write(`\r\x1b[${picker.rows}A\x1b[J`)
    state.modelPicker = null
    prompt()
  }

  async function openModelPicker() {
    const active = agent.config?.providers?.active
    const provider = active ? agent.config?.providers?.[active] : null
    const baseUrl = agent.provider?.baseURL || (provider && typeof provider === 'object' ? provider.base_url : '')
    const apiKey = provider && typeof provider === 'object' ? provider.api_key || '' : ''
    if (!baseUrl) {
      displayLine(color('Tidak bisa memuat daftar model: base_url provider aktif kosong. Pakai /model <nama>.', ANSI.yellow))
      return
    }
    if (!interactive) {
      // Piped/non-TTY run: print the catalog instead of taking over the keyboard.
      const result = await fetchModels({ baseUrl, apiKey })
      if (!result.ok) { displayLine(color(`Gagal memuat model dari ${baseUrl} (${result.error}). Pakai /model <nama>.`, ANSI.yellow)); return }
      const groups = groupModelsByOwner(result.models)
      displayLine(`${formatModelCatalog(groups, { currentModel: agent.provider?.model || '' })}\n\nPakai /model <nama> untuk memilih.`)
      return
    }
    clearPromptArea()
    output.write('\r\x1b[2K')   // drop the readline prompt line left by the command echo
    // Claim the keyboard immediately: keys pressed while the gateway responds must not
    // turn into empty REPL lines (that used to redraw the prompt over the picker).
    state.modelPicker = { loading: true, groups: [], level: 'owner', ownerIndex: 0, modelIndex: 0, query: '', rows: 0 }
    out(color(`  Memuat model dari ${baseUrl} …\n`, ANSI.dim))
    const result = await fetchModels({ baseUrl, apiKey })
    if (!result.ok) {
      state.modelPicker = null
      out('\r\x1b[1A\x1b[J')
      displayLine(color(`Gagal memuat model dari ${baseUrl} (${result.error}). Pakai /model <nama> untuk manual.`, ANSI.yellow))
      return
    }
    const groups = groupModelsByOwner(result.models)
    state.modelPicker = createPickerState(groups)
    paintModelPicker()
  }

  function applyPickedModel(model) {
    const picker = state.modelPicker
    if (picker?.rows) output.write(`\r\x1b[${picker.rows}A\x1b[J`)
    output.write('\r\x1b[2K')
    state.modelPicker = null
    try { agent.setModel(model, false) } catch (error) {
      displayLine(color(`Gagal memasang model ${model}: ${error instanceof Error ? error.message : String(error)}`, ANSI.red))
      return
    }
    // displayLine redraws the prompt (and therefore the status bar) with the new model.
    displayLine(`${color('✔', ANSI.green)} model sesi: ${color(model, ANSI.bold)}\n  ${color('permanen? /model save ' + model, ANSI.dim)}`)
  }

  function handleModelPickerKey(text) {
    const picker = state.modelPicker
    if (!picker) return false
    if (picker.loading) {
      // Esc / Ctrl+C cancels the load; everything else waits for the model list.
      if (text === '\x1b' || text === '\x03') { state.modelPicker = null; out('\r\x1b[1A\x1b[J'); prompt() }
      return true
    }
    if (text === '\x1b[A' || text === '\x1bOA') { movePicker(picker, -1); paintModelPicker(); return true }
    if (text === '\x1b[B' || text === '\x1bOB') { movePicker(picker, 1); paintModelPicker(); return true }
    if (text === '\r' || text === '\n') {
      const outcome = enterPicker(picker)
      if (outcome.done) applyPickedModel(outcome.model)
      else paintModelPicker()
      return true
    }
    if (text === '\x1b' || text === '\x03') {
      const outcome = backPicker(picker)
      if (outcome.closed) closeModelPicker()
      else paintModelPicker()
      return true
    }
    if (text === '\x7f' || text === '\b') { backspacePicker(picker); paintModelPicker(); return true }
    if (/^[\x20-\x7e]+$/.test(text)) { typeInPicker(picker, text); paintModelPicker(); return true }
    return true
  }

  // ---- raw input: suggestion keys + bracketed paste folding ----
  const decoder = new StringDecoder('utf8')
  let pasteBuffer = null
  function foldPaste(text) {
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    if (!normalized.includes('\n')) return normalized
    const id = ++state.pasteSeq
    state.pastes.set(id, normalized)
    return `[Pasted text #${id} +${normalized.split('\n').length} lines]`
  }
  function filterPaste(text) {
    let rest = text
    let result = ''
    while (rest.length) {
      if (pasteBuffer === null) {
        const start = rest.indexOf('\x1b[200~')
        if (start === -1) { result += rest; break }
        result += rest.slice(0, start)
        rest = rest.slice(start + 6)
        pasteBuffer = ''
      } else {
        const end = rest.indexOf('\x1b[201~')
        if (end === -1) { pasteBuffer += rest; break }
        pasteBuffer += rest.slice(0, end)
        rest = rest.slice(end + 6)
        result += foldPaste(pasteBuffer)
        pasteBuffer = null
      }
    }
    return result
  }
  function onInputData(chunk) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    // While an approval is pending a single y / n / a keypress answers it immediately (no Enter needed).
    if (state.pendingApproval && pasteBuffer === null && /^[yna]$/i.test(text)) { enqueue({ line: text.toLowerCase(), generation: state.generation }); return }
    if (state.modelPicker && pasteBuffer === null) { handleModelPickerKey(text); return }
    if (pasteBuffer === null) {
      // Several arrow presses can arrive glued together in one chunk (key repeat): handle each one.
      const keys = /^(?:\x1b[\[O][AB])+$/.test(text) ? text.match(/\x1b[\[O][AB]/g) : [text]
      if (keys.every(handleSuggestKey)) return
    }
    const forwarded = filterPaste(text)
    if (forwarded) readerInput.write(forwarded)
  }
  function suspendInput() { if (interactive) { pasteMode(false); input.pause() } }
  function resumeInput() { if (interactive) { input.resume(); readerInput.resume?.(); pasteMode(true) } }
  function detachReader() {
    state.generation++
    state.rl?.close()
    state.rl = null
    state.statusRows = 0
    suspendInput()
  }
  function enqueue(item) {
    if (state.waiter) { const resolveLine = state.waiter; state.waiter = null; resolveLine(item) }
    else state.queue.push(item)
  }
  function attachReader() {
    const generation = ++state.generation
    const rl = createInterface({ input: readerInput, output, terminal: interactive, history: loadHistory(), historySize: 500 })
    state.rl = rl
    const onKey = () => scheduleSuggest()
    if (interactive) readerInput.on('keypress', onKey)
    rl.on('line', raw => {
      state.sugRows = 0
      const line = raw.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (match, id) => state.pastes.get(Number(id)) ?? match)
      saveHistory(raw)
      enqueue({ line, raw, generation })
    })
    rl.on('close', () => {
      readerInput.off('keypress', onKey)
      unlockInputEcho()
      if (state.generation === generation) enqueue({ eof: true, generation })
    })
    rl.on('SIGINT', () => {
      if (state.busy) { enqueue({ line: '/stop', generation }); return }
      if (rl.line) { rl.write(null, { ctrl: true, name: 'u' }); scheduleSuggest(); return }
      const now = Date.now()
      if (now - state.lastSigint < 2000) { enqueue({ line: '/exit', synthetic: true, generation }); return }
      state.lastSigint = now
      displayLine(color('Press Ctrl+C again to exit.', ANSI.dim))
    })
    resumeInput()
    prompt()
  }
  /**
   * Hidden token entry without `stty`: raw-mode keypresses work on Windows, macOS,
   * Linux and Termux alike. Returns a Promise so callers await it.
   */
  async function readHiddenToken() {
    if (!input.isTTY || !output.isTTY) return { error: 'Hidden token entry requires an interactive terminal.' }
    detachReader()
    input.off('data', onInputData)
    try {
      return await new Promise(resolveToken => {
        let token = ''
        let settled = false
        const finish = result => {
          if (settled) return
          settled = true
          input.off('keypress', onKey)
          try { input.setRawMode(false) } catch {}
          input.pause()
          output.write('\n')
          resolveToken(result)
        }
        const onKey = (text, key = {}) => {
          if (key.ctrl && key.name === 'c') return finish({ error: 'Token entry cancelled.' })
          if (key.name === 'return' || key.name === 'enter' || text === '\r' || text === '\n') {
            return finish(token ? { value: token } : { error: 'Empty token not saved.' })
          }
          if (key.name === 'backspace') { token = Array.from(token).slice(0, -1).join(''); return }
          if (key.ctrl && key.name === 'u') { token = ''; return }
          if (text && !key.ctrl && token.length + text.length <= 512) token += text
        }
        emitKeypressEvents(input)
        input.setRawMode(true)
        input.on('keypress', onKey)
        input.resume()
        output.write('9router API token (input hidden): ')
      })
    } finally {
      input.on('data', onInputData)
      attachReader()
    }
  }
  function nextLine() {
    if (state.queue.length) return Promise.resolve(state.queue.shift())
    if (state.ended) return Promise.resolve({ eof: true })
    return new Promise(resolveLine => { state.waiter = resolveLine })
  }
  function settleApproval(allowed) {
    const pending = state.pendingApproval
    if (!pending) return
    state.pendingApproval = null
    clearTimeout(pending.timer)
    // Wipe the approval box so the chat stays clean, but only if nothing else was printed under it meanwhile.
    const box = state.approvalBox
    state.approvalBox = null
    if (box && interactive && state.busy && box.seq === state.printSeq) {
      output.write(`\r\x1b[${box.rows}A\x1b[J`)
      state.robotVisible = false
    }
    pending.resolve(allowed)
    refreshStatus()
  }
  function askApproval(request) {
    const mode = core.approvalMode(agent.config?.agentApproval)
    const server = core.mcpServerFromTool(request.name)
    const trusted = server ? agent.config?.mcpServers?.[server]?.trusted === true : false
    // A big edit shows its diff before it lands, even when the mode would not ask —
    // unless the mode is 'off' (/auto on), where the user asked for no gates at all.
    const bigPreview = bigEditPreview(request, { interactive })
    const required = core.requiresApproval({ name: request.name, args: request.args }, mode, trusted)
    if (!shouldAskApproval({ mode, required, bigPreview })) return Promise.resolve(true)
    if (server && core.isMcpApproved(agent.getSessionId(), server)) return Promise.resolve(true)
    const key = approvalKey(request)
    const canAlways = interactive && !isRiskyTerminal(request)
    if (!bigPreview && canAlways && state.sessionAllow.has(key)) return Promise.resolve(true)
    if (state.pendingApproval) return Promise.resolve(false)
    return new Promise(resolveApproval => {
      const timer = setTimeout(() => {
        settleApproval(false)
        displayLine('Approval timeout; tool denied.')
      }, options.approvalTimeoutMs || 5 * 60_000)
      state.pendingApproval = { resolve: resolveApproval, timer, server, name: request.name, key, canAlways }
      showRobot('APPROVAL')
      if (interactive) {
        setTitle('VallenEmperor · approval needed')
        output.write('\x07')
        const isTerminal = request.name === 'terminal'
        const preview = bigPreview || editPreviewFor(request)
        const details = isTerminal ? [] : summarizeArgs(preview ? stripEditArgs(request.args) : request.args)
        if (bigPreview) details.push(['size', `${bigPreview.added}+ / ${bigPreview.removed}- lines · big edit, diff shown first`])
        const box = formatApprovalBox({
          name: request.name,
          command: isTerminal ? String(request.args.command || '').slice(0, 1200) : '',
          server: server || '',
          details,
          preview,
          canAlways
        }, boxWidth())
        displayLine(box)
        state.approvalBox = { rows: box.split('\n').length, seq: state.printSeq }
      } else displayLine(`Allow tool ${request.name}? [y/N]${request.name === 'terminal' ? `\nCommand: ${String(request.args.command || '').slice(0, 1200)}` : ''}`)
    })
  }
  // One rendered block for a finished tool call (edit result, compact line, full card, or plain text when non-interactive).
  function renderToolEnd(tool, { callText, text, durationMs, failed }) {
    const width = boxWidth()
    if (['patch', 'write_file'].includes(tool.name)) return formatFileEditResult(tool.name, tool.args, tool.result, { durationMs, width })
    if (!interactive) return colorizeDiff(text)
    const hasHunks = /^\s*@@ /m.test(stripAnsi(String(text || '')))
    if (!verboseTools && !failed && !hasHunks) return formatToolLine(callText, text, { durationMs, width })
    return `${verboseTools ? '' : `${formatToolCall(callText, { width })}\n`}${formatToolResult(text, { error: failed, durationMs, width })}`
  }

  function printResponse(text, { markdown = false, footer = '' } = {}) {
    const width = boxWidth()
    if (interactive) displayLine(formatResponseCard(String(text || ''), ' ☤ VallenEmperor CLI ', width, { markdown, footer }))
    else displayLine(core.formatResponseBox(String(text || ''), ' ☤ VallenEmperor CLI ', width))
  }
  // Streamed answer text is rendered line by line into one framed card; any tool output closes the card first.
  function pushStream(piece) {
    if (!state.stream) state.stream = createCardStream({ title: ' ☤ VallenEmperor CLI ', width: boxWidth(), write: displayLine })
    state.stream.push(piece)
  }
  function closeStream(footer = '') {
    if (!state.stream) return
    const stream = state.stream
    state.stream = null
    stream.end(footer)
  }
  // "4.2s · 3 tools · 18k ctx" shown in the bottom edge of the final answer card.
  function turnFooter() {
    if (!state.turnStartedAt) return ''
    return [fmtDuration(Date.now() - state.turnStartedAt), state.turnToolCalls ? `${state.turnToolCalls} tool${state.turnToolCalls === 1 ? '' : 's'}` : '', state.lastTokens > 0 ? `${fmtTokens(state.lastTokens)} ctx` : ''].filter(Boolean).join(' · ')
  }
  function noteTokens() {
    try { state.lastTokens = Number(agent.getContextStats?.()?.promptTokens) || state.lastTokens } catch {}
  }

  // --quiet/--no-banner: skip the startup box (and its network health probe) so
  // scripted or embedded runs get clean output.
  if (!options.quiet) {
    out(`${startupBox(agent, bannerText, await healthCheck(agent, state.mcpServers), output.columns || 80, { fancy: interactive && supportsAnsi, compact: compactUi })}\n`)
    if (interactive && !compactUi) out(`${formatTip()}\n`)
  }
  if (interactive) { if (supportsAnsi) output.write('\x1b[22;0t'); setTitle('VallenEmperor') }
  state.started = true
  if (interactive) {
    // readline reads from a proxy so the dropdown keys (Tab/arrows/Esc/Enter) and bracketed paste can be handled first.
    const proxy = new PassThrough()
    proxy.isTTY = true
    proxy.setRawMode = mode => { if (typeof input.setRawMode === 'function') input.setRawMode(mode); return proxy }
    readerInput = proxy
    input.on('data', onInputData)
    process.once('exit', resetPasteMode)
  }
  refreshStatus()
  attachReader()

  async function runTurn(message, displayMessage = message) {
    state.turnStartedAt = Date.now()
    state.thinkingFaceIndex = Math.floor(Math.random() * THINKING_FACES.length)
    state.thinkingVerbIndex = Math.floor(Math.random() * THINKING_VERBS.length)
    state.busy = true
    state.turns++
    state.streamedChars = 0
    state.turnToolCalls = 0
    setTitle('VallenEmperor · working…')
    lockInputEcho()
    if (!interactive) renderChatBox(displayMessage)
    refreshStatus('THINKING')
    state.activeTurn = (async () => {
      try {
        const result = await agent.runTurn({ message, surfaceId: 'vallenemperor' }, {
          requestApproval: request => askApproval(request),
          onEvent: event => {
            if (interactive && DELTA_EVENTS.has(event.type)) {
              const piece = event.text ?? event.delta ?? event.content ?? event.chunk
              if (typeof piece === 'string' && piece) { state.streamedChars += piece.length; pushStream(piece) }
              return
            }
            if (event.type === 'thinking') refreshStatus('THINKING')
            else if (event.type === 'tool_start') {
              closeStream()
              const args = event.tool.args || {}
              const target = String(args.path || args.file_path || args.command || args.query || args.pattern || args.name || '')
              showRobot(`WORKING · ${event.tool.name}${target ? ` · ${target}` : ''}`)
              const text = event.tool.preview || core.formatToolStart(event.tool.name, event.tool.args)
              state.toolCalls++
              state.turnToolCalls++
              state.toolStarts.set(toolKey(event.tool), Date.now())
              state.toolCallText.set(toolKey(event.tool), text)
              if (!interactive) displayLine(text)
              else if (verboseTools) displayLine(formatToolCall(text, { width: boxWidth() }))
            } else if (event.type === 'tool_end') {
              closeStream()
              const startedAt = state.toolStarts.get(toolKey(event.tool))
              const terminalOutputShown = event.tool.name === 'terminal' && flushTerminalChunk(toolKey(event.tool), event.tool, startedAt ? Date.now() - startedAt : 0)
              const callText = state.toolCallText.get(toolKey(event.tool)) || String(event.tool.name || 'tool')
              state.toolCallText.delete(toolKey(event.tool))
              state.toolStarts.delete(toolKey(event.tool))
              const failed = hasToolError(event.tool.result)
              if (failed) state.toolErrors++
              if (event.tool.name === 'shell' && String(toolError(event.tool.result)).includes('Tool not found')) displayLine('Unsupported tool "shell". Use "terminal" instead.')
              else if (!terminalOutputShown && (event.tool.name !== 'skill_view' || failed)) {
                const text = event.tool.preview || core.formatToolEnd(event.tool.name, event.tool.args, event.tool.result)
                const durationMs = startedAt ? Date.now() - startedAt : 0
                displayLine(renderToolEnd(event.tool, { callText, text, durationMs, failed }))
              }
              showRobot('THINKING')
            } else if (event.type === 'terminal_output') captureTerminalOutput(event.output)
            else if (event.type === 'review_complete') displayLine(event.summary)
            else if (event.type === 'review_error') displayLine(color(`Review error: ${event.error}`, ANSI.yellow))
            else if (event.type === 'review_skipped') { if (interactive) displayLine(`💾 review: ${event.reason}`) }
            else if (event.type === 'telemetry') { noteTokens(); refreshStatus('WORKING') }
          }
        })
        const streamed = state.streamedChars > 0
        const footer = turnFooter()
        closeStream(footer)
        if (result.completionStatus === 'incomplete') displayLine(color('Turn incomplete; check remaining work and errors above.', ANSI.yellow))
        if (!streamed) printResponse(result.response, { markdown: true, footer })
        if (result.artifacts?.summary) displayLine(result.artifacts.summary)
      } catch (error) {
        closeStream()
        displayLine(color(`Agent error: ${error instanceof Error ? error.message : String(error)}`, ANSI.red))
      } finally {
        stopThinkingTicker()
        if (interactive && state.turnStartedAt && Date.now() - state.turnStartedAt > 20_000) { output.write('\x07'); if (process.env.VALLEN_OSC9 === '1') output.write('\x1b]9;VallenEmperor: turn finished\x07') }
        state.streamedChars = 0
        state.toolStarts.clear()
        invalidateGit()
        setTitle('VallenEmperor')
        state.turnStartedAt = 0
        state.busy = false
        state.activeTurn = null
        unlockInputEcho()
        refreshStatus()
      }
    })()
  }

  async function enterShell() {
    const spec = core.interactiveShell?.() || {
      command: process.env.SHELL || (platform() === 'win32' ? 'cmd.exe' : '/bin/sh'),
      args: platform() === 'win32' ? [] : ['-i']
    }
    detachReader()
    write(output, `Entering ${spec.command}; type exit to return to VallenCLI.`)
    await new Promise(resolveShell => {
      const child = spawn(spec.command, spec.args, { cwd: agent.config?.terminal?.cwd || process.cwd(), stdio: 'inherit' })
      child.once('error', error => { write(output, `Shell error: ${error.message}`); resolveShell() })
      child.once('exit', (code, signal) => { write(output, `Shell closed (${signal || (code ?? 0)}).`); resolveShell() })
    })
    attachReader()
    refreshStatus()
  }

  const localCommand = createLocalCommandHandler({ agent, core, state, output, printResponse, readHiddenToken, settleApproval, enqueue, out, refreshStatus, healthCheck, enterShell, runTurn, displayLine })

  try {
    for (;;) {
      const item = await nextLine()
      if (item?.eof) { state.ended = true; break }
      if (item?.generation !== state.generation && !state.rl) continue
      const text = safeInput(item.line).trim()
      if (interactive && !state.busy) {
        // Wipe status line + typed input (+ dropdown); keep only the message itself in the chat history.
        if (item.synthetic) clearPromptArea()
        else if (state.statusRows) {
          output.write(chatBoxRedrawSequence(item.raw ?? item.line, termWidth(), state.statusRows))
          state.statusRows = 0
          const shown = safeInput(item.raw ?? item.line).trim()
          if (shown) out(`${formatUserMessage(shown, boxWidth())}\n`)
        }
      }
      state.pastes.clear()
      if (!text) { if (!state.busy) prompt(); continue }
      const command = text.split(/\s+/, 1)[0].toLowerCase()
      const isSlashCommand = /^\/[a-z][\w-]*$/.test(command) // "/home/me/app" is a path, not a command
      if (command === '/exit' || command === '/quit') { await localCommand('/exit'); continue }
      if (command === '/stop' && state.busy) { await localCommand('/stop'); continue }
      if (state.pendingApproval) {
        const pending = state.pendingApproval
        const answer = text.toLowerCase()
        const yes = /^(?:y|yes)$/.test(answer)
        const always = pending.canAlways && /^(?:a|always)$/.test(answer)
        if (yes || always) {
          if (always) state.sessionAllow.add(pending.key)
          settleApproval(true)
          if (pending.server) core.rememberMcpApproval(agent.getSessionId(), pending.server)
        } else if (/^(?:n|no)$/.test(answer)) settleApproval(false)
        else displayLine(pending.canAlways ? 'Reply y, a (always this session) or n to approve; /stop interrupts turn.' : 'Reply y or n to approve; /stop interrupts turn.')
        continue
      }
      if (state.busy) { displayLine('Agent busy; use /stop or wait for the current turn.'); continue }
      if (text.startsWith('/') && isSlashCommand) {
        try {
          // `/model` alone opens the live provider → model picker; `/model <name>` stays a direct switch.
          if (/^\/model\s*$/i.test(text)) { await openModelPicker(); continue }
          if (await localCommand(text)) continue
          const shared = await sharedCommand?.({
            channel: 'terminal',
            agent,
            // /review lives in core; the CLI only supplies where its result is shown.
            reviewCallbacks: {
              onReviewComplete: message => displayLine(message),
              onReviewError: error => displayLine(`Review error: ${error}`)
            }
          }, text)
          if (shared?.handled) {
            printResponse(shared.response)
            // Commands that change session/model/cwd now live in core, so the status
            // bar has to be refreshed here instead of inside a local handler.
            if (interactive) refreshStatus()
            continue
          }
          printResponse(`Unknown command: ${text.split(/\s+/, 1)[0]}. Use /help.`)
        } catch (error) { displayLine(color(`Command error: ${error instanceof Error ? error.message : String(error)}`, ANSI.red)) }
        continue
      }
      await runTurn(text)
    }
  } finally {
    state.closing = true
    if (state.pendingApproval) settleApproval(false)
    if (state.busy) agent.interrupt()
    await state.activeTurn
    if (interactive && (state.turns > 0 || state.toolCalls > 0)) {
      let stats = {}
      try { stats = agent.getContextStats?.() || {} } catch {}
      let sessionId = ''
      try { sessionId = agent.getSessionId?.() || '' } catch {}
      out(`\n${formatSessionSummary({ model: agent.provider?.model || '', sessionId, startedAt: state.sessionStartedAt, turns: state.turns, toolCalls: state.toolCalls, toolErrors: state.toolErrors, percent: Number(stats.percent) || 0, width: boxWidth() })}\n`)
    }
    if (interactive && supportsAnsi) output.write('\x1b[23;0t')
    // Real cleanup: closes MCP transports and child processes. The old shutdownMcp?.() call
    // never existed on AIAgent, so MCP servers were left running after the CLI exited.
    try { await agent.shutdown?.() } catch {}
    if (state.sugTimer) clearImmediate(state.sugTimer)
    if (interactive) {
      input.off('data', onInputData)
      input.pause()
      resetPasteMode()
      process.off('exit', resetPasteMode)
    }
  }
  return { agent, state }
}

const APPROVAL_MODES = new Set(['dangerous', 'all', 'off'])

/** `vallenemperor config ...` — provider presets and validation without editing JSON by hand. */
function parseConfigArgs(args) {
  const base = { mode: 'config', configAction: null, provider: null, configModel: null, configApproval: null, error: null }
  const [action, key, value] = args
  const usage = 'Usage: vallenemperor config show | config set provider <preset> | config set model <name> | config set approval <mode>'
  if (!action || action === 'show') return { ...base, configAction: 'show' }
  if (action !== 'set') return { ...base, mode: 'error', error: `Unknown config action: ${action}. ${usage}` }
  if (key === 'provider') {
    if (!value) return { ...base, mode: 'error', error: 'config set provider needs a preset name.' }
    return { ...base, configAction: 'set-provider', provider: String(value) }
  }
  if (key === 'model') {
    if (!value) return { ...base, mode: 'error', error: 'config set model needs a model name.' }
    return { ...base, configAction: 'set-model', configModel: String(value) }
  }
  if (key === 'approval') {
    if (!APPROVAL_MODES.has(String(value))) return { ...base, mode: 'error', error: `config set approval must be one of dangerous, all, off (got ${value || 'nothing'}).` }
    return { ...base, configAction: 'set-approval', configApproval: String(value) }
  }
  return { ...base, mode: 'error', error: `Unknown config key: ${key || '(nothing)'}. ${usage}` }
}

/**
 * Explicit startup-argument parser. Unknown flags are an error instead of being
 * silently ignored and dropping into the REPL.
 *
 *   vallenemperor                    → REPL
 *   vallenemperor -p "prompt"        → one-shot, prints the answer, exits
 *   vallenemperor --resume [id]      → resume the last (or the given) session
 *   --approval dangerous|all|off     → approval override for this run
 *   --model <name>                   → model override for this run
 */
export function parseArgs(argv) {
  const result = { mode: 'run', prompt: null, resumeId: null, approval: null, model: null, json: false, quiet: false, error: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index])
    if (arg === '--help' || arg === '-h') return { ...result, mode: 'help' }
    if (arg === '--version' || arg === '-v' || arg === '-versi') return { ...result, mode: 'version' }
    if (arg === '--json') { result.json = true; continue }
    if (arg === '--quiet' || arg === '--no-banner') { result.quiet = true; continue }
    if (arg === '-p' || arg === '--prompt') {
      const value = argv[index + 1]
      if (!value || String(value).startsWith('-')) return { ...result, mode: 'error', error: `${arg} needs a prompt value. See --help.` }
      result.prompt = String(value)
      result.mode = 'prompt'
      index++
      continue
    }
    if (arg === '--resume' || arg === '-r') {
      const value = argv[index + 1]
      result.mode = 'resume'
      if (value && !String(value).startsWith('-')) { result.resumeId = String(value); index++ }
      continue
    }
    if (arg === '--approval') {
      const value = String(argv[index + 1] || '')
      if (!APPROVAL_MODES.has(value)) return { ...result, mode: 'error', error: `--approval must be one of dangerous, all, off (got ${value || 'nothing'}). See --help.` }
      result.approval = value
      index++
      continue
    }
    if (arg === '--model' || arg === '-m') {
      const value = argv[index + 1]
      if (!value || String(value).startsWith('-')) return { ...result, mode: 'error', error: `${arg} needs a model name. See --help.` }
      result.model = String(value)
      index++
      continue
    }
    if (arg === 'config') return parseConfigArgs(argv.slice(index + 1))
    if (arg === 'run') continue
    return { ...result, mode: 'error', error: arg.startsWith('-') ? `Unknown option: ${arg}. See --help.` : `Unknown argument: ${arg}. See --help.` }
  }
  return result
}

/** Apply a `config` subcommand against config.json; returns a process exit code. */
export async function runConfigCommand(core, parsed) {
  if (parsed.configAction === 'show') {
    const config = core.loadConfig()
    const active = config.providers?.active
    const provider = config.providers?.[active]
    const model = provider && typeof provider === 'object' ? provider.model : undefined
    const baseUrl = provider && typeof provider === 'object' ? provider.base_url : undefined
    const hasKey = Boolean(provider && typeof provider === 'object' && provider.api_key)
    console.log(`active provider: ${active}${model ? ` · model ${model}` : ''}`)
    console.log(`base_url: ${baseUrl || '(unset)'}`)
    console.log(`api_key: ${hasKey ? 'set in config.json' : 'not set (use the provider env var)'}`)
    console.log(`approval: ${core.approvalMode(config.agentApproval)}`)
    const report = core.validateProviderConfig(config)
    for (const warning of report.warnings) console.log(`warning: ${warning}`)
    for (const error of report.errors) console.error(`error: ${error}`)
    return report.ok ? 0 : 2
  }

  if (parsed.configAction === 'set-provider') {
    const name = String(parsed.provider)
    const presets = core.PROVIDER_PRESETS || {}
    if (!presets[name]) {
      console.error(`Unknown provider preset "${name}". Known: ${Object.keys(presets).join(', ')}`)
      return 2
    }
    // Keys live in the environment: never persist them into config.json.
    const preset = core.providerPresetConfig(name, { api_key: '' })
    core.saveConfig({ providers: { active: name, [name]: preset } })
    console.log(`provider ${name} is now active · ${preset.base_url} · model ${preset.model}`)
    console.log(presets[name].env_key ? `API key: set ${presets[name].env_key} in the environment (never written to config.json).` : 'This provider needs no API key.')
    const report = core.validateProviderConfig(core.loadConfig())
    for (const warning of report.warnings) console.log(`warning: ${warning}`)
    for (const error of report.errors) console.error(`error: ${error}`)
    return report.ok ? 0 : 2
  }

  if (parsed.configAction === 'set-model') {
    const config = core.loadConfig()
    const active = config.providers?.active
    if (!active || !config.providers?.[active] || typeof config.providers[active] === 'string') {
      console.error(`No active provider to set a model on (providers.active = ${JSON.stringify(active)}). Run: vallenemperor config set provider <preset>`)
      return 2
    }
    core.saveConfig({ providers: { [active]: { model: String(parsed.configModel) } } })
    console.log(`model for ${active}: ${parsed.configModel}`)
    return 0
  }

  if (parsed.configAction === 'set-approval') {
    // Everything reads config.agentApproval; writing `approval` here used to be a no-op.
    core.saveConfig({ agentApproval: parsed.configApproval })
    console.log(`approval mode: ${parsed.configApproval}`)
    return 0
  }

  console.error('Unknown config action.')
  return 2
}

/**
 * One-shot runs have no approval UI, and `runTurn` only installs the approval gate
 * when a `requestApproval` callback exists — so before this, `--approval
 * off|dangerous|all` were all equivalent to "run everything silently".
 * A scripted run cannot ask a human, so it refuses the risky call and says how to
 * allow it. `--approval off` still means "allow everything" (explicit opt-in).
 */
export function createOneShotApproval(core, agent, { onBlocked } = {}) {
  const mode = core.approvalMode(agent.config?.agentApproval)
  const denied = []
  const requestApproval = async request => {
    const server = core.mcpServerFromTool?.(request.name) || null
    const trusted = server ? agent.config?.mcpServers?.[server]?.trusted === true : false
    if (!core.requiresApproval({ name: request.name, args: request.args }, mode, trusted)) return true
    if (server && core.isMcpApproved?.(agent.getSessionId(), server)) return true
    denied.push(String(request.name))
    onBlocked?.(request.name, mode)
    return false
  }
  return { requestApproval, denied }
}

/** One-shot run: send one prompt, print the answer, shut down. */
async function runOneShot(agent, prompt, { core } = {}) {
  const gate = core
    ? createOneShotApproval(core, agent, {
        onBlocked: (name, mode) => process.stderr.write(`Blocked risky tool "${name}" (approval mode: ${mode}, no approval prompt in one-shot mode). Re-run with --approval off to allow it.\n`)
      })
    : { requestApproval: undefined, denied: [] }
  const result = await agent.runTurn({ message: prompt, surfaceId: 'cli' }, { requestApproval: gate.requestApproval })
  process.stdout.write(`${String(result.response || '').trim()}\n`)
  if (result.artifacts?.summary) process.stdout.write(`${result.artifacts.summary}\n`)
  return { result, denied: gate.denied }
}

// "/help" is a command; "/home/me/app" is a path, so the token must end here.
const SLASH_LINE = /^\/[a-z][\w-]*(?:\s|$)/i

export function isSlashCommandLine(text) {
  return SLASH_LINE.test(String(text || '').trim())
}

/**
 * `-p` used to forward anything starting with "/" straight to the model, which then
 * invented command output. Dispatch the real CLI/shared handlers instead.
 */
export async function runOneShotCommand(core, agent, text, io = {}) {
  const out = io.out || process.stdout
  const err = io.err || process.stderr
  const line = String(text || '').trim()
  const cmd = line.split(/\s+/, 1)[0].toLowerCase()
  if (cmd === '/exit' || cmd === '/quit') {
    out.write(io.json ? `${JSON.stringify({ command: cmd, handled: true, exiting: true })}\n` : 'Session ending.\n')
    return 0
  }
  if (cmd === '/help') {
    const help = core.handleCommand ? String((await core.handleCommand({ channel: 'terminal', agent }, '/help'))?.response || HELP) : HELP
    out.write(io.json ? `${JSON.stringify({ command: cmd, handled: true, help })}\n` : `${help}\n`)
    return 0
  }
  // Telemetry is the one thing scripts need in a stable shape.
  if (io.json && ['/stats', '/status', '/context'].includes(cmd)) {
    const telemetry = core.contextTelemetry?.(agent)
    if (telemetry) { out.write(`${JSON.stringify(telemetry)}\n`); return 0 }
  }
  let shared
  try {
    shared = await core.handleCommand?.({ channel: 'terminal', agent }, line)
  } catch (error) {
    err.write(`Command error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (shared?.handled) {
    const response = String(shared.response || '').trim()
    out.write(io.json ? `${JSON.stringify({ command: cmd, handled: true, response })}\n` : `${response}\n`)
    return 0
  }
  // Some commands only exist in the interactive REPL because they need its state
  // (readline, approval, output buffer). Say that instead of "unknown command".
  if (findCommand(cmd)) {
    err.write(`${cmd} hanya tersedia di REPL interaktif: jalankan \`vallenemperor\` tanpa -p.\n`)
    return 2
  }
  err.write(`Unknown command: ${cmd}. Use --help.\n`)
  return 2
}

/**
 * `--approval` used to write `config.approval`, but every surface reads
 * `config.agentApproval` (that is what `/auto` writes), so the flag was dead.
 * Keep both keys in sync so either reader sees the override.
 */
export function applyRuntimeOverrides(config, parsed = {}) {
  if (parsed.approval) {
    config.agentApproval = parsed.approval
    config.approval = parsed.approval
  }
  if (parsed.model) {
    const active = config.providers?.active
    if (active && config.providers?.[active]) config.providers[active].model = parsed.model
  }
  return config
}

export function createCliAgent(core, options = {}) {
  const backgroundReview = options.backgroundReview ?? options.config?.gateway?.background_review ?? true
  return new core.AIAgent({ ...options, backgroundReview })
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'help') {
    console.log(HELP)
    // The command reference lives in core so `--help`, `/help` and `-p "/help"` cannot drift.
    try {
      const core = await import(pathToFileURL(CORE_PATH).href)
      const reference = String((await core.handleCommand({ channel: 'terminal', agent: undefined }, '/help'))?.response || '')
      if (reference) console.log(`\n${reference}`)
    } catch { /* core not built yet: the flag help is still useful on its own */ }
    return 0
  }
  if (parsed.mode === 'error') { console.error(parsed.error); return 2 }
  // Version comes from the published package root; vallencli is a private workspace
  // and its own version lags behind the release tag.
  const version = (() => {
    for (const candidate of [join(ROOT, 'package.json'), join(ROOT, 'vallencli', 'package.json')]) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
        if (parsed?.version) return String(parsed.version)
      } catch { /* try the next candidate */ }
    }
    return '0.0.0'
  })()

  if (parsed.mode === 'version') { console.log(`vallenemperor v${version}`); return 0 }
  if (!existsSync(CORE_PATH)) {
    console.error('VallenAgent core build missing. Run: npm -w vallenagent run build')
    return 1
  }
  try {
    const core = await import(pathToFileURL(CORE_PATH).href)
    const config = core.loadConfig()
    applyRuntimeOverrides(config, parsed)
    const createAgent = options => createCliAgent(core, { ...options, config })

    if (parsed.mode === 'config') return await runConfigCommand(core, parsed)

    if (parsed.mode === 'prompt') {
      const agent = createAgent({})
      try {
        // Slash input must never reach the model: it used to answer as if it were the CLI.
        if (isSlashCommandLine(parsed.prompt)) return await runOneShotCommand(core, agent, parsed.prompt, { json: parsed.json })
        const { result, denied } = await runOneShot(agent, parsed.prompt, { core })
        // A blocked tool means the requested work did not happen; report that to the shell.
        if (denied.length) return 1
        return result?.completionStatus === 'incomplete' ? 1 : 0
      } finally {
        try { await agent.shutdown?.() } catch {}
      }
    }

    const result = await runCli({
      core,
      createAgent,
      quiet: parsed.quiet,
      resumeSessionId: parsed.mode === 'resume' ? parsed.resumeId : null,
      resumeLatest: parsed.mode === 'resume' && !parsed.resumeId
    })
    return 0
  } catch (error) {
    console.error(`VallenCLI failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// npm installs the bin as a symlink (node_modules/.bin/vallenemperor), so compare real paths:
// a plain resolve() comparison leaves the CLI silently doing nothing when run from a global install.
function invokedAsCli() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  }
}

if (invokedAsCli()) {
  process.exitCode = await main()
}
