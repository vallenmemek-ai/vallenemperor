import { isTypecheckCommand, verificationGroupsForCommand, type VerificationGroup } from './verification'

const TYPESCRIPT_FILE = /\.(?:ts|tsx|mts|cts)$/i
/** Test files: a test edit must be proven by running the suite. */
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:[\\/](?:tests?|__tests__)[\\/])/i
/** Build-affecting config: changing it must be proven by a build. */
const BUILD_CONFIG_FILE = /(?:^|[\\/])(?:package\.json|tsconfig[^\\/]*\.json|(?:vite|webpack|rollup|esbuild|next|nuxt|babel|jest|vitest)\.config\.[cm]?[jt]s|Makefile|Dockerfile)$/i

function classifyPath(path: string): Pick<ToolEvidence, 'typescriptEdited' | 'testEdited' | 'buildConfigEdited'> {
  return {
    typescriptEdited: TYPESCRIPT_FILE.test(path),
    testEdited: TEST_FILE.test(path),
    buildConfigEdited: BUILD_CONFIG_FILE.test(path)
  }
}

export interface ToolEvidence {
  /** A real file edit landed (write_file/patch/patch_batch/apply_patch succeeded). */
  edited: boolean
  /** The edit touched a TypeScript file, so a typecheck is the expected proof. */
  typescriptEdited: boolean
  /** The edit touched a test file, so running the suite is the expected proof. */
  testEdited?: boolean
  /** The edit touched build config, so a build is the expected proof. */
  buildConfigEdited?: boolean
  /** A terminal command that counts as verification evidence, with its real exit code. */
  verification?: {
    command: string
    exitCode: number | null
    output: string
    typecheckPassed: boolean
    /** Verification groups this successful command proves. */
    groups: VerificationGroup[]
  }
}

const NO_EVIDENCE: ToolEvidence = { edited: false, typescriptEdited: false }

function parseJson(raw: string): any | null {
  try { return JSON.parse(raw) } catch { return null }
}

/**
 * Classify one tool result into verification state.
 *
 * Rules live here instead of inline in the tool loop so they are testable and auditable:
 * unparseable output proves nothing, failed edits prove nothing, and only a terminal run
 * with a real exit code counts as verification.
 */
export function classifyToolResult(toolName: string, args: Record<string, any>, result: string, options: { isSubagent?: boolean } = {}): ToolEvidence {
  if (toolName === 'write_file' || toolName === 'patch') {
    const parsed = parseJson(result)
    if (!parsed || parsed.error) return NO_EVIDENCE
    const path = String(parsed.path || args.path || '')
    return { edited: true, ...classifyPath(path) }
  }

  if (toolName === 'patch_batch' || toolName === 'apply_patch') {
    const parsed = parseJson(result)
    if (!parsed || !parsed.success || !Array.isArray(parsed.files)) return NO_EVIDENCE
    const files = parsed.files as Array<{ path?: string }>
    const classified = files.map(file => classifyPath(String(file.path || '')))
    return {
      edited: true,
      typescriptEdited: classified.some(entry => entry.typescriptEdited),
      testEdited: classified.some(entry => entry.testEdited),
      buildConfigEdited: classified.some(entry => entry.buildConfigEdited)
    }
  }

  if (toolName === 'terminal' && !options.isSubagent) {
    const parsed = parseJson(result)
    if (!parsed) return NO_EVIDENCE
    const exitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code : null
    const command = String(args.command || '')
    return {
      edited: false,
      typescriptEdited: false,
      verification: {
        command,
        exitCode,
        output: `${parsed.output ?? ''}\n${parsed.stderr ?? ''}`,
        typecheckPassed: isTypecheckCommand(command) && exitCode === 0,
        groups: exitCode === 0 ? verificationGroupsForCommand(command) : []
      }
    }
  }

  return NO_EVIDENCE
}
