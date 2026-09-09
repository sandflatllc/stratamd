import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'

const thread = {
  id: 't1', projectId: 'p1', title: 'Live thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'running', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: 'turn-1', lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
const detail = { snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages: [{ id: 'm1', role: 'user', text: 'Start.', attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }], activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } }

function event(sequence: number, type: string, payload: unknown) {
  return { kind: 'event', event: { sequence, eventId: `e${sequence}`, aggregateKind: 'thread', aggregateId: 't1', occurredAt: at, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type, payload } }
}

function messageSent(sequence: number, messageId: string, text: string, streaming: boolean) {
  return event(sequence, 'thread.message-sent', { threadId: 't1', messageId, role: 'assistant', text, turnId: 'turn-1', streaming, createdAt: at, updatedAt: at })
}

/** Lets the fake socket's microtask hops (send, chunk, handler) settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function engineFetch() {
  let snapshots = 0
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) { snapshots += 1; return Response.json(shell) }
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail)
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, shellSnapshots: () => snapshots }
}

describe('live engine subscriptions (§5.1)', () => {
  it('a thread attached to a document streams too, so an agent block posted while another conversation is open still arrives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-live-'))
    const second = { ...thread, id: 't2', title: 'Attached thread' }
    const shellWithTwo = { ...shell, threads: [thread, second] }
    const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shellWithTwo)
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail)
      if (url.endsWith('/api/orchestration/threads/t2')) return Response.json({ ...detail, thread: { ...detail.thread, ...second, messages: [] } })
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await client.watchThreads(['t2'])
    await settle()
    const threadSubscriptions = () => server.requests.filter((request) => request.tag === 'orchestration.subscribeThread').map((request) => (request.payload as { threadId: string }).threadId)
    expect(threadSubscriptions()).toEqual(['t1', 't2'])

    const posted = { ...messageSent(11, 'a1', 'Done.\n\n```strata\n[]\n```', false), event: { ...messageSent(11, 'a1', 'Done.', false).event, aggregateId: 't2', payload: { threadId: 't2', messageId: 'a1', role: 'assistant', text: 'Done.', turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at } } }
    server.push('orchestration.subscribeThread', [posted])
    await settle()
    const threads = client.view().projects[0]!.threads
    expect(threads.find((candidate) => candidate.id === 't2')!.messages.map((message) => message.id)).toEqual(['a1'])
    expect(threads.find((candidate) => candidate.id === 't1')!.messages.map((message) => message.id)).toEqual(['m1'])

    // Detaching stops following: the subscription is interrupted and no new one opens.
    await client.watchThreads([])
    await settle()
    // Server configuration is a separate connection-wide stream, not another shell.
    expect(server.sockets[0]!.streams.map(stream => stream.tag === 'orchestration.subscribeThread' ? `${stream.tag}:${(stream.payload as { threadId: string }).threadId}` : stream.tag).sort()).toEqual(['orchestration.subscribeShell', 'orchestration.subscribeThread:t1', 'subscribeServerConfig'])
    expect(threadSubscriptions()).toEqual(['t1', 't2'])
    await client.shutdown()
    expect(server.sockets.filter(socket => !socket.closed)).toEqual([])
  })

  it('switching the selected thread closes its old subscription and reconnect follows only the new selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-selection-'))
    const second = { ...thread, id: 't2', title: 'Second thread' }
    const server = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const baseline = engineFetch().fetch
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/orchestration/shell')) return Response.json({ ...shell, threads: [thread, second] })
      if (url.endsWith('/api/orchestration/threads/t2')) return Response.json({ ...detail, thread: { ...detail.thread, ...second, messages: [] } })
      return baseline(input, init)
    }
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    const followed = () => server.sockets.filter(socket => !socket.closed).flatMap(socket => socket.streams.filter(stream => stream.tag === 'orchestration.subscribeThread').map(stream => (stream.payload as { threadId: string }).threadId))
    try {
      await client.pair('http://engine.test', 'code')
      expect(followed()).toEqual([])
      await client.openThread('t1'); await settle()
      expect(followed()).toEqual(['t1'])
      await client.openThread('t2'); await settle()
      expect(followed()).toEqual(['t2'])
      server.dropAll(); await settle()
      await client.reconnect(); await settle()
      expect(followed()).toEqual(['t2'])
      expect(client.view().activeThreadId).toBe('t2')
    } finally { await client.shutdown() }
  })

  it('a streamed message appears in the view with no poll tick, token by token, and settles when streaming ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-live-'))
    const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const { fetch, shellSnapshots } = engineFetch()
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    const published: string[] = []
    client.subscribe((view) => published.push(view.projects[0]?.threads[0]?.messages.map((message) => `${message.id}:${message.text}${message.streaming ? '…' : ''}`).join('|') ?? ''))
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await settle()
    const subscriptions = server.requests.filter((request) => request.tag.startsWith('orchestration.subscribe'))
    expect(subscriptions.map((request) => request.tag)).toEqual(['orchestration.subscribeShell', 'orchestration.subscribeThread'])
    expect(subscriptions[0]!.payload).toEqual({ afterSequence: 10, requestCompletionMarker: true })
    expect(subscriptions[1]!.payload).toEqual({ threadId: 't1', afterSequence: 10, requestCompletionMarker: true })
    const snapshotsBefore = shellSnapshots()

    server.push('orchestration.subscribeThread', [messageSent(11, 'm2', 'The agent ', true)])
    await settle()
    expect(client.view().projects[0]!.threads[0]!.messages.map((message) => message.text)).toEqual(['Start.', 'The agent '])
    expect(published.at(-1)).toBe('m1:Start.|m2:The agent …')

    server.push('orchestration.subscribeThread', [messageSent(12, 'm2', 'is typing.', true)])
    await settle()
    expect(client.view().projects[0]!.threads[0]!.messages[1]).toMatchObject({ text: 'The agent is typing.', streaming: true })

    server.push('orchestration.subscribeThread', [messageSent(13, 'm2', 'The agent is typing. Done.', false), event(14, 'thread.session-set', { threadId: 't1', session: { ...thread.session, status: 'ready', activeTurnId: null } })])
    await settle()
    expect(client.view().projects[0]!.threads[0]!.messages[1]).toMatchObject({ text: 'The agent is typing. Done.', streaming: false })
    expect(client.view().projects[0]!.threads[0]!.status).toBe('ready')
    // Everything above arrived over the socket; the HTTP snapshot count did not move.
    expect(shellSnapshots()).toBe(snapshotsBefore)
    await client.shutdown()
  })

  it('a dropped socket shows Disconnected, and reconnect resubscribes once with no duplicate messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-drop-'))
    const server = fakeEngineServer((tag, payload) => {
      if (tag === 'orchestration.subscribeThread') {
        // A resumed subscription replays what the client may already have seen, as T3 does after `afterSequence`.
        const after = (payload as { afterSequence?: number }).afterSequence ?? 0
        return [...(after < 11 ? [messageSent(11, 'm2', 'Replayed reply.', false)] : []), { kind: 'synchronized' }]
      }
      return tag === 'orchestration.subscribeShell' ? [{ kind: 'synchronized' }] : null
    })
    const { fetch } = engineFetch()
    const states: string[] = []
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0, reconnectDelaysMs: [20] })
    client.subscribe((view) => { if (states.at(-1) !== view.state) states.push(view.state) })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await settle()
    server.push('orchestration.subscribeThread', [messageSent(11, 'm2', 'Replayed reply.', false)])
    await settle()
    expect(client.view().projects[0]!.threads[0]!.messages).toHaveLength(2)
    expect(server.sockets).toHaveLength(1)

    server.dropAll()
    await settle()
    expect(client.view()).toMatchObject({ state: 'disconnected', activeThreadId: 't1' })
    expect(states).toEqual(['connecting', 'connected', 'disconnected'])

    // The owner's Reconnect (or the backoff) opens one socket and subscribes exactly once each.
    await client.reconnect()
    await settle()
    expect(server.sockets.filter((socket) => !socket.closed)).toHaveLength(1)
    const afterDrop = server.requests.filter((request) => request.socket === server.sockets.length - 1 && request.tag.startsWith('orchestration.subscribe')).map((request) => request.tag)
    expect(afterDrop).toEqual(['orchestration.subscribeShell', 'orchestration.subscribeThread'])
    expect(client.view().state).toBe('connected')
    // The replay carried a message the client already had; it is not shown twice.
    expect(client.view().projects[0]!.threads[0]!.messages.map((message) => message.id)).toEqual(['m1', 'm2'])

    // A second drop reconnects on its own after the backoff delay, again once.
    server.dropAll()
    await settle()
    expect(client.view().state).toBe('disconnected')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(client.view().state).toBe('connected')
    expect(server.sockets.filter((socket) => !socket.closed)).toHaveLength(1)
    expect(server.requests.filter((request) => request.tag === 'orchestration.subscribeShell')).toHaveLength(3)
    expect(client.view().projects[0]!.threads[0]!.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    await client.shutdown()
  })
})
