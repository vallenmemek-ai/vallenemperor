import { classifyToolResult } from './tool_evidence'
import { recordArtifacts, type TurnArtifactState } from './turn_artifacts'
import type { VerificationLedger, VerificationGroup } from './verification'

/**
 * Turn stage — bookkeeping after one tool result lands.
 *
 * Turns a raw tool result into: verification evidence (typecheck/test/build dirtied or
 * proven), turn artifacts (created/changed/saved files, verification commands) and the
 * explicit-skill marker. Kept out of agent.ts so the tool loop stays readable.
 */
export interface ToolResultContext {
  verification: VerificationLedger
  dirty: Set<VerificationGroup>
  verified: Set<VerificationGroup>
  artifacts: TurnArtifactState
  isSubagent: boolean
  /** Called when skill_view loads a skill on purpose (sticky for the session). */
  onExplicitSkill?: (skill: { name: string; content: string }) => void
}

export function applyToolResult(
  context: ToolResultContext,
  toolName: string,
  args: Record<string, any>,
  result: string
): void {
  const evidence = classifyToolResult(toolName, args, result, { isSubagent: context.isSubagent })

  if (evidence.edited) {
    const dirtied: VerificationGroup[] = []
    if (evidence.typescriptEdited) dirtied.push('typecheck')
    if (evidence.testEdited) dirtied.push('test')
    if (evidence.buildConfigEdited) dirtied.push('build')
    for (const group of dirtied) {
      context.dirty.add(group)
      // A fresh edit invalidates earlier proof for that group.
      context.verified.delete(group)
    }
  }

  if (evidence.verification) {
    context.verification.record(evidence.verification.command, evidence.verification.exitCode, evidence.verification.output)
    for (const group of evidence.verification.groups) context.verified.add(group)
  }

  recordArtifacts(context.artifacts, toolName, args, result)

  // An explicit skill_view is a deliberate load: keep it for the rest of the session.
  if (toolName === 'skill_view' && !context.isSubagent && context.onExplicitSkill) {
    let parsed: any = null
    try { parsed = JSON.parse(result) } catch { parsed = null }
    if (parsed && !parsed.error && parsed.name && typeof parsed.content === 'string' && !args.file_path) {
      context.onExplicitSkill({ name: String(parsed.name), content: parsed.content })
    }
  }
}
