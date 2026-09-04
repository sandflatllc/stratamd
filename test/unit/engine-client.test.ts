import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'

/** The engine's RPC socket: subscriptions synchronize at once, uploads get a signed URL, nothing else is served. */
function liveServer() {
  return fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'attachments.createUploadUrl' ? { attachmentId: 'pending-upload', relativeUrl: '/upload/signed', expiresAt: 1 } : null)
}

function shell(text = 'First thread', status: 'idle' | 'running' = 'idle') {
  return {
    snapshotSequence: 4,
    projects: [{ id: 'p1', title: 'StrataMD', workspaceRoot: '/work/strata', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
    threads: [{
      id: 't1', projectId: 'p1', title: text,
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: { effort: 'medium' } },
      runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null,
      latestTurn: null, createdAt: at, updatedAt: at,
      session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex-main', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at },
      latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
    }],
    updatedAt: at,
  }
}

function detail(message = 'Engine transcript', checkpoints: unknown[] = []) {
  return {
    snapshotSequence: 5,
    thread: {
      ...shell().threads[0], deletedAt: null,
      messages: [{ id: 'm1', role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }],
      activities: [], checkpoints,
    },
    page: { beforeCursor: null, hasMore: false, snapshotSequence: 5, threadSequence: 5 },
  }
}

describe('T3 engine read client', () => {
  it('projects markdown and code files from completed turn diffs without opening them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-files-'))
    const server = liveServer()
    const checkpoint = { turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'ref', status: 'ready', files: [{ path: 'notes/one.md', kind: 'modified', additions: 4, deletions: 1 }, { path: 'src/two.ts', kind: 'created', additions: 8, deletions: 0 }], assistantMessageId: 'm1', completedAt: at }
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/oauth/token')
      ? Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      : String(input).endsWith('/api/auth/websocket-ticket') ? Response.json({ ticket: 'ticket-1', expiresAt: at })
      : String(input).endsWith('/api/orchestration/shell') ? Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } }) : Response.json(detail('Done', [checkpoint]))) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    expect(client.view().projects[0]!.threads[0]!.documents).toEqual([
      { path: '/work/strata/notes/one.md', turnId: 'turn-1', additions: 4, deletions: 1, markdown: true },
      { path: '/work/strata/src/two.ts', turnId: 'turn-1', additions: 8, deletions: 0, markdown: false },
    ])
    await client.shutdown()
  })

  it('creates a thread with the picker choices and makes it active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-create-'))
    const server = liveServer()
    let created: Record<string, unknown> | null = null
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      const base = shell()
      const listed = (command: { threadId: string; title: string; modelSelection: unknown; runtimeMode: string }) => ({ ...base.threads[0]!, id: command.threadId, title: command.title, modelSelection: command.modelSelection as typeof base.threads[0]['modelSelection'], runtimeMode: command.runtimeMode as 'full-access' })
      if (url.endsWith('/api/orchestration/dispatch')) {
        created = JSON.parse(String(init?.body))
        // T3 announces the created thread on the shell subscription; nothing is polled.
        server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 5, thread: listed(created as Parameters<typeof listed>[0]) }])
        return Response.json({ sequence: 5 })
      }
      if (created) base.threads.push(listed(created as Parameters<typeof listed>[0]))
      if (url.endsWith('/api/orchestration/shell')) return Response.json(base, { headers: { 'x-t3-version': '0.0.33' } })
      const id = url.split('/').pop()!
      return Response.json({ ...detail(''), thread: { ...detail('').thread, ...base.threads.find((thread) => thread.id === id), id } })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    const id = await client.createThread({ projectId: 'p1', title: 'From document', model: 'gpt-5.6', effort: 'high', access: 'full-access' })
    expect(client.view().activeThreadId).toBe(id)
    expect(created).toMatchObject({ type: 'thread.create', threadId: id, projectId: 'p1', title: 'From document', modelSelection: { model: 'gpt-5.6', options: { effort: 'high' } }, runtimeMode: 'full-access' })
    await client.shutdown()
  })
  it('pairs, keeps the credential private, projects the shell, and persists visits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-'))
    const server = liveServer()
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'session-secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail())
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.initialize()
    expect(client.view().state).toBe('unpaired')

    await client.pair('http://engine.test:3774/path-is-ignored', 'one-time-code')
    expect(client.view()).toMatchObject({ state: 'connected', server: 'http://engine.test:3774', serverVersion: '0.0.33' })
    expect(client.view().projects[0]?.threads[0]).toMatchObject({ id: 't1', title: 'First thread', model: 'gpt-5.6', effort: 'medium', access: 'full-access' })
    expect(requests[0]?.init?.body?.toString()).toContain('subject_token=one-time-code')
    expect(requests[1]?.init?.headers).toEqual({ authorization: 'Bearer session-secret' })
    expect((await stat(join(directory, 'engine-credential.json'))).mode & 0o777).toBe(0o600)

    await client.openThread('t1')
    expect(client.view().activeThreadId).toBe('t1')
    expect(client.view().projects[0]?.threads[0]?.messages[0]?.text).toBe('Engine transcript')
    expect(client.view().projects[0]?.threads[0]?.unread).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'engine-reading.json'), 'utf8'))).toMatchObject({ activeThreadId: 't1' })
    await client.shutdown()
  })

  it('publishes one disconnected state and recovers the same active conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-reconnect-'))
    const server = liveServer()
    let online = true
    let transcript = 'Before restart'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (!online) throw new TypeError('fetch failed')
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail(transcript))
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.initialize()
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    online = false
    await client.reconnect()
    expect(client.view()).toMatchObject({ state: 'disconnected', server: 'http://engine.test', activeThreadId: 't1' })
    transcript = 'After restart'
    online = true
    await client.reconnect()
    expect(client.view().projects[0]?.threads[0]?.messages[0]?.text).toBe('After restart')
    expect(client.view().activeThreadId).toBe('t1')
    await client.shutdown()
  })

  it('dispatches conversation turns, interruption, approvals, and user input with the T3 command contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-write-'))
    const server = liveServer()
    const commands: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/dispatch')) {
        commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ sequence: commands.length })
      }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell('First thread', 'running'), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await client.startTurn('t1', { text: 'Continue the work', model: 'gpt-5.6', effort: 'high', access: 'full-access' })
    await client.respondApproval('t1', 'approval-1', 'accept')
    await client.respondUserInput('t1', 'input-1', { choice: 'Ship it' })
    await client.interrupt('t1')
    await client.actOnThread('t1', 'settle')

    expect(commands.map((command) => command.type)).toEqual([
      'thread.turn.start', 'thread.approval.respond', 'thread.user-input.respond', 'thread.turn.interrupt', 'thread.settle',
    ])
    expect(commands[0]).toMatchObject({
      threadId: 't1', message: { role: 'user', text: 'Continue the work', attachments: [] },
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: { effort: 'high' } },
      runtimeMode: 'full-access', interactionMode: 'default',
    })
    expect(commands[1]).toMatchObject({ requestId: 'approval-1', decision: 'accept' })
    expect(commands[2]).toMatchObject({ requestId: 'input-1', answers: { choice: 'Ship it' } })
    expect(commands[3]).toMatchObject({ turnId: 'turn-1' })
    expect(commands[4]).toMatchObject({ threadId: 't1' })
    for (const command of commands) expect(command).toMatchObject({ commandId: expect.any(String) })
    for (const command of commands.slice(0, 4)) expect(command).toMatchObject({ createdAt: at })
    await client.shutdown()
  })

  it('reuses a persisted command id until the matching message is visible after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-retry-'))
    const server = liveServer()
    const commands: Array<Record<string, unknown>> = []
    let acknowledged = false
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/dispatch')) {
        commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ sequence: commands.length })
      }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      const snapshot = detail()
      snapshot.thread.messages = acknowledged
        ? [{ id: 'delivery-1', role: 'user', text: 'Delivery delivery-1', attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }]
        : []
      return Response.json(snapshot)
    }) as typeof globalThis.fetch

    const first = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await first.pair('http://engine.test', 'code')
    await first.openThread('t1')
    await first.startTurn('t1', { text: 'Delivery delivery-1', model: 'gpt-5.6', effort: 'medium', access: 'full-access', messageId: 'delivery-1', commandId: 'command-1' })
    await first.shutdown()

    acknowledged = true
    const second = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await second.initialize()
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ commandId: 'command-1', message: { messageId: 'delivery-1' } })
    expect(commands[1]).toEqual(commands[0])
    expect(JSON.parse(await readFile(join(directory, 'engine-commands.json'), 'utf8')).pending).toEqual([])
    await second.shutdown()
  })

  it('uploads a Markdown delivery before dispatching its file attachment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-upload-'))
    const server = liveServer()
    const commands: Array<Record<string, unknown>> = []
    const uploads: Array<{ url: string; body: string }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/upload/signed')) { uploads.push({ url, body: new TextDecoder().decode(init?.body as Uint8Array) }); return new Response('', { status: 200 }) }
      if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ sequence: 1 }) }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.startTurn('t1', { text: 'Delivery d1.', model: 'gpt-5.6', effort: 'medium', access: 'full-access', attachment: { name: 'delivery.md', text: '# Delivery' } })
    expect(uploads).toEqual([{ url: 'http://engine.test/upload/signed', body: '# Delivery' }])
    expect(server.requests.find((request) => request.tag === 'attachments.createUploadUrl')).toMatchObject({ payload: { type: 'file', name: 'delivery.md', mimeType: 'text/markdown' } })
    expect(commands[0]).toMatchObject({ message: { text: 'Delivery d1.', attachments: [{ type: 'file', id: 'pending-upload', name: 'delivery.md', mimeType: 'text/markdown', sizeBytes: 10 }] } })
    await client.shutdown()
  })
})
