import { spawnSync } from 'node:child_process'

/**
 * Post-edit formatter — run the project's own formatter on a file the agent just changed.
 *
 * Config: `formatter: { command: "npx prettier --write {file}", extensions: [".ts"] }`.
 * `{file}` is replaced with the edited path. Best-effort: a failing formatter is reported, never fatal,
 * and it is skipped when the extension is not listed.
 */

export interface FormatterConfig {
  command?: string
  extensions?: string[]
}

export interface FormatResult {
  ran: boolean
  ok: boolean
  output?: string
}

export function shouldFormat(file: string, config: FormatterConfig | undefined): boolean {
  if (!config?.command) return false
  const extensions = config.extensions
  if (!extensions?.length) return true
  const lower = String(file).toLowerCase()
  return extensions.some(extension => lower.endsWith(extension.toLowerCase()))
}

export function formatFile(options: {
  file: string
  cwd?: string
  config?: FormatterConfig
  runner?: (command: string, cwd?: string) => { status: number | null; stdout?: string; stderr?: string }
}): FormatResult {
  if (!shouldFormat(options.file, options.config)) return { ran: false, ok: true }
  const command = String(options.config?.command || '').replaceAll('{file}', options.file)
  const runner = options.runner || ((cmd, cwd) => {
    const result = spawnSync(cmd, { shell: true, cwd, timeout: 20_000, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
  })
  try {
    const result = runner(command, options.cwd)
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    return { ran: true, ok: result.status === 0, output: output.slice(0, 2000) }
  } catch (error: any) {
    return { ran: true, ok: false, output: String(error?.message || error).slice(0, 500) }
  }
}
