// Slash-command registry and fuzzy suggestion engine for VallenCLI.
// Pure logic (no I/O) so it is easy to test.

// args: "<x>" = required argument, "[x]" = optional argument.
// fillOnly: Enter completes the command but never runs it (destructive / starts an agent turn).
export const COMMANDS = [
  { name: '/help', desc: 'Show this help' },
  { name: '/model', args: '[name]', desc: 'Pick provider/model live, or switch directly' },
  { name: '/token', args: '[status]', desc: 'Set 9router token (hidden input)' },
  { name: '/stop', desc: 'Interrupt active turn' },
  { name: '/exit', aliases: ['/quit'], desc: 'Exit VallenCLI' },
  { name: '/new', aliases: ['/reset'], desc: 'Start a fresh conversation' },
  { name: '/sessions', desc: 'List saved sessions' },
  { name: '/resume', args: '<number>', desc: 'Resume a session by number' },
  { name: '/stats', aliases: ['/status', '/context'], desc: 'Show telemetry and context use' },
  { name: '/search', args: '<query>', desc: 'Search saved sessions' },
  { name: '/memory', desc: 'Show persistent memory' },
  { name: '/todos', desc: 'Show task list' },
  { name: '/tools', desc: 'List available tools' },
  { name: '/skills', args: '[help|search|install]', desc: 'Search, install and manage skills' },
  { name: '/review', args: '[log]', desc: 'Run review or show review history' },
  { name: '/session', args: 'clearall', desc: 'Delete saved sessions', fillOnly: true },
  { name: '/output', desc: 'Expand the latest terminal output' },
  { name: '/gateway', args: '[wa|tel ...]', desc: 'Gateway status and control' },
  { name: '/settings', desc: 'Display settings' },
  { name: '/schedule', args: '[list|history|add|remove]', desc: 'Manage scheduled agent jobs' },
  { name: '/agents', args: '[available|show|stop|clean]', desc: 'Subagent panel + custom agents' },
  { name: '/browser', args: '<task>', desc: 'Unlock browser tools and run a browser task' },
  { name: '/learn', args: '[source]', desc: 'Author a skill from a source' },
  { name: '/grill-me', args: '[task]', desc: 'Interview before building' },
  { name: '/plan', args: '[task|go|next|edit|skip|stop|status]', desc: 'Plan mode: write a plan, then run it step by step', fillOnly: true },
  { name: '/plans', desc: 'List saved plans' },
  { name: '/gamedev', args: '[off]', desc: 'Toggle game-development mode' },
  { name: '/cd', args: '<path>', desc: 'Change project folder' },
  { name: '/mcp', args: '[subcommand]', desc: 'Manage MCP servers and tools' },
  { name: '/project', desc: 'Show project instructions/context' },
  { name: '/init', args: '[confirm]', desc: 'Preview/save VALLEN.md after review' },
  { name: '/checkpoints', desc: 'List file checkpoints' },
  { name: '/diff', args: '[turn]', desc: 'Show checkpoint diff' },
  { name: '/undo', args: '[count]', desc: 'Restore file checkpoints', fillOnly: true },
  { name: '/compact', desc: 'Compact conversation history' },
  { name: '/auto', args: '[on|safe|off]', desc: 'Set tool approval mode' },
  { name: '/artifact', args: '[n|last]', desc: 'Review artifacts' },
  { name: '/codesearch', args: '<query>', desc: 'Search workspace code' },
  { name: '/copy', args: '[n]', desc: 'Copy last reply' },
  { name: '/save', args: '[md|json] [file] [redact]', desc: 'Export transcript' },
  { name: '/title', args: '[name]', desc: 'Name this session' },
  { name: '/history', args: '[n]', desc: 'Recent messages' },
  { name: '/prompt', desc: 'Compose in $EDITOR' },
  { name: '/commands', desc: 'Custom commands' },
  { name: '/steer', args: '<note>', desc: 'Mid-turn note' },
  { name: '/queue', args: '[add|list|rm|clear]', desc: 'Prompt queue' },
  { name: '/rewind', args: '[n|fork n]', desc: 'Rewind to a prompt' },
  { name: '/goal', args: '[text|status|pause|resume|clear]', desc: 'Standing goal loop' },
  { name: '/effort', args: '[low|medium|high]', desc: 'Reasoning effort' },
  { name: '/artifacts', desc: 'List session artifacts' },
  { name: '/btw', args: '<question>', desc: 'Side question, clean context' },
  { name: '/fork', desc: 'Clone conversation to a new session' },
  { name: '/sandbox', args: '[status|workspace|off]', desc: 'Filesystem write boundary' },
  { name: '/permissions', desc: 'Effective permission summary' },
  { name: '/policy', args: '[tool] [allow|ask|deny]', desc: 'Per-tool policy' },
  { name: '/worktree', args: '[new|list]', desc: 'Git worktree for this session' },
  { name: '/health', desc: 'Run diagnostics' },
  { name: '/perf', desc: 'Process CPU / memory sample' },
  { name: '/clear', desc: 'Clear the screen' },
  { name: '/theme', aliases: ['/themes'], args: '[name]', desc: 'Show or switch color theme' },
  { name: '/sh', aliases: ['/pty'], desc: 'Enter a direct shell' }
]

