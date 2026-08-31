import { readFile, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { net, protocol } from 'electron'

export const APP_SCHEME = 'app'
export const APP_HOST = 'stratamd'
export const LOCAL_IMAGE_SCHEME = 'strata-image'
export const LOCAL_IMAGE_HOST = 'local'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self' app:",
  "base-uri 'none'",
  "connect-src 'self' app:",
  "font-src 'self' app:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' app: strata-image: data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'"
].join('; ')

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true
      }
    },
    {
      scheme: LOCAL_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true
      }
    }
  ])
}

export interface AppProtocolOptions {
  rendererRoot: string
  devServerUrl?: string
}

export function localRendererUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol === 'file:') {
    if (url.host && url.host !== 'localhost') {
      throw new Error('The renderer file URL must refer to the local machine')
    }
    return url
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The renderer URL must use file, http, or https')
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const addressKind = isIP(hostname)
  const loopback = hostname === 'localhost'
    || (addressKind === 4 && hostname.startsWith('127.'))
    || (addressKind === 6 && hostname === '::1')
  if (!loopback) throw new Error('The renderer development server must be loopback-only')
  return url
}

export function installAppProtocol(options: AppProtocolOptions): void {
  if (options.devServerUrl) {
    const origin = localRendererUrl(options.devServerUrl)
    if (origin.protocol === 'file:') {
      const rendererRoot = fileURLToPath(origin)
      protocol.handle(APP_SCHEME, async (request) => serveAppAsset(request, rendererRoot))
      return
    }
    protocol.handle(APP_SCHEME, (request) => {
      const url = new URL(request.url)
      if (url.host !== APP_HOST) return forbidden()
      const target = new URL(`${url.pathname}${url.search}`, origin)
      return net.fetch(target.toString())
    })
    return
  }

  protocol.handle(APP_SCHEME, async (request) => serveAppAsset(request, options.rendererRoot))
}

export interface LocalImageProtocolOptions {
  allowedRoots: () => readonly string[] | Promise<readonly string[]>
}

export function installLocalImageProtocol(options: LocalImageProtocolOptions): void {
  protocol.handle(LOCAL_IMAGE_SCHEME, async (request) => serveLocalImage(request, options))
}

export function localImageUrl(path: string): string {
  if (!isAbsolute(path)) throw new Error('Local image paths must be absolute')
  return `${LOCAL_IMAGE_SCHEME}://${LOCAL_IMAGE_HOST}/${Buffer.from(path).toString('base64url')}`
}

async function serveAppAsset(request: Request, rendererRoot: string): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.host !== APP_HOST) return forbidden()

  const pathname = decodeURIComponent(url.pathname)
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = await realpath(rendererRoot)
  const candidate = resolve(root, relativePath)
  if (!isContained(root, candidate)) return forbidden()

  try {
    const resolvedCandidate = await realpath(candidate)
    if (!isContained(root, resolvedCandidate)) return forbidden()
    const file = await readFile(resolvedCandidate)
    return new Response(file, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Content-Type': mimeType(resolvedCandidate),
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return notFound()
    throw error
  }
}

async function serveLocalImage(request: Request, options: LocalImageProtocolOptions): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.host !== LOCAL_IMAGE_HOST) return forbidden()

  let requestedPath: string
  try {
    requestedPath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf8')
  } catch {
    return forbidden()
  }
  if (!isAbsolute(requestedPath)) return forbidden()

  try {
    const [candidate, roots] = await Promise.all([
      realpath(requestedPath),
      Promise.resolve(options.allowedRoots()).then((paths) => Promise.all(paths.map((path) => realpath(path))))
    ])
    if (!roots.some((root) => isContained(root, candidate))) return forbidden()
    if (!(await stat(candidate)).isFile() || !isImagePath(candidate)) return forbidden()
    const file = await readFile(candidate)
    return new Response(file, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Content-Type': mimeType(candidate),
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return notFound()
    return forbidden()
  }
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function isImagePath(path: string): boolean {
  return ['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(extname(path).toLowerCase())
}

function mimeType(path: string): string {
  return ({
    '.avif': 'image/avif',
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
