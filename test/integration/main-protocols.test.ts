import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('serves approved files anywhere without project roots and refuses forged URLs or changed symlink targets', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'stratamd-images-')))
    const image = join(base, 'photo.png')
    const other = join(base, 'other.png')
    const text = join(base, 'notes.md')
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    await writeFile(other, Buffer.from([137, 80, 78, 71]))
    await writeFile(text, '# Notes')
    protocols.installLocalImageProtocol()
    const handler = handles.get('strata-image')!
    const approved = protocols.localImageUrl(image)
    expect((await handler(new Request(approved))).status).toBe(200)
    const forged = `strata-image://local/${Buffer.from(other).toString('base64url')}/${approved.split('/').at(-1)}`
    expect((await handler(new Request(forged))).status).toBe(403)
    expect((await handler(new Request(`strata-image://local/${Buffer.from(image).toString('base64url')}`))).status).toBe(403)
    expect((await handler(new Request(protocols.localImageUrl(text)))).status).toBe(403)
    await rm(image)
    expect((await handler(new Request(approved))).status).toBe(404)
    await symlink(other, image)
    expect((await handler(new Request(approved))).status).toBe(403)
  })
})
