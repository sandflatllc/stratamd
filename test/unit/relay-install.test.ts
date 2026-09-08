import { expect, it } from 'vitest'
import { installRelayClient } from '../../src/main/engine/relay-install'
import type { EngineSocket } from '../../src/main/engine/socket'
it('requires a successful final installer event and reports progress', async () => {
  const messages: string[] = []
  const socket: Pick<EngineSocket, 'stream'> = { stream: async (_tag, _payload, item, end) => {
    item({ type: 'progress', stage: 'downloading' }); item({ type: 'complete', status: { status: 'available' } }); end?.(null)
    return { interrupt() {} }
  } }
  await installRelayClient(socket, new AbortController().signal, message => messages.push(message))
  expect(messages).toEqual(['Downloading connection support…'])
  socket.stream = async (_tag, _payload, _item, end) => { end?.(null); return { interrupt() {} } }
  await expect(installRelayClient(socket, new AbortController().signal, () => undefined)).rejects.toThrow('did not finish')
})
it('cancellation before a stream handle arrives still interrupts the eventual handle', async () => {
  const abort = new AbortController(); let interrupted = 0
  const socket: Pick<EngineSocket, 'stream'> = { stream: async () => { abort.abort(); return { interrupt() { interrupted++ } } } }
  await expect(installRelayClient(socket, abort.signal, () => undefined)).rejects.toThrow('cancelled')
  expect(interrupted).toBe(1)
})
