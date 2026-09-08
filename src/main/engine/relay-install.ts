import { z } from 'zod'
import type { EngineSocket, EngineStream } from './socket'
import { connectFailure } from './connect-output'
const installationEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), stage: z.string() }),
  z.object({ type: z.literal('complete'), status: z.object({ status: z.string() }) }),
])
const stages: Record<string, string> = { checking: 'Checking connection support…', waiting_for_lock: 'Waiting for the installer…', downloading: 'Downloading connection support…', verifying: 'Checking the download…', installing: 'Installing connection support…', validating: 'Checking the installation…', activating: 'Preparing remote access…' }
export async function installRelayClient(socket: Pick<EngineSocket, 'stream'>, signal: AbortSignal, progress: (message: string) => void): Promise<void> {
  if (signal.aborted) throw new Error('Setup cancelled.')
  await new Promise<void>((resolve, reject) => {
    let stream: EngineStream | undefined, done = false, installed = false
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); stream?.interrupt()
      error ? reject(error) : resolve()
    }
    const cancel = () => finish(new Error('Setup cancelled.'))
    const timer = setTimeout(() => finish(new Error('Connection support took too long to install. Check your network and retry.')), 10 * 60 * 1000)
    signal.addEventListener('abort', cancel, { once: true })
    void socket.stream('cloud.installRelayClient', {}, raw => {
      if (done) return
      const event = installationEvent.safeParse(raw)
      if (!event.success) { finish(new Error('T3 returned an unsupported installer response. Update Strata and retry.')); return }
      if (event.data.type === 'progress') progress(stages[event.data.stage] ?? 'Installing connection support…')
      else installed = event.data.status.status === 'available'
    }, error => finish(error ? new Error(connectFailure(error.message)) : installed ? undefined : new Error('Connection support did not finish installing. Retry the download.'))).then(value => { stream = value; if (done) value.interrupt() }, error => finish(new Error(connectFailure(String(error)))))
  })
}
