import { logger } from '../core/logger'
/**
 * Skills Hub Search - GitHub and registry search
 * Adapted from Hermes Agent skills_hub_search.py
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, resolve, sep } from 'path'
import { URL } from 'url'
import type { SkillSearchResult, SkillBundle } from './models'

const execFileAsync = promisify(execFile)
const REQUEST_TIMEOUT_MS = 10_000

/** Default upstream catalog. Override with VALLENEMPEROR_SKILLS_CATALOG=owner/repo. */
export const DEFAULT_SKILLS_CATALOG_REPO = 'vallenmulia99/vallenemperor'

/** owner/repo of the external skill catalog, from env when set and well-formed. */
export function resolveSkillsCatalogRepo(): string {
  const configured = String(process.env.VALLENEMPEROR_SKILLS_CATALOG || '').trim()
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured) ? configured : DEFAULT_SKILLS_CATALOG_REPO
}

/** Catalog URLs are derived from the repo, never hardcoded per call site. */
export function officialCatalogUrls(repo: string = resolveSkillsCatalogRepo()): {
  contents: string
  skillFile: (category: string, name: string) => string
} {
  return {
    contents: `https://api.github.com/repos/${repo}/contents/.vallenemperor/skills`,
    skillFile: (category: string, name: string) => `https://raw.githubusercontent.com/${repo}/main/.vallenemperor/skills/${category}/${name}/SKILL.md`
  }
}

let lastCatalogError: string | null = null

/** Last catalog failure, so callers can tell "empty catalog" from "catalog broken". */
export function getCatalogError(): string | null {
  return lastCatalogError
}

export function clearCatalogError(): void {
  lastCatalogError = null
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VallenEmperor-Skills-Hub' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  return response.json()
}

async function listOfficialSkills(): Promise<Array<{ name: string; category: string; description: string }>> {
  const candidates = [process.env.VALLENEMPEROR_BUNDLED_SKILLS, join(__dirname, '../../../.vallenemperor/skills'), join(process.cwd(), '.vallenemperor/skills')].filter(Boolean) as string[]
  const root = candidates.find(path => {
    try { return require('fs').statSync(path).isDirectory() } catch { return false }
  })
  if (root) {
    const skills: Array<{ name: string; category: string; description: string }> = []
    const walk = (dir: string, category: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, category ? `${category}/${entry.name}` : entry.name)
        else if (entry.isFile() && entry.name === 'SKILL.md') {
          const text = readFileSync(path, 'utf8')
          const name = text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || category.split('/').pop() || ''
          const description = text.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || 'Official VallenEmperor skill'
          skills.push({ name, category: category.includes('/') ? category.slice(0, category.lastIndexOf('/')) : 'official', description })
        }
      }
    }
    walk(root, '')
    return skills
  }

  return loadOfficialCatalogFromGitHub()
}

/**
 * Fetch the upstream catalog. A failure is recorded (getCatalogError) instead of being
 * swallowed, so an unreachable catalog is not indistinguishable from an empty one.
 */
export async function loadOfficialCatalogFromGitHub(repo: string = resolveSkillsCatalogRepo()): Promise<Array<{ name: string; category: string; description: string }>> {
  const urls = officialCatalogUrls(repo)
  try {
    const categories = await fetchJson(urls.contents)
    const skills: Array<{ name: string; category: string; description: string }> = []
    for (const category of categories.filter((entry: any) => entry.type === 'dir')) {
      const entries = await fetchJson(category.url)
      for (const entry of entries.filter((item: any) => item.type === 'dir')) {
        const files = await fetchJson(entry.url)
        if (!files.some((item: any) => item.name === 'SKILL.md')) continue
        const response = await fetch(urls.skillFile(category.name, entry.name), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!response.ok) continue
        const text = await response.text()
        skills.push({
          name: text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || entry.name,
          category: category.name,
          description: text.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || 'Official VallenEmperor skill'
        })
      }
    }
    clearCatalogError()
    return skills
  } catch (err: any) {
    lastCatalogError = `Skills catalog ${repo} unreachable: ${err?.message || String(err)}`
    logger.warn('[SkillSearch] External skills catalog failed:', err)
    return []
  }
}

export interface SearchOptions {
  query?: string
  source?: string
  limit?: number
}

/**
 * Search GitHub for skill repositories
 */
