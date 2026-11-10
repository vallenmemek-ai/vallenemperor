import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Approval mining — turn repeated human decisions into policy.
 *
 * Every approval prompt appends one JSONL line. `mineApprovals` then proposes the two safe extremes:
 * a tool the user always approves becomes `allow`, a tool they always deny becomes `deny`. Mixed
 * histories propose nothing — a coin flip is not a policy.
 */

export interface ApprovalRecord {
  tool: string
  approved: boolean
  at?: string
  cwd?: string
}

export interface ApprovalSuggestion {
  tool: string
  approved: number
  denied: number
  total: number
  suggestion: 'allow' | 'deny' | null
}

const FILE = 'approvals.jsonl'

export function recordApproval(home: string, record: ApprovalRecord): void {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, FILE), `${JSON.stringify({ ...record, at: record.at || new Date().toISOString() })}\n`)
  } catch { }
}

export function readApprovals(home: string): ApprovalRecord[] {
  const path = join(home, FILE)
  if (!existsSync(path)) return []
  const records: ApprovalRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.tool === 'string') records.push({ tool: parsed.tool, approved: Boolean(parsed.approved), at: parsed.at, cwd: parsed.cwd })
    } catch { }
  }
  return records
}

export function mineApprovals(records: ApprovalRecord[], options: { minCount?: number } = {}): ApprovalSuggestion[] {
  const minCount = Math.max(1, Number(options.minCount) || 3)
  const byTool = new Map<string, { approved: number; denied: number }>()
  for (const record of records) {
    const entry = byTool.get(record.tool) || { approved: 0, denied: 0 }
    if (record.approved) entry.approved++
    else entry.denied++
    byTool.set(record.tool, entry)
  }
  const suggestions: ApprovalSuggestion[] = []
  for (const [tool, counts] of byTool) {
    const total = counts.approved + counts.denied
    let suggestion: 'allow' | 'deny' | null = null
    if (counts.approved >= minCount && counts.denied === 0) suggestion = 'allow'
    else if (counts.denied >= minCount && counts.approved === 0) suggestion = 'deny'
    suggestions.push({ tool, approved: counts.approved, denied: counts.denied, total, suggestion })
  }
  return suggestions.sort((a, b) => b.total - a.total)
}

export function formatApprovals(suggestions: ApprovalSuggestion[]): string {
  if (!suggestions.length) return 'No approval history yet. Decisions are recorded as you answer prompts.'
  const lines = ['Approval history', ...suggestions.map(item => `  ${item.tool.padEnd(18)} ${String(item.approved).padStart(3)} approved · ${String(item.denied).padStart(3)} denied   ${item.suggestion ? `→ propose ${item.suggestion}` : ''}`)]
  if (suggestions.some(item => item.suggestion)) lines.push('', 'Run /approvals apply to write the proposals into tool_policy.')
  return lines.join('\n')
}
