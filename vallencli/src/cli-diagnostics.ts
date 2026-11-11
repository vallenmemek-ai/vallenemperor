import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { platform, release } from 'node:os'

/**
 * Offline diagnostics: `prompt-size`, `insights`, `logs`, `dump`.
 * Everything reads local files or the tool registry — no model calls, no network.
 */

export function promptSizeReport({ systemPrompt = '', toolSchemas = [], skills = [] } = {}) {
  const tokens = text => Math.ceil(String(text || '').length / 4)
  const schemaChars = toolSchemas.reduce((total, schema) => total + String(schema).length, 0)
  const skillChars = skills.reduce((total, skill) => total + String(skill.name || '').length + String(skill.description || '').length + 8, 0)
  const lines = [
    'Prompt size (offline estimate, chars/4)',
    `  system prompt : ~${tokens(systemPrompt).toLocaleString()} tokens (${systemPrompt.length.toLocaleString()} chars)`,
    `  tool schemas  : ~${tokens(schemaChars).toLocaleString()} tokens (${toolSchemas.length} tools)`,
    `  skills index  : ~${tokens(skillChars).toLocaleString()} tokens (${skills.length} skills)`,
    `  total fixed   : ~${(tokens(systemPrompt) + tokens(schemaChars) + tokens(skillChars)).toLocaleString()} tokens`
  ]
  return lines.join('\n')
}

export function insightsReport({ sessions = [], now = Date.now() } = {}) {
  if (!sessions.length) return 'No saved sessions yet.'
  const turns = sessions.reduce((total, session) => total + Number(session.turns || session.messageCount || 0), 0)
  const recent = sessions.filter(session => {
    const stamp = Date.parse(session.updatedAt || session.createdAt || '') || 0
    return stamp && now - stamp < 7 * 24 * 60 * 60 * 1000
  })
  return [
    `Sessions: ${sessions.length} total · ${recent.length} in the last 7 days`,
    `Messages: ${turns.toLocaleString()}`,
    ...sessions.slice(0, 5).map(session => `  ${session.id || session.sessionId || '(id)'} · ${session.title || 'untitled'} · ${session.turns || session.messageCount || 0} msgs`)
  ].join('\n')
}

export function listLogs(home) {
  const dir = join(home, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => !name.startsWith('.'))
    .map(name => {
      const path = join(dir, name)
      let size = 0
      try { size = statSync(path).size } catch { }
      return { name, path, size }
    })
    .sort((a, b) => b.size - a.size)
}

export function dumpReport({ config, version, home }) {
  const redacted = JSON.parse(JSON.stringify(config || {}))
  if (redacted.providers) {
    for (const value of Object.values(redacted.providers)) {
      if (value && typeof value === 'object' && 'api_key' in value) value.api_key = value.api_key ? '***set***' : ''
    }
  }
  return [
    'VallenEmperor dump (safe to paste)',
    `  version : ${version}`,
    `  platform: ${platform()} ${release()}`,
    `  node    : ${process.version}`,
    `  home    : ${home}`,
    '  config  :',
    ...JSON.stringify(redacted, null, 2).split('\n').map(line => `    ${line}`)
  ].join('\n')
}
