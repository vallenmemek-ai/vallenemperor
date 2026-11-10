import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * Path policy — what the agent may never write, and what it must not rewrite silently.
 *
 * Two classes:
 * - **sensitive**: credentials and key material. Hard deny, always, no override.
 * - **instruction**: files that define how the agent behaves (AGENTS.md, RULES.md, …). Denied by
 *   default so a turn cannot quietly rewrite its own rules; the owner can opt in per machine with
 *   `VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS=1`.
 *
 * Reads are not restricted here: the sandbox (`core/sandbox.ts`) bounds writes, and blocking reads
 * would break legitimate diagnostics.
 */

export type PathClass = 'sensitive' | 'instruction' | 'normal'

export interface PathVerdict {
  class: PathClass
  reason?: string
}

const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.password-store', '.config/gh']
const SENSITIVE_FILES = [
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys', 'known_hosts',
  '.npmrc', '.netrc', '.pgpass', '.git-credentials', 'credentials', 'credentials.json',
  'secrets.json', 'secrets.yaml', 'secrets.yml', '.env'
]
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.asc', '.gpg']
const INSTRUCTION_FILES = new Set(['agents.md', 'rules.md', 'claude.md', 'gemini.md', 'soul.md', 'copilot-instructions.md'])

function normalize(target: string): string {
  const expanded = target.startsWith('~/') ? join(homedir(), target.slice(2)) : target
  return resolve(expanded)
}

export function classifyPath(target: string, home: string = homedir()): PathVerdict {
  const full = normalize(target)
  const lower = full.toLowerCase()
  const name = basename(lower)

  for (const dir of SENSITIVE_DIRS) {
    const marker = `${dir}/`.toLowerCase()
    if (lower.includes(`/${marker}`) || lower.endsWith(`/${dir}`)) {
      return { class: 'sensitive', reason: `credential directory (${dir})` }
    }
  }
  if (SENSITIVE_FILES.includes(name)) {
    return { class: 'sensitive', reason: `credential file (${name})` }
  }
  // .env.local / .env.production are secrets; .env.example is documentation.
  if (/^\.env\.[a-z0-9]+$/i.test(name) && !name.endsWith('.example')) {
    return { class: 'sensitive', reason: 'environment secrets file' }
  }
  if (SENSITIVE_SUFFIXES.some(suffix => lower.endsWith(suffix))) {
    return { class: 'sensitive', reason: 'private key material' }
  }
  if (INSTRUCTION_FILES.has(name)) {
    return { class: 'instruction', reason: 'agent instruction file' }
  }
  // Everything under the vallenemperor home that holds config is instruction-like, but data files
  // (sessions, artifacts) are normal writes.
  if (lower.startsWith(join(home, '.vallenemperor').toLowerCase()) && /(^|\/)config\.json$/.test(lower)) {
    return { class: 'instruction', reason: 'agent configuration' }
  }
  return { class: 'normal' }
}

export function instructionEditsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS === '1'
}

/** Returns an error message when a write must be refused, else null. */
export function checkWritePolicy(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const verdict = classifyPath(target)
  if (verdict.class === 'sensitive') {
    return `Refusing to write ${target}: it is a ${verdict.reason}. Credential and key material is never written by the agent.`
  }
  if (verdict.class === 'instruction' && !instructionEditsAllowed(env)) {
    return `Refusing to write ${target}: it is an ${verdict.reason}. These files define how the agent behaves. `
      + 'Edit it yourself, or set VALLENEMPEROR_ALLOW_INSTRUCTION_EDITS=1 to allow the agent to change its own rules.'
  }
  return null
}
