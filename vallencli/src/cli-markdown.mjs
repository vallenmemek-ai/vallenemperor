// Terminal markdown renderer + framed response card (streaming-friendly: feed it lines as they arrive).
import { stringWidth, stripAnsi, clipWidth, clipEllipsis } from './cli-ui.mjs'
import { fg, bg, FG_OFF, BG_OFF, getColorLevel, gradientText } from './cli-theme.mjs'

const lvl = () => getColorLevel()
const sgr = code => (lvl() === 0 ? '' : code)
const B = ['\x1b[1m', '\x1b[22m']
const I = ['\x1b[3m', '\x1b[23m']
const U = ['\x1b[4m', '\x1b[24m']
const S = ['\x1b[9m', '\x1b[29m']
const D = ['\x1b[2m', '\x1b[22m']
const tone = (text, role) => `${fg(role)}${text}${FG_OFF}`
// Clickable links (OSC 8): real colour terminals only, http(s)/file/mailto only, never with control characters.
const linksOn = () => lvl() > 0 && Boolean(process.stdout.isTTY) && process.env.VALLEN_LINKS !== '0'
const safeHref = href => { const h = String(href || '').replace(/[\x00-\x1f\x7f]/g, ''); return /^(https?:|file:|mailto:)/i.test(h) ? h : '' }

function styled(text, s = {}) {
  if (lvl() === 0) return text
  let open = ''
  let close = ''
  if (s.b) { open += B[0]; close = B[1] + close }
  if (s.i) { open += I[0]; close = I[1] + close }
  if (s.s) { open += S[0]; close = S[1] + close }
  if (s.q) { open += D[0]; close = D[1] + close }
  if (s.u) { open += U[0] + fg('primary'); close = FG_OFF + U[1] + close }
  const href = s.href && linksOn() ? safeHref(s.href) : ''
  if (href) { open = `\x1b]8;;${href}\x1b\\` + open; close += '\x1b]8;;\x1b\\' }
  if (s.c) { open += (lvl() >= 2 ? bg('panel') : '') + fg('accent'); close = FG_OFF + (lvl() >= 2 ? BG_OFF : '') + close }
  return open + text + close
}

// ---------- inline ----------
const INLINE_SOURCE = String.raw`(` + '`' + String.raw`+)([^` + '`' + String.raw`]|[^` + '`' + String.raw`][\s\S]*?[^` + '`' + String.raw`])\1(?!` + '`' + String.raw`)|\*\*([^\s*][\s\S]*?)\*\*|__([^\s_][\s\S]*?)__|~~([^\s~][\s\S]*?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])|\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()\x00-\x1f\x7f]*[^\s<>().,;:!?'"\x00-\x1f\x7f])`

export function inlineSegments(text, base = {}) {
  const re = new RegExp(INLINE_SOURCE, 'g')
  const segs = []
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ ...base, text: text.slice(last, m.index) })
    if (m[2] !== undefined) segs.push({ ...base, text: m[2], c: true })
    else if (m[3] !== undefined) segs.push(...inlineSegments(m[3], { ...base, b: true }))
    else if (m[4] !== undefined) segs.push(...inlineSegments(m[4], { ...base, b: true }))
    else if (m[5] !== undefined) segs.push(...inlineSegments(m[5], { ...base, s: true }))
    else if (m[6] !== undefined) segs.push(...inlineSegments(m[6], { ...base, i: true }))
    else if (m[7] !== undefined) segs.push(...inlineSegments(m[7], { ...base, i: true }))
    else if (m[8] !== undefined) {
      segs.push(...inlineSegments(m[8], { ...base, u: true, href: m[9] }))
      if (m[9] !== m[8] && !m[9].startsWith('#')) segs.push({ ...base, text: ` (${m[9]})`, q: true })
    }
    else if (m[10] !== undefined) segs.push({ ...base, text: m[10], u: true, href: m[10] })
    last = re.lastIndex
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) })
  return segs
}

function toAtoms(segs) {
  const atoms = []
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (!part) continue
      atoms.push(/^\s+$/.test(part) ? { space: true, style: seg } : { text: part, style: seg })
    }
  }
  return atoms
}

