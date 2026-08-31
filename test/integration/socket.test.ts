import { execFile } from 'node:child_process'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOverSocket } from '../../src/cli/socket-client.js'
import { PROTOCOL_VERSION, type CommandRequest } from '../../src/cli/protocol.js'
import {
  AttachWaitRegistry,
  createCommandSocketServer,
  type CommandSocketServer
} from '../../src/main/socket.js'

const servers: CommandSocketServer[] = []
const directories: string[] = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
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
      version: 9,
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
        client.write(`${JSON.stringify({ version: 11, id: 'bad', command: 'attach', args: { timeout: -1 } })}\n`)
      )
      client.on('data', (chunk) => (input += chunk))
      client.once('end', () => resolve(input))
    })
    expect(JSON.parse(response)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(dispatched).toBe(false)
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
