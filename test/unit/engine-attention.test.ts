import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient, type EngineNotification } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'

function shellThread(id: string, title: string, status: 'running' | 'ready' | 'idle', extra: Record<string, unknown> = {}) {
  return {
    id, projectId: 'p1', title, modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
    latestTurn: null, createdAt: at, updatedAt: at,
    session: { threadId: id, status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? `turn-${id}` : null, lastError: null, updatedAt: at },
    latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false, ...extra,
  }
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [shellThread('t1', 'Front', 'idle'), shellThread('t2', 'Elsewhere', 'running', { pinnedAt: '2026-09-01T00:00:00.000Z', snoozedUntil: null })], updatedAt: at }
const detail = (id: string) => ({ snapshotSequence: 10, thread: { ...shell.threads.find((thread) => thread.id === id)!, deletedAt: null, messages: [], activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function engineFetch(commands: Array<Record<string, unknown>>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ sequence: 11 + commands.length }) }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    const id = url.split('/').pop()!
    return shell.threads.some((thread) => thread.id === id) ? Response.json(detail(id)) : new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
}

describe('thread rows and notifications (§5.2)', () => {
  it('a turn finishing elsewhere badges the thread, notifies the unfocused owner once, persists, and clears when the thread opens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-attention-'))
    const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const commands: Array<Record<string, unknown>> = []
    let focused = false
    const notifications: EngineNotification[] = []
    const client = new T3EngineClient({ dataDirectory: directory, fetch: engineFetch(commands), webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0, isFocused: () => focused, notify: (notification) => notifications.push(notification) })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await settle()
    const threadView = (id: string) => client.view().projects[0]!.threads.find((thread) => thread.id === id)!
    expect(threadView('t2')).toMatchObject({ pinnedAt: '2026-09-01T00:00:00.000Z', snoozedUntil: null, attention: 0 })

    // t2 finishes its turn while t1 is in front and the window is unfocused.
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 11, thread: shellThread('t2', 'Elsewhere', 'ready', { pinnedAt: '2026-09-01T00:00:00.000Z' }) }])
    await settle()
    expect(threadView('t2').attention).toBe(1)
    expect(threadView('t1').attention).toBe(0)
    expect(notifications).toEqual([{ threadId: 't2', title: 'Elsewhere', body: 'Turn finished' }])
    // The same state pushed again is not news.
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 12, thread: shellThread('t2', 'Elsewhere', 'ready', { pinnedAt: '2026-09-01T00:00:00.000Z' }) }])
    await settle()
    expect(threadView('t2').attention).toBe(1)
    expect(notifications).toHaveLength(1)
    // An approval arriving while the owner watches another thread badges but, with the window focused, does not notify.
    focused = true
    server.push('orchestration.subscribeShell', [{ kind: 'thread-upserted', sequence: 13, thread: shellThread('t2', 'Elsewhere', 'ready', { pinnedAt: '2026-09-01T00:00:00.000Z', hasPendingApprovals: true }) }])
    await settle()
    expect(threadView('t2').attention).toBe(2)
    expect(notifications).toHaveLength(1)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, 'engine-reading.json'), 'utf8')).attention).toEqual({ t2: 2 }))

    await client.openThread('t2')
    expect(threadView('t2').attention).toBe(0)
    expect(JSON.parse(await readFile(join(directory, 'engine-reading.json'), 'utf8')).attention).toEqual({})
    await client.shutdown()
  })

  it('pin, snooze, unsnooze, unpin, and rename dispatch T3 commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-rows-'))
    const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const commands: Array<Record<string, unknown>> = []
    const client = new T3EngineClient({ dataDirectory: directory, fetch: engineFetch(commands), webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await client.pair('http://engine.test', 'code')
    await client.updateThread('t1', { pinned: true })
    await client.updateThread('t1', { snoozedUntil: '2026-09-04T09:00:00.000Z' })
    await client.updateThread('t1', { snoozedUntil: null })
    await client.updateThread('t1', { pinned: false })
    await client.updateThread('t1', { title: '  Front, renamed ' })
    expect(commands.map((command) => command.type)).toEqual(['thread.pin', 'thread.snooze', 'thread.unsnooze', 'thread.unpin', 'thread.meta.update'])
    expect(commands[1]).toMatchObject({ threadId: 't1', snoozedUntil: '2026-09-04T09:00:00.000Z' })
    expect(commands[2]).toMatchObject({ reason: 'user' })
    expect(commands[4]).toMatchObject({ title: 'Front, renamed' })
    await expect(client.updateThread('t1', { title: '   ' })).rejects.toThrow('A thread needs a name')
    await expect(client.updateThread('missing', { pinned: true })).rejects.toThrow('Thread was not found')
    await client.shutdown()
  })
})
