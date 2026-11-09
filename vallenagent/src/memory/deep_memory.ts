import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { viewSession } from '../session/session_search'
import { chmodSafe } from '../core/platform'

export interface DeepMemoryFact {
  fact: string
  source_session: string
  created_at: string
  expires_at?: string
}

type DeepMemoryHistory = {
  fact: string
  source_session: string
  action: 'replaced' | 'forgotten'
  changed_at: string
  replacement?: string
  replacement_source_session?: string
}
type MemoryFile = { version: 2; entries: DeepMemoryFact[]; history: DeepMemoryHistory[] }

const MAX_FACTS = 500
const MAX_HISTORY = 500
const WORDS = /[\p{L}\p{N}_-]{3,}/gu
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=]|gh[pousr]_[A-Za-z0-9]{20,})/i
const INJECTION = /ignore\s+(?:all\s+)?previous\s+instructions|\byou\s+are\s+now\b|\bsystem\s+prompt\b|\bdisregard\b/i

function normalize(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ') }
function terms(value: string): Set<string> { return new Set(value.toLocaleLowerCase().match(WORDS) || []) }

export class DeepMemoryStore {
  private readonly file: string

  constructor(file = join(process.env.VALLENEMPEROR_HOME || join(homedir(), '.vallenemperor'), 'memories', 'DEEP_MEMORY.json')) {
    this.file = file
  }

  private read(): MemoryFile {
    let parsed: any
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 2, entries: [], history: [] }
      throw new Error('Deep memory file is corrupt; refusing writes to preserve existing data.')
    }
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries))) {
      throw new Error('Deep memory file is invalid; refusing writes to preserve existing data.')
    }
    const raw = Array.isArray(parsed) ? parsed : parsed.entries
    const entries = raw.filter((item: any) => typeof item?.fact === 'string' && typeof item?.source_session === 'string')
    const history = !Array.isArray(parsed) && Array.isArray(parsed.history)
      ? parsed.history.filter((item: any) => typeof item?.fact === 'string' && typeof item?.source_session === 'string')
      : []
    return { version: 2, entries: entries.slice(-MAX_FACTS), history: history.slice(-MAX_HISTORY) }
  }

  private write(data: MemoryFile): void {
    const dir = join(this.file, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSafe(dir, 0o700)
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify({ ...data, entries: data.entries.slice(-MAX_FACTS), history: data.history.slice(-MAX_HISTORY) }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSafe(temp, 0o600)
    try { renameSync(temp, this.file) } catch (error) { try { unlinkSync(temp) } catch {}; throw error }
  }

  private validate(fact: string, sourceSession: string, expiresAt?: string): string | null {
    const value = fact.trim()
    if (!value || value.length > 500) return 'Fact must contain 1-500 characters.'
    if (/[\u0000-\u001f\u007f]/.test(value)) return 'Fact contains control characters.'
    if (INJECTION.test(value)) return 'Fact resembles prompt injection.'
    if (SECRET.test(value)) return 'Fact may contain a secret.'
    if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) return 'Expiry must be a valid date.'
    if (typeof sourceSession !== 'string' || !sourceSession || sourceSession.length > 200) return 'Source session ID is invalid.'
    const session = viewSession(sourceSession, { offset: 0, limit: 100 })
    if (!session) return 'Source session not found.'
    if (!session.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(value))) {
      return 'Fact must be quoted from a user message in source_session.'
    }
    return null
  }

  add(fact: string, sourceSession: string, expiresAt?: string): { success?: boolean; error?: string } {
    const value = fact.trim()
    const error = this.validate(value, sourceSession, expiresAt)
    if (error) return { error }
    let data: MemoryFile
    try { data = this.read() } catch (error: any) { return { error: error.message || 'Deep memory is unreadable.' } }
    if (data.entries.some(entry => normalize(entry.fact) === normalize(value))) return { success: true }
    if (data.entries.length >= MAX_FACTS) return { error: 'Deep memory is full; forget an outdated fact first.' }
    data.entries.push({ fact: value, source_session: sourceSession, created_at: new Date().toISOString(), ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}) })
    this.write(data)
    return { success: true }
  }

  replace(oldFact: string, fact: string, sourceSession: string, expiresAt?: string): { success?: boolean; error?: string } {
    const value = fact.trim()
    const error = this.validate(value, sourceSession, expiresAt)
    if (error) return { error }
    let data: MemoryFile
    try { data = this.read() } catch (error: any) { return { error: error.message || 'Deep memory is unreadable.' } }
    const index = data.entries.findIndex(entry => normalize(entry.fact) === normalize(oldFact))
    if (index < 0) return { error: 'Fact not found.' }
    if (data.entries.some((entry, i) => i !== index && normalize(entry.fact) === normalize(value))) return { error: 'Replacement fact already exists.' }
    const prior = data.entries[index]
    data.history.push({ fact: prior.fact, source_session: prior.source_session, action: 'replaced', changed_at: new Date().toISOString(), replacement: value, replacement_source_session: sourceSession })
    data.entries[index] = { fact: value, source_session: sourceSession, created_at: new Date().toISOString(), ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}) }
    this.write(data)
    return { success: true }
  }

  forget(fact: string): { success?: boolean; error?: string } {
    let data: MemoryFile
    try { data = this.read() } catch (error: any) { return { error: error.message || 'Deep memory is unreadable.' } }
    const index = data.entries.findIndex(entry => normalize(entry.fact) === normalize(fact))
    if (index < 0) return { error: 'Fact not found.' }
    const [removed] = data.entries.splice(index, 1)
    data.history.push({ fact: removed.fact, source_session: removed.source_session, action: 'forgotten', changed_at: new Date().toISOString() })
    this.write(data)
    return { success: true }
  }

  search(query: string, limit = 10): DeepMemoryFact[] {
    const queryTerms = terms(query)
    if (!queryTerms.size) return []
    const now = Date.now()
    let entries: DeepMemoryFact[]
    try { entries = this.read().entries } catch { return [] }
    return entries
      .filter(entry => !entry.expires_at || Date.parse(entry.expires_at) > now)
      .map(entry => {
        const factTerms = terms(entry.fact)
        const overlap = [...queryTerms].filter(term => factTerms.has(term)).length
        if (!overlap) return { entry, score: 0 }
        const precision = overlap / factTerms.size
        const recall = overlap / queryTerms.size
        const score = 2 * precision * recall / (precision + recall) + (entry.fact.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 0.2 : 0)
        return { entry, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.entry.created_at) - Date.parse(a.entry.created_at))
      .slice(0, Math.max(1, Math.min(20, Math.floor(Number(limit) || 10))))
      .map(item => item.entry)
  }

  list(): DeepMemoryFact[] {
    try { return this.read().entries.filter(entry => !entry.expires_at || Date.parse(entry.expires_at) > Date.now()) } catch { return [] }
  }
  history(): DeepMemoryHistory[] {
    try { return this.read().history } catch { return [] }
  }
}
