import { logger } from './logger'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AgentConfig, ProviderConfig } from './types'
import type { McpServerConfig } from '../mcp/types'
import { chmodSafe } from './platform'

export function validateMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    logger.warn('[Config] Invalid mcpServers; MCP servers disabled.')
    return {}
  }
  const valid: Record<string, McpServerConfig> = {}
  for (const [name, candidate] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      logger.warn('[Config] Skipped invalid MCP server entry.')
      continue
    }
    const server = candidate as Record<string, unknown>
    const hasCommand = typeof server.command === 'string' && server.command.length > 0
    const hasUrl = typeof server.url === 'string' && server.url.length > 0
    const validCommand = !hasCommand || !/\s/.test(server.command as string)
    const validArgs = server.args === undefined || (Array.isArray(server.args) && server.args.every(item => typeof item === 'string'))
    const validEnv = server.env === undefined || (server.env !== null && typeof server.env === 'object' && !Array.isArray(server.env) && Object.values(server.env as object).every(item => typeof item === 'string'))
    const validHeaders = server.headers === undefined || (server.headers !== null && typeof server.headers === 'object' && !Array.isArray(server.headers) && Object.values(server.headers as object).every(item => typeof item === 'string'))
    const validCwd = server.cwd === undefined || typeof server.cwd === 'string'
    const validFlags = ['enabled', 'trusted'].every(key => server[key] === undefined || typeof server[key] === 'boolean')
    const validTimeout = server.timeoutMs === undefined || (typeof server.timeoutMs === 'number' && Number.isInteger(server.timeoutMs) && server.timeoutMs > 0)
    if (hasCommand === hasUrl || !validCommand || !validArgs || !validEnv || !validHeaders || !validCwd || !validFlags || !validTimeout) {
      logger.warn('[Config] Skipped invalid MCP server entry.')
      continue
    }
    valid[name] = {
      ...(hasCommand ? { command: server.command as string } : { url: server.url as string }),
      ...(server.args !== undefined ? { args: server.args as string[] } : {}),
      ...(server.env !== undefined ? { env: server.env as Record<string, string> } : {}),
      ...(server.headers !== undefined ? { headers: server.headers as Record<string, string> } : {}),
      ...(server.cwd !== undefined ? { cwd: server.cwd as string } : {}),
      enabled: server.enabled !== false,
      trusted: server.trusted === true,
      timeoutMs: server.timeoutMs as number || 60000
    }
  }
  return valid
}

export const DEFAULT_CONFIG: AgentConfig = {
  providers: {
    active: '9router',
    '9router': {
      base_url: 'http://127.0.0.1:20128/v1',
      api_key: '',
      model: 'ag/gemini-3.8-flash-medium',
      enabled: true
    }
  },
  max_iterations: 500,
  max_tokens_per_turn: 400_000,
  mcpServers: {},
  gateway: {
    // Background review may invoke a model and propose persistent skill/memory edits; set false to disable.
    background_review: true,
    background_review_interval: 5,
    telegram: { approval: 'dangerous', max_iterations: 60, turn_timeout_ms: 900_000 }
  },
  skills: {
    paths: [
      join(getVallenHome(), 'skills')
    ],
    disabled: [],
    enabled: []
  },
  terminal: {
    cwd: process.cwd()
  }
}

/** Known provider endpoints. Keys stay in the environment, never in config.json. */
export interface ProviderPreset {
  base_url: string
  model: string
  /** Environment variable that should hold the key ('' = no key needed, e.g. local Ollama). */
  env_key: string
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', env_key: 'OPENROUTER_API_KEY' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', env_key: 'OPENAI_API_KEY' },
  anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', env_key: 'ANTHROPIC_API_KEY' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', env_key: 'DEEPSEEK_API_KEY' },
  '9router': { base_url: 'http://127.0.0.1:20128/v1', model: 'ag/gemini-3.8-flash-medium', env_key: 'NINE_ROUTER_API_KEY' },
  ollama: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.1', env_key: '' }
}

