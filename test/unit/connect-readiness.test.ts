import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConnectReadiness, liveConnectStatus } from '../../src/main/engine/connect-readiness'
import { preferredPairingEndpoint, type ConnectStatus } from '../../src/shared/computer'
const saved: ConnectStatus = { desired: true, authenticated: true, linked: false, cloudUserId: null, publishAgentActivity: false, relayClient: { status: 'available' } }
it('observes cloud registration after the command exits without equating configuration with verified reachability', () => {
  const observer = new ConnectReadiness()
  expect(observer.read(saved, false, [], 0).connectionState).toBe('starting')
  const live = liveConnectStatus(saved, { linked: true, cloudUserId: 'owner', managedTunnelActive: true, publishAgentActivity: false })
  expect(observer.read(live.connect, live.remoteEnabled, [], 100).connectionState).toBe('configured')
  expect(observer.read(live.connect, true, [{ sessionId: 'strata', label: 'Strata', current: true, connected: true }], 100).connectionState).toBe('configured')
  expect(observer.read(live.connect, true, [{ sessionId: 'phone', label: 'Phone', current: false, connected: true }], 100).connectionState).toBe('device-connected')
})
it('bounds registration wait and resets it for an explicit retry', () => {
  const observer = new ConnectReadiness()
  observer.read(saved, false, [], 0)
  expect(observer.read(saved, false, [], 600000).connectionState).toBe('failed')
  observer.reset()
  expect(observer.read(saved, false, [], 600001).connectionState).toBe('starting')
})
it('unknown live state is not shown as off and private-network pairing avoids loopback when possible', () => {
  expect(new ConnectReadiness().read(saved, null, []).connectionState).toBe('unavailable')
  expect(preferredPairingEndpoint(['http://127.0.0.1:3774', 'https://computer.example.ts.net'])).toBe('https://computer.example.ts.net')
})

it('reports new cloud startup failures without exposing logs or replaying an old failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-connect-readiness-'))
  try {
    const path = join(root, 'engine.log'), observer = new ConnectReadiness()
    await writeFile(path, 'Failed to reconcile T3 Connect desired link on startup: old failure\n')
    await observer.watchLog(path)
    expect(await observer.failure()).toBeNull()
    await appendFile(path, 'Failed to reconcile T3 Connect desired link on startup: environment_link_limit_exceeded opaque-secret\n')
    expect(await observer.failure()).toContain('computer limit')
    expect(await observer.failure()).not.toContain('opaque-secret')
  } finally { await rm(root, { recursive: true, force: true }) }
})
