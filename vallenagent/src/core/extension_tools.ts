import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Executable extension tools (R34) — the half a manifest cannot cover.
 *
 * A pack may ship `tools/*.mjs` modules that export tool definitions. Loading them runs code, so it is
 * opt-in (`extensions.allow_tools: true`), names are validated, and a module can never shadow a builtin
 * tool. Nothing is loaded from the network and nothing is loaded silently.
 */

export interface ExtensionToolDefinition {
  name: string
  description: string
  parameters?: Record<string, any>
  handler: (args: any, context: any) => Promise<string> | string
}

export interface LoadedExtensionTool {
  definition: ExtensionToolDefinition
  path: string
  pack: string
}

export interface LoadExtensionToolsResult {
  tools: LoadedExtensionTool[]
  errors: string[]
  allowed: boolean
  reason?: string
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/

export function extensionToolDirs(home: string): string[] {
  const root = join(home, 'extensions')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .map(name => join(root, name, 'tools'))
      .filter(dir => existsSync(dir))
  } catch { return [] }
}

function normalizeModule(mod: any): ExtensionToolDefinition[] {
  const exported = mod?.default ?? mod?.tools ?? mod
  const list = Array.isArray(exported) ? exported : [exported]
  return list.filter(item => item && typeof item === 'object' && typeof item.name === 'string')
}

export async function loadExtensionTools(options: {
  home: string
  allow: boolean
  builtinNames?: string[]
  importer?: (url: string) => Promise<any>
}): Promise<LoadExtensionToolsResult> {
  if (!options.allow) {
    return { tools: [], errors: [], allowed: false, reason: 'extensions.allow_tools is false — pack tools were not loaded' }
  }
  const importer = options.importer || ((url: string) => import(url))
  const builtins = new Set(options.builtinNames || [])
  const tools: LoadedExtensionTool[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const dir of extensionToolDirs(options.home)) {
    let files: string[] = []
    try { files = readdirSync(dir).filter(name => name.endsWith('.mjs') || name.endsWith('.js')) } catch { continue }
    for (const file of files) {
      const path = join(dir, file)
      const pack = path.split('/extensions/')[1]?.split('/')[0] || 'unknown'
      try {
        const mod = await importer(pathToFileURL(path).href)
        for (const definition of normalizeModule(mod)) {
          if (!NAME_PATTERN.test(definition.name)) { errors.push(`${path}: invalid tool name "${definition.name}"`); continue }
          if (builtins.has(definition.name)) { errors.push(`${path}: "${definition.name}" would shadow a builtin tool`); continue }
          if (seen.has(definition.name)) { errors.push(`${path}: duplicate tool "${definition.name}"`); continue }
          if (typeof definition.handler !== 'function') { errors.push(`${path}: "${definition.name}" has no handler function`); continue }
          if (!definition.description || String(definition.description).length < 10) { errors.push(`${path}: "${definition.name}" needs a description`); continue }
          seen.add(definition.name)
          tools.push({ definition, path, pack })
        }
      } catch (error: any) {
        errors.push(`${path}: ${String(error?.message || error).slice(0, 200)}`)
      }
    }
  }
  return { tools, errors, allowed: true }
}

export function formatExtensionTools(result: LoadExtensionToolsResult): string {
  if (!result.allowed) return result.reason || 'Extension tools are disabled.'
  if (!result.tools.length && !result.errors.length) return 'No executable extension tools installed.'
  const lines = [`${result.tools.length} extension tool(s) loaded`]
  for (const tool of result.tools) lines.push(`  ${tool.definition.name.padEnd(24)} ${tool.pack}  ${tool.definition.description.slice(0, 60)}`)
  if (result.errors.length) {
    lines.push(`Skipped ${result.errors.length}:`)
    for (const error of result.errors) lines.push(`  ${error}`)
  }
  return lines.join('\n')
}
