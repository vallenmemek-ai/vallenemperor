import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Interactive `/diff` review (P1.3).
 *
 * A working-tree diff is split into per-file hunks. The viewer walks them one at a time; `skip` reverts
 * exactly that hunk with a reverse `git apply`, so a bad hunk can be dropped without touching the rest
 * of the change. Everything is plain text — it works over SSH and inside a piped session.
 */

export interface DiffHunk {
  file: string
  /** 1-based position across the whole diff. */
  index: number
  header: string
  lines: string[]
  /** The complete patch for this hunk, including the file headers git needs. */
  patch: string
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  // Windows git emits CRLF; splitting on \n would leave a trailing \r on every line
  // and the re-applied patch would write CRLF into the file.
  const lines = String(diffText || '').replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  let file = ''
  let fileHeader: string[] = []
  let current: { header: string; lines: string[] } | null = null

  const flush = () => {
    if (!current || !file) { current = null; return }
    hunks.push({
      file,
      index: hunks.length + 1,
      header: current.header,
      lines: current.lines,
      patch: [...fileHeader, current.header, ...current.lines].join('\n') + '\n'
    })
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      file = match ? match[2] : ''
      fileHeader = [line]
      continue
    }
    if (current) {
      if (line.startsWith('@@')) {
        flush()
        current = { header: line, lines: [] }
        continue
      }
      if (line.startsWith('diff --git ')) continue
      current.lines.push(line)
      continue
    }
    if (HUNK_HEADER.test(line)) {
      current = { header: line, lines: [] }
      continue
    }
    if (file && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('new file ') || line.startsWith('deleted file ') || line.startsWith('old mode ') ||
        line.startsWith('new mode ') || line.startsWith('similarity index ') || line.startsWith('rename '))) {
      fileHeader.push(line)
    }
  }
  flush()
  // Drop trailing empty strings that come from the final newline.
  for (const hunk of hunks) while (hunk.lines.length && hunk.lines[hunk.lines.length - 1] === '') hunk.lines.pop()
  return hunks
}

export function formatHunkView(hunk: DiffHunk, total: number): string {
  const added = hunk.lines.filter(line => line.startsWith('+')).length
  const removed = hunk.lines.filter(line => line.startsWith('-')).length
  return [
    `Hunk ${hunk.index}/${total} · ${hunk.file} · +${added} -${removed}`,
    hunk.header,
    ...hunk.lines.map(line => (line.length ? `  ${line}` : '  ')),
    '',
    'Commands: /diff next · /diff prev · /diff keep · /diff skip (revert this hunk) · /diff done'
  ].join('\n')
}

export function revertHunk(options: {
  repo: string
  hunk: DiffHunk
  runner?: (args: string[], cwd: string, input?: string) => { status: number | null; stdout?: string; stderr?: string }
}): { ok: boolean; output: string } {
  const runner = options.runner || ((args, cwd, input) => {
    const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 20_000 })
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
  })
  const dir = mkdtempSync(join(tmpdir(), 'vallen-hunk-'))
  const patchFile = join(dir, 'hunk.patch')
  try {
    writeFileSync(patchFile, String(options.hunk.patch).replace(/\r\n/g, '\n'))
    const result = runner(['apply', '-R', '--whitespace=nowarn', patchFile], options.repo)
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    return { ok: result.status === 0, output }
  } catch (error: any) {
    return { ok: false, output: String(error?.message || error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface DiffReviewState {
  repo: string
  hunks: DiffHunk[]
  index: number
  kept: number[]
  skipped: number[]
}

export function startDiffReview(repo: string, diffText: string): DiffReviewState | null {
  const hunks = parseDiffHunks(diffText)
  if (!hunks.length) return null
  return { repo, hunks, index: 0, kept: [], skipped: [] }
}

export function currentHunk(state: DiffReviewState): DiffHunk | null {
  return state.hunks[state.index] || null
}

export function moveReview(state: DiffReviewState, delta: number): DiffReviewState {
  const next = Math.min(Math.max(0, state.index + delta), Math.max(0, state.hunks.length - 1))
  return { ...state, index: next }
}

export function formatReviewProgress(state: DiffReviewState): string {
  return `${state.index + 1}/${state.hunks.length} · kept ${state.kept.length} · skipped ${state.skipped.length}`
}
