/**
 * `x_search` (R18) — search recent posts on X.
 *
 * Uses the X API v2 recent-search endpoint with a bearer token from the environment
 * (`X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN`). No token means a clear refusal, never a silent empty
 * result. The network call is injectable so the parsing and error handling can be tested offline.
 */

export interface XPost {
  id: string
  text: string
  createdAt?: string
  authorId?: string
  likes?: number
  reposts?: number
  url: string
}

export interface XSearchResult {
  ok: boolean
  query: string
  posts: XPost[]
  error?: string
  hint?: string
}

export function xBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN || '').trim()
}

export function buildXSearchUrl(query: string, maxResults = 10): string {
  const params = new URLSearchParams({
    query: String(query || '').trim(),
    max_results: String(Math.min(100, Math.max(10, maxResults))),
    'tweet.fields': 'created_at,public_metrics,author_id'
  })
  return `https://api.x.com/2/tweets/search/recent?${params.toString()}`
}

export async function searchPosts(options: {
  query: string
  maxResults?: number
  token?: string
  fetchImpl?: typeof fetch
}): Promise<XSearchResult> {
  const query = String(options.query || '').trim()
  if (!query) return { ok: false, query, posts: [], error: 'query is required' }
  const token = options.token ?? xBearerToken()
  if (!token) {
    return {
      ok: false, query, posts: [],
      error: 'No X bearer token configured.',
      hint: 'Set X_BEARER_TOKEN (or TWITTER_BEARER_TOKEN) in the environment. x_search never falls back to scraping.'
    }
  }
  const fetchImpl = options.fetchImpl || fetch
  try {
    const response = await fetchImpl(buildXSearchUrl(query, options.maxResults), {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'vallenemperor' }
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, query, posts: [], error: `X API ${response.status}: ${body.slice(0, 300)}` }
    }
    const data: any = await response.json()
    const posts: XPost[] = (data?.data || []).map((item: any) => ({
      id: String(item.id),
      text: String(item.text || ''),
      createdAt: item.created_at,
      authorId: item.author_id,
      likes: item.public_metrics?.like_count,
      reposts: item.public_metrics?.retweet_count,
      url: `https://x.com/i/web/status/${item.id}`
    }))
    return { ok: true, query, posts }
  } catch (error: any) {
    return { ok: false, query, posts: [], error: String(error?.message || error).slice(0, 300) }
  }
}

export function formatXSearch(result: XSearchResult): string {
  if (!result.ok) return `x_search failed: ${result.error}${result.hint ? `\n${result.hint}` : ''}`
  if (!result.posts.length) return `No posts found for "${result.query}".`
  return [
    `${result.posts.length} post(s) for "${result.query}"`,
    ...result.posts.map(post => `  ${post.createdAt || ''} ${post.url}\n    ${post.text.replace(/\s+/g, ' ').slice(0, 200)}`)
  ].join('\n')
}
