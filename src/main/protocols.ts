import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isImagePath } from './files'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { net, protocol } from 'electron'

export const APP_SCHEME = 'app'
export const APP_HOST = 'stratamd'
export const LOCAL_IMAGE_SCHEME = 'strata-image'
export const LOCAL_IMAGE_HOST = 'local'
export const VISUAL_IMAGE_SCHEME = 'strata-visual'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self' app:",
  "base-uri 'none'",
  "connect-src 'self' app:",
  "font-src 'self' app:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' app: strata-image: strata-visual: data:",
  "media-src data:",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
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
        corsEnabled: true,
        stream: true
      }
    },
    {
      scheme: VISUAL_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        // The session draws these images onto a canvas to bake the marks in; without CORS the canvas would be tainted and could not export.
        corsEnabled: true,
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

// A URL proves main approved this exact canonical path. No global directory
// list or growing file registry is needed; grants expire when the app quits.
const imageKey = randomBytes(32)
function imageSignature(encodedPath: string): Buffer {
  return createHmac('sha256', imageKey).update(encodedPath).digest()
}

export function installLocalImageProtocol(): void {
  protocol.handle(LOCAL_IMAGE_SCHEME, serveLocalImage)
}

export interface VisualImageProtocolOptions {
  /** Bytes for a piece of visual evidence or a staged composer image, or null when it is gone. */
  read(kind: 'evidence' | 'staged', id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>
}

/** Visual evidence and staged composer images (docs/plans/open/visual-review): served by id from the data directory, never by path. */
export function installVisualImageProtocol(options: VisualImageProtocolOptions): void {
  protocol.handle(VISUAL_IMAGE_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET' || (url.host !== 'evidence' && url.host !== 'staged')) return forbidden()
    const id = decodeURIComponent(url.pathname.slice(1))
    if (!/^[ae]_[0-9a-f-]{36}$/u.test(id)) return forbidden()
    try {
      const image = await options.read(url.host, id)
      if (!image) return notFound()
      return new Response(Buffer.from(image.bytes), {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': `${APP_SCHEME}://${APP_HOST}`,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Content-Type': image.mimeType,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return forbidden()
    }
  })
}

export function localImageUrl(path: string): string {
  if (!isAbsolute(path)) throw new Error('Local image paths must be absolute')
  const encoded = Buffer.from(path).toString('base64url')
  return `${LOCAL_IMAGE_SCHEME}://${LOCAL_IMAGE_HOST}/${encoded}/${imageSignature(encoded).toString('base64url')}`
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

async function serveLocalImage(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.host !== LOCAL_IMAGE_HOST) return forbidden()

  let requestedPath: string
  try {
    const parts = url.pathname.slice(1).split('/')
    if (parts.length !== 2) return forbidden()
    const [encoded, signature] = parts as [string, string]
    const supplied = Buffer.from(signature, 'base64url')
    const expected = imageSignature(encoded)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return forbidden()
    requestedPath = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return forbidden()
  }
  if (!isAbsolute(requestedPath)) return forbidden()

  try {
    const candidate = await realpath(requestedPath)
    // Refuse a file replaced by a symlink to a different target after approval.
    if (candidate !== requestedPath) return forbidden()
    if (!(await stat(candidate)).isFile() || !isImagePath(candidate)) return forbidden()
    const file = await readFile(candidate)
    return new Response(file, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': `${APP_SCHEME}://${APP_HOST}`,
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

function mimeType(path: string): string {
  return ({
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
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
    '.wasm': 'application/wasm',
    '.mjs': 'text/javascript',
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
