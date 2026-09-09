import { pendingUserInputs } from '../../src/core/user-input'
import { connectionDirectory } from '../../src/main/engine/identity'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
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

function shell(text = 'First thread', status: 'idle' | 'running' = 'idle', extra: Record<string, unknown> = {}) {
  return {
    snapshotSequence: 4,
    projects: [{ id: 'p1', title: 'StrataMD', workspaceRoot: '/work/strata', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
    threads: [{
      id: 't1', projectId: 'p1', title: text,
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: { effort: 'medium' } },
      runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null,
      latestTurn: null, createdAt: at, updatedAt: at,
      session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex-main', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at },
      backgroundLiveness: null as string | null, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
      ...extra,
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
  it('resolves document bytes only for the current thread attachment and rejects outside signed URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-document-'))
    let relativeUrl = '/api/assets/document?signature=capability'
    const server = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'assets.createUrl' ? { relativeUrl, expiresAt: 1 } : null)
    const original = Buffer.from([37, 80, 68, 70, 0, 128, 255])
    const page = detail()
    page.thread.messages[0]!.attachments = [{ type: 'file', id: 'document-1', name: 'original.pdf', mimeType: 'application/pdf', sizeBytes: original.length }] as never[]
    page.thread.activities = [{ id: 'answer-event', kind: 'user-input.answer-submitted', summary: 'User input submitted', tone: 'info', turnId: 'turn-1', createdAt: at, payload: { requestId: 'input-1', attachmentsByQuestionId: { report: [{ type: 'file', id: 'answer-document', name: 'answer.pdf', mimeType: 'application/pdf', sizeBytes: original.length }, { id: 'malformed-document', name: 'fake.pdf' }] } } }] as never[]
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      if (url.includes('/api/assets/')) return new Response(original)
      return Response.json(page)
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    try {
      await client.pair('http://engine.test', 'code')
      await client.openThread('t1')
      const source = { kind: 'attachment' as const, id: 'document-1', threadId: 't1', name: 'untrusted-label.pdf' }
      expect(await client.readDocumentAttachment(source)).toEqual({ bytes: original, name: 'original.pdf' })
      expect(await client.readDocumentAttachment({ ...source, id: 'answer-document' })).toEqual({ bytes: original, name: 'answer.pdf' })
      await expect(client.readDocumentAttachment({ ...source, id: 'malformed-document' })).rejects.toThrow('not attached')
      const request = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/api/assets/'))!
      expect(request[1]?.redirect).toBe('error')
      expect(request[1]?.headers).toBeUndefined()
      await expect(client.readDocumentAttachment({ ...source, threadId: 'unknown' })).rejects.toThrow('not attached')
      relativeUrl = 'https://outside.test/api/assets/document'
      await expect(client.readDocumentAttachment(source)).rejects.toThrow('invalid document address')
      expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('outside.test'))).toBe(false)
    } finally { await client.shutdown() }
  })

  it('carries T3 background liveness and reads never-visited threads as read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-liveness-'))
    const server = liveServer()
    const snapshot = shell('Watcher', 'idle', { backgroundLiveness: 'monitoring' })
    snapshot.threads.push({ ...snapshot.threads[0]!, id: 't2', title: 'Other thread', backgroundLiveness: null })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
      const id = url.split('/').pop()!
      const page = detail()
      return Response.json({ ...page, thread: { ...page.thread, id, backgroundLiveness: id === 't1' ? 'monitoring' : null } })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    const threads = () => client.view().projects[0]!.threads
    expect(threads().map((thread) => [thread.id, thread.backgroundLiveness, thread.unread])).toEqual([['t1', 'monitoring', false], ['t2', null, false]])

    // A visit, then an update that lands while another thread is open: only then is it unread.
    await client.openThread('t1')
    await client.openThread('t2')
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 6, thread: { ...snapshot.threads[0]!, updatedAt: '2099-01-01T00:00:00.000Z', backgroundLiveness: null } }])
    await vi.waitFor(() => expect(threads().find((thread) => thread.id === 't1')).toMatchObject({ unread: true, backgroundLiveness: null }))
    await client.shutdown()
  })

  it('passes message update times and the latest turn stamps through for turn folds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-turn-'))
    const server = liveServer()
    const snapshot = shell('Timed', 'idle', { latestTurn: { turnId: 'turn-1', state: 'interrupted', requestedAt: at, startedAt: '2026-09-03T12:00:01.000Z', completedAt: '2026-09-03T12:00:48.000Z', assistantMessageId: 'm1' } })
    const page = detail()
    page.thread.messages[0]!.updatedAt = '2026-09-03T12:00:46.000Z'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
      return Response.json(page)
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    const thread = () => client.view().projects[0]!.threads[0]!
    await vi.waitFor(() => expect(thread().messages).toHaveLength(1))
    expect(thread().latestTurn).toEqual({ id: 'turn-1', state: 'interrupted', startedAt: '2026-09-03T12:00:01.000Z', completedAt: '2026-09-03T12:00:48.000Z' })
    expect(thread().turnStartedAt).toBe('2026-09-03T12:00:01.000Z')
    expect(thread().messages[0]).toMatchObject({ id: 'm1', createdAt: at, updatedAt: '2026-09-03T12:00:46.000Z' })
    expect(thread().lastExchangeAt).toBe('2026-09-03T12:00:48.000Z')
    await client.shutdown()
  })

  it('holds the last hand-off stamp at the send while a turn runs and moves it only when the turn finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-exchange-'))
    const server = liveServer()
    const sentAt = '2026-09-03T12:05:00.000Z'
    const snapshot = shell('Working', 'running', {
      latestUserMessageAt: sentAt, updatedAt: '2026-09-03T12:09:30.000Z',
      latestTurn: { turnId: 'turn-1', state: 'running', requestedAt: sentAt, startedAt: '2026-09-03T12:05:01.000Z', completedAt: null, assistantMessageId: null },
    })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    const thread = () => client.view().projects[0]!.threads[0]!
    expect(thread().updatedAt).toBe('2026-09-03T12:09:30.000Z')
    expect(thread().lastExchangeAt).toBe(sentAt)
    const finished = shell('Working', 'idle', {
      latestUserMessageAt: sentAt, updatedAt: '2026-09-03T12:12:00.000Z',
      latestTurn: { turnId: 'turn-1', state: 'completed', requestedAt: sentAt, startedAt: '2026-09-03T12:05:01.000Z', completedAt: '2026-09-03T12:11:00.000Z', assistantMessageId: 'm1' },
    })
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 5, thread: finished.threads[0] }])
    await vi.waitFor(() => expect(thread().lastExchangeAt).toBe('2026-09-03T12:11:00.000Z'))
    const fresh = shell('New', 'idle', { latestUserMessageAt: null, latestTurn: null, createdAt: '2026-09-03T12:20:00.000Z', updatedAt: '2026-09-03T12:21:00.000Z' })
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 6, thread: fresh.threads[0] }])
    await vi.waitFor(() => expect(thread().lastExchangeAt).toBe('2026-09-03T12:20:00.000Z'))
    await client.shutdown()
  })

  it('projects markdown and code files from completed turn diffs without opening them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-files-'))
    const server = liveServer()
    const checkpoint = { turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'ref', status: 'ready', files: [{ path: 'notes/one.md', kind: 'modified', additions: 4, deletions: 1 }, { path: 'src/two.ts', kind: 'created', additions: 8, deletions: 0 }], assistantMessageId: 'm1', completedAt: at }
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/oauth/token')
      ? Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      : String(input).endsWith('/api/auth/websocket-ticket') ? Response.json({ ticket: 'ticket-1', expiresAt: at })
      : String(input).endsWith('/api/orchestration/shell') ? Response.json(shell()) : Response.json(detail('Done', [checkpoint]))) as typeof globalThis.fetch
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(base)
      const id = url.split('/').pop()!
      return Response.json({ ...detail(''), thread: { ...detail('').thread, ...base.threads.find((thread) => thread.id === id), id } })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    const id = await client.createThread({ projectId: 'p1', title: 'From document', model: 'gpt-5.6', effort: 'high', access: 'full-access' })
    expect(client.view().activeThreadId).toBe(id)
    expect(created).toMatchObject({ type: 'thread.create', threadId: id, projectId: 'p1', title: 'From document', modelSelection: { model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] }, runtimeMode: 'full-access' })
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail())
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.initialize()
    expect(client.view().state).toBe('unpaired')

    await client.pair('http://engine.test:3774/path-is-ignored', 'one-time-code')
    expect(client.view()).toMatchObject({ state: 'connected', server: 'http://engine.test:3774' })
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell('First thread', 'running'))
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
    await client.actOnThread('t1', 'unsettle')

    expect(commands.map((command) => command.type)).toEqual([
      'thread.meta.update', 'thread.turn.start', 'thread.approval.respond', 'thread.user-input.respond', 'thread.turn.interrupt', 'thread.settle', 'thread.unsettle',
    ])
    expect(commands[0]).toMatchObject({ type: 'thread.meta.update', threadId: 't1', modelSelection: { options: [{ id: 'effort', value: 'high' }] } })
    expect(commands[1]).toMatchObject({
      threadId: 't1', message: { role: 'user', text: 'Continue the work', attachments: [] },
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] },
      runtimeMode: 'full-access', interactionMode: 'default',
    })
    expect(commands[2]).toMatchObject({ requestId: 'approval-1', decision: 'accept' })
    expect(commands[3]).toMatchObject({ requestId: 'input-1', answers: { choice: 'Ship it' } })
    expect(commands[4]).toMatchObject({ turnId: 'turn-1' })
    expect(commands[5]).toMatchObject({ threadId: 't1' })
    expect(commands[6]).toMatchObject({ threadId: 't1', reason: 'user' })
    for (const command of commands) expect(command).toMatchObject({ commandId: expect.any(String) })
    for (const command of commands.slice(1, 5)) expect(command).toMatchObject({ createdAt: at })
    await client.shutdown()
  })

  it('blocks maintenance for an uncertain native answer and retries its frozen command after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-question-receipt-'))
    const server = liveServer()
    const commands: Array<Record<string, unknown>> = []
    let reject = true
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: at })
      if (url.endsWith('/api/orchestration/dispatch')) {
        commands.push(JSON.parse(String(init?.body)))
        if (reject) throw new TypeError('response connection lost')
        return Response.json({ sequence: commands.length })
      }
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      return Response.json({ ...detail(), thread: { ...detail().thread, activities: [{ id: 'ask2', kind: 'user-input.requested', summary: 'Another question', tone: 'info', turnId: 'turn-1', createdAt: at, payload: { requestId: 'input-2', responseMode: 'message', questions: [{ id: 'choice', question: 'Which?' }] } }] } })
    }) as typeof globalThis.fetch
    let client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await expect(client.respondUserInput('t1', 'input-1', { choice: 'Original answer' })).rejects.toThrow('Retry sends the original held answer')
    expect(() => client.assertNoPendingSends()).toThrow('queued conversation sends')
    await client.shutdown()
    client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.initialize()
    expect(() => client.assertNoPendingSends()).toThrow('queued conversation sends')
    reject = false
    await client.respondUserInput('t1', 'input-1', { choice: 'Later edit' })
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(commands[1]).toMatchObject({ answers: { choice: 'Original answer' } })
    expect(() => client.assertNoPendingSends()).not.toThrow()
    reject = true
    await expect(client.respondUserInput('t1', 'input-2', { choice: 'Optional answer' })).rejects.toThrow()
    reject = false
    await client.dismissUserInput('t1', 'input-2')
    expect(() => client.assertNoPendingSends()).not.toThrow()
    await client.shutdown()
  })

  it('saves Codex effort before sending and retries refused settings with stable IDs after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-effort-'))
    const server = liveServer()
    let selected = { instanceId: 'codex-main', model: 'gpt-5.6', options: [{ id: 'reasoningEffort', value: 'medium' }] }
    let refuseSettings = true
    const commands: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell('Effort', 'idle', { modelSelection: selected }))
      if (url.endsWith('/api/orchestration/dispatch')) {
        const command = JSON.parse(String(init?.body))
        commands.push(command)
        if (command.type === 'thread.meta.update') {
          if (refuseSettings) return Response.json({ error: 'refused' }, { status: 400 })
          selected = command.modelSelection
          server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: commands.length + 5, thread: shell('Effort', 'idle', { modelSelection: selected }).threads[0] }])
        } else expect(command.modelSelection.options).toEqual(selected.options)
        return Response.json({ sequence: commands.length + 5 })
      }
      return Response.json({ ...detail(), thread: { ...detail().thread, messages: [] } })
    }) as typeof globalThis.fetch
    const first = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await first.pair('http://engine.test', 'code')
    const input = { text: 'Keep High', model: 'gpt-5.6', effort: 'high', options: [{ id: 'reasoningEffort', value: 'high' }], access: 'full-access' as const, messageId: 'effort-message', commandId: 'effort-command' }
    await expect(first.startTurn('t1', input)).rejects.toThrow('Could not save model settings for thread t1. Your message was not sent.')
    expect(commands.map(command => command.type)).toEqual(['thread.meta.update'])
    await first.shutdown()
    refuseSettings = false
    const second = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    try {
      await second.initialize()
      await vi.waitFor(() => expect(commands.some(command => command.type === 'thread.turn.start')).toBe(true))
      expect(commands[1]).toEqual(commands[0])
      expect(commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ commandId: 'effort-command', modelSelection: selected, message: { messageId: 'effort-message', text: 'Keep High' } })
      expect(selected.options).toEqual([{ id: 'reasoningEffort', value: 'high' }])
      // Document deliveries pass effort separately. They must update Codex's
      // canonical option, without leaving a conflicting legacy `effort` entry.
      await second.startTurn('t1', { text: 'Use Medium now', model: 'gpt-5.6', effort: 'medium', access: 'full-access', messageId: 'next-effort' })
      expect(selected.options).toEqual([{ id: 'reasoningEffort', value: 'medium' }])
    } finally { await second.shutdown() }
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
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
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ commandId: 'command-1', message: { messageId: 'delivery-1' } })
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
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    await client.startTurn('t1', { text: 'Delivery d1.', model: 'gpt-5.6', effort: 'medium', access: 'full-access', attachments: [{ kind: 'text', name: 'delivery.md', text: '# Delivery' }] })
    expect(uploads).toEqual([{ url: 'http://engine.test/upload/signed', body: '# Delivery' }])
    expect(server.requests.find((request) => request.tag === 'attachments.createUploadUrl')).toMatchObject({ payload: { type: 'file', name: 'delivery.md', mimeType: 'text/markdown' } })
    expect(commands[0]).toMatchObject({ message: { text: 'Delivery d1.', attachments: [{ type: 'file', id: 'pending-upload', name: 'delivery.md', mimeType: 'text/markdown', sizeBytes: 10 }] } })
    await client.shutdown()
  })
})

