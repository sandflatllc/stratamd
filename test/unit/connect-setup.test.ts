import { expect, it } from 'vitest'
import { runConnectSetup, ConnectRecoveryError, type ConnectSetupHost } from '../../src/main/engine/connect-setup'
import type { ConnectOperation } from '../../src/main/engine/connect'
import { readConnectOutput, connectFailure } from '../../src/main/engine/connect-output'

function fixture() {
  const events: string[] = [], abort = new AbortController()
  const operation: ConnectOperation = {
    signal: abort.signal, check: () => { if (abort.signal.aborted) throw new Error('cancelled') },
    execute: async args => { events.push(args.join(' ')); if (abort.signal.aborted) throw new Error('cancelled') },
    phase: () => undefined, confirmDownload: async () => { events.push('consent') },
  }
  const host: ConnectSetupHost = {
    status: async () => ({ desired: false, authenticated: true, linked: false, cloudUserId: null, publishAgentActivity: false, relayClient: { status: 'missing' } }),
    install: async () => { events.push('install') }, prepare: async () => { events.push('prepare') }, stop: async () => { events.push('stop') }, start: async () => { events.push('start') }, resume: async () => { events.push('resume') },
  }
  return { events, abort, operation, host }
}
it('downloads before maintenance and applies both choices with exactly one restart', async () => {
  const f = fixture()
  await runConnectSetup({ action: 'configure', remote: true, publish: true }, f.operation, f.host)
  expect(f.events).toEqual(['consent', 'install', 'prepare', 'stop', 'link', 'publish', 'start', 'resume'])
})
it('first login uses a callback without taking engine maintenance; a code login is explicit', async () => {
  const f = fixture()
  await runConnectSetup({ action: 'login' }, f.operation, f.host)
  await runConnectSetup({ action: 'login', method: 'code' }, f.operation, f.host)
  expect(f.events).toEqual(['login', 'login --headless'])
})
it('declined installation never stops the local engine or enables access', async () => {
  const f = fixture(); f.operation.confirmDownload = async () => { throw new Error('declined') }
  await expect(runConnectSetup({ action: 'configure', remote: true, publish: true }, f.operation, f.host)).rejects.toThrow('declined')
  expect(f.events).toEqual([])
})
it('work that starts during download refuses maintenance without stopping the engine', async () => {
  const f = fixture(); f.host.prepare = async () => { throw new Error('active conversation') }
  await expect(runConnectSetup({ action: 'configure', remote: true, publish: false }, f.operation, f.host)).rejects.toThrow('active conversation')
  expect(f.events).toEqual(['consent', 'install'])
})
it('failed or cancelled command restores the engine before surfacing its result', async () => {
  const f = fixture(); f.operation.execute = async () => { f.abort.abort(); throw new Error('cancelled') }
  await expect(runConnectSetup({ action: 'configure', remote: true, publish: true }, f.operation, f.host)).rejects.toThrow('cancelled')
  expect(f.events.slice(-2)).toEqual(['start', 'resume'])
})
it('failed shutdown still attempts restart and a recovery failure remains distinct from cancellation', async () => {
  const f = fixture(); f.host.stop = async () => { f.abort.abort(); throw new Error('stop failed') }; f.host.start = async () => { throw new Error('start failed') }
  await expect(runConnectSetup({ action: 'logout' }, f.operation, f.host)).rejects.toBeInstanceOf(ConnectRecoveryError)
  expect(f.events.at(-1)).toBe('resume')
})
it('turning remote off retains the requested notification setting', async () => {
  const f = fixture(); const saved = await f.host.status(); f.host.status = async () => ({ ...saved, desired: true, linked: true, publishAgentActivity: true })
  await runConnectSetup({ action: 'configure', remote: false, publish: true }, f.operation, f.host)
  expect(f.events).toEqual(['prepare', 'stop', 'unlink', 'publish', 'start', 'resume'])
})
it('changing accounts clears authorization and restores the engine before fresh login', async () => {
  const f = fixture()
  await runConnectSetup({ action: 'change-account' }, f.operation, f.host)
  expect(f.events).toEqual(['prepare', 'stop', 'logout', 'start', 'resume', 'login'])
})
it('recognizes current stock prompts, cancellation and actionable failures without exposing raw output', () => {
  expect(readConnectOutput('Open this URL to authorize T3 Connect:\n https://app.t3.codes/connect?state=opaque\n')).toMatchObject({ phase: 'browser' })
  expect(readConnectOutput('Headless authorization\nhttps://app.t3.codes/connect?state=new\n? Authorization code › ')).toMatchObject({ phase: 'code' })
  expect(readConnectOutput('Authorization code\n')).toMatchObject({ phase: 'code' })
  expect(readConnectOutput('? Download and install version 2026.5.2? › (y/N)')).toMatchObject({ phase: 'download' })
  expect(readConnectOutput('T3 Connect setup cancelled. The relay client was not installed.').cancelled).toBe(true)
  expect(connectFailure('environment_link_limit_exceeded secret-token')).toContain('computer limit')
  expect(connectFailure('secret-token')).not.toContain('secret-token')
})
