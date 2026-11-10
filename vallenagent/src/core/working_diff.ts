import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Working-tree git diff, shared by `/diff <mode>`.
 *
 * Modes: `working` (unstaged + untracked), `staged` (`git diff --cached`), `all` (everything since
 * HEAD plus untracked). Untracked files are folded in with `git diff --no-index /dev/null <file>` so
 * new files show up as additions instead of being invisible.
 *
 * Bounded on purpose: 15 s per git call and a 50-file cap, so a `node_modules` explosion cannot hang
 * the CLI. Never throws: returns `{ ok: false, error }` when the directory is not a git repo.
 */

export type DiffMode = 'working' | 'staged' | 'all'

export interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
  diff: string
}

export interface DiffResult {
  ok: boolean
  mode: DiffMode
  files: DiffFile[]
  text: string
  truncated: boolean
  error?: string
}

const GIT_TIMEOUT_MS = 15_000
const MAX_UNTRACKED = 50
const MAX_TOTAL_CHARS = 200_000

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
}

export function isGitRepository(cwd: string): boolean {
  if (!existsSync(cwd)) return false
  try {
    return git(['rev-parse', '--is-inside-work-tree'], cwd).trim() === 'true'
  } catch {
    return false
  }
}

function statusOf(header: string): DiffFile['status'] {
  if (header.startsWith('new file')) return 'added'
  if (header.startsWith('deleted file')) return 'deleted'
  if (header.startsWith('rename')) return 'renamed'
  return 'modified'
}

function splitDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  const chunks = raw.split(/^diff --git /m).filter(Boolean)
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(body)
    const path = header ? header[2] : '(unknown)'
    const statusLine = /^\+\+\+ .*\n|^--- .*\n/m.test(body) ? body : body
    const newFile = /^new file mode/m.test(statusLine)
    const deleted = /^deleted file mode/m.test(statusLine)
    files.push({
      path,
      status: newFile ? 'added' : deleted ? 'deleted' : statusOf(statusLine.slice(0, 200)),
      diff: body.trimEnd()
    })
  }
  return files
}

export interface CollectDiffOptions {
  cwd: string
  mode?: DiffMode
}

export function collectWorkingDiff(options: CollectDiffOptions): DiffResult {
  const mode: DiffMode = options.mode || 'working'
  const cwd = options.cwd
  if (!isGitRepository(cwd)) {
    return { ok: false, mode, files: [], text: '', truncated: false, error: `${cwd} is not a git repository` }
  }

  try {
    let raw = ''
    if (mode === 'staged') raw = git(['diff', '--cached'], cwd)
    else if (mode === 'all') raw = git(['diff', 'HEAD'], cwd)
    else raw = git(['diff'], cwd)

    const files = splitDiff(raw)

    if (mode !== 'staged') {
      const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, MAX_UNTRACKED)
      for (const path of untracked) {
        let diff = ''
        try {
          diff = execFileSync('git', ['diff', '--no-index', '--', '/dev/null', path], {
            cwd, stdio: 'pipe', encoding: 'utf8', timeout: GIT_TIMEOUT_MS
          })
        } catch (err: any) {
          // `git diff --no-index` exits 1 when files differ, which is the normal case here.
          diff = String(err?.stdout || '')
        }
        files.push({ path, status: 'untracked', diff: diff.trimEnd() })
      }
    }

    let text = files.map(file => file.diff).join('\n\n')
    let truncated = false
    if (text.length > MAX_TOTAL_CHARS) {
      text = `${text.slice(0, MAX_TOTAL_CHARS)}\n\n… diff truncated (${text.length - MAX_TOTAL_CHARS} chars omitted)`
      truncated = true
    }
    if (!files.length) text = 'No changes.'

    return { ok: true, mode, files, text, truncated }
  } catch (err: any) {
    return {
      ok: false,
      mode,
      files: [],
      text: '',
      truncated: false,
      error: String(err?.message || err || 'git diff failed').slice(0, 500)
    }
  }
}

export function formatDiffSummary(result: DiffResult): string {
  if (!result.ok) return `git diff failed: ${result.error}`
  if (!result.files.length) return `No ${result.mode} changes.`
  const lines = [`${result.files.length} file(s) · mode: ${result.mode}`]
  for (const file of result.files) {
    const added = (file.diff.match(/^\+[^+]/gm) || []).length
    const removed = (file.diff.match(/^-[^-]/gm) || []).length
    lines.push(`  ${file.status.padEnd(10)} +${String(added).padStart(4)} -${String(removed).padStart(4)}  ${file.path}`)
  }
  if (result.truncated) lines.push('  (diff truncated)')
  return lines.join('\n')
}