describe('session renewal (§5.1)', () => {
  const day = 24 * 60 * 60 * 1_000
  const exchange = (accessToken: string, scope: string, expiresIn = 30 * 24 * 60 * 60) => Response.json({ access_token: accessToken, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: expiresIn, scope })

  async function seeded(expiresInMs: number, scopes: string[]) {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-renew-'))
    await writeFile(join(directory, 'engine-credential.json'), JSON.stringify({ formatVersion: 1, server: 'http://engine.test', accessToken: 'old-secret', expiresAt: Date.parse(at) + expiresInMs, scopes }), { mode: 0o600 })
    return directory
  }

  function engineFetch(options: { issue?: (init?: RequestInit) => Response; onExchange?: (form: URLSearchParams) => void; renewed?: string } = {}) {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/api/auth/pairing-token')) return options.issue ? options.issue(init) : Response.json({ id: 'link-1', credential: 'renewal-code', expiresAt: at })
      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(String(init?.body))
        options.onExchange?.(form)
        return form.get('subject_token') === 'renewal-code' ? exchange(options.renewed ?? 'new-secret', 'orchestration:read orchestration:operate access:write') : new Response('', { status: 401 })
      }
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail())
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    return { fetch, requests }
  }

  it('renews a session that ends within the week by issuing itself a pairing credential, and every later call uses the new bearer', async () => {
    const directory = await seeded(2 * day, ['orchestration:read', 'orchestration:operate', 'access:write'])
    const server = liveServer()
    let exchanged: URLSearchParams | null = null
    const { fetch, requests } = engineFetch({ onExchange: (form) => { exchanged = form } })
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.initialize()
    expect(client.view()).toMatchObject({ state: 'connected', credential: { renews: true, expiresAt: new Date(Date.parse(at) + 30 * day).toISOString() } })

    const issue = requests.find((request) => request.url.endsWith('/api/auth/pairing-token'))!
    expect(issue.init?.headers).toMatchObject({ authorization: 'Bearer old-secret' })
    expect(JSON.parse(String(issue.init?.body))).toEqual({ label: 'StrataMD', scopes: ['orchestration:read', 'orchestration:operate', 'access:write'] })
    // The exchange names no scope, so the new session keeps every scope the link granted, including the one that allows the next renewal.
    expect(exchanged!.get('subject_token')).toBe('renewal-code')
    expect(exchanged!.has('scope')).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'engine-credential.json'), 'utf8'))).toMatchObject({ accessToken: 'new-secret', scopes: ['orchestration:read', 'orchestration:operate', 'access:write'] })

    await client.openThread('t1')
    const threadRead = requests.filter((request) => request.url.endsWith('/api/orchestration/threads/t1')).at(-1)!
    expect(threadRead.init?.headers).toEqual({ authorization: 'Bearer new-secret' })
    await client.shutdown()
  })

  it('leaves a session with more than a week left alone, and never renews without Manage access', async () => {
    const server = liveServer()
    const early = await seeded(20 * day, ['orchestration:read', 'orchestration:operate', 'access:write'])
    const earlyFetch = engineFetch()
    const earlyClient = new T3EngineClient({ dataDirectory: early, fetch: earlyFetch.fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await earlyClient.initialize()
    expect(earlyFetch.requests.some((request) => request.url.endsWith('/api/auth/pairing-token'))).toBe(false)
    expect(earlyClient.view().credential).toEqual({ expiresAt: new Date(Date.parse(at) + 20 * day).toISOString(), renews: true })
    await earlyClient.shutdown()

    const standard = await seeded(2 * day, ['orchestration:read', 'orchestration:operate'])
    const standardFetch = engineFetch()
    const standardClient = new T3EngineClient({ dataDirectory: standard, fetch: standardFetch.fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await standardClient.initialize()
    expect(standardFetch.requests.some((request) => request.url.endsWith('/api/auth/pairing-token'))).toBe(false)
    expect(standardClient.view().credential).toEqual({ expiresAt: new Date(Date.parse(at) + 2 * day).toISOString(), renews: false })
    expect(JSON.parse(await readFile(join(standard, 'engine-credential.json'), 'utf8')).accessToken).toBe('old-secret')
    await standardClient.shutdown()
  })

  it('a refused renewal keeps the working session and reports nothing', async () => {
    const directory = await seeded(2 * day, ['orchestration:read', 'orchestration:operate', 'access:write'])
    const server = liveServer()
    const { fetch, requests } = engineFetch({ issue: () => new Response('{"error":"insufficient_scope"}', { status: 403 }) })
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.initialize()
    expect(client.view()).toMatchObject({ state: 'connected', problem: null })
    expect(requests.filter((request) => request.url.endsWith('/oauth/token'))).toHaveLength(0)
    expect(JSON.parse(await readFile(join(directory, 'engine-credential.json'), 'utf8')).accessToken).toBe('old-secret')
    await client.openThread('t1')
    expect(client.view().projects[0]?.threads[0]?.messages[0]?.text).toBe('Engine transcript')
    await client.shutdown()
  })

  it('a fresh pairing stores the scopes the link granted so the session can say whether it renews', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-pair-scopes-'))
    const server = liveServer()
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) { expect(new URLSearchParams(String(init?.body)).has('scope')).toBe(false); return exchange('secret', 'orchestration:read orchestration:operate access:read access:write') }
      if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
      return Response.json(detail())
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
    await client.pair('http://engine.test', 'code')
    expect(client.view().credential).toEqual({ expiresAt: new Date(Date.parse(at) + 30 * day).toISOString(), renews: true })
    expect(JSON.parse(await readFile(join(directory, 'engine-credential.json'), 'utf8')).scopes).toEqual(['orchestration:read', 'orchestration:operate', 'access:read', 'access:write'])
    await client.shutdown()
  })
})

