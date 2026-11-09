import { readdirSync, statSync } from 'fs'
import { basename, isAbsolute, join, resolve } from 'path'
import { homedir } from 'os'
import { registry, ToolSchema } from '../tools'
import { captureTypeScriptDiagnostics } from '../../core/typescript_diagnostics'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage']
const MAX_FILES = 80

/**
 * `typecheck` — exposes the TypeScript diagnostics module that already existed in
 * core but had no tool wrapper. Before this the agent had to shell out to
 * `npx tsc` and parse raw output to know whether an edit type-checked.
 */
export function registerDiagnosticsTools(): void {
  const schema: ToolSchema = {
    name: 'typecheck',
    description: 'Report TypeScript diagnostics for a file or directory using the project tsconfig (no shell command). Returns the errors and warnings that exist right now, so an edit can be verified immediately.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to check (default: current working directory)', default: '.' },
        limit: { type: 'integer', description: 'Maximum diagnostics to return (default: 50)', default: 50 }
      },
      required: []
    }
  }

  registry.register({
    name: 'typecheck',
    schema,
    toolset: 'code',
    handler: async (args, context) => {
      const basePath = context.workingDir || process.cwd()
      let rawPath = String(args.path || '.')
      if (rawPath.startsWith('~/')) rawPath = join(homedir(), rawPath.slice(2))
      const target = isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath)
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 50))

      let stats
      try { stats = statSync(target) } catch { return JSON.stringify({ error: `Path not found: ${rawPath}` }) }

      const files: string[] = []
      if (stats.isFile()) {
        files.push(target)
      } else {
        const walk = (dir: string) => {
          if (files.length >= MAX_FILES) return
          let names: string[]
          try { names = readdirSync(dir) } catch { return }
          for (const name of names.sort()) {
            if (files.length >= MAX_FILES) return
            const full = join(dir, name)
            let info
            try { info = statSync(full) } catch { continue }
            if (info.isDirectory()) {
              if (!SKIP_DIRS.includes(name)) walk(full)
              continue
            }
            if (SOURCE_EXTENSIONS.some(ext => name.endsWith(ext))) files.push(full)
          }
        }
        walk(target)
      }

      if (!files.length) {
        return JSON.stringify({ ok: true, files_checked: 0, diagnostics: [], total: 0, note: `No TypeScript files found under ${target}.` })
      }

      const diagnostics: Array<{ file: string; severity: string; message: string }> = []
      let checked = 0
      for (const file of files) {
        const snapshot = captureTypeScriptDiagnostics(file, stats.isFile() ? resolve(target, '..') : target)
        if (snapshot === null) continue
        checked++
        for (const text of snapshot.values()) {
          const severity = text.startsWith('ERROR') ? 'error' : 'warning'
          diagnostics.push({ file: basename(file), severity, message: text })
        }
      }

      if (checked === 0) {
        return JSON.stringify({
          ok: false,
          files_checked: 0,
          diagnostics: [],
          total: 0,
          error: `No TypeScript project found: ${target} is not covered by a tsconfig.json. Run this from the project root or point path at one.`
        })
      }

      const errors = diagnostics.filter(item => item.severity === 'error').length
      const shown = diagnostics.slice(0, limit)
      return JSON.stringify({
        ok: errors === 0,
        files_checked: checked,
        errors,
        warnings: diagnostics.length - errors,
        total: diagnostics.length,
        truncated: diagnostics.length > shown.length,
        diagnostics: shown
      })
    }
  })
}
