import { mkdir, chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CommandFailure,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  errorResponse,
  isCommandRequest,
  type CommandRequest,
  type CommandResponse,
  type SocketCommandHandler
} from '../cli/protocol.js'
import { socketPathForEnvironment } from '../cli/socket-client.js'
import { peerUidFromSocket } from './peer-credentials.js'

export interface CommandSocketServerOptions {
  handler: SocketCommandHandler
  socketPath?: string
  uid?: number
  getPeerUid?: (socket: Socket) => number | undefined
  maxRequestBytes?: number
}

export interface CommandSocketServer {
  readonly path: string
  readonly server: Server
  close(): Promise<void>
}

export type AttachWaitResult<T> =
  | { event: 'delivery'; value: T }
  | { event: 'timeout' }
  | { event: 'superseded' }

interface PendingAttach<T> {
  resolve: (result: AttachWaitResult<T>) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

/**
 * Tracks only live blocking calls. Deliveries remain in the session store until
 * the CLI sends `ack`; this registry must never dequeue one.
 */
export class AttachWaitRegistry<T> {
  readonly #pending = new Map<string, PendingAttach<T>>()

  wait(key: string, timeoutMs: number, signal: AbortSignal): Promise<AttachWaitResult<T>> {
    this.#pending.get(key)?.resolve({ event: 'superseded' })

    return new Promise<AttachWaitResult<T>>((resolve, reject) => {
      const finish = (operation: () => void): void => {
        const pending = this.#pending.get(key)
        if (pending?.resolve !== wrappedResolve) return
        this.#pending.delete(key)
        cleanup()
        operation()
      }
      const wrappedResolve = (result: AttachWaitResult<T>): void => finish(() => resolve(result))
      const wrappedReject = (error: unknown): void => finish(() => reject(error))
      const abort = (): void => wrappedReject(signal.reason ?? new Error('Attach call disconnected'))
      const timer = setTimeout(() => wrappedResolve({ event: 'timeout' }), timeoutMs)
      timer.unref()
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }

      this.#pending.set(key, { resolve: wrappedResolve, reject: wrappedReject, cleanup })
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  deliver(key: string, value: T): boolean {
    const pending = this.#pending.get(key)
    if (!pending) return false
    pending.resolve({ event: 'delivery', value })
    return true
  }

  cancel(key: string, error: unknown): boolean {
    const pending = this.#pending.get(key)
    if (!pending) return false
    pending.reject(error)
    return true
  }

  rejectAll(error: unknown): void {
    for (const pending of [...this.#pending.values()]) pending.reject(error)
  }
}

async function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

async function prepareSocketPath(
  path: string,
  uid: number | undefined,
  tightenParent: boolean
): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })

  // The XDG runtime directory may have been created by the login manager. The
  // fallback is ours, and chmod also repairs a permissive directory from an
  // interrupted older install.
  if (tightenParent) await chmod(parent, 0o700)

  try {
    const entry = await lstat(path)
    if (!entry.isSocket()) {
      throw new Error(`Refusing to replace non-socket path ${path}`)
    }
    if (uid !== undefined && entry.uid !== uid) {
      throw new Error(`Refusing to replace a socket owned by uid ${entry.uid}`)
    }
    if (await socketIsLive(path)) {
      throw new Error(`StrataMD is already listening at ${path}`)
    }
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function writeResponse(socket: Socket, response: CommandResponse): void {
  if (socket.destroyed) return
  socket.end(`${JSON.stringify(response)}\n`)
}

function rejectPeer(socket: Socket, message: string): void {
  writeResponse(
    socket,
    errorResponse('invalid', new CommandFailure(message, 4, 'PEER_REJECTED'))
  )
}

export async function createCommandSocketServer(
  options: CommandSocketServerOptions
): Promise<CommandSocketServer> {
  const path = options.socketPath ?? socketPathForEnvironment()
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid! < 0) {
    throw new Error('StrataMD requires a Linux process uid for its command socket')
  }
  const maxBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES
  await prepareSocketPath(
    path,
    uid,
    options.socketPath === undefined && !process.env.XDG_RUNTIME_DIR?.startsWith('/')
  )

  const connections = new Set<Socket>()

  const server = createServer((socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    let peerUid: number
    try {
      const observed = (options.getPeerUid ?? peerUidFromSocket)(socket)
      if (!Number.isSafeInteger(observed) || observed! < 0) {
        throw new Error('SO_PEERCRED did not return a uid')
      }
      peerUid = observed!
    } catch {
      rejectPeer(socket, 'Socket peer credentials could not be verified')
      return
    }
    if (peerUid !== uid) {
      rejectPeer(socket, 'Socket peer uid does not match the StrataMD process')
      return
    }

    let input = ''
    let dispatched = false
    const controller = new AbortController()
    const connectionId = randomUUID()

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (dispatched) return
      input += chunk
      if (Buffer.byteLength(input) > maxBytes) {
        dispatched = true
        writeResponse(
          socket,
          errorResponse('invalid', new CommandFailure('Request is too large', 1, 'REQUEST_TOO_LARGE'))
        )
        return
      }

      const newline = input.indexOf('\n')
      if (newline === -1) return
      dispatched = true
      const line = input.slice(0, newline)
      let request: CommandRequest
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isCommandRequest(parsed)) {
          throw new CommandFailure('Invalid socket request', 1, 'INVALID_REQUEST')
        }
        request = parsed
      } catch (error) {
        writeResponse(
          socket,
          errorResponse(
            'invalid',
            error instanceof CommandFailure
              ? error
              : new CommandFailure('Malformed JSON request', 1, 'INVALID_JSON')
          )
        )
        return
      }

      void Promise.resolve(
        options.handler(request, {
          connectionId,
          signal: controller.signal,
          peerUid
        })
      ).then(
        (result) => {
          const response: CommandResponse = {
            version: PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            ...(result === undefined ? {} : { result })
          }
          writeResponse(socket, response)
        },
        (error: unknown) => writeResponse(socket, errorResponse(request.id, error))
      )
    })
    socket.once('close', () => controller.abort(new Error('Socket client disconnected')))
    socket.once('error', () => controller.abort(new Error('Socket connection failed')))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolve()
    })
  })
  await chmod(path, 0o600)
  const identity = await lstat(path)

  return {
    path,
    server,
    async close(): Promise<void> {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      try {
        const current = await lstat(path)
        if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