it.each([false, true])('retries socket worktree preparation, reusing an already prepared folder: %s', async (alreadyPrepared) => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-worktree-retry-'))
  const snapshot = shell('New thread', 'idle', { latestUserMessageAt: null })
  const commands: Array<Record<string, unknown>> = []
  let refuse = true
  const server = fakeEngineServer((tag, payload) => {
    if (tag.startsWith('orchestration.subscribe')) return [{ kind: 'synchronized' }]
    if (tag === 'orchestration.dispatchCommand') { commands.push(payload as Record<string, unknown>); return refuse ? null : { sequence: 6 } }
    return null
  })
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
    if (url.endsWith('/api/orchestration/dispatch')) {
      commands.push(JSON.parse(String(init?.body)))
      return refuse ? Response.json({ error: 'refused' }, { status: 400 }) : Response.json({ sequence: 6 })
    }
    return Response.json(detail())
  }) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'code')
    const input = { text: 'Start isolated', model: 'gpt-5.6', effort: 'medium', access: 'full-access' as const, messageId: 'worktree-message', workspace: { kind: 'worktree' as const, baseBranch: 'develop', startFromOrigin: false } }
    await expect(client.startTurn('t1', input)).rejects.toThrow()
    const pending = JSON.parse(await readFile(join(directory, 'engine-conversations.json'), 'utf8'))
    expect(pending.threads.t1.prepared[0].command.bootstrap).toMatchObject({ prepareWorktree: { projectCwd: '/work/strata', baseBranch: 'develop', branch: expect.stringMatching(/^t3\/[a-f0-9]{8}$/), startFromOrigin: false }, runSetupScript: true })
    refuse = false
    if (alreadyPrepared) server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 5, thread: { ...snapshot.threads[0], worktreePath: '/worktrees/created' } }])
    await client.startTurn('t1', input)
    expect(commands).toHaveLength(2)
    if (alreadyPrepared) {
      const { bootstrap: _, ...finalTurn } = commands[0]!
      expect(commands[1]).toEqual(finalTurn)
    } else expect(commands[1]).toEqual(commands[0])
    expect(server.requests.some(request => request.tag === 'orchestration.dispatchCommand')).toBe(true)
  } finally { await client.shutdown() }
})

