import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOverSocket, SocketTimeoutError, SocketUnavailableError } from '../../src/cli/socket-client.js'
import { PROTOCOL_VERSION, type CommandRequest } from '../../src/cli/protocol.js'
import {
  AttachWaitRegistry,
  createCommandSocketServer,
  type CommandSocketServer
} from '../../src/main/socket.js'

const servers: CommandSocketServer[] = []
const rawServers: Array<{ server: Server; sockets: Socket[] }> = []
const directories: string[] = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(rawServers.splice(0).map(({ server, sockets }) => {
    for (const socket of sockets) socket.destroy()
    return new Promise<void>((done) => server.close(() => done()))
  }))
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratamd-socket-'))
  directories.push(directory)
  return join(directory, 'run', 'stratamd.sock')
}

function stateRequest(id = 'request-1'): CommandRequest<'state'> {
  return { version: PROTOCOL_VERSION, id, command: 'state', args: {} }
}

describe('newline JSON socket', () => {
  it('uses the default runtime path and verifies real Linux peer credentials', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'stratamd-default-socket-'))
    directories.push(runtimeDirectory)
    vi.stubEnv('XDG_RUNTIME_DIR', runtimeDirectory)
    let observedPeerUid: number | undefined
    const server = await createCommandSocketServer({
      handler: (request, context) => {
        observedPeerUid = context.peerUid
        return { version: 11, event: 'state', text: request.id }
      }
    })
    servers.push(server)

    expect(server.path).toBe(join(runtimeDirectory, 'stratamd.sock'))
    const response = await requestOverSocket(stateRequest(), { timeoutMs: 1_000 })
    expect(response).toMatchObject({ ok: true, id: 'request-1' })
    expect(observedPeerUid).toBe(process.getuid?.())
  })

  it('serves one framed request and creates a 0600 socket', async () => {
    const path = await socketPath()
    let observedPeerUid: number | undefined
    const server = await createCommandSocketServer({
      socketPath: path,
      handler: (request, context) => {
        observedPeerUid = context.peerUid
        return { version: 11, event: 'state', text: request.id }
      }
    })
    servers.push(server)

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const response = await requestOverSocket(stateRequest(), { socketPath: path, timeoutMs: 1_000 })
    expect(response).toEqual({
      version: PROTOCOL_VERSION,
      id: 'request-1',
      ok: true,
      result: { version: 11, event: 'state', text: 'request-1' }
    })
    expect(observedPeerUid).toBe(process.getuid?.())
  })

  it('returns structured usage errors for malformed input', async () => {
    const path = await socketPath()
    const server = await createCommandSocketServer({ socketPath: path, handler: () => undefined })
    servers.push(server)

    const response = await new Promise<string>((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      client.once('connect', () => client.write('{bad json}\n'))
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(input))
    })
    expect(JSON.parse(response)).toMatchObject({
      ok: false,
      exitCode: 1,
      error: { code: 'INVALID_JSON' }
    })
  })

  it('does not dispatch commands with invalid arguments', async () => {
    const path = await socketPath()
    let dispatched = false
    const server = await createCommandSocketServer({
      socketPath: path,
      handler: () => {
        dispatched = true
      }
    })
    servers.push(server)

    const response = await new Promise<string>((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      client.once('connect', () =>
        client.write(`${JSON.stringify({ version: PROTOCOL_VERSION, id: 'bad', command: 'attach', args: { timeout: -1 } })}\n`)
      )
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(input))
    })
    expect(JSON.parse(response)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(dispatched).toBe(false)
  })

  it('answers a request from another protocol version with PROTOCOL_MISMATCH, naming both sides', async () => {
    const path = await socketPath()
    let dispatched = false
    const server = await createCommandSocketServer({ socketPath: path, handler: () => { dispatched = true } })
    servers.push(server)

    const send = (version: number): Promise<Record<string, unknown>> => new Promise((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      client.once('connect', () =>
        client.write(`${JSON.stringify({ version, id: `v${version}`, command: 'state', args: {} })}\n`)
      )
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(JSON.parse(input) as Record<string, unknown>))
    })

    // A newer CLI than the app: the app must be restarted.
    const newer = await send(PROTOCOL_VERSION + 1)
    expect(newer).toMatchObject({
      version: PROTOCOL_VERSION,
      id: `v${PROTOCOL_VERSION + 1}`,
      ok: false,
      exitCode: 4,
      error: {
        code: 'PROTOCOL_MISMATCH',
        detail: { app: PROTOCOL_VERSION, cli: PROTOCOL_VERSION + 1 },
      },
    })
    expect((newer.error as { error: string }).error).toContain('restart StrataMD to pick up the new build')

    // An older CLI than the app: the command must be updated.
    const older = await send(PROTOCOL_VERSION - 1)
    expect(older).toMatchObject({ ok: false, exitCode: 4, error: { code: 'PROTOCOL_MISMATCH' } })
    expect((older.error as { error: string }).error).toContain('update the stratamd command')
    expect(dispatched).toBe(false)

    // The version check comes before argument validation, so a stale build
    // never sees INVALID_REQUEST for a shape it cannot know.
    const staleShape = await new Promise<Record<string, unknown>>((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      client.once('connect', () =>
        client.write(`${JSON.stringify({ version: PROTOCOL_VERSION + 1, id: 'shape', command: 'edit', args: { nonsense: true } })}\n`)
      )
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(JSON.parse(input) as Record<string, unknown>))
    })
    expect(staleShape).toMatchObject({ error: { code: 'PROTOCOL_MISMATCH' } })
  })

  it('rejects a peer uid mismatch before dispatch', async () => {
    const path = await socketPath()
    let dispatched = false
    const server = await createCommandSocketServer({
      socketPath: path,
      uid: 1000,
      getPeerUid: () => 1001,
      handler: () => {
        dispatched = true
      }
    })
    servers.push(server)
    const response = await requestOverSocket(stateRequest(), { socketPath: path, timeoutMs: 1_000 })
    expect(response).toMatchObject({ ok: false, exitCode: 4, error: { code: 'PEER_REJECTED' } })
    expect(dispatched).toBe(false)
  })

  it('fails closed when peer credentials cannot be read', async () => {
    const path = await socketPath()
    let dispatched = false
    const server = await createCommandSocketServer({
      socketPath: path,
      getPeerUid: () => undefined,
      handler: () => { dispatched = true }
    })
    servers.push(server)

    const response = await requestOverSocket(stateRequest(), { socketPath: path, timeoutMs: 1_000 })
    expect(response).toMatchObject({ ok: false, exitCode: 4, error: { code: 'PEER_REJECTED' } })
    expect(dispatched).toBe(false)
  })
})