// Category per command (colours the marker dot in the dropdown).
const CATEGORY = {
  chat: ['/help', '/stop', '/exit', '/clear', '/theme'],
  agent: ['/model', '/token', '/new', '/sessions', '/resume', '/stats', '/search', '/memory', '/todos', '/tools', '/skills', '/review', '/session', '/plan', '/plans', '/gamedev', '/compact', '/auto', '/schedule'],
  workspace: ['/cd', '/mcp', '/project', '/init', '/checkpoints', '/diff', '/undo', '/sh', '/output'],
  system: ['/health', '/perf']
}
const categoryOf = name => Object.keys(CATEGORY).find(key => CATEGORY[key].includes(name)) || 'system'

// One row per name or alias, remembering the primary command.
const ENTRIES = COMMANDS.flatMap((command, index) => [command.name, ...(command.aliases || [])].map(name => ({
  name,
  primary: command.name,
  args: command.args || '',
  desc: name === command.name ? command.desc : `${command.desc} (alias of ${command.name})`,
  fillOnly: Boolean(command.fillOnly),
  cat: categoryOf(command.name),
  isAlias: name !== command.name,
  order: index
})))

export function findCommand(name) {
  const key = String(name || '').toLowerCase()
  return ENTRIES.find(entry => entry.name === key) || null
}

// Does Enter need to wait for the user (required arg, or fill-only command)?
export function needsMoreInput(entry) {
  return Boolean(entry && (entry.fillOnly || entry.args.includes('<')))
}

// Optimal string alignment distance (Levenshtein + adjacent transposition).
export function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const d = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

function subsequenceSpan(query, text) {
  let from = 0
  let first = -1
  let last = -1
  for (const char of query) {
    const at = text.indexOf(char, from)
    if (at === -1) return -1
    if (first === -1) first = at
    last = at
    from = at + 1
  }
  return last - first + 1
}

function nearestDistance(query, name) {
  return Math.min(editDistance(query, name), editDistance(query, name.slice(0, query.length)))
}

function scoreEntry(query, entry) {
  const name = entry.name.slice(1)
  if (name === query) return 1000
  if (name.startsWith(query)) return 900 - (name.length - query.length)
  const at = name.indexOf(query)
  if (at !== -1) return 700 - at * 10 - (name.length - query.length)
  const span = query.length >= 2 ? subsequenceSpan(query, name) : -1
  if (span !== -1) return 500 - (span - query.length) * 15 - (name.length - query.length)
  // Small typos ("hlep" -> help) still count as a real match.
  const limit = query.length <= 2 ? 0 : query.length <= 5 ? 1 : 2
  const distance = nearestDistance(query, name)
  return limit > 0 && distance <= limit ? 400 - distance * 60 - Math.abs(name.length - query.length) : 0
}

// Returns suggestions for a token such as "/tis", best match first.
export function suggestCommands(token, limit = 40) {
  const text = String(token || '')
  if (!text.startsWith('/')) return []
  const query = text.slice(1).toLowerCase()
  if (!query) return ENTRIES.filter(entry => !entry.isAlias).slice(0, limit)
  const tweak = entry => entry.order * 0.001 + (entry.isAlias ? 0.5 : 0)
  const strong = ENTRIES
    .map(entry => ({ ...entry, score: scoreEntry(query, entry) - tweak(entry) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  if (strong.length) return strong.slice(0, limit)
  // Nothing matches well: still offer the closest few so the list is never a dead end.
  if (query.length < 3) return []
  return ENTRIES
    .map(entry => ({ ...entry, distance: nearestDistance(query, entry.name.slice(1)) }))
    .filter(entry => entry.distance <= query.length - 1)
    .map(entry => ({ ...entry, rank: entry.distance * 10 + (entry.name[1] === query[0] ? 0 : 5) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, 3)
    .map(entry => ({ ...entry, score: 1, fuzzy: true }))
}

// A line is a "command token" only while it is a single word: "/he" yes, "/cd x" no, "/home/me" no.
export function commandToken(line) {
  return /^\/[A-Za-z0-9_-]*$/.test(String(line || '')) ? String(line) : null
}

// Character positions of `query` inside `name` for highlighting: contiguous match first, else in-order subsequence; [] when none.
export function matchPositions(query, name) {
  const q = String(query || '').toLowerCase()
  const n = String(name || '').toLowerCase()
  if (!q) return []
  const at = n.indexOf(q)
  if (at !== -1) return Array.from({ length: q.length }, (_, i) => at + i)
  const found = []
  let from = 0
  for (const char of q) {
    const i = n.indexOf(char, from)
    if (i === -1) return []
    found.push(i)
    from = i + 1
  }
  return found
}