// Word-wrap styled atoms; first/rest are already-styled line prefixes.
function wrapAtoms(atoms, width, first = '', rest = '') {
  const lines = []
  let prefix = first
  let line = ''
  let w = stringWidth(first)
  let pending = null
  const flush = () => { lines.push(prefix + line); prefix = rest; line = ''; w = stringWidth(rest); pending = null }
  for (const atom of atoms) {
    if (atom.space) { if (line) pending = atom; continue }
    let text = atom.text
    for (;;) {
      const gap = pending && line ? 1 : 0
      const tw = stringWidth(text)
      if (w + gap + tw <= width) {
        if (gap) line += styled(' ', pending.style)
        line += styled(text, atom.style)
        w += gap + tw
        pending = null
        break
      }
      if (line) { flush(); continue }
      const chunk = clipWidth(text, Math.max(1, width - w)) || Array.from(text)[0]
      line += styled(chunk, atom.style)
      text = text.slice(chunk.length)
      flush()
      if (!text) break
    }
  }
  if (line || !lines.length) lines.push(prefix + line)
  return lines
}

// ---------- code highlighting ----------
const KEYWORDS = new Set(('const let var function return if else for while do class import export from default async await new try catch throw switch case break continue typeof instanceof of in extends super this yield static ' +
  'func package type struct interface map chan go defer range select fallthrough goto ' +
  'def lambda pass with as raise except finally elif not and or is del global nonlocal assert ' +
  'fn pub mut impl trait use mod enum match loop where ' +
  'then fi done esac echo local readonly ' +
  'public private protected void int string bool boolean float double char long final abstract ' +
  'null nil None true false True False undefined').split(/\s+/))