describe('connection hygiene', () => {
  it('times out a connection that never completes its request line', async () => {
    const path = await socketPath()
    let dispatched = false
    const server = await createCommandSocketServer({
      socketPath: path,
      idleTimeoutMs: 100,
      handler: () => { dispatched = true }
    })
    servers.push(server)

    const response = await new Promise<string>((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      // Half a request, no newline: the server must not wait forever.
      client.once('connect', () => client.write('{"version":9,"id":"slow"'))
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(input))
    })
    expect(JSON.parse(response)).toMatchObject({ ok: false, error: { code: 'REQUEST_TIMEOUT' } })
    expect(dispatched).toBe(false)
  })

  it('closes the connection when bytes follow the dispatched request', async () => {
    const path = await socketPath()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const server = await createCommandSocketServer({
      socketPath: path,
      handler: async () => {
        await held
        return { late: true }
      }
    })
    servers.push(server)

    const outcome = await new Promise<{ closed: boolean; input: string }>((resolve) => {
      const client = connect(path)
      let input = ''
      client.setEncoding('utf8')
      client.once('connect', () => {
        client.write(`${JSON.stringify(stateRequest('first'))}\n`)
        setTimeout(() => client.write('second line while the first is in flight\n'), 50)
      })
      client.on('data', (chunk) => (input += chunk))
      client.once('close', () => resolve({ closed: true, input }))
      setTimeout(() => resolve({ closed: false, input }), 1_500)
    })
    release()
    expect(outcome.closed).toBe(true)
    expect(outcome.input).toBe('')
  })
})

describe('client timeout classification', () => {
  it('distinguishes a stalled instance from an absent one', async () => {
    const absent = await socketPath()
    await expect(requestOverSocket(stateRequest(), { socketPath: absent, timeoutMs: 500 }))
      .rejects.toBeInstanceOf(SocketUnavailableError)

    const stalled = await socketPath()
    await mkdir(dirname(stalled), { recursive: true })
    const sockets: Socket[] = []
    // Accepts the connection and never answers: a running but stalled instance.
    const server = createServer((socket) => { sockets.push(socket) })
    rawServers.push({ server, sockets })
    await new Promise<void>((listening) => server.listen(stalled, listening))
    const failure = await requestOverSocket(stateRequest(), { socketPath: stalled, timeoutMs: 100 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SocketTimeoutError)
    expect(failure).not.toBeInstanceOf(SocketUnavailableError)
  })
})

describe('blocking attach registry', () => {
  it('supersedes an older call for the same canonical attachment', async () => {
    const registry = new AttachWaitRegistry<string>()
    const first = registry.wait('/doc.md\0ag_1', 5_000, new AbortController().signal)
    const second = registry.wait('/doc.md\0ag_1', 5_000, new AbortController().signal)
    expect(await first).toEqual({ event: 'superseded' })
    expect(registry.deliver('/doc.md\0ag_1', 'd_1')).toBe(true)
    expect(await second).toEqual({ event: 'delivery', value: 'd_1' })
  })

  it('returns timeout without consuming a delivery', async () => {
    const registry = new AttachWaitRegistry<string>()
    await expect(registry.wait('key', 0, new AbortController().signal)).resolves.toEqual({ event: 'timeout' })
    expect(registry.deliver('key', 'late')).toBe(false)
  })
})

describe('plain Node executable', () => {
  it('runs an offline state command without launching a browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratamd-bin-'))
    directories.push(directory)
    const document = join(directory, 'document.md')
    await writeFile(document, '# Offline\n\nUnsaved work is visible here.\n', 'utf8')
    const { stdout, stderr } = await executeFile(join(process.cwd(), 'bin', 'stratamd'), ['state', document], {
      env: {
        ...process.env,
        HOME: join(directory, 'home'),
        XDG_DATA_HOME: join(directory, 'data'),
        XDG_RUNTIME_DIR: join(directory, 'no-running-instance')
      }
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      version: 11,
      event: 'state',
      file: document,
      document: '# Offline\n\nUnsaved work is visible here.\n'
    })
  })
})
