import { open, stat } from 'node:fs/promises'
import { connectFailure } from './connect-output'
import { connectionChoices, type ComputerView, type ConnectStatus } from '../../shared/computer'

/** Stored tunnel configuration is not a remote reachability proof. This observer never claims it is. */
export class ConnectReadiness {
  #waitingSince: number | null = null
  #log: { path: string; offset: number; failure: string | null } | null = null
  reset(): void { this.#waitingSince = null; this.#log = null }
  async watchLog(path: string): Promise<void> {
    this.reset()
    this.#log = { path, offset: await stat(path).then(value => value.size).catch(() => 0), failure: null }
  }
  async failure(): Promise<string | null> {
    const log = this.#log
    if (!log || log.failure) return log?.failure ?? null
    let file
    try {
      file = await open(log.path, 'r')
      const size = (await file.stat()).size
      const start = Math.max(size < log.offset ? 0 : log.offset, size - 32768)
      const bytes = Buffer.alloc(Math.max(0, size - start))
      await file.read(bytes, 0, bytes.length, start)
      const text = bytes.toString()
      if (text.includes('Failed to reconcile T3 Connect desired link on startup')) log.failure = connectFailure(text)
      return log.failure
    } catch { return null }
    finally { await file?.close() }
  }
  read(connect: ConnectStatus | null, remote: boolean | null, devices: ComputerView['devices'], now = Date.now()): Pick<ComputerView, 'connectionState' | 'connectionMessage'> {
    if (!connect || remote === null) return { connectionState: 'unavailable', connectionMessage: 'Connection status is unavailable. Reconnect the local engine and refresh.' }
    if (!connect.authenticated) { this.reset(); return { connectionState: 'signed-out', connectionMessage: 'Remote access is off. Connect this computer to get started.' } }
    if (connect.desired && !connect.linked) {
      this.#waitingSince ??= now
      return now - this.#waitingSince < 10 * 60 * 1000
        ? { connectionState: 'starting', connectionMessage: 'Starting the T3 connection. This can take a few minutes.' }
        : { connectionState: 'failed', connectionMessage: 'T3 could not finish connecting. Retry setup. If it fails again, check the engine log for a network or account-limit error, or reconnect your account.' }
    }
    this.#waitingSince = null
    if (remote) return devices.some(device => !device.current && device.connected)
      ? { connectionState: 'device-connected', connectionMessage: 'A paired device is connected. Open a conversation there to check that it can send and receive replies.' }
      : { connectionState: 'configured', connectionMessage: 'Remote access is configured. Connect your phone to check that it works.' }
    return { connectionState: 'off', connectionMessage: connect.publishAgentActivity ? 'Mobile notifications are enabled. Remote access is off.' : 'Signed in to T3. Remote access is off.' }
  }
}
export function liveConnectStatus(saved: ConnectStatus, raw: unknown): { connect: ConnectStatus; remoteEnabled: boolean } {
  const live = connectionChoices.parse(raw)
  return { connect: { ...saved, linked: live.linked, cloudUserId: live.cloudUserId, publishAgentActivity: live.publishAgentActivity }, remoteEnabled: live.managedTunnelActive === true }
}
