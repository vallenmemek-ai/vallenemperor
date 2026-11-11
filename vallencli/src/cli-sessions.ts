import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SessionManager } from '../../vallenagent/dist/session/session.js'
import { exportSession } from '../../vallenagent/dist/agent/session_export.js'

/**
 * `vallenemperor sessions [list|show <id>|export <id> [md|json] [file]|prune <n>]`
 * Browse, inspect, export and prune saved sessions without starting an agent.
 */

function manager() {
  return new SessionManager()
}

export function runSessionsCommand({ args = [], stdout = process.stdout, cwd = process.cwd() } = {}) {
  const [action = 'list', id, formatArg, fileArg] = args
  const sessions = manager()

  if (action === 'list') {
    const list = sessions.listSessions()
    if (!list.length) { stdout.write('No saved sessions yet.\n'); return 0 }
    stdout.write(`${list.length} session(s)\n`)
    for (const session of list.slice(0, 20)) {
      stdout.write(`  ${session.id}  ${session.updated_at || session.created_at || ''}  ${session.title || 'untitled'}\n`)
    }
    return 0
  }

  if (action === 'show') {
    if (!id) { stdout.write('Usage: vallenemperor sessions show <id>\n'); return 2 }
    const data = sessions.loadSession(id)
    if (!data) { stdout.write(`No session ${id}.\n`); return 1 }
    stdout.write(`Session ${data.id}\n  title: ${data.title}\n  model: ${data.model}\n  cwd: ${data.cwd}\n  messages: ${data.messages.length}\n`)
    return 0
  }

  if (action === 'export') {
    if (!id) { stdout.write('Usage: vallenemperor sessions export <id> [md|json] [file]\n'); return 2 }
    const data = sessions.loadSession(id)
    if (!data) { stdout.write(`No session ${id}.\n`); return 1 }
    const format = formatArg === 'json' ? 'json' : 'md'
    const content = exportSession({ messages: data.messages, sessionId: data.id, model: data.model, title: data.title, format, redact: true })
    if (fileArg) {
      const target = resolve(cwd, fileArg)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, { mode: 0o600 })
      stdout.write(`Exported ${data.id} to ${target}\n`)
    } else {
      stdout.write(`${content}\n`)
    }
    return 0
  }

  if (action === 'prune') {
    const keep = Math.max(1, Number(id) || 10)
    const list = sessions.listSessions()
    if (list.length <= keep) { stdout.write(`Nothing to prune (${list.length} session(s), keeping ${keep}).\n`); return 0 }
    const remove = list.slice(keep)
    let removed = 0
    for (const session of remove) if (sessions.deleteSession(session.id)) removed++
    stdout.write(`Pruned ${removed} session(s); kept the newest ${keep}.\n`)
    return 0
  }

  stdout.write('Usage: vallenemperor sessions [list|show <id>|export <id> [md|json] [file]|prune <n>]\n')
  return 2
}