it('detaches terminal subscriptions by attachment id and never closes a server shell on detach', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-terminal-'))
  const server = liveServer()
  const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/oauth/token')
    ? Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    : String(input).endsWith('/api/auth/websocket-ticket') ? Response.json({ ticket: 'ticket-1', expiresAt: at })
    : String(input).endsWith('/api/orchestration/shell') ? Response.json(shell()) : Response.json(detail(''))) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  const received: unknown[] = []
  client.onTerminalEvent(event => received.push(event))
  try {
    await client.pair('http://engine.test', 'code')
    const first = { attachmentId: 'one', threadId: 't1', terminalId: 'term-1', cwd: '/work/strata', cols: 80, rows: 24 }
    await client.attachTerminal(first)
    server.push('terminal.attach', [{ type: 'output', threadId: 't1', terminalId: 'term-1', data: 'first' }])
    expect(received).toHaveLength(1)
    await client.attachTerminal({ ...first, attachmentId: 'two', threadId: 't2' })
    await client.detachTerminal('one')
    server.push('terminal.attach', [{ type: 'output', threadId: 't1', terminalId: 'term-1', data: 'stale' }])
    expect(received).toHaveLength(1)
    server.push('terminal.attach', [{ type: 'output', threadId: 't2', terminalId: 'term-1', data: 'second' }])
    expect(received).toHaveLength(2)
    await client.detachTerminal('two')
    expect(server.sockets.flatMap(socket => socket.streams).filter(stream => stream.tag === 'terminal.attach')).toHaveLength(0)
    expect(server.requests.some(request => request.tag === 'terminal.close')).toBe(false)
  } finally { await client.shutdown() }
})

