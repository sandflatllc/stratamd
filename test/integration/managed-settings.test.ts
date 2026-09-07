import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { T3EngineClient } from '../../src/main/engine/client'
import { EngineSocket } from '../../src/main/engine/socket'
import type { EngineActivity } from '../../src/shared/engine-settings'

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('stock settings survive engine restart and actual host/client signals enforce background policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-settings-'))
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined, authenticate: async address => {
    const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
    return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok
  } })
  let socket: EngineSocket | null = null
  try {
    await manager.start(); expect(manager.view().state).toBe('running')
    let base = await client.readSettings()
    const identity = client.view().identity!
    await client.editSettings({ identity, base, patch: { defaultThreadEnvMode: 'worktree', sidebarAutoSettleAfterDays: 12, sourceControlWritingStyle: { mode: 'custom', customInstructions: 'Short titles.' }, backgroundActivity: { profile: 'custom', baseProfile: 'balanced', overrides: { pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenOnBattery: true, pauseWhenClientLowPower: true } } } })
    base = await client.readSettings()
    const codex = base.providerInstances.codex!
    expect(codex).toBeTruthy()
    await client.editProvider({ identity, instanceId: 'codex', base: codex, patch: { accentColor: '#123456', config: { customModels: ['custom-proof-model'] }, environment: [{ name: 'STRATA_TEST_SECRET', value: 'disposable-test-value', sensitive: true }] } })
    const masked = (await client.readSettings()).providerInstances.codex!
    expect(masked.environment?.[0]).toMatchObject({ value: '', valueRedacted: true })
    await client.editProvider({ identity, instanceId: 'codex', base: masked, patch: { displayName: 'Codex proof' } })
    expect((await client.readSettings()).providerInstances.codex?.environment?.[0]).toMatchObject({ value: '', valueRedacted: true })
    await manager.restart()
    base = await client.readSettings()
    expect(base).toMatchObject({ defaultThreadEnvMode: 'worktree', sidebarAutoSettleAfterDays: 12, sourceControlWritingStyle: { customInstructions: 'Short titles.' }, providerInstances: { codex: { displayName: 'Codex proof', accentColor: '#123456', config: { customModels: ['custom-proof-model'] } } } })
    await client.editProvider({ identity, instanceId: 'codex', base: base.providerInstances.codex!, patch: { accentColor: '', displayName: 'Default color proof' } })
    await manager.restart()
    base = await client.readSettings()
    expect(base.providerInstances.codex?.accentColor).toBeUndefined()
    expect(base.providerInstances.codex?.displayName).toBe('Default color proof')
    expect(Object.keys(base.providerInstances).length).toBeGreaterThan(1)
    await expect(client.editSettings({ identity, base, patch: { addProjectBaseDirectory: join(root, 'does-not-exist') } })).rejects.toThrow()
    const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
    const ticket = await fetch(credential.server + '/api/auth/websocket-ticket', { method: 'POST', headers: { authorization: `Bearer ${credential.accessToken}` } }).then(response => response.json())
    const url = new URL('/ws', credential.server); url.protocol = 'ws:'; url.searchParams.set('wsTicket', ticket.ticket)
    socket = new EngineSocket({ url, webSocket: WebSocket, onClose: () => undefined }); await socket.open()
    const host: EngineActivity['hostPower'] = { source: 'electron-main', idle: 'false', idleSeconds: 0, locked: 'false', suspended: false, onBattery: 'false', lowPowerMode: 'false', thermalState: 'nominal', stale: false, updatedAt: new Date().toISOString() }
    const activity = { clientId: 'strata-settings-proof', visible: true, focused: true, recentlyInteracted: true, hostPower: host }
    for (const key of ['locked', 'onBattery', 'lowPowerMode'] as const) {
      await client.reportActivity({ ...activity, hostPower: { ...host, [key]: 'true', updatedAt: new Date().toISOString() } }, true)
      expect(await socket.request('server.getBackgroundPolicy', {})).toMatchObject({ shouldRunOpportunisticWork: false })
    }
    await client.reportActivity({ ...activity, hostPower: { ...host, updatedAt: new Date().toISOString() } }, true)
    expect(await socket.request('server.getBackgroundPolicy', {})).toMatchObject({ shouldRunOpportunisticWork: true })
    await client.reportActivity({ ...activity, hostPower: { ...host, locked: 'true' } }, false)
    expect(await socket.request('server.getBackgroundPolicy', {})).toMatchObject({ hostPower: { locked: 'false' } })
  } finally { socket?.close(); await manager.stop(); await client.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60000)
