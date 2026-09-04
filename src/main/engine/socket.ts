import { randomUUID } from 'node:crypto'

/**
 * One connection to T3's Effect RPC socket (§5.1). Requests get their `Exit`;
 * streams deliver every `Chunk` item and are acknowledged so the server keeps
 * sending. A Ping every `pingMs` with no Pong inside `pongTimeoutMs` closes
 * the socket, which the owner sees as Disconnected instead of a silent stall.
 */
export interface EngineSocketOptions {
  url: URL
  webSocket: typeof WebSocket
  onClose(reason: string): void
  pingMs?: number
  pongTimeoutMs?: number
  requestTimeoutMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export interface EngineStream {
  /** Ends the subscription; the server stops sending for this request. */
  interrupt(): void
}

interface Frame {
  _tag?: string
  requestId?: string
  values?: unknown[]
  exit?: { _tag?: string; value?: unknown; cause?: unknown }
  defect?: unknown
}

export class EngineSocket {
  readonly #socket: WebSocket
  readonly #onClose: (reason: string) => void
  readonly #pingMs: number
  readonly #pongTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #setTimer: typeof setTimeout
  readonly #clearTimer: typeof clearTimeout
  readonly #requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }>()
  readonly #streams = new Map<string, { onItem(item: unknown): void; onEnd(error: Error | null): void }>()
  #opened: Promise<void>
  #closed = false
  #pingTimer: ReturnType<typeof setTimeout> | null = null
  #pongTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: EngineSocketOptions) {
    this.#onClose = options.onClose
    this.#pingMs = options.pingMs ?? 20_000
    this.#pongTimeoutMs = options.pongTimeoutMs ?? 10_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.#setTimer = options.setTimer ?? setTimeout
    this.#clearTimer = options.clearTimer ?? clearTimeout
    this.#socket = new options.webSocket(options.url)
    this.#opened = new Promise<void>((resolve, reject) => {
      this.#socket.addEventListener('open', () => { this.#schedulePing(); resolve() })
      this.#socket.addEventListener('error', () => { reject(new Error('The engine socket is unreachable')); this.#end('The engine socket failed') })
      this.#socket.addEventListener('close', () => { reject(new Error('The engine socket closed')); this.#end('The engine socket closed') })
      this.#socket.addEventListener('message', (event) => this.#receive(String(event.data)))
    })
    // A rejection before anyone awaits open() must not surface as unhandled.
    this.#opened.catch(() => undefined)
  }

  open(): Promise<void> {
    return this.#opened
  }

  get closed(): boolean {
    return this.#closed
  }

  async request(tag: string, payload: unknown): Promise<unknown> {
    await this.#opened
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.#setTimer(() => { this.#requests.delete(id); reject(new Error(`The engine did not answer ${tag} in time`)) }, this.#requestTimeoutMs)
      this.#requests.set(id, { resolve, reject, timer })
      this.#send({ _tag: 'Request', id, tag, payload, headers: [] })
    })
  }

  /**
   * Subscribes and returns once the server accepted the request; items keep
   * arriving through `onItem` until the stream ends or is interrupted.
   */
  async stream(tag: string, payload: unknown, onItem: (item: unknown) => void, onEnd: (error: Error | null) => void = () => undefined): Promise<EngineStream> {
    await this.#opened
    const id = randomUUID()
    this.#streams.set(id, { onItem, onEnd })
    this.#send({ _tag: 'Request', id, tag, payload, headers: [] })
    return {
      interrupt: () => {
        if (!this.#streams.delete(id)) return
        this.#send({ _tag: 'Interrupt', requestId: id, interruptors: [] })
      },
    }
  }

  close(): void {
    this.#end('Closed by Strata', false)
    try { this.#socket.close() } catch { /* already closed */ }
  }

  #receive(raw: string): void {
    let frame: Frame
    try { frame = JSON.parse(raw) as Frame } catch { return }
    switch (frame._tag) {
      case 'Pong':
        if (this.#pongTimer) this.#clearTimer(this.#pongTimer)
        this.#pongTimer = null
        return
      case 'Ping':
        this.#send({ _tag: 'Pong' })
        return
      case 'Chunk': {
        const stream = frame.requestId ? this.#streams.get(frame.requestId) : undefined
        if (stream) for (const item of frame.values ?? []) stream.onItem(item)
        if (frame.requestId) this.#send({ _tag: 'Ack', requestId: frame.requestId })
        return
      }
      case 'Exit': {
        if (!frame.requestId) return
        const request = this.#requests.get(frame.requestId)
        if (request) {
          this.#requests.delete(frame.requestId)
          if (request.timer) this.#clearTimer(request.timer)
          if (frame.exit?._tag === 'Success') request.resolve(frame.exit.value)
          else request.reject(new Error(describeFailure(frame.exit?.cause)))
          return
        }
        const stream = this.#streams.get(frame.requestId)
        if (stream) {
          this.#streams.delete(frame.requestId)
          stream.onEnd(frame.exit?._tag === 'Success' ? null : new Error(describeFailure(frame.exit?.cause)))
        }
        return
      }
      case 'Defect':
        this.#end(`The engine reported a defect: ${describeFailure(frame.defect)}`)
        return
      default:
        return
    }
  }

  #send(frame: unknown): void {
    if (this.#closed) return
    try { this.#socket.send(JSON.stringify(frame)) } catch { this.#end('The engine socket refused a frame') }
  }

  #schedulePing(): void {
    if (this.#closed) return
    this.#pingTimer = this.#setTimer(() => {
      this.#pingTimer = null
      this.#send({ _tag: 'Ping' })
      this.#pongTimer = this.#setTimer(() => this.#end('The engine stopped answering'), this.#pongTimeoutMs)
      this.#pongTimer.unref?.()
      this.#schedulePing()
    }, this.#pingMs)
    this.#pingTimer.unref?.()
  }

  #end(reason: string, notify = true): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#pingTimer) this.#clearTimer(this.#pingTimer)
    if (this.#pongTimer) this.#clearTimer(this.#pongTimer)
    for (const request of this.#requests.values()) { if (request.timer) this.#clearTimer(request.timer); request.reject(new Error(reason)) }
    this.#requests.clear()
    for (const stream of this.#streams.values()) stream.onEnd(new Error(reason))
    this.#streams.clear()
    try { this.#socket.close() } catch { /* already closed */ }
    if (notify) this.#onClose(reason)
  }
}

function describeFailure(cause: unknown): string {
  if (typeof cause === 'string') return cause
  if (cause && typeof cause === 'object') {
    const record = cause as { message?: unknown; error?: { message?: unknown }; failures?: unknown[] }
    if (typeof record.message === 'string') return record.message
    if (typeof record.error?.message === 'string') return record.error.message
    if (Array.isArray(record.failures) && record.failures.length) return describeFailure(record.failures[0])
    return JSON.stringify(cause).slice(0, 200)
  }
  return 'The engine refused the request'
}
