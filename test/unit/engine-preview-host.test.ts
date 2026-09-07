import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient, type PreviewHostBridge } from '../../src/main/engine/client'
import { readEngineIdentity } from '../../src/main/engine/identity'
import { fakeEngineServer } from './support/fake-engine-socket'

/**
 * Registering as the engine's browser host (docs/plans/open/visual-review,
 * phase 2): one identity read, a connect stream over the socket Strata
 * already holds, requests answered on the same socket with the thread id
 * they carried, and registration repeated on reconnect only to the same
 * engine identity.
 */
const at = '2026-09-05T12:00:00.000Z'
const thread = {
  id: 't1', projectId: 'p1', title: 'Clients table review', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Mesa', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

function engine(options: { identity?: string | null; accept?: boolean } = {}) {
  let identity = options.identity === undefined ? 'env-1' : options.identity
  const answers: unknown[] = []
  const server = fakeEngineServer((tag, payload) => {
    if (tag.startsWith('orchestration.subscribe')) return [{ kind: 'synchronized' }]
    if (tag === 'previewAutomation.connect') return options.accept === false ? null : [{ type: 'connected', connectionId: 'conn-1' }]
    if (tag === 'previewAutomation.respond') { answers.push(payload); return null }
    return null
  })
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/.well-known/t3/environment') && new Headers(init?.headers).get('authorization') !== 'Bearer secret') return new Response('authentication required', { status: 401 })
    if (url.endsWith('/.well-known/t3/environment')) return identity ? Response.json({ environmentId: identity, label: 'Fake' }) : new Response('nope', { status: 404 })
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages: [], activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { server, fetch, answers, setIdentity: (value: string | null) => { identity = value } }
}

function host(): PreviewHostBridge & { registered: boolean; requests: unknown[] } {
  const bridge = {
    registered: false,
    requests: [] as unknown[],
    operations: ['status', 'open', 'click'],
    async handle(request: { requestId: string; threadId: string; operation: string; input: unknown }) {
      bridge.requests.push(request)
      if (request.operation === 'click') return { ok: false as const, error: { _tag: 'PreviewAutomationTabNotFoundError', message: 'closed' } }
      return { ok: true as const, result: { available: true, threadId: request.threadId } }
    },
    setRegistered(registered: boolean) { bridge.registered = registered },
  }
  return bridge
}

async function client(fake: ReturnType<typeof engine>, directory: string, bridge: PreviewHostBridge) {
  const instance = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0, reconnectDelaysMs: [5], previewHost: bridge })
  await instance.pair('http://engine.test', 'code')
  await settle()
  return instance
}

describe('the engine identity read', () => {
  it('reads the environment id from the well-known descriptor and refuses anything else', async () => {
    const fake = engine()
    expect(await readEngineIdentity(fake.fetch, 'http://engine.test', 3000, 'secret')).toEqual({ environmentId: 'env-1', label: 'Fake' })
    fake.setIdentity(null)
    await expect(readEngineIdentity(fake.fetch, 'http://engine.test', 3000, 'secret')).rejects.toThrow('did not describe itself')
  })
})

describe('registering as the browser host', () => {
  it('registers with the operations it implements, serves a request on the same socket, and reports the answer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-preview-host-'))
    const fake = engine()
    const bridge = host()
    const instance = await client(fake, directory, bridge)
    const connect = fake.server.requests.find((request) => request.tag === 'previewAutomation.connect')
    expect(connect?.payload).toMatchObject({ environmentId: 'env-1', supportedOperations: ['status', 'open', 'click'] })
    expect(String((connect?.payload as { clientId: string }).clientId)).toMatch(/^strata-/)
    await vi.waitFor(() => expect(bridge.registered).toBe(true))
    fake.server.push('previewAutomation.connect', [{ type: 'request', connectionId: 'conn-1', request: { requestId: 'r1', threadId: 't1', tabId: null, operation: 'status', input: {}, timeoutMs: 1000 } }])
    await vi.waitFor(() => expect(fake.answers).toHaveLength(1))
    expect(fake.answers[0]).toMatchObject({ connectionId: 'conn-1', requestId: 'r1', ok: true, result: { available: true, threadId: 't1' } })
    fake.server.push('previewAutomation.connect', [{ type: 'request', connectionId: 'conn-1', request: { requestId: 'r2', threadId: 't1', tabId: 'tab_gone', operation: 'click', input: {}, timeoutMs: 1000 } }])
    await vi.waitFor(() => expect(fake.answers).toHaveLength(2))
    expect(fake.answers[1]).toMatchObject({ requestId: 'r2', ok: false, error: { _tag: 'PreviewAutomationTabNotFoundError' } })
    expect(bridge.requests[1]).toMatchObject({ tabId: 'tab_gone' })
    // A dropped socket ends the registration; the reconnect registers again with the same identity.
    fake.server.dropAll()
    await vi.waitFor(() => expect(bridge.registered).toBe(false))
    await vi.waitFor(() => expect(fake.server.requests.filter((request) => request.tag === 'previewAutomation.connect')).toHaveLength(2), { timeout: 3_000 })
    await vi.waitFor(() => expect(bridge.registered).toBe(true))
    await instance.shutdown()
  })

  it('stays unregistered when the engine does not accept hosts, and never re-registers with another identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-preview-host-refused-'))
    const fake = engine({ accept: false })
    const bridge = host()
    const instance = await client(fake, directory, bridge)
    expect(bridge.registered).toBe(false)
    await instance.shutdown()

    const changing = engine()
    const bridge2 = host()
    const second = await client(changing, await mkdtemp(join(tmpdir(), 'strata-preview-host-identity-')), bridge2)
    await vi.waitFor(() => expect(bridge2.registered).toBe(true))
    changing.setIdentity('env-2')
    changing.server.dropAll()
    await vi.waitFor(() => expect(bridge2.registered).toBe(false))
    await vi.waitFor(() => expect(changing.server.requests.filter((request) => request.tag === 'orchestration.subscribeShell')).toHaveLength(2), { timeout: 3_000 })
    await settle()
    expect(changing.server.requests.filter((request) => request.tag === 'previewAutomation.connect')).toHaveLength(1)
    expect(bridge2.registered).toBe(false)
    await second.shutdown()
  })
})