it.each(['send', 'refuse', 'overlap'] as const)('retains queued comment sources across navigation and releases reservations: %s', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-send-lifetime-'))
  const server = liveServer()
  const snapshot = shell()
  snapshot.threads.push({ ...snapshot.threads[0]!, id: 't2', session: { ...snapshot.threads[0]!.session, threadId: 't2' } })
  const source = 'Understanding and checking are different jobs.\n\nThe map needs both.'
  const commands: Array<{ type: string; threadId: string; commandId: string; message: { messageId: string; role: string; text: string; attachments: unknown[] } }> = []
  const uploads: string[] = []
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const dispatchStarted = new Promise<void>(resolve => { entered = resolve })
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
    if (url.endsWith('/upload/signed')) { uploads.push(new TextDecoder().decode(init!.body as Uint8Array)); return new Response('') }
    if (url.endsWith('/api/orchestration/dispatch')) {
      const command = JSON.parse(String(init?.body))
      commands.push(command)
      if (command.threadId === 't2') { entered(); await blocked }
      return Response.json({ sequence: 6 })
    }
    const result = detail(source)
    if (url.endsWith('/threads/t2')) result.thread = { ...result.thread, id: 't2' }
    return Response.json(result)
  }) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  const selection = { model: 'gpt-5.6', instanceId: 'codex-main', effort: 'medium', access: 'full-access' as const }
  const sends: Array<Promise<unknown>> = []
  try {
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    const id = await client.holdMessageComment('t1', { messageId: 'm1', from: 0, to: 44, kind: 'comment', text: 'Explain how these connect.' })
    const previous = client.startTurn('t2', { ...selection, text: 'Earlier send' })
    sends.push(previous)
    await dispatchStarted
    const refused = mode !== 'send' ? client.startTurn('t1', { ...selection, text: '', comments: { [id]: 99 } }).then(() => null, error => error.message) : null
    if (refused) sends.push(refused)
    const sending = mode !== 'refuse' ? client.startTurn('t1', { ...selection, text: '', comments: { [id]: 1 } }) : null
    if (sending) sends.push(sending)
    await client.openThread('t2')
    expect(client.view().projects[0]!.threads[0]!.messages[0]?.text).toBe(source)
    release()
    await previous
    if (refused) expect(await refused).toContain(`Comment ${id} changed`)
    if (sending) {
      await sending
      expect(commands.filter(command => command.threadId === 't1')).toHaveLength(1)
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toContain('Explain how these connect.')
      expect(uploads[0]).toContain('Understanding and checking are different jobs.')
      // Acknowledgment removes the persisted pending-delivery reservation too.
      const command = commands.find(command => command.threadId === 't1')!
      server.push('orchestration.subscribeThread', [{ kind: 'event', event: { sequence: 7, eventId: 'ack', aggregateKind: 'thread', aggregateId: 't1', type: 'thread.message-sent', occurredAt: at, commandId: command.commandId, causationEventId: null, correlationId: null, metadata: {}, payload: { ...command.message, threadId: 't1', turnId: null, streaming: false, createdAt: at, updatedAt: at } } }])
      await vi.waitFor(() => expect(client.view().projects[0]!.threads[0]!.comments?.[0]?.state).toBe('open'))
      await client.watchThreads([])
    }
    expect(client.view().projects[0]!.threads[0]!.messages).toHaveLength(0)
    expect(client.view().activeThreadId).toBe('t2')
  } finally { release(); await Promise.allSettled(sends); await client.shutdown() }
})

