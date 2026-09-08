import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { T3Connect } from '../../src/main/engine/connect'

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('stock pairing links and sessions revoke independently, local Connect stays signed out, and explicit LAN restart retains the environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connections-'))
  let lan = false
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, network: () => ({ lan }), connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined, authenticate: async address => {
    const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
    return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok
  } })
  try {
    await manager.start(); expect(manager.view().state).toBe('running')
    const identity = client.view().identity
    const connect = new T3Connect()
    expect(await connect.status(manager.runtimeContext()!)).toMatchObject({ authenticated: false, linked: false, publishAgentActivity: false })
    const link = await client.connectionRequest('create-link', { label: 'Disposable device', scopes: ['orchestration:read'] }) as { id: string; credential: string }
    expect(await client.connectionRequest('links')).toEqual(expect.arrayContaining([expect.objectContaining({ id: link.id, label: 'Disposable device' })]))
    const origin = client.view().server!
    const second = new T3EngineClient({ dataDirectory: join(root, 'second'), terminalShimDirectory: null })
    try {
      await second.pair(origin, link.credential)
      const devices = await client.connectionRequest('devices') as { sessionId: string; current: boolean }[]
      const other = devices.find(row => !row.current)!
      expect(other).toBeTruthy()
      await client.connectionRequest('revoke-link', { id: link.id })
      expect(await client.connectionRequest('links')).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: link.id })]))
      await client.connectionRequest('revoke-device', { sessionId: other.sessionId })
      expect(await client.connectionRequest('devices')).not.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: other.sessionId })]))
    } finally { await second.shutdown() }
    lan = true; await manager.restart(); expect(manager.view().state).toBe('running'); expect(client.view().identity).toBe(identity)
    lan = false; await manager.restart(); expect(manager.view().state).toBe('running'); expect(client.view().identity).toBe(identity)
  } finally { await manager.stop(); await client.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60000)


it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('stock Connect exposes a loopback callback, accepts code fallback over pipes and cancels without saving authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-stock-connect-')), connect = new T3Connect()
  const bundle = process.env.STRATAMD_ENGINE_BUNDLE!
  const runtime = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'))
  const context = { directory: bundle, baseDirectory: root, executable: join(bundle, runtime.executable) }
  try {
    connect.start(context, async operation => { await operation.execute(['login']); return 'Signed in' })
    await expect.poll(() => connect.view(), { timeout: 10000 }).toMatchObject({ state: 'running', phase: 'browser' })
    const browserUrl = new URL(connect.view().url!)
    const params = new URLSearchParams(browserUrl.hash.slice(1))
    const port = params.get('port')
    expect(Number(port)).toBeGreaterThan(0)
    const callback = `http://127.0.0.1:${port}/callback`
    expect((await fetch(callback)).status).toBe(400)
    connect.useCode()
    await expect.poll(() => connect.view().phase, { timeout: 10000 }).toBe('code')
    expect(new URL(connect.view().url!).hash).not.toContain('port=')
    await connect.cancel()
    expect(connect.view()).toMatchObject({ state: 'cancelled' })
    expect(connect.view().url).toBeUndefined()
    expect(await connect.status(context, true)).toMatchObject({ authenticated: false, linked: false })
  } finally { await connect.cancel(); await rm(root, { recursive: true, force: true }) }
}, 30000)