/** Build a valid provider entry from a preset; the API key comes from env, not config.json. */
export function providerPresetConfig(name: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const preset = PROVIDER_PRESETS[name]
  if (!preset) throw new Error(`Unknown provider preset "${name}". Known presets: ${Object.keys(PROVIDER_PRESETS).join(', ')}`)
  const envValue = preset.env_key ? process.env[preset.env_key] : ''
  return {
    base_url: preset.base_url,
    api_key: envValue || '',
    model: preset.model,
    enabled: true,
    ...overrides
  }
}

/** Human-readable check of providers.active/base_url/api_key. */
export function validateProviderConfig(config: AgentConfig): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const providers = config.providers || ({} as AgentConfig['providers'])
  const active = providers.active
  if (!active) errors.push('providers.active is not set.')
  const provider = active ? providers[active] : undefined
  if (active && (!provider || typeof provider === 'string')) {
    errors.push(`providers.active "${active}" does not exist in providers. Known: ${Object.keys(providers).filter(key => key !== 'active').join(', ') || '(none)'}`)
    return { ok: false, errors, warnings }
  }
  if (provider && typeof provider === 'object') {
    const baseUrl = String(provider.base_url || '').trim()
    if (!baseUrl) errors.push(`Provider "${active}" has an empty base_url; set providers.${active}.base_url.`)
    else {
      try {
        const parsed = new URL(baseUrl)
        if (!/^https?:$/.test(parsed.protocol)) errors.push(`Provider "${active}" base_url must be http(s): ${baseUrl}`)
      } catch {
        errors.push(`Provider "${active}" base_url is not a valid URL: ${baseUrl}`)
      }
    }
    const preset = active ? PROVIDER_PRESETS[active] : undefined
    if (!provider.api_key) {
      const envKey = preset?.env_key
      const envValue = envKey ? process.env[envKey] : ''
      if (envKey && !envValue) warnings.push(`Provider "${active}" has no api_key: set ${envKey} in the environment (or providers.${active}.api_key). Keys are never written to config.json.`)
      else if (!envKey) warnings.push(`Provider "${active}" has no api_key; set providers.${active}.api_key or its environment variable.`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

export function getVallenHome(): string {
  if (process.env.VALLENEMPEROR_HOME) return process.env.VALLENEMPEROR_HOME
  return join(homedir(), '.vallenemperor')
}

function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (path.startsWith('$VALLENEMPEROR_HOME/')) {
    return join(getVallenHome(), path.slice(20))
  }
  return path
}

export function loadConfig(): AgentConfig {
  const home = getVallenHome()
  const configPath = join(home, 'config.json')
  
  if (!existsSync(configPath)) {
    return { ...structuredClone(DEFAULT_CONFIG), skills: { ...DEFAULT_CONFIG.skills, paths: [join(home, 'skills')] }, terminal: { cwd: process.cwd() } }
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const userConfig = JSON.parse(raw)
    
    // Deep-merge providers: merge each provider key's nested config
    const mergedProviders = { ...DEFAULT_CONFIG.providers }
    if (userConfig.providers) {
      for (const [key, value] of Object.entries(userConfig.providers)) {
        if (key === 'active') {
          mergedProviders.active = value as string
        } else if (value && typeof value === 'object') {
          const existing = mergedProviders[key]
          mergedProviders[key] = (typeof existing === 'object' 
            ? { ...existing, ...value as ProviderConfig }
            : value) as ProviderConfig
        } else {
          mergedProviders[key] = value as string | ProviderConfig
        }
      }
    }
    
    // Deep merge with defaults
    const merged: AgentConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      mcpServers: validateMcpServers(userConfig.mcpServers),
      providers: mergedProviders,
      skills: {
        ...DEFAULT_CONFIG.skills,
        paths: [join(home, 'skills')],
        ...userConfig.skills
      },
      gateway: {
        ...DEFAULT_CONFIG.gateway,
        ...userConfig.gateway,
        telegram: {
          ...DEFAULT_CONFIG.gateway?.telegram,
          ...userConfig.gateway?.telegram
        }
      },
      // BUG-10: Always use current cwd, never persisted value
      terminal: {
        cwd: process.cwd()
      }
    }

    if (merged.skills?.paths) {
      merged.skills.paths = merged.skills.paths.map(expandPath)
    }

    return merged
  } catch (err) {
    logger.error('[Config] Failed to load, using defaults:', err)
    return { ...structuredClone(DEFAULT_CONFIG), terminal: { cwd: process.cwd() } }
  }
}

export function saveConfig(updates: Partial<AgentConfig>): AgentConfig {
  const current = loadConfig()
  const home = getVallenHome()
  const configPath = join(home, 'config.json')

  // Deep-merge providers: merge each provider key's nested config
  const mergedProviders = { ...current.providers }
  if (updates.providers) {
    for (const [key, value] of Object.entries(updates.providers)) {
      if (key === 'active') {
        mergedProviders.active = value as string
      } else if (value && typeof value === 'object') {
        const existing = mergedProviders[key]
        mergedProviders[key] = (typeof existing === 'object' 
          ? { ...existing, ...value as ProviderConfig }
          : value) as ProviderConfig
      } else {
        mergedProviders[key] = value as string | ProviderConfig
      }
    }
  }

  const updated: AgentConfig = {
    ...current,
    ...updates,
    providers: mergedProviders,
    skills: {
      ...current.skills,
      ...(updates.skills || {})
    },
    gateway: {
      ...current.gateway,
      ...(updates.gateway || {}),
      telegram: {
        ...current.gateway?.telegram,
        ...(updates.gateway?.telegram || {})
      }
    }
    // BUG-10: Never persist terminal.cwd (runtime state)
  }

  mkdirSync(home, { recursive: true })
  chmodSafe(home, 0o700)
  
  // BUG-10: Write config with 0600 permissions (API keys inside)
  const existingConfig = existsSync(configPath)
  if (existingConfig) {
    const oldContent = readFileSync(configPath, 'utf-8')
    try {
      const parsed = JSON.parse(oldContent)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config root must be an object')
    } catch {
      let suffix = 0
      let corruptPath: string
      do {
        corruptPath = `${configPath}.corrupt-${Date.now()}${suffix ? `-${suffix}` : ''}`
        suffix++
      } while (existsSync(corruptPath))
      renameSync(configPath, corruptPath)
      logger.warn(`[Config] Invalid config quarantined at ${corruptPath}; save aborted to protect existing settings and backup.`)
      throw new Error(`Refusing to overwrite corrupt config; inspect ${corruptPath} and restore or remove it first.`)
    }
    // Secure legacy config before copying secrets into backup.
    chmodSafe(configPath, 0o600)
    // Backup only valid config, never overwrite known-good backup with corrupt bytes.
    const backupPath = configPath + '.bak'
    writeFileSync(backupPath, oldContent, { mode: 0o600 })
  }
  
  const { terminal: _runtimeTerminal, ...persisted } = updated
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(persisted, null, 2), { mode: 0o600 })
  chmodSafe(tmpPath, 0o600)
  renameSync(tmpPath, configPath)
  return updated
}