const HASH_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'py', 'python', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'dockerfile', 'makefile', 'conf', 'ini', 'env'])
const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'log', 'output', 'console', 'tree', 'ascii'])
const SLASH_RE = /(\/\/.*$|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)(\s*\()?/g
const HASH_RE = /(#.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)(\s*\()?/g
const JSON_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d[\d.eE+-]*\b)|\b(true|false|null)\b/g

export function highlightCode(text, lang = '') {
  const l = String(lang).toLowerCase()
  if (lvl() === 0 || PLAIN_LANGS.has(l)) return text
  if (l === 'diff' || l === 'patch') {
    if (/^\+(?!\+\+)/.test(text)) return tone(text, 'ok')
    if (/^-(?!--)/.test(text)) return tone(text, 'err')
    if (/^@@/.test(text)) return tone(text, 'primary')
    return text
  }
  if (l === 'json' || l === 'jsonc') {
    return text.replace(JSON_RE, (m, str, colon, num, lit) => {
      if (str) return colon ? `${tone(str, 'primary')}${colon}` : tone(str, 'ok')
      if (num) return tone(num, 'warn')
      return tone(lit, 'accent')
    })
  }
  return text.replace(HASH_LANGS.has(l) ? HASH_RE : SLASH_RE, (m, comment, str, num, ident, paren) => {
    if (comment) return `${sgr(I[0])}${tone(comment, 'muted')}${sgr(I[1])}`
    if (str) return tone(str, 'ok')
    if (num) return tone(num, 'warn')
    if (ident) {
      if (KEYWORDS.has(ident)) return `${tone(ident, 'accent')}${paren || ''}`
      if (paren) return `${tone(ident, 'primary')}${paren}`
    }
    return m
  })
}

// ---------- block renderer ----------
export function createMarkdownRenderer({ width = 76, emit }) {
  const W = Math.max(20, width)
  let fence = null
  let table = []
  let lastBlank = true
  const out = line => { emit(line); lastBlank = line === '' }
  const blank = () => { if (!lastBlank) out('') }
  const muted = text => tone(text, 'muted')
  const paragraph = (text, first = '', rest = '', base = {}) => { for (const l of wrapAtoms(toAtoms(inlineSegments(text, base)), W, first, rest)) out(l) }

  const codeRow = content => {
    const pad = ' '.repeat(Math.max(0, W - 2 - stringWidth(content)))
    return lvl() >= 2 ? `${bg('panel')} ${content}${pad} ${BG_OFF}` : `${muted('│')} ${content}`
  }
  function openFence(ch, len, lang) {
    fence = { ch, len, lang }
    blank()
    const name = lang || 'code'
    if (lvl() >= 2) out(`${bg('panel')} ${tone('◆', 'primary')} ${sgr(B[0])}${tone(name, 'accent')}${sgr(B[1])}${' '.repeat(Math.max(0, W - 4 - stringWidth(name)))} ${BG_OFF}`)
    else out(muted(`┌─ ${name}`))
  }
  function codeLine(text) {
    const room = Math.max(8, W - 2)
    let rest = text
    do {
      const piece = stringWidth(rest) <= room ? rest : (clipWidth(rest, room) || Array.from(rest)[0])
      out(codeRow(highlightCode(piece, fence.lang)))
      rest = rest.slice(piece.length)
    } while (rest)
  }
  function closeFence() {
    out(lvl() >= 2 ? codeRow('') : muted('└─'))
    fence = null
  }

  const parseRow = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
  function flushTable() {
    if (!table.length) return
    const rows = table.map(parseRow)
    table = []
    const isSep = r => r.length > 0 && r.every(c => /^:?-{2,}:?$/.test(c))
    let header = null
    let aligns = []
    let body = rows
    if (rows.length >= 2 && isSep(rows[1])) {
      header = rows[0]
      aligns = rows[1].map(c => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l'))
      body = rows.slice(2)
    }
    const all = header ? [header, ...body] : body
    const cols = Math.max(...all.map(r => r.length))
    const cells = all.map(r => Array.from({ length: cols }, (_, i) => inlineSegments(r[i] ?? '')))
    const plainOf = segs => segs.map(s => s.text).join('')
    const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...cells.map(r => stringWidth(plainOf(r[c])))))
    while (widths.reduce((a, b) => a + b, 0) + cols * 3 + 1 > W) {
      const i = widths.indexOf(Math.max(...widths))
      if (widths[i] <= 3) break
      widths[i]--
    }
    const render = (segs, w, align, head) => {
      const plain = plainOf(segs)
      let content = stringWidth(plain) <= w ? segs.map(s => styled(s.text, s)).join('') : styled(clipEllipsis(plain, w), {})
      if (head) content = `${sgr(B[0])}${fg('primary')}${content}${FG_OFF}${sgr(B[1])}`
      const gap = Math.max(0, w - stringWidth(content))
      const left = align === 'r' ? gap : align === 'c' ? Math.floor(gap / 2) : 0
      return ' '.repeat(left) + content + ' '.repeat(gap - left)
    }
    const rule = (l, m, r) => muted(`${l}${widths.map(w => '─'.repeat(w + 2)).join(m)}${r}`)
    const line = (r, head) => `${muted('│')} ${r.map((segs, c) => render(segs, widths[c], aligns[c] || 'l', head)).join(` ${muted('│')} `)} ${muted('│')}`
    blank()
    out(rule('╭', '┬', '╮'))
    cells.forEach((r, i) => {
      out(line(r, Boolean(header) && i === 0))
      if (header && i === 0) out(rule('├', '┼', '┤'))
    })
    out(rule('╰', '┴', '╯'))
  }

  function line(raw) {
    const text = String(raw).replace(/\r$/, '').replace(/\t/g, '    ')
    if (fence) {
      if (new RegExp(`^\\s*${fence.ch === '`' ? '`' : '~'}{${fence.len},}\\s*$`).test(text)) closeFence()
      else codeLine(text)
      return
    }
    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(text)
    if (open) { flushTable(); openFence(open[1][0], open[1].length, open[2]); return }
    if (/^\s*\|.*\|\s*$/.test(text)) { table.push(text); return }
    flushTable()
    if (!text.trim()) { blank(); return }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
    if (heading) {
      const level = heading[1].length
      const plain = inlineSegments(heading[2]).map(s => s.text).join('')
      blank()
      if (level === 1 && stringWidth(plain) <= W) {
        out(`${sgr(B[0])}${gradientText(plain)}${sgr(B[1])}`)
        out(muted('─'.repeat(Math.min(W, stringWidth(plain) + 2))))
      } else if (level === 2) paragraph(heading[2], `${tone('▎', 'primary')} `, '  ', { b: true })
      else if (level === 3) paragraph(heading[2], `${tone('▸', 'accent')} `, '  ', { b: true })
      else paragraph(heading[2], '', '', { b: true, q: level >= 5 })
      return
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) { blank(); out(muted('─'.repeat(W))); return }
    const quote = /^\s*>\s?(.*)$/.exec(text)
    if (quote) { const bar = `${muted('▎')} `; paragraph(quote[1], bar, bar, { i: true, q: true }); return }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(text)
    if (item) {
      const depth = Math.min(6, Math.floor(item[1].length / 2))
      const indent = '  '.repeat(depth)
      let marker = /\d/.test(item[2]) ? tone(item[2], 'primary') : tone(['•', '◦', '▪'][Math.min(depth, 2)], 'accent')
      let body = item[3]
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body)
      if (task) { marker = task[1].trim() ? tone('☑', 'ok') : muted('☐'); body = task[2] }
      paragraph(body, `${indent}${marker} `, ' '.repeat(stringWidth(indent) + stringWidth(marker) + 1))
      return
    }
    paragraph(text.trim())
  }

  return { line, flush() { flushTable(); if (fence) closeFence() } }
}

