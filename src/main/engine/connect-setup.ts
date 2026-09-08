import type { ConnectStatus } from '../../shared/computer'
import type { ConnectOperation } from './connect'

export interface ConnectSetupHost {
  status(): Promise<ConnectStatus>
  install(signal: AbortSignal, progress: (message: string) => void): Promise<void>
  prepare(): Promise<void>
  stop(): Promise<void>
  start(): Promise<void>
  resume(): Promise<void>
}
export class ConnectRecoveryError extends Error {}
export type ConnectSetupAction = { action: 'login'; method?: 'browser' | 'code' } | { action: 'logout' | 'change-account' } | { action: 'configure'; remote: boolean; publish: boolean }

/** Download while the engine is available; reserve maintenance only for the final settings transaction. */
export async function runConnectSetup(action: ConnectSetupAction, operation: ConnectOperation, host: ConnectSetupHost): Promise<string> {
  if (action.action === 'login') {
    await operation.execute(action.method === 'code' ? ['login', '--headless'] : ['login'])
    return 'Signed in to T3. Continue to choose remote access and mobile notifications.'
  }
  const previous = await host.status()
  if (action.action === 'configure' && (action.remote || action.publish) && !previous.authenticated) throw new Error('Sign in to T3 before enabling remote access or mobile notifications.')
  if (action.action === 'configure' && action.remote && previous.relayClient.status !== 'available') {
    if (previous.relayClient.status === 'unsupported') throw new Error('T3 connection support is unavailable for this computer. Use private-network pairing or update Strata.')
    await operation.confirmDownload()
    operation.phase('installing', 'Installing connection support…')
    await host.install(operation.signal, message => operation.phase('installing', message))
  }
  operation.check()
  let prepared = false, stopped = false, operationError: unknown
  try {
    await host.prepare(); prepared = true; operation.check()
    operation.phase('applying', 'Applying your connection choices…')
    // Once stop begins, always attempt recovery, even if stopping reports an error.
    stopped = true; await host.stop(); operation.check()
    if (action.action === 'configure') {
      if (action.remote) await operation.execute(['link'])
      else if (previous.desired || previous.linked) await operation.execute(['unlink'])
      await operation.execute(action.publish ? ['publish'] : ['publish', '--disable'])
    } else await operation.execute(['logout'])
  } catch (error) { operationError = error }
  finally {
    try {
      if (stopped) { operation.phase('restarting', 'Starting the local engine…'); await host.start() }
    } catch { throw new ConnectRecoveryError('The local engine could not restart after setup. Open Advanced engine details and choose Restart engine.') }
    finally { if (prepared) { try { await host.resume() } catch { throw new ConnectRecoveryError('The local engine could not resume after setup. Open Advanced engine details and restart it.') } } }
  }
  if (operationError) throw operationError
  operation.check()
  if (action.action === 'change-account') {
    operation.phase('authorizing', 'Sign in with the T3 account you want to use.')
    await operation.execute(['login'])
    return 'Signed in. Choose remote access and mobile notifications for this account.'
  }
  return action.action !== 'configure' ? 'Signed out of T3. Remote access and mobile notifications are off.' : action.remote || action.publish ? 'Your connection choices are saved.' : 'Remote access and mobile notifications are off.'
}
