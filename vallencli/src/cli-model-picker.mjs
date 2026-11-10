// Two-level model picker for VallenCLI.
//
// `/model` (no argument) asks the active gateway for its model list and lets the user pick
// provider/account first, then the model — arrow keys, Enter to choose, Esc to go back.
// Pure state machine + fetch, so it is testable without a terminal or network.

/** Friendly names for gateway account ids; anything else is shown as-is. */
export const OWNER_LABELS = {
  ag: 'antigravity',
  kc: 'kiro'
}

export function ownerLabel(owner) {
  const key = String(owner || '').trim()
  if (!key) return 'other'
  return OWNER_LABELS[key] || key
}

/** Group a flat `/v1/models` payload by its `owned_by` account. */
export function groupModelsByOwner(models) {
  const groups = new Map()
  for (const raw of Array.isArray(models) ? models : []) {
    const id = String(raw?.id || '').trim()
    if (!id) continue
    const owner = String(raw?.owner || raw?.owned_by || 'other').trim() || 'other'
    if (!groups.has(owner)) groups.set(owner, { owner, label: ownerLabel(owner), models: [] })
    groups.get(owner).models.push({
      id,
      context: Number(raw?.context || 0),
      maxOutput: Number(raw?.maxOutput || 0),
      tools: Boolean(raw?.tools),
      vision: Boolean(raw?.vision)
    })
  }
  const list = [...groups.values()]
  for (const group of list) group.models.sort((a, b) => a.id.localeCompare(b.id))
  return list.sort((a, b) => b.models.length - a.models.length || a.label.localeCompare(b.label))
}

/** Normalize an OpenAI-compatible `/v1/models` payload into picker entries. */
export function normalizeGatewayModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return list.map(entry => ({
    id: String(entry?.id || '').trim(),
    owner: String(entry?.owned_by || entry?.owner || 'other').trim() || 'other',
    context: Number(entry?.context_length || entry?.context || 0),
    maxOutput: Number(entry?.max_completion_tokens || entry?.maxOutput || 0),
    tools: Boolean(entry?.capabilities?.tools ?? entry?.tools),
    vision: Boolean(entry?.capabilities?.vision ?? entry?.vision)
  })).filter(model => model.id)
}

/**
 * Fetch models from an OpenAI-compatible gateway (9router included).
 * Never throws: returns `{ ok: false, error }` so the CLI can fall back to a manual name.
 */
