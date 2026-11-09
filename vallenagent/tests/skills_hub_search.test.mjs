import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const catalog = mkdtempSync(join(tmpdir(), 'vallenemperor-catalog-'))
process.env.VALLENEMPEROR_BUNDLED_SKILLS = catalog

function seedSkill(category, name, description) {
  const dir = category ? join(catalog, category, name) : join(catalog, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
}

seedSkill('research', 'arxiv-search', 'Search arXiv papers by keyword')
seedSkill('media', 'gif-search', 'Find and download GIFs')
seedSkill('', 'root-skill', 'A skill living at the catalog root')

const { searchOfficialSkills, searchSkills, fetchGitHubSkill } = await import('../dist/skills_hub/search.js')

test.after(() => rmSync(catalog, { recursive: true, force: true }))

test('searchOfficialSkills matches on name and marks results as builtin', async () => {
  const results = await searchOfficialSkills('arxiv')
  assert.equal(results.length, 1)
  assert.equal(results[0].identifier, 'official/research/arxiv-search')
  assert.equal(results[0].trust_level, 'builtin')
  assert.equal(results[0].install_command, '/skills install official/research/arxiv-search')
})

test('searchOfficialSkills matches on category and description', async () => {
  const byCategory = await searchOfficialSkills('media')
  assert.ok(byCategory.some(r => r.name === 'gif-search'))

  const byDescription = await searchOfficialSkills('keyword')
  assert.ok(byDescription.some(r => r.name === 'arxiv-search'))
})

test('searchOfficialSkills honours the limit and an empty query lists the catalog', async () => {
  const limited = await searchOfficialSkills('', 2)
  assert.equal(limited.length, 2)

  const all = await searchOfficialSkills('')
  assert.ok(all.length >= 3)
})

test('a catalog skill sitting directly at the root is filed under the official category', async () => {
  // Root-level SKILL.md has no folder to derive a category from, so the walker falls back to
  // 'official'. Documented here because the resulting identifier (official/official/<name>)
  // looks accidental but is the current contract.
  const results = await searchOfficialSkills('root-skill')
  assert.equal(results.length, 1)
  assert.equal(results[0].category, 'official')
  assert.equal(results[0].identifier, 'official/official/root-skill')
})

test('searchSkills with source=official does not touch the network', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('network should not be used') }
  try {
    const results = await searchSkills({ query: 'gif', source: 'official' })
    assert.ok(results.length >= 1)
    assert.equal(called, false, 'github search must be skipped for source=official')
  } finally {
    globalThis.fetch = original
  }
})

test('searchSkills sorts by trust level and deduplicates identifiers', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      items: [
        { full_name: 'someone/gif-search', name: 'gif-search', description: 'community gif skill', html_url: 'https://github.com/someone/gif-search' },
        { full_name: 'other/arxiv', name: 'arxiv', description: 'community arxiv', html_url: 'https://github.com/other/arxiv' }
      ]
    })
  })
  try {
    const results = await searchSkills({ query: 'gif', limit: 10 })
    const trust = results.map(r => r.trust_level)
    assert.equal(trust[0], 'builtin', 'official skills rank above community ones')
    assert.ok(trust.includes('community'))
    const ids = results.map(r => r.identifier)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate identifiers')
  } finally {
    globalThis.fetch = original
  }
})

test('a failing GitHub search degrades to an empty list instead of throwing', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    const results = await searchSkills({ query: 'anything', source: 'github' })
    assert.deepEqual(results, [])
  } finally {
    globalThis.fetch = original
  }
})

test('fetchGitHubSkill rejects every URL shape that could redirect or leak credentials', async () => {
  const bad = [
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://user:token@github.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/tree/main/sub',
    'https://github.com.evil.test/owner/repo',
    'not-a-url'
  ]
  for (const url of bad) {
    await assert.rejects(fetchGitHubSkill(url), /Invalid GitHub skill URL|Invalid URL/i, `${url} must be rejected`)
  }
})

// ---------- external catalog: configurable source + visible failures ----------

const { officialCatalogUrls, resolveSkillsCatalogRepo, loadOfficialCatalogFromGitHub, getCatalogError, clearCatalogError, DEFAULT_SKILLS_CATALOG_REPO } = await import('../dist/skills_hub/search.js')

test('catalog URLs follow VALLENEMPEROR_SKILLS_CATALOG instead of a hardcoded repo', () => {
  const previous = process.env.VALLENEMPEROR_SKILLS_CATALOG
  try {
    process.env.VALLENEMPEROR_SKILLS_CATALOG = 'acme/skills'
    assert.equal(resolveSkillsCatalogRepo(), 'acme/skills')
    const urls = officialCatalogUrls()
    assert.match(urls.contents, /^https:\/\/api\.github\.com\/repos\/acme\/skills\/contents\//)
    assert.match(urls.skillFile('media', 'gif-search'), /^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/main\/\.vallenemperor\/skills\/media\/gif-search\/SKILL\.md$/)

    delete process.env.VALLENEMPEROR_SKILLS_CATALOG
    assert.equal(resolveSkillsCatalogRepo(), DEFAULT_SKILLS_CATALOG_REPO)
    assert.match(officialCatalogUrls().contents, new RegExp(`/repos/${DEFAULT_SKILLS_CATALOG_REPO}/`))
  } finally {
    if (previous === undefined) delete process.env.VALLENEMPEROR_SKILLS_CATALOG
    else process.env.VALLENEMPEROR_SKILLS_CATALOG = previous
  }
})

test('an unreachable catalog reports an error instead of pretending to be empty', async () => {
  const originalFetch = globalThis.fetch
  clearCatalogError()
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') }
  try {
    const skills = await loadOfficialCatalogFromGitHub('nobody/missing-repo')
    assert.deepEqual(skills, [])
    const error = getCatalogError()
    assert.ok(error, 'a failed fetch must be recorded, not swallowed')
    assert.match(error, /nobody\/missing-repo unreachable/)
    assert.match(error, /ENOTFOUND/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a successful catalog fetch clears the previous error', async () => {
  const originalFetch = globalThis.fetch
  clearCatalogError()
  globalThis.fetch = async () => { throw new Error('boom') }
  await loadOfficialCatalogFromGitHub('nobody/missing-repo')
  assert.ok(getCatalogError())

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' })
  try {
    const skills = await loadOfficialCatalogFromGitHub('acme/skills')
    assert.deepEqual(skills, [])
    assert.equal(getCatalogError(), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
