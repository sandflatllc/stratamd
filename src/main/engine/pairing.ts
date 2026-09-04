import type { PairEngineRequest } from '../../shared/contracts'

export interface PairingTarget {
  /** The server origin Strata will pair with, `http(s)://host[:port]`. */
  server: string
  /** The one-time pairing credential exchanged for a session. */
  code: string
}

const TOKEN_PARAM = 'token'
const HOSTED_HOST_PARAM = 'host'

function originOf(raw: string, what: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`Enter the ${what}`)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new Error(`${what[0]!.toUpperCase()}${what.slice(1)} is not a valid address: ${trimmed}`) }
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${what[0]!.toUpperCase()}${what.slice(1)} must use http or https: ${trimmed}`)
  return url.origin
}

function tokenOf(url: URL): string | null {
  const hash = new URLSearchParams(url.hash.replace(/^#/u, '')).get(TOKEN_PARAM)?.trim() ?? ''
  if (hash) return hash
  const search = url.searchParams.get(TOKEN_PARAM)?.trim() ?? ''
  return search || null
}

/**
 * The same two ways T3's phone pairs (§5.1): a pairing link that carries the
 * one-time token in its query or hash, optionally naming a hosted server, or a
 * host typed by hand plus the code shown beside it.
 */
export function resolvePairingTarget(request: PairEngineRequest): PairingTarget {
  if ('link' in request) {
    const server = originOf(request.link, 'pairing link')
    const url = new URL(request.link.trim().includes('://') ? request.link.trim() : `http://${request.link.trim()}`)
    const code = tokenOf(url)
    if (!code) throw new Error('The pairing link carries no code. Copy the whole link from T3, or type the host and code.')
    const hosted = url.searchParams.get(HOSTED_HOST_PARAM)?.trim()
    return { server: hosted ? originOf(hosted, 'pairing link host') : server, code }
  }
  const server = originOf(request.host, 'engine host')
  const code = request.code.trim()
  if (!code) throw new Error('Enter the pairing code shown in T3')
  return { server, code }
}