it('reloads an evicted comment source before sending and still refuses an actually changed source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-send-reload-'))
  const server = liveServer(), snapshot = shell()
  snapshot.threads.push({ ...snapshot.threads[0]!, id: 't2', session: { ...snapshot.threads[0]!.session, threadId: 't2' } })
  let source = 'Original passage.', dispatched = 0
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
    if (url.endsWith('/upload/signed')) return new Response('')
    if (url.endsWith('/api/orchestration/dispatch')) { dispatched++; return Response.json({ sequence: 6 }) }
    const result = detail(source)
    if (url.endsWith('/threads/t2')) result.thread = { ...result.thread, id: 't2' }
    return Response.json(result)
  }) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    const id = await client.holdMessageComment('t1', { messageId: 'm1', from: 0, to: source.length, kind: 'comment', text: 'Clarify this.' })
    await client.openThread('t2')
    expect(client.view().projects[0]!.threads[0]!.messages).toHaveLength(0)
    const input = { text: '', model: 'gpt-5.6', instanceId: 'codex-main', effort: 'medium', access: 'full-access' as const, comments: { [id]: 1 } }
    source = 'The passage really changed.'
    await expect(client.startTurn('t1', input)).rejects.toThrow(`Target unavailable for comment ${id}`)
    expect(dispatched).toBe(0)
    expect(client.view().projects[0]!.threads[0]!.comments?.[0]?.state).toBe('held')
    source = 'Original passage.'
    await client.startTurn('t1', input)
    expect(dispatched).toBe(1)
  } finally { await client.shutdown() }
})