export async function searchGitHub(query: string, limit: number = 10): Promise<SkillSearchResult[]> {
  try {
    const searchQuery = `${query} SKILL.md in:file language:markdown`
    const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&per_page=${limit}`
    const data = await fetchJson(apiUrl)
    if (!Array.isArray(data.items)) return []
    
    return data.items.map((repo: any) => ({
      identifier: repo.full_name,
      name: repo.name,
      description: repo.description || 'No description',
      source: 'github',
      trust_level: 'community',
      repo_url: repo.html_url,
      install_command: `/skills install ${repo.html_url}`
    }))
  } catch (err) {
    logger.warn(`[SkillSearch] GitHub search failed:`, err)
    return []
  }
}

/**
 * Search skills in bundled VallenEmperor catalog (or upstream repository)
 */
export async function searchOfficialSkills(query: string, limit: number = 20): Promise<SkillSearchResult[]> {
  try {
    const lowerQuery = query.toLowerCase()
    return (await listOfficialSkills())
      .filter(skill => skill.name.toLowerCase().includes(lowerQuery) || skill.category.toLowerCase().includes(lowerQuery) || skill.description.toLowerCase().includes(lowerQuery))
      .slice(0, Math.max(0, limit))
      .map(skill => ({
        identifier: `official/${skill.category}/${skill.name}`,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        source: 'official',
        trust_level: 'builtin',
        install_command: `/skills install official/${skill.category}/${skill.name}`
      }))
  } catch (err) {
    logger.warn('[SkillSearch] Official skills catalog failed:', err)
    return []
  }
}

/**
 * Search all sources
 */
export async function searchSkills(options: SearchOptions): Promise<SkillSearchResult[]> {
  const { query = '', source, limit = 20 } = options
  
  const results: SkillSearchResult[] = []
  
  // Search official first
  if (!source || source === 'official') {
    const official = await searchOfficialSkills(query, Math.floor(limit / 2))
    results.push(...official)
  }
  
  // Search GitHub
  if (!source || source === 'github') {
    const github = await searchGitHub(query, Math.floor(limit / 2))
    results.push(...github)
  }
  
  // Deduplicate and sort by trust level
  const seen = new Set<string>()
  const trustRank = { builtin: 3, trusted: 2, community: 1, local: 0 }
  
  return results
    .filter(r => {
      if (seen.has(r.identifier)) return false
      seen.add(r.identifier)
      return true
    })
    .sort((a, b) => {
      const rankDiff = (trustRank[b.trust_level as keyof typeof trustRank] || 0) - 
                       (trustRank[a.trust_level as keyof typeof trustRank] || 0)
      if (rankDiff !== 0) return rankDiff
      return a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}

/**
 * Fetch skill bundle from GitHub URL
 */
export async function fetchGitHubSkill(url: string): Promise<SkillBundle> {
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com' || parsedUrl.username || parsedUrl.password || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsedUrl.pathname)) {
    throw new Error('Invalid GitHub skill URL')
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'vallenemperor-skill-'))
  
  try {
    // Clone repo (shallow, single branch)
    await execFileAsync('git', ['clone', '--depth', '1', '--', parsedUrl.toString(), tmpDir], { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    
    // Find SKILL.md files
    const skillFiles: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== '.git') walk(path)
        else if (entry.isFile() && entry.name === 'SKILL.md') skillFiles.push(path)
      }
    }
    walk(tmpDir)
    
    if (skillFiles.length === 0) {
      throw new Error('No SKILL.md found in repository')
    }
    
    // Use first SKILL.md found
    const skillFile = skillFiles[0]
    const skillDir = skillFile.replace('/SKILL.md', '')
    
    // Read all files in skill directory
    const files: Record<string, string> = {}
    const filePaths: string[] = []
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (entry.isFile()) filePaths.push(path)
      }
    }
    collect(skillDir)
    
    for (const filePath of filePaths) {
      const relPath = relative(skillDir, filePath)
      try {
        const content = readFileSync(filePath, 'utf-8')
        files[relPath] = content
      } catch {
        // Skip binary files
      }
    }
    
    // Parse skill name from SKILL.md frontmatter
    const skillMdContent = files['SKILL.md'] || ''
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m)
    const descMatch = skillMdContent.match(/^description:\s*(.+)$/m)
    
    const name = nameMatch ? nameMatch[1].trim() : url.split('/').pop() || 'unknown'
    const description = descMatch ? descMatch[1].trim() : 'No description'
    
    return {
      name,
      description,
      source: 'github',
      identifier: url,
      files,
      trust_level: 'community'
    }
  } finally {
    // Cleanup temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Fetch official skill from Hermes reference
 */
export async function fetchOfficialSkill(category: string, name: string): Promise<SkillBundle> {
  if (!/^[A-Za-z0-9_-]+$/.test(category) || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid official skill identifier')
  const candidates = [process.env.VALLENEMPEROR_BUNDLED_SKILLS, join(__dirname, '../../../.vallenemperor/skills'), join(process.cwd(), '.vallenemperor/skills')].filter(Boolean) as string[]
  const refPath = candidates.find(path => require('fs').existsSync(path))
  if (!refPath) throw new Error('Official skills directory not found')
  const skillPath = resolve(refPath, category, name)
  const relPath = relative(resolve(refPath), skillPath)
  if (!relPath || relPath === '..' || relPath.startsWith(`..${sep}`) || relPath.startsWith(`${sep}`)) throw new Error('Invalid official skill path')

  
  try {
    const { existsSync, readdirSync, readFileSync, statSync } = require('fs')
    const { join } = require('path')
    
    if (!existsSync(skillPath)) {
      throw new Error(`Official skill not found: ${category}/${name}`)
    }
    
    // Read all files recursively
    const files: Record<string, string> = {}
    
    function readDir(dir: string, baseDir: string) {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        
        if (stat.isDirectory()) {
          readDir(fullPath, baseDir)
        } else if (stat.isFile()) {
          const relPath = fullPath.replace(baseDir + '/', '')
          try {
            const content = readFileSync(fullPath, 'utf-8')
            files[relPath] = content
          } catch {
            // Skip binary files
          }
        }
      }
    }
    
    readDir(skillPath, skillPath)
    
    // Parse description from SKILL.md
    const skillMdContent = files['SKILL.md'] || ''
    const descMatch = skillMdContent.match(/^description:\s*(.+)$/m)
    const description = descMatch ? descMatch[1].trim() : 'Official Hermes skill'
    
    return {
      name,
      category,
      description,
      source: 'official',
      identifier: `official/${category}/${name}`,
      files,
      trust_level: 'builtin'
    }
  } catch (err) {
    throw new Error(`Failed to fetch official skill: ${err}`)
  }
}
