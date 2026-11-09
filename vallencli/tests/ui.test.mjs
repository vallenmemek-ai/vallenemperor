// Run with: node --test vallencli/tests/ui.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { setColorLevel, setTheme } from '../src/cli-theme.mjs'
import { stringWidth, stripAnsi, toAscii, formatUserMessage, startupBox, buildEditPreview, formatApprovalBox, formatToolLine, formatStatusBar, formatTerminalLine, colorizeDiffPro } from '../src/cli-ui.mjs'
import { formatResponseCard, renderMarkdown } from '../src/cli-markdown.mjs'

setColorLevel(0)
setTheme('vallen')
const checks = [{ title: 'Host', detail: 'linux', status: 'ok' }, { title: 'MCP', detail: '1/2 ready', status: 'warn' }]

test('user message wraps inside the width', () => {
  const out = formatUserMessage('x'.repeat(100), 40).split('\n')
  assert.ok(out.length >= 3)
  assert.ok(out.every(line => stringWidth(line) <= 40))
  assert.ok(out[0].startsWith('›'))
})

test('compact startup is short and lists only problems', () => {
  const out = stripAnsi(startupBox({}, 'ART', checks, 60, { compact: true }))
  assert.ok(out.split('\n').length <= 3)
  assert.match(out, /1 warning/)
  assert.match(out, /MCP/)
  assert.doesNotMatch(out, /ART/)
})

test('full startup box keeps every row the same width', () => {
  const rows = stripAnsi(startupBox({}, '', checks, 80, { fancy: true })).split('\n').filter(line => /^[│╭╰]/.test(line))
  assert.ok(rows.length >= 4)
  assert.equal(new Set(rows.map(stringWidth)).size, 1)
})

test('edit preview counts added/removed lines', () => {
  assert.deepEqual(buildEditPreview({ old_string: 'a\nb', new_string: 'c' }), { added: 1, removed: 2, lines: ['-a', '-b', '+c'] })
  assert.equal(buildEditPreview({ path: 'x' }), null)
  const p = buildEditPreview({ diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx' })
  assert.equal(p.added, 1); assert.equal(p.removed, 1)
})

test('approval box shows the change preview and stays aligned', () => {
  const box = stripAnsi(formatApprovalBox({ name: 'patch', details: [['path', 'src/a.rs']], preview: buildEditPreview({ old_string: 'old', new_string: 'new\nmore' }) }, 60)).split('\n')
  assert.ok(box.some(line => line.includes('+2 −1')))
  assert.equal(new Set(box.map(stringWidth)).size, 1)
})

test('tool line is a single line', () => {
  const line = stripAnsi(formatToolLine('read_file auth.rs\nlines 1-80', '80 lines read', { durationMs: 120, width: 60 }))
  assert.equal(line.split('\n').length, 1)
  assert.match(line, /read_file auth\.rs/)
  assert.match(line, /120ms/)
  assert.ok(stringWidth(line) <= 60)
})

test('response card: open rail, footer, no trailing blank rows', () => {
  const card = stripAnsi(formatResponseCard('hello\n\n', ' T ', 50, { footer: '4.2s · 2 tools' })).split('\n')
  assert.ok(card[0].startsWith('╭─'))
  assert.ok(card.at(-1).startsWith('╰─ 4.2s · 2 tools'))
  assert.notEqual(card.at(-2).trim(), '│')
  assert.ok(card.every(line => stringWidth(line) <= 50))
  assert.equal(stringWidth(card[0]), stringWidth(card.at(-1)))
})

test('markdown table and code render without overflow', () => {
  const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1\n```', 40).split('\n')
  assert.ok(out.some(line => line.startsWith('╭')))
  assert.ok(out.every(line => stringWidth(line) <= 40))
})

test('bare urls and links survive without colour (no OSC garbage)', () => {
  const out = renderMarkdown('see https://example.com/a_b and [docs](https://x.dev)', 60)
  assert.match(out, /https:\/\/example\.com\/a_b/)
  assert.doesNotMatch(out, /\x1b/)
})

test('ascii mode maps to single-cell characters', () => {
  const src = '╭─ ● ▲ ✖ › ▰▱ ╯'
  const out = toAscii(src)
  assert.match(out, /^[\x00-\x7f]+$/)
  assert.equal(stringWidth(out), stringWidth(src))
})

test('status bar adds the hint only when it fits', () => {
  const agent = { getContextStats: () => ({ percent: 10 }), provider: { model: 'm' }, config: { terminal: { cwd: '/tmp' } } }
  const wide = stripAnsi(formatStatusBar(agent, [], { width: 90, git: null, hint: 'Ctrl+C stop' }))
  const narrow = stripAnsi(formatStatusBar(agent, [], { width: 40, git: null, hint: 'Ctrl+C stop' }))
  assert.match(wide, /Ctrl\+C stop$/)
  assert.doesNotMatch(narrow, /Ctrl\+C/)
  assert.ok(stringWidth(wide) <= 90)
})

test('terminal result collapses to one checkmark line; failures add exit code and a short tail', () => {
  const ok = stripAnsi(formatTerminalLine("python3 <<'EOF'\nprint(1)\nEOF", { exit: 0, durationMs: 3300, width: 80 }))
  assert.equal(ok.split('\n').length, 1)
  assert.match(ok, /^ {2}✓ \$ python3 <<'EOF' … · 3\.3s$/)
  const bad = stripAnsi(formatTerminalLine('npm test', { exit: 1, failed: true, durationMs: 40, tail: ['a', 'b'], width: 80 }))
  assert.match(bad, /✖ \$ npm test · exit 1 · 40ms/)
  assert.equal(bad.split('\n').length, 3)
})

test('unified diff rows (+/- at column 0) are classified as added/removed with line numbers', () => {
  setColorLevel(3)
  const rows = colorizeDiffPro('@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more', { width: 60, maxLines: 20 })
  setColorLevel(0)
  const hasTint = (row, pattern) => pattern.test(row)
  assert.ok(hasTint(rows[2], /\x1b\[48;2;58;20;32m/), 'removed line has red tint')
  assert.ok(hasTint(rows[3], /\x1b\[48;2;16;48;28m/), 'added line has green tint')
  assert.match(stripAnsi(rows[3]).trim(), /^2 \+new/)
  assert.match(stripAnsi(rows[4]).trim(), /^3 \+more/)
})
