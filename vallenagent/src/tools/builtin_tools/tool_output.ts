import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

let lastCleanupAt = 0
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

export function truncateOutput(text: string, maxBytes: number = 50_000): { text: string; truncated: boolean; spillPath?: string } {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  const headBytes = Math.floor(maxBytes * 0.4)
  const tailBytes = Math.floor(maxBytes * 0.6)
  const head = buf.subarray(0, headBytes).toString('utf-8').replace(/\uFFFD$/, '')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf-8').replace(/^\uFFFD/, '')

  let spillPath: string | undefined
  try {
    const scratchDir = join(homedir(), '.vallenemperor', 'scratch')
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    const now = Date.now()
    if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      for (const name of readdirSync(scratchDir)) {
        if (/^output-\d+-[a-f0-9-]+\.log$/.test(name)) {
          try { if (now - statSync(join(scratchDir, name)).mtimeMs > 86_400_000) unlinkSync(join(scratchDir, name)) } catch {}
        }
      }
      lastCleanupAt = now
    }
    spillPath = join(scratchDir, `output-${now}-${randomUUID()}.log`)
    writeFileSync(spillPath, text, { encoding: 'utf-8', mode: 0o600 })
  } catch {}

  const spillNotice = spillPath ? ` (FULL output saved to ${spillPath} — page with read_file if needed)` : ''

  return {
    text: `${head}\n\n[... Truncated ${buf.length - maxBytes} bytes${spillNotice} ...]\n\n${tail}`,
    truncated: true,
    spillPath
  }
}