it('preserves native question identity and mode after reconnect, dismisses async without a turn, and refuses blocking dismissal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-engine-native-questions-'))
  const server = liveServer()
  const commands: Array<Record<string, unknown>> = []
  let resolved = false
  const activities = () => [
    { id: 'async', kind: 'user-input.requested', tone: 'info', summary: 'Question', turnId: 'turn-1', createdAt: at, payload: { requestId: 'native-async', responseMode: 'message', questions: [{ id: 'release', question: 'Which release?' }] } },
    { id: 'blocking', kind: 'user-input.requested', tone: 'info', summary: 'Question', turnId: 'turn-1', createdAt: at, payload: { requestId: 'native-blocking', questions: [{ id: 'date', question: 'Which date?' }] } },
    ...(resolved ? [{ id: 'resolved', kind: 'user-input.resolved', tone: 'info', summary: 'User input dismissed', turnId: 'turn-1', createdAt: at, payload: { requestId: 'native-async', responseMode: 'message' } }] : []),
  ]
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/dispatch')) {
      commands.push(JSON.parse(String(init?.body)))
      resolved = true
      return Response.json({ sequence: 6 })
    }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
    const snapshot = detail()
    return Response.json({ ...snapshot, thread: { ...snapshot.thread, activities: activities() } })
  }) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await client.reconnect()
    expect(client.view().projects[0]?.threads[0]?.activities.map(activity => activity.payload)).toEqual(activities().map(activity => activity.payload))
    await expect(client.dismissUserInput('t1', 'native-blocking')).rejects.toThrow('cannot be dismissed')
    expect(commands).toEqual([])
    await client.dismissUserInput('t1', 'native-async')
    expect(commands).toEqual([{ type: 'thread.user-input.dismiss', commandId: expect.any(String), threadId: 't1', requestId: 'native-async', createdAt: at }])
    await client.reconnect()
    await expect(client.dismissUserInput('t1', 'native-async')).rejects.toThrow('cannot be dismissed')
    expect(commands).toHaveLength(1)
  } finally { await client.shutdown() }
})

it('compacts with the exact attachment-free command and preserves queued work and visible history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-compact-'))
  const snapshot = shell()
  const provider = { instanceId: 'codex-main', driver: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, slashCommands: [], workspaceSnapshots: [{ cwd: '/work/strata', checkedAt: at, slashCommands: [{ name: 'compact' }], skills: [] }] }
  const server = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'server.getConfig' ? { providers: [provider] } : tag === 'orchestration.dispatchCommand' ? { sequence: 6 } : null)
  const commands: Array<Record<string, unknown>> = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body))); return Response.json({ sequence: 6 }) }
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(snapshot)
    return Response.json(detail())
  }) as typeof globalThis.fetch
  const client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await client.holdMessageComment('t1', { messageId: 'm1', from: 0, to: 6, kind: 'comment', text: 'Keep this held.' })
    const before = client.view().projects[0]!.threads[0]!
    const input = { instanceId: 'codex-main', model: 'gpt-5.6', effort: 'medium', access: 'full-access' as const }
    await client.compactContext('t1', input)
    const turn = commands.find(command => command.type === 'thread.turn.start')!
    expect(turn).toMatchObject({ type: 'thread.turn.start', threadId: 't1', message: { text: '/compact', attachments: [] }, runtimeMode: 'full-access', interactionMode: 'default', modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6' } })
    expect(Object.keys(turn.message as object).sort()).toEqual(['attachments', 'messageId', 'role', 'text'])
    expect(server.requests.some(r => r.tag.startsWith('attachments.'))).toBe(false)
    const after = client.view().projects[0]!.threads[0]!
    expect(after.comments).toEqual(before.comments)
    expect(after.messages).toEqual(before.messages)
    expect(after.deliveries).toEqual(before.deliveries)
    expect(after.compaction).toEqual({ state: 'working' })
    await expect(client.compactContext('t1', input)).rejects.toThrow('Wait for thread')
    await expect(client.startTurn('t1', { ...input, text: 'Do not consume held work' })).rejects.toThrow('Wait for context compaction')
    server.dropAll()
    expect(client.view().projects[0]!.threads[0]!.compaction).toMatchObject({ state: 'failed', error: expect.stringContaining('lost during compaction') })
  } finally { await client.shutdown() }
})

