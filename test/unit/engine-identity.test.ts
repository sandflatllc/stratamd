import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectionDirectory, connectionIdentity } from '../../src/main/engine/identity'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

it('keeps managed identity through port changes and separates server identities', () => {
  expect(connectionIdentity('http://127.0.0.1:1234', 'first')).toBe(connectionIdentity('http://127.0.0.1:4321', 'first'))
  expect(connectionIdentity('http://127.0.0.1:1234', 'first')).not.toBe(connectionIdentity('http://127.0.0.1:1234', 'second'))
})

it('does not post old pending commands or keep reading and account state when two engines reuse ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-identity-'))
  const first = connectionIdentity('http://first.test')
  await connectionDirectory(root, first)
  await writeFile(join(root, 'engine-credential.json'), JSON.stringify({ formatVersion: 1, server: 'http://first.test', accessToken: 'first', expiresAt: Date.now() + 1000000, scopes: [] }))
  await writeFile(join(root, 'engine-commands.json'), JSON.stringify({ formatVersion: 1, pending: [{ key: 'old', command: { type: 'thread.turn.start', threadId: 'same' } }] }))
  await writeFile(join(root, 'engine-reading.json'), JSON.stringify({ formatVersion: 1, activeThreadId: 'same', lastVisited: { same: 4 }, attention: { same: 7 } }))
  const requests: string[] = []
  const socket = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  const fetch: typeof globalThis.fetch = async input => {
    const url = String(input); requests.push(url)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'second', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: '2026-09-06T00:00:00Z' })
    return Response.json({ snapshotSequence: 0, projects: [], threads: [], updatedAt: '2026-09-06T00:00:00Z' })
  }
  const client = new T3EngineClient({ dataDirectory: root, fetch, webSocket: socket.WebSocket })
  await client.initialize(false)
  await client.pair('http://second.test', 'bootstrap')
  expect(client.view().activeThreadId).toBeNull()
  expect(client.view().identity).not.toBe(first)
  expect(requests.filter(url => url.includes('/dispatch'))).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'engine-commands.json'), 'utf8')).pending).toHaveLength(1)
  await client.shutdown()
})

it('binds legacy external files to the authenticated environment before switching away and back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-legacy-identity-'))
  await writeFile(join(root, 'engine-credential.json'), JSON.stringify({ formatVersion: 1, server: 'http://first.test', accessToken: 'first', expiresAt: Date.now() + 1000000, scopes: [] }))
  const socket = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
  const fetch: typeof globalThis.fetch = async input => {
    const url = String(input)
    if (url.endsWith('/.well-known/t3/environment')) return Response.json({ environmentId: 'first-environment' })
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: 3600, scope: 'orchestration:read' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: '2026-09-06T00:00:00Z' })
    return Response.json({ snapshotSequence: 0, projects: [], threads: [], updatedAt: '2026-09-06T00:00:00Z' })
  }
  const client = new T3EngineClient({ dataDirectory: root, fetch, webSocket: socket.WebSocket })
  try {
    await client.initialize()
    const identity = client.view().identity
    expect(identity).toBe(connectionIdentity('http://first.test', 'first-environment'))
    await client.pair('http://second.test', 'code', 'second-environment')
    await client.pair('http://first.test', 'code', 'first-environment')
    expect(client.view().identity).toBe(identity)
    expect(JSON.parse(await readFile(join(root, 'engine-identity.json'), 'utf8')).identity).toBe(identity)
  } finally { await client.shutdown() }
})
