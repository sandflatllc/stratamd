import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'
const questions = '1. Which audience should lead?\n2. Should launch be public?\n3. What is the budget?\n4. Which region goes first?\n5. Keep the old name?\n6. Require approval?\n7. When should work begin?'
const thread = {
  id: 't1', projectId: 'p1', title: 'Interview', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function engine() {
  const commands: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const messages: unknown[] = [{ id: 'm1', role: 'assistant', text: questions, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }]
  const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'attachments.createUploadUrl' ? { attachmentId: `upload-${uploads.length + 1}`, relativeUrl: '/upload/next', expiresAt: 1 } : null)
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/upload/next')) { uploads.push(new TextDecoder().decode(init?.body as Uint8Array)); return new Response('', { status: 200 }) }
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ sequence: 10 + commands.length }) }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages, activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  /** The engine lists the delivered message, which is how a delivery is acknowledged. */
  const acknowledge = (messageId: string, text: string) => {
    messages.push({ id: messageId, role: 'user', text, attachments: [], turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
    server.push('orchestration.subscribeThread', [{ kind: 'event', event: { sequence: 11 + commands.length, eventId: `e${commands.length}`, aggregateKind: 'thread', aggregateId: 't1', occurredAt: at, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type: 'thread.message-sent', payload: { threadId: 't1', messageId, role: 'user', text, turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at } } }])
  }
  return { server, fetch, commands, uploads, acknowledge }
}

describe('conversation items remembered in the main process (§5.4, §5.12)', () => {
  it('four answers travel keyed by item id in one delivery, show Drafted until acknowledged, and survive a restart with a dismissal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-conversation-state-'))
    const fake = engine()
    const client = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await settle()
    const items = () => client.view().projects[0]!.threads[0]!.items!
    expect(items()).toHaveLength(7)
    expect(items().every((item) => item.inferred && item.status === 'open')).toBe(true)

    const answers = ['Audience', 'Yes', '$10k', 'West']
    for (const [index, answer] of answers.entries()) await client.queueItemReply('t1', items()[index]!.id, answer)
    expect(items().filter((item) => item.status === 'drafted').map((item) => item.draftReply)).toEqual(answers)
    await client.discardItemReply('t1', items()[3]!.id)
    expect(items().filter((item) => item.status === 'drafted')).toHaveLength(3)
    await client.queueItemReply('t1', items()[3]!.id, 'West')

    await client.startTurn('t1', { text: '', model: 'gpt-5.6', effort: null, access: 'full-access' })
    expect(fake.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(1)
    const turn = fake.commands[0]!.message as { messageId: string; text: string; attachments: Array<{ name: string }> }
    expect(turn.text).toBe('Replies to 4 items.')
    expect(turn.attachments.map((attachment) => attachment.name)).toEqual([`replies-${turn.messageId}.md`])
    expect(fake.commands[0]).toMatchObject({ commandId: `strata-${turn.messageId}` })
    expect(fake.uploads).toHaveLength(1)
    const keyed = fake.uploads[0]!.match(/^(inferred_[0-9a-f]+) ← user: (.+)$/gmu)!
    expect(keyed).toHaveLength(4)
    expect(fake.uploads[0]).toContain(`${items()[0]!.id} ← user: Audience\n  item: question in message m1 about "Which audience should lead?"`)
    // Drafted holds until the Send carrying the reply is acknowledged.
    expect(items().filter((item) => item.status === 'drafted')).toHaveLength(4)
    expect(items().filter((item) => item.status === 'drafted').every((item) => item.draftReply === undefined)).toBe(true)
    await expect(client.startTurn('t1', { text: '   ', model: 'gpt-5.6', effort: null, access: 'full-access' })).rejects.toThrow('Write a message or queue a reply')

    fake.acknowledge(turn.messageId, turn.text)
    await settle()
    expect(items().filter((item) => item.status === 'done')).toHaveLength(4)
    expect(items().filter((item) => item.status === 'open')).toHaveLength(3)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, 'engine-commands.json'), 'utf8')).pending).toEqual([]))

    const dismissedId = items().find((item) => item.status === 'open')!.id
    await client.dismissItem('t1', dismissedId)
    expect(items()).toHaveLength(6)
    await client.shutdown()

    // A restart reads the same store: the answers stay done, the dismissal stays hidden, two remain open.
    const again = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await again.initialize()
    const reopened = again.view().projects[0]!.threads[0]!.items!
    expect(reopened).toHaveLength(6)
    expect(reopened.filter((item) => item.status === 'done')).toHaveLength(4)
    expect(reopened.filter((item) => item.status === 'open')).toHaveLength(2)
    expect(reopened.some((item) => item.id === dismissedId)).toBe(false)
    await again.shutdown()
  })
})