export function setProviderToken(providerName: string, apiKey: string): AgentConfig {
  const current = loadConfig()
  const provider = current.providers[providerName] as ProviderConfig | undefined
  if (!provider || typeof provider === 'string') {
    current.providers[providerName] = {
      base_url: 'http://localhost:20128/v1',
      api_key: apiKey,
      model: 'ag/gemini-3.8-flash-medium',
      enabled: true
    }
  } else {
    provider.api_key = apiKey
    provider.enabled = true
  }
  return saveConfig(current)
}

export function getActiveProvider(config: AgentConfig): { name: string } & ProviderConfig {
  const activeName = config.providers.active
  const provider = config.providers[activeName]
  
  if (!provider || typeof provider === 'string') {
    throw new Error(`Active provider "${activeName}" not found in config`)
  }
  
  if (!provider.enabled) {
    throw new Error(`Provider "${activeName}" is disabled`)
  }

  const baseUrl = String(provider.base_url || '').trim()
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`Provider "${activeName}" has no valid base_url (got ${JSON.stringify(baseUrl)}); set providers.${activeName}.base_url.`)
  }
  const preset = PROVIDER_PRESETS[activeName]
  if (!provider.api_key && preset?.env_key && !process.env[preset.env_key]) {
    logger.warn(`[Config] Provider "${activeName}" has no api_key: set ${preset.env_key} or run the provider setup.`)
  }

  return { name: activeName, ...provider }
}
