import { registry, ToolSchema } from '../tools'
import { formatXSearch, searchPosts } from '../../core/x_search'
import { fetchSafeUrl } from '../../core/network_safety'

export function registerWebTools(): void {
  registry.register({
    name: 'x_search',
    toolset: 'web',
    schema: {
      name: 'x_search',
      description: 'Search recent posts on X (Twitter) via the official API v2. Requires X_BEARER_TOKEN in the environment; without it the tool says so instead of returning empty results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (supports X search operators)' },
          max_results: { type: 'integer', description: '10-100 results (default 10)' }
        },
        required: ['query']
      }
    },
    handler: async (args: any) => {
      const result = await searchPosts({ query: String(args.query || ''), maxResults: Number(args.max_results) || 10 })
      return JSON.stringify({ ...result, summary: formatXSearch(result) })
    }
  })


  // 7. web_search
  const webSearchSchema: ToolSchema = {
    name: 'web_search',
    description: 'Search the web for information. Returns title, url, and description snippet of matching web pages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Maximum number of results to return (default: 5)' }
      },
      required: ['query']
    }
  }

  registry.register({
    name: 'web_search',
    schema: webSearchSchema,
    toolset: 'web',
    parallelSafe: true,
    handler: async (args, context) => {
      const query = String(args.query || '').trim()
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5))

      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const res = await fetchSafeUrl(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          signal: AbortSignal.timeout(15000), timeoutMs: 15000, requester: context?.httpRequester
        })
        if (!res.ok) {
          return JSON.stringify({
            error: `Search request failed with HTTP ${res.status}: ${res.statusText}`
          })
        }
        const html = await res.text()

        const results: Array<{ title: string; url: string; description: string }> = []
        const titleMatches = [...html.matchAll(/<a class="result__a[^>]*>([\s\S]*?)<\/a>/g)]
        const snippetMatches = [...html.matchAll(/<a class="result__snippet[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
        const decodeEntities = (value: string) => value
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&#(\d+);/g, (entity, n) => { const point = Number(n); return point <= 0x10ffff ? String.fromCodePoint(point) : entity })
          .replace(/&#x([\da-f]+);/gi, (entity, n) => { const point = parseInt(n, 16); return point <= 0x10ffff ? String.fromCodePoint(point) : entity })
        for (const [index, m] of snippetMatches.slice(0, limit).entries()) {
          let rawUrl = m[1]
          if (rawUrl.includes('uddg=')) {
            const match = rawUrl.match(/[?&]uddg=([^&]+)/)
            if (match) { try { rawUrl = decodeURIComponent(match[1]) } catch {} }
          }
          const stripHtml = (value: string) => decodeEntities(value.replace(/<[^>]+>/g, '').trim())
          const snippet = stripHtml(m[2])
          const title = titleMatches[index]?.[1] ? stripHtml(titleMatches[index][1]) : snippet.slice(0, 80)
          results.push({ title, url: rawUrl, description: snippet })
        }

        if (results.length === 0) {
          return JSON.stringify({
            error: 'No search results found (parsing failed or blocked by CAPTCHA)'
          })
        }

        return JSON.stringify({ untrusted_external_data: true, data: { web: results } })
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'Web search failed' })
      }
    }
  })

  // 8. web_extract
  const webExtractSchema: ToolSchema = {
    name: 'web_extract',
    description: 'Extract content from web page URLs. Returns clean markdown/text content.',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string', description: 'URL to extract' },
          description: 'List of URLs to extract content from'
        },
        char_limit: { type: 'integer', description: 'Max character budget per page (default: 15000)' }
      },
      required: ['urls']
    }
  }

  registry.register({
    name: 'web_extract',
    schema: webExtractSchema,
    toolset: 'web',
    parallelSafe: true,
    handler: async (args, context) => {
      const urls = Array.isArray(args.urls) ? args.urls.map(String) : []
      const charLimit = Math.min(50_000, Number(args.char_limit) || 15_000)
      const results: Array<{ url: string; title: string; content: string; error?: string; untrusted_external_data?: true }> = []

      for (const targetUrl of urls.slice(0, 5)) {
        try {
          let currentUrl = targetUrl
        let redirectCount = 0
        const maxRedirects = 5
        let res: any = null
        let fetchError: string | null = null

        while (true) {
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 30000)

            try {
              res = await fetchSafeUrl(currentUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                signal: controller.signal, timeoutMs: 30000, maxBytes: 5 * 1024 * 1024,
                requester: context?.httpRequester
              })
            } finally {
              clearTimeout(timeoutId)
            }
          } catch (err: any) {
            fetchError = err.message || String(err)
            break
          }

          if (res && [301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers?.get ? res.headers.get('location') : res.headers?.location
            if (!location) {
              fetchError = `HTTP ${res.status}: Redirect with no Location header`
              break
            }
            redirectCount++
            if (redirectCount > maxRedirects) {
              fetchError = 'Too many redirects'
              break
            }
            res.body?.resume?.()
            currentUrl = new URL(location, currentUrl).toString()
            continue
          }

          break
        }

        if (fetchError) {
          results.push({
            url: targetUrl,
            title: 'Blocked',
            content: '',
            error: fetchError
          })
          continue
        }

        if (!res || !res.ok) {
          results.push({
            url: targetUrl,
            title: targetUrl,
            content: '',
            error: res ? `HTTP ${res.status}: ${res.statusText || ''}` : 'Fetch failed'
          })
          continue
        }

        let rawHtml = ''
        try {
          rawHtml = await res.text()
        } catch (err: any) {
          results.push({
            url: targetUrl,
            title: targetUrl,
            content: '',
            error: `Failed to read response body: ${err.message}`
          })
          continue
        }

        if (rawHtml.length > 5 * 1024 * 1024) {
          rawHtml = rawHtml.slice(0, 5 * 1024 * 1024)
        }

        const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
        const title = titleMatch ? titleMatch[1].trim() : targetUrl

          let clean = rawHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
            .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
            .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n### $1\n')
            .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
            .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n\n')
            .trim()

          if (clean.length > charLimit) {
            clean = clean.slice(0, charLimit) + `\n\n[... Truncated at ${charLimit} chars ...]`
          }

          results.push({ url: targetUrl, title, content: clean, untrusted_external_data: true })
        } catch (err: any) {
          results.push({ url: targetUrl, title: targetUrl, content: '', error: err.message || 'Extract failed' })
        }
      }

      return JSON.stringify({ results })
    }
  })

}
