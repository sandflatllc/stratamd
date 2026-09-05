/**
 * An in-process stand-in for T3's RPC socket for unit tests: the "server" side
 * answers requests from a handler table and can push Chunk items into any
 * open stream, so a test proves the view changes with no poll tick at all.
 */
export interface FakeEngineServer {
  /** Every Request the client sent, in order. */
  requests: Array<{ tag: string; payload: unknown; socket: number }>
  /** Open sockets, oldest first. */
  sockets: FakeSocketHandle[]
  /** Pushes stream items to every open subscription with this tag. */
  push(tag: string, items: unknown[]): void
  /** Closes every open socket from the server side, as a dropped connection would. */
  dropAll(): void
  /** The WebSocket constructor to hand the client. */
  WebSocket: typeof WebSocket
}

export interface FakeSocketHandle {
  index: number
  closed: boolean
  streams: Array<{ id: string; tag: string; payload: unknown }>
  close(): void
}

type Listener = (event: { data?: string }) => void

export function fakeEngineServer(answer: (tag: string, payload: unknown) => unknown = () => null): FakeEngineServer {
  const requests: FakeEngineServer['requests'] = []
  const sockets: FakeSocketHandle[] = []
  const senders = new Map<number, (frame: unknown) => void>()

  class FakeSocket {
    readonly #listeners = new Map<string, Listener[]>()
    readonly #handle: FakeSocketHandle
    constructor(_url: URL) {
      const index = sockets.length
      this.#handle = { index, closed: false, streams: [], close: () => this.#serverClose() }
      sockets.push(this.#handle)
      senders.set(index, (frame) => this.#emit('message', { data: JSON.stringify(frame) }))
      queueMicrotask(() => this.#emit('open', {}))
    }
    addEventListener(type: string, listener: Listener): void { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]) }
    send(data: string): void {
      if (this.#handle.closed) throw new Error('socket closed')
      const frame = JSON.parse(data) as { _tag: string; id?: string; tag?: string; payload?: unknown; requestId?: string }
      if (frame._tag === 'Ping') { queueMicrotask(() => senders.get(this.#handle.index)?.({ _tag: 'Pong' })); return }
      if (frame._tag === 'Ack') return
      if (frame._tag === 'Interrupt') { this.#handle.streams = this.#handle.streams.filter((stream) => stream.id !== frame.requestId); return }
      if (frame._tag !== 'Request' || !frame.id || !frame.tag) return
      requests.push({ tag: frame.tag, payload: frame.payload, socket: this.#handle.index })
      if (frame.tag.startsWith('orchestration.subscribe') || frame.tag === 'terminal.attach') {
        this.#handle.streams.push({ id: frame.id, tag: frame.tag, payload: frame.payload })
        const initial = answer(frame.tag, frame.payload)
        if (Array.isArray(initial)) queueMicrotask(() => senders.get(this.#handle.index)?.({ _tag: 'Chunk', requestId: frame.id, values: initial }))
        return
      }
      const value = answer(frame.tag, frame.payload)
      queueMicrotask(() => senders.get(this.#handle.index)?.({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value } }))
    }
    close(): void { if (!this.#handle.closed) { this.#handle.closed = true; senders.delete(this.#handle.index) } }
    #serverClose(): void { if (this.#handle.closed) return; this.#handle.closed = true; senders.delete(this.#handle.index); this.#emit('close', {}) }
    #emit(type: string, event: { data?: string }): void { for (const listener of this.#listeners.get(type) ?? []) listener(event) }
  }

  return {
    requests,
    sockets,
    push: (tag, items) => {
      for (const socket of sockets) {
        if (socket.closed) continue
        for (const stream of socket.streams) if (stream.tag === tag) senders.get(socket.index)?.({ _tag: 'Chunk', requestId: stream.id, values: items })
      }
    },
    dropAll: () => { for (const socket of [...sockets]) socket.close() },
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  }
}