export async function fetchGatewayModels({ baseUrl, apiKey = '', timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!root) return { ok: false, error: 'base_url provider kosong' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch tidak tersedia' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 15000))
  timer.unref?.()
  try {
    const response = await fetchImpl(`${root}/models`, {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: controller.signal
    })
    if (!response?.ok) return { ok: false, error: `HTTP ${response?.status ?? '?'}` }
    const models = normalizeGatewayModels(await response.json())
    if (!models.length) return { ok: false, error: 'gateway mengembalikan 0 model' }
    return { ok: true, models }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, error: aborted ? `timeout ${Math.round(timeoutMs)}ms` : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

export function createPickerState(groups) {
  return {
    groups: Array.isArray(groups) ? groups : [],
    level: 'owner',
    ownerIndex: 0,
    modelIndex: 0,
    query: '',
    rows: 0
  }
}

function currentGroup(state) {
  const groups = visibleGroups(state)
  if (!groups.length) return null
  const index = Math.min(Math.max(0, state.ownerIndex), groups.length - 1)
  return groups[index]
}

/** Groups matching the current query (label, owner id, or any model id). */
export function visibleGroups(state) {
  const query = String(state?.query || '').trim().toLowerCase()
  if (!query) return state?.groups || []
  return (state?.groups || []).filter(group =>
    group.label.toLowerCase().includes(query) ||
    group.owner.toLowerCase().includes(query) ||
    group.models.some(model => model.id.toLowerCase().includes(query))
  )
}

/** Models of the selected group, filtered by the query when one is typed. */
export function visibleModels(state) {
  const group = currentGroup(state)
  if (!group) return []
  const query = String(state?.query || '').trim().toLowerCase()
  if (!query) return group.models
  return group.models.filter(model => model.id.toLowerCase().includes(query))
}

function clampIndexes(state) {
  const groups = visibleGroups(state)
  state.ownerIndex = Math.min(Math.max(0, state.ownerIndex), Math.max(0, groups.length - 1))
  const models = visibleModels(state)
  state.modelIndex = Math.min(Math.max(0, state.modelIndex), Math.max(0, models.length - 1))
}

export function movePicker(state, delta) {
  const step = delta < 0 ? -1 : 1
  const list = state.level === 'owner' ? visibleGroups(state) : visibleModels(state)
  if (!list.length) return state
  if (state.level === 'owner') {
    state.ownerIndex = (state.ownerIndex + step + list.length) % list.length
    state.modelIndex = 0
  } else {
    state.modelIndex = (state.modelIndex + step + list.length) % list.length
  }
  return state
}

/** Enter: owner level descends into the model list, model level returns the choice. */
export function enterPicker(state) {
  if (state.level === 'owner') {
    const group = currentGroup(state)
    if (!group) return { done: false }
    state.level = 'model'
    state.modelIndex = 0
    state.query = ''
    return { done: false }
  }
  const models = visibleModels(state)
  const model = models[state.modelIndex]
  if (!model) return { done: false }
  return { done: true, model: model.id }
}

/** Esc: model level goes back to the provider list, owner level closes the picker. */
export function backPicker(state) {
  if (state.level === 'model') {
    state.level = 'owner'
    state.query = ''
    return { closed: false }
  }
  return { closed: true }
}

/** Typing filters the current level; the selection resets to the top. */
export function typeInPicker(state, text) {
  const addition = String(text || '').replace(/[\x00-\x1f\x7f]/g, '')
  if (!addition) return state
  state.query += addition
  state.ownerIndex = 0
  state.modelIndex = 0
  clampIndexes(state)
  return state
}

export function backspacePicker(state) {
  state.query = state.query.slice(0, -1)
  state.ownerIndex = 0
  state.modelIndex = 0
  clampIndexes(state)
  return state
}

const ctxLabel = model => {
  if (!model.context) return ''
  return `${Math.round(model.context / 1000)}k ctx`
}

/**
 * Render the picker. Returns plain lines plus the index of the highlighted row,
 * so the caller can color it without this module knowing about ANSI.
 */
export function pickerLines(state, { width = 80, maxRows = 12 } = {}) {
  const group = currentGroup(state)
  const lines = []
  const query = String(state.query || '').trim()
  const hint = state.level === 'owner'
    ? '↑/↓ pilih provider · Enter lanjut · Esc batal'
    : '↑/↓ pilih model · Enter pasang · Esc kembali · ketik untuk cari'
  lines.push(`  ${state.level === 'owner' ? 'Pilih provider/akun' : `Model di ${group?.label || '?'}`}${query ? ` · filter "${query}"` : ''} · ${hint}`)
  lines.push(`  ${'─'.repeat(Math.max(10, Math.min(width - 4, 72)))}`)

  const list = state.level === 'owner' ? visibleGroups(state) : visibleModels(state)
  if (!list.length) {
    lines.push('  (tidak ada yang cocok — Backspace untuk hapus filter, Esc untuk kembali)')
    return { lines, selectedIndex: -1 }
  }

  const index = state.level === 'owner' ? state.ownerIndex : state.modelIndex
  const window = Math.max(3, maxRows)
  const start = Math.min(Math.max(0, index - Math.floor(window / 2)), Math.max(0, list.length - window))
  const slice = list.slice(start, start + window)
  let selectedIndex = -1
  slice.forEach((entry, offset) => {
    const position = start + offset
    const selected = position === index
    const marker = selected ? '❯' : ' '
    if (state.level === 'owner') {
      const label = entry.label === entry.owner ? entry.owner : `${entry.label} (${entry.owner})`
      lines.push(`  ${marker} ${label.padEnd(30)} ${String(entry.models.length).padStart(3)} model`)
    } else {
      const meta = [ctxLabel(entry), entry.tools ? 'tools' : '', entry.vision ? 'vision' : ''].filter(Boolean).join(' · ')
      lines.push(`  ${marker} ${entry.id}${meta ? `  ${meta}` : ''}`)
    }
    if (selected) selectedIndex = lines.length - 1
  })
  if (list.length > slice.length) {
    lines.push(`  … ${start > 0 ? '↑ ' : ''}${start + slice.length < list.length ? '↓ ' : ''}${list.length} total`)
  }
  return { lines, selectedIndex }
}

/** Non-interactive fallback: a readable list instead of a picker. */
export function formatModelCatalog(groups, { maxModelsPerGroup = 4, currentModel = '' } = {}) {
  const lines = []
  for (const group of groups) {
    const label = group.label === group.owner ? group.owner : `${group.label} (${group.owner})`
    lines.push(`${label} · ${group.models.length} model`)
    for (const model of group.models.slice(0, maxModelsPerGroup)) {
      lines.push(`  ${model.id === currentModel ? '* ' : '  '}${model.id}`)
    }
    if (group.models.length > maxModelsPerGroup) lines.push(`  … ${group.models.length - maxModelsPerGroup} lainnya`)
  }
  return lines.join('\n')
}