for (const proof of ['resolved', 'answer-submitted', 'retired', 'discarded'] as const) it(`reconciles a lost native receipt from matching ${proof} history without another send`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-question-reconcile-'))
  const server = liveServer()
  const commands: Array<Record<string, any>> = []
  let activities: Array<Record<string, unknown>> = []
  let uploads = 0
  const request = { id: 'question-request', kind: 'user-input.requested', summary: 'Which?', tone: 'info', turnId: 'turn-1', createdAt: at, payload: { requestId: 'input-receipt', responseMode: 'message', questions: [{ id: 'choice', question: 'Which?', allowCustomAnswer: true }] } }
  activities = [request]
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'fixture', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell())
    if (url.endsWith('/upload/signed')) { uploads++; return new Response('') }
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body))); throw new Error('Response connection lost after engine acceptance') }
    return Response.json({ ...detail(), thread: { ...detail().thread, activities } })
  }
  let client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
  try {
    await client.pair('http://engine.test', 'fixture'); await client.openThread('t1')
    await client.holdMessageComment('t1', { messageId: 'm1', from: 0, to: 6, kind: 'comment', text: 'Keep private' })
    const held = structuredClone(client.view().projects[0]!.threads[0]!.comments)
    await expect(client.respondUserInput('t1', 'input-receipt', { choice: 'Original answer' }, { choice: [{ kind: 'text', name: 'answer.md', text: 'Exact file bytes' }], empty: [] })).rejects.toThrow('Response connection lost')
    const command = commands[0]!
    const storePath = join(await connectionDirectory(directory, client.view().identity!), 'engine-conversations.json')
    const frozen = JSON.parse(await readFile(storePath, 'utf8')).threads.t1.userInputResponses['input-receipt']
    await client.shutdown()
    const readingPath = join(await connectionDirectory(directory, client.view().identity!), 'engine-reading.json')
    const reading = JSON.parse(await readFile(readingPath, 'utf8'))
    await writeFile(readingPath, JSON.stringify({ ...reading, activeThreadId: null }))
    client = new T3EngineClient({ dataDirectory: directory, fetch, webSocket: server.WebSocket })
    // Missing history or an unrelated request does not establish retirement.
    activities = []
    await client.initialize()
    expect(() => client.assertNoPendingSends()).toThrow('queued conversation sends')
    activities = [request, { ...request, id: 'unrelated', kind: 'user-input.resolved', payload: { requestId: 'another-request', answers: command.answers } }]
    await client.reconnect()
    expect(() => client.assertNoPendingSends()).toThrow('queued conversation sends')
    if (proof === 'retired' || proof === 'discarded') {
      if (proof === 'retired') {
        activities = [request, { ...request, id: 'different-answer', kind: 'user-input.resolved', payload: { requestId: 'input-receipt', answers: { choice: 'Someone else answered' } } }]
        await client.reconnect()
      } else await client.discardUserInputResponse('t1', 'input-receipt')
      expect(() => client.assertNoPendingSends()).not.toThrow()
      expect(commands).toHaveLength(1)
      expect(client.view().projects[0]!.threads[0]!.comments).toEqual(held)
      return
    }
    activities = [request, { ...request, id: proof === 'resolved' ? 'async-answer:input-receipt' : `question-answer:${command.commandId}`, kind: `user-input.${proof}`, payload: { requestId: 'input-receipt', answers: command.answers, attachmentsByQuestionId: command.attachmentsByQuestionId } }]
    if (proof === 'answer-submitted') activities.push({ ...request, id: 'provider-resolution', kind: 'user-input.resolved', payload: { requestId: 'input-receipt', answers: command.answers } })
    await client.reconnect()
    await vi.waitFor(() => expect(() => client.assertNoPendingSends()).not.toThrow())
    // This is the exact pending-question projection consumed by Conversation's UI.
    expect(pendingUserInputs(client.view().projects[0]!.threads[0]!.activities)).toEqual([])
    await client.prepareLocalSetup(); await client.freezeForBackup(); client.assertNoPendingSends(); await client.resumeAfterMaintenance()
    await client.respondUserInput('t1', 'input-receipt', { choice: 'Later draft must stay private' })
    expect(commands).toHaveLength(1); expect(uploads).toBe(1)
    expect(client.view().projects[0]!.threads[0]!.comments).toEqual(held)
    const saved = JSON.parse(await readFile(storePath, 'utf8')).threads.t1.userInputResponses['input-receipt']
    expect(saved).toEqual({ ...frozen, sent: true })
  } finally { await client.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

it('accepts the upstream active settled override in shell and thread snapshots', async () => {
  const { shellSnapshot, threadDetailSnapshot } = await import('../../src/main/engine/t3-contract')
  expect(shellSnapshot.parse(shell('Live', 'idle', { settledOverride: 'active' })).threads[0]?.settledOverride).toBe('active')
  const snapshot = detail(); Object.assign(snapshot.thread, { settledOverride: 'active' })
  expect(threadDetailSnapshot.parse(snapshot).thread.settledOverride).toBe('active')
})
