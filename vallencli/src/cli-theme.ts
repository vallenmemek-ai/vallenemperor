// Theme + colour engine for VallenCLI: truecolor / 256 / 16 colour fallback, gradients, shimmer.
// Pure logic apart from loadSavedTheme/saveTheme (tiny file I/O).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const THEMES = {
  vallen:   { primary: '#22d3ee', accent: '#a78bfa', ok: '#4ade80', warn: '#fbbf24', err: '#f87171', muted: '#8b93a7', panel: '#1f1b3a', gradient: ['#22d3ee', '#818cf8', '#c084fc'] },
  midnight: { primary: '#60a5fa', accent: '#38bdf8', ok: '#34d399', warn: '#fbbf24', err: '#fb7185', muted: '#8a9bb8', panel: '#0f1d3a', gradient: ['#2563eb', '#38bdf8', '#a5f3fc'] },
  sunset:   { primary: '#fb923c', accent: '#f472b6', ok: '#a3e635', warn: '#fde047', err: '#f87171', muted: '#a29a94', panel: '#2a1626', gradient: ['#f97316', '#ec4899', '#8b5cf6'] },
  matrix:   { primary: '#4ade80', accent: '#a3e635', ok: '#86efac', warn: '#facc15', err: '#f87171', muted: '#6f8f7a', panel: '#0b2415', gradient: ['#14532d', '#22c55e', '#bbf7d0'] },
  nord:     { primary: '#88c0d0', accent: '#b48ead', ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a', muted: '#7b88a1', panel: '#2e3440', gradient: ['#5e81ac', '#88c0d0', '#8fbcbb'] },
  rose:     { primary: '#fda4af', accent: '#c4b5fd', ok: '#86efac', warn: '#fde68a', err: '#fb7185', muted: '#a8929b', panel: '#2b1a24', gradient: ['#fb7185', '#f0abfc', '#a5b4fc'] },
  paper:    { primary: '#0e7490', accent: '#7c3aed', ok: '#15803d', warn: '#b45309', err: '#b91c1c', muted: '#6b7280', panel: '#e9edf3', addBg: '#d1fae5', delBg: '#fee2e2', gradient: ['#0e7490', '#4f46e5', '#9333ea'] },
  mono:     { primary: '#e5e7eb', accent: '#9ca3af', ok: '#d1d5db', warn: '#d1d5db', err: '#f87171', muted: '#9ca3af', panel: '#27272a', gradient: ['#6b7280', '#f3f4f6'] }
}

export const FG_OFF = '\x1b[39m'
export const BG_OFF = '\x1b[49m'

// 0 = none, 1 = 16 colours, 2 = 256 colours, 3 = truecolor. VALLEN_COLOR=truecolor|256|16|none overrides detection.
export function detectColorLevel(env = process.env) {
  const forced = String(env.VALLEN_COLOR || '').toLowerCase()
  if (forced) return { none: 0, '16': 1, '256': 2, truecolor: 3 }[forced] ?? 2
  if (env.NO_COLOR || env.FORCE_COLOR === '0') return 0
  const colorterm = String(env.COLORTERM || '').toLowerCase()
  const term = String(env.TERM || '')
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || ['vscode', 'iTerm.app', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM) || /kitty|alacritty|wezterm|ghostty/i.test(term)) return 3
  if (/256/.test(term)) return 2
  return 1
}

let level = detectColorLevel()
let currentName = 'vallen'

export const getColorLevel = () => level
export const setColorLevel = value => { level = value }
export const getThemeName = () => currentName
export const getTheme = () => THEMES[currentName]
export const themeNames = () => Object.keys(THEMES)
export function setTheme(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!THEMES[key]) return false
  currentName = key
  return true
}

const hexToRgb = hex => { const n = parseInt(String(hex).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rgbToHex = ([r, g, b]) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

export function rgbTo256([r, g, b]: number[]) {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round((r - 8) / 247 * 24) + 232
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5)
}
export function rgbTo16([r, g, b]: number[]) {
  const max = Math.max(r, g, b)
  if (max < 40) return 30
  const t = max * 0.55
  const code = (r >= t ? 1 : 0) | (g >= t ? 2 : 0) | (b >= t ? 4 : 0)
  if (code === 0) return 90
  return (max > 180 ? 90 : 30) + code
}

function seq(hex, isBg) {
  if (level === 0) return ''
  const rgb = hexToRgb(hex)
  if (level >= 3) return `\x1b[${isBg ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  if (level === 2) return `\x1b[${isBg ? 48 : 38};5;${rgbTo256(rgb)}m`
  return `\x1b[${rgbTo16(rgb) + (isBg ? 10 : 0)}m`
}
const resolve = role => (String(role).startsWith('#') ? role : getTheme()[role] || '#ffffff')
// Foreground / background escape for a theme role ("primary", "accent", "ok", "warn", "err", "muted", "panel") or a #hex.
export const fg = role => seq(resolve(role), false)
export const bg = role => seq(resolve(role), true)

export function mixHex(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return rgbToHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t])
}
function gradientAt(stops, t) {
  if (stops.length === 1) return stops[0]
  const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(scaled))
  return mixHex(stops[i], stops[i + 1], scaled - i)
}

export function gradientText(text, stops = getTheme().gradient) {
  const chars = Array.from(String(text))
  if (level === 0 || !chars.length) return String(text)
  if (level === 1) return `${fg('primary')}${text}${FG_OFF}`
  const n = Math.max(1, chars.length - 1)
  return chars.map((ch, i) => (ch === ' ' ? ch : `${seq(gradientAt(stops, i / n), false)}${ch}`)).join('') + FG_OFF
}

// Multi-line block (banner art): gradient runs left -> right across the widest line.
export function gradientBlock(text, stops = getTheme().gradient) {
  const lines = String(text).split('\n')
  if (level < 2) return level === 1 ? lines.map(line => `${fg('primary')}${line}${FG_OFF}`).join('\n') : String(text)
  const max = Math.max(1, ...lines.map(line => Array.from(line).length - 1))
  return lines.map(line => Array.from(line).map((ch, i) => (ch === ' ' ? ch : `${seq(gradientAt(stops, i / max), false)}${ch}`)).join('') + FG_OFF).join('\n')
}

// A bright band that sweeps across dim text; tick advances it.
export function shimmerText(text, tick = 0, { base = 'muted', hi = 'accent', band = 5 } = {}) {
  const chars = Array.from(String(text))
  if (level < 2) return `${fg(base)}${text}${FG_OFF}`
  const theme = getTheme()
  const total = chars.length + band * 2
  const pos = (tick % total) - band
  return chars.map((ch, i) => {
    const d = Math.abs(i - pos)
    const t = d >= band ? 0 : 1 - d / band
    return `${seq(mixHex(theme[base], theme[hi], t), false)}${ch}`
  }).join('') + FG_OFF
}

export function loadSavedTheme(home) {
  if (process.env.VALLEN_THEME && setTheme(process.env.VALLEN_THEME)) return
  try { if (setTheme(readFileSync(join(home, 'cli_theme'), 'utf8'))) return } catch {}
  // light terminal background (COLORFGBG="fg;bg", bg 7/15 = light) -> readable light theme by default
  const bgCode = String(process.env.COLORFGBG || '').split(';').pop()
  if (/^\d+$/.test(bgCode) && [7, 15].includes(Number(bgCode))) setTheme('paper')
}
export function saveTheme(home, name) {
  try { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'cli_theme'), `${name}\n`, { mode: 0o600 }) } catch {}
}
