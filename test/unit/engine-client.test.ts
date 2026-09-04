import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'

const at = '2026-09-03T12:00:00.000Z'

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

function detail(message = 'Engine transcript') {
  return {
    snapshotSequence: 5,
    thread: {
      ...shell().threads[0], deletedAt: null,
      messages: [{ id: 'm1', role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }],
      activities: [], checkpoints: [],
    },
    page: { beforeCursor: null, hasMore: false, snapshotSequence: 5, threadSequence: 5 },
  }
}

describe('T3 engine read client', () => {
  it('pairs, keeps the credential private, projects the shell, and persists visits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-'))
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'session-secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail())
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), pollMs: 60_000 })
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
    let online = true
    let transcript = 'Before restart'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (!online) throw new TypeError('fetch failed')
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail(transcript))
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, pollMs: 60_000 })
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
    const commands: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/orchestration/dispatch')) {
        commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ sequence: commands.length })
      }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell('First thread', 'running'), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), pollMs: 60_000 })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await client.startTurn('t1', { text: 'Continue the work', model: 'gpt-5.6', effort: 'high', access: 'full-access' })
    await client.respondApproval('t1', 'approval-1', 'accept')
    await client.respondUserInput('t1', 'input-1', { choice: 'Ship it' })
    await client.interrupt('t1')

    expect(commands.map((command) => command.type)).toEqual([
      'thread.turn.start', 'thread.approval.respond', 'thread.user-input.respond', 'thread.turn.interrupt',
    ])
    expect(commands[0]).toMatchObject({
      threadId: 't1', message: { role: 'user', text: 'Continue the work', attachments: [] },
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: { effort: 'high' } },
      runtimeMode: 'full-access', interactionMode: 'default',
    })
    expect(commands[1]).toMatchObject({ requestId: 'approval-1', decision: 'accept' })
    expect(commands[2]).toMatchObject({ requestId: 'input-1', answers: { choice: 'Ship it' } })
    expect(commands[3]).toMatchObject({ turnId: 'turn-1' })
    for (const command of commands) expect(command).toMatchObject({ commandId: expect.any(String), createdAt: at })
    await client.shutdown()
  })

  it('reuses a persisted command id until the matching message is visible after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-retry-'))
    const commands: Array<Record<string, unknown>> = []
    let acknowledged = false
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
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

    const first = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), pollMs: 60_000 })
    await first.pair('http://engine.test', 'code')
    await first.openThread('t1')
    await first.startTurn('t1', { text: 'Delivery delivery-1', model: 'gpt-5.6', effort: 'medium', access: 'full-access', messageId: 'delivery-1', commandId: 'command-1' })
    await first.shutdown()

    acknowledged = true
    const second = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), pollMs: 60_000 })
    await second.initialize()
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ commandId: 'command-1', message: { messageId: 'delivery-1' } })
    expect(commands[1]).toEqual(commands[0])
    expect(JSON.parse(await readFile(join(directory, 'engine-commands.json'), 'utf8')).pending).toEqual([])
    await second.shutdown()
  })

  it('uploads a Markdown delivery before dispatching its file attachment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-upload-'))
    const commands: Array<Record<string, unknown>> = []
    const uploads: Array<{ url: string; body: string }> = []
    class UploadSocket {
      static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3
      readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>()
      constructor(readonly url: string | URL) { queueMicrotask(() => this.emit('open', {})) }
      addEventListener(name: string, listener: (event: { data?: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
      send(value: string) {
        const request = JSON.parse(value) as { id: string; tag: string; payload: unknown }
        expect(request).toMatchObject({ tag: 'attachments.createUploadUrl', payload: { type: 'file', name: 'delivery.md', mimeType: 'text/markdown' } })
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: { attachmentId: 'pending-upload', relativeUrl: '/upload/signed', expiresAt: 1 } } }) }))
      }
      close() {}
      emit(name: string, event: { data?: string }) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
    }
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/upload/signed')) { uploads.push({ url, body: new TextDecoder().decode(init?.body as Uint8Array) }); return new Response('', { status: 200 }) }
      if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ sequence: 1 }) }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: UploadSocket as unknown as typeof WebSocket, pollMs: 60_000 })
    await client.pair('http://engine.test', 'code')
    await client.startTurn('t1', { text: 'Delivery d1.', model: 'gpt-5.6', effort: 'medium', access: 'full-access', attachment: { name: 'delivery.md', text: '# Delivery' } })
    expect(uploads).toEqual([{ url: 'http://engine.test/upload/signed', body: '# Delivery' }])
    expect(commands[0]).toMatchObject({ message: { text: 'Delivery d1.', attachments: [{ type: 'file', id: 'pending-upload', name: 'delivery.md', mimeType: 'text/markdown', sizeBytes: 10 }] } })
    await client.shutdown()
  })
})
