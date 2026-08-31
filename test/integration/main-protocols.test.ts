import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handles = new Map<string, (request: Request) => Promise<Response> | Response>()
const registerSchemesAsPrivileged = vi.fn()
const { netFetch } = vi.hoisted(() => ({ netFetch: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: netFetch },
  protocol: {
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response> | Response) => handles.set(scheme, handler)),
    registerSchemesAsPrivileged
  }
}))

const protocols = await import('../../src/main/protocols')

beforeEach(() => {
  handles.clear()
  registerSchemesAsPrivileged.mockClear()
  netFetch.mockReset()
})

describe('custom protocols', () => {
  it('registers app and local images as secure schemes', () => {
    protocols.registerPrivilegedSchemes()
    expect(registerSchemesAsPrivileged).toHaveBeenCalledOnce()
    expect(registerSchemesAsPrivileged.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'app', privileges: expect.objectContaining({ secure: true }) }),
      expect.objectContaining({ scheme: 'strata-image', privileges: expect.objectContaining({ secure: true }) })
    ]))
  })

  it('serves app assets with a restrictive CSP and blocks traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-renderer-'))
    await writeFile(join(root, 'index.html'), '<main>Strata</main>')
    protocols.installAppProtocol({ rendererRoot: root })
    const handler = handles.get('app')
    const response = await handler?.(new Request('app://stratamd/'))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-security-policy')).toContain("object-src 'none'")

    const blocked = await handler?.(new Request('app://stratamd/%2e%2e/%2e%2e/etc/passwd'))
    expect(blocked?.status).not.toBe(200)
  })

  it('allows only file and loopback renderer development URLs', () => {
    expect(protocols.localRendererUrl('http://localhost:5173').hostname).toBe('localhost')
    expect(protocols.localRendererUrl('http://127.0.0.1:5173').hostname).toBe('127.0.0.1')
    expect(protocols.localRendererUrl('http://[::1]:5173').hostname).toBe('[::1]')
    expect(protocols.localRendererUrl('file:///tmp/stratamd-renderer/').protocol).toBe('file:')

    for (const url of [
      'https://example.test/renderer/',
      'http://localhost.example.test/',
      'file://fileserver.example.test/share/',
      'data:text/html,remote'
    ]) {
      expect(() => protocols.localRendererUrl(url), url).toThrow()
      expect(() => protocols.installAppProtocol({ rendererRoot: '/unused', devServerUrl: url }), url).toThrow()
    }
    expect(handles.has('app')).toBe(false)
  })

  it('serves a file renderer locally without using Electron net fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-file-renderer-'))
    await writeFile(join(root, 'index.html'), '<main>Local renderer</main>')
    protocols.installAppProtocol({
      rendererRoot: '/unused',
      devServerUrl: `${pathToFileURL(root).href}/`
    })

    const response = await handles.get('app')?.(new Request('app://stratamd/'))
    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain('Local renderer')
    expect(netFetch).not.toHaveBeenCalled()
  })

  it('serves only image files whose realpath is within a current allowlisted root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'stratamd-images-'))
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const image = join(allowed, 'photo.png')
    const secret = join(outside, 'secret.png')
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    await writeFile(secret, Buffer.from([137, 80, 78, 71]))
    await symlink(secret, join(allowed, 'escape.png'))
    protocols.installLocalImageProtocol({ allowedRoots: () => [allowed] })
    const handler = handles.get('strata-image')

    const permitted = await handler?.(new Request(protocols.localImageUrl(image)))
    const escaped = await handler?.(new Request(protocols.localImageUrl(join(allowed, 'escape.png'))))
    const denied = await handler?.(new Request(protocols.localImageUrl(secret)))
    expect(permitted?.status).toBe(200)
    expect(escaped?.status).toBe(403)
    expect(denied?.status).toBe(403)
  })
})
