import { connect } from 'node:net'
import { homedir } from 'node:os'
import { getSocketLocation } from '../platform/paths.js'
import {
  type CommandRequest,
  type CommandResponse
} from './protocol.js'

export function socketPathForEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return getSocketLocation({ env: environment, home }).path
}

export class SocketUnavailableError extends Error {
  readonly causeCode?: string

  constructor(message: string, causeCode?: string) {
    super(message)
    this.name = 'SocketUnavailableError'
    if (causeCode !== undefined) this.causeCode = causeCode
  }
}

export interface SocketRequestOptions {
  socketPath?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export function requestOverSocket(
  request: CommandRequest,
  options: SocketRequestOptions = {}
): Promise<CommandResponse> {
  const path = options.socketPath ?? socketPathForEnvironment()

  return new Promise((resolve, reject) => {
    let settled = false
    let received = ''
    const socket = connect(path)

    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      operation()
    }

    const abort = (): void => {
      socket.destroy()
      finish(() => reject(options.signal?.reason ?? new Error('Command aborted')))
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          socket.destroy()
          finish(() => reject(new SocketUnavailableError('StrataMD did not answer in time', 'ETIMEDOUT')))
        }, options.timeoutMs)
      : undefined
    timer?.unref()

    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk: string) => {
      received += chunk
      const newline = received.indexOf('\n')
      if (newline === -1) return
      const line = received.slice(0, newline)
      socket.end()
      finish(() => {
        try {
          const response = JSON.parse(line) as CommandResponse
          if (
            !response ||
            typeof response !== 'object' ||
            (response.id !== request.id && !(response.id === 'invalid' && response.ok === false))
          ) {
            throw new Error('StrataMD returned a mismatched response')
          }
          resolve(response)
        } catch (error) {
          reject(error)
        }
      })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new SocketUnavailableError(
            `Cannot reach StrataMD at ${path}`,
            error.code
          )
        )
      )
    })
    socket.once('end', () => {
      if (received.includes('\n')) return
      finish(() => reject(new Error('StrataMD closed the socket without a response')))
    })
  })
}
