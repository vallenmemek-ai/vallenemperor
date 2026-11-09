import { isIP, isIPv4, isIPv6 } from 'node:net'
import dns from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

function expandIpv6(ip: string): string[] {
  const parts = ip.split('::')
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts[1] ? parts[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  const mid = Array(Math.max(0, missing)).fill('0')
  return [...left, ...mid, ...right].map(g => g.padStart(4, '0'))
}

export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    if (parts[0] === 0) return true
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] === 192 && parts[1] === 0) return true
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true
    if (parts[0] >= 224) return true
    return false
  }
  if (isIPv6(ip)) {
    const clean = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (clean === '::' || clean === '::1') return true
    const mappedMatch = clean.match(/^::ffff:([0-9a-f.:]+)$/)
    if (mappedMatch) {
      const rest = mappedMatch[1]
      if (isIPv4(rest)) return isPrivateAddress(rest)
      const hexParts = rest.split(':')
      if (hexParts.length === 2) {
        const p1 = parseInt(hexParts[0], 16)
        const p2 = parseInt(hexParts[1], 16)
        if (!isNaN(p1) && !isNaN(p2)) {
          const ipv4Str = `${(p1 >> 8) & 0xff}.${p1 & 0xff}.${(p2 >> 8) & 0xff}.${p2 & 0xff}`
          return isPrivateAddress(ipv4Str)
        }
      }
    }
    const full = expandIpv6(clean)
    if (full.length === 8) {
      const firstWord = parseInt(full[0], 16)
      if (!isNaN(firstWord)) {
        if ((firstWord & 0xffc0) === 0xfe80) return true
        if ((firstWord & 0xfe00) === 0xfc00) return true
        if ((firstWord & 0xff00) === 0xff00) return true
        if ((firstWord & 0xe000) !== 0x2000) return true
      }
    }
  }
  return false
}

async function resolveSafeUrl(urlStr: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = new URL(urlStr)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol: only HTTP and HTTPS allowed')
  const rawHost = url.hostname
  const cleanHost = rawHost.replace(/^\[|\]$/g, '')
  if (rawHost === 'localhost' || rawHost.endsWith('.localhost')) throw new Error('Private IP addresses blocked (SSRF protection)')
  if (isIP(cleanHost)) {
    if (isPrivateAddress(cleanHost)) throw new Error('Private IP addresses blocked (SSRF protection)')
    return { url, address: cleanHost, family: isIP(cleanHost) as 4 | 6 }
  }
  try {
    const addresses = await dns.promises.lookup(rawHost, { all: true, verbatim: true })
    if (!addresses.length) throw new Error('No address records')
    for (const addr of addresses) {
      if (isPrivateAddress(addr.address)) throw new Error('Private IP addresses blocked (SSRF protection)')
    }
    const chosen = addresses[0]
    return { url, address: chosen.address, family: chosen.family as 4 | 6 }
  } catch (err: any) {
    if (err.message?.includes('Private IP addresses blocked')) throw err
    throw new Error(`Unable to validate host address: ${rawHost}`)
  }
}

export async function validateSafeUrl(urlStr: string): Promise<URL> {
  return (await resolveSafeUrl(urlStr)).url
}

type SafeRequestOptions = {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  requester?: (url: URL, options: any, callback: (response: any) => void) => any
}

export async function fetchSafeUrl(urlStr: string, options: SafeRequestOptions = {}) {
  const { url, address, family } = await resolveSafeUrl(urlStr)
  const requester = options.requester || (url.protocol === 'https:' ? httpsRequest : httpRequest)
  const timeoutMs = options.timeoutMs ?? 30_000
  return await new Promise<any>((resolve, reject) => {
    const request = requester(url, {
      headers: options.headers,
      signal: options.signal,
      lookup: (_hostname: string, lookupOptions: any, callback: (...args: any[]) => void) => {
        if (typeof lookupOptions === 'function') callback = lookupOptions
        if (lookupOptions?.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      }
    }, (response: any) => {
      const headers = {
        get: (name: string) => {
          const value = response.headers?.[name.toLowerCase()]
          return Array.isArray(value) ? value.join(', ') : value ?? null
        }
      }
      let bodyPromise: Promise<Buffer> | undefined
      const readBody = () => bodyPromise ||= (async () => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response) {
          const buffer = Buffer.from(chunk)
          size += buffer.length
          if (size > (options.maxBytes ?? 5 * 1024 * 1024)) {
            response.destroy?.()
            throw new Error('Response exceeds size limit')
          }
          chunks.push(buffer)
        }
        return Buffer.concat(chunks)
      })()
      resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || '',
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers,
        body: response,
        text: async () => (await readBody()).toString('utf8'),
        arrayBuffer: async () => {
          const buffer = await readBody()
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout?.(timeoutMs, () => request.destroy(new Error('Request timed out')))
    request.end()
  })
}