export function renderMarkdown(text, width = 76) {
  const lines = []
  const md = createMarkdownRenderer({ width, emit: line => lines.push(line) })
  for (const l of String(text).split('\n')) md.line(l)
  md.flush()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

// ---------- framed response card ----------
export function createCardStream({ title = ' ☤ VallenEmperor CLI ', width = 80, write, markdown = true }) {
  // Open "rail" card: only a left edge, so there is no ragged right border and copy/paste stays clean.
  const columns = Math.max(36, Math.floor(Number(width) || 80))
  const content = columns - 2
  const edge = text => tone(text, 'accent')
  const frame = text => `${edge('│')} ${text}${sgr('\x1b[0m')}`
  let started = false
  let buffer = ''
  let chars = 0
  // blank rows are held back so the card never ends (or streams) with dangling empty lines
  let heldBlank = 0
  const emit = text => {
    if (text === '') { if (started && chars > 0) heldBlank++; return }
    for (; heldBlank > 0; heldBlank--) write(frame(''))
    write(frame(text))
  }
  const md = markdown ? createMarkdownRenderer({ width: content, emit }) : null
  const plainLine = text => {
    let value = stringWidth(text) <= content ? text : stripAnsi(text)
    if (stringWidth(value) <= content) return emit(value)
    while (value) {
      const piece = clipWidth(value, content) || Array.from(value)[0]
      emit(piece)
      value = value.slice(piece.length)
    }
  }
  const feed = text => (md ? md.line(text) : plainLine(text))
  const start = () => {
    if (started) return
    started = true
    write(`${edge('╭─')}${sgr(B[0])}${gradientText(title)}${sgr(B[1])}${tone('─'.repeat(Math.max(0, columns - 2 - stringWidth(title))), 'muted')}`)
  }
  return {
    get started() { return started },
    get chars() { return chars },
    push(text) {
      start()
      chars += text.length
      buffer += text.replace(/\r\n?/g, '\n')
      let i
      while ((i = buffer.indexOf('\n')) >= 0) { feed(buffer.slice(0, i)); buffer = buffer.slice(i + 1) }
    },
    end(footer = '') {
      start()
      if (buffer) { feed(buffer); buffer = '' }
      md?.flush()
      heldBlank = 0
      const label = String(footer || '').trim()
      if (label) {
        const shown = clipEllipsis(label, columns - 6)
        write(`${edge('╰─')} ${tone(shown, 'muted')} ${tone('─'.repeat(Math.max(0, columns - 4 - stringWidth(shown))), 'muted')}`)
      } else write(`${edge('╰')}${tone('─'.repeat(columns - 1), 'muted')}`)
    }
  }
}

export function formatResponseCard(text, title = ' ☤ VallenEmperor CLI ', width = 80, { markdown = true, footer = '' } = {}) {
  const lines = []
  const card = createCardStream({ title, width, markdown, write: line => lines.push(line) })
  card.push(`${String(text ?? '')}\n`)
  card.end(footer)
  return lines.join('\n')
}
